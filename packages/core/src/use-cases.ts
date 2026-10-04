import type { Confidence, EvidenceRef, GraphNode, SoftwareGraph } from './types.js';
import type { Requirement } from './requirements.js';

/**
 * Use cases.
 *
 * A use case is an externally observable interaction with the system. That definition is the
 * whole design constraint: only an entry point someone outside the code could invoke qualifies
 * — an HTTP route, a CLI command, an event consumer, an exported function another system calls.
 *
 * Three things this module refuses to do, each of which is the usual way use-case diagrams go
 * wrong:
 *
 * 1. **No invented actors.** An actor exists only when the graph records something external
 *    interacting: an `authenticates`/`authorizes` relationship naming an actor, or an `actor`
 *    node, or an inbound `communicates_with`. A system with no evidence of who calls it gets
 *    `actor: null` and a stated reason, never "User".
 * 2. **Not every function is a use case.** A private helper is not an externally observable
 *    interaction, and treating one as a use case inflates the count with noise.
 * 3. **No fabricated steps.** Where the graph shows only part of an interaction, the use case
 *    is `PARTIAL` and says which part is missing. An empty step list is a result, not a failure
 *    to fill in.
 */

/** How much of the interaction the graph actually evidences. */
export const USE_CASE_STATUSES = ['OBSERVED', 'PARTIAL', 'UNKNOWN'] as const;
export type UseCaseStatus = (typeof USE_CASE_STATUSES)[number];

export const USE_CASE_ENTRY_KINDS = ['api_endpoint', 'event_consumer', 'cli_command', 'exported_function'] as const;

export type UseCaseEntryKind = (typeof USE_CASE_ENTRY_KINDS)[number];

export interface UseCaseStep {
  /** Graph entity that performs the step. */
  nodeId: string;
  label: string;
  kind: GraphNode['kind'];
  /** Graph edges that justify the step, in traversal order. */
  viaEdgeIds: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
}

export interface UseCaseActor {
  nodeId: string;
  name: string;
  /** How the repository evidences this actor. Never empty: an unevidenced actor is not one. */
  derivation: string;
  evidence: EvidenceRef[];
}

export interface UseCase {
  id: string;
  title: string;
  entryKind: UseCaseEntryKind;
  /** Graph node that is the entry point. */
  entryNodeId: string;
  /** The system under analysis, always the repository node. */
  systemNodeId: string;
  /** Null when the repository states no external interacting party. */
  actor: UseCaseActor | null;
  /** What sets the interaction off, as the repository states it. */
  trigger: string;
  /** Only what the graph records; empty means "not evidenced", not "none required". */
  preconditions: string[];
  steps: UseCaseStep[];
  /** What the interaction reaches, in evidence order. */
  postconditions: string[];
  status: UseCaseStatus;
  confidence: Confidence;
  derivation: string;
  evidence: EvidenceRef[];
  /** Requirements this use case supports, by requirement id. */
  supportsRequirementIds: string[];
  /** What this use case does *not* evidence, stated rather than left blank. */
  missing: string[];
}

export interface UseCaseModel {
  useCases: UseCase[];
  counts: Record<UseCaseStatus, number>;
  actors: UseCaseActor[];
  /** Entry points found in the graph, by kind, so a caller can see what was considered. */
  entryPoints: Record<UseCaseEntryKind, number>;
  notRecovered: { reason: string; count: number }[];
}

/** Hard ceiling on traversal. A pathological repository must not cause unbounded descent. */
export const MAX_USE_CASE_DEPTH = 6;

export function buildUseCases(graph: SoftwareGraph, requirements: readonly Requirement[] = []): UseCaseModel {
  const repository = graph.nodes.find((node) => node.kind === 'repository');
  const systemNodeId = repository?.id ?? '';
  const entryPoints = collectEntryPoints(graph);
  const actors = collectActors(graph);

  const useCases = entryPoints.map((entry) => buildUseCase(graph, entry, actors, systemNodeId, requirements));
  const counts: Record<UseCaseStatus, number> = { OBSERVED: 0, PARTIAL: 0, UNKNOWN: 0 };
  for (const useCase of useCases) counts[useCase.status] += 1;

  const entryCounts: Record<UseCaseEntryKind, number> = {
    api_endpoint: 0,
    event_consumer: 0,
    cli_command: 0,
    exported_function: 0,
  };
  for (const entry of entryPoints) entryCounts[entry.kind] += 1;

  return {
    useCases,
    counts,
    actors,
    entryPoints: entryCounts,
    notRecovered: notRecovered(graph, actors, entryPoints),
  };
}

interface EntryPoint {
  kind: UseCaseEntryKind;
  node: GraphNode;
  trigger: string;
}

