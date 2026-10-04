import { describe, expect, it } from 'vitest';
import { ARTIFACTS, buildArtifact, buildC4, detectInfrastructureFamily, hasGraphSupport, projectAtlas, weakestConfidence } from '@repoatlas/artifacts';
import { buildGraph, DiagnosticCollector, EvidenceStore, type ParsedFile, type RepositoryRef, type SoftwareGraph } from '@repoatlas/core';

/**
 * C4 fixtures.
 *
 * Graphs are built through `buildGraph()` so the fixtures carry the same evidence and
 * confidence the real pipeline produces. A hand-written graph would let the projection pass
 * tests that the product would fail, which is precisely the failure this product exists to
 * prevent.
 */

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
    problems: [],
    durationMs: 0,
    ...overrides,
  };
}

function graphFrom(files: ParsedFile[]): SoftwareGraph {
  return buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits: [],
    headCommit: null,
    branch: null,
    evidence: new EvidenceStore({ maxExcerptChars: 200 }),
    diagnostics: new DiagnosticCollector(),
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: false,
  }).graph;
}

function composeFile(services: { service: string; image?: string; build?: string }[]): ParsedFile {
  return parsedFile('docker-compose.yml', {
    language: 'yaml',
    producer: 'config-scanner',
    markers: services.map((service, index) => ({
      name: 'compose.service',
      line: index * 4 + 2,
      attributes: {
        service: service.service,
        image: service.image ?? null,
        build: service.build ?? null,
        publishedPorts: '',
      },
    })),
  });
}

/** A repository with two build-context containers, one external datastore and a cross-container import. */
const DEPLOYED_GRAPH = graphFrom([
  composeFile([
    { service: 'api', image: 'repo/api:1', build: './api' },
    { service: 'worker', image: 'repo/worker:1', build: './worker' },
    { service: 'cache', image: 'redis:7-alpine' },
  ]),
  parsedFile('api/main.ts', {
    imports: [{ specifier: '../worker/jobs.js', names: ['runJob'], kind: 'static', line: 1, isExternal: false }],
  }),
  parsedFile('api/routes/health.ts'),
  parsedFile('worker/jobs.ts'),
]);

/** A repository with no deployment configuration at all. */
const PLAIN_GRAPH = graphFrom([
  parsedFile('src/a.ts', {
    imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 1, isExternal: false }],
  }),
  parsedFile('src/b.ts'),
]);

function c4Of(graph: SoftwareGraph, level: 'context' | 'container' | 'component') {
  return buildC4({ graph, maxElements: 5_000 }, { level });
}

describe('C4 level 1 — context', () => {
  it('represents the analysed repository as the software system, with its citations', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'context');
    const system = artifact.nodes.find((node) => node.c4Kind === 'software_system');
    expect(system?.label).toBe('repo');
    expect(system?.confidence).toBe('EXPLICIT');
    expect(system?.evidence.length).toBeGreaterThan(0);
    expect(system?.graphNodeIds).toEqual([system?.id]);
    expect(system?.derivation).toBeTruthy();
  });

  it('recovers an external system only where a declared image matches a known family', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'context');
    const externals = artifact.nodes.filter((node) => node.c4Kind === 'external_system');
    expect(externals).toHaveLength(1);
    expect(externals[0]?.label).toBe('cache');
    expect(externals[0]?.technology).toBe('redis:7-alpine');
    // The compose file states the image; that it is an external datastore is our reading of
    // the name, so it cannot be presented as an explicit fact.
    expect(externals[0]?.confidence).toBe('WEEKLY_INFERRED');
    expect(externals[0]?.evidence[0]?.path).toBe('docker-compose.yml');
  });

  it('does not present its own services as external systems', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'context');
    expect(artifact.nodes.filter((node) => node.c4Kind === 'external_system').map((node) => node.label)).not.toContain('api');
    const omission = artifact.omitted.find((entry) => entry.reason.includes('known datastore or broker family'));
    expect(omission?.count).toBe(2);
    expect(omission?.examples).toContain('api');
  });

  it('never invents a human actor and says why', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'context');
    expect(artifact.nodes.some((node) => node.c4Kind === 'person')).toBe(false);
    expect(artifact.omitted.some((entry) => entry.reason.includes('human actors'))).toBe(true);
  });

  it('reports that communication is evidenced by co-declaration, not by a code path', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'context');
    const relationship = artifact.edges.find((edge) => edge.target.includes('cache'));
    expect(relationship?.confidence).toBe('WEEKLY_INFERRED');
    expect(artifact.omitted.some((entry) => entry.reason.includes('not by a code path'))).toBe(true);
  });

  it('says so when the graph has no repository node', () => {
    const orphan = graphFrom([parsedFile('src/a.ts')]);
    const stripped: SoftwareGraph = { ...orphan, nodes: orphan.nodes.filter((node) => node.kind !== 'repository') };
    const artifact = c4Of(stripped, 'context');
    expect(artifact.nodes).toHaveLength(0);
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.scope).toContain('no repository node');
  });
});

