import { describe, expect, it } from 'vitest';
import {
  confidenceScore,
  EVIDENCE_STATUSES,
  isEdgeKind,
  isNodeKind,
  nodeId,
  edgeId,
  evidenceId,
  slugify,
  toPosixPath,
  weakerConfidence,
  DEFAULT_LIMITS,
  resolveLimits,
  DiagnosticCollector,
  AnalysisError,
  describeError,
  redactSecrets,
  detectSecretKinds,
  REDACTION_MARKER,
  EvidenceStore,
  SoftwareGraphBuilder,
  computeStats,
  type SoftwareGraph,
} from '@repoatlas/core';

describe('confidence model', () => {
  it('never upgrades a fact when two observations are merged', () => {
    expect(weakerConfidence('EXPLICIT', 'WEEKLY_INFERRED')).toBe('WEEKLY_INFERRED');
    expect(weakerConfidence('STRONGLY_INFERRED', 'EXPLICIT')).toBe('STRONGLY_INFERRED');
    expect(weakerConfidence('EXPLICIT', 'EXPLICIT')).toBe('EXPLICIT');
    expect(weakerConfidence('UNKNOWN', 'WEEKLY_INFERRED')).toBe('UNKNOWN');
  });

  it('orders confidence levels strongest to weakest', () => {
    expect(confidenceScore('EXPLICIT')).toBeGreaterThan(confidenceScore('STRONGLY_INFERRED'));
    expect(confidenceScore('STRONGLY_INFERRED')).toBeGreaterThan(confidenceScore('WEEKLY_INFERRED'));
    expect(confidenceScore('WEEKLY_INFERRED')).toBeGreaterThan(confidenceScore('UNKNOWN'));
  });

  it('defines the four evidence statuses the product promises', () => {
    expect([...EVIDENCE_STATUSES]).toEqual(['EXPLICIT', 'PARTIALLY_EVIDENCED', 'INFERRED', 'NOT_FOUND']);
  });
});

