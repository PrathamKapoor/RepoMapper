import { nodeId, toPosixPath } from './ids.js';
import type { EvidenceRef, EvidenceKind } from './types.js';
import type { AttributeValue, GraphEdge, GraphNode, Marker, ParsedFile, SoftwareGraph } from './types.js';

/**
 * Phase 6: deployment ↔ application reconciliation.
 *
 * Up to Phase 5 the deployment graph and the application graph described the same repository and
 * never met. A compose service said it was built from `./api`; the application graph knew what was
 * in `api/`. Neither could tell the other, which left the most useful question in the product
 * unanswerable: *what code does this service run?*
 *
 * This module answers it, and it answers it in exactly one direction. Reconciliation is
 * **extraction**, not projection: the relationships it produces are canonical graph facts, visible
 * to drift, to the consistency engine and to anyone reading the raw graph. A projection that
 * worked the mapping out for itself would make the answer unavailable everywhere else — which is
 * the Phase 4 lesson (D-063) arriving in a new place.
 *
 * ## What may be claimed
 *
 * A relationship is added only where a file states both sides:
 *
 *   module  → service      the module is inside the service's declared build context
 *   service → module       a CMD/ENTRYPOINT resolves to a file the graph holds
 *   module  → port         the application listens on the number the service publishes
 *   service → endpoint     a healthcheck names a path the graph knows as a route
 *
 * ## What may not be claimed
 *
 * Three specific refusals, each of which is what the naive implementation would do:
 *
 *  1. **A service name is not a module name.** `api` matching `packages/api` is a coincidence of
 *     naming, not evidence. Only a build context places code in a service.
 *  2. **`COPY . .` does not mean every file runs.** It means every file is in the image. A file no
 *     command references is recorded as *present*, never as *run* (D-081).
 *  3. **A published port is not a listener.** `app.listen(4300)` is a listener claim;
 *     `"4300:4300"` is a binding claim. They are reconciled when both exist and reported as
 *     unreconciled when only one does — never as a mismatch.
 *
 * Every mapping that could not be established is counted in `unresolved`, because "this service
 * has no application code" and "this analysis cannot tell which code runs in it" are different
 * answers and only one of them is a finding about the repository.
 */

/** A relationship reconciliation would add, with the evidence behind it. */
export interface ReconciledRelationship {
  from: string;
  to: string;
  kind: GraphEdge['kind'];
  confidence: GraphEdge['confidence'];
  evidence: EvidenceRef[];
  attributes: Record<string, AttributeValue>;
}

/** Something reconciliation looked for and did not establish. */
export interface UnresolvedMapping {
  /** Which rule looked, e.g. `service_to_module`. */
  rule: string;
  /** The graph entity the rule was looking for a target for. */
  subject: string;
  /** Why nothing was established, in words a reader can check. */
  reason: string;
}

export interface ReconciliationResult {
  relationships: ReconciledRelationship[];
  unresolved: UnresolvedMapping[];
  /** Counts by rule, so a projection can report coverage without re-deriving it. */
  counts: Record<string, number>;
}

/** The subset of `EvidenceStore` this module needs. Keeps the dependency one method wide. */
export interface ReconciliationEvidence {
  add(input: {
    kind: EvidenceKind;
    path: string;
    startLine: number;
    endLine?: number;
    symbol?: string;
    excerpt?: string;
    producer: string;
  }): EvidenceRef;
}

export interface ReconciliationInput {
  graph: SoftwareGraph;
  /** Parsed files, needed for Dockerfile commands and WORKDIR the graph stores only as attributes. */
  parsed: readonly ParsedFile[];
  evidence: ReconciliationEvidence;
  /** Module id by repository-relative path, for build-context containment. */
  moduleByPath: ReadonlyMap<string, string>;
}

export const RECONCILIATION_RULES = [
  'service_to_module',
  'service_to_entrypoint',
  'service_to_port',
  'service_to_endpoint',
] as const;

export type ReconciliationRule = (typeof RECONCILIATION_RULES)[number];

/**
 * Reconciles the deployment and application halves of the graph.
 *
 * Deterministic: both relationship and unresolved lists are sorted, so the same graph always
 * produces the same output and a snapshot digest cannot depend on traversal order.
 */
