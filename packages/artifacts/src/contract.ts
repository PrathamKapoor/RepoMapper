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

export interface ArtifactNode {
  id: string;
  label: string;
  kind: string;
  confidence: Confidence;
  /** Short qualifier shown under the label, e.g. a path or HTTP method. */
  detail?: string;
  path?: string;
  evidence: EvidenceRef[];
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