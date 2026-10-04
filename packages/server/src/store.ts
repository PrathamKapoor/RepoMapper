import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  type AnalysisRecord,
  type AnalysisResult,
  type AnalysisStatus,
  type AnalysisSummary,
  type Diagnostic,
  type GraphEdge,
  type GraphNode,
  type SoftwareGraph,
  type Evidence,
} from '@repoatlas/core';

/**
 * Persistence.
 *
 * Uses the SQLite build bundled with Node (`node:sqlite`) rather than a native driver:
 * it removes a compiled dependency from the install path, which keeps Docker builds
 * and CI runs free of toolchain requirements, and the data volume here is small
 * (one row per node, edge and evidence record per analysis).
 *
 * Schema notes:
 *  - entities are stored one row per node/edge so they can be queried by kind and
 *    joined against evidence without loading a whole graph into memory;
 *  - `evidence_json` is denormalised onto nodes and edges so an entity can be rendered
 *    with its citations in one query;
 *  - WAL mode is enabled so a long analysis write does not block API reads.
 */

const SCHEMA_VERSION = 1;

interface AnalysisRow {
  id: string;
  repository_path: string;
  repository_name: string;
  label: string | null;
  status: AnalysisStatus;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  head_commit: string | null;
  branch: string | null;
  error_json: string | null;
  summary_json: string | null;
  warnings_json: string | null;
  graph_digest: string | null;
  extractor_version: string | null;
  graph_schema_version: number | null;
}

interface NodeRow {
  id: string;
  analysis_id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  language: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  digest: string | null;
  confidence: string;
  attributes_json: string | null;
  evidence_json: string | null;
}

interface EdgeRow {
  id: string;
  analysis_id: string;
  from_id: string;
  to_id: string;
  kind: string;
  confidence: string;
  label: string | null;
  attributes_json: string | null;
  evidence_json: string | null;
}

