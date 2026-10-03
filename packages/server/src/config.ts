import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Server configuration.
 *
 * Every value is environment-driven and validated once at startup. Invalid
 * configuration fails fast with a readable message rather than surfacing as a
 * confusing runtime error later.
 *
 * Security-relevant defaults are deliberately restrictive:
 *  - `REPOATLAS_ALLOWED_ROOTS` is unset by default, which means no allow-list. That is
 *    recorded in `/api/health` as `pathAllowListEnforced: false` so an operator can see
 *    the exposure rather than assume containment.
 *  - CORS is off unless explicitly enabled.
 *  - Request body size is capped so an oversized upload cannot exhaust memory.
 */

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_300),
  /**
   * Repository roots the API will analyse. Empty means "no allow-list", which is only
   * acceptable when the process is confined by other means (container, private host).
   */
  REPOATLAS_ALLOWED_ROOTS: z.string().default(''),
  REPOATLAS_DB_PATH: z.string().default('var/repoatlas.sqlite'),
  REPOATLAS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(256 * 1024 * 1024),
  REPOATLAS_MAX_ANALYSES: z.coerce.number().int().min(1).default(50),
  REPOATLAS_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  REPOATLAS_CORS_ORIGIN: z.string().default(''),
  REPOATLAS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REPOATLAS_INCLUDE_GIT: booleanFromEnv.default(true),
  REPOATLAS_STATIC_DIR: z.string().default(''),
  REPOATLAS_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
});

export interface ServerConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  /** Absolute, resolved allow-listed roots. Empty when no allow-list is configured. */
  allowedRoots: string[];
  pathAllowListEnforced: boolean;
  dbPath: string;
  maxUploadBytes: number;
  maxAnalyses: number;
  concurrency: number;
  corsOrigin: string | null;
  logLevel: string;
  includeGitHistory: boolean;
  /** Directory containing the built web UI. Served when it exists. */
  staticDir: string | null;
  analysisTimeoutMs: number;
  isProduction: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid RepoAtlas configuration — ${issues}`);
  }
  const env = parsed.data;

  const allowedRoots = env.REPOATLAS_ALLOWED_ROOTS.split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));

  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    allowedRoots,
    pathAllowListEnforced: allowedRoots.length > 0,
    dbPath: resolve(env.REPOATLAS_DB_PATH),
    maxUploadBytes: env.REPOATLAS_MAX_UPLOAD_BYTES,
    maxAnalyses: env.REPOATLAS_MAX_ANALYSES,
    concurrency: env.REPOATLAS_CONCURRENCY,
    corsOrigin: env.REPOATLAS_CORS_ORIGIN.length > 0 ? env.REPOATLAS_CORS_ORIGIN : null,
    logLevel: env.REPOATLAS_LOG_LEVEL,
    includeGitHistory: env.REPOATLAS_INCLUDE_GIT,
    staticDir: env.REPOATLAS_STATIC_DIR.length > 0 ? resolve(env.REPOATLAS_STATIC_DIR) : null,
    analysisTimeoutMs: env.REPOATLAS_ANALYSIS_TIMEOUT_MS,
    isProduction: env.NODE_ENV === 'production',
  };
}

/** Reads a `REPOATLAS_SECRET`-style value without ever logging it. */
export function readSecret(name: string, source: NodeJS.ProcessEnv = process.env): string | null {
  const value = source[name];
  return value && value.length > 0 ? value : null;
}