import { describe, expect, it } from 'vitest';
import { analyzeSql, tokenizeSql } from '../src/sql.js';

/**
 * SQL statement analysis.
 *
 * The interesting cases are the adversarial ones. A scanner that reports a table named inside a
 * comment, inside a string literal, or that the statement only mentions in a condition is worse
 * than one that reports nothing, because it puts a store in the graph that the code never
 * touches. Each of those has a test here.
 */

function accesses(sql: string) {
  return analyzeSql(sql)?.tables.map((access) => `${access.table}:${access.operation}`) ?? [];
}

function analysis(sql: string) {
  return analyzeSql(sql);
}

describe('tokenizer', () => {
  it('drops line comments so a table named in a comment is not a table', () => {
    expect(tokenizeSql('SELECT 1 FROM users -- FROM audit_log').some((token) => token.value === 'audit_log')).toBe(false);
  });

  it('drops block comments', () => {
    expect(tokenizeSql('SELECT * FROM users /* JOIN orders */').some((token) => token.value === 'orders')).toBe(false);
  });

  it('treats string contents as opaque', () => {
    expect(tokenizeSql("SELECT 'from secret_table' AS note").some((token) => token.value === 'secret_table')).toBe(false);
  });

  it('keeps quoted identifiers, because they name tables', () => {
    const tokens = tokenizeSql('SELECT * FROM "order items"');
    expect(tokens.some((token) => token.kind === 'quoted' && token.value === 'order items')).toBe(true);
  });

  it('handles an escaped quote inside a literal', () => {
    expect(tokenizeSql("SELECT 'it''s fine' AS note FROM users").some((token) => token.value === 'users')).toBe(true);
  });
});

describe('single-table reads', () => {
  it('reads the table named after FROM', () => {
    expect(accesses('SELECT id, title FROM reports')).toEqual(['reports:read']);
  });

  it('strips a schema qualifier', () => {
    expect(accesses('SELECT * FROM public.reports')).toEqual(['reports:read']);
  });

  it('ignores a trailing alias', () => {
    expect(accesses('SELECT r.id FROM reports r')).toEqual(['reports:read']);
  });

  it('accepts a bracketed or backticked identifier', () => {
    expect(accesses('SELECT * FROM [order_items]')).toEqual(['order_items:read']);
    expect(accesses('SELECT * FROM `order_items`')).toEqual(['order_items:read']);
  });
});

describe('joins', () => {
  it('reads every joined table', () => {
    expect(accesses('SELECT users.id, orders.id FROM users JOIN orders ON orders.user_id = users.id')).toEqual([
      'users:read',
      'orders:read',
    ]);
  });

  it('reads every table in a three-way join', () => {
    const tables = accesses(
      'SELECT * FROM users JOIN orders ON orders.user_id = users.id LEFT JOIN invoices ON invoices.order_id = orders.id',
    );
    expect(tables).toEqual(['users:read', 'orders:read', 'invoices:read']);
  });

  it('reads both tables in a comma join', () => {
    expect(accesses('SELECT * FROM users, orders')).toEqual(['users:read', 'orders:read']);
  });

  it('does not report a function call in FROM as a table', () => {
    expect(accesses('SELECT * FROM generate_series(1, 10)')).toEqual([]);
  });

  it('does not report a table that appears only in a join condition', () => {
    // `audit_log` is named in the ON clause. It is not a table this statement reads, so it is
    // not reported - the alternative would be inventing access from a predicate.
    expect(accesses('SELECT * FROM users JOIN orders ON orders.id = audit_log.id')).toEqual(['users:read', 'orders:read']);
  });
});

describe('subqueries', () => {
  it('reads the outer and the inner table', () => {
    expect(accesses('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)')).toEqual(['users:read', 'orders:read']);
  });

  it('reads a table in a correlated subquery in the select list', () => {
    const tables = accesses('SELECT (SELECT count(*) FROM orders WHERE orders.user_id = users.id) AS n FROM users');
    expect(tables).toEqual(['orders:read', 'users:read']);
  });

  it('reads a table in an EXISTS subquery', () => {
    expect(accesses('SELECT * FROM users WHERE EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = users.id)')).toEqual([
      'users:read',
      'sessions:read',
    ]);
  });

  it('reads a derived table source without reporting the subquery as a table', () => {
    expect(accesses('SELECT t.id FROM (SELECT id FROM orders) t')).toEqual(['orders:read']);
  });
});

