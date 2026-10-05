import { createHash } from 'node:crypto';
import { computeStats } from './graph.js';
import type { GraphStats, SoftwareGraph } from './types.js';

/**
 * Analysis snapshots.
 *
 * A snapshot is a repository state that can be compared with another repository state.
 * Its identity is a **content digest**, never a timestamp: re-analysing an unchanged
 * repository must yield the same snapshot id, otherwise "nothing changed" cannot be
 * distinguished from "analysed at a different moment".
 *
 * The digest deliberately covers two things beyond the graph itself:
 *
 *  - `EXTRACTOR_VERSION` — the behaviour of the parsers. If extraction changes, every
 *    entity's facts change, and comparing a pre-change snapshot with a post-change one
 *    would otherwise report the whole repository as rewritten. Including the version
 *    makes that detectable instead of silent.
 *  - the graph schema version — same reasoning for the model.
 *
 * Provenance (path, timestamp, commit, branch, truncation) is recorded in the snapshot
 * but is **not** part of its identity. Two runs of the same content are the same
 * snapshot even if taken from different directories or at different times; provenance is
 * then what distinguishes the runs.
 */

/**
 * Version of the extraction behaviour.
 *
 * Bump when a change to any parser, marker rule, or graph-construction rule can alter the
 * facts produced from unchanged source. A cosmetic change (comments, formatting)
 * must not bump it, or drift between consecutive analyses becomes meaningless.
 *
 * 1.1.0 - Phase 4. The SQL scanner reads every table in a statement rather than only a single
 * FROM, records joins, subqueries, CTEs and set operations, and requires a verb to carry the
 * clause it needs before treating text as a statement. Return, rejection and HTTP-response
 * records became graph facts. Unchanged source therefore produces different facts than it did
 * under 1.0.0, and a snapshot taken then must not compare as though nothing changed.
 */
export const EXTRACTOR_VERSION = '1.1.0';

/** Field separators for the canonical digest input. Control characters, never in source. */
const UNIT = '';
const RECORD = '';

/** Reference to a snapshot without carrying its whole graph. */
export interface SnapshotReference {
  snapshotId: string;
  analysisId: string;
  repositoryName: string;
  repositoryPath: string;
  /** Git commit the analysed working tree was at, or `null` when unavailable. */
  sourceRevision: string | null;
  branch: string | null;
  createdAt: string;
  graphDigest: string;
  extractorVersion: string;
  graphSchemaVersion: number;
  /** True when limits were reached, which makes removals unassertable. */
  truncated: boolean;
}

export interface AnalysisSnapshot {
  id: string;
  provenance: SnapshotReference;
  graph: SoftwareGraph;
  stats: GraphStats;
}

export interface CreateSnapshotInput {
  analysisId: string;
  repositoryPath: string;
  repositoryName: string;
  createdAt: string;
  sourceRevision: string | null;
  branch: string | null;
  truncated: boolean;
  graph: SoftwareGraph;
  extractorVersion?: string;
}

/**
 * Builds a snapshot from a stored analysis and its graph.
 *
 * Pure and deterministic: the same graph always yields the same id, and no field of the
 * input can leak into the identity beyond content, schema and extractor version.
 */
export function createSnapshot(input: CreateSnapshotInput): AnalysisSnapshot {
  const extractorVersion = input.extractorVersion ?? EXTRACTOR_VERSION;
  const graphDigest = computeGraphDigest(input.graph, extractorVersion);
  const snapshotId = snapshotIdFrom(graphDigest, input.graph.schemaVersion);

  return {
    id: snapshotId,
    provenance: {
      snapshotId,
      analysisId: input.analysisId,
      repositoryName: input.repositoryName,
      repositoryPath: input.repositoryPath,
      sourceRevision: input.sourceRevision,
      branch: input.branch,
      createdAt: input.createdAt,
      graphDigest,
      extractorVersion,
      graphSchemaVersion: input.graph.schemaVersion,
      truncated: input.truncated,
    },
    graph: input.graph,
    stats: computeStats(input.graph),
  };
}

/** `snap_<16 hex>` — short enough to read, wide enough to avoid collisions. */
export function snapshotIdFrom(graphDigest: string, graphSchemaVersion: number): string {
  const hash = createHash('sha256').update(`${graphSchemaVersion}${UNIT}${graphDigest}`).digest('hex').slice(0, 16);
  return `snap_${hash}`;
}

/**
 * Content digest of a graph.
 *
 * Exported because the store persists it and the drift engine reports it; both need the
 * same value the snapshot was built from.
 */
export function computeGraphDigest(graph: SoftwareGraph, extractorVersion = EXTRACTOR_VERSION): string {
  const parts: string[] = [extractorVersion, String(graph.schemaVersion)];

  for (const node of graph.nodes) {
    parts.push(
      [
        node.id,
        node.kind,
        node.name,
        node.qualifiedName ?? '',
        node.language ?? '',
        node.path ?? '',
        node.startLine ?? '',
        node.endLine ?? '',
        node.confidence,
        node.digest ?? '',
        stableStringify(node.attributes ?? {}),
        node.evidence.map((ref) => ref.evidenceId).sort().join(','),
      ].join(UNIT),
    );
  }

  for (const edge of graph.edges) {
    parts.push(
      [
        edge.id,
        edge.from,
        edge.to,
        edge.kind,
        edge.confidence,
        edge.label ?? '',
        stableStringify(edge.attributes ?? {}),
        edge.evidence.map((ref) => ref.evidenceId).sort().join(','),
      ].join(UNIT),
    );
  }

  for (const item of graph.evidence) {
    parts.push(
      [
        item.id,
        item.kind,
        item.path,
        item.startLine,
        item.endLine,
        item.symbol ?? '',
        item.excerpt ?? '',
        item.producer,
      ].join(UNIT),
    );
  }

  // Order is normalised so the digest cannot depend on extraction order.
  const body = parts.slice(2).sort().join(RECORD);
  return createHash('sha256').update(`${parts[0]}${UNIT}${parts[1]}${UNIT}${body}`).digest('hex');
}

/**
 * Deterministic JSON serialisation.
 *
 * Object keys are sorted recursively so two structurally identical graphs serialise
 * identically regardless of property insertion order. Arrays keep their order because
 * for the values here (evidence id lists, gap observations) order carries meaning.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * Why two snapshots cannot be meaningfully compared, or `null` when they can.
 *
 * A mismatch in extractor version or graph schema means the two graphs were produced by
 * different machinery, so a naive diff would attribute the machinery change to the
 * repository. The drift engine surfaces this rather than silently diffing.
 */
export function incomparabilityReason(a: SnapshotReference, b: SnapshotReference): string | null {
  if (a.extractorVersion !== b.extractorVersion) {
    return `Extractor versions differ (${a.extractorVersion} vs ${b.extractorVersion}). Facts were produced by different extraction behaviour, so a difference here reflects the tooling, not the repository.`;
  }
  if (a.graphSchemaVersion !== b.graphSchemaVersion) {
    return `Graph schema versions differ (${a.graphSchemaVersion} vs ${b.graphSchemaVersion}). The graphs are not directly comparable.`;
  }
  return null;
}

/** Builds the lightweight reference form used in reports and API payloads. */
export function toSnapshotReference(snapshot: AnalysisSnapshot): SnapshotReference {
  return snapshot.provenance;
}