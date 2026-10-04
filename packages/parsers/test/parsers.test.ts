import { describe, expect, it } from 'vitest';
import { defaultParsers, ParserRegistry, TypeScriptSourceParser, PythonSourceParser, ConfigSourceParser, stripJsonComments } from '@repoatlas/parsers';
import type { ParserContext } from '@repoatlas/parsers';

const TS_CONTEXT: ParserContext = {
  path: 'src/services/report.ts',
  language: 'typescript',
  maxProblems: 20,
  maxCalls: 500,
};

const PY_CONTEXT: ParserContext = {
  path: 'app/repo.py',
  language: 'python',
  maxProblems: 20,
  maxCalls: 500,
};

describe('parser registry', () => {
  const registry = new ParserRegistry(defaultParsers());

  it('routes typescript to the compiler-API parser', () => {
    expect(registry.select(TS_CONTEXT)?.producer).toBe('typescript-compiler-api');
  });

  it('routes python to the structural parser', () => {
    expect(registry.select(PY_CONTEXT)?.producer).toBe('python-structural');
  });

  it('never routes a manifest to the source parser', () => {
    const selected = registry.select({ ...TS_CONTEXT, path: 'tsconfig.json', language: 'json' });
    expect(selected?.producer).toBe('config-scanner');
  });

  it('reports a parser for every supported language', () => {
    for (const language of ['typescript', 'python', 'json', 'yaml', 'sql', 'dockerfile']) {
      expect(registry.select({ ...TS_CONTEXT, path: 'x', language })).toBeDefined();
    }
  });
});

