import type { Confidence, EvidenceRef, GraphNode, SoftwareGraph } from './types.js';
import { nodeId } from './ids.js';

/**
 * Requirements.
 *
 * A requirement is a statement about what the system does, carrying the evidence for it. Two
 * kinds exist, and keeping them apart is the whole point of this module:
 *
 * - **Declared** — the repository states it in words. A `requirement` node exists only when a
 *   document says something that is recognisably a requirement. Nothing turns an endpoint into
 *   a business requirement.
 * - **Derived** — a statement composed from observed graph facts by a rule stated here. These
 *   describe *implementation behaviour*, and every one of them says so. `POST /users validates
 *   email` may support "the system exposes POST /users"; it does not prove that the business
 *   requires users to register with an email address.
 *
 * The distinction is preserved in the model rather than in prose, so a consumer cannot read a
 * derived requirement as a business one by accident. `origin` is required, and a derived
 * requirement always names the rule that produced it.
 *
 * Nothing here reads a source file. Every requirement traces to graph nodes, and every graph
 * node traces to evidence.
 */

export const REQUIREMENT_STATUSES = [
  /** The repository states this, in a document or in code. */
  'OBSERVED',
  /** Composed from observed facts by a stated rule. Describes implementation, not intent. */
  'DERIVED',
  /** Some supporting facts were found and some were not. */
  'PARTIAL',
  /** The question was asked and the repository does not answer it. */
  'UNKNOWN',
  /** Evidence that would support it exists and contradicts it. */
  'UNSUPPORTED',
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_CATEGORIES = [
  'interface_behaviour',
  'validation',
  'persistence',
  'error_handling',
  'integration_behaviour',
  'operational_behaviour',
  'configuration',
  'declared',
] as const;

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export interface Requirement {
  /** Deterministic: `<origin>:<category>:<subject>`. */
  id: string;
  category: RequirementCategory;
  /** The statement, phrased as a requirement rather than as an implementation note. */
  statement: string;
  status: RequirementStatus;
  confidence: Confidence;
  /**
   * Where this requirement came from.
   *
   * `declared` means a document in the repository states it. `derived` means a rule in this
   * module composed it from graph facts. The distinction is the difference between business
   * intent and implementation behaviour, so it is data, not wording.
   */
  origin: 'declared' | 'derived';
  /** The explicit rule that produced a derived requirement. Empty for a declared one. */
  derivation: string;
  evidence: EvidenceRef[];
  /** Graph entities that support it. Never empty: a requirement without support is not one. */
  supportedByNodeIds: string[];
  /** Graph relationships that support it. */
  supportedByEdgeIds: string[];
  /** True when the repository states the requirement in a document. */
  declaredInPath?: string;
}

export interface RequirementModel {
  requirements: Requirement[];
  counts: Record<RequirementStatus, number>;
  /** Total number of documents searched for declared requirements. */
  documentsSearched: number;
  summary: {
    declared: number;
    derived: number;
    /** Claims this model deliberately does not make, each with the reason. */
    notRecovered: { reason: string; count: number }[];
  };
}

const STATUS_ZERO: Record<RequirementStatus, number> = {
  OBSERVED: 0,
  DERIVED: 0,
  PARTIAL: 0,
  UNKNOWN: 0,
  UNSUPPORTED: 0,
};

/**
 * Builds the requirement model from a graph.
 *
 * Deterministic: same graph, same model, byte for byte.
 */
export function buildRequirements(graph: SoftwareGraph): RequirementModel {
  const declared = declaredRequirements(graph);
  const derived = [
    ...interfaceRequirements(graph),
    ...persistenceRequirements(graph),
    ...operationalRequirements(graph),
  ];

  const requirements = [...declared, ...derived].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts = { ...STATUS_ZERO };
  for (const requirement of requirements) counts[requirement.status] += 1;

  const documents = graph.nodes.filter((node) => node.kind === 'module' && isDocumentPath(node.path)).length;

  return {
    requirements,
    counts,
    documentsSearched: documents,
    summary: {
      declared: declared.length,
      derived: derived.length,
      notRecovered: notRecovered(graph, declared.length, documents),
    },
  };
}

/**
 * Requirements a document states in words.
 *
 * A `requirement` node is the only thing that qualifies. Phase 3 deliberately does not parse
 * prose looking for modal verbs: "the system must be fast" in a README is a wish, and
 * recovering it as a requirement with `OBSERVED` status would dress an aspiration up as a
 * fact. If a repository has no `requirement` nodes, it has no declared requirements, and the
 * model says so.
 */
function declaredRequirements(graph: SoftwareGraph): Requirement[] {
  return graph.nodes
    .filter((node) => node.kind === 'requirement')
    .map((node) => ({
      id: `declared:declared:${node.id}`,
      category: 'declared' as const,
      statement: node.qualifiedName ?? node.name,
      status: 'OBSERVED' as const,
      confidence: node.confidence,
      origin: 'declared' as const,
      derivation: 'A requirement entity exists in the graph, which means the repository states it.',
      evidence: node.evidence,
      supportedByNodeIds: supportingEntities(graph, node, 'implements_requirement').map((other) => other.id),
      supportedByEdgeIds: edgesBetween(graph, node, 'implements_requirement').map((edge) => edge.id),
      ...(node.path ? { declaredInPath: node.path } : {}),
    }))
    .filter((requirement) => requirement.supportedByNodeIds.length > 0);
}

/**
 * Externally callable surface, one requirement per route.
 *
 * This is interface behaviour, and it is phrased as such. "The system exposes GET /reports"
 * is a claim about the implementation. Whether the business requires an endpoint is a
 * different question that this repository cannot answer.
 */
function interfaceRequirements(graph: SoftwareGraph): Requirement[] {
  const fromRoutes: Requirement[] = graph.nodes
    .filter((node) => node.kind === 'api_endpoint')
    .map((node) => {
      // The endpoint node's name is already METHOD /route, exactly as the repository wrote it.
      const route = node.name;
      const handler = attribute(node, 'handler');

      // A route whose handler the parser identified supports more than "the route exists":
      // the repository states both the endpoint and the code that serves it.
      const status: RequirementStatus = handler ? 'OBSERVED' : 'PARTIAL';
      const statement =
        handler === undefined
          ? `The system exposes ${route}; the handler was not identified.`
          : `The system exposes ${route}, served by ${handler}.`;

      return {
        id: `derived:interface_behaviour:${node.id}`,
        category: 'interface_behaviour' as const,
        statement,
        status,
        // The route declaration is explicit. What the handler does is only as strong as the
        // evidence for it, which is the endpoint's own citation when no handler was resolved.
        confidence: node.confidence,
        origin: 'derived' as const,
        derivation: `Composed from the ${node.kind} node ${node.id}, which was created from a route registration in source.`,
        evidence: node.evidence,
        supportedByNodeIds: [node.id, ...servingModuleIds(graph, node)],
        supportedByEdgeIds: edgesInto(graph, node).map((edge) => edge.id),
      } satisfies Requirement;
    });

  return [...fromRoutes, ...validationRequirements(graph)];
}

/**
 * Validation or authorisation behaviour, only where the graph records a guard call.
 *
 * "The route validates its input" is supported by a `calls` relationship to something named
 * like a guard, cited in the file that registers the route. It is not supported by the
 * existence of the route, and not by a guard call somewhere else in the repository. A
 * repository with no guards produces no requirement and no complaint about it.
 */
function validationRequirements(graph: SoftwareGraph): Requirement[] {
  const requirements: Requirement[] = [];

  for (const endpoint of graph.nodes.filter((node) => node.kind === 'api_endpoint')) {
    const guards = guardCalls(graph, endpoint);
    if (guards.length === 0) continue;
    const route = endpoint.name;
    const kinds = [...new Set(guards.map((guard) => guard.kind))].sort();

    requirements.push({
      id: `derived:${kinds.includes('authorization') ? 'operational_behaviour' : 'validation'}:${endpoint.id}`,
      category: kinds.includes('authorization') ? 'operational_behaviour' : 'validation',
      statement:
        kinds.includes('authorization') && kinds.includes('validation')
          ? `${route} validates its input and applies an authorisation guard.`
          : kinds.includes('authorization')
            ? `${route} applies an authorisation guard.`
            : `${route} validates its input.`,
      status: 'OBSERVED',
      // The guard call is resolved by name, which is the same weakness as any name-based call
      // resolution in the graph. Never upgraded to explicit.
      confidence: guards.every((guard) => guard.confidence === 'EXPLICIT') ? 'EXPLICIT' : 'STRONGLY_INFERRED',
      origin: 'derived',
      derivation: `Composed from the guard calls recorded on ${endpoint.path ?? 'the registering file'}: ${guards
        .map((guard) => guard.callee)
        .sort()
        .join(', ')}.`,
      evidence: dedupeEvidence([...endpoint.evidence, ...guards.flatMap((guard) => guard.evidence)]),
      supportedByNodeIds: [endpoint.id, ...[...new Set(guards.map((guard) => guard.from))]],
      supportedByEdgeIds: guards.map((guard) => guard.id),
    });
  }

  return requirements;
}

/** Data the repository actually reads and writes, phrased as persistence behaviour. */
function persistenceRequirements(graph: SoftwareGraph): Requirement[] {
  const reads = graph.edges.filter((edge) => edge.kind === 'reads');
  const writes = graph.edges.filter((edge) => edge.kind === 'writes');
  if (reads.length === 0 && writes.length === 0) return [];

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const requirements: Requirement[] = [];

  for (const [operation, edges] of [
    ['reads', reads],
    ['writes', writes],
  ] as const) {
    const tables = new Set(
      edges.map((edge) => byId.get(edge.to)).filter((node): node is GraphNode => Boolean(node?.kind === 'table')).map((node) => node.name),
    );
    if (tables.size === 0) continue;

    requirements.push({
      id: `derived:persistence:${operation}:${[...tables].sort().join('+')}`,
      category: 'persistence',
      statement: `The system ${operation} the ${[...tables].sort().join(', ')} ${tables.size === 1 ? 'table' : 'tables'}.`,
      // EXPLICIT only when a SQL statement in source named the table. An edge at a lower
      // confidence means the code referred to the table without this analysis resolving who.
      status: edges.every((edge) => edge.confidence === 'EXPLICIT') ? 'OBSERVED' : 'PARTIAL',
      confidence: edges.every((edge) => edge.confidence === 'EXPLICIT') ? 'EXPLICIT' : 'WEEKLY_INFERRED',
      origin: 'derived',
      derivation: `Composed from the ${operation} relationships the graph records for SQL statements found in source.`,
      evidence: dedupeEvidence(edges.flatMap((edge) => edge.evidence)),
      supportedByNodeIds: [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))],
      supportedByEdgeIds: edges.map((edge) => edge.id),
    });
  }

  return requirements;
}

