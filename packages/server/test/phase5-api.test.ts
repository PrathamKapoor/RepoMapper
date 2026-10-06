import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AnalysisService } from '../src/service.js';
import { createFixture, SAMPLE_DEPLOYED_PROJECT, type Fixture, type FixtureTree } from './fixtures.js';

/**
 * Phase 5 API surface: the deployment and security views.
 *
 * These exercise a real fixture through the real pipeline, so the assertions are about what a
 * client is actually told. Two properties are checked throughout:
 *
 *  - no response may carry a value written in a compose file or a workflow
 *  - no response may claim something was observed running, or that anything is secure
 */

const cleanups: Fixture[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openStores: Store[] = [];

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
  while (openStores.length > 0) openStores.pop()?.close();
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function analysedApp(tree: FixtureTree) {
  const repo = await createFixture(tree);
  cleanups.push(repo);

  const config: ServerConfig = loadConfig({
    NODE_ENV: 'test',
    REPOATLAS_LOG_LEVEL: 'silent',
    REPOATLAS_DB_PATH: ':memory:',
  } as NodeJS.ProcessEnv);

  const store = new Store(':memory:');
  openStores.push(store);
  const app = await buildApp({ config, store, service: new AnalysisService({ config, store }) });
  openApps.push(app);
  await app.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    payload: { repositoryPath: repo.root, label: 'phase5' },
  });
  expect(created.statusCode).toBe(201);
  const analysisId = (created.json() as { analysis: { id: string } }).analysis.id;
  return { app, analysisId };
}

const SECRET_VALUE = 'shhh-do-not-store-this';

describe('deployment endpoint', () => {
  it('is listed in the artifact catalogue', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts` });
    expect(response.statusCode).toBe(200);
    const kinds = (response.json() as { artifacts: { kind: string }[] }).artifacts.map((entry) => entry.kind);
    expect(kinds).toContain('deployment');
    expect(kinds).toContain('security');
  });

  it('returns the declared services, networks and relationships', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/deployment` });
    expect(response.statusCode).toBe(200);
    const artifact = response.json() as {
      nodes: { label: string; detail?: string }[];
      edges: { kind: string; source: string; target: string; supportingEdgeIds?: string[] }[];
      scope: string;
      insufficientEvidence: boolean;
    };

    expect(artifact.insufficientEvidence).toBe(false);
    const labels = artifact.nodes.map((node) => node.label);
    expect(labels).toContain('api');
    expect(labels).toContain('db');
    expect(labels).toContain('cache');
    expect(labels).toContain('backend');

    const dependency = artifact.edges.find((edge) => edge.kind === 'depends_on');
    expect(dependency?.source).toBe('deployment_component:api');
    expect(dependency?.supportingEdgeIds?.length).toBe(1);
    expect(artifact.edges.some((edge) => edge.kind === 'joins_network')).toBe(true);
  });

  it('says a port is declared rather than bound', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const artifact = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/deployment` })
    ).json() as { nodes: { label: string; detail?: string }[] };
    const api = artifact.nodes.find((node) => node.label === 'api');
    expect(api?.detail).toContain('declared, not observed bound');
  });

  it('states in its scope that nothing was observed running', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const artifact = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/deployment` })
    ).json() as { scope: string };
    expect(artifact.scope).toContain('Nothing here has been observed running');
  });

  it('counts the credential without naming it, and never returns its value', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/deployment` })
    ).body;
    // The credential is reported by the Security view. This view may say it has references to
    // report and may not disclose the name, and it can never carry the value.
    expect(body).not.toContain('STRIPE_SECRET_KEY');
    expect(body).not.toContain(SECRET_VALUE);
    expect(body).toContain('which the Security view reports by name');
  });
});

describe('security endpoint', () => {
  it('returns the credential names the repository references', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const artifact = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/security` })
    ).json() as { nodes: { kind: string; label: string }[] };
    const secrets = artifact.nodes.filter((node) => node.kind === 'secret_reference').map((node) => node.label);
    expect(secrets).toContain('STRIPE_SECRET_KEY');
    expect(secrets).toContain('NPM_TOKEN');
    // NODE_ENV is a credential-looking name to nothing; reporting it would bury the real ones.
    expect(secrets).not.toContain('NODE_ENV');
  });

  it('never returns a secret value anywhere in the response', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/security` });
    expect(response.body).toContain('STRIPE_SECRET_KEY');
    expect(response.body).not.toContain(SECRET_VALUE);
  });

  it('carries no verdict on any element', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const artifact = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/security` })
    ).json() as { nodes: { label: string; detail?: string; derivation?: string }[] };
    for (const node of artifact.nodes) {
      const text = `${node.label} ${node.detail ?? ''} ${node.derivation ?? ''}`.toLowerCase();
      for (const word of ['vulnerable', 'insecure', 'exploit', 'cve-', 'high risk']) {
        expect(text, `${node.label}: ${word}`).not.toContain(word);
      }
    }
  });

  it('keeps the graph itself free of values', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    // The limits are the endpoint's own maxima. What matters here is that a value written in a
    // compose file has no path into any graph payload a client can fetch.
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/graph?limit=5000&edgeLimit=10000` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('STRIPE_SECRET_KEY');
    expect(response.body).not.toContain(SECRET_VALUE);
  });

  it('returns 404 for a view that does not exist, listing what is available', async () => {
    const { app, analysisId } = await analysedApp(SAMPLE_DEPLOYED_PROJECT);
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/artifacts/nonexistent` });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { message: string } }).error.message).toContain('deployment');
  });
});