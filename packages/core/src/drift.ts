import type {
  Confidence,
  EvidenceRef,
  GraphEdge,
  GraphNode,
  SoftwareGraph,
} from './types.js';
import { incomparabilityReason, stableStringify, type AnalysisSnapshot, type SnapshotReference } from './snapshot.js';

/**
 * Drift engine.
 *
 * Compares two analysis snapshots and reports what changed. Two properties define it:
 *
 * **1. Removal is a claim, not an observation.**
 * A node is reported as removed only when it existed in the base snapshot. When the
 * target snapshot was produced by a truncated analysis — limits were reached, so part of
 * the repository was never walked — absence proves nothing. Those removals are reported
 * with `indeterminate: true` and the report's `removalConfidence` drops to
 * `INDETERMINATE`. This is the difference between "this is gone" and "we did not look".
 *
 * **2. Renames are proved, never guessed.**
 * A rename is reported only when the removed node and the added node carry the same
 * content digest, the same kind and the same language — that is, the same bytes under a
 * different path. Anything less (an edited rename, two files with identical content, a
 * similar name) is reported as removed plus added. `confidence` on the rename records
 * that it was established from content identity rather than from the repository's own
 * statement.
 *
 * Everything runs through indexed lookups, so the comparison is O(n + m) in nodes and
 * edges rather than quadratic.
 */

export const DRIFT_CATEGORIES = [
  'NODE_ADDED',
  'NODE_REMOVED',
  'NODE_MODIFIED',
  'NODE_RENAMED',
  'EDGE_ADDED',
  'EDGE_REMOVED',
  'EDGE_MODIFIED',
  'EVIDENCE_ADDED',
  'EVIDENCE_REMOVED',
  'EVIDENCE_CHANGED',
  'CONFIDENCE_CHANGED',
] as const;

export type DriftCategory = (typeof DRIFT_CATEGORIES)[number];

/** Which kind of entity a drift record describes. */
export type DriftEntityKind = 'node' | 'edge' | 'evidence';

/**
 * How strongly the drift claim itself is supported.
 *
 * Distinct from the confidence of the underlying graph facts: an `EXPLICIT` entity can be
 * reported as an `INDETERMINATE` removal if the target analysis was incomplete.
 */
export type DriftClaimConfidence = 'EXPLICIT' | 'STRONGLY_INFERRED' | 'INDETERMINATE';

export interface DriftChange {
  category: DriftCategory;
  entityKind: DriftEntityKind;
  /** Entity id in the target snapshot. */
  entityId: string;
  /** Entity id in the base snapshot, when the entity changed identity (a rename). */
  previousEntityId?: string;
  label: string;
  /** Names of the fields that differ, for MODIFIED records. */
  changedFields?: string[];
  /** Graph node kind, when applicable. */
  nodeKind?: string;
  /** Graph edge kind, when applicable. */
  edgeKind?: string;
  /** Evidence citations in the base snapshot. */
  evidenceBefore: EvidenceRef[];
  /** Evidence citations in the target snapshot. */
  evidenceAfter: EvidenceRef[];
  confidence: Confidence;
  /** Support for the drift claim itself, independent of entity confidence. */
  claimConfidence: DriftClaimConfidence;
  /**
   * True when the change could not be determined with certainty — for example a removal
   * observed through a truncated target analysis. Never reported as a plain fact.
   */
  indeterminate: boolean;
  /** Human-readable explanation, required whenever `indeterminate` is true. */
  reason?: string;
}

export interface DriftSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  nodesRenamed: number;
  relationshipsAdded: number;
  relationshipsRemoved: number;
  relationshipsModified: number;
  evidenceAdded: number;
  evidenceRemoved: number;
  evidenceChanged: number;
  confidenceChanged: number;
  totalChanges: number;
}

