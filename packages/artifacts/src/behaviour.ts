import type { Confidence, EvidenceRef, GraphEdge, GraphNode, SoftwareGraph } from '@repoatlas/core';
import {
  hasGraphSupport,
  type Artifact,
  type ArtifactEdge,
  type ArtifactNode,
  type ProjectionContext,
} from './contract.js';

/**
 * Behaviour projections: sequence and activity.
 *
 * Both are read from the same graph facts and differ only in what they claim.
 *
 * **Sequence** is about *who talks to whom, in what order*. Every message is a `calls`
 * relationship the graph already records, traversed breadth-first from an entry point with a
 * depth bound and a visited set.
 *
 * Phase 4 adds the three arrows that were previously refused:
 *
 * - a **return**, from a `returns` relationship, which exists only where the source has a
 *   `return` statement that hands the callee's value back. The arrow is drawn immediately after
 *   the call it belongs to, because the return evidence is on that line — appending returns at
 *   the end would assert an order the source does not state;
 * - an **HTTP response**, from a `returns` relationship flagged `httpResponse`, pointing at the
 *   endpoint that asked. The status and method come from the response call in the handler;
 * - an **error path**, from a `throws` relationship, which exists only where the callee's body
 *   contains an explicit `throw`, `reject` or `raise`. A function with no recorded failure site
 *   gets no error arrow, and the omission log says how many were not recorded rather than
 *   implying the code cannot fail.
 *
 * What still does *not* get drawn: a return inferred from the existence of a call, a return value
 * resolved to a type the source does not state, and a response shape inferred from a route name.
 * Each of those is the difference between an evidenced return and an invented one.
 *
 * **Activity** is about *what a single unit of work decides*. Its stages are a function and
 * the branch, loop and handler conditions that function owns, in source order. A call graph is
 * not a workflow, so nothing here is derived from calls: a function with no recorded control
 * flow gets one stage and an explicit note that no decision point was found.
 *
 * Both levels are artifacts rather than separate models so they inherit the existing contract:
 * `scope`, `omitted[]`, `insufficientEvidence`, Mermaid export, and the rule that a
 * relationship with no supporting graph edge is dropped rather than drawn.
 */

/** Hard bound on sequence depth. A cycle must terminate; a long chain must not run forever. */
export const MAX_SEQUENCE_DEPTH = 8;

/** Most messages drawn for one flow. Beyond this the diagram stops being readable. */
export const MAX_SEQUENCE_MESSAGES = 60;

/** Most flows drawn in one view. */
export const MAX_SEQUENCE_FLOWS = 40;

/**
 * Ceiling on activity elements.
 *
 * An activity diagram is per unit of work, so the practical bound is the number of functions
 * that own control flow. The limit exists so a repository of pathological size cannot produce
 * an unbounded payload; reaching it is reported in `omitted[]`.
 */
export const MAX_ACTIVITY_NODES = 1_000;

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

export interface SequenceOptions {
  /**
   * Draw at most this many flows.
   *
   * Flows are chosen deterministically by entry-point id, so the same graph always produces
   * the same view and the omission is stated rather than silently applied.
   */
  maxFlows?: number;
}

