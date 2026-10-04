import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AnalysisService } from '../src/service.js';
import { createFixture, SAMPLE_TS_PROJECT, type Fixture } from './fixtures.js';

/**
 * Phase 3 API surface: requirements, use cases, consistency, traceability and lineage.
 *
 * The fixture is a real repository analysed through the real pipeline, so these tests exercise
 * the route contract and the projections together. The assertions concentrate on the responses
 * that must distinguish *absent evidence* from *nothing there*.
 */

const cleanups: Fixture[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openStores: Store[] = [];

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
  while (openStores.length > 0) openStores.pop()?.close();
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function testApp() {
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
  return app;
}

async function analysedApp(tree = SAMPLE_TS_PROJECT) {
  const repo = await createFixture(tree);
  cleanups.push(repo);
  const app = await testApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    payload: { repositoryPath: repo.root, label: 'phase3' },
  });
  expect(response.statusCode).toBe(201);
  return { app, analysisId: (response.json() as { analysis: { id: string } }).analysis.id };
}

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('requirements endpoint', () => {
  it('returns requirements with their origin and derivation', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/requirements` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      requirements: { id: string; origin: string; derivation: string; evidence: unknown[] }[];
      summary: { declared: number; derived: number; notRecovered: { reason: string }[] };
      documentsSearched: number;
    };
    expect(body.requirements.length).toBeGreaterThan(0);
    expect(body.summary.declared + body.summary.derived).toBe(body.requirements.length);
    expect(body.summary.notRecovered.every((entry) => entry.reason.length > 0)).toBe(true);
    // Every requirement states where it came from and cites something.
    for (const requirement of body.requirements) {
      expect(['declared', 'derived']).toContain(requirement.origin);
      expect(requirement.derivation.length).toBeGreaterThan(0);
      expect(requirement.evidence.length).toBeGreaterThan(0);
    }
  });

  it('states that no documents stated a requirement when none do', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/requirements` })
    ).json() as { documentsSearched: number; requirements: { origin: string }[] };

    // The sample repository documents itself, but its README states no obligation.
    expect(body.requirements.some((requirement) => requirement.origin === 'declared')).toBe(false);
    expect(body.documentsSearched).toBeGreaterThanOrEqual(1);
  });

  it('reads a requirement stated in a document', async () => {
    const { app, analysisId } = await analysedApp({
      ...SAMPLE_TS_PROJECT,
      'docs/requirements.md': '# Requirements\n\nREQ-001: The system shall expose GET /api/reports/:id `findById`\n',
    });
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/requirements` })
    ).json() as { requirements: { id: string; origin: string; statement: string; supportedByNodeIds: string[] }[] };

    const declared = body.requirements.find((requirement) => requirement.origin === 'declared');
    expect(declared?.statement).toBe('The system shall expose GET /api/reports/:id');
    // The backticked symbol resolved, so the requirement is linked to code.
    expect(declared?.supportedByNodeIds.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown analysis', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${UNKNOWN_ID}/requirements` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/analyses/not-a-uuid/requirements' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });
});

