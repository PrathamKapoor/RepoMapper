import type { AnalysisLimits, AnalysisOptions } from './types.js';

/**
 * Default safety limits.
 *
 * Repositories are untrusted and can be arbitrarily large, so every ingestion and
 * parsing stage is bounded. Exceeding a limit degrades the analysis (files or
 * nodes are skipped and reported) rather than failing the run or exhausting memory.
 *
 * Values are chosen to comfortably fit a large monorepo on a modest machine while
 * stopping pathological inputs. They are overridable per analysis via the API.
 */
export const DEFAULT_LIMITS: AnalysisLimits = {
  maxFiles: 20_000,
  maxFileBytes: 1_000_000, // 1 MB — larger source files are almost always generated
  maxTotalBytes: 512_000_000, // 512 MB of source text across the repository
  maxParseErrorsPerFile: 50,
  maxExcerptChars: 240,
  maxNodes: 400_000,
  maxEdges: 800_000,
  maxCallRecordsPerFile: 5_000,
};

export const DEFAULT_OPTIONS: AnalysisOptions = {
  limits: DEFAULT_LIMITS,
  languages: [],
  includeGitHistory: true,
  enableInference: false,
  maxCommits: 2_000,
};

/** Clamps user-supplied limits into a safe band. Never trusts the request. */
export function resolveLimits(partial: Partial<AnalysisLimits> | undefined): AnalysisLimits {
  const merged = { ...DEFAULT_LIMITS, ...partial };
  return {
    maxFiles: clampInteger(merged.maxFiles, 1, 200_000, DEFAULT_LIMITS.maxFiles),
    maxFileBytes: clampInteger(merged.maxFileBytes, 1_024, 20_000_000, DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: clampInteger(merged.maxTotalBytes, 1_024, 4_000_000_000, DEFAULT_LIMITS.maxTotalBytes),
    maxParseErrorsPerFile: clampInteger(merged.maxParseErrorsPerFile, 1, 1_000, DEFAULT_LIMITS.maxParseErrorsPerFile),
    maxExcerptChars: clampInteger(merged.maxExcerptChars, 40, 2_000, DEFAULT_LIMITS.maxExcerptChars),
    maxNodes: clampInteger(merged.maxNodes, 100, 5_000_000, DEFAULT_LIMITS.maxNodes),
    maxEdges: clampInteger(merged.maxEdges, 100, 10_000_000, DEFAULT_LIMITS.maxEdges),
    maxCallRecordsPerFile: clampInteger(
      merged.maxCallRecordsPerFile,
      10,
      100_000,
      DEFAULT_LIMITS.maxCallRecordsPerFile,
    ),
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