describe('TypeScript extractor', () => {
  const parser = new TypeScriptSourceParser();

  it('extracts classes with their heritage clauses', () => {
    const result = parser.parse(
      `export abstract class BaseRepository {
  abstract find(id: string): Promise<unknown>;
}

export class ReportService extends BaseRepository implements Loggable {
  async findById(id: string): Promise<string> {
    return id;
  }
}

interface Loggable {
  log(): void;
}
`,
      TS_CONTEXT,
    );

    const service = result.entities.find((entity) => entity.name === 'ReportService');
    expect(service?.kind).toBe('class');
    expect(service?.extendsFrom).toEqual(['BaseRepository']);
    expect(service?.implementsFrom).toEqual(['Loggable']);
    expect(service?.startLine).toBe(5);
    expect(service?.endLine).toBe(9);
  });

  it('qualifies nested members by their declaring type', () => {
    const result = parser.parse(
      `class Service {
  async listAll() {}
  private static helper() {}
}
`,
      TS_CONTEXT,
    );
    const names = result.entities.map((entity) => entity.qualifiedName);
    expect(names).toContain('Service.listAll');
    expect(names).toContain('Service.helper');
  });

  it('does not leak one sibling method name into the next', () => {
    const result = parser.parse(
      `class Service {
  first() {}
  second() {}
}
`,
      TS_CONTEXT,
    );
    const second = result.entities.find((entity) => entity.name === 'second');
    expect(second?.qualifiedName).toBe('Service.second');
  });

  it('extracts every import form and classifies externality', () => {
    const result = parser.parse(
      `import express from 'express';
import type { Config } from './config.js';
import { readFile } from 'node:fs/promises';
export { helper } from './helper.js';
export async function load() {
  return import('./lazy.js');
}
const required = require('./legacy.js');
`,
      TS_CONTEXT,
    );

    const specifiers = result.imports.map((record) => record.specifier);
    expect(specifiers).toEqual(expect.arrayContaining(['express', './config.js', 'node:fs/promises', './helper.js', './lazy.js', './legacy.js']));

    expect(result.imports.find((r) => r.specifier === 'express')?.isExternal).toBe(true);
    expect(result.imports.find((r) => r.specifier === './config.js')?.isExternal).toBe(false);
    expect(result.imports.find((r) => r.specifier === 'node:fs/promises')?.isExternal).toBe(false);
    expect(result.imports.find((r) => r.specifier === './config.js')?.kind).toBe('type_only');
    expect(result.imports.find((r) => r.specifier === './helper.js')?.kind).toBe('reexport');
    expect(result.imports.find((r) => r.specifier === './lazy.js')?.kind).toBe('dynamic');
    expect(result.imports.find((r) => r.specifier === './legacy.js')?.kind).toBe('require');
  });

  it('records the line of each import for citation', () => {
    const result = parser.parse("import a from 'a';\n\nimport b from 'b';\n", TS_CONTEXT);
    expect(result.imports[0]?.line).toBe(1);
    expect(result.imports[1]?.line).toBe(3);
  });

  it('extracts call expressions with their enclosing function', () => {
    const result = parser.parse(
      `function handler() {
  const value = compute(input);
  service.save(value);
}
`,
      TS_CONTEXT,
    );
    const call = result.calls.find((item) => item.callee === 'compute');
    // `const value = compute(...)` must not make the enclosing scope `handler.value`:
    // a variable initialiser is not a scope that owns the call.
    expect(call?.fromQualifiedName).toBe('handler');
    expect(call?.line).toBe(2);
    expect(call?.isLocalIdentifier).toBe(true);
    expect(result.calls.find((item) => item.callee === 'service.save')?.fromQualifiedName).toBe('handler');
    expect(result.calls.find((item) => item.callee === 'service.save')?.isLocalIdentifier).toBe(false);
  });

  it('does not mistake control-flow keywords for calls', () => {
    const result = parser.parse('function f(a) { if (a) { return 1; } while (a) {} }', TS_CONTEXT);
    expect(result.calls.some((call) => call.callee === 'if')).toBe(false);
    expect(result.calls.some((call) => call.callee === 'while')).toBe(false);
  });

  it('recognises Express route registrations', () => {
    const result = parser.parse(
      `const app = express();
app.get('/api/reports/:id', handler);
app.post('/api/reports', createReport);
store.get('/not-a-route');
`,
      TS_CONTEXT,
    );
    const routes = result.markers.filter((marker) => marker.name === 'http.route');
    expect(routes).toHaveLength(2);
    expect(routes[0]?.attributes).toMatchObject({ httpMethod: 'GET', path: '/api/reports/:id' });
    expect(routes[1]?.attributes).toMatchObject({ httpMethod: 'POST', path: '/api/reports' });
  });

  it('does not treat an unrelated object method as an HTTP route', () => {
    const result = parser.parse("const store = {};\nstore.get('/key');\n", TS_CONTEXT);
    expect(result.markers.filter((marker) => marker.name === 'http.route')).toHaveLength(0);
  });

  it('records a syntax error instead of throwing', () => {
    const result = parser.parse('function broken( { return;', TS_CONTEXT);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]?.code).toMatch(/^TS\d+$/);
  });

  it('still extracts what it can from a file with one syntax error', () => {
    const result = parser.parse(
      `export class Good {
  method() {}
`,
      TS_CONTEXT,
    );
    expect(result.entities.some((entity) => entity.name === 'Good')).toBe(true);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('caps the number of call records at the configured limit', () => {
    const body = Array.from({ length: 50 }, (_, i) => `  step${i}();`).join('\n');
    const result = parser.parse(`function many() {\n${body}\n}`, { ...TS_CONTEXT, maxCalls: 5 });
    expect(result.calls).toHaveLength(5);
  });

  it('extracts arrow functions assigned to variables as functions', () => {
    const result = parser.parse('export const handler = (request) => request.body;', TS_CONTEXT);
    const entity = result.entities.find((item) => item.name === 'handler');
    expect(entity?.kind).toBe('function');
    expect(entity?.signature).toContain('request');
  });

  it('handles JSX without treating markup as code', () => {
    const result = parser.parse(
      `export function Panel() {
  return <div className="x">{label}</div>;
}
`,
      { ...TS_CONTEXT, path: 'src/Panel.tsx' },
    );
    expect(result.entities.some((entity) => entity.name === 'Panel')).toBe(true);
    expect(result.problems).toHaveLength(0);
  });
});

