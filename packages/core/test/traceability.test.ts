import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  DiagnosticCollector,
  EvidenceStore,
  traceAll,
  traceSubject,
  type ParsedFile,
  type RepositoryRef,
} from '@repoatlas/core';

/**
 * Traceability: requirement → use case → implementation → test.
 *
 * The tests concentrate on the joints that are easy to fake. A chain that looks complete but
 * cites nothing must fail, and a missing joint must be reported as missing rather than filled.
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

function graphOf(files: ParsedFile[]) {
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

const fn = (name: string, kind: 'function' | 'test' = 'function') => ({
  kind,
  name,
  qualifiedName: name,
  startLine: 1,
  endLine: 6,
  language: 'typescript',
});

/** Route → handler → service, a declared requirement, and a test that calls the handler. */
const FULL_GRAPH = graphOf([
  parsedFile('docs/requirements.md', {
    language: 'markdown',
    producer: 'config-scanner',
    markers: [
      {
        name: 'doc.requirement',
        line: 3,
        attributes: { statement: 'The system exposes GET /api/reports', identifier: 'REQ-001', implementsRef: 'handleList' },
      },
    ],
  }),
  parsedFile('src/routes.ts', {
    entities: [fn('handleList')],
    calls: [{ callee: 'findAll', line: 3, fromQualifiedName: 'handleList', isLocalIdentifier: true, argCount: 0 }],
    markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
  }),
  parsedFile('src/service.ts', {
    entities: [fn('findAll')],
    markers: [{ name: 'sql.query', line: 2, attributes: { operation: 'read', table: 'reports', scope: 'findAll' } }],
  }),
  parsedFile('test/routes.test.ts', {
    entities: [fn('lists reports', 'test')],
    calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'lists reports', isLocalIdentifier: true, argCount: 0 }],
  }),
]);

const ENDPOINT = 'api_endpoint:get-/api/reports';

