import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test repository fixtures.
 *
 * Fixtures are built on disk in a temp directory rather than committed as a tree of
 * files. Two reasons: the exact contents are visible next to the assertions that
 * depend on them, and tests can construct the awkward cases (symlink escapes, binary
 * files, unterminated strings, oversized files) that a static fixture directory cannot
 * carry portably.
 */

export interface FixtureTree {
  /** File contents. Buffers are allowed so binary fixtures can be written. */
  [relativePath: string]: string | Uint8Array;
}

export interface Fixture {
  root: string;
  path(...parts: string[]): string;
  write(relativePath: string, contents: string | Buffer): Promise<string>;
  mkdir(relativePath: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createFixture(tree: FixtureTree = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'repoatlas-fixture-'));

  for (const [relativePath, contents] of Object.entries(tree)) {
    const target = join(root, ...relativePath.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }

  return {
    root,
    path: (...parts: string[]) => join(root, ...parts),
    async write(relativePath, contents) {
      const target = join(root, ...relativePath.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, contents);
      return target;
    },
    async mkdir(relativePath) {
      const target = join(root, ...relativePath.split('/'));
      await mkdir(target, { recursive: true });
      return target;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Creates a symlink inside the fixture pointing outside it. Windows needs privileges. */
export async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

/**
 * A small but realistic TypeScript project used by most integration tests.
 *
 * Shaped to exercise the whole pipeline: internal relative imports across directories,
 * an external dependency, a class with inheritance, an interface implementation,
 * an HTTP route, a schema declaration, a declared-but-unused dependency, and a test.
 */
export const SAMPLE_TS_PROJECT: FixtureTree = {
  'package.json': JSON.stringify(
    {
      name: 'sample-service',
      version: '1.2.3',
      main: 'src/index.ts',
      scripts: { build: 'tsc', test: 'vitest run' },
      dependencies: { express: '^4.19.2', zod: '^3.23.8' },
      devDependencies: { typescript: '^5.5.0', 'unused-dev-dep': '^1.0.0' },
    },
    null,
    2,
  ),

  'src/index.ts': `import express from 'express';
import { ReportService } from './services/report.js';
import { validateReportQuery } from './validation/report.js';

const app = express();

app.get('/api/reports/:id', async (request, response) => {
  const service = new ReportService();
  const report = await service.findById(request.params.id);
  response.json(report);
});

app.post('/api/reports', async (request, response) => {
  const query = validateReportQuery(request.body);
  response.status(201).json(query);
});

export function createApp(): express.Express {
  return app;
}
`,

  'src/services/report.ts': `import { Database } from '../db/database.js';

export interface ReportRecord {
  id: string;
  title: string;
  createdAt: Date;
}

export abstract class BaseRepository {
  abstract find(id: string): Promise<unknown>;
}

export class ReportService extends BaseRepository {
  private readonly database: Database;

  constructor(database?: Database) {
    super();
    this.database = database ?? new Database();
  }

  async findById(id: string): Promise<ReportRecord | null> {
    return this.database.query('SELECT * FROM reports WHERE id = ?', [id]);
  }

  async listAll(): Promise<ReportRecord[]> {
    return this.database.queryAll('SELECT * FROM reports');
  }
}
`,

  'src/db/database.ts': `export class Database {
  query(sql: string, params: unknown[] = []): Promise<unknown> {
    return Promise.resolve({ sql, params });
  }

  queryAll(sql: string): Promise<unknown[]> {
    return Promise.resolve([{ sql }]);
  }
}
`,

  'src/validation/report.ts': `export function validateReportQuery(input: unknown): { title: string } {
  return { title: String((input as { title?: string }).title ?? 'untitled') };
}
`,

  'src/types.ts': `export type ReportId = string;
export type Nullable<T> = T | null;
`,

  'tests/report.test.ts': `import { describe, expect, it } from 'vitest';
import { ReportService } from '../src/services/report.js';

describe('ReportService', () => {
  it('returns a record', async () => {
    const service = new ReportService();
    expect(await service.findById('1')).toBeTruthy();
  });
});
`,

  'schema.sql': `CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE report_shares (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  shared_with TEXT NOT NULL
);
`,

  'docker-compose.yml': `services:
  api:
    image: node:22-alpine
    ports:
      - "3000:3000"
  worker:
    image: node:22-alpine
`,

  '.gitignore': 'node_modules/\ndist/\n*.log\n',
  'README.md': `# sample-service\n\nA sample service used in tests.\n`,
};

/** A Python project exercising the Python extractor. */
export const SAMPLE_PY_PROJECT: FixtureTree = {
  'pyproject.toml': `[project]\nname = "sample-py"\nversion = "0.1.0"\ndependencies = ["fastapi"]\n`,
  'app/main.py': `from fastapi import FastAPI
from app.repo import ReportRepo

app = FastAPI()


@app.get("/reports/{report_id}")
async def get_report(report_id: str):
    repo = ReportRepo()
    return repo.fetch(report_id)


class HealthController:
    def check(self) -> bool:
        return True
`,
  'app/repo.py': `import sqlite3

MAX_LIMIT = 100


class ReportRepo:
    """Docstring mentioning def not_a_function() on purpose."""

    def fetch(self, report_id):
        connection = sqlite3.connect("reports.db")
        return connection.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()

    def _internal(self):
        return None
`,
};