import { afterEach, describe, expect, it } from 'vitest';
import { buildSequence, buildDataFlow, traceLineage, checkConsistency } from '@repoatlas/artifacts';
import { runAnalysis } from '../src/analyze.js';
import { createFixture, type Fixture } from './fixtures.js';

/**
 * Phase 4 through the real pipeline.
 *
 * Source text in, graph out, artifacts out. These tests exist because the interesting failures
 * in this phase live *between* the extractor and the projection: a return recorded but never
 * linked, a status read before its configuring call is seen, a read reported as a write. A test
 * that hand-builds markers cannot catch any of that, so nothing here is mocked.
 */

const cleanups: Fixture[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.cleanup();
});

async function analyse(tree: Record<string, string>) {
  const fixture = await createFixture(tree);
  cleanups.push(fixture);
  const output = await runAnalysis({ repositoryPath: fixture.root, includeGitHistory: false });
  return {
    graph: output.graph,
    sequence: buildSequence({ graph: output.graph, maxElements: 5_000 }),
    dataFlow: buildDataFlow({ graph: output.graph, maxElements: 5_000 }),
    consistency: checkConsistency({ graph: output.graph, maxElements: 5_000 }),
  };
}

const TS_SERVICE = 'export function findAll() {\n  return [];\n}\n';
const TS_LOADER = "export function load() {\n  throw new Error('boom');\n}\n";

function route(body: string): Record<string, string> {
  return {
    'src/routes.ts': `const app = express();\n\napp.get('/reports', async (request, response) => {\n${body}\n});\n`,
    'src/service.ts': TS_SERVICE,
  };
}

describe('returns through the real pipeline', () => {
  it('records a return relationship for a returned call', async () => {
    const { graph } = await analyse({
      'src/a.ts': 'export function load() {\n  return find();\n}\n',
      'src/b.ts': 'export function find() {\n  return 1;\n}\n',
    });

    const returned = graph.edges.filter((edge) => edge.kind === 'returns');
    expect(returned).toHaveLength(1);
    // callee → caller, because the caller is what hands the value on.
    expect(returned[0]?.from).toBe('function:find');
    expect(returned[0]?.to).toBe('function:load');
    expect(returned[0]?.confidence).toBe('STRONGLY_INFERRED');
    expect(returned[0]?.evidence[0]?.startLine).toBe(2);
  });

  it('records no return relationship when the source does not return the call', async () => {
    const { graph } = await analyse({
      'src/a.ts': 'export function load() {\n  find();\n}\n',
      'src/b.ts': 'export function find() {\n  return 1;\n}\n',
    });
    expect(graph.edges.some((edge) => edge.kind === 'returns')).toBe(false);
  });

  it('records the return on the function node, and no return as no return', async () => {
    const { graph } = await analyse({
      'src/a.ts': 'export function withReturn() {\n  return 1;\n}\n',
      'src/b.ts': 'export function withoutReturn() {\n  log(1);\n}\n',
    });
    expect(graph.nodes.find((node) => node.id === 'function:withreturn')?.attributes?.hasReturn).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'function:withoutreturn')?.attributes?.hasReturn).not.toBe(true);
  });

  it('draws a return message immediately after the call it belongs to', async () => {
    const { sequence } = await analyse(route('  const rows = await findAll();\n  return rows;'));

    const callIndex = sequence.edges.findIndex((edge) => edge.kind === 'calls' && edge.target === 'function:findall');
    const returnIndex = sequence.edges.findIndex((edge) => edge.kind === 'returns' && edge.source === 'function:findall');
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(returnIndex).toBeGreaterThan(callIndex);
    // Nothing else is drawn between them: the return belongs to that call.
    expect(sequence.edges[callIndex + 1]?.id).toBe(sequence.edges[returnIndex]?.id);
  });

  it('draws an HTTP response with the status the handler states', async () => {
    const { sequence } = await analyse(route('  const rows = await findAll();\n  response.status(201).json(rows);'));
    const response = sequence.edges.find((edge) => edge.kind === 'returns' && edge.target.startsWith('api_endpoint'));
    expect(response).toBeDefined();
    expect(response?.label).toContain('201');
    expect(response?.label).toContain('json');
  });

  it('states no status when the handler states none', async () => {
    const { sequence } = await analyse(route('  const rows = await findAll();\n  response.json(rows);'));
    const response = sequence.edges.find((edge) => edge.kind === 'returns' && edge.target.startsWith('api_endpoint'));
    expect(response?.label).not.toContain('200');
  });

  it('draws an error path from a throw in the callee', async () => {
    const { sequence, graph } = await analyse({
      'src/routes.ts': "const app = express();\n\napp.get('/reports', (request, response) => {\n  response.json(load());\n});\n",
      'src/service.ts': TS_LOADER,
    });

    expect(graph.edges.some((edge) => edge.kind === 'throws')).toBe(true);
    const failure = sequence.edges.find((edge) => edge.kind === 'throws');
    expect(failure?.source).toBe('function:load');
    expect(failure?.evidence.length).toBeGreaterThan(0);
  });

  it('draws no error path for a callee that never throws', async () => {
    const { sequence } = await analyse(route('  const rows = await findAll();\n  response.json(rows);'));
    expect(sequence.edges.some((edge) => edge.kind === 'throws')).toBe(false);
  });
});

