/**
 * SQL statement analysis for data-access extraction.
 *
 * ## Why a scanner and not a regex
 *
 * Phase 3 read data access with regular expressions, deliberately restricted to one statement,
 * one table, no join and no subquery (`decisions.md`, D-011 era). Widening that with more
 * regular expressions would make it wrong in a new way each time: `SELECT * FROM x -- FROM y`
 * would report a read of `y` from a comment, and `'select * from users'` inside a string
 * literal would report a read of `users`.
 *
 * So this is a **tokeniser plus a clause walker**, not a pattern. It is not a SQL grammar and
 * does not claim to be one: it recognises statement shape, the clause keywords that introduce a
 * table reference, and nesting. Anything it cannot classify deterministically is returned as
 * unsupported with a reason, which is the honest answer and is surfaced in the artifact rather
 * than swallowed.
 *
 * ## What it deliberately does not do
 *
 * - It does not execute anything, and never will. There is no database connection anywhere in
 *   this package.
 * - It does not resolve column-level lineage. Every fact here is table-level, because that is
 *   what a statement names.
 * - It does not model `SELECT ... INTO`, which creates a table in PostgreSQL and means nothing
 *   in MySQL. `INTO` is read as a write target only after `INSERT`.
 * - It does not distinguish `SELECT ... FOR UPDATE`: the statement reads, and the row lock is
 *   not represented.
 */

export type SqlStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'unrecognised';

/** Why a table name appeared. Kept because it is what makes the read/write split checkable. */
export type SqlTableRole = 'from' | 'join' | 'insert_into' | 'update_target' | 'delete_target' | 'delete_using';

export interface SqlTableAccess {
  /** Bare table name, schema qualifier removed. */
  table: string;
  operation: 'read' | 'write';
  role: SqlTableRole;
}

export interface SqlStatementAnalysis {
  statement: SqlStatementKind;
  /** `mixed` when one statement both reads and writes. */
  operation: 'read' | 'write' | 'mixed';
  /** Physical tables only. A CTE name never appears here. */
  tables: SqlTableAccess[];
  /** Common table expressions this statement defined, which are not physical stores. */
  ctes: string[];
  /** Statements found in the literal. One call can carry several. */
  statementCount: number;
  /** Compact identity used in evidence, e.g. `select users, orders`. */
  summary: string;
  /** Present when the statement is SQL but this analyser will not classify it. */
  unsupportedReason?: string;
}

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'punct';

interface SqlToken {
  value: string;
  kind: TokenKind;
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'GRANT', 'REVOKE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'SET', 'CALL', 'EXEC', 'EXECUTE',
  'VACUUM', 'ANALYZE', 'PRAGMA', 'USE', 'SHOW', 'DESCRIBE', 'REPLACE', 'UPSERT',
]);

/** Clause keywords that introduce a table reference. */
const JOIN_WORDS = new Set(['JOIN']);
const JOIN_PREFIXES = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'STRAIGHT_JOIN', 'LATERAL'];

/** What a DDL or privilege verb needs before the text is a statement rather than a sentence. */
const SCHEMA_OBJECT_WORDS = new Set([
  'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'USER', 'ROLE', 'FUNCTION', 'PROCEDURE',
  'TRIGGER', 'SEQUENCE', 'ON',
]);

/**
 * What a transaction verb needs.
 *
 * `'commit'` is one of the most common words in a code string - a git helper, a log label, a
 * column name - and none of those are transactions.
 */
const TRANSACTION_WORDS = new Set(['TRANSACTION', 'WORK']);