describe('common table expressions', () => {
  it('reports the physical table a CTE reads and names the CTE', () => {
    const result = analysis('WITH recent_orders AS (SELECT * FROM orders) SELECT * FROM recent_orders');
    expect(result?.tables.map((entry) => `${entry.table}:${entry.operation}`)).toEqual(['orders:read']);
    expect(result?.ctes).toEqual(['recent_orders']);
  });

  it('does not treat a CTE name as a store', () => {
    // The whole point: `recent_orders` is a query result, so it must never become a table.
    expect(accesses('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent')).not.toContain('recent:read');
  });

  it('handles two CTEs, the second referencing the first', () => {
    const result = analysis(
      'WITH a AS (SELECT * FROM orders), b AS (SELECT * FROM a JOIN users ON users.id = a.user_id) SELECT * FROM b',
    );
    expect(result?.ctes).toEqual(['a', 'b']);
    expect(result?.tables.map((entry) => entry.table)).toEqual(['orders', 'users']);
  });

  it('handles a recursive CTE', () => {
    const result = analysis(
      'WITH RECURSIVE tree AS (SELECT id FROM nodes UNION ALL SELECT n.id FROM nodes n JOIN tree ON n.parent = tree.id) SELECT * FROM tree',
    );
    expect(result?.ctes).toEqual(['tree']);
    expect(result?.tables.map((entry) => entry.table)).toEqual(['nodes']);
  });
});

describe('writes', () => {
  it('classifies INSERT as a write', () => {
    expect(accesses('INSERT INTO reports (id, title) VALUES (1, ??)')).toEqual(['reports:write']);
  });

  it('classifies UPDATE as a write', () => {
    expect(accesses("UPDATE reports SET title = 'x' WHERE id = 1")).toEqual(['reports:write']);
  });

  it('classifies DELETE as a write', () => {
    expect(accesses('DELETE FROM reports WHERE id = 1')).toEqual(['reports:write']);
  });

  it('reads the source of an INSERT ... SELECT without calling it a write', () => {
    expect(accesses('INSERT INTO archive_reports SELECT * FROM reports')).toEqual(['archive_reports:write', 'reports:read']);
  });

  it('reads the source of an UPDATE ... FROM', () => {
    expect(accesses('UPDATE reports SET title = users.name FROM users WHERE users.id = reports.user_id')).toEqual([
      'reports:write',
      'users:read',
    ]);
  });

  it('reads the source of a DELETE ... USING', () => {
    expect(accesses('DELETE FROM reports USING users WHERE users.id = reports.user_id')).toEqual([
      'reports:write',
      'users:read',
    ]);
  });

  it('reads a table a DELETE subquery reads', () => {
    expect(accesses('DELETE FROM reports WHERE user_id IN (SELECT id FROM users)')).toEqual([
      'reports:write',
      'users:read',
    ]);
  });

  it('classifies a MERGE as unsupported rather than guessing which table it writes', () => {
    const result = analysis('MERGE INTO reports USING users ON reports.id = users.id WHEN MATCHED THEN UPDATE SET title = users.name');
    expect(result?.tables).toHaveLength(0);
    expect(result?.unsupportedReason).toContain('MERGE');
  });

  it('does not report a table named only in a WHERE condition', () => {
    expect(accesses("UPDATE reports SET title = 'x' WHERE owner_id IN (SELECT id FROM users) AND id > 0")).toEqual([
      'reports:write',
      'users:read',
    ]);
  });

  it('does not report an INSERT column list as tables', () => {
    expect(accesses('INSERT INTO reports (user_id, title) VALUES (1, 2)')).toEqual(['reports:write']);
  });
});

