import type {
  Confidence,
  EvidenceRef,
  GraphNode,
  SoftwareGraph,
  VerificationOutcome,
  VerificationStatus,
} from './types.js';

/**
 * Phase 6: controlled runtime verification.
 *
 * ## Why this is not part of analysis
 *
 * A repository is untrusted input. `runAnalysis` reads files and nothing else — it never executes
 * them, never runs a package script, never starts a container. That is what makes it safe to point
 * at any repository an operator hands it, and it is the property this module is designed to
 * preserve rather than extend.
 *
 * So verification lives here, is never called from the analysis pipeline, and produces records
 * that are **stored alongside** the graph rather than merged into it. A `VERIFIED` status is an
 * observation made about a specific deployment at a specific time; a `DECLARED` fact is what a
 * file says. Overwriting the second with the first would make the graph stop describing the
 * repository, which is the one thing it exists to do.
 *
 * ## Why `VERIFIED` is not a confidence
 *
 * `Confidence` answers "how strongly do we believe this?". Every Phase 1-5 fact is a statement
 * about a file, and a compose `depends_on` is `EXPLICIT` — the file says it, unambiguously.
 *
 * `VerificationStatus` answers a different question: *did anyone observe this?* The honest answer
 * is almost always "no", for a fact we are otherwise entirely certain about. Keeping the two axes
 * apart is what stops the two opposite errors — calling a certain declaration a guess, and calling
 * an unobserved deployment certain.
 *
 * ## What verification may conclude
 *
 * Only what it actually did:
 *
 *   succeeded      the observation was made and it matched what was declared
 *   failed         the observation was made and it did not match
 *   timed_out      the observation did not complete within its bound
 *   blocked        a precondition was not met, so nothing was attempted
 *   unavailable    no verification mechanism exists in this environment
 *   not_run        verification was never requested
 *
 * `failed` and `timed_out` are not `unknown`. A health check that ran and failed is a fact about
 * the world; one that could not run is a fact about the reader. Collapsing them makes a broken
 * service indistinguishable from an unverifiable one, which is the most damaging possible
 * confusion in this area (D-086).
 */

/** One controlled observation about one graph entity. */
export interface VerificationRecord {
  /** Deterministic: `verify:<runId>:<targetId>:<type>`. */
  id: string;
  /** The run this observation belongs to. */
  runId: string;
  /** Graph node this observation is about. */
  targetId: string;
  /** What was attempted, e.g. `container_starts`, `port_accepts`, `endpoint_responds`. */
  type: string;
  outcome: VerificationOutcome;
  /**
   * The status this observation establishes for the target.
   *
   * `VERIFIED` only ever comes from a `succeeded` outcome. A `failed` observation never marks
   * anything verified — it is the *opposite* of verified and is carried as its own outcome.
   */
  status: VerificationStatus;
  /** What was observed, in one sentence. Never a value, never a credential. */
  observation: string;
  /** ISO-8601. The record is about this moment, not about now. */
  observedAt: string;
  /** How long the observation took, in milliseconds. */
  durationMs: number;
  /** Evidence citations. A runtime observation cites a verification record, not a source line. */
  evidence: EvidenceRef[];
  /** Anything the observer learned that a reader needs, e.g. a truncated stdout. */
  notes?: string;
}

/** One execution of a verification procedure against a snapshot. */
export interface VerificationRun {
  id: string;
  /** The snapshot this run observed. A run never describes a different snapshot's state. */
  snapshotId: string;
  analysisId: string;
  startedAt: string;
  finishedAt: string;
  /** What was asked for. */
  requested: string[];
  /** What was actually attempted, which may be a subset. */
  attempted: string[];
  outcome: VerificationOutcome;
  records: VerificationRecord[];
  /**
   * Why nothing could be verified, when nothing was.
   *
   * Present because "verification is switched off" is the most common state in a fresh install,
   * and reporting it as an empty list of findings would read as "everything is fine".
   */
  blockedReason?: string;
}

/**
 * What verification is permitted to do, decided by the operator.
 *
 * Every limit is explicit and has a default. The default is `enabled: false` — a deployment of
 * RepoAtlas that has not been told it may observe anything observes nothing.
 */
