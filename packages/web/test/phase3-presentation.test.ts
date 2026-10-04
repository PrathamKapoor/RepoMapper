import { describe, expect, it } from 'vitest';
import {
  chainCounts,
  consistencyHeadline,
  consistencyNeedsAttention,
  orderFindings,
  orderRequirements,
  requirementReadability,
  requirementStatusLabel,
  traceView,
} from '../src/presentation';
import type {
  ConsistencyClass,
  ConsistencyFinding,
  ConsistencyReport,
  Requirement,
  Traceability,
} from '../src/api';

/**
 * Tests for the logic behind the requirements, consistency and traceability views.
 *
 * Scope, stated plainly: these cover the decisions the views make, not their rendering. There is
 * no DOM test in this repository, so nothing here proves React renders them. See
 * `docs/verification.md`.
 *
 * The assertions concentrate on wording. A view that says "3 problems" when it ran three checks
 * is misleading in a way no test of layout would catch.
 */

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'r1',
    category: 'declared',
    statement: 'The system shall do the thing',
    status: 'OBSERVED',
    confidence: 'EXPLICIT',
    origin: 'declared',
    derivation: 'A requirement entity exists in the graph.',
    evidence: [],
    supportedByNodeIds: [],
    supportedByEdgeIds: [],
    ...overrides,
  };
}

function finding(overrides: Partial<ConsistencyFinding> = {}): ConsistencyFinding {
  return {
    id: 'rule:subject',
    rule: 'rule',
    class: 'MISSING_EVIDENCE',
    severity: 'info',
    title: 'Something',
    detail: 'Detail',
    artifacts: ['sequence'],
    nodeIds: [],
    edgeIds: [],
    evidenceExpected: 'A relationship.',
    evidenceFound: 'None.',
    derivation: 'Compared the graph with the view.',
    confidence: 'EXPLICIT',
    ...overrides,
  };
}

function report(overrides: Partial<ConsistencyReport> = {}): ConsistencyReport {
  return {
    findings: [],
    counts: {
      CONTRADICTION: 0,
      MISSING_EVIDENCE: 0,
      PARTIAL_EVIDENCE: 0,
      UNSUPPORTED_INFERENCE: 0,
      CONSISTENT: 0,
    },
    compared: ['requirements', 'sequence'],
    summary: 'nothing to report',
    ...overrides,
  };
}

function trace(overrides: Partial<Traceability> = {}): Traceability {
  return {
    subject: { id: 'api_endpoint:get-/x', name: 'GET /x', kind: 'api_endpoint' },
    links: [],
    breaks: [],
    complete: true,
    summary: 'nothing traces',
    ...overrides,
  };
}

describe('requirement readability', () => {
  it('separates a stated requirement from a derived one', () => {
    expect(requirementReadability(requirement())).toBe('stated');
    expect(requirementReadability(requirement({ origin: 'derived', category: 'interface_behaviour' }))).toBe('derived');
  });

  it('reports a partly evidenced requirement as partial whatever its origin', () => {
    expect(requirementReadability(requirement({ status: 'PARTIAL' }))).toBe('partial');
    expect(requirementReadability(requirement({ status: 'UNKNOWN', origin: 'derived' }))).toBe('partial');
  });

  it('reports an unsupported claim as unsupported', () => {
    expect(requirementReadability(requirement({ status: 'UNSUPPORTED' }))).toBe('unsupported');
  });

  it('labels a stated requirement as stated, not as verified', () => {
    // "stated by the repository" is the truth; "verified" would be a claim the repository
    // cannot make about itself.
    expect(requirementStatusLabel(requirement())).toBe('stated by the repository');
    expect(requirementStatusLabel(requirement({ origin: 'derived', category: 'interface_behaviour' }))).toBe(
      'derived from code',
    );
    expect(requirementStatusLabel(requirement({ status: 'PARTIAL' }))).toBe('partly evidenced');
  });
});

