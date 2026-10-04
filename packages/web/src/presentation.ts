import type { AnalysisListEntry, ArtifactEdge, DriftChange, DriftReport } from './api';

/**
 * Decision logic behind the C4 and Drift views.
 *
 * Extracted from the components so it can be tested without a DOM. The project has no
 * browser test infrastructure and browser rendering is unverified (`docs/verification.md`),
 * which is exactly the state in which untested UI logic is most likely to be wrong: it is
 * never exercised until a person opens the page.
 *
 * Each function here answers a question where the *wrong answer misleads* rather than merely
 * looks wrong — which analysis a change belongs to, which relationships are trustworthy, what
 * "no change" actually means.
 */

/**
 * Which analysis a drift change should be inspected in.
 *
 * A removal is a statement about the state the entity was last seen in, so it belongs to the
 * base snapshot; everything else describes the target. Opening a removal in the target would
 * 404 on an entity that no longer exists, which would look like a broken link rather than a
 * correct answer.
 */
export function analysisForChange(change: DriftChange, report: DriftReport): string | null {
  if (change.entityKind !== 'node') return null;
  return change.category === 'NODE_REMOVED' ? report.base.analysisId : report.target.analysisId;
}

/**
 * How strongly a drift report's "nothing changed" may be read.
 *
 * Four states that all render as an empty list, and must not be conflated:
 */
export type DriftState = 'identical' | 'incomparable' | 'changed' | 'unknown';

/**
 * Classifies a report for display.
 *
 * `unknown` is distinct from `identical` on purpose. A report that failed to load and a report
 * that found no differences must never render identically, because one of them means "we do not
 * know" and the other means "we checked".
 */
export function driftState(report: DriftReport | null, loading: boolean, error: string | null): DriftState {
  if (error !== null) return 'unknown';
  if (loading) return 'unknown';
  if (!report) return 'unknown';
  if (!report.comparable) return 'incomparable';
  if (report.identical) return 'identical';
  return 'changed';
}

/**
 * True when removals in this report can be asserted as removals.
 *
 * False means every removal row must be presented as "not looked for" rather than "gone".
 */
export function removalsAreAssertable(report: DriftReport | null): boolean {
  if (!report) return false;
  return !report.targetIncomplete;
}

/**
 * Describes what justifies a projected relationship.
 *
 * Returns `null` for a relationship with no graph support at all. That case should be
 * unreachable — the projection drops such relationships — so returning it explicitly lets the
 * UI surface a violation instead of rendering an arrow that looks evidenced.
 */
export function describeSupport(edge: ArtifactEdge): string | null {
  const edges = edge.supportingEdgeIds ?? [];
  const nodes = edge.supportingNodeIds ?? [];
  if (edges.length === 0 && nodes.length === 0) return null;
  return [...edges.map((id) => `edge ${id}`), ...nodes.map((id) => `node ${id}`)].join(', ');
}

/** True when a relationship is backed only by the existence of nodes, not by an edge. */
export function isExistenceOnly(edge: ArtifactEdge): boolean {
  return (edge.supportingEdgeIds?.length ?? 0) === 0 && (edge.supportingNodeIds?.length ?? 0) > 0;
}

/**
 * The analysis to compare against by default: the previous one.
 *
 * Analyses arrive newest first. `previous` is the answer to the question a reader almost always
 * has — "what did my last change do?" — but it must never be returned as the analysis being
 * compared, and it must not be returned at all when there is no earlier analysis, because a
 * self-comparison would render as a confident "nothing changed".
 */
export function defaultComparisonId(
  analyses: readonly AnalysisListEntry[],
  currentId: string,
): string | null {
  const ordered = [...analyses].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const index = ordered.findIndex((entry) => entry.id === currentId);
  const candidate = index >= 0 ? ordered[index + 1] : ordered.find((entry) => entry.id !== currentId);
  if (!candidate || candidate.id === currentId) return null;
  return candidate.status === 'succeeded' ? candidate.id : null;
}

/**
 * How many analyses can take part in a comparison.
 *
 * A failed or running analysis has no graph, so it cannot be a side of a report. Counting it
 * would promise a comparison the server will refuse.
 */
export function comparableAnalysisCount(analyses: readonly AnalysisListEntry[]): number {
  return analyses.filter((entry) => entry.status === 'succeeded').length;
}
