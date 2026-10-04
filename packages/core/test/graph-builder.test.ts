import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  DiagnosticCollector,
  EvidenceStore,
  moduleNameFor,
  nodeId,
  resolveCallee,
  resolveImportPath,
  stripKnownExtension,
  type ParsedFile,
  type RepositoryRef,
} from '@repoatlas/core';

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

function build(files: ParsedFile[], commits: Parameters<typeof buildGraph>[0]['commits'] = []) {
  const diagnostics = new DiagnosticCollector();
  const evidence = new EvidenceStore({ maxExcerptChars: 200 });
  const result = buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits,
    headCommit: commits[0]?.hash ?? null,
    branch: 'main',
    evidence,
    diagnostics,
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: commits.length > 0,
  });
  return { ...result, diagnostics };
}

describe('module naming', () => {
  it('strips known extensions so a module matches its import specifier', () => {
    expect(moduleNameFor('src/services/report.ts')).toBe('src/services/report');
    expect(moduleNameFor('src/Panel.tsx')).toBe('src/Panel');
    expect(moduleNameFor('app/main.py')).toBe('app/main');
    expect(moduleNameFor('Makefile')).toBe('Makefile');
  });

  it('prefers the longest matching extension', () => {
    expect(stripKnownExtension('src/types.d.ts')).toBe('src/types');
  });
});

describe('import resolution', () => {
  const known = new Map([
    ['src/a.ts', 'module:src/a'],
    ['src/b.ts', 'module:src/b'],
    ['src/dir/index.ts', 'module:src/dir/index'],
    ['src/dir/package.json', 'module:src/dir/package'],
  ]);

  it('resolves an extensionless relative import', () => {
    expect(resolveImportPath('./b', 'src/a.ts', known)).toBe('src/b.ts');
    expect(resolveImportPath('./b.js', 'src/a.ts', known)).toBe('src/b.ts');
  });

  it('resolves a parent-relative import', () => {
    // From src/dir/x.ts, `../b` is src/b. `known` contains no src/dir/b.ts, so a
    // sibling-relative specifier must resolve to null rather than guess.
    expect(resolveImportPath('../b', 'src/dir/x.ts', known)).toBe('src/b.ts');
    expect(resolveImportPath('./b', 'src/dir/x.ts', known)).toBeNull();
  });

  it('resolves a directory index import', () => {
    expect(resolveImportPath('./dir', 'src/a.ts', known)).toBe('src/dir/index.ts');
  });

  it('returns null for a bare specifier and for an unresolvable path', () => {
    expect(resolveImportPath('express', 'src/a.ts', known)).toBeNull();
    expect(resolveImportPath('./missing', 'src/a.ts', known)).toBeNull();
  });
});

describe('callee resolution', () => {
  const index = new Map([
    ['ReportService', { id: 'class:reportservice', filePath: 'a.ts', kind: 'class' as const, qualifiedName: 'ReportService' }],
    ['findById', { id: 'function:findbyid', filePath: 'a.ts', kind: 'function' as const, qualifiedName: 'findById' }],
  ]);

  it('prefers the full dotted name, then the member, then the root', () => {
    expect(resolveCallee('ReportService', index)?.id).toBe('class:reportservice');
    expect(resolveCallee('service.findById', index)?.id).toBe('function:findbyid');
  });

  it('returns undefined for an unknown callee', () => {
    expect(resolveCallee('somethingElse', index)).toBeUndefined();
  });
});