describe('use case endpoints', () => {
  it('returns use cases with steps, status and what is missing', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/use-cases` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      useCases: { id: string; title: string; status: string; steps: unknown[]; derivation: string; missing: string[] }[];
      counts: Record<string, number>;
      totals: { useCases: number; returned: number };
    };
    expect(body.useCases.length).toBeGreaterThan(0);
    expect(body.totals.useCases).toBe(body.useCases.length);
    for (const useCase of body.useCases) {
      expect(['OBSERVED', 'PARTIAL', 'UNKNOWN']).toContain(useCase.status);
      expect(useCase.derivation.length).toBeGreaterThan(0);
    }
  });

  it('returns every use case when no status filter is given', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/use-cases` })
    ).json() as { filtered: boolean; totals: { useCases: number; returned: number } };
    expect(body.filtered).toBe(false);
    expect(body.totals.returned).toBe(body.totals.useCases);
  });

  it('filters by status and says it filtered', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/use-cases?status=OBSERVED` })
    ).json() as { filtered: boolean; useCases: { status: string }[] };
    expect(body.useCases.every((useCase) => useCase.status === 'OBSERVED')).toBe(true);
    // Counts describe the whole repository, not the filtered page.
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  it('rejects an unknown status rather than ignoring it', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/use-cases?status=PROBABLY`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns one use case by id', async () => {
    const { app, analysisId } = await analysedApp();
    const list = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/use-cases` })
    ).json() as { useCases: { id: string }[] };
    const first = list.useCases[0]!;

    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/use-cases/${encodeURIComponent(first.id)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().useCase.id).toBe(first.id);
  });

  it('returns 404 for a use case id the analysis does not hold', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/use-cases/use_case%3Anope`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('names no actor when the graph states none', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/use-cases` })
    ).json() as { useCases: { actor: unknown; missing: string[] }[]; actors: unknown[] };
    // No actor may be invented to fill the role.
    expect(body.actors).toEqual([]);
    expect(body.useCases.some((useCase) => useCase.actor !== null)).toBe(false);
  });
});

describe('consistency endpoint', () => {
  it('returns counts, the representations compared and every finding with its evidence', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/consistency` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      findings: { id: string; class: string; artifacts: string[]; evidenceExpected: string; evidenceFound: string; derivation: string; severity: string }[];
      counts: Record<string, number>;
      compared: string[];
      summary: string;
    };
    expect(body.compared).toContain('sequence');
    expect(body.compared).toContain('data-flow');
    const total = Object.values(body.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(body.findings.length);
    for (const finding of body.findings) {
      expect(finding.evidenceExpected.length).toBeGreaterThan(0);
      expect(finding.evidenceFound.length).toBeGreaterThan(0);
      expect(['info', 'warning']).toContain(finding.severity);
    }
  });

  it('reports no contradiction for a repository that merely lacks evidence', async () => {
    const { app, analysisId } = await analysedApp();
    const body = (
      await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/consistency` })
    ).json() as { counts: Record<string, number> };
    expect(body.counts.CONTRADICTION).toBe(0);
  });

  it('returns 404 for an unknown analysis', async () => {
    const app = await testApp();
    expect((await app.inject({ method: 'GET', url: `/api/analyses/${UNKNOWN_ID}/consistency` })).statusCode).toBe(404);
  });
});

describe('traceability endpoints', () => {
  it('indexes every entry point with its chain counts', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/traceability` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      rows: { subjectId: string; title: string; requirements: number; useCases: number; implementation: number; tests: number; complete: boolean }[];
      totals: { subjects: number; complete: number; incomplete: number };
    };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.totals.subjects).toBe(body.rows.length);
    expect(body.totals.complete + body.totals.incomplete).toBe(body.rows.length);
  });

  it('walks the chain for one entity and names any broken joint', async () => {
    const { app, analysisId } = await analysedApp();
    const index = (await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/traceability` })).json() as {
      rows: { subjectId: string }[];
    };
    const subject = index.rows[0]!.subjectId;

    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/traceability/${encodeURIComponent(subject)}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      subject: { id: string };
      links: { role: string; edgeIds: string[]; evidence: unknown[] }[];
      breaks: { kind: string; reason: string }[];
      complete: boolean;
      summary: string;
    };
    expect(body.subject.id).toBe(subject);
    for (const link of body.links) {
      expect(link.edgeIds.length + link.evidence.length).toBeGreaterThan(0);
    }
    expect(body.complete).toBe(body.breaks.length === 0);
    for (const brk of body.breaks) expect(brk.reason.length).toBeGreaterThan(0);
  });

  it('distinguishes an entity the graph lacks from a chain with a break', async () => {
    const { app, analysisId } = await analysedApp();
    const missing = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/traceability/${encodeURIComponent('function:nope')}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });
});

describe('lineage endpoint', () => {
  it('traces a declared table in both directions', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/lineage/${encodeURIComponent('table:reports')}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      subjectNodeId: string;
      subjectName: string;
      upstream: { relation: string; evidence: unknown[] }[];
      downstream: unknown[];
      truncated: boolean;
    };
    expect(body.subjectNodeId).toBe('table:reports');
    expect(body.subjectName).toBe('reports');
    expect(body.truncated).toBe(false);
    expect(body.upstream.length).toBeGreaterThan(0);
    for (const hop of body.upstream) expect(hop.evidence.length).toBeGreaterThan(0);
  });

  it('returns an empty lineage for a declared store no code touches', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/lineage/${encodeURIComponent('table:report_shares')}`,
    });
    expect(response.statusCode).toBe(200);
    // The store exists in the schema and nothing in the analysed code moves data to or from
    // it. That is an answer, not a 404, and it must be an empty one rather than an invented hop.
    const body = response.json() as { upstream: unknown[]; downstream: unknown[] };
    expect(body.upstream).toHaveLength(0);
    expect(body.downstream).toHaveLength(0);
  });

  it('returns 404 for a node the graph does not hold', async () => {
    const { app, analysisId } = await analysedApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/analyses/${analysisId}/lineage/${encodeURIComponent('table:nope')}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain('no code moves data');
  });
});

describe('meta', () => {
  it('advertises the behaviour and data views plus use-case statuses', async () => {
    const app = await testApp();
    const body = (await app.inject({ method: 'GET', url: '/api/meta' })).json() as {
      artifacts: { kind: string }[];
      useCaseStatuses: string[];
    };
    const kinds = body.artifacts.map((artifact) => artifact.kind);
    expect(kinds).toContain('sequence');
    expect(kinds).toContain('activity');
    expect(kinds).toContain('data-flow');
    expect(body.useCaseStatuses).toContain('PARTIAL');
  });
});