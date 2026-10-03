import type { DiagnosticCollector, ParseProblem, ParsedFile } from '@repoatlas/core';
import type { ParserContext, SourceParser } from './contract.js';
import { ConfigSourceParser } from './config.js';
import { PythonSourceParser } from './python.js';
import { TypeScriptSourceParser } from './typescript.js';

/**
 * Parser registry.
 *
 * A parser is selected purely by the language detected from the file extension during
 * ingestion. Selection order matters: specific parsers are tried before the
 * catch-all configuration scanner so that a `tsconfig.json` is never handed to a
 * TypeScript source parser.
 */
export class ParserRegistry {
  private readonly parsers: SourceParser[];

  constructor(parsers: SourceParser[] = defaultParsers()) {
    this.parsers = parsers;
  }

  /** Returns the first parser that claims the file, or `undefined`. */
  select(context: ParserContext): SourceParser | undefined {
    return this.parsers.find((parser) => parser.supports(context));
  }

  /** Language ids that at least one registered parser can handle. */
  supportedLanguages(): string[] {
    return [...new Set(this.parsers.map((parser) => parser.language))];
  }

  get size(): number {
    return this.parsers.length;
  }
}

export function defaultParsers(): SourceParser[] {
  return [new TypeScriptSourceParser(), new PythonSourceParser(), new ConfigSourceParser()];
}

export interface ParseBatchResult {
  results: ParsedFile[];
  /** Files that no parser claimed. */
  unsupported: string[];
  totalProblems: number;
}

/**
 * Parses a batch of files sequentially.
 *
 * Sequential rather than parallel on purpose: each parse is CPU-bound and mostly
 * synchronous inside the compiler, so a worker pool adds memory pressure and
 * ordering non-determinism without improving throughput for typical repositories. A
 * per-file try/catch guarantees one bad file cannot end the batch.
 */
export async function parseFiles(
  files: readonly { path: string; language: string; absolutePath: string }[],
  registry: ParserRegistry,
  options: { maxProblems: number; maxCalls: number; maxBytes: number; readFile: (absolutePath: string) => Promise<string | null> },
  diagnostics: DiagnosticCollector,
): Promise<ParseBatchResult> {
  const results: ParsedFile[] = [];
  const unsupported: string[] = [];
  let totalProblems = 0;

  for (const file of files) {
    const context: ParserContext = {
      path: file.path,
      language: file.language,
      maxProblems: options.maxProblems,
      maxCalls: options.maxCalls,
    };

    const parser = registry.select(context);
    if (!parser) {
      unsupported.push(file.path);
      diagnostics.info('UNSUPPORTED_LANGUAGE', `No parser for ${file.language}`, { path: file.path });
      continue;
    }

    let source: string | null;
    try {
      source = await options.readFile(file.absolutePath);
    } catch (error) {
      diagnostics.warn('FILE_UNREADABLE', `Cannot read ${file.path}: ${(error as Error).message}`, {
        path: file.path,
      });
      continue;
    }

    if (source === null) continue;
    if (source.length > options.maxBytes) {
      diagnostics.warn('FILE_TOO_LARGE', `Skipped ${file.path}: exceeds the parse byte budget`, {
        path: file.path,
      });
      continue;
    }

    try {
      const parsed = parser.parse(source, context);
      results.push(parsed);
      totalProblems += countProblems(parsed.problems);
      for (const problem of parsed.problems) {
        reportProblem(problem, file.path, parser.producer, diagnostics);
      }
    } catch (error) {
      diagnostics.warn('PARSE_FAILED', `Parser ${parser.producer} failed on ${file.path}: ${(error as Error).message}`, {
        path: file.path,
      });
    }
  }

  return { results, unsupported, totalProblems };
}

function countProblems(problems: readonly ParseProblem[]): number {
  return problems.length;
}

/**
 * Only syntax-level problems are surfaced as diagnostics. A parser reporting a
 * problem does not mean the file is unusable: partial extraction from a file with one
 * syntax error is more useful than dropping the file.
 */
function reportProblem(problem: ParseProblem, path: string, producer: string, diagnostics: DiagnosticCollector): void {
  diagnostics.warn('PARSE_FAILED', `${path}:${problem.line} ${producer} ${problem.code}: ${problem.message}`, {
    path,
    detail: { line: problem.line, code: problem.code, producer },
  });
}