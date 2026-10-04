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
 * Built from `table` and `column` nodes, which come from SQL DDL and from schema definitions
 * the configuration scanner recognises.
 *
 * Phase 3 strengthened this rather than replacing it. The DDL parser now records what a
 * schema constrains — primary keys, foreign-key targets, nullability, uniqueness — and the
 * builder records an explicit `references` relationship for every `REFERENCES` clause. So the
 * diagram can draw a key and a relationship because the schema states them, not because two
 * column names resemble each other.
 *
 * The rule that survives from Phase 1: a relationship is drawn only when the graph holds an
 * edge for it. A column named `report_id` is not a foreign key, and a table with no declared
 * relationship is reported as having none declared rather than having none at all.
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
    // Key and constraint markers travel with the column so a reader can see that a key is
    // declared rather than guessed from a name.
    const constraints = constraintSummary(column);
    const projected = toArtifactNode(column, [String(column.attributes?.dataType ?? ''), constraints].filter(Boolean).join(' '));
    if (constraints.length > 0) projected.derivation = `Declared by the schema: ${constraints.join(', ')}.`;
    if (list) list.push(projected);
    else columnsByTable.set(ownerId, [projected]);
  }

  const artifactNodes: ArtifactNode[] = [];
  for (const table of tables) {
    const columns = columnsByTable.get(table.id) ?? [];
    const columnSummary = columns.map((column) => `${column.label}: ${column.detail ?? ''}`.trim());
    const projected = toArtifactNode(table, columnSummary.length > 0 ? columnSummary.join('\n') : '(no columns detected)');
    const primaryKey = typeof table.attributes?.primaryKey === 'string' ? table.attributes.primaryKey : '';
    if (primaryKey.length > 0) {
      projected.derivation = `The schema declares the primary key as ${primaryKey}.`;
      projected.technology = `pk: ${primaryKey}`;
    } else {
      projected.derivation = 'No primary key is declared for this table in the analysed repository.';
    }
    artifactNodes.push(projected);
    if (artifactNodes.length >= maxElements) {
      omission.record('projection element limit reached', table.id);
      break;
    }
  }

  const tableIds = new Set(tables.map((table) => table.id));
  const artifactEdges: ArtifactEdge[] = [];
  let declaredRelationships = 0;

  for (const edge of graph.edges) {
    if (!tableIds.has(edge.from) || !tableIds.has(edge.to)) continue;
    declaredRelationships += 1;
    const projected = toArtifactEdge(edge);
    if (edge.kind === 'references') {
      projected.label = `references ${String(edge.attributes?.column ?? '')}`.trim();
      projected.derivation = 'An explicit foreign key in the schema.';
      projected.supportingEdgeIds = [edge.id];
    }
    artifactEdges.push(projected);
    if (artifactEdges.length >= maxElements) {
      omission.record('projection element limit reached', edge.id);
      break;
    }
  }

  if (tables.length > 0 && declaredRelationships === 0) {
    omission.record(
      'no inter-table relationships are declared in the analysed schema; foreign keys are not inferred from column names',
      tables[0]?.id ?? '',
    );
  }

  const undeclared = tables.filter((table) => table.attributes?.declaredInDdl === false);
  omission.recordCount(
    'tables referenced by code but never declared in a schema this analysis read; their columns are unknown, not empty',
    undeclared.length,
    undeclared.slice(0, 3).map((table) => table.id),
  );

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
      'Tables, columns and keys from SQL DDL and recognised schema declarations. Primary keys, nullability, uniqueness and relationships are drawn when the schema declares them; none is inferred from a column name.',
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

/** The constraints a column's declaration states, in the words the schema used. */
function constraintSummary(column: { attributes?: Record<string, string | number | boolean | null> }): string[] {
  const summary: string[] = [];
  if (column.attributes?.primaryKey === true) summary.push('primary key');
  if (column.attributes?.unique === true) summary.push('unique');
  if (column.attributes?.notNull === true) summary.push('not null');
  if (typeof column.attributes?.referencesTable === 'string') summary.push(`references ${column.attributes.referencesTable}`);
  return summary;
}