export interface DriftReport {
  base: SnapshotReference;
  target: SnapshotReference;
  /** True when the two graphs have the same digest: nothing changed. */
  identical: boolean;
  /** False when the snapshots were produced by different machinery. */
  comparable: boolean;
  /** Why the snapshots cannot be compared, when `comparable` is false. */
  incomparabilityReason: string | null;
  /** True when the target analysis hit a limit, making removals unassertable. */
  targetIncomplete: boolean;
  /**
   * `CONFIRMED` when removals can be asserted, `INDETERMINATE` when the target analysis
   * was incomplete.
   */
  removalConfidence: DriftClaimConfidence;
  counts: Record<DriftCategory, number>;
  summary: DriftSummary;
  changes: DriftChange[];
}

export interface CompareOptions {
  /** Include per-item change records. Summary counts are always produced. */
  includeChanges?: boolean;
  /** Cap on recorded changes, to bound very large divergences. */
  maxChanges?: number;
}

const DEFAULT_MAX_CHANGES = 5_000;

/** Compares two snapshots. Deterministic: identical inputs always give an identical report. */
export function compareSnapshots(
  base: AnalysisSnapshot,
  target: AnalysisSnapshot,
  options: CompareOptions = {},
): DriftReport {
  const reason = incomparabilityReason(base.provenance, target.provenance);
  const targetIncomplete = target.provenance.truncated;
  const removalConfidence: DriftClaimConfidence = targetIncomplete ? 'INDETERMINATE' : 'EXPLICIT';

  const identical = base.provenance.graphDigest === target.provenance.graphDigest;

  const counts = emptyCounts();
  const changes: DriftChange[] = [];
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const includeChanges = options.includeChanges ?? true;

  // ---------------------------------------------------------------- not comparable
  if (reason !== null) {
    return {
      base: base.provenance,
      target: target.provenance,
      identical: false,
      comparable: false,
      incomparabilityReason: reason,
      targetIncomplete,
      removalConfidence,
      counts,
      summary: summarise(counts),
      changes: [],
    };
  }

  if (identical) {
    return {
      base: base.provenance,
      target: target.provenance,
      identical: true,
      comparable: true,
      incomparabilityReason: null,
      targetIncomplete,
      removalConfidence,
      counts,
      summary: summarise(counts),
      changes: [],
    };
  }

  // ------------------------------------------------------------------- nodes
  const baseNodes = indexById(base.graph.nodes);
  const targetNodes = indexById(target.graph.nodes);

  const removedNodes: GraphNode[] = [];
  const addedNodes: GraphNode[] = [];

  for (const [id, node] of baseNodes) {
    const counterpart = targetNodes.get(id);
    if (!counterpart) {
      removedNodes.push(node);
      continue;
    }
    recordNodeModification(counts, changes, node, counterpart, includeChanges, maxChanges);
    recordEvidenceRebinding(
      counts,
      changes,
      'node',
      node,
      counterpart,
      counterpart.qualifiedName ?? counterpart.name,
      includeChanges,
      maxChanges,
    );
  }
  for (const [id, node] of targetNodes) {
    if (!baseNodes.has(id)) addedNodes.push(node);
  }

  // Renames are resolved before additions and removals are reported, so a renamed file
  // is not simultaneously reported as one removed and one added.
  const renames = detectRenames(removedNodes, addedNodes);
  const renamedFrom = new Set(renames.map((pair) => pair.from.id));
  const renamedTo = new Set(renames.map((pair) => pair.to.id));

  for (const pair of renames) {
    counts.NODE_RENAMED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'NODE_RENAMED',
        entityKind: 'node',
        entityId: pair.to.id,
        previousEntityId: pair.from.id,
        label: `${pair.from.qualifiedName ?? pair.from.name} → ${pair.to.qualifiedName ?? pair.to.name}`,
        nodeKind: pair.to.kind,
        changedFields: ['path', 'qualifiedName'],
        evidenceBefore: pair.from.evidence,
        evidenceAfter: pair.to.evidence,
        confidence: pair.to.confidence,
        // The rename is established from identical content, not from the repository
        // stating that a rename happened. That is an inference, however strong.
        claimConfidence: 'STRONGLY_INFERRED',
        indeterminate: false,
      });
    }
  }

  for (const node of removedNodes) {
    if (renamedFrom.has(node.id)) continue;
    counts.NODE_REMOVED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'NODE_REMOVED',
        entityKind: 'node',
        entityId: node.id,
        label: node.qualifiedName ?? node.name,
        nodeKind: node.kind,
        evidenceBefore: node.evidence,
        evidenceAfter: [],
        confidence: node.confidence,
        claimConfidence: removalConfidence,
        indeterminate: targetIncomplete,
        ...(targetIncomplete
          ? {
              reason:
                'The target analysis hit a limit, so this entity was not observed in it. Absence here does not establish removal.',
            }
          : {}),
      });
    }
  }

  for (const node of addedNodes) {
    if (renamedTo.has(node.id)) continue;
    counts.NODE_ADDED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'NODE_ADDED',
        entityKind: 'node',
        entityId: node.id,
        label: node.qualifiedName ?? node.name,
        nodeKind: node.kind,
        evidenceBefore: [],
        evidenceAfter: node.evidence,
        confidence: node.confidence,
        claimConfidence: 'EXPLICIT',
        indeterminate: false,
      });
    }
  }

  // ------------------------------------------------------------------- edges
  const baseEdges = indexById(base.graph.edges);
  const targetEdges = indexById(target.graph.edges);

  for (const [id, edge] of baseEdges) {
    const counterpart = targetEdges.get(id);
    if (!counterpart) {
      counts.EDGE_REMOVED += 1;
      if (includeChanges && changes.length < maxChanges) {
        changes.push(edgeChange('EDGE_REMOVED', edge, undefined, removalConfidence, targetIncomplete));
      }
      continue;
    }
    recordEdgeModification(counts, changes, edge, counterpart, includeChanges, maxChanges);
    recordEvidenceRebinding(
      counts,
      changes,
      'edge',
      edge,
      counterpart,
      `${counterpart.kind} ${counterpart.from} → ${counterpart.to}`,
      includeChanges,
      maxChanges,
    );
  }

  for (const [id, edge] of targetEdges) {
    if (baseEdges.has(id)) continue;
    counts.EDGE_ADDED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push(edgeChange('EDGE_ADDED', undefined, edge, 'EXPLICIT', false));
    }
  }

  // ---------------------------------------------------------------- evidence
  recordEvidenceChanges(counts, changes, base.graph.evidence, target.graph.evidence, {
    includeChanges,
    maxChanges,
    claimConfidence: removalConfidence,
    indeterminate: targetIncomplete,
  });

  // Confidence changes are recorded per node and per edge as their own category, so a
  // merge that downgraded a fact is visible even though the entity itself did not change.
  // Edges are included because a relationship's strength is downgraded by the builder when
  // observations merge, and that downgrade is a change in its own right.
  for (const [id, node] of baseNodes) {
    const counterpart = targetNodes.get(id);
    if (!counterpart || counterpart.confidence === node.confidence) continue;
    counts.CONFIDENCE_CHANGED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'CONFIDENCE_CHANGED',
        entityKind: 'node',
        entityId: id,
        label: `${node.qualifiedName ?? node.name}: ${node.confidence} → ${counterpart.confidence}`,
        nodeKind: node.kind,
        changedFields: ['confidence'],
        evidenceBefore: node.evidence,
        evidenceAfter: counterpart.evidence,
        confidence: counterpart.confidence,
        claimConfidence: 'EXPLICIT',
        indeterminate: false,
      });
    }
  }

  for (const [id, edge] of baseEdges) {
    const counterpart = targetEdges.get(id);
    if (!counterpart || counterpart.confidence === edge.confidence) continue;
    counts.CONFIDENCE_CHANGED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'CONFIDENCE_CHANGED',
        entityKind: 'edge',
        entityId: id,
        label: `${edge.kind} ${edge.from} → ${edge.to}: ${edge.confidence} → ${counterpart.confidence}`,
        edgeKind: edge.kind,
        changedFields: ['confidence'],
        evidenceBefore: edge.evidence,
        evidenceAfter: counterpart.evidence,
        confidence: counterpart.confidence,
        claimConfidence: 'EXPLICIT',
        indeterminate: false,
      });
    }
  }

  changes.sort(compareChanges);

  return {
    base: base.provenance,
    target: target.provenance,
    identical: false,
    comparable: true,
    incomparabilityReason: null,
    targetIncomplete,
    removalConfidence,
    counts,
    summary: summarise(counts),
    changes,
  };
}

