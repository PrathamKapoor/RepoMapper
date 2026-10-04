import { checkConsistency } from '@repoatlas/artifacts';
import { runAnalysis } from '../src/analyze.js';

const targets = process.argv.slice(2);
for (const target of targets) {
  const started = Date.now();
  const output = await runAnalysis({ repositoryPath: target, includeGitHistory: false });
  const graph = output.graph;
  const byKind = new Map();
  for (const edge of graph.edges) byKind.set(edge.kind, (byKind.get(edge.kind) ?? 0) + 1);

  const reads = graph.edges.filter((e) => e.kind === 'reads');
  const multiTable = new Set();
  const sqlByFunction = new Map();
  for (const edge of [...reads, ...graph.edges.filter((e) => e.kind === 'writes')]) {
    const key = edge.from;
    sqlByFunction.set(key, (sqlByFunction.get(key) ?? 0) + 1);
  }
  for (const [fn, count] of sqlByFunction) if (count > 1) multiTable.add(fn);

  const responses = graph.edges.filter((e) => e.kind === 'returns' && e.attributes?.httpResponse === true);
  const inferred = graph.edges.filter((e) => e.kind === 'returns' && e.attributes?.inferred === true);
  const ctes = graph.nodes.filter((n) => n.attributes?.queryExpression === true);
  const unclassified = graph.nodes.filter((n) => n.attributes?.unclassifiedStatement === true);
  const report = checkConsistency({ graph, maxElements: 20_000 });

  console.log(`\n=== ${target} (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(`  nodes=${graph.nodes.length} edges=${graph.edges.length} evidence=${graph.evidence.length} schema=${graph.schemaVersion}`);
  console.log(`  reads=${byKind.get('reads') ?? 0} writes=${byKind.get('writes') ?? 0} returns=${byKind.get('returns') ?? 0} throws=${byKind.get('throws') ?? 0}`);
  console.log(`  httpResponses=${responses.length} inferredReturns=${inferred.length} ctes=${ctes.length} unclassifiedStatements=${unclassified.length}`);
  console.log(`  multiTableFunctions=${multiTable.size}`);
  console.log(`  consistency=${JSON.stringify(report.counts)}`);
  const rules = new Map();
  for (const f of report.findings) rules.set(f.rule, (rules.get(f.rule) ?? 0) + 1);
  console.log(`  rules=${JSON.stringify(Object.fromEntries(rules))}`);
  for (const edge of reads.slice(0, 4)) {
    console.log(`  read: ${edge.from} -> ${edge.to} role=${edge.attributes?.role} stmt=${String(edge.attributes?.statement).slice(0, 60)}`);
  }
  for (const edge of responses.slice(0, 3)) {
    console.log(`  response: ${edge.from} -> ${edge.to} status=${edge.attributes?.status} method=${edge.attributes?.method}`);
  }
  for (const node of unclassified.slice(0, 3)) console.log(`  unclassified: ${node.name} (${node.path}:${node.startLine})`);
}