describe('multi-table data through the real pipeline', () => {
  const SCHEMA = 'CREATE TABLE users (id TEXT PRIMARY KEY);\nCREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT);\n';

  it('creates one read per table in a join', async () => {
    const { graph } = await analyse({
      'src/reports.ts':
        "export function joinRows() {\n  return query('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id');\n}\n",
      'schema.sql': SCHEMA,
    });

    const reads = graph.edges.filter((edge) => edge.kind === 'reads').map((edge) => edge.to);
    expect(reads.sort()).toEqual(['table:orders', 'table:users']);
    expect(graph.edges.filter((edge) => edge.kind === 'writes')).toHaveLength(0);
  });

  it('separates a read from a write in INSERT ... SELECT', async () => {
    const { graph } = await analyse({
      'src/archive.ts': "export function archive() {\n  return query('INSERT INTO archive_reports SELECT * FROM reports');\n}\n",
      'schema.sql': 'CREATE TABLE reports (id TEXT PRIMARY KEY);\nCREATE TABLE archive_reports (id TEXT PRIMARY KEY);\n',
    });

    expect(graph.edges.find((edge) => edge.kind === 'writes' && edge.to === 'table:archive_reports')).toBeDefined();
    expect(graph.edges.find((edge) => edge.kind === 'reads' && edge.to === 'table:reports')).toBeDefined();
  });

  it('reads a table in a subquery without inventing a write', async () => {
    const { graph } = await analyse({
      'src/users.ts': "export function active() {\n  return query('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)');\n}\n",
      'schema.sql': SCHEMA,
    });

    const reads = graph.edges.filter((edge) => edge.kind === 'reads').map((edge) => edge.to);
    expect(reads.sort()).toEqual(['table:orders', 'table:users']);
    expect(graph.edges.filter((edge) => edge.kind === 'writes')).toHaveLength(0);
  });

  it('does not create a table node for a CTE name', async () => {
    const { graph } = await analyse({
      'src/recent.ts':
        "export function recent() {\n  return query('WITH recent_orders AS (SELECT * FROM orders) SELECT * FROM recent_orders');\n}\n",
      'schema.sql': SCHEMA,
    });

    expect(graph.nodes.some((node) => node.kind === 'table' && node.name === 'recent_orders')).toBe(false);
    expect(graph.edges.some((edge) => edge.to === 'table:orders' && edge.kind === 'reads')).toBe(true);
  });

  it('records a statement it will not classify, with no data relationship', async () => {
    const { graph, dataFlow } = await analyse({
      'src/merge.ts':
        "export function merge() {\n  return query('MERGE INTO reports USING users ON reports.user_id = users.id WHEN MATCHED THEN UPDATE SET title = users.name');\n}\n",
      'schema.sql': SCHEMA,
    });

    expect(graph.edges.some((edge) => edge.kind === 'reads' || edge.kind === 'writes')).toBe(false);
    expect(dataFlow.omitted.some((entry) => entry.reason.includes('queries present but not classified'))).toBe(true);
  });

  it('draws a separate flow per table, and lineage keeps them apart', async () => {
    const { graph, dataFlow } = await analyse({
      'src/reports.ts':
        "export function joinRows() {\n  return query('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id');\n}\n",
      'schema.sql': SCHEMA,
    });

    const flows = dataFlow.edges.filter((edge) => edge.source === 'function:joinrows');
    expect(flows).toHaveLength(2);

    const lineage = traceLineage(graph, 'table:orders')!;
    expect(lineage.upstream).toHaveLength(1);
    expect(lineage.upstream[0]?.role).toBe('join');
    expect(lineage.usage.read).toBe(1);
  });
});

describe('consistency over the new relationships', () => {
  it('finds no unsupported inference in a graph with returns and multi-table reads', async () => {
    const { consistency } = await analyse({
      ...route('  const rows = await findAll();\n  response.status(200).json(rows);'),
      'src/store.ts':
        "export function loadAll() {\n  return query('SELECT * FROM users JOIN orders ON orders.user_id = users.id');\n}\n",
      'schema.sql': 'CREATE TABLE users (id TEXT PRIMARY KEY);\nCREATE TABLE orders (id TEXT PRIMARY KEY);\n',
    });

    expect(consistency.counts.UNSUPPORTED_INFERENCE).toBe(0);
    expect(consistency.counts.CONTRADICTION).toBe(0);
  });

  it('checks that every return message cites a return relationship', async () => {
    const { graph, sequence } = await analyse(route('  const rows = await findAll();\n  response.json(rows);'));
    const returnIds = new Set(graph.edges.filter((edge) => edge.kind === 'returns').map((edge) => edge.id));

    for (const edge of sequence.edges) {
      if (edge.kind !== 'returns') continue;
      expect(edge.supportingEdgeIds?.some((id) => returnIds.has(id))).toBe(true);
    }
  });
});

describe('snapshot identity', () => {
  it('produces the same graph twice for unchanged content, under the new schema', async () => {
    const fixture = await createFixture(route('  const rows = await findAll();\n  response.json(rows);'));
    cleanups.push(fixture);

    const first = await runAnalysis({ repositoryPath: fixture.root, includeGitHistory: false });
    const second = await runAnalysis({ repositoryPath: fixture.root, includeGitHistory: false });

    expect(first.graph.schemaVersion).toBe(4);
    expect(JSON.stringify(first.graph.nodes)).toBe(JSON.stringify(second.graph.nodes));
    expect(JSON.stringify(first.graph.edges)).toBe(JSON.stringify(second.graph.edges));
    expect(first.analysis.id).toBe(second.analysis.id);
    expect(first.analysis.graphDigest).toBe(second.analysis.graphDigest);
  });
});