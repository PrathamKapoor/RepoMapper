import { describe, expect, it } from 'vitest';
import {
  analysisForChange,
  comparableAnalysisCount,
  defaultComparisonId,
  describeSupport,
  driftState,
  isExistenceOnly,
  removalsAreAssertable,
} from '../src/presentation';
import type { AnalysisListEntry, ArtifactEdge, DriftChange, DriftReport } from '../src/api';

/**
 * Tests for the logic behind the C4 and Drift views.
 *
 * Scope, stated plainly: this covers the decisions those views make, not their rendering.
 * There is no DOM or browser test in this repository, so nothing here proves that React renders
 * these screens. See `docs/verification.md`.
 */

function analysis(overrides: Partial<AnalysisListEntry> = {}): AnalysisListEntry {
  return {
    id: 'a1',
    repositoryName: 'repo',
    repositoryPath: '/repo',
    label: null,
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    durationMs: 10,
    headCommit: null,
    branch: null,
    summary: null,
    error: null,
    ...overrides,
  };
}

function report(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    base: {
      snapshotId: 'snap_a',
      analysisId: 'a1',
      repositoryName: 'repo',
      repositoryPath: '/repo',
      sourceRevision: null,
      branch: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      graphDigest: 'a'.repeat(64),
      extractorVersion: '1.0.0',
      graphSchemaVersion: 2,
      truncated: false,
    },
    target: {
      snapshotId: 'snap_b',
      analysisId: 'a2',
      repositoryName: 'repo',
      repositoryPath: '/repo',
      sourceRevision: null,
      branch: null,
      createdAt: '2026-02-01T00:00:00.000Z',
      graphDigest: 'b'.repeat(64),
      extractorVersion: '1.0.0',
      graphSchemaVersion: 2,
      truncated: false,
    },
    identical: false,
    comparable: true,
    incomparabilityReason: null,
    targetIncomplete: false,
    removalConfidence: 'EXPLICIT',
    counts: {} as DriftReport['counts'],
    summary: {} as DriftReport['summary'],
    changes: [],
    ...overrides,
  };
}

function change(overrides: Partial<DriftChange> = {}): DriftChange {
  return {
    category: 'NODE_ADDED',
    entityKind: 'node',
    entityId: 'class:x',
    label: 'X',
    evidenceBefore: [],
    evidenceAfter: [],
    confidence: 'EXPLICIT',
    claimConfidence: 'EXPLICIT',
    indeterminate: false,
    ...overrides,
  };
}

describe('inspecting a drift change', () => {
  it('opens an addition in the target state, where the entity exists', () => {
    expect(analysisForChange(change(), report())).toBe('a2');
  });

  it('opens a removal in the base state, because the entity is not in the target', () => {
    expect(analysisForChange(change({ category: 'NODE_REMOVED' }), report())).toBe('a1');
  });

  it('opens a rename in the target state, under its new identity', () => {
    expect(analysisForChange(change({ category: 'NODE_RENAMED', previousEntityId: 'module:old' }), report())).toBe('a2');
  });

  it('refuses to inspect an evidence record as an entity', () => {
    expect(analysisForChange(change({ entityKind: 'evidence' }), report())).toBeNull();
  });
});

describe('drift state', () => {
  it('reports changed when the snapshots differ', () => {
    expect(driftState(report(), false, null)).toBe('changed');
  });

  it('reports identical only when the report says the digests matched', () => {
    expect(driftState(report({ identical: true }), false, null)).toBe('identical');
  });

  it('reports incomparable when the machinery differed, not identical', () => {
    const state = driftState(
      report({ identical: false, comparable: false, incomparabilityReason: 'Extractor versions differ' }),
      false,
      null,
    );
    expect(state).toBe('incomparable');
  });

  it('never reports unknown as identical', () => {
    // The distinction that matters: "we do not know" must not render as "we checked".
    expect(driftState(null, false, null)).toBe('unknown');
    expect(driftState(null, true, null)).toBe('unknown');
    expect(driftState(null, false, 'boom')).toBe('unknown');
    expect(driftState(null, false, null)).not.toBe('identical');
  });

  it('withholds removals as assertions when the target analysis was incomplete', () => {
    expect(removalsAreAssertable(report())).toBe(true);
    expect(removalsAreAssertable(report({ targetIncomplete: true, removalConfidence: 'INDETERMINATE' }))).toBe(false);
    expect(removalsAreAssertable(null)).toBe(false);
  });
});

describe('C4 relationship support', () => {
  const edge = (overrides: Partial<ArtifactEdge>): ArtifactEdge => ({
    id: 'c4:component:a|depends_on|b',
    kind: 'depends_on',
    source: 'a',
    target: 'b',
    confidence: 'EXPLICIT',
    evidence: [],
    ...overrides,
  });

  it('names the graph edges that justify a relationship', () => {
    const described = describeSupport(edge({ supportingEdgeIds: ['a|imports|b'] }));
    expect(described).toBe('edge a|imports|b');
  });

  it('names graph nodes when support is the existence of an element', () => {
    const described = describeSupport(edge({ supportingNodeIds: ['deployment_component:db'] }));
    expect(described).toBe('node deployment_component:db');
    // Existence-only support is weaker and is labelled as such.
    expect(isExistenceOnly(edge({ supportingNodeIds: ['deployment_component:db'] }))).toBe(true);
  });

  it('reports no support for a relationship that has none', () => {
    // Unreachable through the projection's gate. Returning null lets the UI say so rather than
    // drawing an arrow that looks evidenced.
    expect(describeSupport(edge({}))).toBeNull();
    expect(isExistenceOnly(edge({}))).toBe(false);
  });

  it('prefers edge support when both kinds are present', () => {
    const both = edge({ supportingEdgeIds: ['a|calls|b'], supportingNodeIds: ['deployment_component:db'] });
    expect(describeSupport(both)).toBe('edge a|calls|b, node deployment_component:db');
    expect(isExistenceOnly(both)).toBe(false);
  });
});

describe('choosing what to compare against', () => {
  const a1 = analysis({ id: 'a1', createdAt: '2026-01-01T00:00:00.000Z' });
  const a2 = analysis({ id: 'a2', createdAt: '2026-02-01T00:00:00.000Z' });
  const a3 = analysis({ id: 'a3', createdAt: '2026-03-01T00:00:00.000Z' });

  it('defaults to the previous analysis', () => {
    expect(defaultComparisonId([a3, a1, a2], 'a3')).toBe('a2');
    expect(defaultComparisonId([a3, a1, a2], 'a2')).toBe('a1');
  });

  it('never defaults to the analysis being viewed', () => {
    expect(defaultComparisonId([a1], 'a1')).toBeNull();
    expect(defaultComparisonId([a1], 'missing')).toBe('a1');
  });

  it('does not compare against an analysis that has no graph', () => {
    const running = analysis({ id: 'a4', createdAt: '2026-04-01T00:00:00.000Z', status: 'running' });
    expect(defaultComparisonId([running, a1], 'a1')).toBeNull();
  });

  it('counts only analyses that can take part in a comparison', () => {
    expect(comparableAnalysisCount([a1, a2, analysis({ id: 'a3', status: 'failed' })])).toBe(2);
    expect(comparableAnalysisCount([])).toBe(0);
  });
});
