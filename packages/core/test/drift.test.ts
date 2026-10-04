import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  compareSnapshots,
  computeGraphDigest,
  createSnapshot,
  detectRenames,
  DiagnosticCollector,
  EvidenceStore,
  EXTRACTOR_VERSION,
  GRAPH_SCHEMA_VERSION,
  incomparabilityReason,
  snapshotIdFrom,
  stableStringify,
  type AnalysisSnapshot,
  type Confidence,
  type CreateSnapshotInput,
  type DriftCategory,
  type ParsedFile,
  type RepositoryRef,
  type SoftwareGraph,
} from '@repoatlas/core';

/**
 * Drift fixtures.
 *
 * Two repository states are built from real `buildGraph()` runs rather than hand-written
 * graphs, because the properties under test — deterministic ids, evidence ids that encode
 * path and line, confidence that downgrades on merge — are properties of the builder, not
 * of a graph literal. A fixture that bypassed the builder would test a fiction.
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

function graphOf(files: ParsedFile[], digests: Record<string, string> = {}): SoftwareGraph {
  const digestByPath = new Map(Object.entries(digests));
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
    digestByPath,
  }).graph;
}

interface SnapshotOptions {
  analysisId?: string;
  createdAt?: string;
  sourceRevision?: string | null;
  branch?: string | null;
  truncated?: boolean;
  extractorVersion?: string;
}

function snapshotOf(graph: SoftwareGraph, options: SnapshotOptions = {}): AnalysisSnapshot {
  const input: CreateSnapshotInput = {
    analysisId: options.analysisId ?? 'a1',
    repositoryPath: REPOSITORY.absolutePath,
    repositoryName: REPOSITORY.name,
    createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
    sourceRevision: options.sourceRevision ?? null,
    branch: options.branch ?? null,
    truncated: options.truncated ?? false,
    graph,
    ...(options.extractorVersion ? { extractorVersion: options.extractorVersion } : {}),
  };
  return createSnapshot(input);
}

/** The repository state used by most cases: two modules with an import between them. */
const BASE_FILES: ParsedFile[] = [
  parsedFile('src/a.ts', {
    imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 1, isExternal: false }],
    entities: [{ kind: 'class', name: 'A', qualifiedName: 'A', startLine: 3, endLine: 6, language: 'typescript' }],
  }),
  parsedFile('src/b.ts', {
    entities: [{ kind: 'class', name: 'B', qualifiedName: 'B', startLine: 1, endLine: 4, language: 'typescript' }],
  }),
];

function count(report: { counts: Record<DriftCategory, number> }, category: DriftCategory): number {
  return report.counts[category];
}