describe('C4 level 2 — container', () => {
  it('treats each declared service as a container carrying the declared image', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'container');
    const containers = artifact.nodes.filter((node) => node.c4Kind === 'container');
    expect(containers.map((node) => node.label).sort()).toEqual(['api', 'cache', 'worker']);
    const api = containers.find((node) => node.label === 'api');
    expect(api?.technology).toBe('repo/api:1');
    expect(api?.confidence).toBe('EXPLICIT');
    expect(api?.evidence[0]?.path).toBe('docker-compose.yml');
  });

  it('places a container inside the software system that declares it', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'container');
    const contains = artifact.edges.filter((edge) => edge.kind === 'contains');
    expect(contains).toHaveLength(3);
    expect(contains.every((edge) => edge.source === 'repository:repo')).toBe(true);
    expect(contains.every((edge) => (edge.supportingNodeIds?.length ?? 0) > 0)).toBe(true);
  });

  it('derives a container dependency from imports between modules in different containers', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'container');
    const dependency = artifact.edges.find((edge) => edge.kind === 'depends_on');
    expect(dependency).toBeDefined();
    expect(dependency?.source).toBe('deployment_component:api');
    expect(dependency?.target).toBe('deployment_component:worker');
    // The relationship is only as strong as the graph edge behind it.
    expect(dependency?.confidence).toBe('EXPLICIT');
    expect(dependency?.supportingEdgeIds).toContain('module:api/main|imports|module:worker/jobs');
    expect(dependency?.evidence[0]?.path).toBe('api/main.ts');
    expect(dependency?.derivation).toContain('deploys relationships');
  });

  it('is honestly insufficient when the repository declares no deployment', () => {
    const artifact = c4Of(PLAIN_GRAPH, 'container');
    expect(artifact.nodes.filter((node) => node.c4Kind === 'container')).toHaveLength(0);
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('no deployment configuration'))).toBe(true);
  });

  it('records a container it cannot fill, rather than drawing one with invented contents', () => {
    // `cache` declares only an image, so nothing in the repository says which code runs in it.
    const artifact = c4Of(DEPLOYED_GRAPH, 'container');
    const omission = artifact.omitted.find((entry) => entry.reason.includes('no module attributed'));
    expect(omission?.count).toBe(1);
    expect(omission?.examples).toEqual(['cache']);
  });

  it('excludes dependency packages and says a package is not a container', () => {
    const graph = graphFrom([
      parsedFile('package.json', {
        language: 'json',
        producer: 'config-scanner',
        markers: [
          {
            name: 'manifest.dependency',
            line: 3,
            attributes: { dependency: 'express', section: 'dependencies', range: '^4.0.0' },
          },
        ],
      }),
      composeFile([{ service: 'api', build: './api' }]),
      parsedFile('api/main.ts'),
    ]);

    const artifact = c4Of(graph, 'container');
    expect(artifact.nodes.some((node) => node.label === 'express')).toBe(false);
    expect(artifact.omitted.some((entry) => entry.reason.includes('third-party packages are excluded'))).toBe(true);
  });
  it('does not treat a Docker base image as a container of this system', () => {
    // `FROM node:24-bookworm-slim` states what an image is built from, not a runtime unit.
    // Drawing it would put a dependency in the architecture beside the system itself.
    const graph = graphFrom([
      parsedFile('Dockerfile', {
        language: 'dockerfile',
        producer: 'config-scanner',
        markers: [{ name: 'docker.base_image', line: 1, attributes: { image: 'node:24-bookworm-slim', stage: 'runtime' } }],
      }),
      parsedFile('src/a.ts'),
    ]);

    const artifact = c4Of(graph, 'container');
    expect(artifact.nodes.some((node) => node.label === 'node:24-bookworm-slim')).toBe(false);
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('only base images were declared'))).toBe(true);
  });

  it('does not treat a base image as an external system at context level', () => {
    const graph = graphFrom([
      parsedFile('Dockerfile', {
        language: 'dockerfile',
        producer: 'config-scanner',
        markers: [{ name: 'docker.base_image', line: 1, attributes: { image: 'postgres:16', stage: 'runtime' } }],
      }),
    ]);
    const artifact = c4Of(graph, 'context');
    // A build dependency is not something the running system communicates with.
    expect(artifact.nodes.filter((node) => node.c4Kind === 'external_system')).toHaveLength(0);
    expect(artifact.omitted.some((entry) => entry.reason.includes('base images are not external systems'))).toBe(true);
  });

  it('records a base image as an omission rather than dropping it silently', () => {
    const graph = graphFrom([
      parsedFile('Dockerfile', {
        language: 'dockerfile',
        producer: 'config-scanner',
        markers: [{ name: 'docker.base_image', line: 1, attributes: { image: 'node:24-bookworm-slim', stage: 'runtime' } }],
      }),
      composeFile([{ service: 'api', build: './api' }]),
      parsedFile('api/main.ts'),
    ]);
    const artifact = c4Of(graph, 'container');
    const omission = artifact.omitted.find((entry) => entry.reason.includes('base images are not containers'));
    expect(omission?.count).toBe(1);
    expect(omission?.examples).toEqual(['node:24-bookworm-slim']);
  });
});

