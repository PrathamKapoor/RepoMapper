import type {
  Confidence,
  EdgeKind,
  EvidenceRef,
  GraphNode,
  SoftwareGraph,
} from '@repoatlas/core';
import {
  hasGraphSupport,
  type Artifact,
  type ArtifactEdge,
  type ArtifactNode,
  type C4ElementKind,
  type C4Level,
  type ProjectionContext,
} from './contract.js';

/**
 * C4 architecture recovery.
 *
 * This module is a **mapper**, not a scanner. It reads the canonical graph and decides
 * which graph facts correspond to a C4 element. It never opens a source file, never
 * re-derives an import, and never invents a boundary. Where the repository does not state
 * a boundary, the level reports `insufficientEvidence` and explains what is missing rather
 * than drawing a plausible-looking diagram.
 *
 * ## Mapping rules
 *
 * ### Level 1 — Context
 *
 * | C4 element | Graph source | Confidence |
 * |---|---|---|
 * | Software system | `repository` node | carried through (`EXPLICIT`) |
 * | External system | `deployment_component` whose declared image matches a known datastore or broker family | `WEEKLY_INFERRED` |
 * | Person | *(no source)* | not recoverable |
 *
 * Human actors are **not** invented. Nothing in the current graph describes who uses the
 * system, so `person` elements are never emitted and the omission is recorded. This is the
 * single most common place a diagram tool fabricates architecture.
 *
 * ### Level 2 — Container
 *
 * | C4 element | Graph source | Confidence |
 * |---|---|---|
 * | Container | `deployment_component` (compose service, container base image) | carried through (`EXPLICIT`) |
 * | Container dependency | `imports` / `calls` edges between modules that `deploys` edges place in different containers | weakest support |
 *
 * A package is **not** a container. Dependency packages are libraries; mapping them to
 * containers would assert a runtime boundary the repository never states. They are
 * deliberately excluded, and the exclusion is recorded so the omission is visible.
 *
 * The modules inside a container are *not* drawn at this level — that is what level 3 is
 * for. They are used here only to derive which containers are coupled.
 *
 * ### Level 3 — Component
 *
 * | C4 element | Graph source | Confidence |
 * |---|---|---|
 * | Component | `module` attributed to a container by a `deploys` edge | carried through |
 * | Component dependency | `imports` / `calls` edges between two such modules | carried through |
 *
 * Components are only emitted for modules the graph actually attributes to a container. A
 * module with no deployment attribution is left unattributed rather than being assigned to
 * a container by guesswork.
 *
 * ## Relationship integrity
 *
 * Every C4 relationship carries `supportingEdgeIds` — the graph edges that justify it — or
 * `supportingNodeIds` when the justification is the existence of nodes rather than a
 * relationship between them. A relationship with neither is dropped by `finish()` before it
 * can reach a renderer, because an unsupported arrow is an invented dependency. Where
 * several graph edges justify one architectural relationship, all are preserved and the
 * relationship takes the weakest confidence among them, because it is only as strong as its
 * weakest support.
 *
 * ## Known shortfall
 *
 * A container with no module attributed to it (a declared service nothing in the repository
 * imports, or a service whose code is not analysed) yields no components at level 3. That is
 * reported as an omission rather than papered over. Extracting runtime entrypoints that
 * link a container to its code is the smallest change that would fix it, and it belongs to a
 * later extraction phase.
 */

/**
 * Datastore and broker image families.
 *
 * A fixed list of patterns, not a similarity score, so the same image always yields the same
 * answer and the answer can be tested. A non-match means *unknown*, and the element is then
 * left out rather than guessed.
 */
