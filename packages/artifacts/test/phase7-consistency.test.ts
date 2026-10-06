import { describe, expect, it } from 'vitest';
import { buildGraph, EvidenceStore, type GraphBuildInput } from '@repoatlas/core';
import { projectAtlas, checkConsistency } from '@repoatlas/artifacts';

function emptyGraph() {
  const input: GraphBuildInput = {
    repository: { path: '/test/repo', name: 'test' },
    files: [],
    parsed: [],
    commits: [],
    headCommit: null,
    branch: null,
    evidence: new EvidenceStore({ maxExcerptChars: 200 }),
    diagnostics: { add: () => undefined, all: () => [] },
    limits: { maxNodes: 10000, maxEdges: 20000 },
    includeGitHistory: false,
  };
  return buildGraph(input);
}

describe('Cross-artifact consistency invariants', () => {
  it('projections never invent graph facts', () => {
    const result = emptyGraph();
    const graph = result.graph;
    const projection = projectAtlas(graph);
    for (const artifact of projection.artifacts) {
      for (const node of artifact.nodes) {
        if (node.graphNodeIds && node.graphNodeIds.length > 0) {
          for (const id of node.graphNodeIds) {
            expect(graph.nodes.some((n) => n.id === id)).toBe(true);
          }
        }
      }
      for (const edge of artifact.edges) {
        if (edge.supportingEdgeIds && edge.supportingEdgeIds.length > 0) {
          for (const id of edge.supportingEdgeIds) {
            expect(graph.edges.some((e) => e.id === id)).toBe(true);
          }
        }
      }
    }
  });

  it('consistency report has no contradictions on empty graph', () => {
    const result = emptyGraph();
    const report = checkConsistency({ graph: result.graph, maxElements: 100 });
    expect(report.counts.CONTRADICTION).toBe(0);
  });

  it('every artifact reports scope when graph is empty', () => {
    const result = emptyGraph();
    const projection = projectAtlas(result.graph);
    for (const artifact of projection.artifacts) {
      expect(artifact.scope.length).toBeGreaterThan(0);
    }
  });
});
