import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisError } from '@repoatlas/core';
import { runAnalysis } from '../src/analyze.js';
import { loadConfig } from '../src/config.js';
import { createFixture, SAMPLE_PY_PROJECT, SAMPLE_TS_PROJECT, type Fixture } from './fixtures.js';

const cleanups: Fixture[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function fixture(tree: Parameters<typeof createFixture>[0] = {}): Promise<Fixture> {
  const created = await createFixture(tree);
  cleanups.push(created);
  return created;
}

function allWarnings(output: { diagnostics: { message: string }[] }): string {
  return output.diagnostics.map((item) => item.message).join('\n');
}

function allCodes(output: { diagnostics: { code: string }[] }): string[] {
  return output.diagnostics.map((item) => item.code);
}

describe('analysis pipeline on a TypeScript repository', () => {
  it('turns a real repository into a graph with cited evidence', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.analysis.status).toBe('succeeded');
    expect(output.graph.nodes.length).toBeGreaterThan(10);
    expect(output.graph.edges.length).toBeGreaterThan(10);

    // Every node must be cited. An uncited node would be an unsourced claim.
    for (const node of output.graph.nodes) {
      expect(node.evidence.length, `${node.id} has no evidence`).toBeGreaterThan(0);
    }
  });

  it('extracts the classes, functions and interfaces that are actually in the fixture', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    const names = output.graph.nodes.map((node) => node.name);

    expect(names).toContain('ReportService');
    expect(names).toContain('BaseRepository');
    expect(names).toContain('ReportRecord');
    expect(names).toContain('findById');
    expect(names).toContain('validateReportQuery');
  });

  it('resolves cross-directory relative imports inside the repository', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const importEdges = output.graph.edges.filter((edge) => edge.kind === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(3);
    expect(allWarnings(output)).not.toContain('Unresolved relative import');
  });

  it('records API endpoints found in route registrations', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const endpoints = output.graph.nodes.filter((node) => node.kind === 'api_endpoint').map((node) => node.name);
    expect(endpoints).toContain('GET /api/reports/:id');
    expect(endpoints).toContain('POST /api/reports');
  });

  it('records tables and columns from SQL', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.graph.nodes.filter((node) => node.kind === 'table').map((node) => node.name).sort()).toEqual([
      'report_shares',
      'reports',
    ]);
    const columns = output.graph.nodes.filter((node) => node.kind === 'column');
    // Column names repeat across tables, so the qualified name is what identifies one.
    expect(columns.map((node) => node.qualifiedName).sort()).toEqual([
      'report_shares.id',
      'report_shares.report_id',
      'report_shares.shared_with',
      'reports.created_at',
      'reports.id',
      'reports.title',
    ]);
    // Each column is attached to its own table.
    for (const column of columns) {
      const table = String(column.attributes?.table);
      expect(output.graph.edges.some((edge) => edge.kind === 'contains' && edge.from === `table:${table}` && edge.to === column.id)).toBe(true);
    }
  });

  it('records compose services as deployment components', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const components = output.graph.nodes.filter((node) => node.kind === 'deployment_component').map((node) => node.name);
    expect(components).toContain('api');
    expect(components).toContain('worker');
  });

  it('marks the ER projection available because DDL exists', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    const er = output.projection.artifacts.find((artifact) => artifact.kind === 'er-diagram');
    expect(er?.insufficientEvidence).toBe(false);
    expect(er?.nodes.length).toBeGreaterThan(0);
  });

  it('detects a dependency declared in the manifest but never imported', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const hygiene = output.projection.gaps.gaps.find((gap) => gap.id === 'dependency-hygiene');
    expect(hygiene?.observations.join(' ')).toContain('unused-dev-dep');
  });

  it('finds test entities', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    expect(output.graph.nodes.some((node) => node.kind === 'test')).toBe(true);
  });

  it('never lets a secret reach an evidence excerpt', async () => {
    const repo = await fixture({
      ...SAMPLE_TS_PROJECT,
      'src/leaky.ts': 'export const config = { apiKey: "sk-live-abcdef1234567890" };\nexport function use() { return config; }\n',
    });
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const serialised = JSON.stringify(output.graph.evidence);
    expect(serialised).not.toContain('sk-live-abcdef1234567890');
  });

  it('is deterministic across repeated runs of the same repository', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const first = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    const second = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(second.graph.nodes.map((node) => node.id)).toEqual(first.graph.nodes.map((node) => node.id));
    expect(second.stats.nodeCount).toBe(first.stats.nodeCount);
    expect(second.stats.edgeCount).toBe(first.stats.edgeCount);
  });
});

