import type { EvidenceStore } from './evidence.js';
import { edgeId, nodeId } from './ids.js';
import {
  CONFIDENCE_LEVELS,
  EDGE_KINDS,
  NODE_KINDS,
  weakerConfidence,
  type AttributeValue,
  type Confidence,
  type EdgeKind,
  type EvidenceRef,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  type NodeKind,
  type SoftwareGraph,
} from './types.js';

/**
 * Graph schema version.
 *
* Bumped when the *shape* of the graph changes — a new node kind, a new edge kind, or a new
 * attribute the projections depend on — because a snapshot written against an older shape
 * cannot be compared field-by-field with a newer one.
 *
 * Version 5 adds the deployment and security vocabulary: `network` and `secret` nodes, and the
 * `joins_network`, `references_secret`, `listens_on` and `protected_by` relationships. A
 * deployment view drawn from a version 4 graph and one drawn from a version 5 graph answer
 * different questions, so the two must not be diffed against each other.
 *
 * Version 4 adds `returns` and `throws` edges, `role`/`statement` on data-access edges, and the
 * function attributes behind them. A sequence drawn from a version 3 graph and one drawn from a
 * version 4 graph would disagree about what an interaction hands back, so the two must not be
 * diffed against each other.
 *
 * Version 3 added `condition` nodes, `branches`/`loops`/`references`/`tests` edges, `isAsync` on
 * function entities, SQL `reads`/`writes`, and DDL primary keys, foreign keys, nullability and
 * uniqueness.
 *
 * Snapshots taken under an older version are reported incomparable rather than silently diffed.
 */
export const GRAPH_SCHEMA_VERSION = 5;

export class GraphLimitError extends Error {
  readonly code = 'GRAPH_LIMIT_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'GraphLimitError';
  }
}

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
}

/**
 * Mutable builder for the canonical Software Knowledge Graph.
 *
 * Invariants enforced here (rather than at projection time) so that every artifact
 * inherits them:
 *  - node and edge ids are deterministic;
 *  - an edge never references a missing node;
 *  - merging a duplicate fact keeps the weaker confidence and unions the evidence;
 *  - the graph is bounded by explicit limits.
 */