describe('traceSubject', () => {
  it('walks requirement, use case, implementation and test for a fully traced entry point', () => {
    const trace = traceSubject(FULL_GRAPH, ENDPOINT)!;
    const roles = trace.links.map((link) => link.role);
    expect(roles).toContain('requirement');
    expect(roles).toContain('use_case');
    expect(roles).toContain('implementation');
    expect(roles).toContain('test');
    expect(trace.complete).toBe(true);
    expect(trace.summary).toContain('the chain is complete');
  });

  it('cites a relationship or evidence on every link', () => {
    const trace = traceSubject(FULL_GRAPH, ENDPOINT)!;
    for (const link of trace.links) {
      expect(link.edgeIds.length + link.evidence.length).toBeGreaterThan(0);
      expect(link.confidence).toMatch(/EXPLICIT|STRONGLY_INFERRED|WEEKLY_INFERRED|UNKNOWN/);
    }
  });

  it('names the handler as the implementation because the route names it', () => {
    const trace = traceSubject(FULL_GRAPH, ENDPOINT)!;
    const handler = trace.links.find((link) => link.role === 'implementation' && link.id === 'function:handlelist');
    expect(handler?.note).toContain('route registration');
  });

  it('records the test that calls the handler', () => {
    const trace = traceSubject(FULL_GRAPH, ENDPOINT)!;
    expect(trace.links.some((link) => link.role === 'test' && link.id === 'test:lists-reports')).toBe(true);
  });

  it('distinguishes a declared requirement from a derived one', () => {
    const trace = traceSubject(FULL_GRAPH, ENDPOINT)!;
    const notes = trace.links.filter((link) => link.role === 'requirement').map((link) => link.note);
    // Both are present: the document states one, and the code evidences interface behaviour.
    expect(notes).toContain('Stated by the repository.');
    expect(notes).toContain('Derived from the code.');
  });

  it('reports a missing test as a broken joint, not as a failed test', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
    ]);
    const trace = traceSubject(graph, ENDPOINT)!;
    expect(trace.complete).toBe(false);
    expect(trace.links.some((link) => link.role === 'test')).toBe(false);
    const brk = trace.breaks.find((item) => item.kind === 'NO_TEST');
    expect(brk?.reason).toContain('limit of the matching');
  });

  it('reports a missing implementation when nothing calls the subject', () => {
    const graph = graphOf([
      parsedFile('package.json', {
        language: 'json',
        producer: 'config-scanner',
        markers: [{ name: 'manifest.script', line: 2, attributes: { script: 'noop', command: 'node noop.js' } }],
      }),
    ]);
    // A manifest script is recorded as a configuration node; the use-case model names it a
    // cli_command. Either way it has no calls relationships, so no implementation exists.
    const script = graph.nodes.find((node) => node.kind === 'configuration')!;
    const trace = traceSubject(graph, script.id)!;
    expect(trace.breaks.some((item) => item.kind === 'NO_IMPLEMENTATION')).toBe(true);
    expect(trace.complete).toBe(false);
    // Nothing in the graph states a requirement for this script either, and that is said
    // plainly rather than filled in.
    expect(trace.breaks.find((item) => item.kind === 'NO_REQUIREMENT')?.reason).toContain('not a defect');
  });

  it('derives an interface requirement when the repository states none', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
    ]);
    const trace = traceSubject(graph, ENDPOINT)!;
    // A declared requirement is absent, but the code still evidences interface behaviour, and
    // the derived requirement says only that.
    expect(trace.links.some((link) => link.role === 'requirement')).toBe(true);
    expect(trace.links.every((link) => link.role !== 'requirement' || link.note !== 'Stated by the repository.')).toBe(true);
  });

  it('returns null for a subject the graph does not hold', () => {
    expect(traceSubject(FULL_GRAPH, 'function:nope')).toBeNull();
  });

  it('terminates on a cyclic call graph', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handle')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/loop', handler: 'handle' } }],
      }),
      parsedFile('src/a.ts', {
        entities: [fn('a')],
        calls: [{ callee: 'b', line: 2, fromQualifiedName: 'a', isLocalIdentifier: true, argCount: 0 }],
      }),
      parsedFile('src/b.ts', {
        entities: [fn('b')],
        calls: [{ callee: 'a', line: 2, fromQualifiedName: 'b', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);
    const trace = traceSubject(graph, 'api_endpoint:get-/loop')!;
    expect(trace.links.length).toBeGreaterThan(0);
    expect(trace.links.length).toBeLessThan(10);
  });

  it('answers which entry points reach an inner function', () => {
    const trace = traceSubject(FULL_GRAPH, 'function:findall')!;
    expect(trace.links.some((link) => link.role === 'use_case')).toBe(true);
    expect(trace.subject.name).toBe('findAll');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(traceSubject(FULL_GRAPH, ENDPOINT))).toBe(JSON.stringify(traceSubject(FULL_GRAPH, ENDPOINT)));
  });
});

describe('traceAll', () => {
  it('gives one row per entry point with the four chain counts', () => {
    const index = traceAll(FULL_GRAPH);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]).toMatchObject({
      subjectId: ENDPOINT,
      entryKind: 'api_endpoint',
      complete: true,
    });
    expect(index.rows[0]?.requirements).toBeGreaterThan(0);
    expect(index.rows[0]?.tests).toBe(1);
  });

  it('counts complete and incomplete chains', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handleList')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
      }),
      parsedFile('src/other.ts', {
        entities: [fn('other')],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'POST', path: '/api/other', handler: 'other' } }],
      }),
      parsedFile('test/routes.test.ts', {
        entities: [fn('lists reports', 'test')],
        calls: [{ callee: 'handleList', line: 2, fromQualifiedName: 'lists reports', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);
    const index = traceAll(graph);
    expect(index.totals.subjects).toBe(2);
    expect(index.totals.complete).toBe(1);
    expect(index.totals.incomplete).toBe(1);
  });

  it('is empty for a repository with no entry points', () => {
    const index = traceAll(graphOf([parsedFile('src/a.ts')]));
    expect(index.rows).toHaveLength(0);
    expect(index.totals).toEqual({ subjects: 0, complete: 0, incomplete: 0 });
  });
});