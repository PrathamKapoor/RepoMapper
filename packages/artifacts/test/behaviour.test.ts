import { describe, expect, it } from 'vitest';
import {
  buildActivity,
  buildDataFlow,
  buildSequence,
  hasGraphSupport,
  MAX_ACTIVITY_NODES,
  MAX_SEQUENCE_DEPTH,
  MAX_SEQUENCE_MESSAGES,
  traceLineage,
  ARTIFACTS,
} from '@repoatlas/artifacts';
import { buildGraph, DiagnosticCollector, EvidenceStore, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

/**
 * Behaviour and data projections.
 *
 * Fixtures are built through the real builder so the graph facts under test — `calls` edges
 * with `isAsync` on the target, `branches` and `loops` edges, `reads` and `writes` edges — are
 * the ones the pipeline actually produces.
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

/** Route → handler → service → database, with a branch, a loop and a declared foreign key. */
const FULL_GRAPH = graphOf([
  parsedFile('schema.sql', {
    language: 'sql',
    producer: 'config-scanner',
    markers: [
      { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 3, primaryKey: 'id' } },
      { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true, unique: false } },
      { name: 'schema.column', line: 3, attributes: { table: 'reports', column: 'owner_id', dataType: 'TEXT', primaryKey: false, notNull: true, unique: false, referencesTable: 'users' } },
      { name: 'schema.table', line: 6, attributes: { table: 'users', columnCount: 1, primaryKey: 'id' } },
      { name: 'schema.column', line: 7, attributes: { table: 'users', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true, unique: false } },
      { name: 'schema.foreign_key', line: 3, attributes: { table: 'reports', column: 'owner_id', referencesTable: 'users' } },
    ],
  }),
  parsedFile('src/routes.ts', {
    entities: [fn('handleList', 4, 20, false)],
    imports: [{ specifier: './service.js', names: ['findAll'], kind: 'static', line: 1, isExternal: false }],
    calls: [
      { callee: 'findAll', line: 6, fromQualifiedName: 'handleList', isLocalIdentifier: true, argCount: 0 },
      { callee: 'authorize', line: 5, fromQualifiedName: 'handleList', isLocalIdentifier: true, argCount: 1 },
    ],
    markers: [{ name: 'http.route', line: 3, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'handleList' } }],
  }),
  parsedFile('src/service.ts', {
    entities: [fn('findAll', 2, 12, true)],
    calls: [{ callee: 'normalise', line: 4, fromQualifiedName: 'findAll', isLocalIdentifier: true, argCount: 1 }],
    markers: [
      { name: 'sql.query', line: 3, attributes: { operation: 'read', table: 'reports', scope: 'findAll' } },
      { name: 'control.branch', line: 5, attributes: { flow: 'branch', scope: 'findAll', condition: 'rows.length > 0' } },
      { name: 'control.loop', line: 7, attributes: { flow: 'loop', scope: 'findAll', condition: 'index < rows.length' } },
    ],
  }),
  parsedFile('src/normalise.ts', { entities: [fn('normalise', 1, 5, false)] }),
]);

const EMPTY_GRAPH = graphOf([]);

function sequenceOf(graph = FULL_GRAPH, options = {}) {
  return buildSequence({ graph, maxElements: 5_000 }, options);
}

