import type { SoftwareGraph } from '@repoatlas/core';
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
 * Class diagram projection.
 *
 * Includes classes, interfaces, types and their `extends` / `implements`
 * relationships. Functions and methods are attached to their owning class as members
 * rather than as separate boxes, which is how a class diagram is conventionally read.
 *
 * Every relationship here originates from an explicit heritage clause in the source.
 * The only inference is which in-repository symbol the clause names, and that is why
 * these edges carry `STRONGLY_INFERRED` confidence in the graph rather than `EXPLICIT`.
 */

const TYPE_KINDS = new Set(['class', 'interface', 'type']);
const MEMBER_KINDS = new Set(['function', 'constant']);

export function buildClassDiagram(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();

  const types = graph.nodes.filter((node) => TYPE_KINDS.has(node.kind));

  const artifactNodes: ArtifactNode[] = [];
  const membersByOwner = new Map<string, string[]>();

  for (const type of types) {
    artifactNodes.push(toArtifactNode(type, detailForType(type)));
    if (artifactNodes.length >= maxElements) {
      omission.record('projection element limit reached', type.id);
      break;
    }
  }

  const typeIds = new Set(types.map((node) => node.id));

  // Members are nested under their owner when the owner is a type in this diagram.
  for (const node of graph.nodes) {
    if (!MEMBER_KINDS.has(node.kind)) continue;
    const owner = findOwningType(node, graph);
    if (!owner || !typeIds.has(owner.id)) continue;
    const list = membersByOwner.get(owner.id);
    if (list) list.push(`${node.name}${typeof node.attributes?.signature === 'string' ? String(node.attributes.signature) : '()'}`);
    else membersByOwner.set(owner.id, [`${node.name}${typeof node.attributes?.signature === 'string' ? String(node.attributes.signature) : '()'}`]);
  }

  for (const node of artifactNodes) {
    const members = membersByOwner.get(node.id);
    if (members && members.length > 0) node.detail = `${node.detail ? `${node.detail}\n` : ''}+ ${members.join('\n+ ')}`;
  }

  const artifactEdges: ArtifactEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'extends' && edge.kind !== 'implements') continue;
    if (!typeIds.has(edge.from) || !typeIds.has(edge.to)) {
      omission.record('heritage target is outside the analysed repository', `${edge.from} ${edge.kind} ${edge.to}`);
      continue;
    }
    artifactEdges.push(toArtifactEdge(edge));
    if (artifactEdges.length >= maxElements) {
      omission.record('projection element limit reached', edge.id);
      break;
    }
  }

  const relatedTypeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'extends' && edge.kind !== 'implements') continue;
    relatedTypeIds.add(edge.from);
    relatedTypeIds.add(edge.to);
  }
  const typesWithoutRelations = types.filter((type) => !relatedTypeIds.has(type.id));
  omission.recordCount(
    'types with no in-repository heritage relationship',
    typesWithoutRelations.length,
    typesWithoutRelations.slice(0, 3).map((type) => type.id),
  );

  return {
    kind: 'class-diagram',
    title: 'Class diagram',
    format: 'json',
    scope:
      'Classes, interfaces and type aliases with their extends/implements relationships. Only heritage clauses that resolve inside the analysed repository are drawn.',
    nodes: artifactNodes,
    edges: artifactEdges,
    omitted: omission.list(),
    insufficientEvidence: types.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: artifactNodes.length,
      projectedEdges: artifactEdges.length,
    },
  };
}

function detailForType(node: SoftwareGraph['nodes'][number]): string {
  const parts: string[] = [];
  const implementsFrom = node.attributes?.implementsFrom;
  if (typeof implementsFrom === 'string' && implementsFrom.length > 0) parts.push(`implements ${implementsFrom}`);
  if (node.path) parts.push(node.path);
  return parts.join('\n');
}

/** Finds the type that lexically contains a member, using the qualified name prefix. */
function findOwningType(
  node: SoftwareGraph['nodes'][number],
  graph: SoftwareGraph,
): SoftwareGraph['nodes'][number] | undefined {
  const qualified = node.qualifiedName;
  if (!qualified) return undefined;
  const parts = qualified.split('.');
  for (let take = parts.length - 1; take > 0; take -= 1) {
    const candidate = parts.slice(0, take).join('.');
    const owner = graph.nodes.find((item) => TYPE_KINDS.has(item.kind) && item.qualifiedName === candidate);
    if (owner) return owner;
  }
  return undefined;
}