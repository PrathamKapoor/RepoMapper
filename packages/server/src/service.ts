import { randomUUID } from 'node:crypto';
import {
  AnalysisError,
  compareSnapshots,
  createSnapshot,
  describeError,
  type AnalysisRecord,
  type AnalysisRequest,
  type AnalysisResult,
  type AnalysisSnapshot,
  type CompareOptions,
  type DiagnosticCollector,
  type DriftReport,
} from '@repoatlas/core';
import { projectAtlas, type AtlasProjection } from '@repoatlas/artifacts';
import { runAnalysis, type RunAnalysisOutput } from './analyze.js';
import type { ServerConfig } from './config.js';
import type { Store } from './store.js';

/**
 * Analysis service.
 *
 * Owns the lifecycle of an analysis: admission control, execution, persistence and
 * status reporting. The HTTP layer only calls this; it contains no analysis logic.
 *
 * Analyses run inline rather than in a background queue. That is a deliberate phase-1
 * trade-off: it makes every request deterministic and testable, and a request that
 * outlasts the HTTP timeout returns a real error rather than a job id that nothing
 * polls. `maxAnalyses` and `concurrency` bound the work so a burst cannot exhaust the
 * process. Moving to a durable queue is a later decision, recorded in decisions.md.
 */

export interface AnalysisServiceOptions {
  config: ServerConfig;
  store: Store;
  /** Injected in tests to avoid touching the filesystem. */
  runner?: typeof runAnalysis;
  idFactory?: () => string;
  now?: () => Date;
}

export interface AnalysisListEntry {
  id: string;
  repositoryName: string;
  repositoryPath: string;
  label: string | null;
  status: AnalysisRecord['status'];
  createdAt: string;
  durationMs: number | null;
  headCommit: string | null;
  branch: string | null;
  summary: AnalysisRecord['summary'];
  error: AnalysisRecord['error'];
}

export class AnalysisService {
  private readonly config: ServerConfig;
  private readonly store: Store;
  private readonly runner: typeof runAnalysis;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private running = 0;

