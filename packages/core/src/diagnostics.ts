/**
 * Structured diagnostics.
 *
 * Every stage of the pipeline reports problems as typed diagnostics rather than
 * throwing, so a single malformed file degrades one part of the analysis instead
 * of failing the run. The API surfaces these to the UI verbatim.
 */

export const DIAGNOSTIC_CODES = [
  'BAD_REQUEST',
  'PATH_NOT_FOUND',
  'PATH_NOT_A_DIRECTORY',
  'PATH_NOT_ALLOWED',
  'PATH_ESCAPE_BLOCKED',
  'PERMISSION_DENIED',
  'REPOSITORY_EMPTY',
  'GIT_UNAVAILABLE',
  'GIT_NOT_A_REPOSITORY',
  'GIT_TIMEOUT',
  'FILE_UNREADABLE',
  'FILE_TOO_LARGE',
  'BINARY_FILE',
  'SYMLINK_ESCAPE',
  'ARCHIVE_INVALID',
  'ARCHIVE_ENTRY_UNSAFE',
  'ARCHIVE_TOO_LARGE',
  'ARCHIVE_ENTRY_COUNT_EXCEEDED',
  'FILE_COUNT_LIMIT_REACHED',
  'TOTAL_BYTES_LIMIT_REACHED',
  'PARSE_FAILED',
  'PARSE_ERRORS_TRUNCATED',
  'UNSUPPORTED_LANGUAGE',
  'NODE_LIMIT_REACHED',
  'EDGE_LIMIT_REACHED',
  'DUPLICATE_ENTITY_MERGED',
  'DANGLING_REFERENCE',
  'EMPTY_GRAPH',
  'DEPLOYMENT_MAPPING_UNRESOLVED',
  'INTERNAL_ERROR',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** Repository-relative path the diagnostic refers to, when applicable. */
  path?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** Accumulates diagnostics for one analysis run. */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];
  private readonly limit: number;

  constructor(limit = 2_000) {
    this.limit = limit;
  }

  add(diagnostic: Diagnostic): void {
    if (this.items.length < this.limit) this.items.push(diagnostic);
  }

  warn(code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): void {
    this.add({ code, severity: 'warning', message, ...extra });
  }

  info(code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): void {
    this.add({ code, severity: 'info', message, ...extra });
  }

  error(code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): void {
    this.add({ code, severity: 'error', message, ...extra });
  }

  get size(): number {
    return this.items.length;
  }

  /** True when anything reached the collector cap, so the UI can say "truncated". */
  get truncated(): boolean {
    return this.items.length >= this.limit;
  }

  list(): Diagnostic[] {
    return [...this.items];
  }

  /** Human-readable one-liners persisted on the analysis record. */
  summaryLines(): string[] {
    return this.items
      .filter((item) => item.severity !== 'info')
      .slice(0, 200)
      .map((item) => `${item.severity.toUpperCase()} ${item.code}${item.path ? ` ${item.path}` : ''}: ${item.message}`);
  }

  bySeverity(severity: DiagnosticSeverity): Diagnostic[] {
    return this.items.filter((item) => item.severity === severity);
  }
}

/** Typed error for conditions that must abort the whole analysis. */
export class AnalysisError extends Error {
  readonly code: DiagnosticCode;
  readonly statusCode: number;

  constructor(code: DiagnosticCode, message: string, statusCode = 400, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnalysisError';
    this.code = code;
    this.statusCode = statusCode;
  }

  toDiagnostic(): Diagnostic {
    return { code: this.code, severity: 'error', message: this.message };
  }
}

/** Normalises an unknown thrown value into a diagnostic-safe message. */
export function describeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === 'string') return { name: 'NonError', message: error };
  try {
    return { name: 'NonError', message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { name: 'NonError', message: String(error) };
  }
}
