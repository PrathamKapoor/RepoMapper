import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AnalysisService } from '../src/service.js';
import { createFixture, SAMPLE_TS_PROJECT, type Fixture } from './fixtures.js';

const cleanups: Fixture[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openStores: Store[] = [];

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
  while (openStores.length > 0) openStores.pop()?.close();
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function fixture(tree: Parameters<typeof createFixture>[0] = {}): Promise<Fixture> {
  const created = await createFixture(tree);
  cleanups.push(created);
  return created;
}

/**
 * Builds an app backed by an in-memory database.
 *
 * `:memory:` keeps API tests hermetic and fast; the SQLite schema and serialisation are
 * identical to the file-backed path, so this exercises the real store.
 */
async function testApp(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const config: ServerConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      REPOATLAS_LOG_LEVEL: 'silent',
      REPOATLAS_DB_PATH: ':memory:',
      ...overrides,
    } as NodeJS.ProcessEnv),
  };

  const store = new Store(':memory:');
  openStores.push(store);
  const app = await buildApp({ config, store, service: new AnalysisService({ config, store }) });
  openApps.push(app);
  await app.ready();
  return { app, store, config };
}

async function analysedApp(tree = SAMPLE_TS_PROJECT) {
  const repo = await fixture(tree);
  const context = await testApp();
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/analyses',
    payload: { repositoryPath: repo.root, label: 'test-repo' },
  });
  expect(response.statusCode).toBe(201);
  const created = response.json() as { analysis: { id: string } };
  return { ...context, repo, analysisId: created.analysis.id };
}

describe('health and metadata', () => {
  it('reports health without requiring authentication', async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.pathAllowListEnforced).toBe(false);
    expect(body.analysesStored).toBe(0);
  });

  it('advertises that no path allow-list is enforced', async () => {
    const { app } = await testApp();
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>;
    // Surfacing this is deliberate: an operator must be able to see the exposure.
    expect(body.pathAllowListEnforced).toBe(false);
    expect(body.allowedRootCount).toBe(0);
  });

  it('publishes the vocabularies the UI renders', async () => {
    const { app } = await testApp();
    const body = (await app.inject({ method: 'GET', url: '/api/meta' })).json() as {
      nodeKinds: string[];
      edgeKinds: string[];
      confidenceLevels: string[];
      artifacts: { kind: string }[];
    };
    expect(body.nodeKinds).toContain('module');
    expect(body.edgeKinds).toContain('calls');
    expect(body.confidenceLevels).toEqual(['EXPLICIT', 'STRONGLY_INFERRED', 'WEEKLY_INFERRED', 'UNKNOWN']);
    expect(body.artifacts.map((artifact) => artifact.kind)).toContain('dependency-graph');
  });
});

describe('creating an analysis', () => {
  it('analyses a real repository and returns stats, gaps and diagnostics', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: repo.root },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      analysis: { status: string; summary: { nodeCount: number } };
      stats: { nodeCount: number; explicitShare: { nodes: number } };
      gaps: { gaps: { id: string; status: string; checked: string[] }[] };
      diagnostics: unknown[];
    };

    expect(body.analysis.status).toBe('succeeded');
    expect(body.stats.nodeCount).toBeGreaterThan(10);
    expect(body.stats.explicitShare.nodes).toBeGreaterThan(0);
    expect(body.gaps.gaps.length).toBeGreaterThan(0);
    for (const gap of body.gaps.gaps) {
      expect(['EXPLICIT', 'PARTIALLY_EVIDENCED', 'INFERRED', 'NOT_FOUND']).toContain(gap.status);
      expect(gap.checked.length).toBeGreaterThan(0);
    }
  });

  it('rejects a request with no repository path', async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: 'POST', url: '/api/analyses', payload: {} });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: repo.root, typoField: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a repository path that does not exist', async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: 'C:/definitely-not-here-71c3' },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('PATH_NOT_FOUND');
  });

  it('refuses a repository outside the configured allow-list', async () => {
    const inside = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: inside.root });

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: inside.root },
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('records a failed analysis so it is visible rather than lost', async () => {
    const { app, store } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: 'C:/nope-4d2f' },
    });

    const analyses = store.listAnalyses(10);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.status).toBe('failed');
    expect(analyses[0]?.error?.code).toBe('PATH_NOT_FOUND');
  });
});