  constructor(options: AnalysisServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.runner = options.runner ?? runAnalysis;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs a new analysis and persists it.
   *
   * Throws `AnalysisError` for conditions the caller caused (bad path, not allowed,
   * too many analyses); infrastructure failures are persisted as a failed record and
   * rethrown so the API can report the right status code either way.
   */
  async analyse(request: AnalysisRequest): Promise<{ record: AnalysisRecord; output: RunAnalysisOutput }> {
    if (this.running >= this.config.concurrency) {
      throw new AnalysisError(
        'INTERNAL_ERROR',
        `Server is at its analysis concurrency limit (${this.config.concurrency}). Retry shortly.`,
        429,
      );
    }
    if (this.store.countAnalyses() >= this.config.maxAnalyses) {
      throw new AnalysisError(
        'INTERNAL_ERROR',
        `Stored analysis limit (${this.config.maxAnalyses}) reached. Delete an analysis before starting a new one.`,
        507,
      );
    }

    const id = this.idFactory();
    const createdAt = this.now().toISOString();

    this.running += 1;
    try {
      const output = await this.withTimeout(
        this.runner({
          repositoryPath: request.repositoryPath,
          label: request.label,
          options: request.options,
          allowedRoots: this.config.allowedRoots,
          includeGitHistory: this.config.includeGitHistory && (request.options?.includeGitHistory ?? true),
        }),
      );

      const record: AnalysisRecord = { ...output.analysis, id, createdAt, status: 'succeeded' };

      const snapshot = createSnapshot({
        analysisId: record.id,
        repositoryPath: record.repositoryPath,
        repositoryName: record.repositoryName,
        createdAt: record.createdAt,
        sourceRevision: record.headCommit,
        branch: record.branch,
        truncated: output.analysis.summary?.truncated ?? false,
        graph: output.graph,
      });

      const stored: AnalysisRecord = {
        ...record,
        graphDigest: snapshot.provenance.graphDigest,
        extractorVersion: snapshot.provenance.extractorVersion,
        graphSchemaVersion: snapshot.provenance.graphSchemaVersion,
      };

      this.store.saveAnalysis({
        analysis: stored,
        graph: output.graph,
        diagnostics: output.diagnostics,
        graphDigest: snapshot.provenance.graphDigest,
        extractorVersion: snapshot.provenance.extractorVersion,
        artifacts: output.projection.artifacts.map((artifact) => ({
          kind: artifact.kind,
          title: artifact.title,
          format: artifact.format,
          body: artifact,
        })),
      });

      return { record: stored, output };
    } catch (error) {
      const described = describeError(error);
      const failed: AnalysisRecord = {
        id,
        repositoryPath: request.repositoryPath,
        repositoryName: 'unknown',
        label: request.label ?? null,
        status: 'failed',
        createdAt,
        completedAt: this.now().toISOString(),
        durationMs: null,
        headCommit: null,
        branch: null,
        error: {
          code: error instanceof AnalysisError ? error.code : 'INTERNAL_ERROR',
          message: described.message,
        },
        summary: null,
        warnings: [],
      };
      this.store.saveFailure(failed);
      throw error;
    } finally {
      this.running -= 1;
    }
  }

  get(id: string): AnalysisRecord | null {
    return this.store.getAnalysis(id);
  }

  list(limit: number): AnalysisListEntry[] {
    return this.store.listAnalyses(limit).map((record) => ({
      id: record.id,
      repositoryName: record.repositoryName,
      repositoryPath: record.repositoryPath,
      label: record.label,
      status: record.status,
      createdAt: record.createdAt,
      durationMs: record.durationMs,
      headCommit: record.headCommit,
      branch: record.branch,
      summary: record.summary,
      error: record.error,
    }));
  }

  remove(id: string): boolean {
    return this.store.deleteAnalysis(id);
  }

  /**
   * Rebuilds the snapshot for a stored analysis.
   *
   * Derived from the persisted graph rather than cached, so a schema or extractor change
   * cannot leave a stale identity behind.
   *
   * Returns `null` for an unknown analysis **and for one that did not succeed**. A failed
   * analysis has no graph rows, so loading it would yield an empty graph whose every
   * comparison reports the whole system as removed. Refusing is the difference between
   * "this changed" and "this was never read".
   */
  getSnapshot(id: string): AnalysisSnapshot | null {
    const record = this.store.getAnalysis(id);
    if (!record || record.status !== 'succeeded') return null;
    const graph = this.store.getGraph(id);
    if (!graph || graph.nodes.length === 0) return null;

    return createSnapshot({
      analysisId: record.id,
      repositoryPath: record.repositoryPath,
      repositoryName: record.repositoryName,
      createdAt: record.createdAt,
      sourceRevision: record.headCommit,
      branch: record.branch,
      truncated: record.summary?.truncated ?? false,
      graph,
    });
  }

  /**
   * Compares two stored analyses.
   *
   * The base is the older state and the target the newer one. Ordering is decided by
   * creation time, not by argument order, so a caller cannot accidentally invert the
   * direction of a drift report.
   */
  compareAnalyses(baseId: string, targetId: string, options?: CompareOptions): DriftReport | null {
    const base = this.getSnapshot(baseId);
    const target = this.getSnapshot(targetId);
    if (!base || !target) return null;

    const [older, newer] =
      base.provenance.createdAt <= target.provenance.createdAt ? [base, target] : [target, base];

    return compareSnapshots(older, newer, options);
  }

  /** Reconstructs the full API-shaped result for a stored analysis. */
  getResult(id: string): (AnalysisResult & { projection: AtlasProjection }) | null {
    const record = this.store.getAnalysis(id);
    const graph = this.store.getGraph(id);
    if (!record || !graph) return null;

    // Artifacts and gaps are re-derived from the stored graph rather than read from a
    // cached blob, so a change to a projection is reflected without re-analysing.
    const projection = projectAtlas(graph);

    return {
      analysis: record,
      graph,
      stats: projection.stats,
      projection,
    };
  }

  /** Runs a promise with a hard timeout so one pathological repository cannot hang the API. */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AnalysisError(
              'INTERNAL_ERROR',
              `Analysis exceeded the ${this.config.analysisTimeoutMs} ms limit and was abandoned`,
              504,
            ),
          ),
        this.config.analysisTimeoutMs,
      );
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * `projectAtlas` lives in the artifacts package, which depends only on the core model.
 * Importing it directly keeps the dependency explicit and the bundler-free build simple.
 */
export type { DiagnosticCollector };