function collectEntryPoints(graph: SoftwareGraph): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];

  for (const node of graph.nodes) {
    if (node.kind === 'api_endpoint') {
      entryPoints.push({ kind: 'api_endpoint', node, trigger: `A request arrives for ${node.name}` });
      continue;
    }

    // A task or consumer marker is the graph's only evidence of an event-driven entry point.
    if (node.kind === 'configuration' && str(node.attributes?.marker)?.startsWith('async.')) {
      entryPoints.push({
        kind: 'event_consumer',
        node,
        trigger: `${str(node.attributes?.marker)} handler ${node.name} is invoked`,
      });
      continue;
    }

    // A manifest script is recorded as a configuration node carrying its marker name. It is
    // an entry point because something outside the code runs it.
    if (node.kind === 'configuration' && str(node.attributes?.marker) === 'manifest.script') {
      entryPoints.push({ kind: 'cli_command', node, trigger: `The ${node.name} script is run` });
      continue;
    }
  }

  return entryPoints.sort((a, b) => (a.node.id < b.node.id ? -1 : 1));
}

/**
 * Actors the repository evidences.
 *
 * An `actor` node, or the source of an `authenticates`/`authorizes` relationship. The source is
 * the party being authenticated or the subject of the authorisation decision; the target is
 * what is being protected. Both mean the repository states that something outside the code is
 * involved. Anything else is absent, and the absence is reported rather than filled with a
 * placeholder name.
 */
function collectActors(graph: SoftwareGraph): UseCaseActor[] {
  const actors = new Map<string, UseCaseActor>();

  for (const node of graph.nodes) {
    if (node.kind === 'actor') {
      actors.set(node.id, {
        nodeId: node.id,
        name: node.name,
        derivation: 'An actor entity exists in the graph, which means the repository declares one.',
        evidence: node.evidence,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'authenticates' && edge.kind !== 'authorizes') continue;
    const source = graph.nodes.find((node) => node.id === edge.from);
    if (!source || source.kind === 'actor') continue;
    // Code is not an actor. A relationship whose subject is a module or a class says something
    // about the code, not about an external party.
    if (source.kind === 'module' || source.kind === 'class' || source.kind === 'function') continue;

    actors.set(source.id, {
      nodeId: source.id,
      name: source.qualifiedName ?? source.name,
      derivation: `The repository records a ${edge.kind} relationship whose subject is this entity, which places it outside the protected code path.`,
      evidence: edge.evidence,
    });
  }

  return [...actors.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

function buildUseCase(
  graph: SoftwareGraph,
  entry: EntryPoint,
  actors: readonly UseCaseActor[],
  systemNodeId: string,
  requirements: readonly Requirement[],
): UseCase {
  const steps = traverse(graph, entry.node);
  const missing: string[] = [];
  const groups: EvidenceRef[][] = [entry.node.evidence];
  for (const step of steps) groups.push(step.evidence);
  const evidence = dedupe(groups);

  // The strongest actor claim available: an actor declared in the same file as the entry
  // point. Failing that, a repository that evidences exactly one actor states its actor
  // unambiguously. With several candidates and no match, no actor is named — choosing one
  // would be a guess, and a named guess is worse than an admitted gap.
  const actor =
    actors.find((candidate) => inSameFile(graph, candidate.nodeId, entry.node)) ??
    (actors.length === 1 ? (actors[0] ?? null) : null);
  if (!actor) {
    missing.push(
      actors.length > 1
        ? `actor: ${actors.length} actors are evidenced and none is declared alongside this entry point, so no actor is named`
        : 'actor: nothing in the graph states who or what invokes this entry point, so no actor is named',
    );
  }

  if (steps.length === 0) {
    missing.push('steps: no call was resolved from this entry point, so the interaction is not observed');
  }

  const dataTouched = dataTargets(graph, steps);
  if (dataTouched.length === 0) {
    missing.push('persistence: no read or write was resolved from this entry point');
  }

  const preconditions = preconditionsOf(graph, steps);
  const postconditions = dataTouched.map(
    (node) => `${node.operation === 'write' ? 'writes' : 'reads'} ${node.name}`,
  );

  const status: UseCaseStatus = steps.length === 0 ? 'UNKNOWN' : missing.length > 1 ? 'PARTIAL' : 'OBSERVED';

  return {
    id: `use_case:${entry.kind}:${entry.node.id}`,
    title: titleOf(entry),
    entryKind: entry.kind,
    entryNodeId: entry.node.id,
    systemNodeId,
    actor,
    trigger: entry.trigger,
    preconditions,
    steps,
    postconditions,
    status,
    confidence: entry.node.confidence,
    derivation: `Composed from the ${entry.kind} entry point ${entry.node.id} and the ${steps.length} call relationship(s) reachable from it, within a depth of ${MAX_USE_CASE_DEPTH}.`,
    evidence,
    // A requirement belongs to this use case when the code it names is the entry point or
    // any node the walk reached. A requirement pointing at the handler is about this
    // interaction even though it never mentions the route.
    supportsRequirementIds: requirements
      .filter((requirement) =>
        requirement.supportedByNodeIds.some(
          (id) => id === entry.node.id || steps.some((step) => step.nodeId === id),
        ),
      )
      .map((requirement) => requirement.id)
      .sort(),
    missing,
  };
}

/**
 * Breadth-first walk of `calls` relationships from an entry point.
 *
 * Bounded by `MAX_USE_CASE_DEPTH` and by a visited set, so a cycle in the call graph
 * terminates and a deep chain cannot make this quadratic. Only `calls` and `imports` are
 * followed: a dependency is not a step in an interaction.
 */
function traverse(graph: SoftwareGraph, entry: GraphNode): UseCaseStep[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, SoftwareGraph['edges']>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const steps: UseCaseStep[] = [];
  const visited = new Set<string>([entry.id]);
  let frontier = [entry.id];

  for (let depth = 0; depth < MAX_USE_CASE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];

    for (const source of frontier) {
      const edges = (outgoing.get(source) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const edge of edges) {
        const target = byId.get(edge.to);
        if (!target) continue;
        steps.push({
          nodeId: target.id,
          label: target.qualifiedName ?? target.name,
          kind: target.kind,
          viaEdgeIds: [edge.id],
          evidence: edge.evidence,
          confidence: edge.confidence,
        });
        if (!visited.has(target.id)) {
          visited.add(target.id);
          next.push(target.id);
        }
      }
    }

    frontier = next;
  }

  return steps;
}

/** Data stores the interaction reaches, deduplicated and ordered. */
function dataTargets(graph: SoftwareGraph, steps: readonly UseCaseStep[]): { name: string; operation: string }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const touched = new Map<string, string>();

  for (const step of steps) {
    for (const edgeId of step.viaEdgeIds) {
      const edge = graph.edges.find((candidate) => candidate.id === edgeId);
      if (!edge || (edge.kind !== 'reads' && edge.kind !== 'writes')) continue;
      const target = byId.get(edge.to);
      if (target?.kind !== 'table') continue;
      touched.set(target.id, edge.kind);
    }
  }

  return [...touched.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, operation]) => ({ name: byId.get(id)?.name ?? id, operation }));
}