function emptyCounts(): Record<DriftCategory, number> {
  return {
    NODE_ADDED: 0,
    NODE_REMOVED: 0,
    NODE_MODIFIED: 0,
    NODE_RENAMED: 0,
    EDGE_ADDED: 0,
    EDGE_REMOVED: 0,
    EDGE_MODIFIED: 0,
    EVIDENCE_ADDED: 0,
    EVIDENCE_REMOVED: 0,
    EVIDENCE_CHANGED: 0,
    CONFIDENCE_CHANGED: 0,
  };
}

function summarise(counts: Record<DriftCategory, number>): DriftSummary {
  const summary: DriftSummary = {
    nodesAdded: counts.NODE_ADDED,
    nodesRemoved: counts.NODE_REMOVED,
    nodesModified: counts.NODE_MODIFIED,
    nodesRenamed: counts.NODE_RENAMED,
    relationshipsAdded: counts.EDGE_ADDED,
    relationshipsRemoved: counts.EDGE_REMOVED,
    relationshipsModified: counts.EDGE_MODIFIED,
    evidenceAdded: counts.EVIDENCE_ADDED,
    evidenceRemoved: counts.EVIDENCE_REMOVED,
    evidenceChanged: counts.EVIDENCE_CHANGED,
    confidenceChanged: counts.CONFIDENCE_CHANGED,
    totalChanges: DRIFT_CATEGORIES.reduce((sum, category) => sum + counts[category], 0),
  };
  return summary;
}

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) index.set(item.id, item);
  return index;
}

