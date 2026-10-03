import { describe, expect, it } from 'vitest';
import { analyseGaps, ARTIFACTS, buildArtifact, findCycles, OmissionLog, projectAtlas, toMermaid } from '@repoatlas/artifacts';
import { buildGraph, DiagnosticCollector, EvidenceStore, nodeId, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

const REPOSITORY: RepositoryRef = { absolutePath: '/repo', name: 'repo' };

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    language: 'typescript',
    producer: 'typescript-compiler-api',
    imports: [],
    entities: [],
    calls: [],
    markers: [],
    problems: [],
    durationMs: 0,
    ...overrides,
  };
}

function graphFrom(files: ParsedFile[]) {
  const evidence = new EvidenceStore({ maxExcerptChars: 200 });
  return buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits: [],
    headCommit: null,
    branch: null,
    evidence,
    diagnostics: new DiagnosticCollector(),
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: false,
  }).graph;
}

const RICH_GRAPH = graphFrom([
  parsedFile('src/a.ts', {
    imports: [{ specifier: './b.js', names: ['B'], kind: 'static', line: 1, isExternal: false }],
    entities: [
      { kind: 'class', name: 'A', qualifiedName: 'A', startLine: 3, endLine: 8, language: 'typescript', extendsFrom: ['B'] },
    ],
  }),
  parsedFile('src/b.ts', {
    entities: [
      { kind: 'class', name: 'B', qualifiedName: 'B', startLine: 1, endLine: 4, language: 'typescript' },
      { kind: 'function', name: 'run', qualifiedName: 'B.run', startLine: 6, endLine: 7, language: 'typescript' },
    ],
  }),
  parsedFile('schema.sql', {
    language: 'sql',
    producer: 'config-scanner',
    markers: [
      { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 1 } },
      { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT' } },
    ],
  }),
]);

const EMPTY_GRAPH = graphFrom([]);

describe('dependency graph projection', () => {
  it('projects module-level imports and keeps confidence', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'dependency-graph');
    expect(artifact?.kind).toBe('dependency-graph');
    expect(artifact?.edges.some((edge) => edge.kind === 'imports')).toBe(true);
    expect(artifact?.insufficientEvidence).toBe(false);
    for (const edge of artifact?.edges ?? []) {
      expect(['EXPLICIT', 'STRONGLY_INFERRED', 'WEEKLY_INFERRED', 'UNKNOWN']).toContain(edge.confidence);
    }
  });

  it('marks itself as insufficient when the repository has no imports', () => {
    const artifact = buildArtifact(graphFrom([parsedFile('src/lonely.ts')]), 'dependency-graph');
    expect(artifact?.insufficientEvidence).toBe(true);
    expect(artifact?.edges).toHaveLength(0);
  });

  it('declares what the view does not cover', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'dependency-graph');
    expect(artifact?.scope).toContain('no call-level dependencies');
  });

  it('honours the element limit', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'dependency-graph', 1);
    expect(artifact!.edges.length).toBeLessThanOrEqual(1);
    expect(artifact!.omitted.some((entry) => entry.reason.includes('limit'))).toBe(true);
  });
});

describe('module graph projection', () => {
  it('shows which module declares which entity', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'module-graph');
    const declarations = artifact?.edges.filter((edge) => edge.kind === 'contains') ?? [];
    expect(declarations.some((edge) => edge.target === nodeId('class', 'A'))).toBe(true);
  });
});

describe('class diagram projection', () => {
  it('includes classes and their inheritance edges', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'class-diagram');
    const classes = artifact!.nodes.filter((node) => node.kind === 'class');
    expect(classes.map((node) => node.label).sort()).toEqual(['A', 'B']);
    expect(artifact!.edges.some((edge) => edge.kind === 'extends')).toBe(true);
  });

  it('attaches members to their owning type', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'class-diagram');
    const b = artifact!.nodes.find((node) => node.label === 'B');
    expect(b?.detail).toContain('run');
  });

  it('reports how many types have no resolvable heritage', () => {
    // `Standalone` participates in no extends/implements relationship in either direction.
    const graph = graphFrom([
      parsedFile('src/a.ts', {
        entities: [
          { kind: 'class', name: 'A', qualifiedName: 'A', startLine: 1, endLine: 2, language: 'typescript', extendsFrom: ['B'] },
        ],
      }),
      parsedFile('src/b.ts', {
        entities: [
          { kind: 'class', name: 'B', qualifiedName: 'B', startLine: 1, endLine: 2, language: 'typescript' },
          { kind: 'class', name: 'Standalone', qualifiedName: 'Standalone', startLine: 4, endLine: 5, language: 'typescript' },
        ],
      }),
    ]);
    const artifact = buildArtifact(graph, 'class-diagram')!;
    const omission = artifact.omitted.find((entry) => entry.reason.includes('heritage'));
    expect(omission?.count).toBe(1);
    expect(omission?.examples).toContain('class:standalone');
  });
});

