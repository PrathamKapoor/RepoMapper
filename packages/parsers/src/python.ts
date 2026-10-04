import type { CallRecord, ExtractedEntity, Marker, ParsedFile } from '@repoatlas/core';
import { analyzeSql } from './sql.js';
import { addProblem, emptyResult, type ParserContext, type SourceParser } from './contract.js';

/**
 * Python extractor.
 *
 * Python has no first-party parser in the Node toolchain, so this extractor works on
 * a tokenised view of the source rather than raw lines. The tokenizer strips comments
 * and understands Python's string forms (including triple-quoted and f-strings), so
 * a `def` inside a docstring or a string literal cannot be mistaken for a definition.
 *
 * This is deliberately a *structural* extractor: it reports what the text declares.
 * Anything requiring evaluation — dynamic imports, decorators that build classes,
 * metaprogramming — is recorded as a marker or a problem rather than guessed at, and
 * the resulting facts keep `confidence` below EXPLICIT downstream.
 *
 * Limitation, stated plainly: indentation-sensitive blocks are recovered from logical
 * line structure, and continuation lines inside brackets are joined. This is correct
 * for idiomatic Python but will not reconstruct every exotic case; the tokenizer
 * reports what it could not classify instead of failing silently.
 */

const PRODUCER = 'python-structural';

interface LogicalLine {
  /** 1-based line number of the first physical line. */
  line: number;
  /** Indentation width in columns. */
  indent: number;
  /**
   * Source with comments removed and string *bodies* blanked. Used for detecting
   * definitions and calls, so a `def` inside a docstring or string is invisible.
   */
  code: string;
  /**
   * Source with comments removed but string literals intact. Used for marker
   * extraction, which needs real values such as an HTTP route path. Never used for
   * definition detection.
   */
  raw: string;
  /** True when the physical line ended with a backslash continuation. */
  continued: boolean;
  /** True when the logical line ends while a bracket or triple-quote is still open. */
  unterminated: boolean;
}

export class PythonSourceParser implements SourceParser {
  readonly producer = PRODUCER;
  readonly language = 'python';

  supports(context: ParserContext): boolean {
    return context.language === 'python';
  }

  parse(source: string, context: ParserContext): ParsedFile {
    const started = performance.now();
    const result = emptyResult(context, this.producer);

    const lines = tokenize(source);

    // Report the file as unreliable when tokenization hit an unterminated literal:
    // the logical-line view cannot be trusted past that point.
    if (lines.some((line) => line.unterminated)) {
      addProblem(
        result,
        {
          message: 'File ends inside an unterminated string or bracket.',
          line: lines.find((line) => line.unterminated)?.line ?? 0,
          code: 'PY_UNTERMINATED_LITERAL',
        },
        context.maxProblems,
      );
    }

    /**
     * Enclosing scopes derived from indentation. Python's block structure is
     * indentation, so this replaces a real parser's scope tracking.
     */
    const scopes: { indent: number; qualifiedName: string }[] = [];
    const calls: CallRecord[] = [];

    for (const line of lines) {
      if (line.code === '') continue;

      while (scopes.length > 0 && (scopes.at(-1)?.indent ?? -1) >= line.indent) {
        scopes.pop();
      }
      const enclosing = scopes.at(-1)?.qualifiedName;

      handlePythonLine(line, result, enclosing, calls);

      const declared = declaredNameFor(line);
      if (declared) {
        scopes.push({
          indent: line.indent,
          qualifiedName: enclosing ? `${enclosing}.${declared}` : declared,
        });
      }
    }

    for (const call of calls.slice(0, context.maxCalls)) result.calls.push(call);
    if (calls.length > context.maxCalls) {
      addProblem(
        result,
        {
          message: `Call extraction truncated at ${context.maxCalls} records (${calls.length} found).`,
          line: 0,
          code: 'PY_CALLS_TRUNCATED',
        },
        context.maxProblems,
      );
    }

    result.durationMs = Math.round(performance.now() - started);
    return result;
  }
}

function declaredNameFor(line: LogicalLine): string | undefined {
  const match =
    /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line.code) ?? /^class\s+([A-Za-z_]\w*)/.exec(line.code);
  return match?.[1];
}