const KNOWN_INFRASTRUCTURE_FAMILIES: readonly { family: string; match: RegExp }[] = [
  { family: 'postgres', match: /(^|[/:-])postgres([:/@.-]|$)/i },
  { family: 'mysql', match: /(^|[/:-])mysql([:/@.-]|$)/i },
  { family: 'mariadb', match: /(^|[/:-])mariadb([:/@.-]|$)/i },
  { family: 'mongodb', match: /(^|[/:-])mongo(db)?([:/@.-]|$)/i },
  { family: 'redis', match: /(^|[/:-])redis([:/@.-]|$)/i },
  { family: 'valkey', match: /(^|[/:-])valkey([:/@.-]|$)/i },
  { family: 'rabbitmq', match: /(^|[/:-])rabbitmq([:/@.-]|$)/i },
  { family: 'kafka', match: /(^|[/:-])kafka([:/@.-]|$)/i },
  { family: 'nats', match: /(^|[/:-])nats([:/@.-]|$)/i },
  { family: 'elasticsearch', match: /(^|[/:-])elastic(search)?([:/@.-]|$)/i },
  { family: 'minio', match: /(^|[/:-])minio([:/@.-]|$)/i },
  { family: 'memcached', match: /(^|[/:-])memcached([:/@.-]|$)/i },
];

export interface C4BuildOptions {
  level: C4Level;
}

/** Builds the C4 artifact for one abstraction level. */
export function buildC4(context: ProjectionContext, options: C4BuildOptions): Artifact {
  switch (options.level) {
    case 'context':
      return buildContext(context);
    case 'container':
      return buildContainer(context);
    case 'component':
      return buildComponent(context);
    default:
      return emptyArtifact(options.level);
  }
}

// ---------------------------------------------------------------------------
// Level 1 — Context
// ---------------------------------------------------------------------------

function buildContext(context: ProjectionContext): Artifact {
  const { graph } = context;
  const omitted: Artifact['omitted'] = [];

  const repository = graph.nodes.find((node) => node.kind === 'repository');
  if (!repository) {
    return emptyArtifact(
      'context',
      'The graph holds no repository node, so no software system could be identified.',
    );
  }

  const nodes: ArtifactNode[] = [
    c4Node(repository, 'context', 'software_system', {
      derivation: 'The analysed repository is the software system under analysis.',
    }),
  ];
  const edges: ArtifactEdge[] = [];

  const declared = graph.nodes.filter((node) => node.kind === 'deployment_component');
  // Only declared services are considered here. A base image is a build dependency; presenting
  // it as a system this one *communicates with* would assert a runtime relationship the
  // repository never states.
  const components = declared.filter(isRuntimeUnit);
  const baseImages = declared.filter((node) => !isRuntimeUnit(node));
  const unrecognised: GraphNode[] = [];

  for (const component of components) {
    const family = detectInfrastructureFamily(component);
    if (!family) {
      unrecognised.push(component);
      continue;
    }

    const image = String(component.attributes?.image ?? family.family);
    nodes.push(
      c4Node(component, 'context', 'external_system', {
        technology: image,
        // The compose file states an image; that the image is an external datastore is an
        // interpretation of the image name, so this is an inference, not a citation.
        confidence: 'WEEKLY_INFERRED',
        derivation: `Declared image "${image}" matches the known ${family.family} family, so the component is treated as an external system rather than part of this software system.`,
      }),
    );

    edges.push(
      c4Edge(
        { source: repository.id, target: component.id },
        'communicates_with',
        'WEEKLY_INFERRED',
        repository.evidence,
        // Support is the existence of the declared component node. There is no code path
        // in the graph from the repository to it, which is why the relationship is weak
        // and why the omission below is recorded.
        { supportingNodeIds: [component.id] },
        `Declared as service "${component.name}" in ${component.path ?? 'a deployment file'}, outside this repository's code.`,
        'context',
      ),
    );
  }

  if (unrecognised.length > 0) {
    omitted.push({
      reason:
        'declared services whose image matches no known datastore or broker family, so it cannot be established whether they are internal containers or external systems',
      count: unrecognised.length,
      examples: unrecognised.slice(0, 3).map((component) => component.name),
    });
  }

  if (baseImages.length > 0) {
    omitted.push({
      reason:
        'base images are not external systems at this level: a `FROM` line states what an image is built from, not what the running system talks to',
      count: baseImages.length,
      examples: baseImages.slice(0, 3).map((node) => node.name),
    });
  }

  // Recorded unconditionally rather than only when actors exist, because the absence is
  // itself a statement about what this repository can and cannot evidence.
  omitted.push({
    reason:
      'human actors: nothing in the graph describes who uses the system, so no person element is emitted rather than one being invented',
    count: 1,
    examples: [],
  });

  const codeLevelSupport = graph.edges.filter((edge) => edge.kind === 'depends_on' || edge.kind === 'exposes').length;
  if (components.length > 0 && codeLevelSupport === 0) {
    omitted.push({
      reason:
        'the graph holds no depends_on or exposes relationships, so communication is evidenced only by co-declaration in a deployment file, not by a code path',
      count: Math.max(components.length, 1),
      examples: [],
    });
  }

  return finish({
    kind: 'c4-context',
    level: 'context',
    title: 'C4 — System context',
    scope:
      'Level 1. The software system is the analysed repository. External systems appear only where a deployment file declares an image belonging to a known datastore or broker family. Human actors are not recovered because nothing in the repository evidences them.',
    graph,
    nodes,
    edges,
    omitted,
  });
}