describe('ER diagram projection', () => {
  it('lists tables with their columns', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'er-diagram');
    expect(artifact?.insufficientEvidence).toBe(false);
    const table = artifact?.nodes.find((node) => node.label === 'reports');
    expect(table?.detail).toContain('id');
  });

  it('is honestly insufficient when there is no DDL', () => {
    const artifact = buildArtifact(graphFrom([parsedFile('src/a.ts')]), 'er-diagram');
    expect(artifact?.insufficientEvidence).toBe(true);
    expect(artifact?.scope).toContain('only when the graph holds an explicit edge');
    // With tables present but no inter-table edges, the omission must say foreign keys
    // were not inferred rather than implying there are none.
    const withTable = buildArtifact(RICH_GRAPH, 'er-diagram')!;
    expect(withTable.omitted.some((entry) => entry.reason.includes('foreign keys are not inferred'))).toBe(true);
  });
});

describe('mermaid rendering', () => {
  it('renders a flowchart with escaped labels', () => {
    const artifact = buildArtifact(RICH_GRAPH, 'dependency-graph')!;
    const mermaid = toMermaid(artifact);
    expect(mermaid.startsWith('flowchart')).toBe(true);
    expect(mermaid).toContain('-->');
    expect(mermaid).not.toContain('\n\n');
  });

  it('marks an inferred relationship with a dashed arrow and its confidence', () => {
    const graph = graphFrom([
      parsedFile('src/a.ts', {
        entities: [
          { kind: 'class', name: 'A', qualifiedName: 'A', startLine: 1, endLine: 2, language: 'typescript', extendsFrom: ['B'] },
        ],
      }),
      parsedFile('src/b.ts', {
        entities: [
          { kind: 'class', name: 'B', qualifiedName: 'B', startLine: 1, endLine: 2, language: 'typescript' },
        ],
      }),
    ]);
    const artifact = buildArtifact(graph, 'class-diagram')!;
    const mermaid = toMermaid(artifact);
    expect(mermaid).toContain('-.');
    expect(mermaid).toContain('STRONGLY_INFERRED');
  });
});

describe('cycle detection', () => {
  it('finds a simple cycle', () => {
    const cycles = findCycles([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.[0]).toBe(cycles[0]?.at(-1));
  });

  it('reports a cycle once regardless of entry point', () => {
    const cycles = findCycles([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ]);
    expect(cycles).toHaveLength(1);
  });

  it('returns nothing for an acyclic graph', () => {
    expect(findCycles([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }])).toHaveLength(0);
  });

  it('surfaces cycles in the dependency artifact rather than hiding them', () => {
    const graph = graphFrom([
      parsedFile('src/a.ts', {
        imports: [{ specifier: './b.js', names: [], kind: 'static', line: 1, isExternal: false }],
      }),
      parsedFile('src/b.ts', {
        imports: [{ specifier: './a.js', names: [], kind: 'static', line: 1, isExternal: false }],
      }),
    ]);
    const artifact = buildArtifact(graph, 'dependency-graph')!;
    expect(artifact.omitted.some((entry) => entry.reason.includes('cyclic'))).toBe(true);
  });
});

