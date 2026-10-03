import {
  OmissionLog,
  toArtifactEdge,
  toArtifactNode,
  type Artifact,
  type ArtifactEdge,
  type ArtifactNode,
  type ProjectionContext,
} from './contract.js';

/**
 * Entity-relationship diagram projection.
 *
 * Built from `table` and `column` nodes, which come from SQL DDL and from schema
 * definitions the configuration scanner recognises. Relationships between tables are
 * only drawn when the graph contains an explicit edge for them; this phase does not
 * infer foreign keys, because a guessed foreign key in an ER diagram is exactly the
 * kind of claim the product must not make without evidence.
 */

export function buildErDiagram(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();

  const tables = graph.nodes.filter((node) => node.kind === 'table');
  const columnsByTable = new Map<string, ArtifactNode[]>();

  for (const column of graph.nodes) {
    if (column.kind !== 'column') continue;
    const tableId = column.attributes?.table;
    if (typeof tableId !== 'string') continue;
    const ownerId = `table:${tableId.replace(/[^A-Za-z0-9._/-]+/g, '-').toLowerCase()}`;
    const list = columnsByTable.get(ownerId);
    const projected = toArtifactNode(column, String(column.attributes?.dataType ?? ''));
    if (list) list.push(projected);
    else columnsByTable.set(ownerId, [projected]);
  }

  const artifactNodes: ArtifactNode[] = [];
  for (const table of tables) {
    const columns = columnsByTable.get(table.id) ?? [];
    const columnSummary = columns.map((column) => `${column.label}: ${column.detail ?? ''}`.trim());
    artifactNodes.push(
      toArtifactNode(table, columnSummary.length > 0 ? columnSummary.join('\n') : '(no columns detected)'),
    );
    if (artifactNodes.length >= maxElements) {
      omission.record('projection element limit reached', table.id);
      break;
    }
  }

  const tableIds = new Set(tables.map((table) => table.id));
  const artifactEdges: ArtifactEdge[] = [];
  for (const edge of graph.edges) {
    if (!tableIds.has(edge.from) || !tableIds.has(edge.to)) continue;
    artifactEdges.push(toArtifactEdge(edge));
    if (artifactEdges.length >= maxElements) {
      omission.record('projection element limit reached', edge.id);
      break;
    }
  }

  if (tables.length > 0 && artifactEdges.length === 0) {
    omission.record(
      'no inter-table relationships in the graph; foreign keys are not inferred in this phase',
      tables[0]?.id ?? '',
    );
  }
const tablesWithoutColumns = tables.filter((table) => (columnsByTable.get(table.id) ?? []).length === 0);
  omission.recordCount(
    'tables detected without parsed columns',
    tablesWithoutColumns.length,
    tablesWithoutColumns.slice(0, 3).map((table) => table.id),
  );



  return {
    kind: 'er-diagram',
    title: 'Entity-relationship diagram',
    format: 'json',
    scope:
      'Tables and columns from SQL DDL and recognised schema declarations. Inter-table relationships are drawn only when the graph holds an explicit edge.',
    nodes: artifactNodes,
    edges: artifactEdges,
    omitted: omission.list(),
    insufficientEvidence: tables.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: artifactNodes.length,
      projectedEdges: artifactEdges.length,
    },
  };
}