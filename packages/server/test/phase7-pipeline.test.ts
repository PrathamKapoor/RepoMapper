import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AnalysisService } from '../src/service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { MULTI_SERVICE_FIXTURE } from './phase7-fixture.js';

const cleanups: Fixture[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openStores: Store[] = [];

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
  while (openStores.length > 0) openStores.pop()?.close();
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function analysedApp() {
  const repo = await createFixture(MULTI_SERVICE_FIXTURE);
  cleanups.push(repo);
  const config: ServerConfig = loadConfig({
    NODE_ENV: 'test',
    REPOATLAS_LOG_LEVEL: 'silent',
    REPOATLAS_DB_PATH: ':memory:',
    REPOATLAS_API_KEYS: 'test-key',
  } as NodeJS.ProcessEnv);
  const store = new Store(':memory:');
  openStores.push(store);
  const app = await buildApp({ config, store, service: new AnalysisService({ config, store }) });
  openApps.push(app);
  await app.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    payload: { repositoryPath: repo.root, label: 'phase7' },
    headers: { 'x-api-key': 'test-key' },
  });
  expect(created.statusCode).toBe(201);
  const analysisId = (created.json() as { analysis: { id: string } }).analysis.id;
  return { app, analysisId };
}

describe('Phase 7: Full pipeline with multi-service fixture', () => {
  it('analyses the fixture and produces a coherent graph', async () => {
    const { app, analysisId } = await analysedApp();
    const graph = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/graph?limit=5000&edgeLimit=10000`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { nodes: { kind: string }[]; edges: { kind: string }[]; totals: { nodes: number; edges: number } };
    expect(graph.totals.nodes).toBeGreaterThan(30);
    expect(graph.totals.edges).toBeGreaterThan(30);
    const nodeKinds = new Set(graph.nodes.map((n) => n.kind));
    expect(nodeKinds.has('module')).toBe(true);
    expect(nodeKinds.has('deployment_component')).toBe(true);
    expect(nodeKinds.has('network')).toBe(true);
    expect(nodeKinds.has('secret')).toBe(true);
    expect(nodeKinds.has('table')).toBe(true);
  });

  it('produces all artifacts without error', async () => {
    const { app, analysisId } = await analysedApp();
    const artifacts = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { artifacts: { kind: string }[] };
    const kinds = artifacts.artifacts.map((a) => a.kind);
    for (const kind of ['dependency-graph', 'module-graph', 'class-diagram', 'er-diagram', 'c4-context', 'c4-container', 'c4-component', 'sequence', 'activity', 'data-flow', 'deployment', 'security']) {
      expect(kinds).toContain(kind);
    }
  });

  it('deployment view shows the declared topology', async () => {
    const { app, analysisId } = await analysedApp();
    const deployment = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts/deployment`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { nodes: { label: string }[]; scope: string };
    const names = deployment.nodes.map((n) => n.label);
    expect(names).toContain('web');
    expect(names).toContain('api');
    expect(names).toContain('worker');
    expect(names).toContain('db');
    expect(names).toContain('cache');
    expect(deployment.scope).toContain('Nothing here has been observed running');
  });

  it('security view reports credential names without values', async () => {
    const { app, analysisId } = await analysedApp();
    const security = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts/security`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { nodes: { kind: string; label: string }[] };
    const body = JSON.stringify(security);
    expect(body).toContain('WEB_SECRET_KEY');
    expect(body).toContain('API_SECRET_KEY');
    expect(body).toContain('DEPLOY_SECRET');
    expect(body).not.toContain('super-secret-value-12345');
    expect(body).not.toContain('another-secret-value-67890');
    expect(body).not.toContain('db-password-secret');
  });

  it('C4 views are consistent with the graph', async () => {
    const { app, analysisId } = await analysedApp();
    const c4 = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts/c4-container`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { nodes: { id: string; type: string }[]; edges: { source: string; target: string }[] };
    expect(c4.nodes.length).toBeGreaterThan(0);
    for (const edge of c4.edges) {
      expect(c4.nodes.some((n) => n.id === edge.source)).toBe(true);
      expect(c4.nodes.some((n) => n.id === edge.target)).toBe(true);
    }
  });

  it('consistency report has no contradictions', async () => {
    const { app, analysisId } = await analysedApp();
    const consistency = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/consistency`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { counts: { CONTRADICTION: number } };
    expect(consistency.counts.CONTRADICTION).toBe(0);
  });

  it('snapshot and drift work correctly', async () => {
    const { app, analysisId } = await analysedApp();
    const snapshot = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/snapshot`,
      headers: { 'x-api-key': 'test-key' },
    })).json() as { snapshot: { snapshotId: string; graphDigest: string } };
    expect(snapshot.snapshot.snapshotId).toMatch(/^snap_/);
    expect(snapshot.snapshot.graphDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