describe('OmissionLog', () => {
  it('accumulates counts and keeps a few examples', () => {
    const log = new OmissionLog();
    log.record('missing', 'a');
    log.record('missing', 'b');
    log.record('missing', 'a');
    const entries = log.list();
    expect(entries[0]?.count).toBe(3);
    // Duplicate examples are not repeated.
    expect(entries[0]?.examples).toEqual(['a', 'b']);
  });

  it('records a pre-counted total in one pass', () => {
    const log = new OmissionLog();
    log.recordCount('bulk', 7, ['x', 'y']);
    expect(log.list()[0]).toEqual({ reason: 'bulk', count: 7, examples: ['x', 'y'] });
  });
});

describe('gap analysis', () => {
  it('reports NOT_FOUND with an auditable list of what was searched', () => {
    const report = analyseGaps(EMPTY_GRAPH);
    const deployment = report.gaps.find((gap) => gap.id === 'deployment-architecture');
    expect(deployment?.status).toBe('NOT_FOUND');
    expect(deployment?.checked.length).toBeGreaterThan(0);
    expect(deployment?.whatWouldResolve).toBeTruthy();
  });

  it('makes every NOT_FOUND auditable and free of absence claims', () => {
    const report = analyseGaps(EMPTY_GRAPH);
    // Every NOT_FOUND must be checkable: it names what was searched and what would
    // resolve it. Without those, "not found" is an unfalsifiable claim.
    for (const gap of report.gaps.filter((entry) => entry.status === 'NOT_FOUND')) {
      expect(gap.checked.length, `${gap.id} must list what was searched`).toBeGreaterThan(0);
      expect(gap.whatWouldResolve.length, `${gap.id} must say what would resolve it`).toBeGreaterThan(0);
    }
  });

  it('hedges rather than asserting absence where a capability may live elsewhere', () => {
    const report = analyseGaps(EMPTY_GRAPH);
    const hedged = /not mean|is not absence|does not imply|is expected when|may be|common/;
    for (const gap of report.gaps.filter((entry) => entry.status === 'NOT_FOUND')) {
      expect(`${gap.observations.join(' ')}`, `${gap.id} must hedge`).toMatch(hedged);
    }
  });

  it('reports EXPLICIT for facts the repository states directly', () => {
    const graph = graphFrom([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/health' } }],
      }),
    ]);
    const report = analyseGaps(graph);
    expect(report.gaps.find((gap) => gap.id === 'api-surface')?.status).toBe('EXPLICIT');
  });

  it('detects a declared dependency that is never imported', () => {
    const graph = graphFrom([
      parsedFile('package.json', {
        language: 'json',
        producer: 'config-scanner',
        markers: [
          { name: 'manifest.dependency', line: 1, attributes: { dependency: 'unused-lib', section: 'dependencies', range: '^1.0.0' } },
        ],
      }),
    ]);
    const report = analyseGaps(graph);
    const hygiene = report.gaps.find((gap) => gap.id === 'dependency-hygiene');
    expect(hygiene?.observations.join(' ')).toContain('unused-lib');
  });

  it('counts every status and reports the not-found share', () => {
    const report = analyseGaps(EMPTY_GRAPH);
    const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(report.gaps.length);
    expect(report.notFoundShare).toBeGreaterThan(0);
    expect(report.notFoundShare).toBeLessThanOrEqual(1);
  });

  it('flags an incomplete analysis rather than claiming success', () => {
    const report = analyseGaps(EMPTY_GRAPH);
    const completeness = report.gaps.find((gap) => gap.id === 'analysis-completeness');
    expect(completeness?.status).toBe('NOT_FOUND');
    expect(completeness?.observations.join(' ')).toContain('diagnostics');
  });
});

describe('projectAtlas', () => {
  it('produces every registered artifact plus a gap report from one graph', () => {
    const projection = projectAtlas(RICH_GRAPH);
    expect(projection.artifacts).toHaveLength(ARTIFACTS.length);
    expect(projection.artifacts.map((artifact) => artifact.kind)).toEqual(ARTIFACTS.map((artifact) => artifact.kind));
    expect(projection.gaps.gaps.length).toBeGreaterThan(0);
    expect(projection.stats.nodeCount).toBe(RICH_GRAPH.nodes.length);
  });

  it('attaches mermaid to every artifact', () => {
    const projection = projectAtlas(RICH_GRAPH);
    for (const artifact of projection.artifacts) {
      expect(artifact.mermaid.length).toBeGreaterThan(0);
    }
  });
});