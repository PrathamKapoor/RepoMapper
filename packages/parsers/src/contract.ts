import type { ParseProblem, ParsedFile } from '@repoatlas/core';

/**
 * The parser contract.
 *
 * A parser answers one question: what does this file literally state?
 *
 * Rules that keep the knowledge graph honest:
 *  - a parser reports what it can read, not what it believes the code means;
 *  - every fact it reports carries the line span it came from;
 *  - failure is reported through `problems`, never by throwing, so one malformed
 *    file cannot abort a repository-wide analysis;
 *  - a parser never executes, imports or evaluates the code it reads.
 */

export interface ParserContext {
  /** Repository-relative POSIX path. */
  path: string;
  /** Detected language id. */
  language: string;
  /** Maximum parse problems to record for this file. */
  maxProblems: number;
  /** Maximum call records to record for this file. */
  maxCalls: number;
}

export interface SourceParser {
  /** Stable identifier recorded on every evidence record this parser produces. */
  readonly producer: string;
  readonly language: string;
  /** True when this parser handles the file. */
  supports(context: ParserContext): boolean;
  parse(source: string, context: ParserContext): ParsedFile;
}

/** Builds an empty result with the boilerplate every parser shares. */
export function emptyResult(context: ParserContext, producer: string): ParsedFile {
  return {
    path: context.path,
    language: context.language,
    producer,
    imports: [],
    entities: [],
    calls: [],
    markers: [],
    responses: [],
    throws: [],
    returns: [],
    bindings: [],
    problems: [],
    durationMs: 0,
  };
}

/** Adds a problem, respecting the per-file cap. */
export function addProblem(result: ParsedFile, problem: ParseProblem, max: number): void {
  if (result.problems.length >= max) {
    if (result.problems.length === max) {
      result.problems.push({
        message: 'Further parse errors suppressed.',
        line: 0,
        code: 'PARSE_ERRORS_TRUNCATED',
      });
    }
    return;
  }
  result.problems.push(problem);
}