function handlePythonLine(
  line: LogicalLine,
  result: ParsedFile,
  enclosing: string | undefined,
  calls: CallRecord[],
): void {
  const code = line.code;

  // `from x import a, b` / `import x, y as z`
  const fromImport = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(code);
  if (fromImport?.[1] && fromImport[2]) {
    const specifier = fromImport[1];
    const names = fromImport[2]
      .replace(/[()]/g, '')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
      .filter((name): name is string => Boolean(name) && name !== '*');
    result.imports.push({
      specifier,
      names,
      kind: 'static',
      line: line.line,
      isExternal: !specifier.startsWith('.'),
    });
    return;
  }

  const plainImport = /^import\s+(.+)$/.exec(code);
  if (plainImport?.[1]) {
    for (const part of plainImport[1].split(',')) {
      const specifier = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (!specifier) continue;
      result.imports.push({
        specifier,
        names: [],
        kind: 'static',
        line: line.line,
        isExternal: !specifier.startsWith('.'),
      });
    }
    return;
  }

  // Definitions
  const functionMatch = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)$/.exec(code);
  if (functionMatch?.[2]) {
    const name = functionMatch[2];
    const entity: ExtractedEntity = {
      kind: name.startsWith('test_') ? 'test' : 'function',
      name,
      qualifiedName: enclosing ? `${enclosing}.${name}` : name,
      language: 'python',
      startLine: line.line,
      endLine: line.line,
      signature: `(${functionMatch[3] ?? ''})`.replace(/\s+/g, ' '),
      ...(functionMatch[1] ? { modifiers: ['async'] } : {}),
      // Present whether or not the keyword appears: for a `def` the absence of `async` is a
      // statement the source does make.
      isAsync: Boolean(functionMatch[1]),
    };
    result.entities.push(entity);
    collectCalls(line, entity.qualifiedName, calls);
    return;
  }

  const classMatch = /^class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?/.exec(code);
  if (classMatch?.[1]) {
    const name = classMatch[1];
    const bases = (classMatch[3] ?? '')
      .split(',')
      .map((base) => base.trim().split('=')[0]?.trim())
      .filter((base): base is string => Boolean(base));
    result.entities.push({
      kind: 'class',
      name,
      qualifiedName: enclosing ? `${enclosing}.${name}` : name,
      language: 'python',
      startLine: line.line,
      endLine: line.line,
      ...(bases.length > 0 ? { extendsFrom: bases } : {}),
    });
    return;
  }

  // Module-level assignment to a class-like name is treated as a constant, matching
  // what the source literally states.
  const assignment = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/.exec(code);
  if (assignment?.[1]) {
    result.entities.push({
      kind: 'constant',
      name: assignment[1],
      qualifiedName: enclosing ? `${enclosing}.${assignment[1]}` : assignment[1],
      language: 'python',
      startLine: line.line,
      endLine: line.line,
    });
    return;
  }

  collectCalls(line, enclosing, calls);

  // Control flow is recorded only from an explicit statement in the enclosing scope, for
  // the same reason as in the TypeScript extractor: a workflow must not be inferred from
  // the shape of a call graph.
  const flow = pythonControlFlowMarker(code, line.line, enclosing);
  if (flow) result.markers.push(flow);

  const queries = pythonSqlMarkers(line.raw, line.line, enclosing);
  for (const query of queries) result.markers.push(query);

  // Markers read the literal-preserving view: a decorator's route path is a string
  // value, and blanking string bodies would make it undetectable.
  const marker = pythonMarker(line.raw, line.line);
  if (marker) result.markers.push(marker);
}

/**
 * `if` / `elif` / `for` / `while` / `try` at the start of a logical line.
 *
 * `elif` and `except` are folded into their parent kind: they are the same decision point
 * with a different spelling, and a projection that drew them separately would imply a
 * separate stage.
 */
function pythonControlFlowMarker(code: string, line: number, scope: string | undefined): Marker | undefined {
  if (!scope) return undefined;

  const branch = /^(if|elif)\s+(.+?):\s*$/.exec(code);
  if (branch?.[2]) {
    return { name: 'control.branch', line, attributes: { flow: 'branch', scope, condition: clip(branch[2]) } };
  }

  const loop = /^(for|while)\s+(.+?):\s*$/.exec(code);
  if (loop?.[2]) {
    return { name: 'control.loop', line, attributes: { flow: 'loop', scope, condition: clip(loop[2]) } };
  }

  if (/^(try|finally)\s*:/.test(code)) {
    return { name: 'control.handler', line, attributes: { flow: 'handler', scope } };
  }

  return undefined;
}

/**
 * SQL statements in a Python string literal.
 *
 * Uses the same statement analyser as the TypeScript extractor, so a join, a subquery or a CTE
 * is read identically in both languages — two analysers would be two sets of bugs. The Python
 * parser remains a structural extractor: it finds string literals by line and hands their
 * contents to the analyser.
 *
 * Returns one marker per table the statement touches, so read and write stay separate facts.
 */