describe('identifier stability', () => {
  it('produces the same node id for the same name every time', () => {
    expect(nodeId('class', 'ReportService')).toBe(nodeId('class', 'ReportService'));
    expect(nodeId('class', 'ReportService')).toBe('class:reportservice');
  });

  it('separates different kinds with the same name', () => {
    expect(nodeId('class', 'run')).not.toBe(nodeId('function', 'run'));
  });

  it('builds edge ids from both endpoints and kind', () => {
    expect(edgeId('a:1', 'calls', 'b:2')).toBe('a:1|calls|b:2');
    expect(edgeId('a:1', 'calls', 'b:2')).not.toBe(edgeId('a:1', 'imports', 'b:2'));
  });

  it('produces stable evidence ids and different ids for different lines', () => {
    const a = evidenceId('src/a.ts', 'CALL_SITE', 10, 'ts');
    expect(evidenceId('src/a.ts', 'CALL_SITE', 10, 'ts')).toBe(a);
    expect(evidenceId('src/a.ts', 'CALL_SITE', 11, 'ts')).not.toBe(a);
  });

  it('slugifies paths while preserving their shape', () => {
    expect(slugify('src/services/Report Service')).toBe('src/services/report-service');
    expect(slugify('  weird//name!!  ')).toBe('weird/name');
  });

  it('collapses repeated separators so equivalent paths share an id', () => {
    expect(slugify('src//a.ts')).toBe(slugify('src/a.ts'));
    expect(slugify('/leading/trailing/')).toBe(slugify('leading/trailing'));
  });

  it('normalises windows separators to posix', () => {
    expect(toPosixPath('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(toPosixPath('./src/a.ts')).toBe('src/a.ts');
  });
});

describe('kind guards', () => {
  it('recognises known kinds and rejects unknown ones', () => {
    expect(isNodeKind('module')).toBe(true);
    expect(isNodeKind('microservice')).toBe(false);
    expect(isEdgeKind('calls')).toBe(true);
    expect(isEdgeKind('teleports_to')).toBe(false);
  });
});

describe('limit resolution', () => {
  it('uses defaults when nothing is supplied', () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it('clamps hostile values instead of trusting them', () => {
    const limits = resolveLimits({
      maxFiles: Number.POSITIVE_INFINITY,
      maxFileBytes: -5,
      maxNodes: 10,
      maxExcerptChars: 100_000,
    });
    expect(limits.maxFiles).toBe(DEFAULT_LIMITS.maxFiles);
    expect(limits.maxFileBytes).toBe(1_024);
    expect(limits.maxNodes).toBe(100);
    expect(limits.maxExcerptChars).toBe(2_000);
  });

  it('ignores non-numeric overrides', () => {
    const limits = resolveLimits({ maxFiles: 'lots' as unknown as number });
    expect(limits.maxFiles).toBe(DEFAULT_LIMITS.maxFiles);
  });
});

describe('secret redaction', () => {
  const cases: [string, string][] = [
    ['aws key', 'const k = "AKIAIOSFODNN7EXAMPLE";'],
    ['github token', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['slack token', 'SLACK_TOKEN=xoxb-1234567890-abcdefghijkl'],
    ['google api key', 'apiKey: "AIzaSyA1234567890abcdefghijklmnopqrstuvw"'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
    ['jwt', 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['password assignment', 'password = "hunter2hunter2"'],
    ['api key assignment', 'api_key: "sk-live-abcdef123456"'],
  ];

  for (const [name, input] of cases) {
    it(`redacts ${name}`, () => {
      const output = redactSecrets(input);
      expect(output).toContain(REDACTION_MARKER);
    });
  }

  it('redacts the password but keeps the username in a connection string', () => {
    const output = redactSecrets('DATABASE_URL=postgres://admin:s3cr3tpassword@db.internal:5432/app');
    expect(output).toContain('admin');
    expect(output).not.toContain('s3cr3tpassword');
  });

  it('reports which pattern fired without revealing the value', () => {
    const kinds = detectSecretKinds('key AKIAIOSFODNN7EXAMPLE');
    expect(kinds).toContain('aws-access-key-id');
  });

  it('leaves ordinary code untouched', () => {
    const source = 'export function add(a: number, b: number): number { return a + b; }';
    expect(redactSecrets(source)).toBe(source);
  });
});

describe('EvidenceStore', () => {
  it('deduplicates identical citations', () => {
    const store = new EvidenceStore({ maxExcerptChars: 100 });
    const first = store.add({ kind: 'CALL_SITE', path: 'src/a.ts', startLine: 3, producer: 'ts' });
    const second = store.add({ kind: 'CALL_SITE', path: 'src/a.ts', startLine: 3, producer: 'ts' });
    expect(first.evidenceId).toBe(second.evidenceId);
    expect(store.size).toBe(1);
  });

  it('keeps distinct citations distinct', () => {
    const store = new EvidenceStore({ maxExcerptChars: 100 });
    store.add({ kind: 'CALL_SITE', path: 'src/a.ts', startLine: 3, producer: 'ts' });
    store.add({ kind: 'CALL_SITE', path: 'src/a.ts', startLine: 4, producer: 'ts' });
    expect(store.size).toBe(2);
  });

  it('redacts and truncates excerpts before they are stored', () => {
    const store = new EvidenceStore({ maxExcerptChars: 40 });
    const ref = store.add({
      kind: 'DECLARATION',
      path: 'src/a.ts',
      startLine: 1,
      producer: 'ts',
      excerpt: `const apiKey = "sk-live-abcdef123456"; ${'x'.repeat(200)}`,
    });
    const stored = store.get(ref.evidenceId);
    expect(stored?.excerpt).toContain(REDACTION_MARKER);
    expect(stored?.excerpt?.length).toBeLessThanOrEqual(40);
  });

  it('clamps a backwards line range rather than storing nonsense', () => {
    const store = new EvidenceStore({ maxExcerptChars: 100 });
    const ref = store.add({ kind: 'DECLARATION', path: 'a.ts', startLine: 10, endLine: 2, producer: 'ts' });
    expect(store.get(ref.evidenceId)?.endLine).toBe(10);
  });

  it('filters evidence by path', () => {
    const store = new EvidenceStore({ maxExcerptChars: 100 });
    store.add({ kind: 'DECLARATION', path: 'src/a.ts', startLine: 1, producer: 'ts' });
    store.add({ kind: 'DECLARATION', path: 'src/b.ts', startLine: 1, producer: 'ts' });
    expect(store.forPath('src/a.ts')).toHaveLength(1);
  });
});

describe('SoftwareGraphBuilder', () => {
  function newBuilder(limits = { maxNodes: 100, maxEdges: 200 }) {
    return new SoftwareGraphBuilder(limits);
  }

  it('creates nodes and edges and serialises them', () => {
    const store = new EvidenceStore({ maxExcerptChars: 80 });
    const graph = newBuilder();
    const evidence = store.add({ kind: 'DECLARATION', path: 'a.ts', startLine: 1, producer: 'ts' });

    graph.addNode({ kind: 'module', name: 'a', evidence: [evidence], confidence: 'EXPLICIT' });
    graph.addNode({ kind: 'class', name: 'C', evidence: [evidence], confidence: 'EXPLICIT' });
    graph.addEdge({ from: 'module:a', to: 'class:c', kind: 'contains', confidence: 'EXPLICIT', evidence: [evidence] });

    const built = graph.build(store);
    expect(built.nodes).toHaveLength(2);
    expect(built.edges).toHaveLength(1);
    expect(built.schemaVersion).toBe(1);
  });

  it('refuses to create an edge with a missing endpoint', () => {
    const graph = newBuilder();
    graph.addNode({ kind: 'module', name: 'a', evidence: [], confidence: 'EXPLICIT' });
    expect(graph.addEdge({ from: 'module:a', to: 'module:ghost', kind: 'imports', confidence: 'EXPLICIT', evidence: [] })).toBeUndefined();
  });

  it('keeps the weaker confidence when the same fact is observed twice', () => {
    const store = new EvidenceStore({ maxExcerptChars: 80 });
    const graph = newBuilder();
    const strong = store.add({ kind: 'DECLARATION', path: 'a.ts', startLine: 1, producer: 'ts' });
    const weak = store.add({ kind: 'DECLARATION', path: 'b.ts', startLine: 9, producer: 'py' });

    graph.addNode({ kind: 'class', name: 'C', evidence: [strong], confidence: 'EXPLICIT' });
    graph.addNode({ kind: 'class', name: 'C', evidence: [weak], confidence: 'WEEKLY_INFERRED' });

    const node = graph.getNode('class:c');
    expect(node?.confidence).toBe('WEEKLY_INFERRED');
    expect(node?.evidence).toHaveLength(2);
  });

  it('enforces the node limit and reports truncation', () => {
    const graph = newBuilder({ maxNodes: 2, maxEdges: 10 });
    graph.addNode({ kind: 'module', name: 'a', evidence: [], confidence: 'EXPLICIT' });
    graph.addNode({ kind: 'module', name: 'b', evidence: [], confidence: 'EXPLICIT' });
    graph.addNode({ kind: 'module', name: 'c', evidence: [], confidence: 'EXPLICIT' });

    expect(graph.nodeCount()).toBe(2);
    expect(graph.wasTruncated()).toBe(true);
  });

  it('downgrades an invalid confidence to UNKNOWN rather than storing a lie', () => {
    const graph = newBuilder();
    graph.addNode({
      kind: 'module',
      name: 'a',
      evidence: [],
      confidence: 'VERY_CERTAIN' as never,
    });
    expect(graph.getNode('module:a')?.confidence).toBe('UNKNOWN');
  });

  it('reports incoming and outgoing relationships', () => {
    const graph = newBuilder();
    graph.addNode({ kind: 'module', name: 'a', evidence: [], confidence: 'EXPLICIT' });
    graph.addNode({ kind: 'module', name: 'b', evidence: [], confidence: 'EXPLICIT' });
    graph.addEdge({ from: 'module:a', to: 'module:b', kind: 'imports', confidence: 'EXPLICIT', evidence: [] });

    expect(graph.outgoing('module:a')).toHaveLength(1);
    expect(graph.incoming('module:b')).toHaveLength(1);
    expect(graph.neighbourhood('module:a').out[0]?.to).toBe('module:b');
  });
});

describe('computeStats', () => {
  it('counts by kind and measures explicit share', () => {
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'module:a', kind: 'module', name: 'a', evidence: [], confidence: 'EXPLICIT' },
        { id: 'class:c', kind: 'class', name: 'C', evidence: [], confidence: 'WEEKLY_INFERRED' },
      ],
      edges: [
        {
          id: 'e1',
          from: 'module:a',
          to: 'class:c',
          kind: 'contains',
          confidence: 'EXPLICIT',
          evidence: [],
        },
      ],
      evidence: [],
    } satisfies SoftwareGraph;

    const stats = computeStats(graph);
    expect(stats.nodeCount).toBe(2);
    expect(stats.nodesByKind).toEqual({ module: 1, class: 1 });
    expect(stats.explicitShare.nodes).toBe(0.5);
    expect(stats.explicitShare.edges).toBe(1);
  });

  it('does not divide by zero on an empty graph', () => {
    const stats = computeStats({ schemaVersion: 1, nodes: [], edges: [], evidence: [] });
    expect(stats.explicitShare).toEqual({ nodes: 0, edges: 0 });
  });
});

describe('diagnostics', () => {
  it('summarises non-info diagnostics as readable lines', () => {
    const collector = new DiagnosticCollector();
    collector.info('GIT_NOT_A_REPOSITORY', 'no git');
    collector.warn('FILE_UNREADABLE', 'cannot read', { path: 'a.ts' });
    collector.error('REPOSITORY_EMPTY', 'nothing here');

    const lines = collector.summaryLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('WARNING FILE_UNREADABLE a.ts');
    expect(collector.bySeverity('error')).toHaveLength(1);
  });

  it('stops collecting at the cap and marks itself truncated', () => {
    const collector = new DiagnosticCollector(3);
    for (let i = 0; i < 10; i += 1) collector.warn('FILE_UNREADABLE', `x${i}`);
    expect(collector.size).toBe(3);
    expect(collector.truncated).toBe(true);
  });

  it('carries a typed code and status on AnalysisError', () => {
    const error = new AnalysisError('PATH_NOT_FOUND', 'nope', 404);
    expect(error.code).toBe('PATH_NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.toDiagnostic().severity).toBe('error');
  });

  it('describes thrown non-Error values safely', () => {
    expect(describeError(new TypeError('bad')).name).toBe('TypeError');
    expect(describeError('plain string').message).toBe('plain string');
    expect(describeError({ weird: true }).message).toContain('weird');
  });
});