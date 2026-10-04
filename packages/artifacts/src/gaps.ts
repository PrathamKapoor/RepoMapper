import { buildRequirements, buildUseCases } from '@repoatlas/core';
import type { EvidenceStatus, GraphEdge, GraphNode, SoftwareGraph } from '@repoatlas/core';

/**
 * Gap analysis.
 *
 * The purpose of this module is to make uncertainty visible. A repository almost
 * never documents its own deployment architecture, its authentication flow or the
 * ownership of a component — and the correct finding is not "missing" but
 * "no evidence found in this repository".
 *
 * Therefore every gap carries an `EvidenceStatus`:
 *
 *   EXPLICIT             the repository states this directly
 *   PARTIALLY_EVIDENCED  some of it is stated; the rest is not
 *   INFERRED             reconstructed from indirect evidence (naming, layout)
 *   NOT_FOUND            no supporting evidence exists anywhere in the analysis
 *
 * A gap is never reported merely because a conventionally-named file is absent.
 * `NOT_FOUND` always means "we looked at everything we analysed and found nothing",
 * and the `checked` list records what was searched so that claim is auditable.
 */

export interface Gap {
  /** Stable identifier, e.g. `deployment-architecture`. */
  id: string;
  title: string;
  status: EvidenceStatus;
  /** What the repository would need to contain for this to be EXPLICIT. */
  whatWouldResolve: string;
  /** Concrete observations that led to this status. */
  observations: string[];
  /** What was searched, so the NOT_FOUND claim can be audited. */
  checked: string[];
  /** Graph entity ids the finding relates to, for click-through. */
  relatedNodeIds: string[];
  severity: 'info' | 'warning';
}

export interface GapReport {
  gaps: Gap[];
  counts: Record<EvidenceStatus, number>;
  /**
   * Share of gaps that are NOT_FOUND. A high value means the repository is sparse in
   * machine-readable structure, which is a fact about the repository, not a failure.
   */
  notFoundShare: number;
}

export function analyseGaps(graph: SoftwareGraph): GapReport {
  const nodesByKind = countByKind(graph.nodes);
  const edgesByKind = countByKind(graph.edges);

  const gaps: Gap[] = [
    deploymentArchitecture(nodesByKind, edgesByKind, graph),
    apiSurface(nodesByKind, edgesByKind, graph),
    dataStorage(nodesByKind, edgesByKind, graph),
    authentication(nodesByKind, graph),
    testCoverage(nodesByKind, edgesByKind, graph),
    documentation(nodesByKind, graph),
    ownership(nodesByKind, edgesByKind, graph),
    requirements(edgesByKind, graph),
    dependencyHygiene(graph),
    parseHealth(graph),
  ].filter((gap): gap is Gap => gap !== null);

  const counts: Record<EvidenceStatus, number> = {
    EXPLICIT: 0,
    PARTIALLY_EVIDENCED: 0,
    INFERRED: 0,
    NOT_FOUND: 0,
  };
  for (const gap of gaps) counts[gap.status] += 1;

  return {
    gaps,
    counts,
    notFoundShare: gaps.length === 0 ? 0 : counts.NOT_FOUND / gaps.length,
  };
}

function countByKind<T extends { kind: string }>(items: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return counts;
}

function get(counts: Map<string, number>, kind: string): number {
  return counts.get(kind) ?? 0;
}

function nodeIdsOfKind(graph: SoftwareGraph, kind: string, limit = 10): string[] {
  return graph.nodes.filter((node) => node.kind === kind).slice(0, limit).map((node) => node.id);
}