describe('graph construction', () => {
  it('creates a repository, a module per file and explicit containment', () => {
    const { graph } = build([parsedFile('src/a.ts')]);
    expect(graph.nodes.find((node) => node.kind === 'repository')?.name).toBe('repo');
    expect(graph.nodes.find((node) => node.id === nodeId('module', 'src/a'))).toBeDefined();

    const contains = graph.edges.find((edge) => edge.kind === 'contains');
    expect(contains?.confidence).toBe('EXPLICIT');
  });

  it('cites the declaring file for every module and entity', () => {
    const { graph } = build([parsedFile('src/a.ts')]);
    for (const node of graph.nodes) {
      expect(node.evidence.length).toBeGreaterThan(0);
      for (const ref of node.evidence) {
        expect(graph.evidence.some((item) => item.id === ref.evidenceId)).toBe(true);
      }
    }
  });

  it('links an internal import as an explicit imports edge', () => {
    const { graph, counters } = build([
      parsedFile('src/a.ts', {
        imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 1, isExternal: false }],
      }),
      parsedFile('src/b.ts'),
    ]);

    const edge = graph.edges.find((item) => item.kind === 'imports');
    expect(edge?.from).toBe(nodeId('module', 'src/a'));
    expect(edge?.to).toBe(nodeId('module', 'src/b'));
    expect(edge?.confidence).toBe('EXPLICIT');
    expect(edge?.label).toBe('B');
    expect(counters.resolvedInternalImports).toBe(1);
  });

  it('records an external dependency as a package node', () => {
    const { graph } = build([
      parsedFile('src/a.ts', {
        imports: [{ specifier: 'express', names: ['default'], kind: 'static', line: 1, isExternal: true }],
      }),
    ]);
    const dependency = graph.nodes.find((node) => node.kind === 'package' && node.name === 'express');
    expect(dependency).toBeDefined();
    expect(graph.edges.some((edge) => edge.kind === 'depends_on' && edge.to === dependency?.id)).toBe(true);
  });

  it('resolves an inheritance relationship regardless of file order', () => {
    // The base class is declared in the *second* file: a single-pass index would miss it.
    const { graph } = build([
      parsedFile('src/child.ts', {
        entities: [
          {
            kind: 'class',
            name: 'Child',
            qualifiedName: 'Child',
            startLine: 1,
            endLine: 3,
            language: 'typescript',
            extendsFrom: ['Base'],
          },
        ],
      }),
      parsedFile('src/base.ts', {
        entities: [
          {
            kind: 'class',
            name: 'Base',
            qualifiedName: 'Base',
            startLine: 1,
            endLine: 3,
            language: 'typescript',
          },
        ],
      }),
    ]);

    const edge = graph.edges.find((item) => item.kind === 'extends');
    expect(edge?.from).toBe(nodeId('class', 'Child'));
    expect(edge?.to).toBe(nodeId('class', 'Base'));
    // The heritage clause is explicit; the symbol resolution is not.
    expect(edge?.confidence).toBe('STRONGLY_INFERRED');
  });

  it('refuses to link inheritance to a non-type symbol', () => {
    const { graph } = build([
      parsedFile('src/a.ts', {
        entities: [
          {
            kind: 'class',
            name: 'Child',
            qualifiedName: 'Child',
            startLine: 1,
            endLine: 2,
            language: 'typescript',
            extendsFrom: ['helper'],
          },
          {
            kind: 'function',
            name: 'helper',
            qualifiedName: 'helper',
            startLine: 4,
            endLine: 5,
            language: 'typescript',
          },
        ],
      }),
    ]);
    expect(graph.edges.some((edge) => edge.kind === 'extends')).toBe(false);
  });

  it('records a call as a strong inference when the caller is known', () => {
    const { graph, counters } = build([
      parsedFile('src/a.ts', {
        entities: [
          {
            kind: 'function',
            name: 'handler',
            qualifiedName: 'handler',
            startLine: 1,
            endLine: 5,
            language: 'typescript',
          },
          {
            kind: 'function',
            name: 'compute',
            qualifiedName: 'compute',
            startLine: 7,
            endLine: 9,
            language: 'typescript',
          },
        ],
        calls: [{ callee: 'compute', line: 2, fromQualifiedName: 'handler', isLocalIdentifier: true }],
      }),
    ]);

    const edge = graph.edges.find((item) => item.kind === 'calls');
    expect(edge?.from).toBe(nodeId('function', 'handler'));
    expect(edge?.to).toBe(nodeId('function', 'compute'));
    expect(edge?.confidence).toBe('STRONGLY_INFERRED');
    expect(counters.resolvedCalls).toBe(1);
  });

  it('does not create a self-call edge', () => {
    const { graph } = build([
      parsedFile('src/a.ts', {
        entities: [
          {
            kind: 'function',
            name: 'recurse',
            qualifiedName: 'recurse',
            startLine: 1,
            endLine: 3,
            language: 'typescript',
          },
        ],
        calls: [{ callee: 'recurse', line: 2, fromQualifiedName: 'recurse', isLocalIdentifier: true }],
      }),
    ]);
    expect(graph.edges.some((edge) => edge.kind === 'calls')).toBe(false);
  });

  it('projects an HTTP route into an endpoint node exposed by its module', () => {
    const { graph, counters } = build([
      parsedFile('src/routes.ts', {
        markers: [
          {
            name: 'http.route',
            line: 4,
            attributes: { httpMethod: 'GET', path: '/api/reports/:id', handler: 'handler' },
          },
        ],
      }),
    ]);

    const endpoint = graph.nodes.find((node) => node.kind === 'api_endpoint');
    expect(endpoint?.name).toBe('GET /api/reports/:id');
    expect(endpoint?.attributes?.route).toBe('/api/reports/:id');
    expect(graph.edges.some((edge) => edge.kind === 'exposes' && edge.to === endpoint?.id)).toBe(true);
    expect(counters.apiEndpoints).toBe(1);
  });

  it('projects SQL tables and columns', () => {
    const { graph, counters } = build([
      parsedFile('schema.sql', {
        language: 'sql',
        producer: 'config-scanner',
        markers: [
          { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 2 } },
          { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT' } },
          { name: 'schema.column', line: 3, attributes: { table: 'reports', column: 'title', dataType: 'TEXT' } },
        ],
      }),
    ]);

    expect(graph.nodes.find((node) => node.kind === 'table')?.name).toBe('reports');
    expect(graph.nodes.filter((node) => node.kind === 'column')).toHaveLength(2);
    expect(graph.edges.some((edge) => edge.kind === 'declares_schema')).toBe(true);
    expect(counters.tables).toBe(1);
  });

  it('records a declared manifest dependency separately from an import of it', () => {
    const { graph } = build([
      parsedFile('package.json', {
        language: 'json',
        producer: 'config-scanner',
        markers: [
          {
            name: 'manifest.dependency',
            line: 5,
            attributes: { dependency: 'express', section: 'dependencies', range: '^4.19.2' },
          },
        ],
      }),
    ]);

    const dependency = graph.nodes.find((node) => node.kind === 'package' && node.name === 'express');
    expect(dependency?.attributes?.range).toBe('^4.19.2');
    const edge = graph.edges.find((item) => item.kind === 'depends_on' && item.to === dependency?.id);
    expect(edge?.attributes?.declared).toBe(true);
  });

  it('builds contributor, commit and modification relationships from history', () => {
    const { graph, counters } = build([parsedFile('src/a.ts')], [
      {
        hash: 'abc123',
        shortHash: 'abc',
        authorName: 'Dev',
        authorEmail: 'dev@example.com',
        timestamp: '2026-01-01T00:00:00Z',
        subject: 'Initial commit',
        files: ['src/a.ts'],
      },
    ]);

    expect(graph.nodes.find((node) => node.kind === 'contributor')?.name).toBe('Dev');
    expect(graph.nodes.find((node) => node.kind === 'commit')?.name).toBe('abc');
    expect(graph.edges.some((edge) => edge.kind === 'authored_by')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'modifies' && edge.to === nodeId('module', 'src/a'))).toBe(true);
    expect(counters.contributors).toBe(1);
  });

  it('produces an empty but valid graph for an empty repository', () => {
    const { graph, counters } = build([]);
    expect(graph.nodes).toHaveLength(1); // the repository itself
    expect(graph.edges).toHaveLength(0);
    expect(counters.files).toBe(0);
  });

  it('is deterministic: the same input yields the same ids and counts', () => {
    const files = [
      parsedFile('src/a.ts', {
        imports: [{ specifier: './b.js', names: [], kind: 'static', line: 1, isExternal: false }],
      }),
      parsedFile('src/b.ts'),
    ];
    const first = build(files);
    const second = build(files);
    expect(first.graph.nodes.map((node) => node.id).sort()).toEqual(second.graph.nodes.map((node) => node.id).sort());
    expect(first.counters).toEqual(second.counters);
  });

  it('respects the node limit and reports truncation', () => {
    const diagnostics = new DiagnosticCollector();
    const evidence = new EvidenceStore({ maxExcerptChars: 100 });
    const many = Array.from({ length: 10 }, (_, i) => parsedFile(`src/f${i}.ts`));
    const result = buildGraph({
      repository: REPOSITORY,
      files: many.map((file) => ({ path: file.path, byteSize: 10, language: 'typescript', analyzable: true })),
      parsed: many,
      commits: [],
      headCommit: null,
      branch: null,
      evidence,
      diagnostics,
      limits: { maxNodes: 3, maxEdges: 100 },
      includeGitHistory: false,
    });

    expect(result.truncated).toBe(true);
    expect(result.graph.nodes.length).toBeLessThanOrEqual(3);
    expect(diagnostics.list().some((item) => item.code === 'NODE_LIMIT_REACHED')).toBe(true);
  });
});