describe('analysis pipeline on a Python repository', () => {
  it('extracts Python classes, methods, imports and routes', async () => {
    const repo = await fixture(SAMPLE_PY_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    const names = output.graph.nodes.map((node) => node.name);
    expect(names).toContain('ReportRepo');
    expect(names).toContain('fetch');
    expect(names).toContain('HealthController');

    const endpoints = output.graph.nodes.filter((node) => node.kind === 'api_endpoint').map((node) => node.name);
    expect(endpoints).toContain('GET /reports/{report_id}');
  });

  it('resolves the relative import between Python modules', async () => {
    const repo = await fixture(SAMPLE_PY_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    expect(allWarnings(output)).not.toContain('Unresolved relative import');
  });
});

describe('analysis pipeline error handling', () => {
  it('reports a path that does not exist', async () => {
    await expect(runAnalysis({ repositoryPath: 'C:/definitely-not-here-4b2c' })).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('reports a path outside the allow-list', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const other = await fixture();
    await expect(
      runAnalysis({ repositoryPath: repo.root, allowedRoots: [other.root] }),
    ).rejects.toBeInstanceOf(AnalysisError);
  });

  it('succeeds on an empty repository and says why it is empty', async () => {
    const repo = await fixture({});
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.analysis.status).toBe('succeeded');
    expect(output.graph.nodes).toHaveLength(1); // the repository node only
    expect(allWarnings(output)).toContain('No analyzable files found');
    expect(output.projection.gaps.gaps.find((gap) => gap.id === 'analysis-completeness')?.status).toBe('NOT_FOUND');
  });

  it('succeeds on a repository with only unsupported files', async () => {
    const repo = await fixture({ 'a.bin': 'nothing parseable', 'b.xyz': 'also nothing' });
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });
    expect(output.analysis.status).toBe('succeeded');
    expect(output.graph.nodes.filter((node) => node.kind !== 'repository')).toHaveLength(0);
  });

  it('survives a file with a syntax error and keeps the rest of the analysis', async () => {
    const repo = await fixture({
      ...SAMPLE_TS_PROJECT,
      'src/broken.ts': 'export class Broken { method( {{{ \n',
    });
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.analysis.status).toBe('succeeded');
    expect(output.graph.nodes.some((node) => node.name === 'ReportService')).toBe(true);
    expect(allWarnings(output)).toContain('broken.ts');
  });

  it('handles a malformed package.json without failing the run', async () => {
    const repo = await fixture({ ...SAMPLE_TS_PROJECT, 'package.json': '{ "name": broken' });
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.analysis.status).toBe('succeeded');
    expect(allWarnings(output)).toContain('CONFIG_INVALID_JSON');
  });

  it('honours a file-count limit and reports truncation rather than pretending to be complete', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({
      repositoryPath: repo.root,
      includeGitHistory: false,
      options: { limits: { maxFiles: 3 } },
    });

    expect(output.analysis.summary?.truncated).toBe(true);
    expect(allCodes(output)).toContain('FILE_COUNT_LIMIT_REACHED');
  });

it('skips files ignored by .gitignore', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({ repositoryPath: repo.root, includeGitHistory: false });

    expect(output.graph.nodes.some((node) => node.path === 'node_modules/x.ts')).toBe(false);
  });

  it('restricts parsing to the requested languages', async () => {
    const repo = await fixture(SAMPLE_TS_PROJECT);
    const output = await runAnalysis({
      repositoryPath: repo.root,
      includeGitHistory: false,
      options: { languages: ['python'] },
    });

    // languageCounts still describes the whole repository; what the filter changes is
    // which files were actually parsed.
    expect(output.analysis.summary?.languageCounts.typescript).toBeGreaterThan(0);
    expect(output.parsed.every((file) => file.language === 'python')).toBe(true);
    expect(output.parsed).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4_300);
    expect(config.allowedRoots).toEqual([]);
    expect(config.pathAllowListEnforced).toBe(false);
    expect(config.includeGitHistory).toBe(true);
  });

  it('parses the allow-list and reports that containment is enforced', () => {
    const config = loadConfig({ REPOATLAS_ALLOWED_ROOTS: '/srv/repos;/opt/repo' } as NodeJS.ProcessEnv);
    expect(config.allowedRoots).toHaveLength(2);
    expect(config.pathAllowListEnforced).toBe(true);
  });

  it('fails fast with a readable message on invalid configuration', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' } as NodeJS.ProcessEnv)).toThrow(/Invalid RepoAtlas configuration/);
  });

  it('coerces boolean environment values', () => {
    expect(loadConfig({ REPOATLAS_INCLUDE_GIT: 'false' } as NodeJS.ProcessEnv).includeGitHistory).toBe(false);
    expect(loadConfig({ REPOATLAS_INCLUDE_GIT: '0' } as NodeJS.ProcessEnv).includeGitHistory).toBe(false);
    expect(loadConfig({ REPOATLAS_INCLUDE_GIT: '1' } as NodeJS.ProcessEnv).includeGitHistory).toBe(true);
  });
});