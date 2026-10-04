import type { Confidence, EvidenceRef, GraphEdge, GraphNode, SoftwareGraph } from '@repoatlas/core';
import { hasGraphSupport, type Artifact, type ArtifactEdge, type ArtifactNode, type ProjectionContext } from './contract.js';

/**
 * Data flow.
 *
 * A data-flow diagram is the easiest of these projections to fabricate, because any two
 * modules that depend on each other look like they exchange data. They usually do not. A
 * dependency is not a data flow.
 *
 * Every flow here comes from a relationship the graph records about data specifically:
 * `reads`, `writes`, `produces`, `consumes`, `transforms` or `communicates_with`. Nothing is
 * derived from `imports`, `depends_on` or file adjacency, and the omission log says how many
 * relationships of each kind were considered and rejected — so a reader can see that a flow
 * is absent because no data relationship exists rather than because the view forgot to draw
 * one.
 *
 * Lineage is the same graph read backwards: for a given store, what reaches it and what it
 * reaches, each hop citing the relationship that establishes it.
 */

export interface DataFlowOptions {
  /** Most flows to draw. Beyond this the diagram stops being readable. */
  maxFlows?: number;
}

export const MAX_DATA_FLOWS = 200;

/** The relationship kinds that state something about data. */
export const DATA_EDGE_KINDS = ['reads', 'writes', 'produces', 'consumes', 'transforms', 'communicates_with'] as const;

export function buildDataFlow(context: ProjectionContext, options: DataFlowOptions = {}): Artifact {
  const { graph } = context;
  const maxFlows = options.maxFlows ?? MAX_DATA_FLOWS;
  const omitted: Artifact['omitted'] = [];

  const flows = graph.edges
    .filter((edge) => isDataEdge(edge) && endpointKinds(graph, edge) !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const considered = graph.edges.filter(isDataEdge).length;
  const unusable = considered - flows.length;
  if (unusable > 0) {
    omitted.push({
      reason: 'data relationships whose endpoints are not both in the graph; recorded rather than drawn',
      count: unusable,
      examples: [],
    });
  }

  // A dependency is not a data flow. Said explicitly, because the absence is the point.
  const dependencies = graph.edges.filter((edge) => edge.kind === 'depends_on' || edge.kind === 'imports').length;
  omitted.push({
    reason:
      'dependencies are not data flows: imports and depends_on state that one entity needs another, not that data moves between them',
    count: dependencies,
    examples: [],
  });

  const selected = flows.slice(0, maxFlows);
  if (flows.length > selected.length) {
    omitted.push({
      reason: `data relationships beyond the first ${maxFlows} by id; raise maxFlows to include them`,
      count: flows.length - selected.length,
      examples: flows.slice(maxFlows, maxFlows + 3).map((edge) => edge.id),
    });
  }

  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];

  for (const edge of selected) {
    const source = graph.nodes.find((node) => node.id === edge.from);
    const target = graph.nodes.find((node) => node.id === edge.to);
    if (!source || !target) continue;

    for (const node of [source, target]) {
      if (nodes.some((existing) => existing.id === node.id)) continue;
      nodes.push(dataNode(node));
    }

    edges.push({
      id: `dfd:${edge.id}`,
      kind: edge.kind,
      source: edge.from,
      target: edge.to,
      label: edge.kind,
      confidence: edge.confidence,
      evidence: edge.evidence,
      supportingEdgeIds: [edge.id],
      derivation: `A ${edge.kind} relationship recorded in the graph${dataEdgeDerivation(edge)}.`,
      view: 'data-flow',
    });
  }

  const boundary = boundaryOf(graph);
  omitted.push({
    reason:
      boundary === null
        ? 'external boundaries: no communicates_with relationship exists, so no flow crosses the system boundary'
        : `flows crossing the system boundary are drawn from communicates_with relationships; ${boundary} exist`,
    count: Math.max(boundary ?? 1, 1),
    examples: [],
  });

  const stores = graph.nodes.filter((node) => node.kind === 'table' || node.kind === 'database');
  const undeclared = stores.filter((node) => node.attributes?.declaredInDdl === false);
  if (undeclared.length > 0) {
    omitted.push({
      reason:
        'stores referenced by code but never declared in a schema this analysis read; their shape is unknown, not empty',
      count: undeclared.length,
      examples: undeclared.slice(0, 3).map((node) => node.name),
    });
  }

  // Phase 4. A query this analyser declined to classify is a different fact from no query, and
  // the difference is exactly what a reader needs before concluding a repository has no data
  // access here.
  const unclassified = graph.nodes.filter((node) => node.attributes?.unclassifiedStatement === true);
  if (unclassified.length > 0) {
    omitted.push({
      reason:
        'queries present but not classified: a statement this analyser recognised and would not read contributes no flow, which is a limit of the extractor rather than an absence of database access',
      count: unclassified.length,
      examples: unclassified.slice(0, 3).map((node) => node.name),
    });
  }

  // A CTE is a query result, not a store. Saying so keeps its absence from the store list from
  // reading as an oversight.
  const queryExpressions = graph.nodes.filter((node) => node.attributes?.queryExpression === true);
  if (queryExpressions.length > 0) {
    omitted.push({
      reason:
        'query expressions (CTEs) are drawn as code that produces a result, never as stores: a query result has no schema and is not a database table',
      count: queryExpressions.length,
      examples: queryExpressions.slice(0, 3).map((node) => node.name),
    });
  }

  return {
    kind: 'data-flow',
    title: 'Data flow',
    format: 'json',
    scope:
      'Flows come only from relationships the graph records about data: reads, writes, produces, consumes, transforms and communicates_with. A dependency is not a flow, and none is drawn.',
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: edges.filter(hasGraphSupport).sort((a, b) => (a.id < b.id ? -1 : 1)),
    omitted,
    insufficientEvidence: flows.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: nodes.length,
      projectedEdges: edges.length,
    },
  };
}