/** The clause each verb needs before its text is treated as a statement. */
const VERB_CLAUSE_REQUIREMENTS: Record<string, ReadonlySet<string>> = {
  INSERT: new Set(['INTO', 'VALUES', 'SELECT', 'OVERWRITE']),
  UPDATE: new Set(['SET', 'FROM']),
  DELETE: new Set(['FROM', 'USING']),
  REPLACE: new Set(['INTO']),
  UPSERT: new Set(['INTO', 'ON']),
  GRANT: new Set(['ON']),
  REVOKE: new Set(['ON']),
  USE: new Set(['DATABASE', 'SCHEMA']),
  CREATE: SCHEMA_OBJECT_WORDS,
  ALTER: SCHEMA_OBJECT_WORDS,
  DROP: SCHEMA_OBJECT_WORDS,
  TRUNCATE: SCHEMA_OBJECT_WORDS,
  BEGIN: TRANSACTION_WORDS,
  COMMIT: TRANSACTION_WORDS,
  ROLLBACK: TRANSACTION_WORDS,
};

/**
 * Splits SQL into tokens, discarding comments.
 *
 * Comments and string literals are dropped rather than tokenised as words, which is what stops
 * `SELECT 1 FROM users -- FROM audit_log` from reporting a read of `audit_log`. String
 * contents never become table names; quoted *identifiers* do, because `` `order` `` and
 * `[order]` name tables in MySQL and T-SQL respectively.
 */
export function tokenizeSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    // Comments.
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    // Whitespace.
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    // Single-quoted string literal, with '' as an escaped quote.
    if (char === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ value: '', kind: 'string' });
      continue;
    }

    // Double-quoted or backticked identifier.
    if (char === '"' || char === '`') {
      const closing = char;
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== closing) {
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ value, kind: 'quoted' });
      continue;
    }

    // Bracket-quoted identifier, T-SQL style.
    if (char === '[') {
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== ']') {
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ value, kind: 'quoted' });
      continue;
    }

    // Number.
    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < text.length && /[0-9._]/.test(text[index]!)) index += 1;
      tokens.push({ value: text.slice(start, index), kind: 'number' });
      continue;
    }

    // Identifier or keyword.
    if (/[A-Za-z_@#$]/.test(char)) {
      let value = '';
      while (index < text.length && /[A-Za-z0-9_@#$]/.test(text[index]!)) {
        value += text[index];
        index += 1;
      }
      tokens.push({ value, kind: 'word' });
      continue;
    }

    tokens.push({ value: char, kind: 'punct' });
    index += 1;
  }

  return tokens;
}

/**
 * Analyses every statement in one SQL literal.
 *
 * A call whose argument holds `DELETE FROM a; INSERT INTO b` is analysed as the union of both
 * statements, because the call really does both. The union is reported with `statementCount`
 * so a reader can see it was more than one statement.
 *
 * Returns `null` when the literal is not recognisable as SQL at all — the common case for an
 * arbitrary string argument — so the caller can stay silent about it.
 */
export function analyzeSql(text: string): SqlStatementAnalysis | null {
  const cleaned = text.trim();
  if (cleaned.length === 0) return null;

  const segments = splitStatements(cleaned);
  const analyses = segments.map((segment) => analyzeOne(segment)).filter((entry): entry is SqlStatementAnalysis => entry !== null);
  if (analyses.length === 0) return null;

  const tables = new Map<string, SqlTableAccess>();
  const ctes = new Set<string>();
  let reads = 0;
  let writes = 0;

  for (const analysis of analyses) {
    for (const cte of analysis.ctes) ctes.add(cte);
    for (const access of analysis.tables) {
      const key = `${access.table}:${access.operation}`;
      if (!tables.has(key)) tables.set(key, access);
    }
    if (analysis.operation === 'read' || analysis.operation === 'mixed') reads += 1;
    if (analysis.operation === 'write' || analysis.operation === 'mixed') writes += 1;
  }

  const operation: SqlStatementAnalysis['operation'] = writes > 0 && reads > 0 ? 'mixed' : writes > 0 ? 'write' : 'read';
  const unsupported = analyses.find((analysis) => analysis.unsupportedReason);

  return {
    statement: analyses.length === 1 ? analyses[0]!.statement : 'unrecognised',
    operation,
    tables: [...tables.values()],
    ctes: [...ctes].sort(),
    statementCount: analyses.length,
    summary: summarise(analyses),
    ...(unsupported?.unsupportedReason ? { unsupportedReason: unsupported.unsupportedReason } : {}),
  };
}

