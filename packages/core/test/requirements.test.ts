import { describe, expect, it } from 'vitest';
import { buildRequirements, buildUseCases, MAX_USE_CASE_DEPTH, type Requirement } from '@repoatlas/core';
import { buildGraph, DiagnosticCollector, EvidenceStore, type ParsedFile, type RepositoryRef } from '@repoatlas/core';

/**
 * Phase 3 requirements and use cases.
 *
 * Fixtures go through the real parser and the real builder rather than hand-written graphs,
 * because the properties under test — evidence on every node, deterministic ids, `reads`
 * edges only where a query names a table — are properties of the pipeline.
 */

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

function graphOf(files: ParsedFile[]) {
  return buildGraph({
    repository: REPOSITORY,
    files: files.map((file) => ({ path: file.path, byteSize: 100, language: file.language, analyzable: true })),
    parsed: files,
    commits: [],
    headCommit: null,
    branch: null,
    evidence: new EvidenceStore({ maxExcerptChars: 200 }),
    diagnostics: new DiagnosticCollector(),
    limits: { maxNodes: 10_000, maxEdges: 20_000 },
    includeGitHistory: false,
  }).graph;
}

/** API → service → database, with a schema. The canonical supported case. */
const API_TO_DATABASE = graphOf([
  parsedFile('schema.sql', {
    language: 'sql',
    producer: 'config-scanner',
    markers: [
      { name: 'schema.table', line: 1, attributes: { table: 'reports', columnCount: 2, primaryKey: 'id' } },
      { name: 'schema.column', line: 2, attributes: { table: 'reports', column: 'id', dataType: 'TEXT', primaryKey: true, notNull: true, unique: false } },
      { name: 'schema.column', line: 3, attributes: { table: 'reports', column: 'title', dataType: 'TEXT', primaryKey: false, notNull: true, unique: false } },
    ],
  }),
  parsedFile('src/routes.ts', {
    entities: [
      { kind: 'function', name: 'listReports', qualifiedName: 'listReports', startLine: 4, endLine: 10, language: 'typescript' },
    ],
    calls: [{ callee: 'validateQuery', line: 5, fromQualifiedName: 'listReports', isLocalIdentifier: true, argCount: 1 }],
    markers: [{ name: 'http.route', line: 3, attributes: { httpMethod: 'GET', path: '/api/reports', handler: 'listReports' } }],
  }),
  parsedFile('src/service.ts', {
    entities: [
      { kind: 'class', name: 'ReportService', qualifiedName: 'ReportService', startLine: 1, endLine: 20, language: 'typescript' },
      { kind: 'function', name: 'findAll', qualifiedName: 'ReportService.findAll', startLine: 2, endLine: 6, language: 'typescript' },
      { kind: 'function', name: 'validateQuery', qualifiedName: 'validateQuery', startLine: 8, endLine: 10, language: 'typescript' },
    ],
    calls: [{ callee: 'findAll', line: 5, fromQualifiedName: 'ReportService.findAll', isLocalIdentifier: true, argCount: 0 }],
    markers: [
      {
        name: 'sql.query',
        line: 4,
        attributes: { operation: 'read', table: 'reports', scope: 'ReportService.findAll' },
      },
    ],
  }),
]);

const EMPTY_GRAPH = graphOf([]);

function requirementById(model: ReturnType<typeof buildRequirements>, suffix: string): Requirement | undefined {
  return model.requirements.find((requirement) => requirement.id.endsWith(suffix));
}

