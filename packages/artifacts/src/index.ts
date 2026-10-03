import { computeStats, type SoftwareGraph } from '@repoatlas/core';
import { buildClassDiagram } from './class-diagram.js';
import { toMermaid, type Artifact, type ProjectionContext } from './contract.js';
import { buildDependencyGraph, buildModuleGraph } from './dependency-graph.js';
import { buildErDiagram } from './er-diagram.js';
import { analyseGaps, type GapReport } from './gaps.js';

export * from './contract.js';
export * from './dependency-graph.js';
export * from './class-diagram.js';
export * from './er-diagram.js';
export * from './gaps.js';

/**
 * Artifact registry.
 *
 * Each entry declares what it needs from the graph. Ordering follows the build
 * sequence: artifacts that depend only on the most reliable facts come first, so an
 * incomplete repository still yields useful views.
 *
 * An artifact is *available* only when the graph contains enough of what it needs.
 * The API returns availability separately from content so the UI can say
 * "not enough evidence yet" instead of rendering an empty diagram.
 */
export interface ArtifactDescriptor {
  kind: string;
  title: string;
  /** Minimum number of projected edges before the view is considered meaningful. */
  minEdges: number;
  build(context: ProjectionContext): Artifact;
}

export const ARTIFACTS: readonly ArtifactDescriptor[] = [
  {
    kind: 'dependency-graph',
    title: 'Dependency graph',
    minEdges: 1,
    build: buildDependencyGraph,
  },
  {
    kind: 'module-graph',
    title: 'Module structure',
    minEdges: 1,
    build: buildModuleGraph,
  },
  {
    kind: 'class-diagram',
    title: 'Class diagram',
    minEdges: 0,
    build: buildClassDiagram,
  },
  {
    kind: 'er-diagram',
    title: 'Entity-relationship diagram',
    minEdges: 0,
    build: buildErDiagram,
  },
];

export const DEFAULT_PROJECTION_LIMITS = {
  maxElements: 5_000,
};

export function buildArtifact(graph: SoftwareGraph, kind: string, maxElements = DEFAULT_PROJECTION_LIMITS.maxElements): Artifact | undefined {
  const descriptor = ARTIFACTS.find((artifact) => artifact.kind === kind);
  if (!descriptor) return undefined;
  return descriptor.build({ graph, maxElements });
}

export interface RenderedArtifact extends Artifact {
  mermaid: string;
}

export function renderArtifact(artifact: Artifact): RenderedArtifact {
  return { ...artifact, mermaid: toMermaid(artifact) };
}

export interface AtlasProjection {
  graph: SoftwareGraph;
  stats: ReturnType<typeof computeStats>;
  artifacts: RenderedArtifact[];
  gaps: GapReport;
}

/**
 * Builds every available artifact plus the gap report from one graph.
 *
 * This is the single entry point artifact generation goes through, which is what
 * guarantees the API, the CLI and the UI always see the same set of views for a
 * given graph.
 */
export function projectAtlas(graph: SoftwareGraph, maxElements = DEFAULT_PROJECTION_LIMITS.maxElements): AtlasProjection {
  return {
    graph,
    stats: computeStats(graph),
    artifacts: ARTIFACTS.map((descriptor) => renderArtifact(descriptor.build({ graph, maxElements }))),
    gaps: analyseGaps(graph),
  };
}