/** Deployment topology: only explicit infrastructure declarations count as evidence. */
function deploymentArchitecture(
  nodes: Map<string, number>,
  edges: Map<string, number>,
  graph: SoftwareGraph,
): Gap {
  const components = get(nodes, 'deployment_component');
  const deploys = get(edges, 'deploys');
  const checked = [
    'deployment_component nodes (compose services, container base images)',
    'deploys edges',
    'CI/CD workflow files under .github/workflows',
    'container and infrastructure manifests',
  ];

  if (components > 0 && deploys > 0) {
    return {
      id: 'deployment-architecture',
      title: 'Deployment architecture',
      status: 'EXPLICIT',
      whatWouldResolve: 'Nothing — infrastructure files declare at least one deployable component.',
      observations: [
        `${components} deployment component(s) declared in repository files.`,
        `${deploys} deployment relationship(s) recorded in the graph.`,
      ],
      checked,
      relatedNodeIds: nodeIdsOfKind(graph, 'deployment_component'),
      severity: 'info',
    };
  }

  if (components > 0) {
    return {
      id: 'deployment-architecture',
      title: 'Deployment architecture',
      status: 'PARTIALLY_EVIDENCED',
      whatWouldResolve:
        'A compose file, container definition or infrastructure manifest that maps a component to the module it runs.',
      observations: [
        `${components} deployment component(s) found, but none is linked to a module by a deploys relationship.`,
      ],
      checked,
      relatedNodeIds: nodeIdsOfKind(graph, 'deployment_component'),
      severity: 'warning',
    };
  }

  return {
    id: 'deployment-architecture',
    title: 'Deployment architecture',
    status: 'NOT_FOUND',
    whatWouldResolve:
      'A compose file, Dockerfile, Kubernetes manifest, or infrastructure-as-code directory would provide explicit evidence.',
    observations: [
      'No deployment component could be identified from any analysed file.',
      'This does not mean the system is not deployed; it means deployment is not described inside this repository.',
    ],
    checked,
    relatedNodeIds: [],
    severity: 'warning',
  };
}