/** Fields whose difference constitutes a meaningful modification of a node. */
const NODE_COMPARED_FIELDS = [
  'name',
  'qualifiedName',
  'path',
  'startLine',
  'endLine',
  'language',
  'digest',
] as const;

function recordNodeModification(
  counts: Record<DriftCategory, number>,
  changes: DriftChange[],
  before: GraphNode,
  after: GraphNode,
  includeChanges: boolean,
  maxChanges: number,
): void {
  const changedFields: string[] = [];
  for (const field of NODE_COMPARED_FIELDS) {
    if (before[field] !== after[field]) changedFields.push(field);
  }
  if (stableStringify(before.attributes ?? {}) !== stableStringify(after.attributes ?? {})) {
    changedFields.push('attributes');
  }

  if (changedFields.length === 0) return;
  counts.NODE_MODIFIED += 1;
  if (!includeChanges || changes.length >= maxChanges) return;

  changes.push({
    category: 'NODE_MODIFIED',
    entityKind: 'node',
    entityId: after.id,
    label: after.qualifiedName ?? after.name,
    nodeKind: after.kind,
    changedFields,
    evidenceBefore: before.evidence,
    evidenceAfter: after.evidence,
    confidence: after.confidence,
    claimConfidence: 'EXPLICIT',
    indeterminate: false,
  });
}

/** The minimal shape `recordEvidenceRebinding` needs, so nodes and edges share it. */
interface CitedEntity {
  id: string;
  evidence: EvidenceRef[];
  confidence: Confidence;
}

/**
 * Records a change in which locations cite an entity that exists in both snapshots.
 *
 * An evidence id encodes its path, kind and line, so a citation that moved becomes a
 * different record rather than the same record with new coordinates. The observable fact
 * is therefore "this entity is now cited somewhere else", which is what this records.
 */
