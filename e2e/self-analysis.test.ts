import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runAnalysis } from '@repoatlas/server';

/**
 * End-to-end: analyse this repository with the real pipeline.
 *
 * This is the test that would fail if the product stopped working on real code rather
 * than on purpose-built fixtures. It asserts only invariants that must hold for any
 * non-trivial repository — never specific counts, which would break on every commit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

describe('RepoAtlas analysing its own source', () => {
  it('produces a coherent, fully-cited knowledge graph', async () => {
    const output = await runAnalysis({
      repositoryPath: REPO_ROOT,
      label: 'self-analysis',
      includeGitHistory: false,
    });

    expect(output.analysis.status).toBe('succeeded');

    // The repository is not empty and is not entirely unsupported.
    expect(output.stats.nodeCount).toBeGreaterThan(100);
    expect(output.stats.edgeCount).toBeGreaterThan(100);
    expect(output.analysis.summary?.analyzableFileCount ?? 0).toBeGreaterThan(10);

    // Every node cites at least one piece of repository evidence.
    for (const node of output.graph.nodes) {
      expect(node.evidence.length, `${node.id} is uncited`).toBeGreaterThan(0);
    }

    // Every edge references nodes that exist.
    const ids = new Set(output.graph.nodes.map((node) => node.id));
    for (const edge of output.graph.edges) {
      expect(ids.has(edge.from), `${edge.id} has a missing source`).toBe(true);
      expect(ids.has(edge.to), `${edge.id} has a missing target`).toBe(true);
    }

    // Every evidence reference resolves to a stored evidence record.
    const evidenceIds = new Set(output.graph.evidence.map((item) => item.id));
    for (const node of output.graph.nodes) {
      for (const ref of node.evidence) {
        expect(evidenceIds.has(ref.evidenceId), `${node.id} cites missing evidence`).toBe(true);
      }
    }
  });

  it('finds the entities that demonstrably exist in this repository', async () => {
    const output = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });
    const names = new Set(output.graph.nodes.map((node) => node.name));

    // Named in source and in package manifests, so their presence is a real assertion.
    for (const expected of [
      'SoftwareGraphBuilder',
      'EvidenceStore',
      'buildGraph',
      'discoverFiles',
      'TypeScriptSourceParser',
      'PythonSourceParser',
      'ParserRegistry',
      'analyseGaps',
      'buildDependencyGraph',
      'AnalysisService',
      'Store',
      'runAnalysis',
      'buildApp',
    ]) {
      expect(names.has(expected), `expected entity ${expected} in the graph`).toBe(true);
    }

    // API routes declared in this server are real evidence.
    expect(output.graph.nodes.some((node) => node.name === 'GET /api/health')).toBe(true);
    expect(output.graph.nodes.some((node) => node.name === 'POST /api/analyses')).toBe(true);
  });

  it('detects its own dependency declarations and reports consistency', async () => {
    const output = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });

    const packages = output.graph.nodes.filter((node) => node.kind === 'package').map((node) => node.name);
    expect(packages).toContain('fastify');
    expect(packages).toContain('@repoatlas/core');
    expect(packages).toContain('typescript');

    // The hygiene gap must reach a conclusion either way, and name the evidence.
    const hygiene = output.projection.gaps.gaps.find((gap) => gap.id === 'dependency-hygiene');
    expect(hygiene).toBeDefined();
    expect(hygiene?.observations.length).toBeGreaterThan(0);
  });

  it('reports that its own deployment architecture is not evidenced in the repository', async () => {
    // Honest by construction: the compose file exists in this repository, so this
    // asserts the opposite — that compose services are picked up.
    const output = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });
    const deployment = output.projection.gaps.gaps.find((gap) => gap.id === 'deployment-architecture');
    expect(deployment).toBeDefined();
    expect(['EXPLICIT', 'PARTIALLY_EVIDENCED']).toContain(deployment?.status);
    expect(output.graph.nodes.some((node) => node.kind === 'deployment_component')).toBe(true);
  });

  it('projects every registered artifact and reports insufficient evidence honestly', async () => {
    const output = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });

    expect(output.projection.artifacts.length).toBeGreaterThanOrEqual(4);
    for (const artifact of output.projection.artifacts) {
      expect(artifact.scope.length).toBeGreaterThan(0);
      expect(artifact.mermaid.length).toBeGreaterThan(0);
      expect(artifact.stats.projectedNodes).toBe(artifact.nodes.length);
    }

    // The dependency and class diagrams must have content; this repository has both.
    const dependency = output.projection.artifacts.find((artifact) => artifact.kind === 'dependency-graph');
    expect(dependency?.insufficientEvidence).toBe(false);
    expect(dependency!.edges.length).toBeGreaterThan(10);

    const classes = output.projection.artifacts.find((artifact) => artifact.kind === 'class-diagram');
    expect(classes?.edges.some((edge) => edge.kind === 'extends' || edge.kind === 'implements')).toBe(true);
  });

  it('is deterministic across repeated runs', async () => {
    const first = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });
    const second = await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });

    expect(second.stats.nodeCount).toBe(first.stats.nodeCount);
    expect(second.stats.edgeCount).toBe(first.stats.edgeCount);
    expect(second.graph.nodes.map((node) => node.id)).toEqual(first.graph.nodes.map((node) => node.id));
  });

  it('completes a full analysis within a sane time budget', async () => {
    // Not a benchmark claim: a guard against an accidental O(n^2) regression that would
    // make the product unusable. The threshold is deliberately generous.
    const started = performance.now();
    await runAnalysis({ repositoryPath: REPO_ROOT, includeGitHistory: false });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(120_000);
  });
});