describe('requirements', () => {
  it('recovers an interface requirement from a route registration, with evidence', () => {
    const model = buildRequirements(API_TO_DATABASE);
    const requirement = requirementById(model, 'interface_behaviour:api_endpoint:get-/api/reports');

    expect(requirement).toBeDefined();
    expect(requirement?.statement).toContain('GET /api/reports');
    expect(requirement?.statement).toContain('listReports');
    expect(requirement?.evidence.length).toBeGreaterThan(0);
    expect(requirement?.evidence[0]?.path).toBe('src/routes.ts');
    expect(requirement?.supportedByNodeIds.length).toBeGreaterThan(0);
  });

  it('labels a derived requirement as derived, and never as a business requirement', () => {
    const model = buildRequirements(API_TO_DATABASE);
    for (const requirement of model.requirements) {
      expect(requirement.origin).toBe('derived');
      expect(requirement.derivation.length).toBeGreaterThan(0);
    }
    expect(model.requirements.some((requirement) => /business/i.test(requirement.statement))).toBe(false);
  });

  it('never produces a requirement without graph support', () => {
    for (const graph of [API_TO_DATABASE, EMPTY_GRAPH]) {
      for (const requirement of buildRequirements(graph).requirements) {
        expect(requirement.supportedByNodeIds.length, `${requirement.id} must name support`).toBeGreaterThan(0);
        expect(requirement.evidence.length, `${requirement.id} must cite something`).toBeGreaterThan(0);
      }
    }
  });

  it('recovers persistence behaviour only where a query names a table', () => {
    const model = buildRequirements(API_TO_DATABASE);
    const read = requirementById(model, 'persistence:reads:reports');
    expect(read?.statement).toBe('The system reads the reports table.');
    expect(read?.status).toBe('OBSERVED');
    expect(read?.evidence[0]?.path).toBe('src/service.ts');
    expect(read?.supportedByEdgeIds.length).toBeGreaterThan(0);
  });

  it('produces no persistence requirement for a repository with no queries', () => {
    const graph = graphOf([parsedFile('src/a.ts')]);
    expect(requirementById(buildRequirements(graph), 'persistence:reads:reports')).toBeUndefined();
    expect(buildRequirements(graph).requirements).toHaveLength(0);
  });

  it('records a validation requirement only where a guard call is in the registering file', () => {
    const model = buildRequirements(API_TO_DATABASE);
    const validation = model.requirements.find((requirement) => requirement.category === 'validation');
    expect(validation).toBeDefined();
    expect(validation?.statement).toContain('validates its input');
    expect(validation?.supportedByEdgeIds.length).toBeGreaterThan(0);
    // A guard resolved by name is never presented as explicit.
    expect(validation?.confidence).not.toBe('EXPLICIT');
  });

  it('does not attribute a guard from another file to this route', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a' } }],
      }),
      parsedFile('src/elsewhere.ts', {
        entities: [{ kind: 'function', name: 'validateInput', qualifiedName: 'validateInput', startLine: 1, endLine: 2, language: 'typescript' }],
        calls: [{ callee: 'validateInput', line: 2, fromQualifiedName: 'validateInput', isLocalIdentifier: true, argCount: 1 }],
      }),
    ]);
    expect(buildRequirements(graph).requirements.some((requirement) => requirement.category === 'validation')).toBe(false);
  });

  it('reports business requirements as not recovered rather than inventing them', () => {
    const model = buildRequirements(API_TO_DATABASE);
    const note = model.summary.notRecovered.find((entry) => entry.reason.includes('business requirements'));
    expect(note).toBeDefined();
    expect(note?.reason).toContain('not parsed for intent');
    expect(model.summary.declared).toBe(0);
  });

  it('recovers a declared requirement only when the graph holds one, and only with support', () => {
    const base = graphOf([parsedFile('src/a.ts')]);
    const requirementId = 'requirement:reg-1';
    const withRequirement: ReturnType<typeof graphOf> = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: requirementId,
          kind: 'requirement',
          name: 'REG-1',
          qualifiedName: 'REG-1',
          path: 'docs/requirements.md',
          evidence: base.nodes[0]?.evidence ?? [],
          confidence: 'EXPLICIT',
        },
        {
          id: 'api_endpoint:post/api/register',
          kind: 'api_endpoint',
          name: 'POST /api/register',
          qualifiedName: 'POST /api/register',
          path: 'src/routes.ts',
          evidence: base.nodes[0]?.evidence ?? [],
          confidence: 'EXPLICIT',
          attributes: { httpMethod: 'POST', path: '/api/register', handler: 'register' },
        },
      ],
      edges: [
        ...base.edges,
        {
          id: `${requirementId}|implements_requirement|api_endpoint:post/api/register`,
          from: requirementId,
          to: 'api_endpoint:post/api/register',
          kind: 'implements_requirement',
          confidence: 'EXPLICIT',
          evidence: base.nodes[0]?.evidence ?? [],
        },
      ],
    };

    const model = buildRequirements(withRequirement);
    const declared = model.requirements.find((requirement) => requirement.origin === 'declared');
    expect(declared?.status).toBe('OBSERVED');
    expect(declared?.declaredInPath).toBe('docs/requirements.md');
    expect(declared?.supportedByNodeIds).toContain('api_endpoint:post/api/register');
    expect(model.summary.declared).toBe(1);
  });

  it('drops a declared requirement that nothing implements', () => {
    // A requirement with no implementation is a gap, not a requirement this model can support.
    const base = graphOf([parsedFile('src/a.ts')]);
    const withOrphan: ReturnType<typeof graphOf> = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'requirement:orphan',
          kind: 'requirement',
          name: 'ORPHAN',
          qualifiedName: 'ORPHAN',
          evidence: base.nodes[0]?.evidence ?? [],
          confidence: 'EXPLICIT',
        },
      ],
    };
    expect(buildRequirements(withOrphan).requirements.some((requirement) => requirement.origin === 'declared')).toBe(false);
  });

  it('is deterministic for the same graph', () => {
    expect(JSON.stringify(buildRequirements(API_TO_DATABASE))).toBe(JSON.stringify(buildRequirements(API_TO_DATABASE)));
  });

  it('produces an empty, valid model for an empty repository', () => {
    const model = buildRequirements(EMPTY_GRAPH);
    expect(model.requirements).toHaveLength(0);
    expect(Object.values(model.counts).every((count) => count === 0)).toBe(true);
  });
});