describe('Python extractor', () => {
  const parser = new PythonSourceParser();

  it('extracts classes, functions and module constants', () => {
    const result = parser.parse(
      `import sqlite3
from typing import Any

MAX_LIMIT = 100


class ReportRepo(Base):
    """A docstring that mentions def not_a_function() on purpose."""

    def fetch(self, report_id):
        connection = sqlite3.connect("reports.db")
        return connection.execute("SELECT 1").fetchone()

    def _internal(self):
        return None


def top_level(a, b):
    return a + b
`,
      PY_CONTEXT,
    );

    const names = result.entities.map((entity) => entity.name);
    expect(names).toContain('ReportRepo');
    expect(names).toContain('fetch');
    expect(names).toContain('_internal');
    expect(names).toContain('top_level');
    expect(names).toContain('MAX_LIMIT');
    // A `def` inside a docstring must not become an entity.
    expect(names).not.toContain('not_a_function');
  });

  it('records the base class from the class statement', () => {
    const result = parser.parse('class Repo(Base):\n    pass\n', PY_CONTEXT);
    expect(result.entities.find((entity) => entity.name === 'Repo')?.extendsFrom).toEqual(['Base']);
  });

  it('qualifies methods by their class', () => {
    const result = parser.parse('class Repo:\n    def fetch(self):\n        return 1\n', PY_CONTEXT);
    expect(result.entities.some((entity) => entity.qualifiedName === 'Repo.fetch')).toBe(true);
  });

  it('extracts both import forms and marks relative imports internal', () => {
    const result = parser.parse(
      `from fastapi import FastAPI
from .models import Report
import os.path
`,
      PY_CONTEXT,
    );
    const specifiers = result.imports.map((record) => record.specifier);
    expect(specifiers).toEqual(['fastapi', '.models', 'os.path']);
    expect(result.imports[0]?.isExternal).toBe(true);
    expect(result.imports[1]?.isExternal).toBe(false);
    expect(result.imports[0]?.names).toEqual(['FastAPI']);
  });

  it('handles bracket and backslash continuations as one logical line', () => {
    const result = parser.parse(
      `def build():
    return make_thing(
        alpha=1,
        beta=2,
    )
`,
      PY_CONTEXT,
    );
    expect(result.entities.some((entity) => entity.name === 'build')).toBe(true);
    expect(result.entities.some((entity) => entity.name === 'make_thing')).toBe(false);
  });

  it('ignores comments outside strings', () => {
    const result = parser.parse('# def commented_out(): pass\ndef real():\n    return 1\n', PY_CONTEXT);
    const names = result.entities.map((entity) => entity.name);
    expect(names).toContain('real');
    expect(names).not.toContain('commented_out');
  });

  it('reports an unterminated string rather than producing garbage', () => {
    const result = parser.parse('def broken():\n    text = "unterminated\n', PY_CONTEXT);
    expect(result.problems.some((problem) => problem.code === 'PY_UNTERMINATED_LITERAL')).toBe(true);
  });

  it('marks a test-prefixed function as a test', () => {
    const result = parser.parse('def test_report_repo():\n    assert True\n', PY_CONTEXT);
    expect(result.entities.find((entity) => entity.name === 'test_report_repo')?.kind).toBe('test');
  });
});