/**
 * Deployment components that state something that *runs*.
 *
 * `FROM node:24-bookworm-slim` states what an image is built from, not a deployable unit of
 * this system. The graph records the distinction (`attributes.declaredAs`), and this filter is
 * where it is applied: drawing a base image as a container would put a dependency in the
 * architecture beside the system that depends on it.
 */
function isRuntimeUnit(component: GraphNode): boolean {
  return component.attributes?.declaredAs !== 'base_image';
}

// ---------------------------------------------------------------------------
// Level 2 — Container
// ---------------------------------------------------------------------------

function buildContainer(context: ProjectionContext): Artifact {
  const { graph } = context;
  const omitted: Artifact['omitted'] = [];

  const repository = graph.nodes.find((node) => node.kind === 'repository');
  const declared = graph.nodes.filter((node) => node.kind === 'deployment_component');
  const components = declared.filter(isRuntimeUnit);
  const baseImages = declared.filter((node) => !isRuntimeUnit(node));

  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];

  if (repository) {
    nodes.push(
      c4Node(repository, 'container', 'software_system', {
        derivation: 'The analysed repository is the software system that owns these containers.',
      }),
    );
  }

  if (components.length === 0) {
    return finish({
      kind: 'c4-container',
      level: 'container',
      title: 'C4 — Containers',
      scope:
        'Level 2. Containers are taken only from deployment declarations in the repository. No deployment configuration was found, so no container boundary could be established.',
      graph,
      nodes,
      edges,
      omitted: [
        {
          reason:
            baseImages.length > 0
              ? 'only base images were declared. A `FROM` line states what an image is built from, not a deployable unit of this system'
              : 'no deployment configuration was found. A compose file, Dockerfile or infrastructure manifest would establish container boundaries explicitly',
          count: Math.max(baseImages.length, 1),
          examples: baseImages.slice(0, 3).map((node) => node.name),
        },
      ],
      insufficient: true,
    });
  }

  const byId = indexNodes(graph);

  for (const component of components) {
    const element = c4Node(component, 'container', 'container', {
      technology: containerTechnology(component),
      derivation:
        'Declared as a service or image in a deployment file, so the repository states this is a separately deployable runtime unit.',
    });
    nodes.push(element);

    if (repository) {
      edges.push(
        c4Edge(
          { source: repository.id, target: component.id },
          'contains',
          'EXPLICIT',
          component.evidence,
          // The containment is established by the declaration itself; the graph records no
          // edge from the repository node to a declared service.
          { supportingNodeIds: [component.id] },
          `Declared as a service in ${component.path ?? 'a deployment file'}.`,
          'container',
        ),
      );
    }
  }

  // A module linked to a component by a `deploys` edge runs inside it. That link is what
  // makes a cross-container relationship evidence-based rather than assumed.
  const { attribution: moduleToContainer, declaringFileIds } = attributeModulesToContainers(graph);
  const deploysEdges = indexDeploysEdges(graph);

  for (const { from, to, supporting } of crossContainerDependencies(graph, moduleToContainer)) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;

    edges.push(
      c4Edge(
        { source: from, target: to },
        'depends_on',
        weakestConfidence(supporting.map((edge) => edge.confidence)),
        supporting.flatMap((edge) => edge.evidence),
        { supportingEdgeIds: supporting.map((edge) => edge.id) },
        'Derived from import and call edges between modules that deploys relationships place in these two containers.',
        'container',
      ),
    );
  }

  // A declared service that no analysed module is attributed to still exists, but nothing
  // in this repository says which code runs in it. Say so instead of drawing a container
  // with unexplained contents.
  const populated = new Set(moduleToContainer.values());
  const empty = components.filter((component) => !populated.has(component.id));
  if (empty.length > 0) {
    omitted.push({
      reason:
        'declared containers with no module attributed to them; the repository does not state which code runs inside them, so level 3 shows no components for them',
      count: empty.length,
      examples: empty.slice(0, 3).map((component) => component.name),
    });
  }

  if (deploysEdges.size === 0 && components.length > 0) {
    omitted.push({
      reason:
        'the graph holds no deploys relationships, so no module is placed inside a container and no container dependency could be derived from code',
      count: components.length,
      examples: [],
    });
  }

  if (declaringFileIds.size > 0) {
    omitted.push({
      reason:
        'deployment files that declare a container are not shown as running inside it; a compose file describes the service, it is not part of it',
      count: declaringFileIds.size,
      examples: [],
    });
  }

  if (baseImages.length > 0) {
    omitted.push({
      reason:
        'base images are not containers. A `FROM` line states what an image is built from, which is a dependency of the system rather than a runtime unit of it',
      count: baseImages.length,
      examples: baseImages.slice(0, 3).map((node) => node.name),
    });
  }

  const unattributed = graph.nodes.filter(
    (node) =>
      node.kind === 'module' && !moduleToContainer.has(node.id) && !declaringFileIds.has(node.id),
  ).length;
  if (unattributed > 0) {
    omitted.push({
      reason:
        'modules with no deployment attribution. They are not assigned to a container, and are not drawn here either, because drawing them would imply a runtime boundary the repository does not state',
      count: unattributed,
      examples: [],
    });
  }

  const packages = graph.nodes.filter((node) => node.kind === 'package').length;
  if (packages > 0) {
    omitted.push({
      reason:
        'third-party packages are excluded from this level: a dependency package is a library, not a runtime container, and treating it as one would assert a boundary the repository never states',
      count: packages,
      examples: [],
    });
  }

  if (deploysEdges.size === 0 && components.length > 0) {
    omitted.push({
      reason:
        'the graph holds no deploys relationships, so no module is placed inside a container and no container dependency could be derived from code',
      count: components.length,
      examples: [],
    });
  }

  return finish({
    kind: 'c4-container',
    level: 'container',
    title: 'C4 — Containers',
    scope:
      'Level 2. Containers come only from deployment declarations. A module is placed in a container only where the graph records a deploys relationship, and container-to-container dependencies come only from import and call edges between modules in different containers. Third-party packages are excluded.',
    graph,
    nodes,
    edges,
    omitted,
  });
}