/** Configuration the repository states as a requirement on its own operation. */
function operationalRequirements(graph: SoftwareGraph): Requirement[] {
  const components = graph.nodes.filter((node) => node.kind === 'deployment_component');
  if (components.length === 0) return [];

  return [
    {
      id: 'derived:operational_behaviour:declared_containers',
      category: 'operational_behaviour' as const,
      statement: `The repository declares ${components.length} deployable ${components.length === 1 ? 'unit' : 'units'}: ${components.map((node) => node.name).sort().join(', ')}.`,
      status: 'OBSERVED' as const,
      confidence: components.every((node) => node.confidence === 'EXPLICIT') ? ('EXPLICIT' as const) : ('WEEKLY_INFERRED' as const),
      origin: 'derived' as const,
      derivation: 'Composed from the deployment component nodes created from deployment declarations in source.',
      evidence: dedupeEvidence(components.flatMap((node) => node.evidence)),
      supportedByNodeIds: components.map((node) => node.id),
      supportedByEdgeIds: [],
    },
  ];
}

/** Claims this model deliberately does not make. */
function notRecovered(graph: SoftwareGraph, declared: number, documents: number): { reason: string; count: number }[] {
  const missing: { reason: string; count: number }[] = [];

  missing.push({
    reason:
      'business requirements and user stories: no requirement entity exists in the graph, and prose is not parsed for intent. A README wish is not a requirement',
    count: Math.max(documents, 1),
  });

  if (declared === 0) {
    missing.push({
      reason:
        'authorisation requirements: no authenticates or authorizes relationship exists in the graph, so the system states no authorisation boundary',
      count: graph.edges.filter((edge) => edge.kind === 'authenticates' || edge.kind === 'authorizes').length,
    });
  }

  const unqualified = graph.nodes.filter((node) => node.kind === 'table' && node.attributes?.declaredInDdl === false).length;
  if (unqualified > 0) {
    missing.push({
      reason:
        'schema requirements for tables referenced by code but never declared in a DDL this analysis read',
      count: unqualified,
    });
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attribute(node: GraphNode, key: string): string | undefined {
  const value = node.attributes?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isDocumentPath(path: string | undefined): boolean {
  if (!path) return false;
  return /\.(md|mdx|rst|txt|adoc)$/i.test(path);
}

/** Modules that contain the endpoint's registering code. */
function servingModuleIds(graph: SoftwareGraph, endpoint: GraphNode): string[] {
  if (!endpoint.path) return [];
  const moduleId = nodeId('module', endpoint.path.replace(/\.[^.]+$/, ''));
  return graph.nodes.some((node) => node.id === moduleId) ? [moduleId] : [];
}

function edgesInto(graph: SoftwareGraph, node: GraphNode): SoftwareGraph['edges'] {
  return graph.edges.filter((edge) => edge.to === node.id);
}

function edgesBetween(graph: SoftwareGraph, node: GraphNode, kind: SoftwareGraph['edges'][number]['kind']): SoftwareGraph['edges'] {
  return graph.edges.filter((edge) => edge.kind === kind && edge.from === node.id);
}

function supportingEntities(graph: SoftwareGraph, node: GraphNode, kind: SoftwareGraph['edges'][number]['kind']): GraphNode[] {
  const targets = new Set(edgesBetween(graph, node, kind).map((edge) => edge.to));
  return graph.nodes.filter((candidate) => targets.has(candidate.id));
}

function dedupeEvidence(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const ref of refs) if (!seen.has(ref.evidenceId)) seen.set(ref.evidenceId, ref);
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
}

interface GuardCall {
  id: string;
  from: string;
  callee: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  kind: 'validation' | 'authorization';
}

/**
 * Guard calls made from the file that registers a route.
 *
 * Scoped to that file on purpose: a validation call in an unrelated module says nothing about
 * this endpoint. The caller is resolved through the graph, so the evidence returned is the
 * call site itself and not a restatement of it.
 */
function guardCalls(graph: SoftwareGraph, endpoint: GraphNode): GuardCall[] {
  if (!endpoint.path) return [];

  const guards: GuardCall[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const callee = typeof edge.attributes?.callee === 'string' ? edge.attributes.callee : '';
    if (callee.length === 0) continue;

    const kind = GUARD_CALLEES.authorization.find((pattern) => pattern.test(callee))
      ? 'authorization'
      : GUARD_CALLEES.validation.find((pattern) => pattern.test(callee))
        ? 'validation'
        : null;
    if (!kind) continue;

    const caller = graph.nodes.find((node) => node.id === edge.from);
    if (caller?.path !== endpoint.path) continue;

    guards.push({ id: edge.id, from: edge.from, callee, confidence: edge.confidence, evidence: edge.evidence, kind });
  }
  return guards.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Callee names treated as guards.
 *
 * A fixed list of patterns, not a score. A name that matches is evidence the repository uses
 * something shaped like a guard; it is not proof of what the guard does, which is why every
 * requirement built from one is capped at `STRONGLY_INFERRED` unless the call itself was
 * resolved explicitly.
 */
const GUARD_CALLEES = {
  validation: [/^validat/i, /^parse$/i, /^safeParse$/i, /^schema$/i, /^check[A-Z]/, /^assert[A-Z]/],
  authorization: [/^authenticate$/i, /^authorize$/i, /^requireAuth/i, /^isAuthenticated$/i, /^hasPermission/i],
} as const;