function pythonSqlMarkers(raw: string, line: number, scope: string | undefined): Marker[] {
  if (!scope) return [];
  const markers: Marker[] = [];

  for (const match of raw.matchAll(/(['"])([\s\S]*?)\1/gs)) {
    const statement = match[2];
    if (!statement) continue;
    const analysis = analyzeSql(statement);
    if (!analysis) continue;

    if (analysis.tables.length === 0) {
      markers.push({
        name: 'sql.statement',
        line,
        attributes: { scope, summary: analysis.summary, unsupported: analysis.unsupportedReason ?? null },
      });
      continue;
    }

    for (const access of analysis.tables) {
      markers.push({
        name: 'sql.query',
        line,
        attributes: {
          operation: access.operation,
          table: access.table,
          role: access.role,
          statement: analysis.summary,
          scope,
        },
      });
    }
    if (analysis.ctes.length > 0) {
      markers.push({
        name: 'sql.cte',
        line,
        attributes: { scope, names: analysis.ctes.join(','), statement: analysis.summary },
      });
    }
  }

  return markers;
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

/**
 * Extracts call expressions from a logical line.
 *
 * `name(` starts a call; `name.` chains and dotted paths are preserved so
 * `self.repo.save(...)` survives as a call to `self.repo.save`.
 */
function collectCalls(line: LogicalLine, fromQualifiedName: string | undefined, calls: CallRecord[]): void {
  const pattern = /([A-Za-z_][\w.]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line.code)) !== null) {
    const callee = match[1];
    if (!callee) continue;
    // Keywords that precede a bracket are not calls.
    if (['if', 'elif', 'while', 'for', 'return', 'assert', 'not', 'and', 'or', 'in', 'is', 'with', 'print', 'def', 'class'].includes(callee)) {
      continue;
    }
    const call: CallRecord = {
      callee,
      line: line.line,
      isLocalIdentifier: /^[A-Za-z_]\w*$/.test(callee),
      argCount: countTopLevelArgs(line.code, match.index + match[0].length - 1),
    };
    if (fromQualifiedName) call.fromQualifiedName = fromQualifiedName;
    calls.push(call);
  }
}

function countTopLevelArgs(code: string, openIndex: number): number {
  let depth = 0;
  let args = 0;
  let sawContent = false;
  for (let i = openIndex; i < code.length; i += 1) {
    const char = code[i];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) continue;
      sawContent = true;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return sawContent ? args + 1 : 0;
      continue;
    }
    if (depth === 1 && char === ',') {
      args += 1;
      sawContent = true;
      continue;
    }
    if (depth === 1 && char && !/\s/.test(char)) sawContent = true;
  }
  return sawContent ? args + 1 : 0;
}

