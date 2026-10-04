import type { Confidence, EvidenceRef, GraphNode, SoftwareGraph } from './types.js';
import { nodeId as makeNodeId } from './ids.js';
import { buildRequirements, type Requirement } from './requirements.js';
import { buildUseCases, type UseCase } from './use-cases.js';

/**
 * Traceability.
 *
 * The chain a reader actually asks about is: *what does this repository claim, what triggers
 * it, what code satisfies it, and what checks it?* Answering that needs one traversal rather
 * than four separate views stitched together by hand, and the answer has to be honest about
 * each joint — a requirement with no test is a different fact from a requirement with a test
 * that fails to reach it.
 *
 * This module is the spine. It reads the graph and the requirement and use-case models, and it
 * reports every link with the evidence behind it. It creates no facts of its own: a link exists
 * only where a graph relationship exists.
 */

/** Which joint of the chain is broken, or `null` when the chain is complete. */
export type TraceBreakKind =
  | 'NO_REQUIREMENT'
  | 'NO_USE_CASE'
  | 'NO_IMPLEMENTATION'
  | 'NO_TEST'
  | 'NO_EVIDENCE';

export interface TraceLink {
  /** What part of the chain this link is. */
  role: 'requirement' | 'use_case' | 'implementation' | 'test';
  id: string;
  label: string;
  kind: string;
  /** Graph relationships that make the link. Empty when the link rests on the node alone. */
  edgeIds: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  /** For a use case link, why it belongs to this subject. */
  note?: string;
}

export interface TraceBreak {
  kind: TraceBreakKind;
  reason: string;
}

export interface Traceability {
  /** The graph entity the chain was requested for. */
  subject: { id: string; name: string; kind: GraphNode['kind'] };
  links: TraceLink[];
  /** Joints that could not be established, in chain order. Empty when the chain is complete. */
  breaks: TraceBreak[];
  /** True only when every joint in the chain was established. */
  complete: boolean;
  summary: string;
}

/** Bounds traversal so a cyclic call graph terminates. Matches the use-case walk. */
const MAX_IMPLEMENTATION_DEPTH = 6;

/** Maximum implementation nodes recorded for one subject. */
const MAX_IMPLEMENTATION_NODES = MAX_IMPLEMENTATION_DEPTH * 4;

/**
 * Builds the requirement → use case → implementation → test chain for one graph entity.
 *
 * `subjectId` may name an entry point, a function, or anything reachable from one. When the
 * subject is not an entry point, the use cases considered are those whose steps include it, so
 * asking about a service function answers "which entry points reach this, and what do they
 * claim".
 */
export function traceSubject(graph: SoftwareGraph, subjectId: string): Traceability | null {
  const requirements = buildRequirements(graph).requirements;
  return traceSubjectWith(graph, { requirements, useCases: buildUseCases(graph, requirements).useCases }, subjectId);
}

/** The models a chain is read from. Built once and shared, never rebuilt per subject. */
interface ChainModels {
  requirements: readonly Requirement[];
  useCases: readonly UseCase[];
}

/**
 * The chain, given models that have already been built.
 *
 * Separate from `traceSubject` because building the requirement and use-case models walks the
 * whole graph: doing that once per entry point turned a 300 ms index into fifteen seconds on a
 * repository with twenty-two endpoints, which a browser waits on.
 */