describe('use cases', () => {
  it('recovers an entry point as a use case with steps and evidence', () => {
    const model = buildUseCases(API_TO_DATABASE);
    expect(model.useCases).toHaveLength(1);
    const useCase = model.useCases[0]!;

    expect(useCase.entryKind).toBe('api_endpoint');
    expect(useCase.title).toBe('GET /api/reports');
    expect(useCase.trigger).toContain('GET /api/reports');
    expect(useCase.steps.length).toBeGreaterThan(0);
    expect(useCase.steps[0]?.viaEdgeIds.length).toBeGreaterThan(0);
    expect(useCase.evidence.length).toBeGreaterThan(0);
  });

  it('records what the interaction reaches as postconditions', () => {
    const model = buildUseCases(API_TO_DATABASE);
    const useCase = model.useCases[0]!;
    // The flow reaches the service; the service's own read is a separate edge and is reported
    // as reached only when the traversal reaches it.
    expect(useCase.missing.join(' ')).toContain('persistence');
  });

  it('never names an actor the repository does not evidence', () => {
    const model = buildUseCases(API_TO_DATABASE);
    expect(model.actors).toHaveLength(0);
    for (const useCase of model.useCases) {
      expect(useCase.actor).toBeNull();
      expect(useCase.missing.join(' ')).toContain('actor');
    }
    expect(model.notRecovered.some((entry) => entry.reason.includes('human actors'))).toBe(true);
  });

  it('names an actor only when the graph records one', () => {
    const base = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handle' } }],
      }),
    ]);
    const withBoundary: ReturnType<typeof graphOf> = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'actor:operator', kind: 'actor', name: 'operator', path: 'src/routes.ts', evidence: base.nodes[0]?.evidence ?? [], confidence: 'EXPLICIT' },
      ],
      edges: [
        ...base.edges,
        {
          id: 'actor:operator|authorizes|api_endpoint:get-/a',
          from: 'actor:operator',
          to: 'api_endpoint:get-/a',
          kind: 'authorizes',
          confidence: 'EXPLICIT',
          evidence: base.nodes[0]?.evidence ?? [],
        },
      ],
    };

    const model = buildUseCases(withBoundary);
    expect(model.actors).toHaveLength(1);
    expect(model.useCases[0]?.actor?.nodeId).toBe('actor:operator');
    expect(model.useCases[0]?.actor?.derivation).toContain('actor entity');
  });

  it('infers an actor from an authorisation boundary over a non-code subject', () => {
    const base = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a', handler: 'handle' } }],
      }),
    ]);
    const withParty: ReturnType<typeof graphOf> = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'service:partner-gateway',
          kind: 'service',
          name: 'partner-gateway',
          path: 'src/routes.ts',
          evidence: base.nodes[0]?.evidence ?? [],
          confidence: 'EXPLICIT',
        },
      ],
      edges: [
        ...base.edges,
        {
          id: 'service:partner-gateway|authenticates|api_endpoint:get-/a',
          from: 'service:partner-gateway',
          to: 'api_endpoint:get-/a',
          kind: 'authenticates',
          confidence: 'EXPLICIT',
          evidence: base.nodes[0]?.evidence ?? [],
        },
      ],
    };

    const model = buildUseCases(withParty);
    expect(model.actors[0]?.nodeId).toBe('service:partner-gateway');
    expect(model.actors[0]?.derivation).toContain('authenticates');
    expect(model.useCases[0]?.actor?.nodeId).toBe('service:partner-gateway');
  });

  it('never treats code as an actor', () => {
    const base = graphOf([
      parsedFile('src/guard.ts', {
        entities: [{ kind: 'class', name: 'Guard', qualifiedName: 'Guard', startLine: 1, endLine: 4, language: 'typescript' }],
      }),
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/a' } }],
      }),
    ]);
    const withCodeSubject: ReturnType<typeof graphOf> = {
      ...base,
      edges: [
        ...base.edges,
        {
          id: 'class:guard|authorizes|api_endpoint:get-/a',
          from: 'class:guard',
          to: 'api_endpoint:get-/a',
          kind: 'authorizes',
          confidence: 'EXPLICIT',
          evidence: base.nodes[0]?.evidence ?? [],
        },
      ],
    };
    expect(buildUseCases(withCodeSubject).actors).toHaveLength(0);
  });

  it('does not treat an internal function as a use case', () => {
    const model = buildUseCases(API_TO_DATABASE);
    // The service and its helper are not entry points.
    expect(model.entryPoints.api_endpoint).toBe(1);
    expect(model.entryPoints.exported_function).toBe(0);
    expect(model.useCases.some((useCase) => useCase.entryNodeId.includes('reportservice'))).toBe(false);
    expect(model.notRecovered.some((entry) => entry.reason.includes('per-function use cases'))).toBe(true);
  });

  it('reports a use case with no resolved calls as unknown, not as an empty narrative', () => {
    const graph = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/lonely' } }],
      }),
    ]);
    const useCase = buildUseCases(graph).useCases[0]!;
    expect(useCase.status).toBe('UNKNOWN');
    expect(useCase.steps).toHaveLength(0);
    expect(useCase.missing.join(' ')).toContain('steps');
  });

  it('marks a use case partial when only part of the interaction is evidenced', () => {
    const useCase = buildUseCases(API_TO_DATABASE).useCases[0]!;
    expect(useCase.status).toBe('PARTIAL');
    expect(useCase.missing.length).toBeGreaterThan(0);
  });

  it('bounds traversal so a cyclic call graph terminates', () => {
    // a calls b, b calls a. Without a depth bound and a visited set this never returns.
    const cyclic = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'GET', path: '/loop', handler: 'a' } }],
      }),
      parsedFile('src/a.ts', {
        entities: [{ kind: 'function', name: 'a', qualifiedName: 'a', startLine: 1, endLine: 2, language: 'typescript' }],
        calls: [{ callee: 'b', line: 2, fromQualifiedName: 'a', isLocalIdentifier: true, argCount: 0 }],
      }),
      parsedFile('src/b.ts', {
        entities: [{ kind: 'function', name: 'b', qualifiedName: 'b', startLine: 1, endLine: 2, language: 'typescript' }],
        calls: [{ callee: 'a', line: 2, fromQualifiedName: 'b', isLocalIdentifier: true, argCount: 0 }],
      }),
    ]);

    const useCase = buildUseCases(cyclic).useCases[0]!;
    expect(useCase.steps.length).toBeGreaterThan(0);
    expect(useCase.steps.length).toBeLessThanOrEqual(MAX_USE_CASE_DEPTH * 2);
  });

  it('links a use case to the requirements it supports', () => {
    const requirements = buildRequirements(API_TO_DATABASE).requirements;
    const model = buildUseCases(API_TO_DATABASE, requirements);
    expect(model.useCases[0]?.supportsRequirementIds.length).toBeGreaterThan(0);
    expect(model.useCases[0]?.supportsRequirementIds.some((id) => id.includes('interface_behaviour'))).toBe(true);
  });

  it('records preconditions from an explicit branch, not from the call graph', () => {
    const branching = graphOf([
      parsedFile('src/routes.ts', {
        markers: [{ name: 'http.route', line: 1, attributes: { httpMethod: 'POST', path: '/a', handler: 'handle' } }],
      }),
      parsedFile('src/handler.ts', {
        entities: [{ kind: 'function', name: 'handle', qualifiedName: 'handle', startLine: 1, endLine: 8, language: 'typescript' }],
        markers: [{ name: 'control.branch', line: 3, attributes: { flow: 'branch', scope: 'handle', condition: 'body.length > 0' } }],
      }),
    ]);

    const useCase = buildUseCases(branching).useCases[0]!;
    expect(useCase.preconditions.join(' ')).toContain('body.length > 0');
  });

  it('produces an empty, valid model for an empty repository', () => {
    const model = buildUseCases(EMPTY_GRAPH);
    expect(model.useCases).toHaveLength(0);
    expect(model.actors).toHaveLength(0);
  });

  it('is deterministic for the same graph', () => {
    expect(JSON.stringify(buildUseCases(API_TO_DATABASE))).toBe(JSON.stringify(buildUseCases(API_TO_DATABASE)));
  });
});