export interface LineageHop {
  /** The relationship that moves the data this hop. */
  edgeId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  relation: GraphEdge['kind'];
  confidence: Confidence;
  evidence: EvidenceRef[];
  /**
   * What the statement did to the table: read, write, or unknown when the relationship states
   * no operation. Carried so lineage can answer "where is this read" and "where is this
   * persisted" without the reader having to open the evidence.
   */
  operation?: 'read' | 'write';
  /** The clause the table name appeared in, when the relationship recorded one. */
  role?: string;
  /** The statement the hop came from, when recorded. */
  statement?: string;
}

export interface Lineage {
  /** Store or entity the lineage is about. */
  subjectNodeId: string;
  subjectName: string;
  /** Everything that reaches the subject. */
  upstream: LineageHop[];
  /** Everything the subject reaches. */
  downstream: LineageHop[];
  /** True when the chain was cut by the hop limit rather than by the graph. */
  truncated: boolean;
  /**
   * How the subject is used, counted by operation.
   *
   * Phase 4: `read` and `write` are separate because "where is this table persisted" and "where
   * is it read" are different questions, and answering them from one merged list is how a
   * reader ends up believing a read is a write.
   */
  usage: { read: number; write: number; unclassified: number };
}

/** Hard bound on how far lineage is followed. */
export const MAX_LINEAGE_HOPS = 12;

/**
 * Where data comes from and where it goes, for one subject.
 *
 * Breadth-first in both directions over data relationships only, bounded in depth, so a
 * cycle terminates. `truncated` says whether the chain stopped because of the bound, which is
 * the difference between "this is everything" and "this is everything up to a limit".
 */
export function traceLineage(graph: SoftwareGraph, subjectNodeId: string): Lineage | null {
  const subject = graph.nodes.find((node) => node.id === subjectNodeId);
  if (!subject) return null;

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!isDataEdge(edge)) continue;
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }

  const upstream = walk(incoming, subjectNodeId, 'inbound');
  const downstream = walk(outgoing, subjectNodeId, 'outbound');

  // Counted from the edges that touch the subject directly, because a hop three levels away
  // says what that level did rather than what the subject's own usage is.
  const usage = { read: 0, write: 0, unclassified: 0 };
  for (const edge of graph.edges) {
    if (!isDataEdge(edge)) continue;
    if (edge.from !== subjectNodeId && edge.to !== subjectNodeId) continue;
    if (edge.attributes?.operation === 'read') usage.read += 1;
    else if (edge.attributes?.operation === 'write') usage.write += 1;
    else usage.unclassified += 1;
  }

  return {
    subjectNodeId,
    subjectName: subject.qualifiedName ?? subject.name,
    upstream: upstream.hops,
    downstream: downstream.hops,
    truncated: upstream.truncated || downstream.truncated,
    usage,
  };
}

