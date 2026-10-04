import { describe, expect, it } from 'vitest';
import { buildDataFlow, traceLineage } from '../src/data-flow.js';
import { buildGraph, DiagnosticCollector, EvidenceStore, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

/**
 * Data flow and lineage over multi-table access.
 *
 * The failure these tests exist to prevent: a join collapsed into one arrow, a read reported as
 * a write, and two stores merged into a single "database" because the diagram looked tidier.
 */

const REPOSITORY: RepositoryRef = { absolutePath: '/repo', name: 'repo' };

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    language: 'typescript',
    producer: 'typescript-compiler-api',
    imports: [],
    entities: [],
    calls: [],
    markers: [],
    problems: [],
    durationMs: 0,
    ...overrides,
  };
}

function graphOf(files: ParsedFile[]) {
  return buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits: [],
    headCommit: null,
    branch: null,
    evidence: new EvidenceStore({ maxExcerptChars: 200 }),
    diagnostics: new DiagnosticCollector(),
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: false,
  }).graph;
}

const entity = (name: string) => ({
  kind: 'function' as const,
  name,
  qualifiedName: name,
  startLine: 1,
  endLine: 8,
  language: 'typescript',
});

const query = (table: string, operation: 'read' | 'write', role: string, statement: string) => ({
  name: 'sql.query',
  line: 3,
  attributes: { table, operation, role, statement, scope: 'loadAll' },
});