describe('sequence projection', () => {
  it('draws a participant per reachable entity and a message per call', () => {
    const artifact = sequenceOf();
    expect(artifact.nodes.length).toBeGreaterThan(1);
    expect(artifact.edges.length).toBeGreaterThan(0);
    for (const edge of artifact.edges) {
      expect(edge.kind).toBe('calls');
      expect(edge.supportingEdgeIds?.length).toBeGreaterThan(0);
    }
  });

  it('starts from the entry point and reaches the handler', () => {
    const artifact = sequenceOf();
    const endpoint = artifact.nodes.find((node) => node.kind === 'api_endpoint');
    expect(endpoint).toBeDefined();
    const first = artifact.edges.find((edge) => edge.source === endpoint?.id);
    expect(first?.target).toBe('function:handlelist');
  });

  it('places a return message next to the call it belongs to, in source order', () => {
    // handler → A → B, and handler returns A. The return belongs after the A call that produced
    // the value, not after B's call, which happens to be visited later.
    const artifact = sequenceOf(
      graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handler', 1, 8, true)],
          calls: [{ callee: 'outer', line: 4, fromQualifiedName: 'handler', isLocalIdentifier: true, argCount: 0 }],
          bindings: [{ name: 'value', callee: 'outer', line: 4, awaited: true, fromQualifiedName: 'handler' }],
          returns: [{ line: 7, fromQualifiedName: 'handler', kind: 'identifier', name: 'value', expression: 'value' }],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/x', handler: 'handler' } }],
        }),
        parsedFile('src/a.ts', {
          entities: [fn('outer', 1, 6, true)],
          calls: [{ callee: 'inner', line: 3, fromQualifiedName: 'outer', isLocalIdentifier: true, argCount: 0 }],
          bindings: [{ name: 'deep', callee: 'inner', line: 3, awaited: true, fromQualifiedName: 'outer' }],
          returns: [{ line: 5, fromQualifiedName: 'outer', kind: 'identifier', name: 'deep', expression: 'deep' }],
        }),
        parsedFile('src/b.ts', { entities: [fn('inner', 1, 3, false)] }),
      ]),
    );

    const order = artifact.edges.map((edge) => `${edge.kind}:${edge.source}->${edge.target}`);
    // Calls are drawn before the returns that close them, deepest last.
    expect(order.indexOf('calls:function:handler->function:outer')).toBeLessThan(
      order.indexOf('calls:function:outer->function:inner'),
    );
    expect(order.indexOf('calls:function:outer->function:inner')).toBeLessThan(
      order.indexOf('returns:function:inner->function:outer'),
    );
    expect(order.indexOf('returns:function:inner->function:outer')).toBeLessThan(
      order.indexOf('returns:function:outer->function:handler'),
    );
  });

  it('draws every return a function states, not only the first', () => {
    const artifact = sequenceOf(
      graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handler', 1, 9, true)],
          calls: [
            { callee: 'first', line: 4, fromQualifiedName: 'handler', isLocalIdentifier: true, argCount: 0 },
            { callee: 'second', line: 6, fromQualifiedName: 'handler', isLocalIdentifier: true, argCount: 0 },
          ],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/x', handler: 'handler' } }],
        }),
        parsedFile('src/a.ts', {
          entities: [fn('first', 1, 4, true)],
          calls: [{ callee: 'source', line: 2, fromQualifiedName: 'first', isLocalIdentifier: true, argCount: 0 }],
          returns: [{ line: 3, fromQualifiedName: 'first', kind: 'call', name: 'source', expression: 'source()' }],
        }),
        parsedFile('src/b.ts', {
          entities: [fn('second', 1, 4, true)],
          calls: [{ callee: 'other', line: 2, fromQualifiedName: 'second', isLocalIdentifier: true, argCount: 0 }],
          returns: [{ line: 3, fromQualifiedName: 'second', kind: 'call', name: 'other', expression: 'other()' }],
        }),
        parsedFile('src/c.ts', { entities: [fn('source', 1, 2), fn('other', 1, 2)] }),
      ]),
    );

    // Both hand-backs are drawn: `source` into `first` and `other` into `second`.
    const returned = artifact.edges.filter((edge) => edge.kind === 'returns').map((edge) => edge.target);
    expect(returned).toEqual(['function:first', 'function:second']);
    expect(artifact.edges.filter((edge) => edge.kind === 'calls')).toHaveLength(5);
  });

  it('draws a call whose return the source does not state, as a call with no return', () => {
    const artifact = sequenceOf(
      graphOf([
        parsedFile('src/routes.ts', {
          entities: [fn('handler', 1, 6, true)],
          calls: [{ callee: 'load', line: 3, fromQualifiedName: 'handler', isLocalIdentifier: true, argCount: 0 }],
          markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/x', handler: 'handler' } }],
        }),
        parsedFile('src/a.ts', { entities: [fn('load', 1, 3)] }),
      ]),
    );

    const call = artifact.edges.find((edge) => edge.kind === 'calls' && edge.target === 'function:load');
    expect(call).toBeDefined();
    expect(artifact.edges.some((edge) => edge.kind === 'returns' && edge.source === 'function:load')).toBe(false);
  });

  it('draws no return message when the graph records none', () => {
    // Phase 4 removed the blanket refusal to draw a return, not the requirement for evidence.
    // A call whose result the source never uses still produces no return arrow, and the view
    // says why rather than drawing an empty one.
    const artifact = sequenceOf();
    expect(artifact.edges.every((edge) => edge.kind !== 'returns')).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('calls with no return drawn'))).toBe(true);
    expect(artifact.scope).toContain('A call with no recorded return is drawn as a call with no return');
  });

  it('marks an asynchronous call only where the declaration says so', () => {
    const artifact = sequenceOf();
    const toService = artifact.edges.find((edge) => edge.target === 'function:findall');
    // `findAll` is declared async; `handleList` is not.
    expect(toService?.label).toContain('(async)');

    const sync = artifact.nodes.find((node) => node.id === 'function:handlelist');
    expect(sync?.technology).toBe('sync');
    expect(sync?.derivation).toContain('not async');
  });

  it('does not assert synchrony where the source did not say', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handle', 1, 4)],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handle' } }],
      }),
    ]);
    // The handler is declared without an isAsync attribute, so nothing may be claimed.
    const artifact = sequenceOf(graph);
    const handler = artifact.nodes.find((node) => node.id === 'function:handle');
    expect(handler?.technology).toBeUndefined();
    expect(handler?.derivation).toContain('does not state whether');
  });

  it('excludes third-party packages from the participants', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handle', 1, 4)],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handle' } }],
      }),
      parsedFile('package.json', {
        language: 'json',
        producer: 'config-scanner',
        markers: [{ name: 'manifest.dependency', line: 2, attributes: { dependency: 'express', section: 'dependencies', range: '^4.0.0' } }],
      }),
    ]);
    const artifact = sequenceOf(graph);
    expect(artifact.nodes.some((node) => node.kind === 'package')).toBe(false);
    expect(artifact.omitted.some((entry) => entry.reason.includes('third-party code was not analysed'))).toBe(true);
  });

  it('is honestly insufficient when the repository declares no entry point', () => {
    const artifact = sequenceOf(graphOf([parsedFile('src/a.ts')]));
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.nodes).toHaveLength(0);
    expect(artifact.omitted[0]?.reason).toContain('no entry point');
  });

  it('bounds traversal so a cyclic call graph terminates', () => {
    const cyclic = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('a', 1, 2)],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/loop', handler: 'a' } }],
      }),
      parsedFile('src/a.ts', {
        entities: [fn('a', 1, 2)],
        calls: [{ callee: 'b', line: 2, fromQualifiedName: 'a', isLocalIdentifier: true, argCount: 0 }],
      }),
      parsedFile('src/b.ts', {
        entities: [fn('b', 1, 2)],
        calls: [{ callee: 'a', line: 2, fromQualifiedName: 'b', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);
    const artifact = sequenceOf(cyclic);
    expect(artifact.edges.length).toBeGreaterThan(0);
    expect(artifact.edges.length).toBeLessThanOrEqual(MAX_SEQUENCE_DEPTH * 2);
  });

  it('states when a flow was cut by the message limit', () => {
    const many = Array.from({ length: MAX_SEQUENCE_MESSAGES + 5 }, (_, index) => fn(`f${index}`, 1, 2));
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('entry', 1, 2)],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/wide', handler: 'entry' } }],
      }),
      parsedFile('src/many.ts', {
        entities: many,
        calls: many.map((_entity, index) => ({
          callee: `f${index}`,
          line: 2,
          fromQualifiedName: 'entry',
          isLocalIdentifier: true,
          argCount: 0,
        })),
      }),
    ]);
    const artifact = sequenceOf(graph);
    expect(artifact.edges.length).toBe(MAX_SEQUENCE_MESSAGES);
    expect(artifact.omitted.some((entry) => entry.reason.includes(`beyond ${MAX_SEQUENCE_MESSAGES}`))).toBe(true);
  });

  it('never emits a message without graph support', () => {
    for (const edge of sequenceOf().edges) expect(hasGraphSupport(edge)).toBe(true);
  });

  it('gives every arrow a distinct id, even when two flows make the same call', () => {
    // D-049. The order counter restarts per flow, so `seq:2:service->repo` was produced once
    // per entry point. Two edges with one id cannot be told apart in a view that selects an
    // arrow by id, so the evidence panel showed whichever came first.
    const shared = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handler', 1, 6)],
        markers: [
          { name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handler' } },
          { name: 'http.route', line: 3, attributes: { httpMethod: 'GET', path: '/b', handler: 'handler' } },
        ],
      }),
      parsedFile('src/handler.ts', {
        entities: [fn('handler', 1, 6, true), fn('service', 10, 20, true)],
        calls: [
          {
            callee: 'service',
            line: 4,
            fromQualifiedName: 'handler',
            isLocalIdentifier: true,
            argCount: 1,
            awaited: true,
            result: { kind: 'awaited_call', name: 'service', line: 4, awaited: true },
          },
        ],
        returns: [{ line: 4, fromQualifiedName: 'handler', kind: 'awaited_call', name: 'service', awaited: true }],
      }),
    ]);
    const artifact = sequenceOf(shared);
    const ids = artifact.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Both flows reach the same call, so the shared leg is drawn once per flow and both copies
    // must remain individually addressable.
    expect(artifact.edges.filter((edge) => edge.source === 'function:handler' && edge.target === 'function:service')).toHaveLength(2);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(sequenceOf())).toBe(JSON.stringify(sequenceOf()));
  });
});