describe('C4 level 3 — component', () => {
  it('places only the modules the graph attributes to a container', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'component');
    const components = artifact.nodes.filter((node) => node.c4Kind === 'component').map((node) => node.id);
    expect(components.sort()).toEqual(['module:api/main', 'module:api/routes/health', 'module:worker/jobs']);
    // The container each component belongs to is present, flagged as context.
    expect(artifact.nodes.filter((node) => node.c4Kind === 'container')).toHaveLength(2);
  });

  it('carries the derivation and the evidence of the rule that placed a component', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'component');
    const main = artifact.nodes.find((node) => node.id === 'module:api/main');
    expect(main?.derivation).toContain('deploys relationship');
    // The element is the module, so it cites its own file.
    expect(main?.evidence[0]?.path).toBe('api/main.ts');
    expect(main?.technology).toBe('typescript');

    // The relationship is where the deployment evidence lives: it cites the compose line
    // that put this code in that container.
    const contains = artifact.edges.find((edge) => edge.source === 'deployment_component:api' && edge.target === 'module:api/main');
    expect(contains?.supportingEdgeIds).toHaveLength(1);
    expect(contains?.evidence[0]?.path).toBe('docker-compose.yml');
    // The build context is evidence about the build, not proof of what the image runs.
    expect(contains?.confidence).toBe('STRONGLY_INFERRED');
  });

  it('does not present the compose file as a component of the container it declares', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'component');
    expect(artifact.nodes.some((node) => node.id === 'module:docker-compose')).toBe(false);
    expect(artifact.omitted.some((entry) => entry.reason.includes('deployment files that declare a container'))).toBe(true);
  });

  it('takes component dependencies straight from graph edges, with their confidence', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'component');
    const dependency = artifact.edges.find((edge) => edge.kind === 'depends_on');
    expect(dependency?.source).toBe('module:api/main');
    expect(dependency?.target).toBe('module:worker/jobs');
    expect(dependency?.confidence).toBe('EXPLICIT');
    expect(dependency?.supportingEdgeIds).toEqual(['module:api/main|imports|module:worker/jobs']);
  });

  it('is honestly insufficient when no module can be attributed to a container', () => {
    const artifact = c4Of(PLAIN_GRAPH, 'component');
    expect(artifact.nodes).toHaveLength(0);
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('no module carries a deploys relationship'))).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('without guessing'))).toBe(true);
  });

  it('omits modules it cannot place and explains the count', () => {
    const graph = graphFrom([
      composeFile([{ service: 'api', build: './api' }]),
      parsedFile('api/main.ts'),
      parsedFile('docs/readme-helper.ts'),
    ]);
    const artifact = c4Of(graph, 'component');
    const omission = artifact.omitted.find((entry) => entry.reason.includes('does not attribute them to a container'));
    expect(omission?.count).toBe(1);
    expect(artifact.nodes.some((node) => node.id === 'module:docs/readme-helper')).toBe(false);
  });
});