function walk(
  index: Map<string, GraphEdge[]>,
  start: string,
  direction: 'inbound' | 'outbound',
): { hops: LineageHop[]; truncated: boolean } {
  const hops: LineageHop[] = [];
  const visited = new Set<string>([start]);
  let frontier = [start];
  let truncated = false;

  for (let depth = 0; depth < MAX_LINEAGE_HOPS && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const edges = (index.get(nodeId) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const edge of edges) {
        const other = direction === 'inbound' ? edge.from : edge.to;
        const operation = edge.attributes?.operation === 'read' || edge.attributes?.operation === 'write'
          ? edge.attributes.operation
          : undefined;
        hops.push({
          edgeId: edge.id,
          direction,
          from: edge.from,
          to: edge.to,
          relation: edge.kind,
          confidence: edge.confidence,
          evidence: edge.evidence,
          ...(operation ? { operation } : {}),
          ...(typeof edge.attributes?.role === 'string' ? { role: edge.attributes.role } : {}),
          ...(typeof edge.attributes?.statement === 'string' ? { statement: edge.attributes.statement } : {}),
        });
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  // More edges remain only if the loop stopped with work still to do.
  if (frontier.length > 0) truncated = true;
  return { hops, truncated };
}

function push<T>(index: Map<string, T[]>, key: string, value: T): void {
  const list = index.get(key);
  if (list) list.push(value);
  else index.set(key, [value]);
}

function isDataEdge(edge: GraphEdge): boolean {
  return (DATA_EDGE_KINDS as readonly string[]).includes(edge.kind);
}

/** A flow is drawable only when both ends exist; anything else is recorded as unusable. */
function endpointKinds(graph: SoftwareGraph, edge: GraphEdge): string | null {
  const source = graph.nodes.some((node) => node.id === edge.from);
  const target = graph.nodes.some((node) => node.id === edge.to);
  return source && target ? 'ok' : null;
}

function boundaryOf(graph: SoftwareGraph): number | null {
  const count = graph.edges.filter((edge) => edge.kind === 'communicates_with').length;
  return count > 0 ? count : null;
}

function dataEdgeDerivation(edge: GraphEdge): string {
  const operation = edge.attributes?.operation;
  const role = typeof edge.attributes?.role === 'string' ? edge.attributes.role : undefined;
  const statement = typeof edge.attributes?.statement === 'string' ? edge.attributes.statement : undefined;
  const scopeUnknown = edge.attributes?.scopeUnknown === true;

  const parts: string[] = [];
  if (typeof operation === 'string') parts.push(`The statement in the source was a ${operation.toUpperCase()}.`);
  if (role) parts.push(`The table appeared as ${ROLE_PHRASES[role] ?? role}.`);
  if (statement) {
    parts.push(
      `It came from one statement reading ${statement}, so this relationship is one table of that statement rather than the whole of it.`,
    );
  }
  if (scopeUnknown) {
    parts.push('No enclosing function was resolved, so which unit performs it is not established.');
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** How a table name's role in a statement is described to a reader. */
const ROLE_PHRASES: Record<string, string> = {
  from: 'the FROM clause',
  join: 'a JOIN clause',
  insert_into: 'the INSERT target',
  update_target: 'the UPDATE target',
  delete_target: 'the DELETE target',
  delete_using: 'a USING clause',
};

function dataNode(node: GraphNode): ArtifactNode {
  const declaredInDdl = node.attributes?.declaredInDdl;
  const isQueryExpression = node.attributes?.queryExpression === true;
  return {
    id: node.id,
    // A query expression's qualified name carries an internal `cte:` prefix that exists to keep
    // its id stable. The reader wants the name the query gives it.
    label: isQueryExpression ? node.name : node.qualifiedName ?? node.name,
    kind: node.kind,
    confidence: node.confidence,
    evidence: node.evidence,
    ...(node.path ? { path: node.path } : {}),
    derivation:
      node.kind === 'table' || node.kind === 'database'
        ? declaredInDdl === false
          ? 'A data store referenced by code. No schema in the analysed repository declares it, so its shape is unknown.'
          : 'A data store declared in a schema in the analysed repository.'
        : isQueryExpression
          ? 'A query result defined by a WITH clause. It is not a store: it has no schema and no rows of its own.'
          : 'Code that the graph records as moving data.',
  };
}
