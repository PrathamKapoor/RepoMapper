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
    ['ReportService', { id: 'class:reportservice', filePath: 'a.ts', kind: 'class' as const }],
    ['findById', { id: 'function:findbyid', filePath: 'a.ts', kind: 'function' as const }],
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