describe('deployment attribution', () => {
  const compose = (service: string, extra: Record<string, string | null>) =>
    parsedFile('docker-compose.yml', {
      language: 'yaml',
      producer: 'config-scanner',
      markers: [
        {
          name: 'compose.service',
          line: 3,
          attributes: { service, image: 'repo/service:latest', build: null, publishedPorts: '', ...extra },
        },
      ],
    });

  it('links the declaring file to the service it declares, as an explicit fact', () => {
    const { graph } = build([compose('api', { build: null })]);
    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    expect(component?.name).toBe('api');
    const declares = graph.edges.find((edge) => edge.kind === 'deploys' && edge.to === component?.id);
    expect(declares?.from).toBe('module:docker-compose');
    expect(declares?.confidence).toBe('EXPLICIT');
  });

  it('attributes modules inside a declared build context to that container', () => {
    const { graph } = build([
      compose('api', { build: './api' }),
      parsedFile('api/main.ts'),
      parsedFile('api/routes/health.ts'),
      parsedFile('web/main.ts'),
    ]);

    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    const attributed = graph.edges.filter((edge) => edge.kind === 'deploys' && edge.to === component?.id).map((edge) => edge.from);
    expect(attributed).toContain('module:api/main');
    expect(attributed).toContain('module:api/routes/health');
    expect(attributed).not.toContain('module:web/main');

    const inferred = graph.edges.find((edge) => edge.from === 'module:api/main' && edge.kind === 'deploys');
    // The build context states what is sent to the builder, not what is copied, so the
    // relationship is an inference and is labelled as one.
    expect(inferred?.confidence).toBe('STRONGLY_INFERRED');
    expect(inferred?.attributes?.derivedFrom).toBe('compose.build_context');
    expect(inferred?.attributes?.caveat).toContain('not what the Dockerfile copies');
    expect(inferred?.evidence[0]?.path).toBe('docker-compose.yml');
  });

  it('resolves a build context relative to the file that declares it', () => {
    const { graph } = build([
      parsedFile('deploy/compose.yml', {
        language: 'yaml',
        producer: 'config-scanner',
        markers: [
          {
            name: 'compose.service',
            line: 2,
            attributes: { service: 'worker', image: 'repo/worker', build: '../services/worker', publishedPorts: '' },
          },
        ],
      }),
      parsedFile('services/worker/main.ts'),
      parsedFile('services/api/main.ts'),
    ]);

    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    const attributed = graph.edges.filter((edge) => edge.kind === 'deploys' && edge.to === component?.id).map((edge) => edge.from);
    expect(attributed).toContain('module:services/worker/main');
    expect(attributed).not.toContain('module:services/api/main');
  });

  it('ignores a build context that points outside the analysed repository', () => {
    // The context is attacker-controlled text. Honouring `../..` would mean attributing code
    // this analysis never read.
    const { graph } = build([compose('api', { build: '../..' }), parsedFile('src/a.ts')]);
    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    const attributed = graph.edges.filter((edge) => edge.kind === 'deploys' && edge.to === component?.id);
    expect(attributed.map((edge) => edge.from)).toEqual(['module:docker-compose']);
  });

  it('ignores an absolute build context', () => {
    const { graph } = build([compose('api', { build: '/etc' }), parsedFile('src/a.ts')]);
    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    const attributed = graph.edges.filter((edge) => edge.kind === 'deploys' && edge.to === component?.id);
    expect(attributed.map((edge) => edge.from)).toEqual(['module:docker-compose']);
  });

  it('does not downgrade the explicit declaration edge when the context covers it', () => {
    // The compose file lives in its own build context. Re-adding the edge would merge and
    // downgrade it, understating a fact the repository states directly.
    const { graph } = build([compose('api', { build: '.' }), parsedFile('src/a.ts')]);
    const declares = graph.edges.find((edge) => edge.kind === 'deploys' && edge.from === 'module:docker-compose');
    expect(declares?.confidence).toBe('EXPLICIT');
  });

  it('attributes nothing when the service declares only an image', () => {
    const { graph } = build([compose('db', { build: null, image: 'postgres:16' }), parsedFile('src/a.ts')]);
    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    const attributed = graph.edges.filter((edge) => edge.kind === 'deploys' && edge.to === component?.id);
    expect(attributed.map((edge) => edge.from)).toEqual(['module:docker-compose']);
  });

  it('creates no component for an exposed port, which states no unit', () => {
    // `EXPOSE 4300` previously produced a deployment component literally named "unknown".
    const { graph } = build([
      parsedFile('Dockerfile', {
        language: 'dockerfile',
        producer: 'config-scanner',
        markers: [{ name: 'docker.expose', line: 3, attributes: { ports: '4300' } }],
      }),
    ]);
    expect(graph.nodes.filter((node) => node.kind === 'deployment_component')).toHaveLength(0);
    expect(graph.nodes.some((node) => node.name === 'unknown')).toBe(false);
  });

  it('marks a base image as built-from rather than as a declared service', () => {
    const { graph } = build([
      parsedFile('Dockerfile', {
        language: 'dockerfile',
        producer: 'config-scanner',
        markers: [
          { name: 'docker.base_image', line: 1, attributes: { image: 'node:24-bookworm-slim', stage: 'deps' } },
          { name: 'docker.base_image', line: 9, attributes: { image: 'node:24-bookworm-slim', stage: 'runtime' } },
        ],
      }),
    ]);

    const base = graph.nodes.find((node) => node.kind === 'deployment_component');
    expect(base?.name).toBe('node:24-bookworm-slim');
    expect(base?.attributes?.declaredAs).toBe('base_image');
    // Both stages cite the image, and a base image says nothing about which source is inside
    // the image built from it, so no module is attributed to it.
    expect(base?.evidence).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.kind === 'deploys' && edge.from.startsWith('module:'))).toHaveLength(1);
  });

  it('marks a compose service as declared-as-service', () => {
    const { graph } = build([compose('api', { build: './api' }), parsedFile('api/main.ts')]);
    const component = graph.nodes.find((node) => node.kind === 'deployment_component');
    expect(component?.attributes?.declaredAs).toBe('service');
  });
});