describe('read/write classification', () => {
  it('marks a statement that both reads and writes as mixed', () => {
    expect(analysis('INSERT INTO archive_reports SELECT * FROM reports')?.operation).toBe('mixed');
  });

  it('marks a pure read as read', () => {
    expect(analysis('SELECT * FROM users JOIN orders ON orders.user_id = users.id')?.operation).toBe('read');
  });

  it('marks a pure write as write', () => {
    expect(analysis('UPDATE reports SET title = 1')?.operation).toBe('write');
  });

  it('merges several statements in one literal, and counts them', () => {
    const result = analysis('DELETE FROM reports; INSERT INTO audit_log (id) VALUES (1)');
    expect(result?.statementCount).toBe(2);
    expect(result?.tables.map((entry) => `${entry.table}:${entry.operation}`)).toEqual([
      'reports:write',
      'audit_log:write',
    ]);
  });

  it('does not split on a semicolon inside a literal', () => {
    const result = analysis("SELECT ';' AS marker FROM users");
    expect(result?.statementCount).toBe(1);
    expect(accesses("SELECT ';' AS marker FROM users")).toEqual(['users:read']);
  });
});

describe('unsupported and unrecognised input', () => {
  it('returns null for text that is not SQL', () => {
    expect(analyzeSql('hello world')).toBeNull();
    expect(analyzeSql('/api/reports/:id')).toBeNull();
    expect(analyzeSql('')).toBeNull();
  });

  it('reports DDL as recognised but not a data statement', () => {
    const result = analysis('CREATE TABLE reports (id TEXT)');
    expect(result?.statement).toBe('unrecognised');
    expect(result?.unsupportedReason).toContain('CREATE');
    expect(result?.tables).toHaveLength(0);
  });

  it('reports a SELECT with no resolvable table rather than inventing one', () => {
    const result = analysis('SELECT 1');
    expect(result?.tables).toHaveLength(0);
    expect(result?.unsupportedReason).toContain('no table reference');
  });

  it('reports an INSERT with no target', () => {
    const result = analysis('INSERT VALUES (1)');
    expect(result?.unsupportedReason).toContain('target table');
  });

  it('survives truncated and malformed input without throwing', () => {
    for (const broken of ['SELECT * FROM', 'SELECT * FROM users JOIN', 'WITH AS (', 'SELECT ((', ')))']) {
      expect(() => analysis(broken)).not.toThrow();
    }
  });
});

describe('summary and determinism', () => {
  it('summarises the statement for evidence', () => {
    expect(analysis('SELECT * FROM users JOIN orders ON orders.user_id = users.id')?.summary).toBe(
      'select users, orders',
    );
  });

  it('is deterministic for the same input', () => {
    const sql = 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent JOIN users ON users.id = recent.user_id';
    expect(JSON.stringify(analysis(sql))).toBe(JSON.stringify(analysis(sql)));
  });

  it('records a statement with no table as a statement', () => {
    // A health probe is real SQL that reads nothing. It belongs in the omission log.
    const probe = analysis('SELECT 1');
    expect(probe?.statement).toBe('select');
    expect(probe?.tables).toEqual([]);
    expect(probe?.operation).toBe('read');
  });

  it('reports nothing for prose that opens with a SQL verb', () => {
    // Each of these was found in a real repository, in a string literal rather than in SQL.
    // Treating them as statements would put a non-statement in the omission log.
    expect(analysis('Insert rel=canonical on all 5 indexable pages.')).toBeNull();
    expect(analysis('Update the docs and ship')).toBeNull();
    expect(analysis('revoke:')).toBeNull();
    expect(analysis('Create content targeting this keyword')).toBeNull();
    expect(analysis('commit')).toBeNull();
    expect(analysis('BEGIN TRANSACTION')).not.toBeNull();
  });

  it('still reports a verb that carries the clause it needs', () => {
    expect(analysis('Delete old rows from the queue')?.statement).toBe('delete');
    expect(analysis('INSERT INTO reports VALUES (1)')?.statement).toBe('insert');
    expect(analysis('CREATE TABLE reports (id TEXT)')?.unsupportedReason).toContain('CREATE');
    expect(analysis('GRANT SELECT ON reports TO alice')?.unsupportedReason).toContain('GRANT');
  });
});