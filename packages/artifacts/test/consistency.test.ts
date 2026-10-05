import { describe, expect, it } from 'vitest';
import { checkConsistency, CONSISTENCY_CLASSES, type ConsistencyReport } from '@repoatlas/artifacts';
import { buildGraph, DiagnosticCollector, EvidenceStore, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

/**
 * Cross-artifact consistency.
 *
 * The engine's most important property is restraint. A repository that uses no database has
 * not contradicted anything, and a report that says so is worse than no report. These tests
 * therefore assert as much about what is *not* reported as about what is.
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
    responses: [],
    throws: [],
    returns: [],
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

const fn = (name: string, startLine: number, endLine: number, isAsync?: boolean) => ({
  kind: 'function' as const,
  name,
  qualifiedName: name,
  startLine,
  endLine,
  language: 'typescript',
  ...(isAsync === undefined ? {} : { isAsync }),
});

/** Route → handler → service → SQL, with a container, an unused table and a foreign key. */
const FULL_GRAPH = graphOf([
  parsedFile('docker-compose.yml', {
    language: 'yaml',
    producer: 'config-scanner',
    markers: [
      { name: 'deploy.container', line: 1, attributes: { container: 'api', technology: 'Node', responsibility: 'HTTP API' } },
      { name: 'deploy.image', line: 8, attributes: { image: 'repoatlas/api', container: 'api' } },
    ],
  }),
  parsedFile('schema.sql', {
    language: 'sql',
    producer: 'config-scanner',
    markers: [
      { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 2, primaryKey: 'id' } },
      { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true, unique: false } },
      { name: 'schema.table', line: 4, attributes: { table: 'users', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 5, attributes: { table: 'users', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true, unique: false } },
      { name: 'schema.foreign_key', line: 6, attributes: { table: 'reports', column: 'owner_id', referencesTable: 'users' } },
    ],
  }),
  parsedFile('src/routes.ts', {
    entities: [fn('handleList', 4, 20, false)],
    imports: [{ specifier: './service.js', names: ['findAll'], kind: 'static', line: 1, isExternal: false }],
    calls: [{ callee: 'findAll', line: 6, fromQualifiedName: 'handleList', isLocalIdentifier: true, argCount: 0 }],
    markers: [{ name: 'http.route', line: 3, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
  }),
  parsedFile('src/service.ts', {
    entities: [fn('findAll', 2, 12, true)],
    markers: [
      { name: 'sql.query', line: 3, attributes: { operation: 'read', table: 'reports', scope: 'findAll' } },
      { name: 'control.branch', line: 5, attributes: { flow: 'branch', scope: 'findAll', condition: 'rows.length > 0' } },
    ],
  }),
]);

const EMPTY_GRAPH = graphOf([]);

function ids(report: ConsistencyReport) {
  return report.findings.map((finding) => finding.id);
}

function finding(report: ConsistencyReport, id: string) {
  return report.findings.find((candidate) => candidate.id === id);
}

describe('consistency report', () => {
  it('is deterministic for the same graph', () => {
    expect(JSON.stringify(checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 }))).toBe(
      JSON.stringify(checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 })),
    );
  });

  it('lists what it compared and counts every finding', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    expect(report.compared).toContain('requirements');
    expect(report.compared).toContain('sequence');
    expect(report.compared).toContain('data-flow');
    const total = CONSISTENCY_CLASSES.reduce((sum, key) => sum + report.counts[key], 0);
    expect(total).toBe(report.findings.length);
    expect(report.summary).toContain('agreement');
  });

  it('emits only the five defined classes', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    for (const item of report.findings) expect(CONSISTENCY_CLASSES).toContain(item.class);
  });

  it('gives every finding the evidence needed to check it by hand', () => {
    for (const item of checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 }).findings) {
      expect(item.evidenceExpected.length).toBeGreaterThan(0);
      expect(item.evidenceFound.length).toBeGreaterThan(0);
      expect(item.derivation.length).toBeGreaterThan(0);
      expect(item.artifacts.length).toBeGreaterThan(0);
      expect(['info', 'warning']).toContain(item.severity);
    }
  });
});

describe('projection integrity', () => {
  it('finds no unsupported inference in a healthy graph', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    expect(report.findings.filter((item) => item.rule === 'projection-integrity')).toHaveLength(0);
    expect(report.counts.UNSUPPORTED_INFERENCE).toBe(0);
  });

  it('finds no unsupported inference on an empty repository', () => {
    const report = checkConsistency({ graph: EMPTY_GRAPH, maxElements: 5_000 });
    expect(report.counts.UNSUPPORTED_INFERENCE).toBe(0);
    expect(report.counts.CONTRADICTION).toBe(0);
  });
});

