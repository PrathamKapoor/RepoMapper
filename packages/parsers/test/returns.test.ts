import { describe, expect, it } from 'vitest';
import { TypeScriptSourceParser } from '../src/typescript.js';
import { PythonSourceParser } from '../src/python.js';
import type { ParserContext } from '../src/contract.js';

/**
 * Phase 4: return, await, response and throw extraction.
 *
 * The rule under test throughout is that a return is *evidenced*, never implied by a call. A
 * call with no recorded result must produce no return record, because `service.get(id)` on its
 * own says nothing about what happens to the value.
 */

const ts = new TypeScriptSourceParser();
const py = new PythonSourceParser();

const tsContext: ParserContext = { path: 'src/routes.ts', language: 'typescript', maxProblems: 10, maxCalls: 50 };
const pyContext: ParserContext = { path: 'app/routes.py', language: 'python', maxProblems: 10, maxCalls: 50 };

function parseTs(source: string) {
  return ts.parse(source, tsContext);
}

function parsePy(source: string) {
  return py.parse(source, pyContext);
}

describe('direct returns', () => {
  it('records a returned identifier by name', () => {
    const result = parseTs('function load() {\n  const user = find();\n  return user;\n}');
    expect(result.returns).toHaveLength(1);
    expect(result.returns?.[0]).toMatchObject({ kind: 'identifier', name: 'user', line: 3 });
    expect(result.returns?.[0]?.expression).toBe('user');
  });

  it('records a returned object as a literal, with no invented name', () => {
    const result = parseTs('function build() {\n  return { id: 1, title: "x" };\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'literal' });
    expect(result.returns?.[0]?.name).toBeUndefined();
  });

  it('records a returned call by its callee', () => {
    const result = parseTs('function handler() {\n  return findById(1);\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'call', name: 'findById' });
  });

  it('records a constructor return by its name', () => {
    const result = parseTs('function make() {\n  return new User(id);\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'constructor', name: 'User' });
  });

  it('records a compound expression as unresolved rather than naming a value', () => {
    const result = parseTs('function sum(a, b) {\n  return a + b;\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'expression' });
    expect(result.returns?.[0]?.name).toBeUndefined();
  });

  it('records no return at all for a function that has none', () => {
    const result = parseTs('function log(message) {\n  console.log(message);\n}');
    expect(result.returns).toHaveLength(0);
  });

  it('records the enclosing scope, so a return belongs to a function', () => {
    const result = parseTs('export function handler(request) {\n  return findAll();\n}');
    expect(result.returns?.[0]?.fromQualifiedName).toBe('handler');
  });
});

describe('async returns', () => {
  it('marks an awaited call as awaited', () => {
    const result = parseTs('async function handler() {\n  const rows = await loadRows();\n  return rows;\n}');
    const call = result.calls.find((entry) => entry.callee === 'loadRows');
    expect(call?.awaited).toBe(true);
    expect(call?.result?.kind).toBe('awaited_call');
  });

  it('distinguishes an awaited call from a bare one', () => {
    const result = parseTs('async function handler() {\n  await save();\n  log();\n}');
    const save = result.calls.find((entry) => entry.callee === 'save');
    const log = result.calls.find((entry) => entry.callee === 'log');
    expect(save?.awaited).toBe(true);
    expect(log?.awaited).toBeUndefined();
    // A bare call says nothing about its result, and nothing is invented.
    expect(log?.result).toBeUndefined();
  });

  it('records `return await call()` as both a return and an awaited call', () => {
    const result = parseTs('async function handler() {\n  return await service.get(1);\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'awaited_call', name: 'service.get', awaited: true });
  });
});

describe('HTTP responses', () => {
  it('records a response method with its status chained from the configuring call', () => {
    const result = parseTs('function handler(req, res) {\n  res.status(201).json(order);\n}');
    expect(result.responses).toHaveLength(1);
    expect(result.responses?.[0]).toMatchObject({ method: 'json', status: 201, payload: 'order' });
  });

  it('records a plain send with no status, rather than inventing 200', () => {
    const result = parseTs('function handler(req, res) {\n  res.send(rows);\n}');
    expect(result.responses?.[0]).toMatchObject({ method: 'send', payload: 'rows' });
    expect(result.responses?.[0]?.status).toBeUndefined();
  });

  it('records a returned Response as a response with the requester side', () => {
    const result = parseTs('function handler() {\n  return Response.json({ ok: true });\n}');
    expect(result.responses?.[0]).toMatchObject({ method: 'Response', returned: true });
  });

  it('records a returned Response as a return of the handler too', () => {
    const result = parseTs('function handler() {\n  return Response.json({ ok: true });\n}');
    expect(result.returns?.[0]).toMatchObject({ kind: 'call', name: 'Response.json' });
  });

  it('emits a marker carrying the scope, so a response can be linked to its route', () => {
    const result = parseTs('app.get("/reports", (req, res) => {\n  res.json(rows);\n});');
    const marker = result.markers.find((entry) => entry.name === 'http.response');
    expect(marker?.attributes.method).toBe('json');
    expect(marker?.attributes.scope).toContain('GET /reports handler');
  });

  it('does not record a non-response call as a response', () => {
    const result = parseTs('function handler() {\n  render(rows);\n  save(payload);\n}');
    expect(result.responses).toHaveLength(0);
  });
});

describe('error paths', () => {
  it('records a throw with its expression', () => {
    const result = parseTs('function load() {\n  throw new Error("boom");\n}');
    expect(result.throws).toHaveLength(1);
    expect(result.throws?.[0]).toMatchObject({ via: 'throw', expression: 'new Error("boom")' });
  });

  it('records a bare throw with no expression rather than inventing one', () => {
    const result = parseTs('function load() {\n  throw error;\n}');
    expect(result.throws?.[0]?.expression).toBe('error');
  });

  it('records a Promise rejection', () => {
    const result = parseTs('function load() {\n  return Promise.reject(new Error("no"));\n}');
    expect(result.throws?.[0]).toMatchObject({ via: 'reject' });
  });

  it('marks a throw inside an async function as a rejection', () => {
    const result = parseTs('async function load() {\n  throw new Error("boom");\n}');
    expect(result.throws?.[0]?.inAsyncFunction).toBe(true);
  });

  it('leaves a throw outside any async function unmarked', () => {
    const result = parseTs('function load() {\n  throw new Error("boom");\n}');
    expect(result.throws?.[0]?.inAsyncFunction).toBeUndefined();
  });

  it('records no error path for a function that has none', () => {
    const result = parseTs('function load() {\n  return 1;\n}');
    expect(result.throws).toHaveLength(0);
  });
});

describe('python returns, raises and responses', () => {
  it('records a returned call', () => {
    const result = parsePy('def handler():\n    return find_all()\n');
    expect(result.returns).toHaveLength(1);
    expect(result.returns?.[0]).toMatchObject({ kind: 'call', name: 'find_all', fromQualifiedName: 'handler' });
  });

  it('records a returned identifier', () => {
    const result = parsePy('def load():\n    rows = fetch()\n    return rows\n');
    expect(result.returns?.[0]).toMatchObject({ kind: 'identifier', name: 'rows' });
  });

  it('records a return of a dict as a literal', () => {
    const result = parsePy('def handler():\n    return {"ok": True}\n');
    expect(result.returns?.[0]?.kind).toBe('literal');
  });

  it('marks an awaited return', () => {
    const result = parsePy('async def handler():\n    return await load()\n');
    expect(result.returns?.[0]).toMatchObject({ kind: 'call', name: 'load', awaited: true });
  });

  it('records a raise as an error path', () => {
    const result = parsePy('def load():\n    raise ValueError("boom")\n');
    expect(result.throws?.[0]?.via).toBe('throw');
    // The Python reader blanks string-literal contents before rules run, so the expression names
    // the exception type and not its message. Asserting the message would be asserting a
    // redaction that is deliberate.
    expect(result.throws?.[0]?.expression).toContain('ValueError');
  });

  it('records a returned JSONResponse with its status', () => {
    const result = parsePy('def handler():\n    return JSONResponse({"id": 1}, status_code=201)\n');
    expect(result.responses?.[0]).toMatchObject({ method: 'JSONResponse', status: 201, returned: true });
  });

  it('records a response object call', () => {
    const result = parsePy('def handler(request):\n    response.json({"id": 1})\n');
    expect(result.responses?.[0]).toMatchObject({ method: 'json' });
  });
});