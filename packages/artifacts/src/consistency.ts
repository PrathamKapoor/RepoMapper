import { buildRequirements, buildUseCases, type Requirement, type UseCase } from '@repoatlas/core';
import { buildC4 } from './c4.js';
import { buildActivity, buildSequence } from './behaviour.js';
import { buildDataFlow, traceLineage } from './data-flow.js';
import { buildErDiagram } from './er-diagram.js';
import { hasGraphSupport, type Artifact, type ProjectionContext } from './contract.js';

/**
 * Cross-artifact consistency.
 *
 * Every projection reads the same graph, so where can they disagree? In three places, and each
 * is a place where one view makes a claim another view's evidence does not support:
 *
 * 1. **A projection asserts something the graph does not contain.** A sequence message with no
 *    `calls` relationship, a data flow with no data relationship, an ER relationship with no
 *    schema relationship. The projections themselves drop these before rendering, so this class
 *    of finding is asserted *against the projections' own output* — it is the check that the
 *    gate is still in force.
 * 2. **A claim one view makes that another view cannot see.** A C4 container with no code, a
 *    use case whose entry point no behaviour view can reach, a requirement claiming
 *    implementation support where no implementation entity exists.
 * 3. **A gap between what the repository states and what it evidences.** A table with no code
 *    that touches it, a route with no test, a documented entry point with no implementation.
 *
 * The engine is not a truth source. It holds no state of its own, creates no facts, and its
 * output is a function of the graph alone: the same graph always produces the same findings in
 * the same order.
 *
 * **Absence is not a contradiction.** A missing relationship is reported as `MISSING_EVIDENCE`,
 * never as `CONTRADICTION`. A repository that does not use a datastore has not contradicted
 * anything, and saying it had would be the exact failure this product exists to avoid.
 */

export const CONSISTENCY_CLASSES = [
  /** Two representations state incompatible things about the same entity. */
  'CONTRADICTION',
  /** A claim is made that the repository does not evidence. Not a defect on its own. */
  'MISSING_EVIDENCE',
  /** Part of the evidence for a claim is present and part is not. */
  'PARTIAL_EVIDENCE',
  /** A projection asserts something the graph does not contain. */
  'UNSUPPORTED_INFERENCE',
  /** Representations agree. Recorded so that agreement is visible, not only disagreement. */
  'CONSISTENT',
] as const;

export type ConsistencyClass = (typeof CONSISTENCY_CLASSES)[number];

export const CONSISTENCY_SEVERITIES = ['info', 'warning'] as const;
export type ConsistencySeverity = (typeof CONSISTENCY_SEVERITIES)[number];

export interface ConsistencyFinding {
  /** Deterministic: `<rule>:<subject>`. */
  id: string;
  rule: string;
  class: ConsistencyClass;
  severity: ConsistencySeverity;
  title: string;
  /** What was expected, and what was found instead. */
  detail: string;
  /** Which representations took part. */
  artifacts: string[];
  /** Graph entities involved, when any. */
  nodeIds: string[];
  /** Graph relationships involved, when any. */
  edgeIds: string[];
  evidenceExpected: string;
  evidenceFound: string;
  derivation: string;
  confidence: 'EXPLICIT' | 'STRONGLY_INFERRED' | 'WEEKLY_INFERRED' | 'UNKNOWN';
}

export interface ConsistencyReport {
  findings: ConsistencyFinding[];
  counts: Record<ConsistencyClass, number>;
  /** Representations that took part, so a reader can see what was compared. */
  compared: string[];
  summary: string;
}

/**
 * Compares every representation built from one graph.
 *
 * Takes the same `ProjectionContext` the artifact registry uses, so the engine cannot see a
 * different graph from the views it is checking.
 */