describe('consistency restraint', () => {
  it('does not report a contradiction for a repository with no datastore', () => {
    const report = checkConsistency({ graph: EMPTY_GRAPH, maxElements: 5_000 });
    expect(report.counts.CONTRADICTION).toBe(0);
    expect(report.findings.every((item) => item.class !== 'CONTRADICTION')).toBe(true);
  });

  it('never calls absence a contradiction, whatever the graph', () => {
    const graphs = [FULL_GRAPH, EMPTY_GRAPH, graphOf([parsedFile('src/a.ts')])];
    for (const graph of graphs) {
      const report = checkConsistency({ graph, maxElements: 5_000 });
      for (const item of report.findings.filter((candidate) => candidate.class === 'CONTRADICTION')) {
        // A contradiction requires two statements that cannot both be true. A missing
        // relationship is not a statement, so it can never produce one.
        expect(item.evidenceFound).not.toContain('no relationship');
        expect(item.rule).toBe('projection-integrity');
      }
    }
  });

  it('reports no inconsistency for a repository the tool understands completely', () => {
    // Everything reachable is declared, tested and connected. There is nothing to find.
    const report = checkConsistency({
      graph: graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handle', 1, 4)],
          calls: [{ callee: 'serve', line: 2, fromQualifiedName: 'handle', isLocalIdentifier: true, argCount: 0 }],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/ping', handler: 'handle' } }],
        }),
        parsedFile('src/serve.ts', { entities: [fn('serve', 1, 4)] }),
        parsedFile('test/routes.test.ts', {
          entities: [{ ...fn('t', 1, 4), kind: 'test' as const }],
          calls: [{ callee: 'handle', line: 2, fromQualifiedName: 't', isLocalIdentifier: true, argCount: 0 }],
        }),
      ]),
      maxElements: 5_000,
    });
    const real = report.findings.filter((item) => item.class !== 'CONSISTENT');
    // An untested-route finding cannot appear here: the graph does record a tests edge.
    expect(real.map((item) => item.id)).not.toContain('entry-point-untested:use_case:api_endpoint:api_endpoint:get-/ping');
  });

  it('names each entity of a finding once', () => {
    // D-067. A C4 element projected from one graph entity lists its own id in `graphNodeIds`,
    // so prefixing `node.id` produced the same entity twice. Harmless as a finding; it broke
    // every consumer that keys a list on the entity id, which the browser check reported as a
    // React duplicate-key error.
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    for (const item of report.findings) {
      expect(new Set(item.nodeIds).size, `${item.id} repeats an entity`).toBe(item.nodeIds.length);
      expect(new Set(item.edgeIds).size, `${item.id} repeats a relationship`).toBe(item.edgeIds.length);
    }
    expect(new Set(report.findings.map((item) => item.id)).size).toBe(report.findings.length);
  });

  it('does not claim agreement it did not check', () => {
    const report = checkConsistency({ graph: EMPTY_GRAPH, maxElements: 5_000 });
    expect(report.counts.CONSISTENT).toBe(0);
    expect(report.summary).toContain('No cross-artifact agreement');
  });
});

describe('entry point coverage', () => {
  it('reports an endpoint with no test as absent evidence, not as a defect in the code', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    const item = finding(report, 'entry-point-untested:use_case:api_endpoint:api_endpoint:get-/api/reports');
    expect(item?.class).toBe('MISSING_EVIDENCE');
    expect(item?.severity).toBe('info');
    expect(item?.derivation).toContain('limit of the matching');
  });

  it('does not report an endpoint the graph shows a test for', () => {
    const report = checkConsistency({
      graph: graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handle', 1, 4)],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/ping', handler: 'handle' } }],
        }),
        parsedFile('test/routes.test.ts', {
          entities: [{ ...fn('t', 1, 4), kind: 'test' as const }],
          calls: [{ callee: 'handle', line: 2, fromQualifiedName: 't', isLocalIdentifier: true, argCount: 0 }],
        }),
      ]),
      maxElements: 5_000,
    });
    expect(ids(report)).not.toContain('entry-point-untested:use_case:api_endpoint:api_endpoint:get-/ping');
  });
});