describe('snapshot identity', () => {
  it('gives two analyses of identical content the same identity', () => {
    const first = snapshotOf(graphOf(BASE_FILES), { analysisId: 'a1', createdAt: '2026-01-01T00:00:00.000Z' });
    const second = snapshotOf(graphOf(BASE_FILES), {
      analysisId: 'a2',
      createdAt: '2026-06-01T12:00:00.000Z',
      sourceRevision: 'deadbeef',
      branch: 'release',
    });
    expect(second.id).toBe(first.id);
    expect(second.provenance.graphDigest).toBe(first.provenance.graphDigest);
  });

  it('does not use the analysis id, the path or the commit as its identity', () => {
    const base = snapshotOf(graphOf(BASE_FILES), { analysisId: 'a1' });
    const elsewhere = snapshotOf(graphOf(BASE_FILES), {
      analysisId: 'a99',
      sourceRevision: 'deadbeef',
      branch: 'release',
      createdAt: '2030-12-31T23:59:59.000Z',
    });
    expect(elsewhere.provenance.analysisId).not.toBe(base.provenance.analysisId);
    expect(elsewhere.id).toBe(base.id);
  });

  it('changes identity when the content changes', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const changed = snapshotOf(
      graphOf([...BASE_FILES, parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] })]),
    );
    expect(changed.id).not.toBe(base.id);
  });

  it('changes identity when the extractor version changes, because the facts would differ', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const other = snapshotOf(graphOf(BASE_FILES), { extractorVersion: '9.9.9' });
    expect(other.id).not.toBe(base.id);
    expect(other.provenance.extractorVersion).toBe('9.9.9');
  });

  it('records provenance without letting it leak into the identity', () => {
    const snapshot = snapshotOf(graphOf(BASE_FILES), {
      sourceRevision: 'abc123',
      branch: 'main',
      createdAt: '2026-02-02T00:00:00.000Z',
    });
    expect(snapshot.provenance.sourceRevision).toBe('abc123');
    expect(snapshot.provenance.branch).toBe('main');
    expect(snapshot.provenance.createdAt).toBe('2026-02-02T00:00:00.000Z');
    expect(snapshot.provenance.graphSchemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(snapshot.provenance.extractorVersion).toBe(EXTRACTOR_VERSION);
  });

  it('carries the same identity on the snapshot and inside its provenance', () => {
    // The provenance object is what reports and API payloads serialise, so an identity that
    // was only correct on the outer object would be silently lost in every consumer.
    const snapshot = snapshotOf(graphOf(BASE_FILES));
    expect(snapshot.provenance.snapshotId).toBe(snapshot.id);
    expect(snapshot.provenance.graphDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialises to JSON and back without losing the identity', () => {
    const snapshot = snapshotOf(graphOf(BASE_FILES));
    const restored = JSON.parse(JSON.stringify(snapshot)) as AnalysisSnapshot;
    expect(restored.id).toBe(snapshot.id);
    expect(computeGraphDigest(restored.graph)).toBe(snapshot.provenance.graphDigest);
    expect(snapshot.stats.nodeCount).toBe(snapshot.graph.nodes.length);
  });

  it('produces the same digest regardless of extraction order', () => {
    const forward = graphOf(BASE_FILES);
    const reversed = graphOf([...BASE_FILES].reverse());
    expect(computeGraphDigest(reversed)).toBe(computeGraphDigest(forward));
  });

  it('derives the snapshot id from the digest and the schema version', () => {
    expect(snapshotIdFrom('abc', 2)).toBe(snapshotIdFrom('abc', 2));
    expect(snapshotIdFrom('abc', 2)).not.toBe(snapshotIdFrom('abc', 1));
    expect(snapshotIdFrom('abc', 2)).toMatch(/^snap_[0-9a-f]{16}$/);
  });

  it('serialises objects with sorted keys so insertion order cannot change a digest', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
    expect(stableStringify([3, 1])).toBe('[3,1]');
  });

  it('refuses to compare snapshots produced by different machinery', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const other = snapshotOf(graphOf(BASE_FILES), { extractorVersion: '9.9.9' });
    expect(incomparabilityReason(base.provenance, other.provenance)).toContain('Extractor versions differ');
    const report = compareSnapshots(base, other);
    expect(report.comparable).toBe(false);
    expect(report.incomparabilityReason).toContain('Extractor versions differ');
    expect(report.changes).toHaveLength(0);
  });

  it('creates a snapshot for a repository with no git history', () => {
    const snapshot = snapshotOf(graphOf(BASE_FILES), { sourceRevision: null, branch: null });
    expect(snapshot.provenance.sourceRevision).toBeNull();
    expect(snapshot.provenance.branch).toBeNull();
    expect(snapshot.id).toMatch(/^snap_/);
    expect(compareSnapshots(snapshot, snapshot).identical).toBe(true);
  });
});