describe('config extractor', () => {
  const parser = new ConfigSourceParser();
  const context = (path: string, language: string): ParserContext => ({ path, language, maxProblems: 10, maxCalls: 50 });

  it('reads declared dependencies and scripts from package.json', () => {
    const result = parser.parse(
      JSON.stringify({
        name: 'svc',
        version: '2.0.0',
        dependencies: { express: '^4.0.0' },
        devDependencies: { vitest: '^3.0.0' },
        scripts: { build: 'tsc' },
        main: 'dist/index.js',
      }),
      context('package.json', 'json'),
    );

    const deps = result.markers.filter((marker) => marker.name === 'manifest.dependency');
    expect(deps).toHaveLength(2);
    expect(deps.find((marker) => marker.attributes.dependency === 'express')?.attributes.range).toBe('^4.0.0');
    expect(result.markers.some((marker) => marker.name === 'manifest.script' && marker.attributes.script === 'build')).toBe(true);
    expect(result.markers.some((marker) => marker.name === 'manifest.entrypoint')).toBe(true);
  });

  it('reports invalid JSON instead of throwing', () => {
    const result = parser.parse('{ this is not json', context('package.json', 'json'));
    expect(result.problems.some((problem) => problem.code === 'CONFIG_INVALID_JSON')).toBe(true);
  });

  it('parses JSONC with comments and trailing commas', () => {
    const source = `{
  // a comment
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "strict": true, },
}`;
    expect(() => JSON.parse(stripJsonComments(source))).not.toThrow();
    const result = parser.parse(source, context('tsconfig.json', 'json'));
    // Scalar top-level keys are reported. Nested objects are skipped in this phase —
    // the scanner reads declared scalars, not the whole document tree.
    expect(result.markers.some((marker) => marker.attributes.key === 'extends')).toBe(true);
    expect(result.markers.some((marker) => marker.attributes.key === 'compilerOptions')).toBe(false);
  });

  it('reads CREATE TABLE statements and their columns', () => {
    const result = parser.parse(
      `CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL
);
`,
      context('schema.sql', 'sql'),
    );

    const tables = result.markers.filter((marker) => marker.name === 'schema.table');
    expect(tables.map((marker) => marker.attributes.table)).toEqual(['reports', 'shares']);
    expect(result.markers.filter((marker) => marker.name === 'schema.column')).toHaveLength(4);
  });

  it('ignores constraint clauses when counting columns', () => {
    const result = parser.parse(
      `CREATE TABLE t (
  id TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES other(id)
);`,
      context('schema.sql', 'sql'),
    );
    const columns = result.markers.filter((marker) => marker.name === 'schema.column');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.attributes.column).toBe('id');
  });

  it('reads compose services', () => {
    const result = parser.parse(
      `services:
  api:
    image: node:22-alpine
    ports:
      - "3000:3000"
  worker:
    image: node:22-alpine
`,
      context('docker-compose.yml', 'yaml'),
    );
    const services = result.markers.filter((marker) => marker.name === 'compose.service');
    expect(services).toHaveLength(2);
    expect(services[0]?.attributes).toMatchObject({ service: 'api', image: 'node:22-alpine' });
  });

  it('does not report a named volume or network as a service', () => {
    // Both have the same two-space indentation as a service, so a pattern that matched any
    // indented name produced a container in the architecture view that cannot run.
    const result = parser.parse(
      `services:
  api:
    image: node:22-alpine
    volumes:
      - api-data:/data

volumes:
  api-data:

networks:
  backend:
    driver: bridge
`,
      context('docker-compose.yml', 'yaml'),
    );
    const services = result.markers.filter((marker) => marker.name === 'compose.service');
    expect(services.map((marker) => marker.attributes.service)).toEqual(['api']);
  });

  it('reads the build context from both the short and the long form', () => {
    const long = parser.parse(
      `services:
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.Dockerfile
    image: repo/api:1
`,
      context('docker-compose.yml', 'yaml'),
    );
    expect(long.markers[0]?.attributes.build).toBe('./api');

    const short = parser.parse(
      `services:
  api:
    build: ./api
`,
      context('docker-compose.yml', 'yaml'),
    );
    expect(short.markers[0]?.attributes.build).toBe('./api');
  });

  it('reports no build context when the mapping form omits it', () => {
    const result = parser.parse(
      `services:
  api:
    build:
      dockerfile: Dockerfile
`,
      context('docker-compose.yml', 'yaml'),
    );
    expect(result.markers[0]?.attributes.build).toBeNull();
  });

  it('records the line each service is declared on', () => {
    const result = parser.parse(
      `services:
  api:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`,
      context('docker-compose.yml', 'yaml'),
    );
    expect(result.markers.map((marker) => marker.line)).toEqual([2, 4]);
  });

  it('reads Dockerfile base images and exposed ports', () => {
    const result = parser.parse('FROM node:22-alpine AS build\nRUN npm ci\nFROM alpine\nEXPOSE 3000\n', context('Dockerfile', 'dockerfile'));
    const images = result.markers.filter((marker) => marker.name === 'docker.base_image');
    expect(images).toHaveLength(2);
    expect(images[0]?.attributes.stage).toBe('build');
    expect(result.markers.some((marker) => marker.name === 'docker.expose')).toBe(true);
  });
});