/** Preconditions the graph records: a guard call before the entry point's own work. */
function preconditionsOf(graph: SoftwareGraph, steps: readonly UseCaseStep[]): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const conditions: string[] = [];

  for (const step of steps) {
    const source = byId.get(step.nodeId);
    if (!source) continue;
    for (const edge of graph.edges) {
      if (edge.from !== step.nodeId || (edge.kind !== 'branches' && edge.kind !== 'loops')) continue;
      const condition = byId.get(edge.to);
      if (!condition) continue;
      conditions.push(`${source.qualifiedName ?? source.name} ${edge.kind === 'loops' ? 'loops while' : 'branches on'} ${String(condition.attributes?.condition ?? 'a condition')}`);
    }
  }

  return [...new Set(conditions)].sort().slice(0, 10);
}

function inSameFile(graph: SoftwareGraph, nodeId: string, entry: GraphNode): boolean {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node?.path || !entry.path) return false;
  return node.path === entry.path;
}

function titleOf(entry: EntryPoint): string {
  switch (entry.kind) {
    case 'api_endpoint':
      // The endpoint node's name is already `METHOD /route`, as the repository wrote it.
      return entry.node.name;
    case 'cli_command':
      return `Run the ${entry.node.name} script`;
    default:
      return entry.node.qualifiedName ?? entry.node.name;
  }
}

/** Claims this model deliberately does not make. */
function notRecovered(
  graph: SoftwareGraph,
  actors: readonly UseCaseActor[],
  entryPoints: readonly EntryPoint[],
): { reason: string; count: number }[] {
  const missing: { reason: string; count: number }[] = [];

  if (actors.length === 0) {
    missing.push({
      reason:
        'human actors: no actor entity, authenticates relationship or authorizes relationship exists, so no actor is named for any use case',
      count: entryPoints.length,
    });
  }

  const functions = graph.nodes.filter((node) => node.kind === 'function').length;
  missing.push({
    reason:
      'per-function use cases: an internal helper is not an externally observable interaction, so only declared entry points are recovered as use cases',
    count: functions,
  });

  missing.push({
    reason:
      'narrative steps such as preconditions written in prose: only what the graph records is stated, and the rest is reported as not evidenced',
    count: entryPoints.length,
  });

  return missing;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dedupe(groups: readonly (readonly EvidenceRef[])[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const group of groups) {
    for (const ref of group) if (!seen.has(ref.evidenceId)) seen.set(ref.evidenceId, ref);
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
}