describe('node drift', () => {
  it('reports an added node with the evidence that proves it exists', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        ...BASE_FILES,
        parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] }),
      ]),
    );

    const report = compareSnapshots(base, target);
    const added = report.changes.find((change) => change.category === 'NODE_ADDED');
    expect(count(report, 'NODE_ADDED')).toBeGreaterThan(0);
    expect(added?.nodeKind).toBe('class');
    expect(added?.evidenceAfter.length).toBeGreaterThan(0);
    expect(added?.evidenceBefore).toHaveLength(0);
    expect(added?.claimConfidence).toBe('EXPLICIT');
    expect(added?.indeterminate).toBe(false);
  });

  it('reports a removed node as a removal, with the citations it had', () => {
    const base = snapshotOf(
      graphOf([
        ...BASE_FILES,
        parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] }),
      ]),
    );
    const target = snapshotOf(graphOf(BASE_FILES));

    const report = compareSnapshots(base, target);
    const removed = report.changes.filter((change) => change.category === 'NODE_REMOVED');
    expect(count(report, 'NODE_REMOVED')).toBe(removed.length);
    expect(removed.every((change) => change.evidenceBefore.length > 0)).toBe(true);
    expect(removed.every((change) => change.claimConfidence === 'EXPLICIT')).toBe(true);
    expect(removed.every((change) => change.indeterminate === false)).toBe(true);
  });

  it('reports a retained node as unchanged', () => {
    const report = compareSnapshots(snapshotOf(graphOf(BASE_FILES)), snapshotOf(graphOf(BASE_FILES)));
    expect(report.identical).toBe(true);
    expect(report.counts.NODE_MODIFIED).toBe(0);
    expect(report.counts.NODE_REMOVED).toBe(0);
    expect(report.counts.NODE_ADDED).toBe(0);
    expect(report.summary.totalChanges).toBe(0);
  });

  it('reports a moved declaration as a modification naming the changed fields', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        BASE_FILES[0]!,
        parsedFile('src/b.ts', {
          entities: [{ kind: 'class', name: 'B', qualifiedName: 'B', startLine: 30, endLine: 33, language: 'typescript' }],
        }),
      ]),
    );

    const report = compareSnapshots(base, target);
    const modified = report.changes.find((change) => change.category === 'NODE_MODIFIED');
    expect(modified?.changedFields).toContain('startLine');
    expect(modified?.changedFields).toContain('endLine');
    expect(count(report, 'NODE_MODIFIED')).toBeGreaterThan(0);
  });

  it('reports changed content as a modification of the module, not as a removal', () => {
    const base = snapshotOf(graphOf(BASE_FILES, { 'src/b.ts': 'digest-b' }));
    const target = snapshotOf(graphOf(BASE_FILES, { 'src/b.ts': 'digest-b-changed' }));
    const report = compareSnapshots(base, target);
    const modified = report.changes.find((change) => change.category === 'NODE_MODIFIED');
    expect(modified?.changedFields).toContain('digest');
    expect(count(report, 'NODE_REMOVED')).toBe(0);
    expect(count(report, 'NODE_ADDED')).toBe(0);
  });

  it('does not report a removal merely because an observation is absent from a truncated analysis', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    // A truncated analysis walked part of the repository. The missing class was not looked
    // for, so its absence proves nothing.
    const partial = graphOf([BASE_FILES[0]!]);
    const target = snapshotOf(partial, { truncated: true });

    const report = compareSnapshots(base, target);
    expect(report.targetIncomplete).toBe(true);
    expect(report.removalConfidence).toBe('INDETERMINATE');
    const removals = report.changes.filter((change) => change.category === 'NODE_REMOVED');
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((change) => change.indeterminate)).toBe(true);
    expect(removals.every((change) => change.reason && change.reason.includes('does not establish removal'))).toBe(true);
    // Citations are as unassertable as entities under truncation.
    const evidenceRemovals = report.changes.filter((change) => change.category === 'EVIDENCE_REMOVED');
    expect(evidenceRemovals.every((change) => change.indeterminate)).toBe(true);
  });
});

describe('edge drift', () => {
  const WITH_SECOND_IMPORT: ParsedFile[] = [
    BASE_FILES[0]!,
    BASE_FILES[1]!,
    parsedFile('src/c.ts', {
      imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 1, isExternal: false }],
      entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 3, endLine: 4, language: 'typescript' }],
    }),
  ];

  it('reports an added relationship', () => {
    const report = compareSnapshots(snapshotOf(graphOf(BASE_FILES)), snapshotOf(graphOf(WITH_SECOND_IMPORT)));
    const added = report.changes.filter((change) => change.category === 'EDGE_ADDED');
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((change) => change.edgeKind !== undefined)).toBe(true);
    expect(added.every((change) => change.evidenceAfter.length > 0)).toBe(true);
    expect(report.summary.relationshipsAdded).toBe(added.length);
  });

  it('reports a removed relationship', () => {
    const report = compareSnapshots(snapshotOf(graphOf(WITH_SECOND_IMPORT)), snapshotOf(graphOf(BASE_FILES)));
    const removed = report.changes.filter((change) => change.category === 'EDGE_REMOVED');
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((change) => change.evidenceBefore.length > 0)).toBe(true);
    expect(report.summary.relationshipsRemoved).toBe(removed.length);
  });

  it('reports a change in relationship metadata', () => {
    const downgraded = edgeWithLowerConfidence(graphOf(BASE_FILES));
    const report = compareSnapshots(snapshotOf(graphOf(BASE_FILES)), snapshotOf(downgraded));
    const modified = report.changes.filter((change) => change.category === 'EDGE_MODIFIED');
    expect(modified.length).toBeGreaterThan(0);
    expect(modified[0]?.changedFields).toContain('confidence');
  });

  it('records a confidence change separately so a downgrade is visible on its own', () => {
    const downgraded = edgeWithLowerConfidence(graphOf(BASE_FILES));
    const report = compareSnapshots(snapshotOf(graphOf(BASE_FILES)), snapshotOf(downgraded));
    const confidenceChanges = report.changes.filter((change) => change.category === 'CONFIDENCE_CHANGED');
    expect(confidenceChanges.length).toBeGreaterThan(0);
    expect(confidenceChanges[0]?.changedFields).toEqual(['confidence']);
    expect(confidenceChanges[0]?.confidence).not.toBe('EXPLICIT');
    expect(confidenceChanges[0]?.entityKind).toBe('edge');
    expect(report.summary.confidenceChanged).toBe(confidenceChanges.length);
  });
});