/** Splits on top-level semicolons. A semicolon inside a literal or parenthesis is not a split. */
function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    if (char === "'") {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += text.slice(start, index);
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      if (current.trim().length > 0) parts.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function analyzeOne(segment: string): SqlStatementAnalysis | null {
  const tokens = tokenizeSql(segment);
  if (tokens.length === 0) return null;

  let position = 0;
  const ctes: string[] = [];

  // WITH [RECURSIVE] name [ (cols) ] AS ( … ) [, name AS ( … )]*
  if (isWord(tokens[position], 'WITH')) {
    position += 1;
    if (isWord(tokens[position], 'RECURSIVE')) position += 1;
    for (;;) {
      const name = tokens[position];
      if (!name || (name.kind !== 'word' && name.kind !== 'quoted')) break;
      position += 1;
      if (isPunct(tokens[position], '(')) position = skipBalanced(tokens, position);
      if (!isWord(tokens[position], 'AS')) break;
      position += 1;
      if (!isPunct(tokens[position], '(')) break;
      position = skipBalanced(tokens, position);
      ctes.push(name.value);
      if (isPunct(tokens[position], ',')) {
        position += 1;
        continue;
      }
      break;
    }
  }

  const head = tokens[position];
  const keyword = head?.kind === 'word' ? head.value.toUpperCase() : undefined;
  if (!keyword || !SQL_KEYWORDS.has(keyword)) return null;

  // A keyword on its own does not make text SQL. Code strings are full of words that are also
  // SQL keywords - `console.log('revoke:', ...)`, a note reading "Create content targeting this
  // keyword" - and treating either as a statement puts a non-statement in the omission log, where
  // it reads as something the analyser failed to understand.
  //
  // The requirement is the clause the verb actually needs. `SELECT` is absent deliberately:
  // `SELECT 1` is a real statement that reads nothing, and it belongs in the log. A sentence
  // beginning "Select" is rare enough that the false positive costs less than losing real
  // statements.
  const requiredClause = VERB_CLAUSE_REQUIREMENTS[keyword];
  if (
    requiredClause &&
    !tokens.some((token) => token.kind === 'word' && requiredClause.has(token.value.toUpperCase()))
  ) {
    return null;
  }

  if (keyword !== 'SELECT' && keyword !== 'INSERT' && keyword !== 'UPDATE' && keyword !== 'DELETE') {
    return {
      statement: 'unrecognised',
      operation: 'read',
      tables: [],
      ctes,
      statementCount: 1,
      summary: `${keyword.toLowerCase()} statement`,
      unsupportedReason: `a ${keyword} statement is not a data-access statement this analyser classifies`,
    };
  }

  const kind = keyword.toLowerCase() as 'select' | 'insert' | 'update' | 'delete';
  const cteNames = new Set(ctes.map((name) => name.toLowerCase()));
  const accesses: SqlTableAccess[] = [];
  let writeTargetSeen = false;

  // A CTE body is a statement in its own right, so its tables are read by the same walk. The
  // body tokens were skipped while parsing the CTE header; they are analysed here rather than
  // discarded, which is the difference between `orders` being evidenced and not.
  for (const body of cteBodies(segment)) {
    const inner = analyzeOne(body);
    if (!inner) continue;
    for (const cte of inner.ctes) cteNames.add(cte.toLowerCase());
    for (const access of inner.tables) {
      if (cteNames.has(access.table.toLowerCase())) continue;
      accesses.push(access);
    }
  }

  for (let index = position; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'word') continue;
    const word = token.value.toUpperCase();
    const isJoin = JOIN_WORDS.has(word) || JOIN_PREFIXES.includes(word);

    if (word === 'FROM') {
      // DELETE's first FROM names the rows being deleted; every later FROM is a read.
      if (kind === 'delete' && !writeTargetSeen) {
        const target = tableReferenceAt(tokens, index + 1, cteNames, true);
        if (target) {
          accesses.push({ ...target, operation: 'write', role: 'delete_target' });
          writeTargetSeen = true;
        }
        continue;
      }
      for (const read of tableListAfter(tokens, index + 1, cteNames)) {
        accesses.push({ ...read, operation: 'read', role: 'from' });
      }
      continue;
    }

    if (isJoin) {
      // `LEFT JOIN x`, `CROSS JOIN y`, or a bare `JOIN z`: the table follows the keyword.
      const offset = JOIN_PREFIXES.includes(word) ? index + 1 : index;
      const read = tableReferenceAt(tokens, offset + 1, cteNames);
      if (read) accesses.push({ ...read, operation: 'read', role: 'join' });
      continue;
    }

    if (word === 'USING' && kind === 'delete') {
      // DELETE ... USING other_table, or DELETE ... USING (subquery).
      for (const read of tableListAfter(tokens, index + 1, cteNames)) {
        accesses.push({ ...read, operation: 'read', role: 'delete_using' });
      }
      continue;
    }

    if (word === 'INTO' && kind === 'insert' && !writeTargetSeen) {
      const target = tableReferenceAt(tokens, index + 1, cteNames, true);
      if (target) {
        accesses.push({ ...target, operation: 'write', role: 'insert_into' });
        writeTargetSeen = true;
      }
      continue;
    }

    if (word === 'UPDATE' && kind === 'update' && index === position) {
      const target = tableReferenceAt(tokens, index + 1, cteNames, true);
      if (target) {
        accesses.push({ ...target, operation: 'write', role: 'update_target' });
        writeTargetSeen = true;
      }
      continue;
    }

    // `DELETE alias FROM alias JOIN …` names the write target before FROM.
    if (kind === 'delete' && index === position + 1 && !writeTargetSeen && (head?.kind === 'word' || head?.kind === 'quoted')) {
      const target = tableReferenceAt(tokens, position, cteNames, true);
      if (target) {
        accesses.push({ ...target, operation: 'write', role: 'delete_target' });
        writeTargetSeen = true;
      }
    }
  }

  const writes = accesses.filter((access) => access.operation === 'write');
  const reads = accesses.filter((access) => access.operation === 'read');
  const operation: SqlStatementAnalysis['operation'] =
    writes.length > 0 && reads.length > 0 ? 'mixed' : writes.length > 0 ? 'write' : 'read';

  let unsupportedReason: string | undefined;
  if (accesses.length === 0) {
    unsupportedReason =
      kind === 'select'
        ? 'no table reference could be established from this statement, so no data relationship is claimed'
        : `no ${kind} target table could be established from this statement`;
  }

  return {
    statement: kind,
    operation,
    tables: accesses,
    ctes,
    statementCount: 1,
    summary: `${kind}${accesses.length > 0 ? ` ${accesses.map((access) => access.table).join(', ')}` : ''}`,
    ...(unsupportedReason ? { unsupportedReason } : {}),
  };
}