export function buildSequence(context: ProjectionContext, options: SequenceOptions = {}): Artifact {
  const { graph } = context;
  const maxFlows = options.maxFlows ?? MAX_SEQUENCE_FLOWS;
  const entryPoints = entryPointsOf(graph);

  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];
  const omitted: Artifact['omitted'] = [];
  const flows: { id: string; title: string; messages: number }[] = [];
  let cappedMessages = 0;
  const cappedFlows: string[] = [];
  let values = 0;
  let responses = 0;
  let errors = 0;
  let drawnCalls = 0;

  if (entryPoints.length === 0) {
    return finish({
      kind: 'sequence',
      level: 'sequence',
      title: 'Sequence',
      scope:
        'Participants and messages come from entry points and the calls relationships reachable from them. Nothing is drawn when the repository declares no entry point.',
      graph,
      nodes: [],
      edges: [],
      omitted: [
        {
          reason:
            'no entry point: the graph records no API route, no manifest script and no task or event handler, so there is no interaction to sequence',
          count: 1,
          examples: [],
        },
      ],
      insufficient: true,
    });
  }

  const selected = entryPoints.slice(0, maxFlows);
  if (entryPoints.length > selected.length) {
    omitted.push({
      reason: `entry points beyond the first ${maxFlows} by id; raise maxFlows to include them`,
      count: entryPoints.length - selected.length,
      examples: entryPoints.slice(maxFlows, maxFlows + 3).map((node) => node.name),
    });
  }

  for (const entry of selected) {
    const messages = sequenceMessages(graph, entry);
    const truncated = messages.length > MAX_SEQUENCE_MESSAGES;
    const drawn = messages.slice(0, MAX_SEQUENCE_MESSAGES);
    if (truncated) {
      // Aggregated rather than repeated per flow: one note counting the cut-off messages is
      // more useful than the same sentence twenty times.
      cappedMessages += messages.length - MAX_SEQUENCE_MESSAGES;
      cappedFlows.push(entry.name);
    }

    flows.push({ id: entry.id, title: entry.name, messages: drawn.length });

    for (const node of participantsOf(graph, entry, drawn)) {
      if (nodes.some((existing) => existing.id === node.id)) continue;
      nodes.push(sequenceNode(node));
    }

    // A call is followed immediately by its own return and its own error path, because the
    // evidence for both is on the same source line. Emitting every call first and every return
    // afterwards would assert an order the source never states.
    // The arrow id names the flow it was drawn in. `order` alone restarts at 1 for every entry
    // point, so two flows that both reach `service -> repository` produced two edges with the
    // same id — which silently collapsed them in the UI, where an arrow is selected by id, and
    // made the evidence panel show whichever of the two came first (D-049).
    for (const message of drawn) {
      if (message.kind === 'calls') {
        drawnCalls += 1;
        edges.push({
          id: `seq:${entry.id}:${message.order}:${message.from}->${message.to}`,
          kind: 'calls',
          source: message.from,
          target: message.to,
          label: message.async ? `${message.callee} (async)` : message.callee,
          confidence: message.confidence,
          evidence: message.evidence,
          supportingEdgeIds: [message.edgeId],
          derivation: `A ${message.async ? 'declared asynchronous ' : ''}call relationship recorded in the graph.`,
          view: 'sequence',
        });
        continue;
      }

      if (message.kind === 'returns') {
        edges.push({
          id: `seq:${entry.id}:${message.order}:${message.to}->${message.from}`,
          kind: 'returns',
          source: message.from,
          target: message.to,
          label: message.label,
          confidence: message.confidence,
          evidence: message.evidence,
          supportingEdgeIds: [message.edgeId],
          derivation: message.derivation,
          view: 'sequence',
        });
        if (message.httpResponse) responses += 1;
        else values += 1;
        continue;
      }

      errors += 1;
      edges.push({
        id: `seq:${entry.id}:${message.order}:${message.to}->${message.from}`,
        kind: 'throws',
        source: message.from,
        target: message.to,
        label: message.label,
        confidence: message.confidence,
        evidence: message.evidence,
        supportingEdgeIds: [message.edgeId],
        derivation: message.derivation,
        view: 'sequence',
      });
    }
  }

  const functionsWithFailureSites = graph.nodes.filter((node) => node.kind === 'function' && Number(node.attributes?.throwSites ?? 0) > 0).length;
  const functionsWithoutReturns = graph.nodes.filter(
    (node) => (node.kind === 'function' || node.kind === 'test') && node.attributes?.hasReturn !== true,
  ).length;

  return finish({
    kind: 'sequence',
    level: 'sequence',
    title: 'Sequence',
    scope: `Participants are the entry point and everything it reaches through calls, to a depth of ${MAX_SEQUENCE_DEPTH}. Every arrow is a recorded relationship: a call is a calls relationship, a return is a return or await statement in the source, an error path is an explicit throw or reject, and an HTTP response is a response call in the handler. A call with no recorded return is drawn as a call with no return. Drawn: ${drawnCalls} call(s), ${values} return(s), ${responses} response(s), ${errors} error path(s). Flow count: ${flows.length}.`,
    graph,
    nodes,
    edges,
    omitted: [
      ...omitted,
      ...(cappedMessages > 0
        ? [
            {
              reason: `messages beyond ${MAX_SEQUENCE_MESSAGES} in a flow; the interaction is longer than a readable diagram, and the cut is at the limit rather than in the graph`,
              count: cappedMessages,
              examples: cappedFlows.slice(0, 3),
            },
          ]
        : []),
      {
        reason:
          'calls with no return drawn: a return needs a return statement that hands a callee value back, or a response call in a handler. A call whose result the source does not use has no return, and none is drawn',
        count: Math.max(drawnCalls - values - responses, 0),
        examples: [],
      },
      {
        reason:
          'functions with no recorded return at all: the source states no return for them, so the sequence cannot show one. This is a fact about the code, not a gap in the analysis',
        count: functionsWithoutReturns,
        examples: [],
      },
      {
        reason:
          'error paths not drawn: an error arrow needs an explicit throw, reject or raise in the callee. A function with no recorded failure site gets none, which is not a claim that it cannot fail',
        count: Math.max(graph.nodes.filter((node) => node.kind === 'function').length - functionsWithFailureSites, 0),
        examples: [],
      },
      {
        reason: 'undrawn calls into packages: third-party code was not analysed, so it is not a participant',
        count: graph.nodes.filter((node) => node.kind === 'package').length,
        examples: [],
      },
    ],
    insufficient: edges.length === 0,
  });
}

