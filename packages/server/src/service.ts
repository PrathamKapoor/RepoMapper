import { randomUUID } from 'node:crypto';
import {
  AnalysisError,
  describeError,
  type AnalysisRecord,
  type AnalysisRequest,
  type AnalysisResult,
  type DiagnosticCollector,
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

      this.store.saveAnalysis({
        analysis: record,
        graph: output.graph,
        diagnostics: output.diagnostics,
        artifacts: output.projection.artifacts.map((artifact) => ({
          kind: artifact.kind,
          title: artifact.title,
          format: artifact.format,
          body: artifact,
        })),
      });

      return { record, output };
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