function traceSubjectWith(graph: SoftwareGraph, models: ChainModels, subjectId: string): Traceability | null {
  const subject = graph.nodes.find((node) => node.id === subjectId);
  if (!subject) return null;

  const requirements = models.requirements;
  const useCases = models.useCases;
  const relevant = relevantUseCases(useCases, subjectId);

  const links: TraceLink[] = [];
  const breaks: TraceBreak[] = [];

  // ------------------------------------------------------------ requirement
  const requirementLinks = requirementLinksFor(requirements, relevant, subjectId);
  links.push(...requirementLinks);
  if (requirementLinks.length === 0) {
    breaks.push({
      kind: 'NO_REQUIREMENT',
      reason:
        'No requirement in the repository states or derives from this entry point. That is not a defect: a repository may expose behaviour nobody has written down.',
    });
  }

  // --------------------------------------------------------------- use case
  const useCaseLinks: TraceLink[] = relevant.map((useCase) => ({
    role: 'use_case' as const,
    id: useCase.id,
    label: useCase.title,
    kind: useCase.entryKind,
    edgeIds: useCase.steps.flatMap((step) => step.viaEdgeIds),
    evidence: useCase.evidence,
    confidence: useCase.confidence,
    note: useCase.status === 'OBSERVED' ? 'Every step came from a call relationship.' : useCase.missing[0],
  }));
  links.push(...useCaseLinks);
  if (useCaseLinks.length === 0) {
    breaks.push({
      kind: 'NO_USE_CASE',
      reason:
        'Nothing in the graph names this entity as an entry point, so no use case is recovered for it.',
    });
  }

  // --------------------------------------------------------- implementation
  const implementation = implementationOf(graph, subjectId, relevant);
  links.push(...implementation.links);
  if (implementation.links.length === 0) {
    breaks.push({
      kind: 'NO_IMPLEMENTATION',
      reason: 'No call relationship connects this entity to the code that would serve it.',
    });
  }

  // ------------------------------------------------------------------- test
  const tests = testLinksFor(graph, [...implementation.ids, subjectId]);
  links.push(...tests);
  if (tests.length === 0) {
    breaks.push({
      kind: 'NO_TEST',
      reason:
        'No test entity or test-file function calls this handler directly. A test reaching it through a helper is not attributed, so this reports the limit of the matching rather than a verdict on coverage.',
    });
  }

  // Every link must cite something. A link with neither a relationship nor evidence is a
  // claim with nothing behind it, and is reported rather than shown.
  const unsupported = links.filter((link) => link.edgeIds.length === 0 && link.evidence.length === 0);
  if (unsupported.length > 0) {
    breaks.push({
      kind: 'NO_EVIDENCE',
      reason: `${unsupported.length} link(s) in this chain cite no relationship and no evidence.`,
    });
  }
  const usable = links.filter((link) => link.edgeIds.length > 0 || link.evidence.length > 0);

  return {
    subject: { id: subject.id, name: subject.name, kind: subject.kind },
    links: usable,
    breaks,
    complete: breaks.length === 0,
    summary: usable.length === 0
      ? `Nothing in the graph traces to ${subject.name}.`
      : `${countRole(usable, 'requirement')} requirement(s), ${countRole(usable, 'use_case')} use case(s), ${countRole(usable, 'implementation')} implementation node(s) and ${countRole(usable, 'test')} test(s) trace to ${subject.name}${breaks.length === 0 ? '; the chain is complete.' : `, with ${breaks.length} joint(s) the repository does not evidence.`}`,
  };
}

/**
 * Traceability for every entry point in the repository.
 *
 * The index view: one row per entry point with the four chain counts, so a reader can see at a
 * glance which entry points are fully traced. Bounded by the number of entry points, which is
 * already bounded by the graph.
 */
export function traceAll(graph: SoftwareGraph): {
  rows: { subjectId: string; title: string; entryKind: string; requirements: number; useCases: number; implementation: number; tests: number; complete: boolean }[];
  totals: { subjects: number; complete: number; incomplete: number };
} {
  // Built once for the whole index. `traceAll` exists to give a reader the whole picture at
  // once; rebuilding the models per row would make it quadratic in the number of entry points.
  const requirements = buildRequirements(graph).requirements;
  const models: ChainModels = { requirements, useCases: buildUseCases(graph, requirements).useCases };
  const entryKinds = new Set<string>(['api_endpoint', 'event_consumer', 'cli_command']);

  const rows = graph.nodes
    .filter((node) => entryKinds.has(node.kind))
    .map((node) => {
      const trace = traceSubjectWith(graph, models, node.id)!;
      return {
        subjectId: node.id,
        title: node.name,
        entryKind: node.kind,
        requirements: countRole(trace.links, 'requirement'),
        useCases: countRole(trace.links, 'use_case'),
        implementation: countRole(trace.links, 'implementation'),
        tests: countRole(trace.links, 'test'),
        complete: trace.complete,
      };
    });

  return {
    rows,
    totals: {
      subjects: rows.length,
      complete: rows.filter((row) => row.complete).length,
      incomplete: rows.filter((row) => !row.complete).length,
    },
  };
}

function countRole(links: readonly TraceLink[], role: TraceLink['role']): number {
  return links.filter((link) => link.role === role).length;
}