function recordEvidenceRebinding(
  counts: Record<DriftCategory, number>,
  changes: DriftChange[],
  entityKind: DriftEntityKind,
  before: CitedEntity,
  after: CitedEntity,
  label: string,
  includeChanges: boolean,
  maxChanges: number,
): void {
  const beforeIds = citationKey(before.evidence);
  const afterIds = citationKey(after.evidence);
  if (beforeIds === afterIds) return;

  counts.EVIDENCE_CHANGED += 1;
  if (!includeChanges || changes.length >= maxChanges) return;

  changes.push({
    category: 'EVIDENCE_CHANGED',
    entityKind,
    entityId: after.id,
    label: `${label}: ${describeCitations(before.evidence)} → ${describeCitations(after.evidence)}`,
    changedFields: ['evidence'],
    evidenceBefore: [...before.evidence],
    evidenceAfter: [...after.evidence],
    confidence: after.confidence,
    claimConfidence: 'EXPLICIT',
    indeterminate: false,
  });
}

/** Order-independent fingerprint of a citation set. */
function citationKey(evidence: readonly EvidenceRef[]): string {
  return evidence
    .map((ref) => `${ref.path}:${ref.startLine}:${ref.kind}`)
    .sort()
    .join(',');
}

function describeCitations(evidence: readonly EvidenceRef[]): string {
  const first = evidence[0];
  if (!first) return 'no citations';
  const suffix = evidence.length > 1 ? ` +${evidence.length - 1}` : '';
  return `${first.path}:${first.startLine}${suffix}`;
}

const EDGE_COMPARED_FIELDS = ['kind', 'confidence', 'label'] as const;

function recordEdgeModification(
  counts: Record<DriftCategory, number>,
  changes: DriftChange[],
  before: GraphEdge,
  after: GraphEdge,
  includeChanges: boolean,
  maxChanges: number,
): void {
  const changedFields: string[] = [];
  for (const field of EDGE_COMPARED_FIELDS) {
    if (before[field] !== after[field]) changedFields.push(field);
  }
  if (stableStringify(before.attributes ?? {}) !== stableStringify(after.attributes ?? {})) {
    changedFields.push('attributes');
  }
  if (changedFields.length === 0) return;

  counts.EDGE_MODIFIED += 1;
  if (!includeChanges || changes.length >= maxChanges) return;

  changes.push({
    category: 'EDGE_MODIFIED',
    entityKind: 'edge',
    entityId: after.id,
    label: `${before.kind} ${before.from} → ${before.to}`,
    edgeKind: after.kind,
    changedFields,
    evidenceBefore: before.evidence,
    evidenceAfter: after.evidence,
    confidence: after.confidence,
    claimConfidence: 'EXPLICIT',
    indeterminate: false,
  });
}

function edgeChange(
  category: DriftCategory,
  before: GraphEdge | undefined,
  after: GraphEdge | undefined,
  claimConfidence: DriftClaimConfidence,
  indeterminate: boolean,
): DriftChange {
  const edge = after ?? before;
  const changed: DriftChange = {
    category,
    entityKind: 'edge',
    entityId: edge?.id ?? '',
    label: edge ? `${edge.kind} ${edge.from} → ${edge.to}` : '',
    evidenceBefore: before?.evidence ?? [],
    evidenceAfter: after?.evidence ?? [],
    confidence: edge?.confidence ?? 'UNKNOWN',
    claimConfidence,
    indeterminate,
  };
  if (edge) changed.edgeKind = edge.kind;
  if (indeterminate) {
    changed.reason =
      'The target analysis hit a limit, so this relationship was not observed in it. Absence here does not establish removal.';
  }
  return changed;
}

/**
 * Detects renames by content identity.
 *
 * Rules, all of which must hold:
 *  1. both nodes are of the same kind;
 *  2. both carry a content digest, and the digests are equal;
 *  3. the digests are unique across the candidate sets, so the pairing is unambiguous.
 *
 * A rename that also changed content fails rule 2 and is reported as removed plus added.
 * Two files with identical content fail rule 3 for the same reason: the pairing would be
 * a guess.
 */