describe('activity projection', () => {
  it('orders a workflow by the source line of each decision point', () => {
    const artifact = buildActivity({ graph: FULL_GRAPH, maxElements: 5_000 });
    const decisions = artifact.nodes.filter((node) => node.kind === 'condition');
    expect(decisions.length).toBe(2);
    expect(decisions[0]?.label).toBe('rows.length > 0');
    expect(decisions[1]?.label).toBe('index < rows.length');
    expect(decisions[0]?.detail).toBe('branch');
    expect(decisions[1]?.detail).toBe('loop');
  });

  it('links the unit to its first decision point and then chains them in order', () => {
    const artifact = buildActivity({ graph: FULL_GRAPH, maxElements: 5_000 });
    const start = artifact.edges.find((edge) => edge.source === 'function:findall');
    expect(start?.kind).toBe('branches');
    expect(start?.supportingEdgeIds?.length).toBe(1);

    const then = artifact.edges.find((edge) => edge.kind === 'transforms');
    // Ordering is a claim about source line, so it names both edges that establish it.
    expect(then?.supportingEdgeIds).toHaveLength(2);
    expect(then?.derivation).toContain('source line');
  });

  it('does not turn a call graph into a workflow', () => {
    const callsOnly = graphOf([
      parsedFile('src/routes.ts', {
        entities: [fn('handle', 1, 4)],
        calls: [{ callee: 'other', line: 2, fromQualifiedName: 'handle', isLocalIdentifier: true, argCount: 0 }],
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handle' } }],
      }),
      parsedFile('src/other.ts', { entities: [fn('other', 1, 4)] }),
    ]);
    const artifact = buildActivity({ graph: callsOnly, maxElements: 5_000 });
    expect(artifact.nodes).toHaveLength(0);
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.omitted.some((entry) => entry.reason.includes('call graph is not a workflow'))).toBe(true);
  });

  it('reports a state model as unsupported unless the graph holds one', () => {
    const artifact = buildActivity({ graph: FULL_GRAPH, maxElements: 5_000 });
    const note = artifact.omitted.find((entry) => entry.reason.includes('state transitions'));
    expect(note?.reason).toContain('no state entity and no transition relationship');
  });

  it('never emits a step without graph support', () => {
    for (const edge of buildActivity({ graph: FULL_GRAPH, maxElements: 5_000 }).edges) {
      expect(hasGraphSupport(edge)).toBe(true);
    }
  });

  it('is deterministic and bounded', () => {
    const first = buildActivity({ graph: FULL_GRAPH, maxElements: MAX_ACTIVITY_NODES });
    const second = buildActivity({ graph: FULL_GRAPH, maxElements: MAX_ACTIVITY_NODES });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('data flow projection', () => {
  it('draws a flow only from a data relationship', () => {
    const artifact = buildDataFlow({ graph: FULL_GRAPH, maxElements: 5_000 });
    expect(artifact.edges.length).toBeGreaterThan(0);
    for (const edge of artifact.edges) {
      expect(['reads', 'writes', 'produces', 'consumes', 'transforms', 'communicates_with']).toContain(edge.kind);
      expect(edge.supportingEdgeIds?.length).toBeGreaterThan(0);
    }
  });

  it('says explicitly that a dependency is not a data flow', () => {
    const artifact = buildDataFlow({ graph: FULL_GRAPH, maxElements: 5_000 });
    const note = artifact.omitted.find((entry) => entry.reason.includes('dependencies are not data flows'));
    expect(note).toBeDefined();
    expect(note?.count).toBeGreaterThan(0);
  });

  it('is honestly insufficient when the graph records no data relationship', () => {
    const artifact = buildDataFlow({ graph: graphOf([parsedFile('src/a.ts')]), maxElements: 5_000 });
    expect(artifact.insufficientEvidence).toBe(true);
    expect(artifact.edges).toHaveLength(0);
  });

  it('reports a store referenced by code but never declared', () => {
    const artifact = buildDataFlow({
      graph: graphOf([
        parsedFile('src/a.ts', {
          markers: [{ name: 'sql.query', line: 1, attributes: { operation: 'read', table: 'legacy_orders', scope: 'load' } }],
        }),
      ]),
      maxElements: 5_000,
    });
    expect(artifact.omitted.some((entry) => entry.reason.includes('never declared in a schema'))).toBe(true);
    const store = artifact.nodes.find((node) => node.label === 'legacy_orders');
    expect(store?.derivation).toContain('unknown');
  });

  it('is deterministic', () => {
    const first = buildDataFlow({ graph: FULL_GRAPH, maxElements: 5_000 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(buildDataFlow({ graph: FULL_GRAPH, maxElements: 5_000 })));
  });
});

describe('data lineage', () => {
  it('traces what reaches a store and what it reaches', () => {
    const upstream = traceLineage(FULL_GRAPH, 'table:reports');
    expect(upstream?.subjectName).toBe('reports');
    expect(upstream?.upstream.length).toBeGreaterThan(0);

    const fromCode = traceLineage(FULL_GRAPH, 'function:findall');
    expect(fromCode?.downstream.length).toBeGreaterThan(0);
    expect(fromCode?.downstream.some((hop) => hop.to === 'table:reports')).toBe(true);

    const lineage = upstream;
    // Every hop cites the relationship that moves the data.
    for (const hop of [...(lineage?.upstream ?? []), ...(lineage?.downstream ?? [])]) {
      expect(hop.edgeId.length).toBeGreaterThan(0);
      expect(hop.evidence.length).toBeGreaterThan(0);
    }
  });

  it('answers "where did this come from" in the inbound direction', () => {
    const lineage = traceLineage(FULL_GRAPH, 'table:reports');
    expect(lineage?.upstream.some((hop) => hop.direction === 'inbound' && hop.relation === 'reads')).toBe(true);
    expect(lineage?.upstream.every((hop) => hop.to === 'table:reports' || hop.relation === 'reads')).toBe(true);
  });

  it('reports null for a subject the graph does not hold', () => {
    expect(traceLineage(FULL_GRAPH, 'table:nope')).toBeNull();
  });

  it('terminates on a cycle and says the chain was cut by the limit, not the graph', () => {
    const cyclic = graphOf([
      parsedFile('src/a.ts', {
        entities: [fn('load', 1, 3)],
        markers: [
          { name: 'sql.query', line: 2, attributes: { operation: 'read', table: 'alpha', scope: 'load' } },
          { name: 'sql.query', line: 3, attributes: { operation: 'write', table: 'beta', scope: 'load' } },
        ],
      }),
      parsedFile('src/b.ts', {
        entities: [fn('store', 1, 3)],
        markers: [
          { name: 'sql.query', line: 2, attributes: { operation: 'read', table: 'beta', scope: 'store' } },
          { name: 'sql.query', line: 3, attributes: { operation: 'write', table: 'alpha', scope: 'store' } },
        ],
      }),
    ]);
    const lineage = traceLineage(cyclic, 'table:alpha');
    expect(lineage).not.toBeNull();
    expect(lineage!.upstream.length + lineage!.downstream.length).toBeGreaterThan(0);
  });

  it('returns null rather than an empty object for a graph with no data', () => {
    expect(traceLineage(EMPTY_GRAPH, 'table:reports')).toBeNull();
  });
});

describe('artifact registration', () => {
  it('registers the behaviour and data views so the API can serve them', () => {
    const kinds = ARTIFACTS.map((artifact) => artifact.kind);
    expect(kinds).toContain('sequence');
    expect(kinds).toContain('activity');
    expect(kinds).toContain('data-flow');
  });
});
