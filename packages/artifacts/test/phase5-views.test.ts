import { describe, expect, it } from 'vitest';
import { buildDeployment, buildSecurity } from '@repoatlas/artifacts';
import { buildGraph, DiagnosticCollector, EvidenceStore, nodeId, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

const REPOSITORY: RepositoryRef = { absolutePath: '/repo', name: 'repo' };

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    language: 'typescript',
    producer: 'typescript-compiler-api',
    imports: [],
    entities: [],
    calls: [],
    markers: [],
    responses: [],
    throws: [],
    returns: [],
    problems: [],
    durationMs: 0,
    ...overrides,
  };
}

function graphFrom(files: ParsedFile[]) {
  const evidence = new EvidenceStore({ maxExcerptChars: 200 });
  return buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits: [],
    headCommit: null,
    branch: null,
    evidence,
    diagnostics: new DiagnosticCollector(),
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: false,
  }).graph;
}

const composeService = (service: string, line: number, extra: Record<string, unknown> = {}) => ({
  name: 'compose.service',
  line,
  attributes: { service, image: `repo/${service}:1`, build: null, publishedPorts: '', ...extra },
});

/** A two-service stack with a dependency, a network, a credential, and a health check. */
const STACK_GRAPH = graphFrom([
  parsedFile('docker-compose.yml', {
    language: 'yaml',
    producer: 'config-scanner',
    markers: [
      composeService('web', 2, { publishedPorts: '8080' }),
      composeService('db', 12),
      { name: 'compose.depends_on', line: 5, attributes: { service: 'web', dependsOn: 'db' } },
      { name: 'compose.network', line: 6, attributes: { service: 'web', network: 'front' } },
      { name: 'compose.network_declared', line: 20, attributes: { network: 'front' } },
      { name: 'compose.environment', line: 7, attributes: { service: 'web', variable: 'STRIPE_SECRET_KEY' } },
      { name: 'compose.environment', line: 8, attributes: { service: 'web', variable: 'NODE_ENV' } },
      { name: 'compose.healthcheck', line: 10, attributes: { service: 'web', test: 'CMD curl -f http://localhost/health' } },
    ],
  }),
  parsedFile('Dockerfile', {
    language: 'dockerfile',
    producer: 'config-scanner',
    markers: [{ name: 'docker.base_image', line: 1, attributes: { image: 'node:24-bookworm-slim', stage: 'runtime' } }],
  }),
  parsedFile('.github/workflows/ci.yml', {
    language: 'yaml',
    producer: 'config-scanner',
    markers: [
      { name: 'workflow.job', line: 6, attributes: { job: 'release', runsOn: 'ubuntu-latest', stepCount: '2' } },
      { name: 'workflow.step', line: 8, attributes: { job: 'release', uses: 'docker/build-push-action@v5', namesDeployment: 'true' } },
      { name: 'workflow.secret', line: 8, attributes: { job: 'release', variable: 'NPM_TOKEN' } },
    ],
  }),
]);

const EMPTY_GRAPH = graphFrom([parsedFile('src/a.ts')]);