/**
 * The table a clause keyword introduces, or `null`.
 *
 * Rejects, deliberately:
 * - a CTE name, because a CTE is a query result rather than a store;
 * - a function call such as `FROM generate_series(1, 10)`, unless `allowParen` says the
 *   parenthesis is a column list rather than a call - `INSERT INTO reports (a, b)`;
 * - a subquery `( … )`, because the tables inside it are found by the same linear walk;
 * - a SQL keyword, so `FROM WHERE` never produces a table named `WHERE`.
 *
 * A schema qualifier is reduced to its last segment, because the graph records table names and
 * two schemas can hold tables of the same name; the qualifier is preserved in the DDL when it
 * is declared there.
 */
function tableReferenceAt(
  tokens: readonly SqlToken[],
  index: number,
  ctes: ReadonlySet<string>,
  allowParen = false,
): { table: string } | null {
  const token = tokens[index];
  if (!token) return null;
  if (token.kind !== 'word' && token.kind !== 'quoted') return null;
  if (token.kind === 'word' && SQL_KEYWORDS.has(token.value.toUpperCase())) return null;

  // `schema.table` arrives as three tokens; take the last name in the chain.
  let last = token;
  let offset = index;
  while (isPunct(tokens[offset + 1], '.') && (tokens[offset + 2]?.kind === 'word' || tokens[offset + 2]?.kind === 'quoted')) {
    last = tokens[offset + 2]!;
    offset += 2;
  }

  // `FROM table(col)` and `FROM generate_series(…)` are expressions, not stores — unless the
  // parenthesis is the column list of a write target.
  if (!allowParen && isPunct(tokens[offset + 1], '(')) return null;

  const bare = last.value.split('.').at(-1)?.replace(/^["`[]|["`\]]$/g, '').trim() ?? '';
  if (bare.length === 0) return null;
  if (ctes.has(bare.toLowerCase())) return null;
  return { table: bare };
}

/**
 * A comma-separated table list: `FROM users, orders`.
 *
 * Only the first element can be followed by an alias, so the walk stops at anything that is not
 * another comma-separated name. That means `FROM a, b WHERE x` yields both tables and
 * `FROM a, count(*)` yields only `a`, which is the correct reading of the second form.
 */
function tableListAfter(tokens: readonly SqlToken[], index: number, ctes: ReadonlySet<string>): { table: string }[] {
  const found: { table: string }[] = [];
  let position = index;

  for (let consumed = 0; consumed < 8; consumed += 1) {
    const reference = tableReferenceAt(tokens, position, ctes);
    if (!reference) break;
    found.push(reference);

    // Step over the table, an optional alias, then look for a comma.
    let next = position + 1;
    if (isPunct(tokens[next], '(')) next = skipBalanced(tokens, next);
    if (tokens[next] && (tokens[next]!.kind === 'word' || tokens[next]!.kind === 'quoted') && !isPunct(tokens[next + 1], '.')) {
      if (SQL_KEYWORDS.has(tokens[next]!.value.toUpperCase())) break;
      next += 1;
    }
    if (!isPunct(tokens[next], ',')) break;
    position = next + 1;
  }

  return found;
}

/** The parenthesised bodies of every `WITH name AS ( … )` in a statement. */
function cteBodies(segment: string): string[] {
  const bodies: string[] = [];
  const pattern = /\bAS\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(segment)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let position = start;
    let quote: string | null = null;

    while (position < segment.length && depth > 0) {
      const char = segment[position]!;
      if (quote) {
        if (char === quote) {
          if (segment[position + 1] === quote) position += 1;
          else quote = null;
        }
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      position += 1;
    }

    const body = segment.slice(start, position);
    // A CTE body that is itself `SELECT …` is a statement; a body containing a nested `WITH`
    // is handled by recursion.
    if (/\b(SELECT|WITH)\b/i.test(body)) bodies.push(body);
    pattern.lastIndex = position;
  }

  return bodies;
}

/** Index just past the parenthesis group that starts at `index`. */
function skipBalanced(tokens: readonly SqlToken[], index: number): number {
  let depth = 0;
  for (let position = index; position < tokens.length; position += 1) {
    const token = tokens[position]!;
    if (isPunct(token, '(')) depth += 1;
    else if (isPunct(token, ')')) {
      depth -= 1;
      if (depth === 0) return position + 1;
    }
  }
  return tokens.length;
}

function isWord(token: SqlToken | undefined, word: string): boolean {
  return token?.kind === 'word' && token.value.toUpperCase() === word;
}

function isPunct(token: SqlToken | undefined, char: string): boolean {
  return token?.kind === 'punct' && token.value === char;
}

function summarise(analyses: readonly SqlStatementAnalysis[]): string {
  const names = [...new Set(analyses.flatMap((analysis) => analysis.tables.map((access) => access.table)))];
  const kinds = [...new Set(analyses.map((analysis) => analysis.statement))];
  return names.length > 0 ? `${kinds.join('+')} ${names.join(', ')}` : kinds.join('+');
}