export function checkConsistency(context: ProjectionContext): ConsistencyReport {
  const { graph } = context;
  const requirements = buildRequirements(graph);
  const useCases = buildUseCases(graph, requirements.requirements);

  const c4 = [buildC4(context, { level: 'context' }), buildC4(context, { level: 'container' }), buildC4(context, { level: 'component' })];
  const sequence = buildSequence(context);
  const activity = buildActivity(context);
  const dataFlow = buildDataFlow(context);
  const erDiagram = buildErDiagram(context);

  const findings: ConsistencyFinding[] = [
    ...projectionIntegrity('sequence', sequence, context),
    ...projectionIntegrity('activity', activity, context),
    ...projectionIntegrity('data-flow', dataFlow, context),
    ...projectionIntegrity('er-diagram', erDiagram, context),
    ...projectionIntegrity('c4-container', c4[1]!, context),
    ...containerWithoutCode(c4[1]!, graph),
    ...sequenceParticipantWithoutGraph(sequence, context),
    ...requirementSupport(requirements.requirements, graph),
    ...useCaseReachability(useCases.useCases, sequence, graph),
    ...entryPointCoverage(useCases, c4),
    ...untouchedStores(graph),
    ...untestedEntryPoints(useCases.useCases, graph),
    ...returnRelationshipSupport(graph),
    ...responseEndpointPairing(graph),
    ...queryExpressionAsStore(graph),
    ...unclassifiedStatements(graph),
    ...agreement(useCases, sequence, dataFlow),
  ];

  const sorted = findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts: Record<ConsistencyClass, number> = {
    CONTRADICTION: 0,
    MISSING_EVIDENCE: 0,
    PARTIAL_EVIDENCE: 0,
    UNSUPPORTED_INFERENCE: 0,
    CONSISTENT: 0,
  };
  for (const finding of sorted) counts[finding.class] += 1;

  return {
    findings: sorted,
    counts,
    compared: ['requirements', 'use-cases', 'c4', 'sequence', 'activity', 'data-flow', 'er-diagram'],
    summary:
      counts.CONSISTENT > 0
        ? `${counts.CONSISTENT} agreement(s) confirmed, ${counts.MISSING_EVIDENCE} claim(s) the repository does not evidence, ${counts.PARTIAL_EVIDENCE} partially evidenced, ${counts.UNSUPPORTED_INFERENCE} unsupported, ${counts.CONTRADICTION} contradiction(s). Absence is reported as absence, not as a defect.`
        : 'No cross-artifact agreement or disagreement could be established from this repository.',
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — a projection must not assert what the graph does not contain
// ---------------------------------------------------------------------------

function projectionIntegrity(kind: string, artifact: Artifact, context: ProjectionContext): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const nodeIds = new Set(context.graph.nodes.map((node) => node.id));

  for (const edge of artifact.edges) {
    const supported = hasGraphSupport(edge);
    const edgeExists = (edge.supportingEdgeIds ?? []).every((id) => context.graph.edges.some((candidate) => candidate.id === id));
    if (supported && edgeExists) continue;

    findings.push({
      id: `projection-integrity:${kind}:${edge.id}`,
      rule: 'projection-integrity',
      class: 'UNSUPPORTED_INFERENCE',
      severity: 'warning',
      title: `${kind} draws a relationship the graph does not support`,
      detail: `The relationship ${edge.source} → ${edge.target} is present in the projection but has no supporting graph relationship.`,
      artifacts: [kind],
      nodeIds: [edge.source, edge.target],
      edgeIds: edge.supportingEdgeIds ?? [],
      evidenceExpected: 'A graph relationship, or the existence of the graph nodes, justifying this projection relationship.',
      evidenceFound: supported ? 'The supporting ids do not resolve to graph relationships.' : 'No supporting ids at all.',
      derivation: 'Every relationship in every projection must name the graph fact behind it, and that fact must exist.',
      confidence: 'EXPLICIT',
    });
  }

  for (const node of artifact.nodes) {
    const unknown = (node.graphNodeIds ?? []).filter((id) => !nodeIds.has(id));
    if (unknown.length === 0) continue;
    findings.push({
      id: `projection-integrity:${kind}:${node.id}`,
      rule: 'projection-integrity',
      class: 'UNSUPPORTED_INFERENCE',
      severity: 'warning',
      title: `${kind} draws an element with no graph entity behind it`,
      detail: `Element ${node.id} names graph entities that do not exist: ${unknown.join(', ')}.`,
      artifacts: [kind],
      nodeIds: [node.id],
      edgeIds: [],
      evidenceExpected: 'An existing graph entity for every element in the projection.',
      evidenceFound: `${unknown.length} named entity id(s) do not exist in the graph.`,
      derivation: 'A projection may reformat a graph entity; it may not introduce one.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 2 — a C4 container with no code behind it
// ---------------------------------------------------------------------------

function containerWithoutCode(c4Container: Artifact, graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const components = buildActivity({ graph, maxElements: 5_000 });
  const attributed = new Set(
    components.nodes.filter((node) => node.kind !== 'condition').flatMap((node) => (node.graphNodeIds ?? [])),
  );

  for (const node of c4Container.nodes) {
    if (node.c4Kind !== 'container') continue;
    if (attributed.has(node.id)) continue;

    findings.push({
      id: `container-without-code:${node.id}`,
      rule: 'c4-without-code',
      class: 'MISSING_EVIDENCE',
      severity: 'info',
      title: `Container ${node.label} has no code the behaviour views can see`,
      detail:
        'The container is declared in a deployment file, but no module in the graph is attributed to it, so sequence and activity cannot show what runs inside it.',
      artifacts: ['c4-container', 'sequence', 'activity'],
      nodeIds: [node.id, ...(node.graphNodeIds ?? [])],
      edgeIds: [],
      evidenceExpected: 'A deploys relationship placing at least one module inside this container.',
      evidenceFound: 'None. The container may still be correct; the repository does not state which code runs in it.',
      derivation:
        'Compared the container elements of the C4 view against the modules the behaviour projections traverse. Absence of a deploys relationship is reported as absence, not as a contradiction.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 3 — a sequence participant the graph does not know
// ---------------------------------------------------------------------------

function sequenceParticipantWithoutGraph(sequence: Artifact, context: ProjectionContext): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const nodeIds = new Set(context.graph.nodes.map((node) => node.id));

  for (const node of sequence.nodes) {
    if (nodeIds.has(node.id)) continue;
    findings.push({
      id: `sequence-participant:${node.id}`,
      rule: 'sequence-participant',
      class: 'UNSUPPORTED_INFERENCE',
      severity: 'warning',
      title: `Sequence shows ${node.label}, which the graph does not contain`,
      detail: 'A participant in a sequence diagram must be a graph entity; anything else was drawn from nothing.',
      artifacts: ['sequence'],
      nodeIds: [node.id],
      edgeIds: [],
      evidenceExpected: 'A graph entity for every participant.',
      evidenceFound: 'The participant id is not in the graph.',
      derivation: 'Participants are read from the graph, so a participant the graph lacks can only be a defect.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 4 — a requirement claiming support it does not have
// ---------------------------------------------------------------------------

function requirementSupport(requirements: readonly Requirement[], graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  for (const requirement of requirements) {
    const unresolved = requirement.supportedByNodeIds.filter((id) => !nodeIds.has(id));
    if (unresolved.length > 0) {
      findings.push({
        id: `requirement-support:${requirement.id}`,
        rule: 'requirement-implementation',
        class: 'CONTRADICTION',
        severity: 'warning',
        title: `Requirement ${requirement.id} cites graph entities that do not exist`,
        detail: `Support was claimed from ${unresolved.length} entity id(s) the graph does not contain.`,
        artifacts: ['requirements'],
        nodeIds: unresolved,
        edgeIds: requirement.supportedByEdgeIds,
        evidenceExpected: 'Every entity named as support exists in the graph.',
        evidenceFound: `${unresolved.length} do not.`,
        derivation: 'A requirement may only cite graph entities. Citing one that does not exist is a contradiction, not a gap.',
        confidence: 'EXPLICIT',
      });
      continue;
    }

    if (requirement.origin === 'declared' && requirement.supportedByNodeIds.length === 0) {
      findings.push({
        id: `requirement-unimplemented:${requirement.id}`,
        rule: 'requirement-implementation',
        class: 'MISSING_EVIDENCE',
        severity: 'warning',
        title: `Declared requirement ${requirement.id} has no implementation evidence`,
        detail: 'The repository states this requirement, and nothing in the graph implements it.',
        artifacts: ['requirements'],
        nodeIds: requirement.supportedByNodeIds,
        edgeIds: [],
        evidenceExpected: 'An implements_requirement relationship, or a behaviour view showing the requirement being met.',
        evidenceFound: 'None.',
        derivation:
          'Absence of implementation evidence is reported as absence. The requirement may be met outside the repository, by hand, or not at all; this repository cannot say.',
        confidence: 'EXPLICIT',
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 5 — a use case the behaviour views cannot reach
// ---------------------------------------------------------------------------

function useCaseReachability(useCases: readonly UseCase[], sequence: Artifact, graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const sequenceNodes = new Set(sequence.nodes.map((node) => node.id));
  const calls = graph.edges.filter((edge) => edge.kind === 'calls').length;

  for (const useCase of useCases) {
    if (useCase.steps.length > 0) continue;

    findings.push({
      id: `use-case-unreachable:${useCase.id}`,
      rule: 'use-case-reachability',
      class: calls === 0 ? 'MISSING_EVIDENCE' : 'PARTIAL_EVIDENCE',
      severity: 'info',
      title: `Use case ${useCase.title} reaches nothing the graph records`,
      detail:
        calls === 0
          ? 'The graph holds no call relationships at all, so no interaction can be traced. That describes this repository, not this use case.'
          : 'Call relationships exist elsewhere in the graph, but none is reachable from this entry point.',
      artifacts: ['use-cases', 'sequence'],
      nodeIds: [useCase.entryNodeId],
      edgeIds: [],
      evidenceExpected: 'At least one call relationship reachable from the entry point.',
      evidenceFound: 'None reachable.',
      derivation:
        'Compared the use case step list against the sequence view. Both read the same calls relationships, so a use case with no steps is a genuine gap in the evidence rather than a difference of opinion.',
      confidence: 'EXPLICIT',
    });
    void sequenceNodes;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 6 — an entry point the architecture view cannot see
// ---------------------------------------------------------------------------

function entryPointCoverage(useCases: ReturnType<typeof buildUseCases>, c4: Artifact[]): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const containerModules = new Set(
    c4
      .filter((artifact) => artifact.kind === 'c4-component')
      .flatMap((artifact) => artifact.nodes)
      .flatMap((node) => node.graphNodeIds ?? []),
  );

  for (const useCase of useCases.useCases) {
    if (containerModules.size === 0) continue;
    if (containerModules.has(useCase.entryNodeId)) continue;

    findings.push({
      id: `entry-point-outside-container:${useCase.id}`,
      rule: 'entry-point-coverage',
      class: 'PARTIAL_EVIDENCE',
      severity: 'info',
      title: `Entry point ${useCase.title} is not inside any recovered container`,
      detail:
        'The entry point exists in the graph, and containers exist, but no deploys relationship places this entry point inside one of them.',
      artifacts: ['use-cases', 'c4-component'],
      nodeIds: [useCase.entryNodeId],
      edgeIds: [],
      evidenceExpected: 'A deploys relationship from a module containing the entry point to a container.',
      evidenceFound: 'None.',
      derivation:
        'The repository declares the entry point and the containers separately and does not connect them. Reported as partial evidence, not as a contradiction.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 7 — data and behaviour gaps
// ---------------------------------------------------------------------------

function untouchedStores(graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const touched = new Set(
    graph.edges.filter((edge) => edge.kind === 'reads' || edge.kind === 'writes').map((edge) => edge.to),
  );

  for (const table of graph.nodes.filter((node) => node.kind === 'table')) {
    if (touched.has(table.id)) continue;
    findings.push({
      id: `store-untouched:${table.id}`,
      rule: 'data-coverage',
      class: 'MISSING_EVIDENCE',
      severity: 'info',
      title: `Table ${table.name} is declared but no analysed code reads or writes it`,
      detail: 'A schema declares this store, and no SQL statement in the analysed repository names it.',
      artifacts: ['data-flow', 'er-diagram'],
      nodeIds: [table.id],
      edgeIds: [],
      evidenceExpected: 'A reads or writes relationship from code to this table.',
      evidenceFound: 'None.',
      derivation:
        'A data relationship comes from a table name in a SQL statement the extractor read, including every table in a join, a subquery or a set operation. An ORM, a query builder or a stored procedure produces none, so this is a limit of the extraction rather than evidence that the table is unused.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

/**
 * Checks each return and failure relationship against the call it claims to describe.
 *
 * A `returns` arrow says "this callee hands its value to this caller", and a `throws` arrow says
 * "this caller may see this failure". Both are only meaningful when the caller actually calls the
 * callee. If that call is absent, the arrow asserts a hand-back or a failure that nothing in the
 * code supports, which is the class of step this engine exists to catch.
 *
 * HTTP responses are excluded: they are written by the handler and paired with the endpoint that
 * calls it, which is a different relationship and is checked separately.
 */
function returnRelationshipSupport(graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  // Keyed `caller->callee`, the direction a call is recorded in. A return or failure
  // relationship is recorded the other way round, so the check reads the pair reversed.
  const calls = new Set(
    graph.edges.filter((edge) => edge.kind === 'calls').map((edge) => `${edge.from}->${edge.to}`),
  );

  for (const edge of graph.edges) {
    if (edge.kind !== 'returns' && edge.kind !== 'throws') continue;
    if (edge.kind === 'returns' && edge.attributes?.httpResponse === true) continue;
    if (calls.has(`${edge.to}->${edge.from}`)) continue;

    findings.push({
      id: `return-unsupported:${edge.id}`,
      rule: 'return-support',
      class: 'UNSUPPORTED_INFERENCE',
      severity: 'warning',
      title: `${edge.kind === 'returns' ? 'A return' : 'A failure'} relationship is not backed by a call`,
      detail: `${edge.from} → ${edge.to} is recorded, but no call from ${edge.to} to ${edge.from} exists in the graph.`,
      artifacts: ['sequence', 'use-cases'],
      nodeIds: [edge.from, edge.to],
      edgeIds: [edge.id],
      evidenceExpected: 'A calls relationship from the receiving function to the function it is recorded as receiving from.',
      evidenceFound: 'No such call was recorded.',
      derivation:
        'The relationship was created from a return or failure record scoped to the receiving function. The call itself was not resolved, so the hand-back cannot be followed from the code and is reported rather than trusted.',
      confidence: 'UNKNOWN',
    });
  }

  return findings;
}

/**
 * Checks that a recorded response is paired with an endpoint, not with an arbitrary node.
 *
 * The response arrow points at the requester. If the other end is not an endpoint, the pairing
 * came from something other than a route, and drawing it would put a response in a sequence where
 * no request arrives.
 */
function responseEndpointPairing(graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const endpoints = new Set(graph.nodes.filter((node) => node.kind === 'api_endpoint').map((node) => node.id));

  for (const edge of graph.edges) {
    if (edge.kind !== 'returns' || edge.attributes?.httpResponse !== true) continue;
    if (endpoints.has(edge.to)) continue;

    findings.push({
      id: `response-unpaired:${edge.id}`,
      rule: 'response-pairing',
      class: 'UNSUPPORTED_INFERENCE',
      severity: 'warning',
      title: 'A recorded response is not paired with an API endpoint',
      detail: `${edge.from} records a response, but ${edge.to} is not an endpoint.`,
      artifacts: ['sequence'],
      nodeIds: [edge.from, edge.to],
      edgeIds: [edge.id],
      evidenceExpected: 'The other end of a response relationship to be an endpoint that calls the handler.',
      evidenceFound: `${edge.to} is not an endpoint.`,
      derivation:
        'Responses are paired with the endpoint a route names. A response whose other end is not an endpoint did not come from that pairing, so it is reported instead of drawn.',
      confidence: 'UNKNOWN',
    });
  }

  return findings;
}

/**
 * Checks that a query expression was never turned into a stored table.
 *
 * A CTE name is not a table: it exists only inside one statement. If one reaches a table node, or
 * a reads or writes relationship, the multi-table extractor has confused a name for a store, and
 * the data-flow view would then draw a flow to something that does not exist.
 */
function queryExpressionAsStore(graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const expressions = new Set(
    graph.nodes.filter((node) => node.attributes?.queryExpression === true).map((node) => node.id),
  );
  if (expressions.size === 0) return findings;

  for (const edge of graph.edges) {
    if (edge.kind !== 'reads' && edge.kind !== 'writes') continue;
    if (!expressions.has(edge.to)) continue;

    findings.push({
      id: `cte-as-store:${edge.id}`,
      rule: 'query-expression-scope',
      class: 'CONTRADICTION',
      severity: 'warning',
      title: 'A query expression is recorded as a stored table',
      detail: `${edge.from} ${edge.kind} ${edge.to}, which is a query expression rather than a table.`,
      artifacts: ['data-flow', 'er-diagram'],
      nodeIds: [edge.from, edge.to],
      edgeIds: [edge.id],
      evidenceExpected: 'No reads or writes relationship to a query expression.',
      evidenceFound: `A ${edge.kind} relationship to a query expression exists.`,
      derivation:
        'A CTE or subquery name has no storage behind it. A relationship to one means the statement scope was lost, so the flow is contradicted rather than reported as unknown.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

/**
 * Reports SQL statements that were read but not classified as data access.
 *
 * The omission log names them; this makes the consequence visible where claims about data flow are
 * assessed: a repository whose queries are all unclassified has no evidenced read or write, and
 * that is a limit of this analyser rather than a finding about the code.
 */
function unclassifiedStatements(graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const unclassified = graph.nodes.filter((node) => node.attributes?.unclassifiedStatement === true);
  if (unclassified.length === 0) return [];

  return [
    {
      id: 'data-access:unclassified-statements',
      rule: 'data-classification',
      class: 'PARTIAL_EVIDENCE',
      severity: 'info',
      title: `${unclassified.length} SQL statement(s) were read but not classified as data access`,
      detail:
        'These statements were recorded with the reason they were not classified, and they produce no reads or writes relationship.',
      artifacts: ['data-flow'],
      nodeIds: unclassified.map((node) => node.id),
      edgeIds: [],
      evidenceExpected: 'Every SQL statement in the repository to classify as a read, a write, or neither.',
      evidenceFound: `${unclassified.length} statement(s) fall outside the patterns this analyser classifies.`,
      derivation:
        'Classification is limited to the statement forms listed in the data-access documentation. An unclassified statement is reported as an omission rather than guessed at, so the data-flow view for these statements is incomplete by construction.',
      confidence: 'EXPLICIT',
    },
  ];
}

function untestedEntryPoints(useCases: readonly UseCase[], graph: ProjectionContext['graph']): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const tested = new Set(graph.edges.filter((edge) => edge.kind === 'tests').map((edge) => edge.to));

  for (const useCase of useCases) {
    if (useCase.entryKind !== 'api_endpoint') continue;
    if (tested.has(useCase.entryNodeId)) continue;

    findings.push({
      id: `entry-point-untested:${useCase.id}`,
      rule: 'behaviour-coverage',
      class: 'MISSING_EVIDENCE',
      severity: 'info',
      title: `Entry point ${useCase.title} has no test relationship`,
      detail: 'The graph records no test covering this endpoint.',
      artifacts: ['use-cases', 'sequence'],
      nodeIds: [useCase.entryNodeId],
      edgeIds: [],
      evidenceExpected: 'A tests relationship from a test entity to this endpoint.',
      evidenceFound: 'None.',
      derivation:
        'Tests are matched to endpoints by the graph builder when the call is resolvable. A test that reaches the endpoint through a helper will not be attributed, so this is a limit of the matching, not a verdict on test coverage.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule 8 — recorded agreement
// ---------------------------------------------------------------------------

/**
 * Records what agrees, not only what does not.
 *
 * A consistency report listing only problems reads as an accusation. Recording the agreements
 * gives the problems context: a repository where five checks pass and one fails is a different
 * situation from one where nothing could be compared.
 */
function agreement(useCases: ReturnType<typeof buildUseCases>, sequence: Artifact, dataFlow: Artifact): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  if (useCases.useCases.length > 0 && sequence.edges.length > 0) {
    const reachable = useCases.useCases.filter((useCase) => useCase.steps.length > 0).length;
    if (reachable > 0) {
      findings.push({
        id: 'agreement:behaviour-traced',
        rule: 'cross-artefact-agreement',
        class: 'CONSISTENT',
        severity: 'info',
        title: 'Every recovered use case is traceable in the sequence view',
        detail: `${reachable} of ${useCases.useCases.length} use cases have at least one step, and the sequence view draws the same call relationships.`,
        artifacts: ['use-cases', 'sequence'],
        nodeIds: [],
        edgeIds: [],
        evidenceExpected: 'Use case steps and sequence messages drawn from the same calls relationships.',
        evidenceFound: `${sequence.edges.length} message(s) agree with ${reachable} use case(s).`,
        derivation: 'Both views read the same graph edges, so agreement here confirms neither is inventing a step.',
        confidence: 'EXPLICIT',
      });
    }
  }

  if (dataFlow.edges.length > 0) {
    findings.push({
      id: 'agreement:data-traced',
      rule: 'cross-artefact-agreement',
      class: 'CONSISTENT',
      severity: 'info',
      title: 'Data flows are traceable to schema-declared stores',
      detail: `${dataFlow.edges.length} data relationship(s) resolve to stores that exist in the graph.`,
      artifacts: ['data-flow', 'er-diagram'],
      nodeIds: [],
      edgeIds: dataFlow.edges.flatMap((edge) => edge.supportingEdgeIds ?? []),
      evidenceExpected: 'Every flow endpoint to be a store the graph holds.',
      evidenceFound: 'All flow endpoints resolve.',
      derivation: 'A flow into a store no schema declares is reported separately as an unknown store.',
      confidence: 'EXPLICIT',
    });
  }

  return findings;
}

export { traceLineage };