/**
 * The use cases a subject belongs to.
 *
 * An entry point belongs to its own use case. Anything else belongs to every use case whose
 * traversal reached it, which is how asking about a helper function answers "what uses this".
 */
function relevantUseCases(useCases: readonly UseCase[], subjectId: string): UseCase[] {
  const isEntry = useCases.some((useCase) => useCase.entryNodeId === subjectId);
  if (isEntry) return useCases.filter((useCase) => useCase.entryNodeId === subjectId);

  return useCases.filter((useCase) => useCase.steps.some((step) => step.nodeId === subjectId));
}

function requirementLinksFor(
  requirements: readonly Requirement[],
  useCases: readonly UseCase[],
  subjectId: string,
): TraceLink[] {
  const byId = new Set<string>();
  for (const useCase of useCases) for (const id of useCase.supportsRequirementIds) byId.add(id);
  for (const requirement of requirements) {
    if (requirement.supportedByNodeIds.includes(subjectId)) byId.add(requirement.id);
  }

  return requirements
    .filter((requirement) => byId.has(requirement.id))
    .map((requirement) => ({
      role: 'requirement' as const,
      id: requirement.id,
      label: requirement.statement,
      kind: requirement.category,
      edgeIds: requirement.supportedByEdgeIds,
      evidence: requirement.evidence,
      confidence: requirement.confidence,
      note: requirement.origin === 'declared' ? 'Stated by the repository.' : 'Derived from the code.',
    }));
}

/**
 * The code that serves the subject.
 *
 * For an entry point that means the handler its route names. For anything else it means the
 * reachable functions, bounded and cycle-safe. Both are read from `calls` relationships, so the
 * chain cannot contain a node the graph does not connect.
 */
function implementationOf(
  graph: SoftwareGraph,
  subjectId: string,
  useCases: readonly UseCase[],
): { links: TraceLink[]; ids: string[] } {
  const nodes = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([subjectId]);
  const links: TraceLink[] = [];

  // When the subject is an entry point, the route's own `calls` edge is the direct link to
  // the handler; the rest of the chain comes from the use case's steps.
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls' || edge.from !== subjectId) continue;
    if (visited.has(edge.to)) continue;
    visited.add(edge.to);
    const node = nodes.get(edge.to);
    links.push({
      role: 'implementation',
      id: edge.to,
      label: node?.name ?? edge.to,
      kind: node?.kind ?? 'unknown',
      edgeIds: [edge.id],
      evidence: edge.evidence,
      confidence: edge.confidence,
      ...(edge.attributes?.derivedFrom === 'route.handler'
        ? { note: 'Named as the handler by the route registration.' }
        : {}),
    });
  }

  for (const useCase of useCases) {
    if (links.length >= MAX_IMPLEMENTATION_NODES) break;
    for (const step of useCase.steps) {
      if (links.length >= MAX_IMPLEMENTATION_NODES) break;
      if (visited.has(step.nodeId)) continue;
      visited.add(step.nodeId);
      const node = nodes.get(step.nodeId);
      links.push({
        role: 'implementation',
        id: step.nodeId,
        label: node?.name ?? step.nodeId,
        kind: node?.kind ?? 'unknown',
        edgeIds: step.viaEdgeIds,
        evidence: step.evidence,
        confidence: step.confidence,
      });
    }
  }

  return { links, ids: links.map((link) => link.id) };
}

function testLinksFor(graph: SoftwareGraph, implementationIds: readonly string[]): TraceLink[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const targets = new Set(implementationIds);
  const seen = new Set<string>();
  const links: TraceLink[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== 'tests' || !targets.has(edge.to)) continue;
    if (seen.has(edge.from)) continue;
    seen.add(edge.from);
    const node = nodes.get(edge.from);
    links.push({
      role: 'test',
      id: edge.from,
      label: node?.name ?? edge.from,
      kind: node?.kind ?? 'test',
      edgeIds: [edge.id],
      evidence: edge.evidence,
      confidence: edge.confidence,
      note: 'Calls the handler the endpoint names.',
    });
  }

  return links;
}

/**
 * A stable id for a graph entity, exposed so callers can build links to a trace subject
 * without duplicating the slug rules.
 */
export function traceabilitySubjectId(kind: GraphNode['kind'], qualifiedName: string): string {
  return makeNodeId(kind, qualifiedName);
}