/**
 * Downgrades the confidence of the first relationship in a graph.
 *
 * Confidence cannot rise through extraction (D-007), so the only way to observe a change is
 * to build a weaker graph and compare it against the stronger one.
 */
function edgeWithLowerConfidence(graph: SoftwareGraph): SoftwareGraph {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const edges = graph.edges.map((edge, index) =>
    index === 0 ? { ...edge, confidence: 'WEEKLY_INFERRED' as Confidence } : { ...edge },
  );
  return { ...graph, nodes, edges };
}

describe('evidence drift', () => {
  it('reports citations added and removed as evidence records', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        ...BASE_FILES,
        parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] }),
      ]),
    );
    const report = compareSnapshots(base, target);
    expect(count(report, 'EVIDENCE_ADDED')).toBeGreaterThan(0);
    expect(count(report, 'EVIDENCE_REMOVED')).toBe(0);
  });

  it('reports an entity that is now cited at a different location', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        parsedFile('src/a.ts', {
          imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 2, isExternal: false }],
          entities: [{ kind: 'class', name: 'A', qualifiedName: 'A', startLine: 3, endLine: 6, language: 'typescript' }],
        }),
        BASE_FILES[1]!,
      ]),
    );

    const report = compareSnapshots(base, target);
    const changed = report.changes.filter((change) => change.category === 'EVIDENCE_CHANGED');
    expect(changed.length).toBeGreaterThan(0);
    // The import statement moved from line 1 to line 2, so the relationship that cites it
    // now points somewhere else.
    const record = changed.find((change) => change.entityKind === 'edge');
    expect(record?.evidenceBefore.length).toBeGreaterThan(0);
    expect(record?.evidenceAfter.length).toBeGreaterThan(0);
    expect(record?.evidenceBefore[0]?.path).toBe('src/a.ts');
    expect(record?.evidenceAfter[0]?.path).toBe('src/a.ts');
    expect(record?.evidenceBefore[0]?.startLine).toBe(1);
    expect(record?.evidenceAfter[0]?.startLine).toBe(2);
    expect(record?.label).toContain('src/a.ts:1');
    expect(record?.label).toContain('src/a.ts:2');
  });

  it('reports a declaration that moved as both a modification and a change of citation', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        BASE_FILES[0]!,
        parsedFile('src/b.ts', {
          entities: [{ kind: 'class', name: 'B', qualifiedName: 'B', startLine: 30, endLine: 33, language: 'typescript' }],
        }),
      ]),
    );

    const report = compareSnapshots(base, target);
    const rebinding = report.changes.find(
      (change) => change.category === 'EVIDENCE_CHANGED' && change.entityKind === 'node' && change.entityId === 'class:b',
    );
    expect(rebinding?.evidenceBefore[0]?.startLine).toBe(1);
    expect(rebinding?.evidenceAfter[0]?.startLine).toBe(30);
  });
});