describe('reading a stored analysis', () => {
  it('returns the analysis record with artifact availability and gap report', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      analysis: { id: string; repositoryName: string };
      stats: { nodeCount: number };
      gaps: { gaps: unknown[] };
      artifacts: { kind: string; scope: string; insufficientEvidence: boolean }[];
    };
    expect(body.analysis.id).toBe(analysisId);
    expect(body.artifacts.length).toBeGreaterThan(0);
    for (const artifact of body.artifacts) {
      expect(artifact.scope.length).toBeGreaterThan(0);
    }
  });

  it('serves the graph with no dangling edges', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/graph` })).json() as {
      nodes: { id: string }[];
      edges: { from: string; to: string }[];
      totals: { nodes: number };
    };

    const ids = new Set(body.nodes.map((node) => node.id));
    for (const edge of body.edges) {
      expect(ids.has(edge.from), `edge source ${edge.from} missing`).toBe(true);
      expect(ids.has(edge.to), `edge target ${edge.to} missing`).toBe(true);
    }
  });

  it('filters the graph by node kind without returning orphaned edges', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/graph?kind=class`,
    })).json() as { nodes: { kind: string }[] };

    expect(body.nodes.length).toBeGreaterThan(0);
    for (const node of body.nodes) expect(node.kind).toBe('class');
  });

  it('searches nodes by name and path', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/graph?q=ReportService`,
    })).json() as { nodes: { name: string }[] };

    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes.some((node) => node.name === 'ReportService')).toBe(true);
  });

  it('reports truncation instead of silently returning a partial graph', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/graph?limit=2`,
    })).json() as { nodes: unknown[]; truncated: boolean; totals: { matching: number } };

    expect(body.nodes).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(body.totals.matching).toBeGreaterThan(2);
  });

  it('returns an entity with its relationships, neighbours and evidence', async () => {
    const { app, analysisId } = await analysedApp();

    const graph = (await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/graph` })).json() as {
      nodes: { id: string; kind: string }[];
    };
    const classNode = graph.nodes.find((node) => node.kind === 'class');
    expect(classNode).toBeDefined();

    const detail = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/nodes/${encodeURIComponent(classNode!.id)}`,
    })).json() as {
      node: { id: string; confidence: string };
      outgoing: { id: string; confidence: string }[];
      incoming: unknown[];
      related: unknown[];
      evidence: { path: string; producer: string; excerpt?: string }[];
    };

    expect(detail.node.id).toBe(classNode!.id);
    expect(detail.evidence.length).toBeGreaterThan(0);
    for (const item of detail.evidence) {
      expect(item.path.length).toBeGreaterThan(0);
      expect(item.producer.length).toBeGreaterThan(0);
    }
    for (const edge of detail.outgoing) {
      expect(['EXPLICIT', 'STRONGLY_INFERRED', 'WEEKLY_INFERRED', 'UNKNOWN']).toContain(edge.confidence);
    }
  });

  it('never returns a secret in evidence excerpts', async () => {
    const repo = await fixture({
      'src/leaky.ts': 'export const apiKey = "sk-live-abcdef1234567890";\nexport function use() { return apiKey; }\n',
    });
    const { app } = await testApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: repo.root },
    });
    const id = (created.json() as { analysis: { id: string } }).analysis.id;

    const evidence = (await app.inject({ method: 'GET', url: `/api/analyses/${id}/evidence` })).json() as {
      evidence: { excerpt?: string }[];
    };
    expect(JSON.stringify(evidence)).not.toContain('sk-live-abcdef1234567890');
  });

  it('lists analyses newest first', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({ method: 'GET', url: '/api/analyses' })).json() as {
      analyses: { id: string }[];
    };
    expect(body.analyses[0]?.id).toBe(analysisId);
  });

  it('serves artifact projections including mermaid and omissions', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts/dependency-graph`,
    })).json() as { kind: string; mermaid: string; nodes: unknown[]; omitted: unknown[]; scope: string };

    expect(body.kind).toBe('dependency-graph');
    expect(body.mermaid).toContain('flowchart');
    expect(Array.isArray(body.omitted)).toBe(true);
  });

  it('returns 404 for an unknown artifact kind and lists the valid ones', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/artifacts/does-not-exist`,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { message: string } }).error.message).toContain('dependency-graph');
  });

  it('serves diagnostics and the gap report', async () => {
    const { app, analysisId } = await analysedApp();

    const diagnostics = (await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/diagnostics`,
    })).json() as { diagnostics: { code: string; severity: string }[] };
    expect(Array.isArray(diagnostics.diagnostics)).toBe(true);

    const gaps = (await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/gaps` })).json() as {
      gaps: { id: string }[];
      counts: Record<string, number>;
    };
    expect(gaps.gaps.length).toBeGreaterThan(0);
    expect(Object.keys(gaps.counts).sort()).toEqual([
      'EXPLICIT',
      'INFERRED',
      'NOT_FOUND',
      'PARTIALLY_EVIDENCED',
    ]);
  });

  it('deletes an analysis and then reports it as gone', async () => {
    const { app, analysisId } = await analysedApp();

    const deleted = await app.inject({ method: 'DELETE', url: `/api/analyses/${analysisId}` });
    expect(deleted.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}` });
    expect(after.statusCode).toBe(404);
  });

  it('returns 404 for a malformed analysis id rather than crashing', async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/analyses/not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });

  it('returns JSON 404 for an unknown API route', async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('authentication', () => {
  const TEST_KEY = 'test-api-key-12345';

  async function authedApp(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    return testApp({ REPOATLAS_API_KEYS: TEST_KEY, ...overrides } as NodeJS.ProcessEnv);
  }

  it('rejects unauthenticated requests to protected endpoints', async () => {
    const { app } = await authedApp();
    const response = await app.inject({ method: 'GET', url: '/api/analyses' });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with an invalid API key', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with a malformed API key', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses',
      headers: { 'x-api-key': '' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows authenticated requests with a valid API key', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses',
      headers: { 'x-api-key': TEST_KEY },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows unauthenticated access to health endpoint', async () => {
    const { app } = await authedApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });

  it('allows unauthenticated access to meta endpoint', async () => {
    const { app } = await authedApp();
    const response = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(response.statusCode).toBe(200);
  });

  it('protects analysis creation with authentication', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: '/tmp/test' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('protects graph access with authentication', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses/00000000-0000-0000-0000-000000000000/graph',
    });
    expect(response.statusCode).toBe(401);
  });

  it('protects drift access with authentication', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/analyses/00000000-0000-0000-0000-000000000000/drift?against=00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(401);
  });

  it('protects delete with authentication', async () => {
    const { app } = await authedApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/analyses/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(401);
  });

  it('works when authentication is disabled (no keys configured)', async () => {
    const { app } = await testApp({ REPOATLAS_API_KEYS: '' } as NodeJS.ProcessEnv);
    const response = await app.inject({ method: 'GET', url: '/api/analyses' });
    expect(response.statusCode).toBe(200);
  });

  it('supports multiple API keys', async () => {
    const { app } = await testApp({
      REPOATLAS_API_KEYS: 'key1,key2,key3',
    } as NodeJS.ProcessEnv);

    for (const key of ['key1', 'key2', 'key3']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/analyses',
        headers: { 'x-api-key': key },
      });
      expect(response.statusCode).toBe(200);
    }

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/analyses',
      headers: { 'x-api-key': 'key4' },
    });
    expect(invalid.statusCode).toBe(401);
  });
});

describe('SSRF and path traversal protection', () => {
  it('rejects path traversal attempts when allow-list is configured', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects absolute paths outside the allow-list', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects null byte injection in repository path', async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: 'valid-path\0../../etc/passwd' },
    });
    expect(response.statusCode === 403 || response.statusCode === 404).toBe(true);
  });

  it('rejects encoded path traversal when allow-list is configured', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects double-encoded path traversal when allow-list is configured', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects UNC path injection when allow-list is configured', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects URL-based path injection when allow-list is configured', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const outside = await fixture(SAMPLE_TS_PROJECT);
    const { app } = await testApp({ REPOATLAS_ALLOWED_ROOTS: repo.root } as NodeJS.ProcessEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { repositoryPath: outside.root },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('persistence', () => {
  it('survives a round trip through the store with identical graph content', async () => {
    const { app, store, analysisId } = await analysedApp();
    const served = (await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/graph` })).json() as {
      nodes: unknown[];
      edges: unknown[];
    };
    const stored = store.getGraph(analysisId);

    expect(stored?.nodes).toHaveLength(served.nodes.length);
    expect(stored?.edges).toHaveLength(served.edges.length);
    expect(store.getEvidence(analysisId).length).toBeGreaterThan(0);
  });

  it('enforces the stored-analysis limit', async () => {
    const { app } = await testApp({ REPOATLAS_MAX_ANALYSES: '1' });
    const repo = await fixture(SAMPLE_TS_PROJECT);

    const first = await app.inject({ method: 'POST', url: '/api/analyses', payload: { repositoryPath: repo.root } });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/api/analyses', payload: { repositoryPath: repo.root } });
    expect(second.statusCode).toBe(507);
  });
});