describe('deployment projection', () => {
  const artifact = buildDeployment({ graph: STACK_GRAPH, maxElements: 5_000 });

  it('projects declared services, the network and the base image', () => {
    const labels = artifact.nodes.map((node) => node.label);
    expect(labels).toContain('web');
    expect(labels).toContain('db');
    expect(labels).toContain('front');
    expect(labels).toContain('node:24-bookworm-slim');
  });

  it('says a port is declared rather than bound', () => {
    // "declared, not observed bound" is the difference between reading a compose file and
    // watching a machine. Dropping those words would let a reader assume the latter.
    const web = artifact.nodes.find((node) => node.label === 'web');
    expect(web?.detail).toContain('declares container ports 8080');
    expect(web?.detail).toContain('not observed bound');
  });

  it('says a health check is configured and its result is unknown', () => {
    const web = artifact.nodes.find((node) => node.label === 'web');
    expect(web?.detail).toContain('health check configured, result unknown');
    expect(artifact.omitted.some((entry) => entry.reason.includes('No check was executed'))).toBe(true);
  });

  it('draws the declared dependency and the network membership with graph support', () => {
    const dependency = artifact.edges.find((edge) => edge.kind === 'depends_on');
    expect(dependency?.source).toBe('deployment_component:web');
    expect(dependency?.target).toBe('deployment_component:db');
    expect(dependency?.supportingEdgeIds?.length).toBe(1);
    expect(dependency?.derivation).toContain('does not state that the dependency is reachable, started or healthy');

    const network = artifact.edges.find((edge) => edge.kind === 'joins_network');
    expect(network?.target).toBe(nodeId('network', 'front'));
  });

  it('gives every element a derivation', () => {
    for (const node of artifact.nodes) expect(node.derivation, node.id).toBeTruthy();
    for (const edge of artifact.edges) expect(edge.derivation, edge.id).toBeTruthy();
  });

  it('states its scope as declarations only', () => {
    expect(artifact.scope).toContain('Nothing here has been observed running');
  });

  it('reports insufficient evidence for a repository with no deployment files', () => {
    const empty = buildDeployment({ graph: EMPTY_GRAPH, maxElements: 5_000 });
    expect(empty.insufficientEvidence).toBe(true);
    expect(empty.nodes).toHaveLength(0);
  });
});

describe('security projection', () => {
  const artifact = buildSecurity({ graph: STACK_GRAPH, maxElements: 5_000 });

  it('names credential-like variables and leaves ordinary ones as configuration', () => {
    const secrets = artifact.nodes.filter((node) => node.kind === 'secret_reference').map((node) => node.label);
    expect(secrets).toEqual(['STRIPE_SECRET_KEY', 'NPM_TOKEN']);
    expect(secrets).not.toContain('NODE_ENV');
  });

  it('never attaches a verdict to any element', () => {
    // The single property that makes this view honest. A verdict needs evidence this product does
    // not collect, so no element may carry one. The scope and omission text *do* name these words
    // in order to disclaim them, so this checks the elements a reader acts on.
    for (const node of artifact.nodes) {
      const text = `${node.label} ${node.detail ?? ''} ${node.derivation ?? ''}`.toLowerCase();
      for (const word of ['vulnerable', 'insecure', 'is secure', 'is safe', 'exploit', 'cve-', 'risk: high', 'high risk', 'low risk']) {
        expect(text, `${node.label}: ${word}`).not.toContain(word);
      }
    }
  });

  it('disclaims the verdict words rather than avoiding them entirely', () => {
    expect(artifact.scope).toContain('does not assess whether anything is secure or insecure');
  });

  it('reports a reference as unprotected only in terms of this analysis', () => {
    const secret = artifact.nodes.find((node) => node.label === 'STRIPE_SECRET_KEY');
    expect(secret?.detail).toContain('no check observed');
    expect(secret?.detail).toContain('static reading cannot tell whether one exists');
  });

  it('says the value was never read', () => {
    const secret = artifact.nodes.find((node) => node.label === 'STRIPE_SECRET_KEY');
    expect(secret?.derivation).toContain('The value was never read');
  });

  it('reports a base image without claiming anything about its contents', () => {
    const image = artifact.nodes.find((node) => node.kind === 'base_image');
    expect(image?.label).toBe('node:24-bookworm-slim');
    expect(image?.derivation).toContain('no advisory database is consulted');
  });

  it('reports a workflow with a step count and no claim about its success', () => {
    const workflow = artifact.nodes.find((node) => node.kind === 'ci_workflow');
    expect(workflow?.label).toBe('.github/workflows/ci.yml');
    expect(workflow?.detail).toContain('1 job(s), 1 step(s), 1 naming deployment');
    expect(workflow?.derivation).toContain('No step was executed');
  });

  it('says explicitly that no scan was performed', () => {
    expect(artifact.omitted.some((entry) => entry.reason.includes('No vulnerability scan'))).toBe(true);
  });

  it('distinguishes a missing reference from an absent need', () => {
    const empty = buildSecurity({ graph: EMPTY_GRAPH, maxElements: 5_000 });
    const reason = empty.omitted.find((entry) => entry.reason.includes('credential-like'));
    expect(reason?.reason).toContain('not that the repository needs no secrets');
  });
});