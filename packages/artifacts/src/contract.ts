import type { Confidence, EdgeKind, EvidenceRef, GraphEdge, GraphNode, SoftwareGraph } from '@repoatlas/core';

/**
 * The artifact contract.
 *
 * An artifact is a *projection* of the canonical graph, never an independent model.
 * Two consequences that the whole product depends on:
 *
 *  1. An artifact may only use facts already present in the graph. If a diagram needs
 *     a fact the graph does not have, the fix is to improve extraction — not to make
 *     the diagram guess.
 *  2. An artifact must carry confidence through to its output. A diagram whose
 *     relationships are inferred must say so, otherwise the UI would present a guess
 *     with the same authority as a cited fact.
 *
 * Every artifact also reports what it *could not* draw. A projection that silently
 * omits unresolved relationships is indistinguishable from one that found none.
 */

/** C4 abstraction levels, in progressive-disclosure order. */
export const C4_LEVELS = ['context', 'container', 'component'] as const;
export type C4Level = (typeof C4_LEVELS)[number];

/** C4 element kinds. Deliberately narrow: only what the graph can evidence. */
export type C4ElementKind =
  | 'software_system'
  | 'container'
  | 'component'
  | 'external_system'
  | 'person';

/** Projections that are not part of the C4 model. */
export const BEHAVIOUR_VIEWS = ['sequence', 'activity', 'data-flow'] as const;
export type BehaviourView = (typeof BEHAVIOUR_VIEWS)[number];

export interface ArtifactNode {
  id: string;
  label: string;
  kind: string;
  confidence: Confidence;
  /** Short qualifier shown under the label, e.g. a path or HTTP method. */
  detail?: string;
  path?: string;
  evidence: EvidenceRef[];
  /** C4 abstraction level, set only by the C4 projections. */
  c4Level?: C4Level;
  /** C4 element kind, set only by the C4 projections. */
  c4Kind?: C4ElementKind;
  /**
   * Which non-C4 projection produced this element.
   *
   * Separate from `c4Level` because a sequence view and an activity view are not C4
   * abstraction levels, and labelling them as such would invite a reader to treat a message
   * arrow as an architectural relationship.
   */
  view?: BehaviourView;
  /** Technology named by repository evidence, e.g. an image or language. */
  technology?: string;
  /** Graph nodes this element was derived from. Always non-empty for C4 elements. */
  graphNodeIds?: string[];
  /**
   * The explicit rule that produced this element.
   *
   * Present so a viewer can answer "why does RepoAtlas believe this exists?" without
   * reading the projection source. A C4 element without a derivation is not accepted.
   */
  derivation?: string;
}

export interface ArtifactEdge {
  id: string;
  /** The relationship kind, carried through from the graph so a consumer can tell an import from a call. */
  kind: EdgeKind;
  source: string;
  target: string;
  label?: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  /** C4 abstraction level, set only by the C4 projections. */
  c4Level?: C4Level;
  /** Which non-C4 projection produced this relationship. */
  view?: BehaviourView;
  /**
   * Graph edges that justify this architectural relationship.
   *
   * Every relationship must trace to graph facts. A relationship justified only by the
   * existence of graph nodes — for example "these two are co-declared in one compose
   * file" — names those nodes in `supportingNodeIds` instead. One of the two sets must be
   * non-empty; an empty pair would be an invented relationship.
   */
  supportingEdgeIds?: string[];
  /**
   * Graph nodes that justify this relationship where no edge does.
   *
   * Existence-based support is weaker than edge-based support and must be stated as such
   * by the confidence and derivation on the same record.
   */
  supportingNodeIds?: string[];
  /** The explicit rule that produced this relationship. */
  derivation?: string;
}

/**
 * True when a projected relationship is backed by at least one graph fact.
 *
 * The C4 projections use this as a structural gate: a relationship with no support is
 * dropped rather than rendered, because an unsupported arrow is an invented dependency
 * wearing the visual authority of an evidenced one.
 */
export function hasGraphSupport(edge: ArtifactEdge): boolean {
  return (edge.supportingEdgeIds?.length ?? 0) > 0 || (edge.supportingNodeIds?.length ?? 0) > 0;
}

export type ArtifactFormat = 'json' | 'mermaid';