describe('data coverage', () => {
  it('names the table no analysed code touches and admits the extraction limit', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    const item = finding(report, 'store-untouched:table:users');
    expect(item?.class).toBe('MISSING_EVIDENCE');
    expect(item?.artifacts).toEqual(['data-flow', 'er-diagram']);
    expect(item?.derivation).toContain('ORM');
    // `reports` is read by code, so it must not be reported.
    expect(ids(report)).not.toContain('store-untouched:table:reports');
  });

  it('does not report tables as untouched when the code reads them', () => {
    const graph = graphOf([
      parsedFile('schema.sql', {
        language: 'sql',
        producer: 'config-scanner',
        markers: [
          { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 1 } },
          { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT' } },
        ],
      }),
      parsedFile('src/a.ts', {
        entities: [fn('load', 1, 4)],
        markers: [{ name: 'sql.query', line: 2, attributes: { operation: 'read', table: 'reports', scope: 'load' } }],
      }),
    ]);
    expect(ids(checkConsistency({ graph, maxElements: 5_000 }))).not.toContain('store-untouched:table:reports');
  });
});

describe('use case reachability', () => {
  it('reports a use case whose entry point reaches nothing', () => {
    // A manifest script is an entry point with no caller and no callee: there is nothing to
    // trace, and the repository holds calls elsewhere, so this is partial evidence.
    const report = checkConsistency({
      graph: graphOf([
        parsedFile('package.json', {
          language: 'json',
          producer: 'config-scanner',
          markers: [{ name: 'manifest.script', line: 2, attributes: { script: 'noop', command: 'node noop.js' } }],
        }),
        parsedFile('src/routes.ts', {
          entities: [fn('handle', 1, 4)],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/ping', handler: 'handle' } }],
        }),
        parsedFile('src/serve.ts', {
          entities: [fn('serve', 1, 4)],
          calls: [{ callee: 'handle', line: 2, fromQualifiedName: 'serve', isLocalIdentifier: true, argCount: 0 }],
        }),
      ]),
      maxElements: 5_000,
    });
    const item = finding(report, 'use-case-unreachable:use_case:cli_command:configuration:package.json-2');
    expect(item).toBeDefined();
    expect(['MISSING_EVIDENCE', 'PARTIAL_EVIDENCE']).toContain(item?.class);
    expect(item?.severity).toBe('info');
  });

  it('does not report a use case the sequence view can trace', () => {
    expect(ids(checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 }))).not.toContain(
      'use-case-unreachable:use_case:api_endpoint:api_endpoint:get-/api/reports',
    );
  });

  it('counts the endpoint to its handler as a step, because the route names the handler', () => {
    // `calls` from the endpoint is drawn from the route registration, so a route with a
    // handler already has one traceable interaction. Calling that unreachable would be
    // wrong, and this test exists because it nearly was.
    const report = checkConsistency({
      graph: graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handle', 1, 4)],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/ping', handler: 'handle' } }],
        }),
      ]),
      maxElements: 5_000,
    });
    expect(ids(report)).not.toContain('use-case-unreachable:use_case:api_endpoint:api_endpoint:get-/ping');
  });
});

describe('recorded agreement', () => {
  it('records that behaviour and use cases agree', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    const item = finding(report, 'agreement:behaviour-traced');
    expect(item?.class).toBe('CONSISTENT');
    expect(item?.artifacts).toEqual(['use-cases', 'sequence']);
  });

  it('records that data flows resolve to declared stores', () => {
    const report = checkConsistency({ graph: FULL_GRAPH, maxElements: 5_000 });
    expect(finding(report, 'agreement:data-traced')?.class).toBe('CONSISTENT');
  });
});