describe('requirement ordering', () => {
  it('puts stated requirements before derived ones, then sorts by id', () => {
    const ordered = orderRequirements([
      requirement({ id: 'd2', origin: 'derived', category: 'persistence_behaviour' }),
      requirement({ id: 'a1' }),
      requirement({ id: 'd1', origin: 'derived', category: 'interface_behaviour' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a1', 'd1', 'd2']);
  });

  it('is stable for the same input', () => {
    const input = [requirement({ id: 'b' }), requirement({ id: 'a' })];
    expect(orderRequirements(input).map((entry) => entry.id)).toEqual(orderRequirements(input).map((entry) => entry.id));
  });

  it('does not mutate its input', () => {
    const input = [requirement({ id: 'b' }), requirement({ id: 'a' })];
    orderRequirements(input);
    expect(input.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('consistency headline', () => {
  it('never leads with problems without saying how many representations were compared', () => {
    const text = consistencyHeadline(
      report({
        counts: {
          CONTRADICTION: 0,
          MISSING_EVIDENCE: 2,
          PARTIAL_EVIDENCE: 1,
          UNSUPPORTED_INFERENCE: 0,
          CONSISTENT: 1,
        },
        compared: ['requirements', 'sequence', 'data-flow'],
      }),
      false,
      null,
    );
    expect(text).toContain('3 claim(s)');
    expect(text).toContain('3 representations');
    expect(text).toContain('Absence is reported as absence');
  });

  it('says so when everything agrees', () => {
    const text = consistencyHeadline(report({ counts: { ...report().counts, CONSISTENT: 3 } }), false, null);
    expect(text).toContain('3 agreement(s) confirmed');
    expect(text).toContain('nothing left unevidenced');
  });

  it('distinguishes loading, error and loaded', () => {
    expect(consistencyHeadline(null, true, null)).toContain('Checking');
    expect(consistencyHeadline(null, false, 'boom')).toContain('boom');
    expect(consistencyHeadline(report(), false, null)).toBeTypeOf('string');
  });

  it('does not claim agreement it did not find', () => {
    const text = consistencyHeadline(report(), false, null);
    expect(text).toContain('Nothing could be established');
    expect(text).toContain('different from agreement');
  });
});

describe('consistency ordering', () => {
  it('puts a contradiction first and agreement last', () => {
    const ordered = orderFindings([
      finding({ id: 'agree', class: 'CONSISTENT' }),
      finding({ id: 'missing', class: 'MISSING_EVIDENCE' }),
      finding({ id: 'partial', class: 'PARTIAL_EVIDENCE' }),
      finding({ id: 'bad', class: 'UNSUPPORTED_INFERENCE' }),
      finding({ id: 'clash', class: 'CONTRADICTION' }),
    ]);
    expect(ordered.map((entry) => entry.class)).toEqual([
      'CONTRADICTION',
      'UNSUPPORTED_INFERENCE',
      'PARTIAL_EVIDENCE',
      'MISSING_EVIDENCE',
      'CONSISTENT',
    ]);
  });

  it('sorts by id within a class', () => {
    const ordered = orderFindings([finding({ id: 'b' }), finding({ id: 'a' })]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('covers every class it is given', () => {
    const classes: ConsistencyClass[] = ['CONSISTENT', 'MISSING_EVIDENCE', 'PARTIAL_EVIDENCE', 'UNSUPPORTED_INFERENCE', 'CONTRADICTION'];
    expect(orderFindings(classes.map((value) => finding({ id: value, class: value })))).toHaveLength(classes.length);
  });
});

describe('consistency attention', () => {
  it('is needed only for a contradiction or an unsupported inference', () => {
    expect(consistencyNeedsAttention(report())).toBe(false);
    expect(consistencyNeedsAttention(report({ counts: { ...report().counts, MISSING_EVIDENCE: 4 } }))).toBe(false);
    expect(consistencyNeedsAttention(report({ counts: { ...report().counts, UNSUPPORTED_INFERENCE: 1 } }))).toBe(true);
    expect(consistencyNeedsAttention(report({ counts: { ...report().counts, CONTRADICTION: 1 } }))).toBe(true);
  });

  it('is false when there is no report, so an empty view never looks alarming', () => {
    expect(consistencyNeedsAttention(null)).toBe(false);
  });
});

describe('trace view', () => {
  it('separates a complete chain from a broken one', () => {
    const complete = traceView(trace(), false, null);
    expect(complete.kind).toBe('complete');

    const broken = traceView(
      trace({ complete: false, breaks: [{ kind: 'NO_TEST', reason: 'no test calls the handler' }] }),
      false,
      null,
    );
    expect(broken.kind).toBe('broken');
    expect(broken.kind === 'broken' && broken.breaks[0]?.kind).toBe('NO_TEST');
  });

  it('does not present loading as a result', () => {
    expect(traceView(null, true, null).kind).toBe('missing');
    expect(traceView(null, true, null).text).toContain('Following');
  });

  it('shows the error rather than an empty chain', () => {
    const view = traceView(null, false, 'boom');
    expect(view.text).toContain('boom');
  });
});

describe('chain counts', () => {
  it('always reports all four joints, zeros included', () => {
    const counts = chainCounts(
      trace({
        links: [
          { role: 'requirement', id: 'r', label: 'r', kind: 'declared', edgeIds: [], evidence: [], confidence: 'EXPLICIT' },
          { role: 'implementation', id: 'i', label: 'i', kind: 'function', edgeIds: [], evidence: [], confidence: 'EXPLICIT' },
          { role: 'test', id: 't', label: 't', kind: 'test', edgeIds: [], evidence: [], confidence: 'EXPLICIT' },
        ],
      }),
    );
    expect(counts).toEqual([
      { role: 'requirement', count: 1 },
      { role: 'use_case', count: 0 },
      { role: 'implementation', count: 1 },
      { role: 'test', count: 1 },
    ]);
  });

  it('reports zeros for a chain that has not loaded', () => {
    expect(chainCounts(null).every((entry) => entry.count === 0)).toBe(true);
  });
});