// ---------------------------------------------------------------------------
// Level 3 — Component
// ---------------------------------------------------------------------------

function buildComponent(context: ProjectionContext): Artifact {
  const { graph } = context;
  const omitted: Artifact['omitted'] = [];

  const byId = indexNodes(graph);
  const { attribution, declaringFileIds } = attributeModulesToContainers(graph);
  const attributed = new Set(attribution.keys());

  if (attributed.size === 0) {
    return finish({
      kind: 'c4-component',
      level: 'component',
      title: 'C4 — Components',
      scope:
        'Level 3. Components are the modules the graph attributes to a container. No module is attributed in this repository, so no component boundary could be established.',
      graph,
      nodes: [],
      edges: [],
      omitted: [
        {
          reason:
            'no module carries a deploys relationship to a container, so no module can be placed inside a container without guessing',
          count: graph.nodes.filter((node) => node.kind === 'module').length,
          examples: [],
        },
      ],
      insufficient: true,
    });
  }

  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];
  const deploysEdges = indexDeploysEdges(graph);
  const includedContainers = new Set<string>();

  for (const [moduleId, containerId] of attribution) {    const module = byId.get(moduleId);
    const container = byId.get(containerId);
    if (!module || !container) continue;

    // The container is included for context, flagged by c4Kind, so a component is never
    // drawn floating without the unit it belongs to.
    if (!includedContainers.has(containerId)) {
      includedContainers.add(containerId);
      nodes.push(
        c4Node(container, 'component', 'container', {
          technology: containerTechnology(container),
          derivation: 'Included for context: the container these components belong to.',
        }),
      );
    }

    nodes.push(
      c4Node(module, 'component', 'component', {
        technology: module.language,
        derivation:
          'A module the graph attributes to a container by a deploys relationship, so the repository places this code inside that runtime unit.',
      }),
    );

    const supporting = deploysEdges.get(`${moduleId}->${containerId}`) ?? [];
    edges.push(
      c4Edge(
        { source: containerId, target: moduleId },
        'contains',
        supporting[0]?.confidence ?? 'EXPLICIT',
        supporting[0]?.evidence ?? module.evidence,
        { supportingEdgeIds: supporting.map((edge) => edge.id) },
        'The graph records a deploys relationship from this module to the container.',
        'component',
      ),
    );
  }

  // Component-to-component dependencies, taken directly from graph edges.
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' && edge.kind !== 'calls') continue;
    if (!attributed.has(edge.from) || !attributed.has(edge.to)) continue;

    edges.push(
      c4Edge(
        { source: edge.from, target: edge.to },
        'depends_on',
        edge.confidence,
        edge.evidence,
        { supportingEdgeIds: [edge.id] },
        'A dependency edge between two modules that are both attributed to a container.',
        'component',
      ),
    );
  }

  const unattributed = graph.nodes.filter(
    (node) => node.kind === 'module' && !attributed.has(node.id) && !declaringFileIds.has(node.id),
  ).length;
  if (unattributed > 0) {
    omitted.push({
      reason:
        'modules excluded because the graph does not attribute them to a container; showing them here would imply a runtime boundary that is not evidenced',
      count: unattributed,
      examples: [],
    });
  }

  const unattributedContainers = graph.nodes.filter(
    (node) => node.kind === 'deployment_component' && !includedContainers.has(node.id),
  ).length;
  if (unattributedContainers > 0) {
    omitted.push({
      reason:
        'declared containers with no component; the repository does not state which code runs in them, so no module was assigned',
      count: unattributedContainers,
      examples: [],
    });
  }

  if (declaringFileIds.size > 0) {
    omitted.push({
      reason:
        'deployment files that declare a container are not components; a compose file describes the service rather than running inside it',
      count: declaringFileIds.size,
      examples: [],
    });
  }

  return finish({
    kind: 'c4-component',
    level: 'component',
    title: 'C4 — Components',
    scope:
      'Level 3. Components are modules attributed to a container by a deploys relationship. Dependencies between components come straight from graph import and call edges, carrying their confidence.',
    graph,
    nodes,
    edges,
    omitted,
  });
}

