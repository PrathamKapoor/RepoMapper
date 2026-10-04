import type {
  AnalysisListEntry,
  ArtifactEdge,
  ConsistencyFinding,
  ConsistencyReport,
  DriftChange,
  DriftReport,
  Requirement,
  Traceability,
} from './api';

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

// ---------------------------------------------------------------------------
// Requirements, consistency and traceability
// ---------------------------------------------------------------------------

/**
 * How a requirement should be read.
 *
 * The distinction that matters is whether the repository *stated* it or a rule *derived* it from
 * the code. Both are shown; neither is presented as the other. `UNSUPPORTED` is reported as
 * "this repository cannot support that claim" rather than as a failure.
 */
export function requirementReadability(requirement: Requirement): 'stated' | 'derived' | 'partial' | 'unsupported' {
  if (requirement.status === 'UNSUPPORTED') return 'unsupported';
  if (requirement.status === 'PARTIAL' || requirement.status === 'UNKNOWN') return 'partial';
  return requirement.origin === 'declared' ? 'stated' : 'derived';
}

/** Short label for a requirement's status, worded so it never implies a verdict on the code. */
export function requirementStatusLabel(requirement: Requirement): string {
  switch (requirementReadability(requirement)) {
    case 'stated':
      return 'stated by the repository';
    case 'derived':
      return 'derived from code';
    case 'partial':
      return 'partly evidenced';
    case 'unsupported':
      return 'not supported by this repository';
  }
}

/**
 * Requirements ordered for reading.
 *
 * Declared requirements come first because they are the ones a person wrote down; derived ones
 * follow. Within each group the sort is by id, so the order is stable across reloads — an
 * unstable list would make a reader think the repository changed.
 */
export function orderRequirements(requirements: readonly Requirement[]): Requirement[] {
  return [...requirements].sort((a, b) => {
    const rank = (requirement: Requirement): number => (requirement.origin === 'declared' ? 0 : 1);
    const byOrigin = rank(a) - rank(b);
    return byOrigin !== 0 ? byOrigin : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The headline for a consistency report.
 *
 * A report must never lead with a count of problems without saying how many checks actually
 * ran, because "3 problems" from 3 checks and from 30 are not the same claim.
 */
export function consistencyHeadline(report: ConsistencyReport | null, loading: boolean, error: string | null): string {
  if (error !== null) return `Consistency could not be loaded: ${error}`;
  if (loading || !report) return 'Checking the views against each other…';
  const problems =
    report.counts.CONTRADICTION + report.counts.MISSING_EVIDENCE + report.counts.PARTIAL_EVIDENCE + report.counts.UNSUPPORTED_INFERENCE;
  if (problems === 0 && report.counts.CONSISTENT === 0) {
    return `Nothing could be established across ${report.compared.length} representations from this repository. That is different from agreement.`;
  }
  if (problems === 0) {
    return `${report.counts.CONSISTENT} agreement(s) confirmed across ${report.compared.length} representations, with nothing left unevidenced.`;
  }
  return `${problems} claim(s) not fully evidenced across ${report.compared.length} representations; ${report.counts.CONSISTENT} agreement(s) confirmed. Absence is reported as absence.`;
}

/**
 * Findings ordered so the reader sees what needs a decision first.
 *
 * Contradictions first because they are the only class where two statements cannot both be
 * true. Absent evidence follows, then recorded agreement last: agreement is context, not a
 * problem, and putting it at the top would bury the finding that matters.
 */
export function orderFindings(findings: readonly ConsistencyFinding[]): ConsistencyFinding[] {
  const rank = (finding: ConsistencyFinding): number => {
    switch (finding.class) {
      case 'CONTRADICTION':
        return 0;
      case 'UNSUPPORTED_INFERENCE':
        return 1;
      case 'PARTIAL_EVIDENCE':
        return 2;
      case 'MISSING_EVIDENCE':
        return 3;
      case 'CONSISTENT':
        return 4;
    }
  };
  return [...findings].sort((a, b) => {
    const byClass = rank(a) - rank(b);
    if (byClass !== 0) return byClass;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** True when the report contains something a person should act on. */
export function consistencyNeedsAttention(report: ConsistencyReport | null): boolean {
  if (!report) return false;
  return report.counts.CONTRADICTION > 0 || report.counts.UNSUPPORTED_INFERENCE > 0;
}

/**
 * What to say about a traceability chain.
 *
 * The four states are distinct because they ask for different actions: a complete chain is
 * confirmed; a chain with a break needs investigation; an absent subject is a wrong id; and a
 * subject the graph does not hold is a real answer about the repository.
 */
export type TraceView =
  | { kind: 'complete'; text: string }
  | { kind: 'broken'; text: string; breaks: { kind: string; reason: string }[] }
  | { kind: 'missing'; text: string };

export function traceView(trace: Traceability | null, loading: boolean, error: string | null): TraceView {
  if (error !== null) return { kind: 'missing', text: `Chain could not be loaded: ${error}` };
  if (loading) return { kind: 'missing', text: 'Following the chain…' };
  if (!trace) return { kind: 'missing', text: 'No chain for this entity.' };
  if (trace.complete) {
    return { kind: 'complete', text: `Every joint traced: ${trace.summary}` };
  }
  return {
    kind: 'broken',
    text: `${trace.breaks.length} joint(s) the repository does not evidence.`,
    breaks: trace.breaks,
  };
}

/**
 * Counts per chain role, in the order the chain is read.
 *
 * Ordered rather than sorted so the four numbers line up with the four stages a reader expects,
 * and a zero is shown rather than hidden — "no test" is a fact worth seeing.
 */
export function chainCounts(trace: Traceability | null): { role: Traceability['links'][number]['role']; count: number }[] {
  const roles: Traceability['links'][number]['role'][] = ['requirement', 'use_case', 'implementation', 'test'];
  if (!trace) return roles.map((role) => ({ role, count: 0 }));
  return roles.map((role) => ({ role, count: trace.links.filter((link) => link.role === role).length }));
}