interface EvidenceRow {
  id: string;
  analysis_id: string;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  excerpt: string | null;
  producer: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id              TEXT PRIMARY KEY,
  repository_path TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  label           TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  duration_ms     INTEGER,
  head_commit     TEXT,
  branch          TEXT,
  error_json      TEXT,
  summary_json    TEXT,
  warnings_json   TEXT,
  -- Snapshot identity. The digest is content-derived, so two runs over unchanged
  -- content share it and "nothing changed" is decidable without a timestamp comparison.
  graph_digest          TEXT,
  extractor_version     TEXT,
  graph_schema_version  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_repo    ON analyses (repository_path, created_at DESC);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT NOT NULL,
  analysis_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  qualified_name  TEXT,
  language        TEXT,
  path            TEXT,
  start_line      INTEGER,
  end_line        INTEGER,
  -- Content digest of the underlying source, present on module nodes. Rename detection
  -- compares these, so a rename is proved by identical content rather than by a
  -- similar-looking name.
  digest          TEXT,
  confidence      TEXT NOT NULL,
  attributes_json TEXT,
  evidence_json   TEXT,
  PRIMARY KEY (analysis_id, id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_analysis_kind ON nodes (analysis_id, kind);
CREATE INDEX IF NOT EXISTS idx_nodes_analysis_path ON nodes (analysis_id, path);

CREATE TABLE IF NOT EXISTS edges (
  id              TEXT NOT NULL,
  analysis_id     TEXT NOT NULL,
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  label           TEXT,
  attributes_json TEXT,
  evidence_json   TEXT,
  PRIMARY KEY (analysis_id, id)
);

CREATE INDEX IF NOT EXISTS idx_edges_analysis_kind ON edges (analysis_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (analysis_id, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges (analysis_id, to_id);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol      TEXT,
  excerpt     TEXT,
  producer    TEXT NOT NULL,
  PRIMARY KEY (analysis_id, id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_path ON evidence (analysis_id, path);

CREATE TABLE IF NOT EXISTS diagnostics (
  analysis_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  code        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  message     TEXT NOT NULL,
  path        TEXT,
  detail_json TEXT,
  PRIMARY KEY (analysis_id, seq)
);

CREATE TABLE IF NOT EXISTS artifacts (
  analysis_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  format      TEXT NOT NULL,
  body_json   TEXT NOT NULL,
  PRIMARY KEY (analysis_id, kind)
);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly statements: {
    insertAnalysis: StatementSync;
    updateAnalysis: StatementSync;
    getAnalysis: StatementSync;
    listAnalyses: StatementSync;
    countAnalyses: StatementSync;
    deleteAnalysis: StatementSync;
    insertNode: StatementSync;
    insertEdge: StatementSync;
    insertEvidence: StatementSync;
    insertDiagnostic: StatementSync;
    insertArtifact: StatementSync;
    listNodes: StatementSync;
    listEdges: StatementSync;
    listEvidence: StatementSync;
    listDiagnostics: StatementSync;
    listArtifacts: StatementSync;
    findNode: StatementSync;
    neighbourOut: StatementSync;
    neighbourIn: StatementSync;
  };

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);

    // WAL keeps API reads responsive while a long analysis writes. `:memory:` has no
    // journal file, so it is skipped there.
    if (databasePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));

    this.statements = {
      insertAnalysis: this.db.prepare(
        `INSERT INTO analyses (id, repository_path, repository_name, label, status, created_at, completed_at,
          duration_ms, head_commit, branch, error_json, summary_json, warnings_json,
          graph_digest, extractor_version, graph_schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateAnalysis: this.db.prepare(
        `UPDATE analyses SET status = ?, completed_at = ?, duration_ms = ?, head_commit = ?, branch = ?,
          error_json = ?, summary_json = ?, warnings_json = ? WHERE id = ?`,
      ),
      getAnalysis: this.db.prepare('SELECT * FROM analyses WHERE id = ?'),
      listAnalyses: this.db.prepare('SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?'),
      countAnalyses: this.db.prepare('SELECT COUNT(*) AS total FROM analyses'),
      deleteAnalysis: this.db.prepare('DELETE FROM analyses WHERE id = ?'),
      insertNode: this.db.prepare(
        `INSERT OR REPLACE INTO nodes (id, analysis_id, kind, name, qualified_name, language, path,
          start_line, end_line, digest, confidence, attributes_json, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertEdge: this.db.prepare(
        `INSERT OR REPLACE INTO edges (id, analysis_id, from_id, to_id, kind, confidence, label,
          attributes_json, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertEvidence: this.db.prepare(
        `INSERT OR REPLACE INTO evidence (id, analysis_id, kind, path, start_line, end_line, symbol, excerpt, producer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertDiagnostic: this.db.prepare(
        'INSERT OR REPLACE INTO diagnostics (analysis_id, seq, code, severity, message, path, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertArtifact: this.db.prepare(
        'INSERT OR REPLACE INTO artifacts (analysis_id, kind, title, format, body_json) VALUES (?, ?, ?, ?, ?)',
      ),
      listNodes: this.db.prepare('SELECT * FROM nodes WHERE analysis_id = ? ORDER BY kind, name'),
      listEdges: this.db.prepare('SELECT * FROM edges WHERE analysis_id = ? ORDER BY kind, from_id'),
      listEvidence: this.db.prepare('SELECT * FROM evidence WHERE analysis_id = ? ORDER BY path, start_line'),
      listDiagnostics: this.db.prepare('SELECT * FROM diagnostics WHERE analysis_id = ? ORDER BY seq'),
      listArtifacts: this.db.prepare('SELECT * FROM artifacts WHERE analysis_id = ? ORDER BY kind'),
      findNode: this.db.prepare('SELECT * FROM nodes WHERE analysis_id = ? AND id = ?'),
      neighbourOut: this.db.prepare('SELECT * FROM edges WHERE analysis_id = ? AND from_id = ?'),
      neighbourIn: this.db.prepare('SELECT * FROM edges WHERE analysis_id = ? AND to_id = ?'),
    };
  }

  /** Persists a completed analysis and its whole graph in one transaction. */
  saveAnalysis(input: {
    analysis: AnalysisRecord;
    graph: SoftwareGraph;
    diagnostics: readonly Diagnostic[];
    artifacts: readonly { kind: string; title: string; format: string; body: unknown }[];
    /** Snapshot identity, persisted so identity is queryable without re-reading the graph. */
    graphDigest: string;
    extractorVersion: string;
  }): void {
    const record = input.analysis;

    this.db.exec('BEGIN');
    try {
      this.statements.insertAnalysis.run(
        record.id,
        record.repositoryPath,
        record.repositoryName,
        record.label,
        record.status,
        record.createdAt,
        record.completedAt,
        record.durationMs,
        record.headCommit,
        record.branch,
        record.error ? JSON.stringify(record.error) : null,
        record.summary ? JSON.stringify(record.summary) : null,
        JSON.stringify(record.warnings),
        input.graphDigest,
        input.extractorVersion,
        record.graphSchemaVersion ?? null,
      );

      for (const node of input.graph.nodes) {
        this.statements.insertNode.run(
          node.id,
          record.id,
          node.kind,
          node.name,
          node.qualifiedName ?? null,
          node.language ?? null,
          node.path ?? null,
          node.startLine ?? null,
          node.endLine ?? null,
          node.digest ?? null,
          node.confidence,
          node.attributes ? JSON.stringify(node.attributes) : null,
          JSON.stringify(node.evidence),
        );
      }

      for (const edge of input.graph.edges) {
        this.statements.insertEdge.run(
          edge.id,
          record.id,
          edge.from,
          edge.to,
          edge.kind,
          edge.confidence,
          edge.label ?? null,
          edge.attributes ? JSON.stringify(edge.attributes) : null,
          JSON.stringify(edge.evidence),
        );
      }

      for (const item of input.graph.evidence) {
        this.statements.insertEvidence.run(
          item.id,
          record.id,
          item.kind,
          item.path,
          item.startLine,
          item.endLine,
          item.symbol ?? null,
          item.excerpt ?? null,
          item.producer,
        );
      }

      input.diagnostics.forEach((diagnostic, index) => {
        this.statements.insertDiagnostic.run(
          record.id,
          index,
          diagnostic.code,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.path ?? null,
          diagnostic.detail ? JSON.stringify(diagnostic.detail) : null,
        );
      });

      for (const artifact of input.artifacts) {
        this.statements.insertArtifact.run(record.id, artifact.kind, artifact.title, artifact.format, JSON.stringify(artifact.body));
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records a failed analysis so failures are visible rather than silently lost. */
  saveFailure(record: AnalysisRecord): void {
    this.statements.insertAnalysis.run(
      record.id,
      record.repositoryPath,
      record.repositoryName,
      record.label,
      record.status,
      record.createdAt,
      record.completedAt,
      record.durationMs,
      record.headCommit,
      record.branch,
      record.error ? JSON.stringify(record.error) : null,
      record.summary ? JSON.stringify(record.summary) : null,
      JSON.stringify(record.warnings),
      null,
      null,
      null,
    );
  }

  getAnalysis(id: string): AnalysisRecord | null {
    const row = this.statements.getAnalysis.get(id) as unknown as AnalysisRow | undefined;
    return row ? rowToAnalysis(row) : null;
  }

  listAnalyses(limit: number): AnalysisRecord[] {
    const rows = this.statements.listAnalyses.all(limit) as unknown as AnalysisRow[];
    return rows.map(rowToAnalysis);
  }

  countAnalyses(): number {
    const row = this.statements.countAnalyses.get() as unknown as { total: number };
    return row.total;
  }

  /** Removes an analysis and, by cascade-free design, its graph rows explicitly. */
  deleteAnalysis(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      for (const table of ['nodes', 'edges', 'evidence', 'diagnostics', 'artifacts']) {
        this.db.prepare(`DELETE FROM ${table} WHERE analysis_id = ?`).run(id);
      }
      const result = this.statements.deleteAnalysis.run(id);
      this.db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Loads the whole graph for an analysis. */
  getGraph(analysisId: string): SoftwareGraph | null {
    if (!this.getAnalysis(analysisId)) return null;

    const nodes = (this.statements.listNodes.all(analysisId) as unknown as NodeRow[]).map(rowToNode);
    const edges = (this.statements.listEdges.all(analysisId) as unknown as EdgeRow[]).map(rowToEdge);
    const evidence = (this.statements.listEvidence.all(analysisId) as unknown as EvidenceRow[]).map(rowToEvidence);

    return { schemaVersion: SCHEMA_VERSION, nodes, edges, evidence };
  }

  getNode(analysisId: string, nodeId: string): GraphNode | null {
    const row = this.statements.findNode.get(analysisId, nodeId) as unknown as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  /** Neighbourhood of a node, used by the entity inspector. */
  getNeighbourhood(analysisId: string, nodeId: string): { out: GraphEdge[]; in: GraphEdge[] } {
    const out = (this.statements.neighbourOut.all(analysisId, nodeId) as unknown as EdgeRow[]).map(rowToEdge);
    const incoming = (this.statements.neighbourIn.all(analysisId, nodeId) as unknown as EdgeRow[]).map(rowToEdge);
    return { out, in: incoming };
  }

  getEvidence(analysisId: string, path?: string): Evidence[] {
    const all = (this.statements.listEvidence.all(analysisId) as unknown as EvidenceRow[]).map(rowToEvidence);
    if (path === undefined) return all;
    return all.filter((item) => item.path === path);
  }

  getDiagnostics(analysisId: string): Diagnostic[] {
    const rows = this.statements.listDiagnostics.all(analysisId) as unknown as {
      code: string;
      severity: 'info' | 'warning' | 'error';
      message: string;
      path: string | null;
      detail_json: string | null;
    }[];
    return rows.map((row) => ({
      code: row.code as Diagnostic['code'],
      severity: row.severity,
      message: row.message,
      ...(row.path ? { path: row.path } : {}),
      ...(row.detail_json ? { detail: JSON.parse(row.detail_json) as Record<string, string | number | boolean | null> } : {}),
    }));
  }

  getArtifacts(analysisId: string): { kind: string; title: string; format: string; body: unknown }[] {
    const rows = this.statements.listArtifacts.all(analysisId) as unknown as {
      kind: string;
      title: string;
      format: string;
      body_json: string;
    }[];
    return rows.map((row) => ({
      kind: row.kind,
      title: row.title,
      format: row.format,
      body: JSON.parse(row.body_json) as unknown,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToAnalysis(row: AnalysisRow): AnalysisRecord {
  return {
    id: row.id,
    repositoryPath: row.repository_path,
    repositoryName: row.repository_name,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    headCommit: row.head_commit,
    branch: row.branch,
    error: row.error_json ? (JSON.parse(row.error_json) as AnalysisRecord['error']) : null,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as AnalysisSummary) : null,
    warnings: row.warnings_json ? (JSON.parse(row.warnings_json) as string[]) : [],
    graphDigest: row.graph_digest,
    extractorVersion: row.extractor_version,
    graphSchemaVersion: row.graph_schema_version,
  };
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as GraphNode['kind'],
    name: row.name,
    ...(row.qualified_name ? { qualifiedName: row.qualified_name } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.start_line !== null ? { startLine: row.start_line } : {}),
    ...(row.end_line !== null ? { endLine: row.end_line } : {}),
    ...(row.digest ? { digest: row.digest } : {}),
    confidence: row.confidence as GraphNode['confidence'],
    ...(row.attributes_json ? { attributes: JSON.parse(row.attributes_json) as GraphNode['attributes'] } : {}),
    evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as GraphNode['evidence']) : [],
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    kind: row.kind as GraphEdge['kind'],
    confidence: row.confidence as GraphEdge['confidence'],
    ...(row.label ? { label: row.label } : {}),
    ...(row.attributes_json ? { attributes: JSON.parse(row.attributes_json) as GraphEdge['attributes'] } : {}),
    evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as GraphEdge['evidence']) : [],
  };
}

function rowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    kind: row.kind as Evidence['kind'],
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.excerpt ? { excerpt: row.excerpt } : {}),
    producer: row.producer,
  };
}

export type { AnalysisResult };