describe('C4 relationship integrity', () => {
  it('never emits a relationship with no graph fact behind it', () => {
    for (const level of ['context', 'container', 'component'] as const) {
      const artifact = c4Of(DEPLOYED_GRAPH, level);
      for (const edge of artifact.edges) {
        expect(hasGraphSupport(edge), `${level}: ${edge.id} must cite graph support`).toBe(true);
      }
    }
  });

  it('never emits a relationship whose endpoints are not in the same level', () => {
    for (const level of ['context', 'container', 'component'] as const) {
      const artifact = c4Of(DEPLOYED_GRAPH, level);
      const ids = new Set(artifact.nodes.map((node) => node.id));
      for (const edge of artifact.edges) {
        expect(ids.has(edge.source), `${level}: dangling source ${edge.id}`).toBe(true);
        expect(ids.has(edge.target), `${level}: dangling target ${edge.id}`).toBe(true);
      }
    }
  });

  it('reports what it dropped instead of drawing it', () => {
    const artifact = c4Of(DEPLOYED_GRAPH, 'container');
    const dropped = artifact.omitted.filter((entry) => entry.reason.includes('no graph fact justified'));
    for (const entry of dropped) expect(entry.count).toBeGreaterThan(0);
  });

  it('gives every element a graph node and a derivation', () => {
    for (const level of ['context', 'container', 'component'] as const) {
      const artifact = c4Of(DEPLOYED_GRAPH, level);
      for (const node of artifact.nodes) {
        expect(node.graphNodeIds?.length, `${level}: ${node.id} must name its graph node`).toBeGreaterThan(0);
        expect(node.derivation?.length ?? 0, `${level}: ${node.id} must state its rule`).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for the same graph', () => {
    const first = c4Of(DEPLOYED_GRAPH, 'container');
    const second = c4Of(graphFrom([
      composeFile([
        { service: 'api', image: 'repo/api:1', build: './api' },
        { service: 'worker', image: 'repo/worker:1', build: './worker' },
        { service: 'cache', image: 'redis:7-alpine' },
      ]),
      parsedFile('api/main.ts', {
        imports: [{ specifier: '../worker/jobs.js', names: ['runJob'], kind: 'static', line: 1, isExternal: false }],
      }),
      parsedFile('api/routes/health.ts'),
      parsedFile('worker/jobs.ts'),
    ]), 'container');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('drops a container relationship when its supporting edge is removed from the graph', () => {
    // Cross-artifact consistency: the projection has no independent truth source.
    const withImport = c4Of(DEPLOYED_GRAPH, 'container');
    expect(withImport.edges.some((edge) => edge.kind === 'depends_on')).toBe(true);

    const withoutImport = graphFrom([
      composeFile([
        { service: 'api', image: 'repo/api:1', build: './api' },
        { service: 'worker', image: 'repo/worker:1', build: './worker' },
      ]),
      parsedFile('api/main.ts'),
      parsedFile('worker/jobs.ts'),
    ]);
    expect(c4Of(withoutImport, 'container').edges.some((edge) => edge.kind === 'depends_on')).toBe(false);
  });

  it('drops a component when the graph no longer attributes its module to a container', () => {
    const stripped = graphFrom([parsedFile('api/main.ts'), parsedFile('worker/jobs.ts')]);
    expect(c4Of(stripped, 'component').nodes).toHaveLength(0);
  });
});

describe('C4 helpers and registration', () => {
  it('recognises datastore and broker families, and nothing else', () => {
    const image = (value: string) => detectInfrastructureFamily({ id: 'x', kind: 'deployment_component', name: 'svc', attributes: { image: value }, evidence: [], confidence: 'EXPLICIT' });
    expect(image('postgres:16')?.family).toBe('postgres');
    expect(image('docker.io/library/mongo:latest')?.family).toBe('mongodb');
    expect(image('bitnami/kafka:3.7')?.family).toBe('kafka');
    expect(image('node:22-alpine')).toBeNull();
    expect(image('repo/api:1')).toBeNull();
  });

  it('takes the weakest confidence when several facts support one relationship', () => {
    expect(weakestConfidence(['EXPLICIT', 'STRONGLY_INFERRED'])).toBe('STRONGLY_INFERRED');
    expect(weakestConfidence(['STRONGLY_INFERRED', 'WEEKLY_INFERRED'])).toBe('WEEKLY_INFERRED');
    expect(weakestConfidence(['EXPLICIT', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(weakestConfidence([])).toBe('UNKNOWN');
  });

  it('registers all three levels so the API and UI can reach them', () => {
    const kinds = ARTIFACTS.map((artifact) => artifact.kind);
    expect(kinds).toContain('c4-context');
    expect(kinds).toContain('c4-container');
    expect(kinds).toContain('c4-component');
    for (const kind of ['c4-context', 'c4-container', 'c4-component']) {
      const artifact = buildArtifact(DEPLOYED_GRAPH, kind);
      expect(artifact?.title).toContain('C4');
    }
  });

  it('produces C4 levels through the ordinary projection path', () => {
    const projection = projectAtlas(DEPLOYED_GRAPH);
    const container = projection.artifacts.find((artifact) => artifact.kind === 'c4-container');
    expect(container?.mermaid).toContain('flowchart');
    // Mermaid identifiers are sanitised, so the container appears as its label in a node.
    expect(container?.mermaid).toContain('n_deployment_component_api["api"]');
    expect(container?.mermaid).toContain('n_deployment_component_api --> n_deployment_component_worker');
  });
});