// ---------------------------------------------------------------------------
// Shared mapping helpers
// ---------------------------------------------------------------------------

function indexNodes(graph: SoftwareGraph): Map<string, GraphNode> {
  const index = new Map<string, GraphNode>();
  for (const node of graph.nodes) index.set(node.id, node);
  return index;
}

/**
 * Builds a module-id to container-id map from `deploys` edges.
 *
 * Two filters apply, both of them about not drawing something the repository does not
 * support:
 *
 *  - the source must be a module, so a `deploys` edge with an unexpected endpoint cannot
 *    attribute something that is not code;
 *  - the declaring deployment file is excluded. The compose file that declares a service
 *    does not run inside it, so treating it as a component would place the description of
 *    the container inside the container.
 *
 * Endpoint kinds are checked against the node index rather than with repeated searches,
 * because this runs once per level over a graph that can hold thousands of nodes.
 */
function attributeModulesToContainers(graph: SoftwareGraph): {
  attribution: Map<string, string>;
  /** Module ids of deployment files, counted separately so they are not double-reported. */
  declaringFileIds: Set<string>;
} {
  const byId = indexNodes(graph);
  const attribution = new Map<string, string>();
  const declaringFileIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'deploys') continue;
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || source.kind !== 'module' || !target) continue;
    if (source.path !== undefined && source.path === target.path) {
      declaringFileIds.add(edge.from);
      continue;
    }
    attribution.set(edge.from, edge.to);
  }

  return { attribution, declaringFileIds };
}