describe('rename detection', () => {
  /** The base state plus the second file under a new path. */
  const renamedFiles = (to: string): ParsedFile[] => [
    BASE_FILES[0]!,
    parsedFile(to, {
      entities: [{ kind: 'class', name: 'B', qualifiedName: 'B', startLine: 1, endLine: 4, language: 'typescript' }],
    }),
  ];

  it('proves a rename when the content is identical', () => {
    const base = snapshotOf(graphOf(BASE_FILES, { 'src/b.ts': 'same-bytes' }));
    const target = snapshotOf(graphOf(renamedFiles('src/renamed.ts'), { 'src/renamed.ts': 'same-bytes' }));

    const report = compareSnapshots(base, target);
    const rename = report.changes.find((change) => change.category === 'NODE_RENAMED');
    expect(rename).toBeDefined();
    expect(rename?.previousEntityId).toBe('module:src/b');
    expect(rename?.entityId).toBe('module:src/renamed');
    // A rename established from identical content is an inference, however strong, and it
    // is labelled as one.
    expect(rename?.claimConfidence).toBe('STRONGLY_INFERRED');
    expect(rename?.evidenceBefore.length).toBeGreaterThan(0);
    expect(rename?.evidenceAfter.length).toBeGreaterThan(0);
    // The same file must not also appear as an addition and a removal.
    expect(count(report, 'NODE_REMOVED')).toBe(0);
    expect(count(report, 'NODE_ADDED')).toBe(0);
  });

  it('refuses to call a rename when the content also changed', () => {
    const base = snapshotOf(graphOf(BASE_FILES, { 'src/b.ts': 'bytes-one' }));
    const target = snapshotOf(graphOf(renamedFiles('src/renamed.ts'), { 'src/renamed.ts': 'bytes-two' }));
    const report = compareSnapshots(base, target);
    expect(count(report, 'NODE_RENAMED')).toBe(0);
    expect(count(report, 'NODE_REMOVED')).toBeGreaterThan(0);
    expect(count(report, 'NODE_ADDED')).toBeGreaterThan(0);
  });

  it('refuses to call a rename when the pairing would be ambiguous', () => {
    // Two identical files, so content identity cannot say which became which.
    const base = snapshotOf(
      graphOf([BASE_FILES[0]!, parsedFile('src/one.ts'), parsedFile('src/two.ts')], {
        'src/one.ts': 'identical',
        'src/two.ts': 'identical',
      }),
    );
    const target = snapshotOf(
      graphOf([BASE_FILES[0]!, parsedFile('src/three.ts'), parsedFile('src/four.ts')], {
        'src/three.ts': 'identical',
        'src/four.ts': 'identical',
      }),
    );
    expect(compareSnapshots(base, target).counts.NODE_RENAMED).toBe(0);
  });

  it('reports removed plus added when no digest was captured at all', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(graphOf(renamedFiles('src/renamed.ts')));
    const report = compareSnapshots(base, target);
    expect(count(report, 'NODE_RENAMED')).toBe(0);
    expect(count(report, 'NODE_REMOVED')).toBeGreaterThan(0);
    expect(count(report, 'NODE_ADDED')).toBeGreaterThan(0);
  });

  it('never pairs nodes of different kinds, even with identical content', () => {
    const removed = {
      id: 'module:a',
      kind: 'module' as const,
      name: 'a',
      digest: 'same',
      language: 'typescript',
      evidence: [],
      confidence: 'EXPLICIT' as const,
    };
    const added = { ...removed, id: 'class:a', kind: 'class' as const };
    expect(detectRenames([removed], [added])).toHaveLength(0);
  });
});

describe('drift determinism', () => {
  it('produces byte-identical reports for the same pair of snapshots', () => {
    const base = snapshotOf(graphOf(BASE_FILES), { createdAt: '2026-01-01T00:00:00.000Z' });
    const target = snapshotOf(
      graphOf([...BASE_FILES, parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] })]),
      { createdAt: '2026-02-01T00:00:00.000Z' },
    );

    const first = compareSnapshots(base, target);
    const second = compareSnapshots(base, target);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('orders changes deterministically regardless of insertion order', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        ...BASE_FILES,
        parsedFile('src/z.ts', { entities: [{ kind: 'class', name: 'Z', qualifiedName: 'Z', startLine: 1, endLine: 2, language: 'typescript' }] }),
        parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] }),
      ]),
    );
    const forward = compareSnapshots(base, target);
    const reversed = compareSnapshots(base, target);
    const ids = forward.changes.map((change) => `${change.category}:${change.entityId}`);
    expect(ids).toEqual([...ids].sort());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('counts every change even when per-item records are suppressed', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([...BASE_FILES, parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] })]),
    );

    const withChanges = compareSnapshots(base, target);
    const withoutChanges = compareSnapshots(base, target, { includeChanges: false });
    expect(withoutChanges.changes).toHaveLength(0);
    expect(withoutChanges.summary).toEqual(withChanges.summary);
  });

  it('caps recorded changes without capping the counts', () => {
    const base = snapshotOf(graphOf(BASE_FILES));
    const target = snapshotOf(
      graphOf([
        ...BASE_FILES,
        parsedFile('src/c.ts', { entities: [{ kind: 'class', name: 'C', qualifiedName: 'C', startLine: 1, endLine: 2, language: 'typescript' }] }),
        parsedFile('src/d.ts', { entities: [{ kind: 'class', name: 'D', qualifiedName: 'D', startLine: 1, endLine: 2, language: 'typescript' }] }),
      ]),
    );
    const capped = compareSnapshots(base, target, { maxChanges: 1 });
    expect(capped.changes).toHaveLength(1);
    expect(capped.counts.NODE_ADDED).toBe(compareSnapshots(base, target).counts.NODE_ADDED);
  });
});