export interface VerificationPolicy {
  /**
   * Master switch. Off by default, and `blocked` — not `unavailable` and not `not_run` — when a
   * caller asks for verification against a disabled policy, so the refusal is visible.
   */
  enabled: boolean;
  /** Hard ceiling on one observation. Exceeding it is `timed_out`, never a hang. */
  timeoutMs: number;
  /** Ceiling on observations per run. */
  maxObservations: number;
  /** Container runtime to use, e.g. `docker`. Absent means verification is unavailable. */
  runtime?: string;
  /**
   * Whether the analysed source may be mounted into the verification container.
   *
   * Defaults to `false` for a reason that is not configurable away: a repository's source is
   * exactly the untrusted input this product exists not to execute.
   */
  allowSourceMount: boolean;
  /** Memory ceiling applied to a verification container. */
  memoryLimitMb?: number;
  /** CPU ceiling applied to a verification container. */
  cpusLimit?: number;
  /** Whether the verification container may reach any network at all. */
  networkAccess: 'none' | 'internal_only';
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  enabled: false,
  timeoutMs: 60_000,
  maxObservations: 32,
  runtime: 'docker',
  // A repository's source is never mounted. Verification observes a *fixture the operator chose*,
  // not the analysed tree (D-088).
  allowSourceMount: false,
  memoryLimitMb: 512,
  cpusLimit: 1,
  networkAccess: 'none',
};

/**
 * Validates a requested observation before anything runs.
 *
 * Separated from execution so the safety rules are testable without a runtime, and so a refusal
 * is a first-class outcome rather than a thrown error. The order matters: a disabled policy is
 * reported before an over-long timeout, because an operator who has switched verification off
 * does not need to be told their timeout is also wrong.
 */
export function checkVerificationRequest(
  policy: VerificationPolicy,
  request: { types: string[]; timeoutMs?: number },
): { allowed: true } | { allowed: false; outcome: VerificationOutcome; reason: string } {
  if (!policy.enabled) {
    return {
      allowed: false,
      outcome: 'blocked',
      reason:
        'Runtime verification is disabled. Set REPOATLAS_VERIFICATION_ENABLED=true to permit it. Static analysis is unaffected: every deployment fact remains a declaration.',
    };
  }
  if (!policy.runtime) {
    return {
      allowed: false,
      outcome: 'unavailable',
      reason:
        'No container runtime is configured, so there is no way to observe a deployment. Nothing was attempted and nothing is known about whether the deployment works.',
    };
  }
  if (request.types.length === 0) {
    return { allowed: false, outcome: 'blocked', reason: 'No observation types were requested.' };
  }
  if (request.types.length > policy.maxObservations) {
    return {
      allowed: false,
      outcome: 'blocked',
      reason: `${request.types.length} observations requested, above the limit of ${policy.maxObservations}. Split the request.`,
    };
  }
  if (request.timeoutMs !== undefined && request.timeoutMs > policy.timeoutMs) {
    return {
      allowed: false,
      outcome: 'blocked',
      reason: `Requested timeout ${request.timeoutMs} ms exceeds the policy ceiling of ${policy.timeoutMs} ms.`,
    };
  }
  if (!policy.allowSourceMount && policy.networkAccess === 'none' && policy.runtime === 'untrusted') {
    return {
      allowed: false,
      outcome: 'blocked',
      reason: 'A verification run may not both mount untrusted source and deny the network.',
    };
  }
  return { allowed: true };
}

/**
 * The verification status a recorded observation establishes.
 *
 * Derived rather than supplied, so a caller cannot record `VERIFIED` for a run that failed. This
 * is the single place the mapping exists, and it is exhaustive over `VerificationOutcome`.
 */