/** `moduleId->containerId` to the deploys edges asserting it. */
function indexDeploysEdges(graph: SoftwareGraph): Map<string, SoftwareGraph['edges'][number][]> {
  const index = new Map<string, SoftwareGraph['edges'][number][]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'deploys') continue;
    const key = `${edge.from}->${edge.to}`;
    const list = index.get(key);
    if (list) list.push(edge);
    else index.set(key, [edge]);
  }
  return index;
}

/**
 * Finds container pairs coupled by code, with every edge that justifies the coupling.
 *
 * Both directions are collected because the architectural relationship is "these two
 * containers are coupled", which is true regardless of which module imports which. The
 * direction recorded on the relationship is the one the supporting import edges point, so
 * the arrow means the same thing as the code does.
 */
function crossContainerDependencies(
  graph: SoftwareGraph,
  moduleToContainer: ReadonlyMap<string, string>,
): { from: string; to: string; supporting: SoftwareGraph['edges'] }[] {
  const pairs = new Map<string, { from: string; to: string; supporting: SoftwareGraph['edges'] }>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' && edge.kind !== 'calls') continue;
    const fromContainer = moduleToContainer.get(edge.from);
    const toContainer = moduleToContainer.get(edge.to);
    if (!fromContainer || !toContainer || fromContainer === toContainer) continue;

    const key = `${fromContainer}->${toContainer}`;
    const existing = pairs.get(key);
    if (existing) existing.supporting.push(edge);
    else pairs.set(key, { from: fromContainer, to: toContainer, supporting: [edge] });
  }

  // Sorted so the artifact is byte-identical across runs.
  return [...pairs.values()].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
}

/** Technology string for a declared component: the image if there is one, else the build. */
function containerTechnology(component: GraphNode): string | undefined {
  const image = component.attributes?.image;
  const build = component.attributes?.build;
  if (typeof image === 'string' && image.length > 0) return image;
  if (typeof build === 'string' && build.length > 0) return build;
  return undefined;
}

/**
 * Identifies an infrastructure image family.
 *
 * A non-match means *unknown*, and the element is then left out rather than guessed.
 */
export function detectInfrastructureFamily(node: GraphNode): { family: string } | null {
  const image = node.attributes?.image ?? node.attributes?.name;
  if (typeof image !== 'string' || image.length === 0) return null;
  for (const candidate of KNOWN_INFRASTRUCTURE_FAMILIES) {
    if (candidate.match.test(image)) return { family: candidate.family };
  }
  return null;
}