describe('module content digests', () => {
  it('records the digest supplied for a file so a rename can be proved later', () => {
    const evidence = new EvidenceStore({ maxExcerptChars: 100 });
    const result = buildGraph({
      repository: REPOSITORY,
      files: [{ path: 'src/a.ts', byteSize: 10, language: 'typescript', analyzable: true }],
      parsed: [parsedFile('src/a.ts')],
      commits: [],
      headCommit: null,
      branch: null,
      evidence,
      diagnostics: new DiagnosticCollector(),
      limits: { maxNodes: 100, maxEdges: 100 },
      includeGitHistory: false,
      digestByPath: new Map([['src/a.ts', 'abc123']]),
    });
    expect(result.graph.nodes.find((node) => node.id === 'module:src/a')?.digest).toBe('abc123');
  });

  it('omits the digest entirely when ingestion supplied none', () => {
    const { graph } = build([parsedFile('src/a.ts')]);
    expect(graph.nodes.find((node) => node.id === 'module:src/a')?.digest).toBeUndefined();
  });
});

describe('test attribution', () => {
  const fn = (name: string, kind: 'function' | 'test' = 'function') => ({
    kind,
    name,
    qualifiedName: name,
    startLine: 1,
    endLine: 4,
    language: 'typescript',
  });

  it('links a test that calls a route handler to the endpoint that route serves', () => {
    const { graph } = build([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
      parsedFile('test/routes.test.ts', {
        entities: [fn('lists', 'test')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'lists', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    const tests = graph.edges.filter((edge) => edge.kind === 'tests');
    expect(tests).toHaveLength(1);
    expect(tests[0]?.from).toBe('test:lists');
    expect(tests[0]?.to).toBe('api_endpoint:get-/api/reports');
    // The call exists; that the test *covers the endpoint* is an inference about intent.
    expect(tests[0]?.confidence).toBe('STRONGLY_INFERRED');
    expect(tests[0]?.evidence.length).toBeGreaterThan(0);
  });

  it('links a function in a test file that calls a handler', () => {
    const { graph } = build([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
      parsedFile('test/routes.spec.ts', {
        entities: [fn('exercisesHandler')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'exercisesHandler', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    expect(graph.edges.filter((edge) => edge.kind === 'tests')).toHaveLength(1);
  });

  it('does not claim a test for a handler reached only through a helper', () => {
    // One hop only. Walking the chain would attribute the test to every endpoint the helper
    // could reach, which is a guess.
    const { graph } = build([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
      parsedFile('src/client.ts', {
        entities: [fn('sendRequest')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'sendRequest', isLocalIdentifier: true, argCount: 0 }],
      }),
      parsedFile('test/api.test.ts', {
        entities: [fn('usesClient', 'test')],
        calls: [{ callee: 'sendRequest', line: 2, fromQualifiedName: 'usesClient', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    expect(graph.edges.filter((edge) => edge.kind === 'tests')).toHaveLength(0);
  });

  it('does not claim a test when the route names no handler', () => {
    const { graph } = build([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports' } }],
      }),
      parsedFile('test/routes.test.ts', {
        entities: [fn('lists', 'test')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'lists', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    expect(graph.edges.filter((edge) => edge.kind === 'tests')).toHaveLength(0);
  });

  it('does not treat a production function as a test just because it calls a handler', () => {
    const { graph } = build([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
      parsedFile('src/warmup.ts', {
        entities: [fn('warmUp')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'warmUp', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    expect(graph.edges.filter((edge) => edge.kind === 'tests')).toHaveLength(0);
  });
});describe('data access from SQL in code', () => {
  const queryMarker = (table: string, operation: 'read' | 'write', role: string, scope = 'loadAll') => ({
    name: 'sql.query',
    line: 3,
    attributes: { table, operation, role, statement: 'select users, orders', scope },
  });

  const entity = (name: string) => ({
    kind: 'function' as const,
    name,
    qualifiedName: name,
    startLine: 1,
    endLine: 6,
    language: 'typescript',
  });

  const service = (markers: unknown[]) =>
    parsedFile('src/service.ts', { entities: [entity('loadAll')], markers: markers as never });

  const edgesTo = (markers: unknown[], table: string) =>
    build([service(markers)]).graph.edges.filter(
      (edge) => (edge.kind === 'reads' || edge.kind === 'writes') && edge.to === nodeId('table', table),
    );

  it('creates one relationship per table in a join, each with its role', () => {
    const markers = [queryMarker('users', 'read', 'from'), queryMarker('orders', 'read', 'join')];
    const graph = build([service(markers)]).graph;

    expect(edgesTo(markers, 'users')).toHaveLength(1);
    expect(edgesTo(markers, 'orders')).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.kind === 'reads')).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.to === nodeId('table', 'orders'))?.attributes?.role).toBe('join');
  });

  it('keeps a read and a write of the same table as separate relationships', () => {
    // The exact shape of `INSERT INTO archive SELECT * FROM reports`. Collapsing these into one
    // edge would make an archive write look like a report write.
    const markers = [queryMarker('archive_reports', 'write', 'insert_into'), queryMarker('reports', 'read', 'from')];
    const graph = build([service(markers)]).graph;

    expect(graph.edges.find((edge) => edge.to === nodeId('table', 'archive_reports'))?.kind).toBe('writes');
    expect(graph.edges.find((edge) => edge.to === nodeId('table', 'reports'))?.kind).toBe('reads');
  });

  it('attributes the relationship to the enclosing function and cites the statement line', () => {
    const [edge] = build([service([queryMarker('users', 'read', 'from')])]).graph.edges.filter(
      (candidate) => candidate.kind === 'reads',
    );

    expect(edge?.from).toBe('function:loadall');
    expect(edge?.confidence).toBe('EXPLICIT');
    expect(edge?.evidence[0]?.startLine).toBe(3);
    expect(edge?.attributes?.statement).toBe('select users, orders');
  });

  it('marks a store as unknown schema when no DDL declares it, rather than inventing columns', () => {
    const graph = build([service([queryMarker('legacy_orders', 'read', 'from')])]).graph;
    const table = graph.nodes.find((node) => node.id === nodeId('table', 'legacy_orders'));

    expect(table?.attributes?.declaredInDdl).toBe(false);
    expect(table?.confidence).toBe('UNKNOWN');
  });

  it('records a CTE as a query result held by the function that defined it, never as a table', () => {
    const graph = build([
      service([
        queryMarker('orders', 'read', 'from'),
        { name: 'sql.cte', line: 3, attributes: { names: 'recent_orders', statement: 'select orders', scope: 'loadAll' } },
      ]),
    ]).graph;

    const cte = graph.nodes.find((node) => node.attributes?.queryExpression === true);
    expect(cte?.name).toBe('recent_orders');
    expect(graph.nodes.some((node) => node.kind === 'table' && node.name === 'recent_orders')).toBe(false);
    expect(graph.edges.find((edge) => edge.to === cte?.id)?.kind).toBe('produces');
  });

  it('records an unclassifiable statement as evidence with no data relationship', () => {
    const graph = build([
      service([
        {
          name: 'sql.statement',
          line: 3,
          attributes: {
            summary: 'merge statement',
            unsupported: 'a MERGE statement is not a data-access statement this analyser classifies',
            scope: 'loadAll',
          },
        },
      ]),
    ]).graph;

    expect(graph.edges.some((edge) => edge.kind === 'reads' || edge.kind === 'writes')).toBe(false);
    const statement = graph.nodes.find((node) => node.attributes?.unclassifiedStatement === true);
    expect(statement?.name).toBe('merge statement');
    expect(statement?.confidence).toBe('UNKNOWN');
    expect(String(statement?.attributes?.reason)).toContain('MERGE');
  });

  it('attaches an unscoped statement to the module and says the scope is unknown', () => {
    const graph = build([
      parsedFile('src/migrate.ts', {
        markers: [
          { name: 'sql.query', line: 2, attributes: { table: 'users', operation: 'read', role: 'from', statement: 'select users' } },
        ],
      }),
    ]).graph;

    const edge = graph.edges.find((candidate) => candidate.kind === 'reads');
    expect(edge?.from).toBe('module:src/migrate');
    expect(edge?.confidence).toBe('WEEKLY_INFERRED');
expect(edge?.attributes?.scopeUnknown).toBe(true);
  });
});

describe('return, throw and response relationships', () => {
  function functionEntity(name: string, line = 1) {
    return { kind: 'function' as const, name, qualifiedName: name, startLine: line, endLine: line + 2, language: 'typescript' };
  }

  it('links a direct return from the callee to the caller', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('load'), functionEntity('find')],
        calls: [{ callee: 'find', line: 2, fromQualifiedName: 'load', isLocalIdentifier: true }],
        returns: [{ line: 2, fromQualifiedName: 'load', kind: 'call', name: 'find', expression: 'find()' }],
      }),
    ]).graph;

    const returned = graph.edges.find((edge) => edge.kind === 'returns');
    expect(returned?.from).toBe('function:find');
    expect(returned?.to).toBe('function:load');
    expect(returned?.confidence).toBe('STRONGLY_INFERRED');
    expect(returned?.evidence[0]?.startLine).toBe(2);
  });

  it('marks a return through a binding as inferred, names the variable, and stays weaker', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('handler'), functionEntity('findAll')],
        bindings: [{ name: 'rows', callee: 'findAll', line: 4, awaited: true, fromQualifiedName: 'handler' }],
        returns: [{ line: 5, fromQualifiedName: 'handler', kind: 'identifier', name: 'rows', expression: 'rows' }],
      }),
    ]).graph;

    const returned = graph.edges.find((edge) => edge.kind === 'returns');
    expect(returned?.confidence).toBe('WEEKLY_INFERRED');
    expect(returned?.attributes?.inferred).toBe(true);
    expect(returned?.attributes?.via).toBe('rows');
    expect(returned?.attributes?.awaited).toBe(true);
    // Both the assignment and the return statement are cited, so a reader can check the chain.
    expect(returned?.evidence.map((item) => item.startLine)).toEqual([4, 5]);
  });

  it('creates no return when a returned variable has more than one binding', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('handler'), functionEntity('findAll'), functionEntity('findOther')],
        bindings: [
          { name: 'rows', callee: 'findAll', line: 4, fromQualifiedName: 'handler' },
          { name: 'rows', callee: 'findOther', line: 6, fromQualifiedName: 'handler' },
        ],
        returns: [{ line: 8, fromQualifiedName: 'handler', kind: 'identifier', name: 'rows', expression: 'rows' }],
      }),
    ]).graph;

    expect(graph.edges.some((edge) => edge.kind === 'returns')).toBe(false);
  });

  it('creates no return for a bare return', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('load')],
        returns: [{ line: 2, fromQualifiedName: 'load', kind: 'bare' }],
      }),
    ]).graph;

    expect(graph.edges.some((edge) => edge.kind === 'returns')).toBe(false);
    expect(graph.nodes.find((node) => node.id === 'function:load')?.attributes?.hasReturn).toBe(true);
  });

  it('links a throw from the callee to callers in other files', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('handler')],
        calls: [{ callee: 'load', line: 4, fromQualifiedName: 'handler', isLocalIdentifier: true }],
      }),
      parsedFile('src/b.ts', {
        entities: [functionEntity('load')],
        throws: [{ line: 2, fromQualifiedName: 'load', via: 'throw', expression: "new Error('boom')" }],
      }),
    ]).graph;

    const thrown = graph.edges.find((edge) => edge.kind === 'throws');
    expect(thrown?.from).toBe('function:load');
    expect(thrown?.to).toBe('function:handler');
    expect(thrown?.attributes?.via).toBe('throw');
    expect(graph.nodes.find((node) => node.id === 'function:load')?.attributes?.throwSites).toBe(1);
  });

  it('marks a rejection as a rejection rather than a synchronous throw', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('handler')],
        calls: [{ callee: 'load', line: 4, fromQualifiedName: 'handler', isLocalIdentifier: true }],
      }),
      parsedFile('src/b.ts', {
        entities: [{ ...functionEntity('load'), isAsync: true }],
        throws: [{ line: 2, fromQualifiedName: 'load', via: 'reject', inAsyncFunction: true, expression: 'new Error()' }],
      }),
    ]).graph;

    expect(graph.edges.find((edge) => edge.kind === 'throws')?.attributes?.rejects).toBe(true);
  });

  it('links a response written by a handler a route names to that endpoint', () => {
    const graph = build([
      parsedFile('src/routes.ts', {
        entities: [
          {
            ...functionEntity('GET /reports handler', 3),
            isAsync: true,
            attributes: { routeHandler: true, method: 'GET', path: '/reports' },
          },
        ],
        markers: [
          {
            name: 'http.route',
            line: 3,
            attributes: { httpMethod: 'GET', path: '/reports', handler: 'GET /reports handler' },
          },
          {
            name: 'http.response',
            line: 5,
            attributes: { scope: 'GET /reports handler', status: 201, method: 'json', payload: 'rows' },
          },
        ],
        responses: [{ line: 5, method: 'json', status: 201, payload: 'rows', payloadKind: 'identifier' }],
      }),
    ]).graph;

    const responded = graph.edges.find((edge) => edge.kind === 'returns');
    expect(responded?.from).toBe('function:get-/reports-handler');
    expect(responded?.to).toBe('api_endpoint:get-/reports');
    expect(responded?.attributes?.httpResponse).toBe(true);
    expect(responded?.attributes?.status).toBe(201);
    expect(responded?.evidence[0]?.startLine).toBe(5);
  });

  it('records a response from a function no route names without inventing an endpoint', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('load')],
        markers: [{ name: 'http.response', line: 3, attributes: { scope: 'load', method: 'json' } }],
        responses: [{ line: 3, method: 'json' }],
      }),
    ]).graph;

    expect(graph.edges.some((edge) => edge.kind === 'returns')).toBe(false);
    const load = graph.nodes.find((node) => node.id === 'function:load');
    expect(load?.attributes?.httpResponses).toBe(1);
    // No status was written, so none is claimed.
    expect(load?.attributes?.httpResponseStatuses).toBeUndefined();
  });

  it('records the statuses a function states, without repeating one', () => {
    const graph = build([
      parsedFile('src/a.ts', {
        entities: [functionEntity('load')],
        markers: [
          { name: 'http.response', line: 3, attributes: { scope: 'load', method: 'json', status: 200 } },
          { name: 'http.response', line: 4, attributes: { scope: 'load', method: 'json', status: 200 } },
          { name: 'http.response', line: 5, attributes: { scope: 'load', method: 'send', status: 404 } },
        ],
        responses: [
          { line: 3, method: 'json', status: 200 },
          { line: 4, method: 'json', status: 200 },
          { line: 5, method: 'send', status: 404 },
        ],
      }),
    ]).graph;

    const load = graph.nodes.find((node) => node.id === 'function:load');
    expect(load?.attributes?.httpResponses).toBe(3);
    expect(load?.attributes?.httpResponseStatuses).toBe('200,404');
  });
});