export class SoftwareGraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly limits: GraphLimits;
  private nodeOverflow = false;
  private edgeOverflow = false;

  constructor(limits: GraphLimits) {
    this.limits = limits;
  }

  /** Registers a node. Returns the stored node so callers can chain. */
  addNode(input: Omit<GraphNode, 'id'> & { id?: string }): GraphNode {
    const id = input.id ?? nodeId(input.kind, input.qualifiedName ?? input.name);
    const existing = this.nodes.get(id);

    if (existing) {
      this.mergeNode(existing, input);
      return existing;
    }

    if (this.nodes.size >= this.limits.maxNodes) {
      this.nodeOverflow = true;
      return {
        id,
        kind: input.kind,
        name: input.name,
        evidence: [],
        confidence: 'UNKNOWN',
      };
    }

    const node: GraphNode = {
      ...input,
      id,
      evidence: dedupeRefs(input.evidence),
      confidence: normaliseConfidence(input.confidence),
    };
    this.nodes.set(id, node);
    return node;
  }

  /**
   * Registers an edge.
   *
   * Returns `undefined` when the edge would dangle; callers use that signal to
   * record an unresolved reference rather than inventing an endpoint.
   */
  addEdge(input: Omit<GraphEdge, 'id'>): GraphEdge | undefined {
    if (!this.nodes.has(input.from) || !this.nodes.has(input.to)) {
      return undefined;
    }
    if (this.edges.size >= this.limits.maxEdges) {
      this.edgeOverflow = true;
      return undefined;
    }

    const id = edgeId(input.from, input.kind, input.to);
    const existing = this.edges.get(id);

    if (existing) {
      existing.evidence = dedupeRefs([...existing.evidence, ...input.evidence]);
      existing.confidence = weakerConfidence(existing.confidence, normaliseConfidence(input.confidence));
      if (input.attributes) existing.attributes = { ...input.attributes, ...existing.attributes };
      if (input.label && !existing.label) existing.label = input.label;
      return existing;
    }

    const edge: GraphEdge = {
      ...input,
      id,
      confidence: normaliseConfidence(input.confidence),
      evidence: dedupeRefs(input.evidence),
    };
    this.edges.set(id, edge);
    return edge;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  /** True when a limit stopped nodes or edges from being stored. */
  wasTruncated(): boolean {
    return this.nodeOverflow || this.edgeOverflow;
  }

  /** Nodes of a given kind, in insertion order. */
  nodesOfKind(kind: NodeKind): GraphNode[] {
    return [...this.nodes.values()].filter((node) => node.kind === kind);
  }

  /**
   * Every node registered so far, in insertion order.
   *
   * Exposed so a later pass can reason about nodes added by an earlier pass — the test
   * attribution pass needs the endpoints that marker facts just created. Read-only view:
   * callers must not mutate the nodes they receive.
   */
  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /** Every edge registered so far, in insertion order. Same read-only contract as `allNodes`. */
  allEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }

  /** Edges leaving a node. */
  outgoing(id: string): GraphEdge[] {
    return [...this.edges.values()].filter((edge) => edge.from === id);
  }

  /** Edges entering a node. */
  incoming(id: string): GraphEdge[] {
    return [...this.edges.values()].filter((edge) => edge.to === id);
  }

  /** Adjacency for a node, used by artifact projection and the UI. */
  neighbourhood(id: string): { out: GraphEdge[]; in: GraphEdge[] } {
    return { out: this.outgoing(id), in: this.incoming(id) };
  }

  private mergeNode(existing: GraphNode, incoming: Omit<GraphNode, 'id'>): void {
    existing.evidence = dedupeRefs([...existing.evidence, ...incoming.evidence]);
    existing.confidence = weakerConfidence(existing.confidence, normaliseConfidence(incoming.confidence));
    if (incoming.attributes) {
      existing.attributes = { ...incoming.attributes, ...existing.attributes };
    }
    existing.startLine = existing.startLine ?? incoming.startLine;
    existing.endLine = existing.endLine ?? incoming.endLine;
    existing.path = existing.path ?? incoming.path;
    existing.language = existing.language ?? incoming.language;
    existing.qualifiedName = existing.qualifiedName ?? incoming.qualifiedName;
  }

  /** Freezes the builder into an immutable, serialisable graph. */
  build(evidence: EvidenceStore): SoftwareGraph {
    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      evidence: evidence.list(),
    };
  }
}

function normaliseConfidence(value: Confidence | undefined): Confidence {
  return value && CONFIDENCE_LEVELS.includes(value) ? value : 'UNKNOWN';
}

function dedupeRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    if (!seen.has(ref.evidenceId)) seen.set(ref.evidenceId, ref);
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
}

/** Computes the statistics surfaced on the Overview screen and in API responses. */
export function computeStats(graph: SoftwareGraph): GraphStats {
  const nodesByKind: Record<string, number> = {};
  const edgesByKind: Record<string, number> = {};
  let explicitNodes = 0;
  let explicitEdges = 0;

  for (const node of graph.nodes) {
    nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
    if (node.confidence === 'EXPLICIT') explicitNodes += 1;
  }
  for (const edge of graph.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
    if (edge.confidence === 'EXPLICIT') explicitEdges += 1;
  }

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    evidenceCount: graph.evidence.length,
    nodesByKind,
    edgesByKind,
    explicitShare: {
      nodes: graph.nodes.length === 0 ? 0 : explicitNodes / graph.nodes.length,
      edges: graph.edges.length === 0 ? 0 : explicitEdges / graph.edges.length,
    },
  };
}

/** Type-level guard used by the API when validating deserialised graph payloads. */
export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value);
}

/** Type-level guard for attribute values persisted as JSON. */
export function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}