/** The weakest confidence in a set: a claim is only as strong as its weakest support. */
export function weakestConfidence(values: readonly Confidence[]): Confidence {
  if (values.length === 0) return 'UNKNOWN';
  if (values.includes('UNKNOWN')) return 'UNKNOWN';
  if (values.includes('WEEKLY_INFERRED')) return 'WEEKLY_INFERRED';
  if (values.includes('STRONGLY_INFERRED')) return 'STRONGLY_INFERRED';
  return 'EXPLICIT';
}

interface C4NodeOptions {
  technology?: string | undefined;
  derivation: string;
  confidence?: Confidence | undefined;
}

function c4Node(
  node: GraphNode,
  level: C4Level,
  c4Kind: C4ElementKind,
  options: C4NodeOptions,
): ArtifactNode {
  return {
    id: node.id,
    label: node.name,
    kind: c4Kind,
    confidence: options.confidence ?? node.confidence,
    graphNodeIds: [node.id],
    derivation: options.derivation,
    evidence: node.evidence,
    c4Level: level,
    c4Kind,
    ...(node.path ? { path: node.path } : {}),
    ...(options.technology ? { technology: options.technology } : {}),
  };
}

/** Support for a projected relationship: graph edges, graph nodes, or both. */
interface C4Support {
  supportingEdgeIds?: string[];
  supportingNodeIds?: string[];
}

function c4Edge(
  endpoints: { source: string; target: string },
  kind: EdgeKind,
  confidence: Confidence,
  evidence: EvidenceRef[],
  support: C4Support,
  derivation: string,
  level: C4Level,
): ArtifactEdge {
  return {
    id: `c4:${level}:${endpoints.source}|${kind}|${endpoints.target}`,
    kind,
    source: endpoints.source,
    target: endpoints.target,
    confidence,
    evidence,
    ...support,
    derivation,
    c4Level: level,
  };
}

interface FinishInput {
  kind: string;
  level: C4Level;
  title: string;
  scope: string;
  graph: SoftwareGraph;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  omitted: Artifact['omitted'];
  insufficient?: boolean;
}

function finish(input: FinishInput): Artifact {
  // Structural integrity gates. A relationship with no supporting graph fact would be an
  // invented dependency, and an edge whose endpoints were not emitted would be a dangling
  // reference. Both are dropped rather than rendered, and both are counted.
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const supported = input.edges.filter(hasGraphSupport);
  const edges = supported.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  const omitted = [...input.omitted];
  if (supported.length - edges.length > 0) {
    omitted.push({
      reason: 'relationships dropped because an endpoint was not part of this level',
      count: supported.length - edges.length,
      examples: [],
    });
  }
  if (input.edges.length - supported.length > 0) {
    omitted.push({
      reason: 'relationships dropped because no graph fact justified them',
      count: input.edges.length - supported.length,
      examples: [],
    });
  }

  // Deterministic order, so two runs over the same graph produce the same artifact bytes.
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodes = [...input.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    kind: input.kind,
    title: input.title,
    format: 'json',
    scope: input.scope,
    nodes,
    edges,
    omitted,
    insufficientEvidence: input.insufficient ?? (edges.length === 0 && nodes.length <= 1),
    stats: {
      graphNodes: input.graph.nodes.length,
      graphEdges: input.graph.edges.length,
      projectedNodes: nodes.length,
      projectedEdges: edges.length,
    },
  };
}

function emptyArtifact(
  level: C4Level,
  reason = 'No C4 projection is available for this level.',
): Artifact {
  return {
    kind: `c4-${level}`,
    title: `C4 — ${level}`,
    format: 'json',
    scope: reason,
    nodes: [],
    edges: [],
    omitted: [{ reason, count: 1, examples: [] }],
    insufficientEvidence: true,
    stats: { graphNodes: 0, graphEdges: 0, projectedNodes: 0, projectedEdges: 0 },
  };
}