export function statusForOutcome(outcome: VerificationOutcome): VerificationStatus {
  switch (outcome) {
    case 'succeeded':
      return 'VERIFIED';
    case 'failed':
      // A failed observation is a real observation. It establishes that the claim did *not* hold
      // at this moment, which is emphatically not `VERIFIED` and is not `UNKNOWN` either.
      return 'UNKNOWN';
    case 'timed_out':
    case 'blocked':
    case 'unavailable':
    case 'not_run':
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/** A `run_verification` refusal, ready for the API layer. */
export function blockedRun(input: {
  runId: string;
  snapshotId: string;
  analysisId: string;
  startedAt: string;
  requested: string[];
  outcome: VerificationOutcome;
  reason: string;
}): VerificationRun {
  return {
    id: input.runId,
    snapshotId: input.snapshotId,
    analysisId: input.analysisId,
    startedAt: input.startedAt,
    finishedAt: input.startedAt,
    requested: input.requested,
    attempted: [],
    outcome: input.outcome,
    records: [],
    blockedReason: input.reason,
  };
}

/**
 * The deployment claims a graph holds, as a target list for verification.
 *
 * Only claims a runtime can actually speak to are returned. A compose `networks:` membership is
 * not one of them — nothing outside the container observes which network a service joined — and
 * offering it as a target would invite a runner that reports `succeeded` for a check that never
 * happened.
 */
export function verifiableTargets(graph: SoftwareGraph): { nodeId: string; label: string; checks: string[] }[] {
  const targets: { nodeId: string; label: string; checks: string[] }[] = [];

  for (const node of graph.nodes) {
    if (node.kind === 'deployment_component' && node.attributes?.declaredAs === 'service') {
      targets.push({ nodeId: node.id, label: node.name, checks: ['container_starts', 'health_status'] });
      continue;
    }
    if (node.kind === 'port') {
      targets.push({ nodeId: node.id, label: `${node.name} (${node.qualifiedName ?? ''})`, checks: ['port_accepts'] });
      continue;
    }
    if (node.kind === 'api_endpoint' && isHealthEndpoint(node)) {
      targets.push({ nodeId: node.id, label: node.name, checks: ['endpoint_responds'] });
    }
  }

  return targets.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/**
 * Whether an endpoint looks like a health endpoint.
 *
 * A **name** test, and only a name test. It selects which endpoint is worth an observation; it is
 * not evidence that the endpoint is a health check, and an observation against it is reported
 * with whatever it actually returned rather than as a pass.
 */
function isHealthEndpoint(node: GraphNode): boolean {
  const path = String(node.attributes?.path ?? '');
  return /\/(health|healthz|readyz|livez|ping|status)\b/i.test(path);
}

/** The confidence of the underlying declaration, which verification does not change. */
export function declaredConfidenceOf(node: GraphNode | undefined): Confidence {
  return node?.confidence ?? 'UNKNOWN';
}

/**
 * The verification status of a graph entity, as of a set of records.
 *
 * `VERIFIED` only when a record for this target succeeded. The most recent record wins, so a
 * deployment that was verified an hour ago and has since failed reads as failed — presenting the
 * earlier success as current would be the same mistake as presenting a historical success as
 * "currently running".
 */
export function statusForTarget(records: readonly VerificationRecord[], targetId: string): VerificationStatus {
  const forTarget = records.filter((record) => record.targetId === targetId);
  if (forTarget.length === 0) return 'UNKNOWN';
  const latest = [...forTarget].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1);
  if (!latest) return 'UNKNOWN';
  return statusForOutcome(latest.outcome);
}

/** The most recent record for a target, or `null` when nothing has been observed. */
export function latestRecordFor(
  records: readonly VerificationRecord[],
  targetId: string,
): VerificationRecord | null {
  return (
    [...records]
      .filter((record) => record.targetId === targetId)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
      .at(-1) ?? null
  );
}

/**
 * The word a reader must see next to a status.
 *
 * Deliberately not derived from `status` alone: `UNKNOWN` after a *failed* check and `UNKNOWN`
 * after no check are the same status and completely different sentences, and the sentence is what
 * the reader actually needs.
 */
export function statusSentence(record: VerificationRecord | null): string {
  if (!record) return 'Not observed. No controlled verification has been run against this.';
  switch (record.outcome) {
    case 'succeeded':
      return `Verified on ${record.observedAt}. ${record.observation} This is an observation from that moment, not a statement about now.`;
    case 'failed':
      return `Verification ran and failed on ${record.observedAt}. ${record.observation} This is not "unknown" — the check was made and did not hold.`;
    case 'timed_out':
      return `Verification timed out on ${record.observedAt} after ${record.durationMs} ms. Nothing was concluded about whether the deployment works.`;
    case 'blocked':
      return `Verification was blocked on ${record.observedAt}. ${record.observation}`;
    case 'unavailable':
      return `No verification mechanism was available on ${record.observedAt}. ${record.observation}`;
    case 'not_run':
      return `Verification was requested but has not run. ${record.observation}`;
    default:
      return 'No observation recorded.';
  }
}