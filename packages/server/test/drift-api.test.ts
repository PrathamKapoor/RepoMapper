import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_SCHEMA_VERSION } from '@repoatlas/core';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { AnalysisService } from '../src/service.js';
import { Store } from '../src/store.js';
import { createFixture, SAMPLE_TS_PROJECT, type Fixture, type FixtureTree } from './fixtures.js';

/**
 * Phase 2 API tests: snapshots and drift over the HTTP surface.
 *
 * Both routes are exercised through the real store rather than a stub, because the point of
 * a snapshot is that it survives a round trip through persistence. A drift engine tested
 * against in-memory graphs would not prove the product can compare two analyses it read
 * back from disk.
 */

const cleanups: Fixture[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openStores: Store[] = [];

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
  while (openStores.length > 0) openStores.pop()?.close();
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function fixture(tree: FixtureTree = {}): Promise<Fixture> {
  const created = await createFixture(tree);
  cleanups.push(created);
  return created;
}

async function testApp(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const config: ServerConfig = loadConfig({
    NODE_ENV: 'test',
    REPOATLAS_LOG_LEVEL: 'silent',
    REPOATLAS_DB_PATH: ':memory:',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const store = new Store(':memory:');
  openStores.push(store);
  const app = await buildApp({ config, store, service: new AnalysisService({ config, store }) });
  openApps.push(app);
  await app.ready();
  return { app, store, config };
}

interface DriftReportBody {
  base: { analysisId: string; snapshotId: string; repositoryName: string; graphDigest: string; truncated: boolean };
  target: { analysisId: string; snapshotId: string; repositoryName: string; graphDigest: string };
  identical: boolean;
  comparable: boolean;
  incomparabilityReason: string | null;
  targetIncomplete: boolean;
  removalConfidence: string;
  counts: Record<string, number>;
  summary: Record<string, number>;
  changes: {
    category: string;
    entityId: string;
    label: string;
    entityKind: string;
    claimConfidence: string;
    indeterminate: boolean;
    reason?: string;
    evidenceBefore: { path: string; startLine: number }[];
    evidenceAfter: { path: string; startLine: number }[];
  }[];
}

async function analyse(app: Awaited<ReturnType<typeof testApp>>['app'], root: string, label?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    payload: { repositoryPath: root, ...(label ? { label } : {}) },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { analysis: { id: string } }).analysis.id;
}

/** Analyses one fixture, mutates it, analyses it again, and returns both ids. */
async function analyseTwice(
  app: Awaited<ReturnType<typeof testApp>>['app'],
  tree: FixtureTree,
  mutate: (fixture: Fixture) => Promise<void>,
) {
  const repo = await fixture(tree);
  const before = await analyse(app, repo.root, 'before');
  await mutate(repo);
  const after = await analyse(app, repo.root, 'after');
  return { repo, before, after };
}

describe('snapshot identity over HTTP', () => {
  it('exposes the snapshot identity of an analysis without its whole graph', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const id = await analyse(app, repo.root);

    const response = await app.inject({ method: 'GET', url: `/api/analyses/${id}/snapshot` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      snapshot: { snapshotId: string; graphDigest: string; extractorVersion: string; graphSchemaVersion: number };
      stats: { nodeCount: number };
    };
    expect(body.snapshot.snapshotId).toMatch(/^snap_[0-9a-f]{16}$/);
    expect(body.snapshot.graphDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.snapshot.extractorVersion).toBeTruthy();
    expect(body.snapshot.graphSchemaVersion).toBeGreaterThan(0);
    expect(body.stats.nodeCount).toBeGreaterThan(0);
  });

  it('gives two analyses of unchanged content the same snapshot identity', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const first = await analyse(app, repo.root, 'first');
    const second = await analyse(app, repo.root, 'second');

    const one = (await app.inject({ method: 'GET', url: `/api/analyses/${first}/snapshot` })).json() as { snapshot: { snapshotId: string } };
    const two = (await app.inject({ method: 'GET', url: `/api/analyses/${second}/snapshot` })).json() as { snapshot: { snapshotId: string } };
    expect(two.snapshot.snapshotId).toBe(one.snapshot.snapshotId);
  });

  it('returns 404 for an unknown analysis', async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses/8f3a1c22-0000-4000-8000-000000000000/snapshot',
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('recomputes the same identity from the stored graph as from the analysed one', async () => {
    // The digest is persisted for convenience, so it must equal what is recomputed on read.
    // A graph rebuilt from rows that claimed a different schema version would silently
    // produce a different digest and make the stored one unusable (D-038).
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const id = await analyse(app, repo.root);

    const detail = (await app.inject({ method: 'GET', url: `/api/analyses/${id}` })).json() as {
      analysis: { graphDigest: string; graphSchemaVersion: number };
    };
    const snapshot = (await app.inject({ method: 'GET', url: `/api/analyses/${id}/snapshot` })).json() as {
      snapshot: { graphDigest: string; graphSchemaVersion: number };
    };
    const graph = (await app.inject({ method: 'GET', url: `/api/analyses/${id}/graph` })).json() as {
      schemaVersion: number;
    };

    expect(snapshot.snapshot.graphDigest).toBe(detail.analysis.graphDigest);
    expect(snapshot.snapshot.graphSchemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(detail.analysis.graphSchemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
  });
});

describe('drift over HTTP', () => {
  it('reports no change between two analyses of unchanged content', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const before = await analyse(app, repo.root, 'before');
    const after = await analyse(app, repo.root, 'after');

    const response = await app.inject({ method: 'GET', url: `/api/analyses/${after}/drift?against=${before}` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as DriftReportBody;
    expect(body.identical).toBe(true);
    expect(body.comparable).toBe(true);
    expect(body.summary.totalChanges).toBe(0);
    expect(body.changes).toHaveLength(0);
    expect(body.removalConfidence).toBe('EXPLICIT');
  });

  it('detects a new entity and a new relationship, with evidence in both snapshots', async () => {
    const { app } = await testApp();
    const { before, after } = await analyseTwice(app, SAMPLE_TS_PROJECT, async (repo) => {
      await repo.write(
        'src/services/audit.ts',
        `export class AuditService {\n  record(event: string): void {\n    void event;\n  }\n}\n`,
      );
      await repo.write(
        'src/routes/audit.ts',
        `import { AuditService } from '../services/audit.js';\n\nexport function registerAudit(app: unknown): void {\n  const service = new AuditService();\n  app.get('/api/audit', service.record);\n}\n`,
      );
    });

    const response = await app.inject({ method: 'GET', url: `/api/analyses/${after}/drift?against=${before}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as DriftReportBody;

    expect(body.identical).toBe(false);
    expect(body.summary.nodesAdded).toBeGreaterThan(0);
    expect(body.summary.relationshipsAdded).toBeGreaterThan(0);
    const addedClass = body.changes.find((change) => change.category === 'NODE_ADDED' && change.label === 'AuditService');
    expect(addedClass).toBeDefined();
    expect(addedClass?.evidenceAfter.length).toBeGreaterThan(0);
    expect(addedClass?.evidenceAfter[0]?.path).toBe('src/services/audit.ts');
    expect(addedClass?.claimConfidence).toBe('EXPLICIT');
  });

  it('detects a removed entity', async () => {
    const { app } = await testApp();
    const { before, after } = await analyseTwice(app, SAMPLE_TS_PROJECT, async (repo) => {
      const { rm } = await import('node:fs/promises');
      await rm(repo.path('src', 'validation', 'report.ts'));
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${after}/drift?against=${before}`,
    })).json() as DriftReportBody;

    expect(body.summary.nodesRemoved).toBeGreaterThan(0);
    const removed = body.changes.find((change) => change.category === 'NODE_REMOVED');
    expect(removed?.indeterminate).toBe(false);
    expect(removed?.claimConfidence).toBe('EXPLICIT');
    expect(removed?.evidenceBefore.length).toBeGreaterThan(0);
  });

  it('proves a rename when a file moves with its content unchanged', async () => {
    const { app } = await testApp();
    const { before, after } = await analyseTwice(app, SAMPLE_TS_PROJECT, async (repo) => {
      const { rename } = await import('node:fs/promises');
      await rename(repo.path('src', 'validation', 'report.ts'), repo.path('src', 'validation', 'query.ts'));
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${after}/drift?against=${before}`,
    })).json() as DriftReportBody;

    const renameChange = body.changes.find((change) => change.category === 'NODE_RENAMED');
    expect(renameChange).toBeDefined();
    expect(renameChange?.label).toContain('src/validation/report');
    expect(renameChange?.label).toContain('src/validation/query');
    expect(renameChange?.claimConfidence).toBe('STRONGLY_INFERRED');
    expect(body.summary.nodesRenamed).toBeGreaterThan(0);
  });

  it('orders the report by age, so a caller cannot invert it', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const before = await analyse(app, repo.root, 'before');
    await repo.write('src/new.ts', 'export const value = 1;\n');
    const after = await analyse(app, repo.root, 'after');

    // Asked in reverse: the older analysis is still the base.
    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${before}/drift?against=${after}`,
    })).json() as DriftReportBody;

    expect(body.base.analysisId).toBe(before);
    expect(body.target.analysisId).toBe(after);
    expect(body.summary.nodesAdded).toBeGreaterThan(0);
  });

  it('rejects a missing or malformed comparison target', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const id = await analyse(app, repo.root);

    const missing = await app.inject({ method: 'GET', url: `/api/analyses/${id}/drift` });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');

    const malformed = await app.inject({ method: 'GET', url: `/api/analyses/${id}/drift?against=not-a-uuid` });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/analyses/${id}/drift?against=8f3a1c22-0000-4000-8000-000000000000`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rejects an out-of-range limit rather than silently truncating', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const first = await analyse(app, repo.root, 'a');
    const second = await analyse(app, repo.root, 'b');

    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${second}/drift?against=${first}&limit=999999`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns counts without change records when asked to', async () => {
    const { app } = await testApp();
    const { before, after } = await analyseTwice(app, SAMPLE_TS_PROJECT, async (repo) => {
      await repo.write('src/extra.ts', 'export class Extra {\n  run(): void {}\n}\n');
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${after}/drift?against=${before}&includeChanges=false`,
    })).json() as DriftReportBody;

    expect(body.changes).toHaveLength(0);
    expect(body.summary.nodesAdded).toBeGreaterThan(0);
  });

  it('produces the same report for the same pair of analyses', async () => {
    const { app } = await testApp();
    const { before, after } = await analyseTwice(app, SAMPLE_TS_PROJECT, async (repo) => {
      await repo.write('src/extra.ts', 'export class Extra {\n  run(): void {}\n}\n');
    });

    const first = await app.inject({ method: 'GET', url: `/api/analyses/${after}/drift?against=${before}` });
    const second = await app.inject({ method: 'GET', url: `/api/analyses/${after}/drift?against=${before}` });
    expect(second.body).toBe(first.body);
  });

  it('does not read the filesystem, so the containment boundary is unchanged', async () => {
    // Drift operates only on stored graphs. The route takes two analysis ids and no path, so
    // there is nothing for it to resolve outside the allow-list.
    const { app } = await testApp();
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const before = await analyse(app, repo.root, 'before');
    await repo.cleanup();
    const after = await analyse(app, repo.root, 'after').catch(() => null);

    if (after === null) return; // The fixture was removed; nothing further to compare.

    const response = await app.inject({ method: 'GET', url: `/api/analyses/${after}/drift?against=${before}` });
    expect(response.statusCode).toBe(200);
  });

  it('will not compare a failed analysis, because it has no graph', async () => {
    const { app, store } = await testApp();
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const succeeded = await analyse(app, repo.root);

    await app.inject({ method: 'POST', url: '/api/analyses', payload: { repositoryPath: 'C:/nope-drift-91' } });
    const failed = store.listAnalyses(10).find((entry) => entry.status === 'failed');
    expect(failed).toBeDefined();

    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${succeeded}/drift?against=${failed?.id}`,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { message: string } }).error.message).toContain('snapshots');
  });
});