interface SequenceMessage {
  kind: 'calls' | 'returns' | 'throws';
  from: string;
  to: string;
  callee: string;
  edgeId: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  async: boolean;
  order: number;
  /** Label for a return or an error path. */
  label?: string;
  /** Why this arrow may be drawn, in words. */
  derivation?: string;
  /** True for a response back to the endpoint that asked. */
  httpResponse?: boolean;
}

/**
 * Depth-first walk of `calls` relationships from one entry point, each call followed by whatever
 * the callee does before the value comes back.
 *
 * The order is the order the code runs in: `handler -> outer`, then everything `outer` does, then
 * `outer -> handler` returning. A breadth-first walk drew the return before the nested calls that
 * actually happened first, which read as though the callee returned before it had finished.
 *
 * The pairing is exact rather than positional: a `returns` relationship is drawn only on the
 * call whose caller is the relationship's target, so a return can never appear against a call it
 * does not belong to. Ordering is therefore deterministic and reproducible for a given graph.
 * The walk is bounded by `MAX_SEQUENCE_DEPTH` and by the visited set, so a cyclic call graph
 * terminates rather than recursing without end.
 */
function sequenceMessages(graph: SoftwareGraph, entry: GraphNode): SequenceMessage[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, SoftwareGraph['edges']>();
  /** (callee, caller) -> the relationships that describe what comes back. */
  const returnsByPair = new Map<string, GraphEdge[]>();
  const throwsByPair = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    if (edge.kind === 'calls') {
      const list = outgoing.get(edge.from);
      if (list) list.push(edge);
      else outgoing.set(edge.from, [edge]);
      continue;
    }
    if (edge.kind !== 'returns' && edge.kind !== 'throws') continue;
    // `returns` and `throws` run callee to caller, so the pair key is reversed from `calls`.
    const key = `${edge.from}->${edge.to}`;
    const index = edge.kind === 'returns' ? returnsByPair : throwsByPair;
    const list = index.get(key);
    if (list) list.push(edge);
    else index.set(key, [edge]);
  }

  const messages: SequenceMessage[] = [];
  const visited = new Set<string>([entry.id]);
  let order = 0;

  const walk = (source: string, depth: number): void => {
    const edges = (outgoing.get(source) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const edge of edges) {
      const target = byId.get(edge.to);
      if (!target) continue;
      // A package is a dependency, not a participant: its behaviour was not analysed.
      if (target.kind === 'package') continue;

      order += 1;
      messages.push({
        kind: 'calls',
        from: edge.from,
        to: edge.to,
        callee: String(edge.attributes?.callee ?? target.name),
        edgeId: edge.id,
        confidence: edge.confidence,
        evidence: edge.evidence,
        async: isAsync(target),
        order,
      });

      // Whatever the callee does happens before its value comes back.
      if (!visited.has(target.id) && depth < MAX_SEQUENCE_DEPTH) {
        visited.add(target.id);
        walk(target.id, depth + 1);
      }

      const pairKey = `${edge.to}->${edge.from}`;
      for (const returned of returnsByPair.get(pairKey) ?? []) {
          const http = returned.attributes?.httpResponse === true;
          order += 1;
          messages.push({
            kind: 'returns',
            from: returned.from,
            to: returned.to,
            callee: '',
            edgeId: returned.id,
            confidence: returned.confidence,
            evidence: returned.evidence,
            async: returned.attributes?.awaited === true,
            order,
            ...(http
              ? {
                  httpResponse: true,
                  label: `responds ${String(returned.attributes?.status ?? '')}${returned.attributes?.status ? ' ' : ''}${String(returned.attributes?.method ?? '')}`.trim(),
                  derivation:
                    'A response call in the handler body. The status and method come from that call, never from the route name.',
                }
              : {
                  label: `returns${returned.attributes?.awaited === true ? ' (awaited)' : ''}`,
                  derivation:
                    returned.attributes?.inferred === true
                      ? `A local binding assigned from this call (${String(returned.attributes?.via ?? 'variable')}) is returned by the caller. The return statement names the variable, not the call, so the link is an inference and is drawn as one.`
                      : 'A return statement in the caller hands this callee value on. The returned value is not resolved to a type, so the arrow states the fact and not a shape.',
                }),
          });
        }

        for (const thrown of throwsByPair.get(pairKey) ?? []) {
          order += 1;
          messages.push({
            kind: 'throws',
            from: thrown.from,
            to: thrown.to,
            callee: '',
            edgeId: thrown.id,
            confidence: thrown.confidence,
            evidence: thrown.evidence,
            async: thrown.attributes?.rejects === true,
            order,
            label: `throws${thrown.attributes?.via === 'reject' || thrown.attributes?.rejects === true ? ' (rejects)' : ''}`,
            derivation:
              'An explicit throw, reject or raise inside the callee. A function with no recorded failure site produces no error arrow, which is not a claim that it cannot fail.',
          });
        }
      }
  };

  walk(entry.id, 0);

  return messages;
}

