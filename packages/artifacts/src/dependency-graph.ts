import type { GraphNode, SoftwareGraph } from '@repoatlas/core';
import {
  NOISE_NODE_KINDS,
  OmissionLog,
  toArtifactEdge,
  toArtifactNode,
  type Artifact,
  type ProjectionContext,
} from './contract.js';

/**
 * Dependency graph projection.
 *
 * Answers "what depends on what" at module level: internal module-to-module imports,
 * and module-to-package dependencies for third-party code. This is the first artifact
 * in the build order because it needs only import statements, which are the most
 * reliably extractable fact in any repository.
 *
 * Third-party packages are included but visually separable via `external`, because a
 * dependency view that hides them answers a different question than the one engineers
 * usually ask.
 */

const RELEVANT_EDGE_KINDS = new Set(['imports', 're_exports', 'depends_on']);

export function buildDependencyGraph(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const modules = graph.nodes.filter((node) => node.kind === 'module');

  const projectedNodeIds = new Set<string>();
  const artifactEdges: Artifact['edges'] = [];

  for (const edge of graph.edges) {
    if (!RELEVANT_EDGE_KINDS.has(edge.kind)) continue;

    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) {
      omission.record('edge endpoint missing from graph', edge.id);
      continue;
    }
    if (from.kind !== 'module' || (to.kind !== 'module' && to.kind !== 'package')) continue;

    artifactEdges.push(toArtifactEdge(edge));
    projectedNodeIds.add(from.id);
    projectedNodeIds.add(to.id);

    if (artifactEdges.length >= maxElements) {
      omission.record('projection element limit reached', edge.id);
      break;
    }
  }

  // Cycles are a fact about the repository worth surfacing rather than hiding, but a
  // naive layout renders them badly. They are counted, not removed.
  const cycles = findCycles(artifactEdges);

  const nodes: Artifact['nodes'] = [];
  for (const id of projectedNodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (NOISE_NODE_KINDS.has(node.kind)) continue;
    nodes.push(toArtifactNode(node, detailFor(node)));
  }

  // A dependency graph with no edges means the repository had no resolvable imports,
  // which is a genuine finding, not a rendering failure.
  const insufficient = artifactEdges.length === 0 && modules.length > 0;

  return {
    kind: 'dependency-graph',
    title: 'Dependency graph',
    format: 'json',
    scope:
      'Module-level imports and declared third-party packages. Derived only from import statements and manifest fields; no call-level dependencies.',
    nodes,
    edges: artifactEdges,
    omitted: [
      ...omission.list(),
      ...(cycles.length > 0
        ? [{ reason: 'cyclic dependencies detected (reported, not hidden)', count: cycles.length, examples: cycles.slice(0, 3).map((cycle) => cycle.join(' → ')) }]
        : []),
    ],
    insufficientEvidence: insufficient,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: nodes.length,
      projectedEdges: artifactEdges.length,
    },
  };
}

/**
 * Module structure projection.
 *
 * Shows the containment hierarchy: which module declares which entity. Unlike the
 * dependency graph this is about *composition*, not ordering.
 */
export function buildModuleGraph(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const artifactEdges: Artifact['edges'] = [];
  const projectedNodeIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' && edge.kind !== 'declared_in') continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    if (from.kind !== 'module') continue;
    if (NOISE_NODE_KINDS.has(to.kind)) continue;

    artifactEdges.push(toArtifactEdge(edge));
    projectedNodeIds.add(from.id);
    projectedNodeIds.add(to.id);

    if (artifactEdges.length >= maxElements) {
      omission.record('projection element limit reached', edge.id);
      break;
    }
  }

  const nodes: Artifact['nodes'] = [];
  for (const id of projectedNodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    nodes.push(toArtifactNode(node, detailFor(node)));
  }

  return {
    kind: 'module-graph',
    title: 'Module structure',
    format: 'json',
    scope:
      'Containment only: which module declares each entity. Says nothing about execution order or runtime behaviour.',
    nodes,
    edges: artifactEdges,
    omitted: omission.list(),
    insufficientEvidence: artifactEdges.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: nodes.length,
      projectedEdges: artifactEdges.length,
    },
  };
}

function detailFor(node: GraphNode): string | undefined {
  if (node.kind === 'package') return 'third-party';
  if (node.kind === 'module') return node.path;
  if (node.attributes?.signature) return String(node.attributes.signature);
  if (node.attributes?.httpMethod) return `${node.attributes.httpMethod} ${String(node.attributes.route ?? '')}`.trim();
  return node.path;
}

/**
 * Finds simple cycles in a directed edge list.
 *
 * Uses an iterative depth-first search with a recursion guard so a large graph cannot
 * blow the stack. Only cycles reachable within the traversed depth are reported.
 */
export function findCycles(edges: readonly { source: string; target: string }[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const walk = (node: string): void => {
    if (cycles.length >= 20 || stack.length > 64) return;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (onStack.has(next)) {
        const start = stack.indexOf(next);
        if (start >= 0) {
          const cycle = [...stack.slice(start), next];
          const key = canonicalCycleKey(cycle);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
        continue;
      }
      if (!seen.has(next)) walk(next);
    }

    stack.pop();
    onStack.delete(node);
  };

  for (const node of adjacency.keys()) {
    if (!seen.has(node)) walk(node);
  }

  return cycles;
}

/** Rotation-independent key so the same cycle is not reported twice. */
function canonicalCycleKey(cycle: readonly string[]): string {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return '';
  let smallest = 0;
  for (let i = 1; i < body.length; i += 1) {
    if (body[i]! < body[smallest]!) smallest = i;
  }
  return [...body.slice(smallest), ...body.slice(0, smallest)].join('>');
}

export type { SoftwareGraph };