export function reconcileDeployment(input: ReconciliationInput): ReconciliationResult {
  const { graph, parsed, evidence, moduleByPath } = input;
  const relationships: ReconciledRelationship[] = [];
  const unresolved: UnresolvedMapping[] = [];

  const services = graph.nodes.filter(
    (node) => node.kind === 'deployment_component' && node.attributes?.declaredAs === 'service',
  );
  if (services.length === 0) {
    return { relationships: [], unresolved: [], counts: {} };
  }

  reconcileServiceToModules(services, moduleByPath, relationships, unresolved, graph.edges);
  const entrypoints = reconcileEntrypoints(services, graph, parsed, moduleByPath, evidence, relationships, unresolved);
  const ports = reconcilePorts(graph, services, relationships, unresolved);
  const endpoints = reconcileHealthchecks(services, graph, relationships, unresolved);

  // Sorted so the same graph yields the same bytes regardless of rule evaluation order.
  relationships.sort((a, b) => `${a.from}|${a.kind}|${a.to}`.localeCompare(`${b.from}|${b.kind}|${b.to}`));
  unresolved.sort((a, b) => `${a.rule}|${a.subject}`.localeCompare(`${b.rule}|${b.subject}`));

  return {
    relationships,
    unresolved,
    counts: {
      service_to_module: relationships.filter((r) => r.kind === 'deploys' && r.attributes.scope === 'application_to_service')
        .length,
      service_to_entrypoint: entrypoints,
      service_to_port: ports,
      service_to_endpoint: endpoints,
    },
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — a service runs the modules inside its build context
// ---------------------------------------------------------------------------

/**
 * `deploys`, from the declared build context.
 *
 * This is the same rule Phase 2 established for C4 (`attributeBuildContext`), reused rather than
 * reinvented: a build context says what is *sent to the builder*, not what the image runs, so the
 * edge is `STRONGLY_INFERRED` and carries that caveat on itself.
 *
 * A service with no build context is recorded as unresolved rather than skipped, because
 * `image: postgres:16` states a service exists without saying which code, if any, is inside it.
 */
function reconcileServiceToModules(
  services: readonly GraphNode[],
  moduleByPath: ReadonlyMap<string, string>,
  relationships: ReconciledRelationship[],
  unresolved: UnresolvedMapping[],
  graphEdges: readonly GraphEdge[],
): void {
  const modulePaths = [...moduleByPath.keys()].sort();

  for (const service of services) {
    const context = buildContextDirectory(service.path, service.attributes?.build);
    if (context === null) {
      unresolved.push({
        rule: 'service_to_module',
        subject: service.id,
        reason:
          'The service declares an image but no build context, so no analysed file is placed in it. The repository does not state which code, if any, this service runs.',
      });
      continue;
    }

    const inside = modulePaths.filter((path) => isInsideDirectory(path, context));
    if (inside.length === 0) {
      unresolved.push({
        rule: 'service_to_module',
        subject: service.id,
        reason: `Build context ${context} contains no analysed file this analysis holds. The context may be correct and the files may be in a language or a directory this analysis did not read.`,
      });
      continue;
    }

    // Only the innermost modules. Every module beneath a directory module would otherwise
    // produce an extra relationship, and a reader counting them would overcount the evidence.
    const leafPaths = inside.filter(
      (path) => !inside.some((other) => other !== path && other.startsWith(`${path}/`)),
    );

    for (const path of leafPaths) {
      const moduleId = moduleByPath.get(path);
      if (!moduleId) continue;

      // Skip if an EXPLICIT deploys edge already exists (added by addDeploymentComponent).
      // Adding a STRONGLY_INFERRED edge would merge and downgrade the explicit confidence.
      const explicitEdge = graphEdges.find(
        (edge) => edge.kind === 'deploys' && edge.from === moduleId && edge.to === service.id && edge.confidence === 'EXPLICIT',
      );
      if (explicitEdge) continue;

      relationships.push({
        from: moduleId,
        to: service.id,
        kind: 'deploys',
        confidence: 'STRONGLY_INFERRED',
        evidence: service.evidence,
        attributes: {
          derivedFrom: 'compose.build_context',
          scope: 'application_to_service',
          caveat:
            'The build context states what is sent to the builder, not what the Dockerfile copies and not what the image runs.',
        },
      });
    }
  }
}

/**
 * Resolves a service's build context to a repository-relative directory.
 *
 * Containment is enforced here rather than trusted. The context is untrusted repository text, and
 * only paths already inside the analysed repository are ever compared; a context resolving outside
 * it is ignored, because honouring `../..` would attribute code this analysis never read (D-034).
 */
export function buildContextDirectory(declaringPath: string | undefined, context: AttributeValue | undefined): string | null {
  if (typeof context !== 'string' || context.length === 0) return null;
  if (context.startsWith('/') || /^[A-Za-z]:[\\/]/.test(context)) return null;

  const base = declaringPath?.includes('/') ? declaringPath.slice(0, declaringPath.lastIndexOf('/')) : '';
  const segments: string[] = [];
  for (const segment of toPosixPath(base.length > 0 ? `${base}/${context}` : context).split('/')) {
    if (segment === '' || segment === '.') continue;
    // Refuses to climb out of the repository: `../..` resolves to nothing rather than to `/`.
    if (segment === '..') return null;
    segments.push(segment);
  }
  const directory = segments.join('/');
  return directory.length > 0 ? directory : '.';
}

function isInsideDirectory(path: string, directory: string): boolean {
  if (directory === '.') return true;
  return path === directory || path.startsWith(`${directory}/`);
}

// ---------------------------------------------------------------------------
// Rule 2 — a service runs an entrypoint its command names
// ---------------------------------------------------------------------------

/**
 * `runs`, from a CMD/ENTRYPOINT that resolves to a file the graph holds.
 *
 * Resolution is deliberately narrow, because this is the step where a guess would do the most
 * damage: `node dist/server.js` names a *path*, and the only thing that makes it a fact is finding
 * a module at that path. A command naming nothing the analysis holds stays unresolved, which is a
 * different claim from "this service runs no code".
 */
function reconcileEntrypoints(
  services: readonly GraphNode[],
  graph: SoftwareGraph,
  parsed: readonly ParsedFile[],
  moduleByPath: ReadonlyMap<string, string>,
  evidence: ReconciliationEvidence,
  relationships: ReconciledRelationship[],
  unresolved: UnresolvedMapping[],
): number {
  const commands = entrypointCommands(services, graph, parsed);
  let resolved = 0;

  for (const service of services) {
    const entry = commands.get(service.id);
    if (!entry) {
      unresolved.push({
        rule: 'service_to_entrypoint',
        subject: service.id,
        reason:
          'Neither the service nor the Dockerfile it builds from declares a CMD or ENTRYPOINT, so nothing states what process this service starts.',
      });
      continue;
    }

    const target = resolveCommandToModule(entry.command, entry.workdir, service, moduleByPath);
    if (target === null) {
      unresolved.push({
        rule: 'service_to_entrypoint',
        subject: service.id,
        reason: `The declared command \`${truncate(entry.command, 60)}\` names no file this analysis holds, so the entrypoint stays unresolved. The command may be correct and the file may be produced by a build step or live in a language this analysis did not read.`,
      });
      continue;
    }

    const moduleId = moduleByPath.get(target);
    if (!moduleId) continue;

    relationships.push({
      from: service.id,
      to: moduleId,
      // A command names a file. That it is the process the container starts is an inference, and
      // a modest one: an entrypoint script may exec something else entirely.
      kind: 'runs',
      confidence: 'WEEKLY_INFERRED',
      evidence: [
        evidence.add({
          kind: 'INFRASTRUCTURE_FILE',
          path: service.path ?? '.',
          startLine: service.startLine ?? 1,
          symbol: service.name,
          // The command text as declared. It is never executed.
          excerpt: `declared command: ${truncate(entry.command, 80)}`,
          producer: 'deployment-reconciliation',
        }),
      ],
      attributes: {
        derivedFrom: 'dockerfile.entrypoint_or_cmd',
        // Explicit that this is a declared command, not an observed process.
        declared: true,
        observed: false,
        caveat:
          'A declared command names a file. That this file is the process the container starts is inferred, and the command may exec something else.',
      },
    });
    resolved += 1;
  }
  return resolved;
}

/**
 * The command each service declares, and the WORKDIR it is resolved against.
 *
 * A compose `command:` *replaces* the image's CMD, so it wins outright. Reading an entrypoint from
 * a Dockerfile and attributing it to a service that overrides the command is how a deployment view
 * ends up describing a process that never starts (D-079).
 */
function entrypointCommands(
  services: readonly GraphNode[],
  graph: SoftwareGraph,
  parsed: readonly ParsedFile[],
): Map<string, { command: string; workdir: string | null }> {
  const commands = new Map<string, { command: string; workdir: string | null }>();

  for (const node of graph.nodes) {
    if (node.kind !== 'configuration' || node.attributes?.marker !== 'compose.command') continue;
    const service = String(node.attributes.service ?? '');
    const value = String(node.attributes.value ?? '');
    if (service.length === 0 || value.length === 0) continue;
    commands.set(nodeId('deployment_component', service), { command: value, workdir: null });
  }

  const dockerfiles = parsed.filter((file) => isDockerfile(file.path));
  for (const service of services) {
    if (commands.has(service.id)) continue;
    const context = buildContextDirectory(service.path, service.attributes?.build);
    const dockerfilePath = dockerfilePathFor(context, service.attributes?.buildFile);
    if (dockerfilePath === null) continue;

    const dockerfile = dockerfiles.find((file) => file.path === dockerfilePath);
    if (!dockerfile) continue;

    const workdirMarker = lastOf(dockerfile.markers, 'docker.workdir');
    const workdir = typeof workdirMarker?.attributes.path === 'string' ? workdirMarker.attributes.path : null;

    const cmd = lastOf(dockerfile.markers, 'docker.cmd');
    const entrypoint = lastOf(dockerfile.markers, 'docker.entrypoint');
    const value = cmd?.attributes.value ?? entrypoint?.attributes.value;
    if (typeof value !== 'string' || value.length === 0) continue;
    commands.set(service.id, { command: value, workdir });
  }

  return commands;
}

function isDockerfile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === 'Dockerfile' || base.startsWith('Dockerfile.');
}

/**
 * The Dockerfile a build uses, resolved against its context.
 *
 * Compose's default is `<context>/Dockerfile`; an explicit `dockerfile:` is ordinary in a
 * monorepo. Returns `null` when the result would escape the repository, so a build cannot name a
 * Dockerfile outside the analysed tree.
 */
function dockerfilePathFor(context: string | null, buildFile: AttributeValue | undefined): string | null {
  if (context === null) return null;
  const explicit = typeof buildFile === 'string' && buildFile.length > 0 ? buildFile : 'Dockerfile';
  if (explicit.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicit)) return null;

  const joined = context === '.' ? explicit : `${context}/${explicit}`;
  const segments: string[] = [];
  for (const segment of toPosixPath(joined).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

function lastOf(markers: readonly Marker[], name: string): Marker | undefined {
  let found: Marker | undefined;
  for (const marker of markers) if (marker.name === name) found = marker;
  return found;
}

/**
 * Resolves a declared command to a repository-relative module path.
 *
 * Only arguments that look like file paths are considered, and each is tried against the paths the
 * graph actually holds. `WORKDIR` is applied first because that is where the command runs inside
 * the image, then the build context, then the repository root — the three roots a real image can
 * plausibly resolve from.
 *
 * A bare `node` with no argument resolves to nothing. The file it would start depends on
 * `package.json` fields this rule does not read, and guessing there would be inventing the single
 * fact this rule exists to establish.
 */
function resolveCommandToModule(
  command: string,
  workdir: string | null,
  service: GraphNode,
  moduleByPath: ReadonlyMap<string, string>,
): string | null {
  const context = buildContextDirectory(service.path, service.attributes?.build) ?? '.';
  const roots = [
    ...(workdir ? [normaliseRoot(workdir, context)] : []),
    context,
    '.',
  ].filter((root, index, all) => root !== null && all.indexOf(root) === index) as string[];

  const tokens = command
    .replace(/^\[|\]$/g, '')
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter((token) => token.length > 0);

  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) continue;
    // Shell syntax and variable references are not paths.
    if (/[|&;<>$(){}[\]]/.test(token)) continue;
    if (!/^[./\w@/-]+\.\w+$/.test(token)) continue;

    for (const root of roots) {
      for (const candidate of candidatePaths(root, token)) {
        if (moduleByPath.has(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** A `WORKDIR` is absolute inside the image, so it is resolved against the build context. */
function normaliseRoot(workdir: string, context: string): string | null {
  const trimmed = workdir.replace(/^\/+/, '');
  if (trimmed.length === 0) return context;
  const segments: string[] = [];
  for (const segment of `${context}/${trimmed}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

function candidatePaths(root: string, token: string): string[] {
  const absolute = token.startsWith('/');
  const joined = absolute ? token.slice(1) : root === '.' ? token : `${root}/${token}`;
  const segments: string[] = [];
  for (const segment of toPosixPath(joined).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return [];
    segments.push(segment);
  }
  if (segments.length === 0) return [];
  const base = segments.join('/');
  // A command names a file with its extension; a module node is keyed without one.
  const candidates = [base, base.replace(/\.[cm]?[jt]sx?$/, ''), base.replace(/\.py$/, '')];
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// Rule 3 — a published port and an application listener
// ---------------------------------------------------------------------------

/** Ports the application graph says it listens on, read from `listen()` call sites. */
function collectListeners(graph: SoftwareGraph): Map<string, { moduleId: string }[]> {
  const listeners = new Map<string, { moduleId: string }[]>();
  const owners = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'configures') owners.set(edge.to, edge.from);
  }

  for (const node of graph.nodes) {
    if (node.kind !== 'configuration') continue;
    const raw = typeof node.attributes?.value === 'string' ? node.attributes.value : '';
    const port = portFromListenerCall(raw);
    if (port === null) continue;
    const owner = owners.get(node.id);
    if (!owner) continue;
    const list = listeners.get(port);
    if (list) list.push({ moduleId: owner });
    else listeners.set(port, [{ moduleId: owner }]);
  }
  return listeners;
}

/**
 * The port a `listen()` call binds.
 *
 * Reads the positional form and the options-object form. A `listen(port)` where `port` is a
 * variable cannot be resolved without data flow this module does not do, so it returns `null`
 * rather than a guess — the caller records it as unreconciled.
 */
function portFromListenerCall(value: string): string | null {
  const positional = /listen\s*\(\s*(\d{2,5})\s*[,)]/.exec(value);
  if (positional?.[1]) return positional[1];
  const options = /listen\s*\(\s*\{[^}]*port\s*:\s*(\d{2,5})/.exec(value);
  return options?.[1] ?? null;
}

/**
 * Reconciles a declared port against an application listener.
 *
 * `STRONGLY_INFERRED`, never `EXPLICIT`: two facts agreeing is not one fact stating the other. A
 * compose file publishing 3000 and a `listen(3000)` call in code are independent statements that
 * happen to agree, and a reader is entitled to know the mapping was assembled by matching numbers.
 *
 * Where only one side exists, that is recorded as unresolved rather than as a mismatch. A service
 * publishing a port nothing in the analysed code listens on may be proxying to something outside
 * the repository, and calling that broken would be a claim this analysis cannot support.
 */
function reconcilePorts(
  graph: SoftwareGraph,
  services: readonly GraphNode[],
  relationships: ReconciledRelationship[],
  unresolved: UnresolvedMapping[],
): number {
  const listeners = collectListeners(graph);
  const serviceIds = new Set(services.map((service) => service.id));
  let reconciled = 0;

  // The owning service is whichever service published the port; recovered from the port id's
  // `<service>:<containerPort>` shape rather than from an edge, so this rule does not depend on
  // `exposes` having been built.
  for (const port of graph.nodes) {
    if (port.kind !== 'port') continue;
    const containerPort = String(port.attributes?.containerPort ?? '');
    if (containerPort.length === 0) continue;

    const declaredService = String(port.qualifiedName ?? '').split(':')[0] ?? '';
    const ownerId = nodeId('deployment_component', declaredService);
    if (!serviceIds.has(ownerId)) {
      unresolved.push({
        rule: 'service_to_port',
        subject: port.id,
        reason: `Port ${containerPort} is published but the service that publishes it is not declared in the analysed files.`,
      });
      continue;
    }

    const matches = listeners.get(containerPort) ?? [];
    if (matches.length === 0) {
      unresolved.push({
        rule: 'service_to_port',
        subject: port.id,
        reason: `No analysed code is observed listening on container port ${containerPort}. The service may be fronting something outside this repository, or the listener may be in a language or a file this analysis did not read. This is not reported as a broken port.`,
      });
      continue;
    }

    for (const match of matches) {
      relationships.push({
        from: match.moduleId,
        to: port.id,
        kind: 'listens_on',
        // Two independent statements that agree. Assembled by matching numbers, which is why it
        // is an inference and says so on the edge.
        confidence: 'STRONGLY_INFERRED',
        evidence: port.evidence,
        attributes: {
          derivedFrom: 'container_port_equals_listen_argument',
          scope: 'application_to_deployment',
          observed: false,
          caveat:
            'The application states it listens on this number and the deployment states it publishes it. Nothing observed a socket; the mapping is assembled by matching the two numbers.',
        },
      });
      reconciled += 1;
    }
  }
  return reconciled;
}

// ---------------------------------------------------------------------------
// Rule 4 — a healthcheck that names an endpoint
// ---------------------------------------------------------------------------

/**
 * Reconciles a declared healthcheck against the routes the graph holds.
 *
 * This is the check that earns the word *consistent* without earning *passing*. A healthcheck
 * naming `/api/health` and an endpoint at `/api/health` agree about a path. Nothing about that
 * agreement says the check runs, that the endpoint answers, or that the container is healthy —
 * all three need a controlled observation (D-084).
 */
function reconcileHealthchecks(
  services: readonly GraphNode[],
  graph: SoftwareGraph,
  relationships: ReconciledRelationship[],
  unresolved: UnresolvedMapping[],
): number {
  const serviceIds = new Set(services.map((service) => service.id));
  const routes = graph.nodes.filter((node) => node.kind === 'api_endpoint');
  let reconciled = 0;

  for (const node of graph.nodes) {
    if (node.kind !== 'configuration') continue;
    if (node.attributes?.marker !== 'compose.healthcheck') continue;

    const service = String(node.attributes.service ?? '');
    const endpoint = typeof node.attributes.endpoint === 'string' ? node.attributes.endpoint : '';
    const from = nodeId('deployment_component', service);
    if (!serviceIds.has(from)) continue;

    if (endpoint.length === 0) {
      unresolved.push({
        rule: 'service_to_endpoint',
        subject: from,
        reason:
          'The healthcheck is a command with no URL, so it names no endpoint this analysis could match. Whether it succeeds is a runtime fact either way.',
      });
      continue;
    }

    // A declared path matched against declared routes. Matching is exact on the path, because
    // `/health` and `/api/health` are different endpoints and treating them as the same would
    // invent a consistency the repository does not state.
    const target = routes.find((route) => String(route.attributes?.path ?? '') === endpoint);
    if (!target) {
      unresolved.push({
        rule: 'service_to_endpoint',
        subject: from,
        reason: `The healthcheck names ${endpoint}, which no route in the analysed code declares. The check may call a path served by a gateway, a dependency, or code this analysis did not read. This is not reported as a broken check.`,
      });
      continue;
    }

    relationships.push({
      from,
      to: target.id,
      kind: 'exposes',
      // The check names a path and a route declares it. That the check passes against that route
      // is not stated by either, which is what keeps this from becoming a health claim.
      confidence: 'EXPLICIT',
      evidence: [...node.evidence, ...target.evidence],
      attributes: {
        derivedFrom: 'compose.healthcheck_target',
        scope: 'deployment_to_application',
        // Names the agreement. Says nothing about the outcome.
        declared: true,
        observed: false,
        outcome: 'unknown',
        caveat:
          'The healthcheck names this path and the application declares it. Whether the check runs, and whether it passes, requires a controlled observation.',
      },
    });
    reconciled += 1;
  }
  return reconciled;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}