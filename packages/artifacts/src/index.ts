import { computeStats, type SoftwareGraph } from '@repoatlas/core';
import { buildClassDiagram } from './class-diagram.js';
import { toMermaid, type Artifact, type ProjectionContext } from './contract.js';
import { buildActivity, buildSequence } from './behaviour.js';
import { buildC4 } from './c4.js';
import { checkConsistency, type ConsistencyReport } from './consistency.js';
import { buildDataFlow } from './data-flow.js';
import { buildDependencyGraph, buildModuleGraph } from './dependency-graph.js';
import { buildErDiagram } from './er-diagram.js';
import { analyseGaps, type GapReport } from './gaps.js';

export * from './contract.js';
export * from './dependency-graph.js';
export * from './class-diagram.js';
export * from './er-diagram.js';
export * from './behaviour.js';
export * from './c4.js';
export * from './consistency.js';
export * from './data-flow.js';
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
  // C4 levels come after the structural views: they are the most inferential, so they are
  // read once the reader already knows what the graph actually contains. `minEdges: 0`
  // because a level with no relationships is still informative — it reports that the
  // repository does not evidence one, rather than being hidden.
  {
    kind: 'c4-context',
    title: 'C4 — System context',
    minEdges: 0,
    build: (context) => buildC4(context, { level: 'context' }),
  },
  {
    kind: 'c4-container',
    title: 'C4 — Containers',
    minEdges: 0,
    build: (context) => buildC4(context, { level: 'container' }),
  },
  {
    kind: 'c4-component',
    title: 'C4 — Components',
    minEdges: 0,
    build: (context) => buildC4(context, { level: 'component' }),
  },
  // Behaviour and data come after the structural and architectural views. They are the most
  // inferential: a message arrow and a data flow are both claims about how the system runs,
  // not about what it is made of. Each reports what it could not evidence, and each drops a
  // relationship with no supporting graph edge.
  {
    kind: 'sequence',
    title: 'Sequence — interactions',
    minEdges: 0,
    build: (context) => buildSequence(context),
  },
  {
    kind: 'activity',
    title: 'Activity — control flow',
    minEdges: 0,
    build: (context) => buildActivity(context),
  },
  {
    kind: 'data-flow',
    title: 'Data flow',
    minEdges: 0,
    build: (context) => buildDataFlow(context),
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
  consistency: ConsistencyReport;
}

/**
 * Builds every available artifact, the gap report and the cross-artifact consistency
 * report from one graph.
 *
 * This is the single entry point artifact generation goes through, which is what
 * guarantees the API, the CLI and the UI always see the same set of views for a
 * given graph. The consistency report is built here rather than on demand so that
 * it cannot be computed against a different graph from the artifacts it checks.
 */
export function projectAtlas(graph: SoftwareGraph, maxElements = DEFAULT_PROJECTION_LIMITS.maxElements): AtlasProjection {
  const context: ProjectionContext = { graph, maxElements };
  return {
    graph,
    stats: computeStats(graph),
    artifacts: ARTIFACTS.map((descriptor) => renderArtifact(descriptor.build(context))),
    gaps: analyseGaps(graph),
    consistency: checkConsistency(context),
  };
}