/** Recognises framework entry points that matter for architecture views. */
const PY_FRAMEWORKS: readonly { name: string; pattern: RegExp; marker: string }[] = [
  { name: 'fastapi', pattern: /@(\w+)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/, marker: 'http.route' },
  { name: 'flask', pattern: /@(\w+)\.(route|get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/, marker: 'http.route' },
  { name: 'django', pattern: /path\s*\(\s*["']([^"']+)["']/, marker: 'http.route' },
  { name: 'celery', pattern: /@(\w+)\.task\s*\(/, marker: 'async.task' },
];

function pythonMarker(code: string, line: number): Marker | undefined {
  for (const framework of PY_FRAMEWORKS) {
    const match = framework.pattern.exec(code);
    if (!match) continue;
    const attributes: Marker['attributes'] = { framework: framework.name };
    if (framework.marker === 'http.route' && match[3]) {
      attributes.path = match[3];
      attributes.httpMethod = (match[2] ?? 'ANY').toUpperCase();
    }
    return { name: framework.marker, line, attributes };
  }
  return undefined;
}

/**
 * Splits source into comment-free logical lines.
 *
 * Handles: `#` comments outside strings, single/double/triple quoted strings,
 * f-strings, escaped characters, explicit line continuations and bracket
 * continuations. String *bodies* are removed so `def` inside a docstring is invisible.
 */
export function tokenize(source: string): LogicalLine[] {
  const physical = source.split(/\r\n|\r|\n/);
  const logical: LogicalLine[] = [];

  let buffer = '';
  let rawBuffer = '';
  let startLine = 0;
  let indent = 0;
  let bracketDepth = 0;
  let triple: string | null = null;
  let pendingUnterminated = false;

  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index] ?? '';
    const lineNumber = index + 1;
    const stripped = stripLine(raw, triple);

    if (triple === null && startLine === 0) {
      indent = countIndent(raw);
      startLine = lineNumber;
    }

    triple = stripped.triple;
    bracketDepth = stripped.depth;
    pendingUnterminated = pendingUnterminated || stripped.unterminatedString;

    if (buffer === '' && stripped.code.trim() === '' && triple === null && !stripped.unterminatedString) {
      // Blank or comment-only physical line: emit nothing.
      if (bracketDepth === 0) {
        startLine = 0;
        indent = 0;
      }
      continue;
    }

    const segment = stripped.code.trim();
    const rawSegment = stripped.raw.trim();
    buffer = buffer === '' ? segment : `${buffer} ${segment}`;
    rawBuffer = rawBuffer === '' ? rawSegment : `${rawBuffer} ${rawSegment}`;

    if (bracketDepth > 0 || triple !== null || stripped.endedWithContinuation) {
      continue;
    }

    logical.push({
      line: startLine,
      indent,
      code: normaliseSpacing(buffer),
      raw: normaliseSpacing(rawBuffer),
      continued: false,
      unterminated: pendingUnterminated,
    });
    buffer = '';
    rawBuffer = '';
    pendingUnterminated = false;
    startLine = 0;
    indent = 0;
  }

  if (buffer !== '' || triple !== null || pendingUnterminated) {
    logical.push({
      line: startLine,
      indent,
      code: normaliseSpacing(buffer),
      raw: normaliseSpacing(rawBuffer),
      continued: true,
      unterminated: pendingUnterminated || triple !== null || bracketDepth > 0,
    });
  }

  return logical;
}

interface StrippedLine {
  /** Comments removed, string bodies blanked. */
  code: string;
  /** Comments removed, string literals preserved. */
  raw: string;
  /** Triple-quote delimiter still open after this line, if any. */
  triple: string | null;
  /** Net bracket depth after this line. */
  depth: number;
  endedWithContinuation: boolean;
  /** True when a single-quoted string was opened but never closed on this line. */
  unterminatedString: boolean;
}

function stripLine(raw: string, openTriple: string | null): StrippedLine {
  let code = '';
  let rawOut = '';
  let triple = openTriple;
  let depth = 0;
  let unterminatedString = false;
  let i = 0;

  while (i < raw.length) {
    const char = raw[i] ?? '';

    if (triple !== null) {
      if (raw.startsWith(triple, i)) {
        i += 3;
        triple = null;
        // Docstrings are blanked in both views: they must never look like code.
        code += '""';
        rawOut += '""';
        continue;
      }
      if (char === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === '#') break; // comment to end of line

    if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) {
      triple = raw.slice(i, i + 3);
      i += 3;
      code += '""';
      rawOut += '""';
      continue;
    }

    if (char === '"' || char === "'") {
      const closed = skipSingleLineString(raw, i);
      const end = closed === -1 ? raw.length : closed;
      const body = raw.slice(i + 1, closed === -1 ? raw.length : closed - 1);
      if (closed === -1) unterminatedString = true;
      // Blanked for structure detection, preserved for marker extraction.
      code += '""';
      rawOut += `${quoteOf(raw[i])}${body}${quoteOf(raw[i])}`;
      i = end;
      continue;
    }

    if (char === '\\' && i === raw.length - 1) {
      i += 1;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;

    code += char;
    rawOut += char;
    i += 1;
  }

  const trimmedCode = code.replace(/\s+$/, '');
  const trimmedRaw = rawOut.replace(/\s+$/, '');
  const endedWithContinuation = trimmedCode.endsWith('\\');

  return {
    code: trimmedCode,
    raw: trimmedRaw,
    triple,
    depth,
    endedWithContinuation,
    unterminatedString,
  };
}

function quoteOf(char: string | undefined): string {
  return char === "'" ? "'" : '"';
}

/**
 * Consumes a single-line string starting at `start`.
 * Returns the index just past the closing quote, or `-1` when the string is unterminated.
 */
function skipSingleLineString(raw: string, start: number): number {
  const quote = raw[start];
  let i = start + 1;
  while (i < raw.length) {
    const char = raw[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    i += 1;
  }
  return -1;
}

function countIndent(raw: string): number {
  let count = 0;
  for (const char of raw) {
    if (char === ' ') count += 1;
    else if (char === '\t') count += 4;
    else break;
  }
  return count;
}

function normaliseSpacing(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}
