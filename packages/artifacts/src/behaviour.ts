import type { Confidence, EvidenceRef, GraphNode, SoftwareGraph } from '@repoatlas/core';
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
 * depth bound and a visited set. It never draws a return message, because the graph records
 * no return; a sequence diagram whose arrows go back are the most common way this diagram type
 * starts asserting things the code does not say. Asynchronous calls are marked only where the
 * declaration is marked `async`.
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
      omitted.push({
        reason: `messages beyond ${MAX_SEQUENCE_MESSAGES} in this flow; the interaction is longer than a readable diagram`,
        count: messages.length - MAX_SEQUENCE_MESSAGES,
        examples: [entry.name],
      });
    }

    flows.push({ id: entry.id, title: entry.name, messages: drawn.length });

    for (const node of participantsOf(graph, entry, drawn)) {
      if (nodes.some((existing) => existing.id === node.id)) continue;
      nodes.push(sequenceNode(node));
    }

    for (const message of drawn) {
      edges.push({
        id: `seq:${message.from}->${message.to}:${message.order}`,
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
    }
  }

  return finish({
    kind: 'sequence',
    level: 'sequence',
    title: 'Sequence',
    scope: `Participants are the entry point and everything it reaches through calls, to a depth of ${MAX_SEQUENCE_DEPTH}. Every arrow is a recorded calls relationship; no return message is drawn because the graph records no return. Flow count: ${flows.length}.`,
    graph,
    nodes,
    edges,
    omitted: [
      ...omitted,
      {
        reason:
          'return messages and error responses: the graph records call relationships and explicit handler conditions, not return values or thrown errors, so none are drawn',
        count: flows.length,
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
  from: string;
  to: string;
  callee: string;
  edgeId: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  async: boolean;
  order: number;
}

/** Breadth-first walk of `calls` relationships from one entry point. */
function sequenceMessages(graph: SoftwareGraph, entry: GraphNode): SequenceMessage[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, SoftwareGraph['edges']>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const messages: SequenceMessage[] = [];
  const visited = new Set<string>([entry.id]);
  let frontier = [entry.id];
  let order = 0;

  for (let depth = 0; depth < MAX_SEQUENCE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];

    for (const source of frontier) {
      const edges = (outgoing.get(source) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const edge of edges) {
        const target = byId.get(edge.to);
        if (!target) continue;
        // A package is a dependency, not a participant: its behaviour was not analysed.
        if (target.kind === 'package') continue;

        order += 1;
        messages.push({
          from: edge.from,
          to: edge.to,
          callee: String(edge.attributes?.callee ?? target.name),
          edgeId: edge.id,
          confidence: edge.confidence,
          evidence: edge.evidence,
          async: isAsync(target),
          order,
        });

        if (!visited.has(target.id)) {
          visited.add(target.id);
          next.push(target.id);
        }
      }
    }

    frontier = next;
  }

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

  for (const unit of withControlFlow) {
    if (nodes.length >= limit) {
      omitted.push({
        reason: `units with control flow beyond the ${limit}-element limit; raise the projection limit to include them`,
        count: withControlFlow.length - nodes.length,
        examples: [],
      });
      break;
    }

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