export function detectRenames(
  removed: readonly GraphNode[],
  added: readonly GraphNode[],
): { from: GraphNode; to: GraphNode }[] {
  const removedByDigest = new Map<string, GraphNode[]>();
  const addedByDigest = new Map<string, GraphNode[]>();

  for (const node of removed) {
    if (!node.digest) continue;
    const list = removedByDigest.get(node.digest);
    if (list) list.push(node);
    else removedByDigest.set(node.digest, [node]);
  }
  for (const node of added) {
    if (!node.digest) continue;
    const list = addedByDigest.get(node.digest);
    if (list) list.push(node);
    else addedByDigest.set(node.digest, [node]);
  }

  const pairs: { from: GraphNode; to: GraphNode }[] = [];
  for (const [digest, removals] of removedByDigest) {
    if (removals.length !== 1) continue;
    const additions = addedByDigest.get(digest);
    if (!additions || additions.length !== 1) continue;
    const from = removals[0]!;
    const to = additions[0]!;
    if (from.kind !== to.kind) continue;
    if ((from.language ?? '') !== (to.language ?? '')) continue;
    pairs.push({ from, to });
  }

  // Deterministic ordering regardless of Map iteration details.
  pairs.sort((a, b) => (a.to.id < b.to.id ? -1 : a.to.id > b.to.id ? 1 : 0));
  return pairs;
}

type EvidenceRecord = SoftwareGraph['evidence'][number];

interface EvidenceCompareOptions {
  includeChanges: boolean;
  maxChanges: number;
  /**
   * How strongly a claim of removal is supported. Evidence is as unassertable as a node
   * when the target analysis was incomplete: a citation that is absent from a partial walk
   * was not looked for, not deleted.
   */
  claimConfidence: DriftClaimConfidence;
  indeterminate: boolean;
}

function recordEvidenceChanges(
  counts: Record<DriftCategory, number>,
  changes: DriftChange[],
  base: readonly EvidenceRecord[],
  target: readonly EvidenceRecord[],
  options: EvidenceCompareOptions,
): void {
  const { includeChanges, maxChanges, claimConfidence, indeterminate } = options;
  const baseById = indexById(base);
  const targetById = indexById(target);

  for (const [id, before] of baseById) {
    const after = targetById.get(id);
    if (!after) {
      counts.EVIDENCE_REMOVED += 1;
      if (includeChanges && changes.length < maxChanges) {
        changes.push({
          category: 'EVIDENCE_REMOVED',
          entityKind: 'evidence',
          entityId: id,
          label: `${before.path}:${before.startLine}`,
          evidenceBefore: [],
          evidenceAfter: [],
          confidence: 'EXPLICIT',
          claimConfidence,
          indeterminate,
          ...(indeterminate
            ? {
                reason:
                  'The target analysis hit a limit, so this citation was not observed in it. Absence here does not establish that the citation was deleted.',
              }
            : {}),
        });
      }
      continue;
    }
    // Nothing else to compare per record: an evidence id encodes its path, kind and line,
    // so two records sharing an id are identical by construction. A citation that moved is
    // a *different* record, and is visible as EVIDENCE_REMOVED plus EVIDENCE_ADDED here
    // and as EVIDENCE_CHANGED on the entity that cites it.
  }

  for (const [id, after] of targetById) {
    if (baseById.has(id)) continue;
    counts.EVIDENCE_ADDED += 1;
    if (includeChanges && changes.length < maxChanges) {
      changes.push({
        category: 'EVIDENCE_ADDED',
        entityKind: 'evidence',
        entityId: id,
        label: `${after.path}:${after.startLine}`,
        evidenceBefore: [],
        evidenceAfter: [],
        confidence: 'EXPLICIT',
        claimConfidence: 'EXPLICIT',
        indeterminate: false,
      });
    }
  }
}

/**
 * Total order over change records.
 *
 * Sorting makes the report reproducible: two runs over the same pair of snapshots produce
 * byte-identical output, which is what allows a drift report to be diffed itself.
 */
function compareChanges(a: DriftChange, b: DriftChange): number {
  const byCategory = a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  if (byCategory !== 0) return byCategory;
  if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
  return 0;
}