/** True only where the declaration says so. An unstated call is synchronous *or* unknown. */
function isAsync(node: GraphNode): boolean {
  return node.attributes?.isAsync === true;
}

function sequenceNode(node: GraphNode): ArtifactNode {
  const async = isAsync(node);
  return {
    id: node.id,
    label: node.qualifiedName ?? node.name,
    kind: node.kind,
    confidence: node.confidence,
    evidence: node.evidence,
    ...(node.path ? { path: node.path } : {}),
    ...(node.attributes?.isAsync === undefined ? {} : { technology: async ? 'async' : 'sync' }),
    derivation: async
      ? 'The source marks this declaration async, so its calls are drawn as asynchronous.'
      : node.attributes?.isAsync === false
        ? 'The source marks this declaration as not async.'
        : 'The source does not state whether this declaration is asynchronous.',
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function buildActivity(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];
  const omitted: Artifact['omitted'] = [];
  const limit = Math.min(maxElements, MAX_ACTIVITY_NODES);

  const units = graph.nodes.filter((node) => node.kind === 'function' || node.kind === 'test');
  const withControlFlow = units.filter((node) => controlEdgesOf(graph, node).length > 0);
  let drawn = 0;

  for (const unit of withControlFlow) {
    if (drawn >= limit) break;
    drawn += 1;

    const conditions = controlEdgesOf(graph, unit);
    if (conditions.length === 0) continue;

    nodes.push(activityNode(unit, 'start'));
    const previous = unit.id;

    // Source order, not discovery order: a workflow whose steps are unordered is not a
    // workflow. Ties on the same line are broken by node id so the result is deterministic.
    const ordered = conditions
      .map((edge) => ({ edge, condition: graph.nodes.find((node) => node.id === edge.to) }))
      .filter((entry): entry is { edge: SoftwareGraph['edges'][number]; condition: GraphNode } => Boolean(entry.condition))
      .sort((a, b) => (a.condition.startLine ?? 0) - (b.condition.startLine ?? 0) || (a.condition.id < b.condition.id ? -1 : 1));

    for (const { edge, condition } of ordered) {
      nodes.push(activityNode(condition, 'decision'));
      edges.push({
        id: `act:${unit.id}->${condition.id}`,
        kind: edge.kind,
        source: previous,
        target: condition.id,
        label: edge.kind === 'loops' ? 'loops' : 'branches',
        confidence: edge.confidence,
        evidence: edge.evidence,
        supportingEdgeIds: [edge.id],
        derivation: `An explicit ${edge.kind === 'loops' ? 'loop' : 'branch'} recorded at ${condition.path ?? 'a source location'}.`,
        view: 'activity',
      });
      // Sequential chaining between decision points, each supported by the next edge in source
      // order. The support is the *ordering* claim, which is stated by line number, so it
      // names the two edges that establish it.
      const next = ordered.find((entry) => entry.condition.id === condition.id);
      if (next) {
        const following = ordered[ordered.indexOf(next) + 1];
        if (following) {
          edges.push({
            id: `act:then:${condition.id}->${following.condition.id}`,
            kind: 'transforms',
            source: condition.id,
            target: following.condition.id,
            label: 'then',
            confidence: weaker([edge.confidence, following.edge.confidence]),
            evidence: dedupe([...edge.evidence, ...following.edge.evidence]),
            supportingEdgeIds: [edge.id, following.edge.id],
            derivation: 'Order established by source line: these two decision points appear in this sequence in the file.',
            view: 'activity',
          });
        }
      }
    }
  }

  const withoutControlFlow = units.length - withControlFlow.length;
  if (withoutControlFlow > 0) {
    omitted.push({
      reason:
        'functions with no recorded branch, loop or handler. A call graph is not a workflow, so none is given a single-stage activity',
      count: withoutControlFlow,
      examples: [],
    });
  }

  // Counted after the loop, from the units actually drawn, so the number can never go
  // negative or exceed the number of units that have control flow.
  const cutOff = withControlFlow.length - drawn;
  if (cutOff > 0) {
    omitted.push({
      reason: `units with control flow beyond the ${limit}-unit limit; raise the projection limit to include them`,
      count: cutOff,
      examples: withControlFlow.slice(drawn, drawn + 3).map((node) => node.qualifiedName ?? node.name),
    });
  }

  const stateCandidates = graph.nodes.filter((node) => node.kind === 'constant' && /status|state|phase|stage/i.test(node.name));
  omitted.push({
    reason:
      stateCandidates.length > 0
        ? `state transitions: ${stateCandidates.length} name suggests a state, but the graph holds no transition relationship between states, so no state model is drawn`
        : 'state transitions: the graph holds no state entity and no transition relationship, so a state model is unsupported here',
    count: Math.max(stateCandidates.length, 1),
    examples: stateCandidates.slice(0, 3).map((node) => node.name),
  });

  return finish({
    kind: 'activity',
    level: 'activity',
    title: 'Activity',
    scope:
      'Stages are functions that own an explicit branch, loop or handler, with their decision points in source order. Nothing is inferred from the call graph: a dependency is not a step in a workflow.',
    graph,
    nodes,
    edges,
    omitted,
    insufficient: nodes.length === 0,
  });
}

function controlEdgesOf(graph: SoftwareGraph, node: GraphNode): SoftwareGraph['edges'] {
  return graph.edges
    .filter((edge) => edge.from === node.id && (edge.kind === 'branches' || edge.kind === 'loops'))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function activityNode(node: GraphNode, role: 'start' | 'decision'): ArtifactNode {
  const condition = typeof node.attributes?.condition === 'string' ? node.attributes.condition : undefined;
  const flow = typeof node.attributes?.flow === 'string' ? node.attributes.flow : undefined;

  return {
    id: node.id,
    label: role === 'start' ? (node.qualifiedName ?? node.name) : (condition ?? String(node.name)),
    kind: role === 'start' ? node.kind : 'condition',
    detail: role === 'decision' && flow ? flow : undefined,
    confidence: node.confidence,
    evidence: node.evidence,
    ...(node.path ? { path: node.path } : {}),
    derivation:
      role === 'start'
        ? 'The function that owns the recorded control flow.'
        : `An explicit ${flow ?? 'branch'} recorded in source${condition ? ` with the condition as written: ${condition}` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Entry points a sequence can start from, in a deterministic order. */
function entryPointsOf(graph: SoftwareGraph): GraphNode[] {
  const entry: GraphNode[] = [];

  for (const node of graph.nodes) {
    if (node.kind === 'api_endpoint') entry.push(node);
    else if (node.kind === 'configuration' && typeof node.attributes?.marker === 'string' && node.attributes.marker.startsWith('async.')) {
      entry.push(node);
    }
  }

  return entry.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function participantsOf(graph: SoftwareGraph, entry: GraphNode, messages: readonly SequenceMessage[]): GraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const participants = [entry];
  for (const message of messages) {
    const target = byId.get(message.to);
    if (target) participants.push(target);
  }
  return participants;
}

function weaker(values: readonly Confidence[]): Confidence {
  if (values.includes('UNKNOWN')) return 'UNKNOWN';
  if (values.includes('WEEKLY_INFERRED')) return 'WEEKLY_INFERRED';
  if (values.includes('STRONGLY_INFERRED')) return 'STRONGLY_INFERRED';
  return 'EXPLICIT';
}

function dedupe(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const ref of refs) if (!seen.has(ref.evidenceId)) seen.set(ref.evidenceId, ref);
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
}

interface BehaviourFinishInput {
  kind: string;
  level: 'sequence' | 'activity';
  title: string;
  scope: string;
  graph: SoftwareGraph;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  omitted: Artifact['omitted'];
  insufficient?: boolean;
}

/** Same integrity gate as every other projection: no support, no arrow. */
function finish(input: BehaviourFinishInput): Artifact {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const supported = input.edges.filter(hasGraphSupport);
  const edges = supported.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  const omitted = [...input.omitted];
  if (supported.length - edges.length > 0) {
    omitted.push({
      reason: 'relationships dropped because an endpoint was not part of this view',
      count: supported.length - edges.length,
      examples: [],
    });
  }
  if (input.edges.length - supported.length > 0) {
    omitted.push({
      reason: 'relationships dropped because no graph fact justified them',
      count: input.edges.length - supported.length,
      examples: [],
    });
  }

  edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  const nodes = [...input.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    kind: input.kind,
    title: input.title,
    format: 'json',
    scope: input.scope,
    nodes,
    edges,
    omitted,
    insufficientEvidence: input.insufficient ?? false,
    stats: {
      graphNodes: input.graph.nodes.length,
      graphEdges: input.graph.edges.length,
      projectedNodes: nodes.length,
      projectedEdges: edges.length,
    },
  };
}