/** One statement reading two tables, and one writing two. */
const MULTI_TABLE_GRAPH = graphOf([
  parsedFile('src/service.ts', {
    entities: [entity('loadAll'), entity('archiveAll')],
    markers: [
      query('users', 'read', 'from', 'select users, orders'),
      query('orders', 'read', 'join', 'select users, orders'),
      { ...query('archive_reports', 'write', 'insert_into', 'insert archive_reports, reports'), attributes: { table: 'archive_reports', operation: 'write', role: 'insert_into', statement: 'insert archive_reports, reports', scope: 'archiveAll' } },
      { ...query('reports', 'read', 'from', 'insert archive_reports, reports'), attributes: { table: 'reports', operation: 'read', role: 'from', statement: 'insert archive_reports, reports', scope: 'archiveAll' } },
    ],
  }),
  parsedFile('schema.sql', {
    language: 'sql',
    producer: 'config-scanner',
    markers: [
      { name: 'schema.table', line: 1, attributes: { table: 'users', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 2, attributes: { table: 'users', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true } },
      { name: 'schema.table', line: 3, attributes: { table: 'orders', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 4, attributes: { table: 'orders', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true } },
      { name: 'schema.table', line: 5, attributes: { table: 'reports', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 6, attributes: { table: 'reports', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true } },
      { name: 'schema.table', line: 7, attributes: { table: 'archive_reports', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 8, attributes: { table: 'archive_reports', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true } },
    ],
  }),
]);

describe('multi-table data flow', () => {
  const artifact = buildDataFlow({ graph: MULTI_TABLE_GRAPH, maxElements: 5_000 });

  it('draws one flow per table, not one per statement', () => {
    const flows = artifact.edges.filter((edge) => edge.source === 'function:loadall');
    expect(flows.map((edge) => edge.target).sort()).toEqual(['table:orders', 'table:users']);
  });

  it('keeps multiple stores distinct rather than collapsing them into one database node', () => {
    const stores = artifact.nodes.filter((node) => node.kind === 'table').map((node) => node.id);
    expect(stores.sort()).toEqual(['table:archive_reports', 'table:orders', 'table:reports', 'table:users']);
    expect(artifact.nodes.some((node) => node.kind === 'database')).toBe(false);
  });

  it('does not turn a read into a write', () => {
    expect(artifact.edges.filter((edge) => edge.kind === 'writes').map((edge) => edge.target)).toEqual(['table:archive_reports']);
    expect(artifact.edges.filter((edge) => edge.kind === 'reads')).toHaveLength(3);
  });

  it('says which clause each table came from and which statement it was', () => {
    const join = artifact.edges.find((edge) => edge.target === 'table:orders');
    expect(join?.derivation).toContain('a JOIN clause');
    expect(join?.derivation).toContain('select users, orders');
  });

  it('cites the graph relationship behind every flow', () => {
    for (const edge of artifact.edges) {
      expect(edge.supportingEdgeIds).toHaveLength(1);
      expect(edge.evidence.length).toBeGreaterThan(0);
    }
  });

  it('reports a query it could not read as a query, not as an absence of access', () => {
    const graph = graphOf([
      parsedFile('src/migrate.ts', {
        markers: [
          {
            name: 'sql.statement',
            line: 4,
            attributes: {
              summary: 'merge statement',
              unsupported: 'a MERGE statement is not a data-access statement this analyser classifies',
              scope: 'migrate',
            },
          },
        ],
      }),
    ]);
    const artifact2 = buildDataFlow({ graph, maxElements: 5_000 });
    expect(artifact2.insufficientEvidence).toBe(true);
    expect(artifact2.omitted.some((entry) => entry.reason.includes('queries present but not classified'))).toBe(true);
  });

  it('says a CTE is a query result and not a store', () => {
    const graph = graphOf([
      parsedFile('src/service.ts', {
        entities: [entity('loadAll')],
        markers: [
          query('orders', 'read', 'from', 'select orders'),
          { name: 'sql.cte', line: 3, attributes: { names: 'recent_orders', statement: 'select orders', scope: 'loadAll' } },
        ],
      }),
    ]);
    const artifact2 = buildDataFlow({ graph, maxElements: 5_000 });
    expect(artifact2.nodes.some((node) => node.kind === 'constant' && node.label === 'recent_orders')).toBe(true);
    expect(artifact2.omitted.some((entry) => entry.reason.includes('query expressions (CTEs)'))).toBe(true);
  });
});

describe('lineage over multi-table access', () => {
  it('keeps the source relationships separate for a multi-table statement', () => {
    const lineage = traceLineage(MULTI_TABLE_GRAPH, 'function:loadall')!;
    expect(lineage.downstream.map((hop) => hop.to).sort()).toEqual(['table:orders', 'table:users']);
  });

  it('records the operation on each hop so a read is not read as a write', () => {
    const lineage = traceLineage(MULTI_TABLE_GRAPH, 'function:loadall')!;
    expect(lineage.downstream.every((hop) => hop.operation === 'read')).toBe(true);
    // Two reads reach this function; the archive statement belongs to rchiveAll and is not counted here.
    expect(lineage.usage).toEqual({ read: 2, write: 0, unclassified: 0 });
  });

  it('counts reads and writes separately for a store', () => {
    const lineage = traceLineage(MULTI_TABLE_GRAPH, 'table:reports')!;
    expect(lineage.upstream).toHaveLength(1);
    expect(lineage.upstream[0]?.operation).toBe('read');
  });

  it('counts a write for the store a statement inserts into', () => {
    const lineage = traceLineage(MULTI_TABLE_GRAPH, 'table:archive_reports')!;
    expect(lineage.upstream[0]?.operation).toBe('write');
    expect(lineage.usage.write).toBe(1);
  });

  it('carries the role and statement on each hop', () => {
    const lineage = traceLineage(MULTI_TABLE_GRAPH, 'table:orders')!;
    expect(lineage.upstream[0]?.role).toBe('join');
    expect(lineage.upstream[0]?.statement).toBe('select users, orders');
  });

  it('reports a store with no relationship as empty rather than inventing a source', () => {
    const graph = graphOf([
      parsedFile('schema.sql', {
        language: 'sql',
        producer: 'config-scanner',
        markers: [{ name: 'schema.table', line: 1, attributes: { table: 'unused', columnCount: 1 } }],
      }),
    ]);
    const lineage = traceLineage(graph, 'table:unused')!;
    expect(lineage.upstream).toHaveLength(0);
    expect(lineage.downstream).toHaveLength(0);
    expect(lineage.usage).toEqual({ read: 0, write: 0, unclassified: 0 });
  });
});