function apiSurface(
  nodes: Map<string, number>,
  edges: Map<string, number>,
  graph: SoftwareGraph,
): Gap {
  const endpoints = get(nodes, 'api_endpoint');
  const checked = [
    'api_endpoint nodes from HTTP route registrations',
    'OpenAPI/GraphQL/Protobuf schema declarations',
    'exposes edges from modules to endpoints',
  ];

  if (endpoints === 0) {
    return {
      id: 'api-surface',
      title: 'API surface',
      status: 'NOT_FOUND',
      whatWouldResolve:
        'Route registrations in supported frameworks, or an OpenAPI/GraphQL schema, would establish the API surface explicitly.',
      observations: [
        'No HTTP route registration was recognised in any analysed source file.',
        'Supported route syntax in this phase: Express/Fastify/Hono `app.get("/path")` style, and Python decorator routes.',
        'This does not mean the system has no API; it means no recognisable route declaration was found in this repository.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'warning',
    };
  }

  return {
    id: 'api-surface',
    title: 'API surface',
    status: 'EXPLICIT',
    whatWouldResolve: 'Nothing — route declarations are present in source.',
    observations: [
      `${endpoints} API endpoint(s) extracted from route declarations.`,
      `${get(edges, 'exposes')} module-to-endpoint relationship(s) recorded.`,
    ],
    checked,
    relatedNodeIds: nodeIdsOfKind(graph, 'api_endpoint'),
    severity: 'info',
  };
}

function dataStorage(
  nodes: Map<string, number>,
  edges: Map<string, number>,
  graph: SoftwareGraph,
): Gap {
  const tables = get(nodes, 'table');
  const columns = get(nodes, 'column');
  const checked = [
    'table and column nodes from SQL DDL (CREATE TABLE statements)',
    'schema declarations in configuration files',
    'reads/writes relationships from code to storage',
  ];

  if (tables === 0) {
    return {
      id: 'data-storage',
      title: 'Data storage',
      status: 'NOT_FOUND',
      whatWouldResolve: 'A SQL migration, schema file, or ORM model definition would provide explicit storage evidence.',
      observations: [
        'No table definition was found in any analysed file.',
        'Repositories using an ORM without SQL migrations are common; absence of DDL is not absence of storage.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'warning',
    };
  }

  const withoutAccessEvidence = get(edges, 'reads') + get(edges, 'writes') === 0;
  return {
    id: 'data-storage',
    title: 'Data storage',
    status: withoutAccessEvidence ? 'PARTIALLY_EVIDENCED' : 'EXPLICIT',
    whatWouldResolve: withoutAccessEvidence
      ? 'Detected access paths from code to the declared tables would complete the picture.'
      : 'Nothing — storage is declared and access is evidenced.',
    observations: [
      `${tables} table(s) and ${columns} column(s) extracted from schema declarations.`,
      withoutAccessEvidence
        ? 'No code-to-storage access relationship was recorded; data flow is therefore unknown.'
        : 'Storage access relationships are present in the graph.',
    ],
    checked,
    relatedNodeIds: nodeIdsOfKind(graph, 'table'),
    severity: withoutAccessEvidence ? 'warning' : 'info',
  };
}

function authentication(nodes: Map<string, number>, graph: SoftwareGraph): Gap {
  const checked = [
    'middleware registrations (app.use) that reference authentication',
    'authorizes and authenticates relationships',
    'credential-handling configuration keys',
  ];

  if (get(nodes, 'service') > 0 && (get(nodes, 'actor') > 0 || graph.edges.some((edge) => edge.kind === 'authenticates'))) {
    return {
      id: 'authentication',
      title: 'Authentication and authorisation',
      status: 'EXPLICIT',
      whatWouldResolve: 'Nothing — authentication relationships are explicit in the graph.',
      observations: ['Authentication relationships were found in the analysed code.'],
      checked,
      relatedNodeIds: nodeIdsOfKind(graph, 'actor'),
      severity: 'info',
    };
  }

  return {
    id: 'authentication',
    title: 'Authentication and authorisation',
    status: 'NOT_FOUND',
    whatWouldResolve:
      'Middleware wiring, guard/decorator usage, or an identity-provider integration would establish the auth flow.',
    observations: [
      'No authentication or authorisation relationship could be reconstructed.',
      'Authentication is frequently provided by infrastructure or a gateway outside the repository. This does not mean the system is unauthenticated; it means the repository contains nothing that evidences the auth flow.',
    ],
    checked,
    relatedNodeIds: [],
    severity: 'warning',
  };
}

function testCoverage(
  nodes: Map<string, number>,
  edges: Map<string, number>,
  graph: SoftwareGraph,
): Gap {
  const tests = get(nodes, 'test');
  const testEdges = get(edges, 'tests');
  const functions = get(nodes, 'function') + get(nodes, 'class');
  const checked = ['test nodes extracted from test files and test-named declarations', 'tests relationships linking tests to code'];

  if (tests === 0) {
    return {
      id: 'test-coverage',
      title: 'Test evidence',
      status: 'NOT_FOUND',
      whatWouldResolve: 'Test files, or test-named functions, would provide explicit test evidence.',
      observations: [
        'No test entity was extracted from any analysed file.',
        'Tests stored outside this repository, or written in a language this phase does not parse, would also produce this result. This does not mean the code is untested.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'warning',
    };
  }

  return {
    id: 'test-coverage',
    title: 'Test evidence',
    status: testEdges > 0 ? 'EXPLICIT' : 'PARTIALLY_EVIDENCED',
    whatWouldResolve:
      testEdges > 0 ? 'Nothing — tests and their relationship to code are both present.' : 'Links from test entities to the code they exercise.',
    observations: [
      `${tests} test entit(ies) found.`,
      `${functions} function/class entities available to be tested.`,
      testEdges > 0
        ? `${testEdges} test-to-code relationship(s) recorded.`
        : 'No test could be linked to a specific code entity, so coverage cannot be stated.',
    ],
    checked,
    relatedNodeIds: nodeIdsOfKind(graph, 'test'),
    severity: testEdges > 0 ? 'info' : 'warning',
  };
}

function documentation(nodes: Map<string, number>, graph: SoftwareGraph): Gap {
  void nodes;
  const documentEdges = graph.edges.filter((edge) => edge.kind === 'documents').length;
  const checked = ['markdown files in the repository', 'documents relationships from code to documentation'];

  if (documentEdges === 0) {
    return {
      id: 'documentation-links',
      title: 'Documentation traceability',
      status: 'NOT_FOUND',
      whatWouldResolve: 'Explicit references from code to documentation would allow documentation drift to be measured.',
      observations: [
        'No code-to-documentation relationship was found.',
        'Documentation may exist as prose that never names the code entity it describes. Detecting that requires semantics this phase does not have, so this does not mean the project is undocumented.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'info',
    };
  }

  return {
    id: 'documentation-links',
    title: 'Documentation traceability',
    status: 'EXPLICIT',
    whatWouldResolve: 'Nothing — documentation references are present.',
    observations: [`${documentEdges} code-to-documentation relationship(s) recorded.`],
    checked,
    relatedNodeIds: [],
    severity: 'info',
  };
}

function ownership(
  nodes: Map<string, number>,
  edges: Map<string, number>,
  graph: SoftwareGraph,
): Gap {
  const contributors = get(nodes, 'contributor');
  const commits = get(nodes, 'commit');
  const checked = ['git history availability', 'contributor and commit nodes', 'authored_by relationships'];

  if (contributors === 0 || commits === 0) {
    return {
      id: 'ownership',
      title: 'Component ownership',
      status: 'NOT_FOUND',
      whatWouldResolve: 'Git history in the analysed repository would allow commit-based ownership to be reconstructed.',
      observations: [
        'No contributor or commit was reconstructed.',
        'This is expected when analysing an exported archive or a shallow clone with no history.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'info',
    };
  }

  return {
    id: 'ownership',
    title: 'Component ownership',
    status: get(edges, 'authored_by') > 0 ? 'EXPLICIT' : 'PARTIALLY_EVIDENCED',
    whatWouldResolve:
      get(edges, 'authored_by') > 0 ? 'Nothing — authorship is recorded.' : 'Commit-to-author relationships from git history.',
    observations: [
      `${contributors} contributor(s) and ${commits} commit(s) reconstructed from git history.`,
    ],
    checked,
    relatedNodeIds: nodeIdsOfKind(graph, 'contributor'),
    severity: 'info',
  };
}

function requirements(edges: Map<string, number>, graph: SoftwareGraph): Gap {
  const model = buildRequirements(graph);
  const useCases = buildUseCases(graph, model.requirements);
  // The models, not node counts: a use case is a projection over entry points and calls, so it
  // has no node of its own, and counting `use_case` nodes would report zero for every
  // repository including the ones with twenty endpoints.
  const stated = model.requirements.filter((requirement) => requirement.origin === 'declared').length;
  const derived = model.requirements.length - stated;
  const implemented = get(edges, 'implements_requirement');
  const traced = model.requirements.filter((requirement) => requirement.supportedByNodeIds.length > 0).length;
  const checked = ['documents stating a requirement', 'derived requirement rules', 'use-case entry points and calls'];

  if (model.requirements.length === 0 && useCases.useCases.length === 0) {
    return {
      id: 'requirements',
      title: 'Requirements traceability',
      status: 'NOT_FOUND',
      whatWouldResolve:
        'Requirements documents, issue templates, or user stories in the repository would provide explicit requirement entities.',
      observations: [
        'No requirement or use-case entity was extracted.',
        'Requirements are frequently held in an issue tracker rather than in the repository; this status does not imply they do not exist.',
      ],
      checked,
      relatedNodeIds: [],
      severity: 'info',
    };
  }

  return {
    id: 'requirements',
    title: 'Requirements traceability',
    status: implemented > 0 ? 'EXPLICIT' : 'PARTIALLY_EVIDENCED',
    whatWouldResolve:
      implemented > 0
        ? 'Nothing.'
        : 'Documents that name the code implementing a requirement, so the link is stated rather than matched by name.',
    observations: [
      `${stated} requirement(s) stated by a document, ${derived} derived from the code by a fixed rule.`,
      `${useCases.useCases.length} use case(s) recovered from entry points and the calls relationships reachable from them.`,
      `${traced} of ${model.requirements.length} requirement(s) name code that implements them; ${implemented} relationship(s) recorded in the graph.`,
    ],
    checked,
    relatedNodeIds: nodeIdsOfKind(graph, 'requirement'),
    severity: 'info',
  };
}

/**
 * Declared-but-unused and used-but-undeclared dependencies.
 *
 * This is a real consistency check rather than a gap, but it belongs in the same
 * report because both answer "what does the repository not tell us about itself".
 */
function dependencyHygiene(graph: SoftwareGraph): Gap {
  const declared = new Set<string>();
  const used = new Map<string, string>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'depends_on') continue;
    const target = graph.nodes.find((node) => node.id === edge.to);
    if (!target || target.kind !== 'package') continue;
    const attributes = edge.attributes ?? {};
    if (attributes.declared === true) declared.add(target.name);
    else used.set(target.name, edge.from);
  }

  const unused = [...declared].filter((name) => !used.has(name));
  const undeclared = [...used.keys()].filter((name) => !declared.has(name));

  const observations: string[] = [];
  if (unused.length > 0) observations.push(`${unused.length} dependency(ies) declared in a manifest but not imported: ${unused.slice(0, 8).join(', ')}.`);
  if (undeclared.length > 0) observations.push(`${undeclared.length} import(s) reference a package not declared in any analysed manifest: ${undeclared.slice(0, 8).join(', ')}.`);
  if (observations.length === 0) observations.push('Every imported package is declared, and every declared package is imported.');

  const status: EvidenceStatus =
    unused.length === 0 && undeclared.length === 0 ? 'EXPLICIT' : observations.length > 0 && (unused.length > 0 || undeclared.length > 0) ? 'PARTIALLY_EVIDENCED' : 'NOT_FOUND';

  return {
    id: 'dependency-hygiene',
    title: 'Dependency consistency',
    status,
    whatWouldResolve: 'Manifests and import statements that agree with each other.',
    observations,
    checked: ['manifest dependency declarations', 'import specifiers referencing external packages'],
    relatedNodeIds: [],
    severity: unused.length > 0 || undeclared.length > 0 ? 'warning' : 'info',
  };
}

/** Whether extraction itself produced enough material for the findings above to mean anything. */
function parseHealth(graph: SoftwareGraph): Gap {
  // The repository node exists as soon as a path was analysed, so it must not be
  // counted as evidence that anything was actually understood.
  const meaningfulNodes = graph.nodes.filter((node) => node.kind !== 'repository');
  const citedPaths = new Set(graph.evidence.map((item) => item.path));

  return {
    id: 'analysis-completeness',
    title: 'Analysis completeness',
    status: meaningfulNodes.length === 0 ? 'NOT_FOUND' : 'EXPLICIT',
    whatWouldResolve:
      meaningfulNodes.length === 0
        ? 'At least one analyzable source file with recognisable declarations.'
        : 'Nothing — entities were extracted and are individually cited.',
    observations: [
      meaningfulNodes.length === 0
        ? 'No graph entities were produced. Check the analysis diagnostics: the repository may be empty, entirely unsupported, or fully excluded by limits.'
        : `${meaningfulNodes.length} entities and ${graph.edges.length} relationships were extracted, citing ${citedPaths.size} file(s).`,
      'Relations marked below EXPLICIT were reconstructed rather than stated. Inspect evidence before relying on them.',
    ],
    checked: ['graph node and edge counts', 'evidence coverage across analysed files'],
    relatedNodeIds: [],
    severity: meaningfulNodes.length === 0 ? 'warning' : 'info',
  };
}

/** Filters a gap's related nodes down to the ids the API returns. */
export function relatedNodeIds(gap: Gap): string[] {
  return gap.relatedNodeIds.filter((id) => typeof id === 'string' && id.length > 0);
}

export type { GraphEdge, GraphNode };