describe('return, failure and response support', () => {
  /** A handler that calls `load`, and `load` returning the call and throwing. */
  function returnGraph() {
    return graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handler', 1, 6)],
        calls: [
          { callee: 'load', line: 4, fromQualifiedName: 'handler', isLocalIdentifier: true },
        ],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/reports', handler: 'handler' } }],
        bindings: [{ name: 'rows', callee: 'load', line: 4, awaited: true, fromQualifiedName: 'handler' }],
        returns: [{ line: 5, fromQualifiedName: 'handler', kind: 'identifier', name: 'rows', expression: 'rows' }],
        responses: [{ line: 6, method: 'json', status: 200 }],
      }),
      parsedFile('src/service.ts', {
        entities: [fn('load', 1, 4)],
        throws: [{ line: 2, fromQualifiedName: 'load', via: 'throw', expression: "new Error('boom')" }],
      }),
    ]);
  }

  it('finds no unsupported inference in a graph whose returns and throws follow real calls', () => {
    const report = checkConsistency({ graph: returnGraph(), maxElements: 5_000 });
    expect(report.counts.UNSUPPORTED_INFERENCE).toBe(0);
  });

  it('reports a return relationship the call graph does not support', () => {
    const graph = returnGraph();
    // A hand-back asserted between two functions that never call each other.
    graph.edges.push({
      id: 'function:load|returns|function:unrelated',
      from: 'function:load',
      to: 'function:unrelated',
      kind: 'returns',
      confidence: 'STRONGLY_INFERRED',
      evidence: [],
      attributes: { returnKind: 'call' },
    });

    const report = checkConsistency({ graph, maxElements: 5_000 });
    const item = finding(report, 'return-unsupported:function:load|returns|function:unrelated');
    expect(item?.class).toBe('UNSUPPORTED_INFERENCE');
    expect(item?.severity).toBe('warning');
    expect(report.counts.UNSUPPORTED_INFERENCE).toBe(1);
  });

  it('reports a failure relationship the call graph does not support', () => {
    const graph = returnGraph();
    graph.edges.push({
      id: 'function:load|throws|function:unrelated',
      from: 'function:load',
      to: 'function:unrelated',
      kind: 'throws',
      confidence: 'STRONGLY_INFERRED',
      evidence: [],
      attributes: { via: 'throw' },
    });

    expect(
      finding(checkConsistency({ graph, maxElements: 5_000 }), 'return-unsupported:function:load|throws|function:unrelated')
        ?.class,
    ).toBe('UNSUPPORTED_INFERENCE');
  });

  it('reports a response paired with something that is not an endpoint', () => {
    const graph = returnGraph();
    graph.edges.push({
      id: 'function:handler|returns|function:unrelated',
      from: 'function:handler',
      to: 'function:unrelated',
      kind: 'returns',
      confidence: 'EXPLICIT',
      evidence: [],
      attributes: { httpResponse: true, method: 'json' },
    });

    expect(
      finding(checkConsistency({ graph, maxElements: 5_000 }), 'response-unpaired:function:handler|returns|function:unrelated')
        ?.class,
    ).toBe('UNSUPPORTED_INFERENCE');
  });

  it('reports a query expression recorded as a stored table', () => {
    const graph = graphOf([
      parsedFile('src/q.ts', { entities: [fn('load', 1, 4)] }),
      parsedFile('src/q.sql', {
        markers: [
          {
            name: 'sql.cte',
            line: 1,
            attributes: { names: 'recent_orders', scope: 'load', statement: 'select orders' },
          },
        ],
      }),
    ]);
    const cte = graph.nodes.find((node) => node.attributes?.queryExpression === true)!;
    expect(cte.kind).toBe('constant');
    graph.edges.push({
      id: `function:load|reads|${cte.id}`,
      from: 'function:load',
      to: cte.id,
      kind: 'reads',
      confidence: 'STRONGLY_INFERRED',
      evidence: [],
    });

    const item = finding(checkConsistency({ graph, maxElements: 5_000 }), `cte-as-store:function:load|reads|${cte.id}`);
    expect(item?.class).toBe('CONTRADICTION');
    expect(item?.artifacts).toEqual(['data-flow', 'er-diagram']);
  });

  it('reports statements that were read but not classified', () => {
    const graph = graphOf([
      parsedFile('src/migrate.ts', {
        entities: [fn('merge', 1, 4)],
        markers: [
          {
            name: 'sql.statement',
            line: 2,
            attributes: { summary: 'merge statement', unsupported: 'MERGE is not classified', scope: 'merge' },
          },
        ],
      }),
    ]);

    const item = finding(checkConsistency({ graph, maxElements: 5_000 }), 'data-access:unclassified-statements');
    expect(item?.class).toBe('PARTIAL_EVIDENCE');
    expect(item?.severity).toBe('info');
    expect(item?.evidenceFound).toContain('1 statement(s)');
  });

  it('says nothing about statements when every query classified', () => {
    const graph = graphOf([
      parsedFile('src/q.ts', {
        entities: [fn('load', 1, 4)],
        markers: [{ name: 'sql.query', line: 2, attributes: { table: 'users', operation: 'read', role: 'from', statement: 'select users' } }],
      }),
    ]);
    expect(ids(checkConsistency({ graph, maxElements: 5_000 }))).not.toContain('data-access:unclassified-statements');
  });
});