export interface Artifact {
  /** Stable identifier, e.g. `dependency-graph`. */
  kind: string;
  title: string;
  format: ArtifactFormat;
  /** Short statement of what this view does and does not show. */
  scope: string;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  /**
   * Facts in the graph that this artifact could not represent. Surfaced in the UI so
   * an incomplete diagram is never mistaken for a complete one.
   */
  omitted: { reason: string; count: number; examples: string[] }[];
  /** True when the graph did not contain enough to draw this view meaningfully. */
  insufficientEvidence: boolean;
  /** Counts used to decide whether to render or show a "not enough evidence" state. */
  stats: { graphNodes: number; graphEdges: number; projectedNodes: number; projectedEdges: number };
}

export interface ProjectionContext {
  graph: SoftwareGraph;
  /** Hard ceiling on projected elements, so a huge graph cannot produce a huge payload. */
  maxElements: number;
}

/** Maps a graph node onto an artifact node, preserving confidence and evidence. */
export function toArtifactNode(node: GraphNode, detail?: string): ArtifactNode {
  return {
    id: node.id,
    label: node.name,
    kind: node.kind,
    confidence: node.confidence,
    ...(detail ? { detail } : {}),
    ...(node.path ? { path: node.path } : {}),
    evidence: node.evidence,
  };
}

export function toArtifactEdge(edge: GraphEdge): ArtifactEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    source: edge.from,
    target: edge.to,
    ...(edge.label ? { label: edge.label } : {}),
    confidence: edge.confidence,
    evidence: edge.evidence,
  };
}

/**
 * Renders an artifact as Mermaid.
 *
 * Mermaid is the text projection format because it renders in the browser with no
 * server-side renderer and no headless browser, which keeps the deployment surface
 * small. Confidence is encoded in the arrow style so an inferred relationship is
 * visibly different from a cited one in the rendered diagram.
 */
export function toMermaid(artifact: Artifact): string {
  const lines: string[] = [];
  lines.push(`${mermaidDiagramType(artifact.kind)} ${artifact.edges.length > artifact.nodes.length ? 'LR' : 'TD'}`);

  for (const node of artifact.nodes) {
    lines.push(`  ${mermaidId(node.id)}["${escapeLabel(node.label)}"]`);
  }

  for (const edge of artifact.edges) {
    const source = mermaidId(edge.source);
    const target = mermaidId(edge.target);

    if (edge.confidence !== 'EXPLICIT') {
      // Dotted arrow plus a confidence tag: a guess must not look like a fact.
      lines.push(`  ${source} -. "${edge.confidence}" .-> ${target}`);
      continue;
    }
    const label = edge.label ? `|${escapeLabel(edge.label)}|` : '';
    lines.push(`  ${source} -->${label} ${target}`);
  }

  return lines.join('\n');
}

function mermaidDiagramType(kind: string): string {
  switch (kind) {
    case 'class-diagram':
      return 'classDiagram';
    default:
      return 'flowchart LR';
  }
}

/** Mermaid identifiers cannot contain arbitrary characters, so ids are hashed-safe. */
function mermaidId(id: string): string {
  return `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 80);
}

/** Collects omission reasons for a projection so incompleteness is always visible. */
export class OmissionLog {
  private readonly entries = new Map<string, { count: number; examples: string[] }>();

  /** Records one occurrence of an omission, remembering a few examples. */
  record(reason: string, example: string): void {
    const entry = this.entries.get(reason);
    if (entry) {
      entry.count += 1;
      if (entry.examples.length < 5 && !entry.examples.includes(example)) entry.examples.push(example);
      return;
    }
    this.entries.set(reason, { count: 1, examples: [example] });
  }

  /** Records that `count` occurrences of a reason were observed in one pass. */
  recordCount(reason: string, count: number, examples: string[] = []): void {
    if (count === 0) return;
    this.entries.set(reason, { count, examples: examples.slice(0, 5) });
  }

  list(): Artifact['omitted'] {
    return [...this.entries.entries()].map(([reason, value]) => ({
      reason,
      count: value.count,
      examples: value.examples,
    }));
  }
}

/** Node kinds that should never be drawn in a module-level view. */
export const NOISE_NODE_KINDS = new Set(['commit', 'contributor', 'evidence']);

export type { EdgeKind };