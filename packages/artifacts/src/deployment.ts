import { nodeId, type SoftwareGraph } from '@repoatlas/core';
import {
  OmissionLog,
  toArtifactEdge,
  toArtifactNode,
  type Artifact,
  type ArtifactEdge,
  type ArtifactNode,
  type ProjectionContext,
} from './contract.js';

/**
 * Deployment projection.
 *
 * What this view shows is exactly what a repository declares about running itself: compose
 * services, the base images named by Dockerfiles, which service depends on which, which network
 * each service joins, what configuration each service expects, and what the CI workflows say.
 *
 * What it deliberately does not show is anything about a running system. Nothing here has been
 * observed. A compose file states an *ordering*, not a healthy dependency; a `healthcheck:` block
 * states that a check was *configured*, not that it ever passed; an `EXPOSE` line states a port
 * the image declares, not a listener. Every element therefore carries the word it earned —
 * `declared`, `configured`, `referenced` — and never `running`, `healthy` or `reachable`, because
 * the repository contains nothing that would support those words.
 *
 * The distinction that is easy to lose is between a **declared** and a **verified** fact. Both look
 * identical in a diagram. This projection keeps them apart in the vocabulary, in the derivation on
 * every element, and in the omission log, which names what could not be established.
 */

export function buildDeployment(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();

  const components = graph.nodes.filter((node) => node.kind === 'deployment_component');
  const networks = graph.nodes.filter((node) => node.kind === 'network');
  const configuration = graph.nodes.filter((node) => node.kind === 'configuration');

  /** Declarations grouped by the component or module that made them. */
  const declarationsByOwner = groupDeclarations(graph);

  const artifactNodes: ArtifactNode[] = [];

  for (const component of components) {
    const declarations = declarationsByOwner.get(component.id) ?? [];
    const projected = toArtifactNode(component, serviceDetail(component, declarations));
    projected.derivation = componentDerivation(component);
    projected.technology = technologyOf(component);
    artifactNodes.push(projected);

    if (artifactNodes.length >= maxElements) {
      omission.record('projection element limit reached', component.id);
      break;
    }
  }

  for (const network of networks) {
    const projected = toArtifactNode(network, 'compose network');
    projected.derivation =
      'Declared as a network in a compose file. What this network permits between the services on it is not stated by the repository.';
    artifactNodes.push(projected);
  }

  const drawn = new Set(artifactNodes.map((node) => node.id));
  const artifactEdges: ArtifactEdge[] = [];
  let omittedSecretReferences = 0;

  for (const edge of graph.edges) {
    if (!isDeploymentEdge(edge)) continue;

    // Checked before the endpoint test. A secret node is deliberately not drawn here, so testing
    // endpoints first would file every credential reference under "missing endpoint" and a reader
    // would count credentials as relationships the view lost.
    if (edge.kind === 'references_secret') {
      omittedSecretReferences += 1;
      continue;
    }

    if (!drawn.has(edge.from) || !drawn.has(edge.to)) {
      // A dependency edge between a module and a package is a manifest statement about code
      // dependencies, not a statement about deployment topology. It belongs to the dependency
      // graph, so counting it here would report this repository's package.json as missing units.
      if (edge.kind === 'depends_on' && edge.attributes?.scope !== 'deployment') continue;
      omission.record(
        'deployment relationship whose endpoint is not a projected unit',
        `${edge.from} -> ${edge.to}`,
      );
      continue;
    }
    const projected = toArtifactEdge(edge);
    projected.label = deploymentLabel(edge);
    projected.derivation = deploymentDerivation(edge);
    projected.supportingEdgeIds = [edge.id];
    artifactEdges.push(projected);
  }

  if (omittedSecretReferences > 0) {
    omission.recordCount(
      'secret references, which the Security view reports by name. This view draws no secret node.',
      omittedSecretReferences,
      graph.edges
        .filter((edge) => edge.kind === 'references_secret')
        .slice(0, 3)
        .map((edge) => edge.to),
    );
  }

  // A compose file that declares a dependency between two services that never appear as
  // components is a statement about the file that the view cannot honour. Saying so beats
  // silently drawing a relationship to nothing.
  const declaredDependencies = graph.edges.filter((edge) => edge.kind === 'depends_on' && edge.attributes?.scope === 'deployment');
  const undrawn = declaredDependencies.filter((edge) => !drawn.has(edge.from) || !drawn.has(edge.to));
  omission.recordCount(
    'declared service dependencies whose service is not itself declared in the analysed files',
    undrawn.length,
    undrawn.slice(0, 3).map((edge) => `${edge.from} -> ${edge.to}`),
  );

  const configuredHealthchecks = configuration.filter((node) => node.attributes?.marker === 'compose.healthcheck');
  omission.record(
    'health checks are shown as configured. No check was executed and no result is known.',
    `${configuredHealthchecks.length} configured`,
  );

  // A workflow that declares a job is described by this view; one that declares nothing is not
// silently counted as fine. Matched on the configuration nodes rather than on module paths,
  // because the graph strips a leading dot from a path and a path comparison here would miss
  // every workflow file.
  const declaredWorkflows = new Set(
    configuration.filter((node) => String(node.attributes?.marker ?? '').startsWith('workflow.')).map((node) => node.path),
  );
  const silentWorkflows = workflowModules(graph).filter((moduleId) => !declaredWorkflows.has(graph.nodes.find((n) => n.id === moduleId)?.path ?? ''));
  omission.recordCount(
    'workflow files whose jobs and steps this analysis did not read',
    silentWorkflows.length,
    silentWorkflows.slice(0, 3),
  );

  return {
    kind: 'deployment',
    title: 'Deployment',
    format: 'json',
    scope:
      'Compose services, container base images, declared dependencies, network membership, configuration each service expects, and CI workflow steps. Every element is a declaration read from a repository file. Nothing here has been observed running, and no health, reachability or successful build is claimed.',
    nodes: artifactNodes,
    edges: artifactEdges,
    omitted: omission.list(),
    insufficientEvidence: components.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: artifactNodes.length,
      projectedEdges: artifactEdges.length,
    },
  };
}

function isDeploymentEdge(edge: { kind: string }): boolean {
  return edge.kind === 'depends_on' || edge.kind === 'joins_network' || edge.kind === 'references_secret';
}

function deploymentLabel(edge: { kind: string; attributes?: Record<string, unknown> }): string | undefined {
  switch (edge.kind) {
    case 'depends_on':
      return 'declares a dependency on';
    case 'joins_network':
      return 'joins network';
    case 'references_secret':
      return 'references secret (name only)';
    default:
      return undefined;
  }
}

/**
 * The rule that produced a deployment relationship, in one sentence.
 *
 * The point of this string is that a reader can tell, without reading this file, exactly how much
 * a given arrow is worth. Every one of these relationships is worth the same as far as the
 * repository is concerned: something in a file said it, and nothing confirmed it.
 */
function deploymentDerivation(edge: { kind: string; attributes?: Record<string, unknown> }): string {
  const declaredIn = typeof edge.attributes?.declaredIn === 'string' ? edge.attributes.declaredIn : 'a repository file';
  switch (edge.kind) {
    case 'depends_on':
      return `${declaredIn} lists this service under depends_on, stating a start ordering. It does not state that the dependency is reachable, started or healthy.`;
    case 'joins_network':
      return `${declaredIn} lists this service on this network. It does not state what the network permits between the services on it.`;
    case 'references_secret':
      return `${declaredIn} names this variable. The graph holds the name only; the value was never read.`;
    default:
      return 'Declared in a repository file.';
  }
}

/**
 * A one-line description of a service, from the declarations it carries.
 *
 * The wording is chosen so a reader cannot mistake it for a runtime observation: the image is
 * "declares image", a port is "declares container ports", a health check is "health check
 * configured". None of them has been seen to happen.
 */
function serviceDetail(
  component: { attributes?: Record<string, unknown> },
  declarations: { marker: string; detail: string }[],
): string {
  const parts: string[] = [];

  const image = typeof component.attributes?.image === 'string' ? component.attributes.image : '';
  if (image.length > 0) parts.push(`declares image ${image}`);

  const ports = typeof component.attributes?.publishedPorts === 'string' ? component.attributes.publishedPorts : '';
  if (ports.length > 0) parts.push(`declares container ports ${ports} (declared, not observed bound)`);

  const healthcheck = declarations.find((entry) => entry.marker === 'compose.healthcheck');
  if (healthcheck) parts.push('health check configured, result unknown');

  const restart = declarations.find((entry) => entry.marker === 'compose.restart_policy');
  if (restart) parts.push(`restart policy declared: ${restart.detail.replace(/^restart=/, '')}`);

  const environment = declarations.filter((entry) => entry.marker === 'compose.environment');
  if (environment.length > 0) parts.push(`expects ${environment.length} environment variable(s) by name`);

  return parts.join(' · ');
}

function componentDerivation(component: { attributes?: Record<string, unknown>; path?: string }): string {
  const role = typeof component.attributes?.declaredAs === 'string' ? component.attributes.declaredAs : 'service';
  if (role === 'base_image') {
    return `Declared as a base image in ${component.path ?? 'a Dockerfile'}. An image a Dockerfile builds FROM is a component of the image it builds, not a unit that runs on its own.`;
  }
  return `Declared as a compose service in ${component.path ?? 'a compose file'}. This is a declaration; no container from it has been observed.`;
}

function technologyOf(component: { attributes?: Record<string, unknown> }): string | undefined {
  const image = component.attributes?.image;
  if (typeof image !== 'string' || image.length === 0) return undefined;
  const base = image.includes(':') ? image.slice(0, image.lastIndexOf(':')) : image;
  return base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : base;
}

/**
 * Configuration nodes grouped by the unit whose file declares them.
 *
 * A `configures` edge names the declaring module. A compose marker additionally names the service
 * it belongs to, so that `environment: NODE_ENV` is grouped under the service rather than under
 * the compose file — otherwise every service in a stack would appear to share one service's
 * configuration.
 */
function groupDeclarations(graph: SoftwareGraph): Map<string, { marker: string; detail: string }[]> {
  const configurationById = new Map(graph.nodes.filter((node) => node.kind === 'configuration').map((node) => [node.id, node]));
  const componentIds = new Set(graph.nodes.filter((node) => node.kind === 'deployment_component').map((node) => node.id));
  const byOwner = new Map<string, { marker: string; detail: string }[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'configures') continue;
    const node = configurationById.get(edge.to);
    if (!node) continue;

    const marker = typeof node.attributes?.marker === 'string' ? node.attributes.marker : '';
    const detail = declarationDetail(node);

    // Prefer the service the marker names; fall back to the module whose file declares it.
    const service = typeof node.attributes?.service === 'string' ? nodeId('deployment_component', node.attributes.service) : '';
    const owner = componentIds.has(service) ? service : edge.from;
    const entry = byOwner.get(owner);
    if (entry) entry.push({ marker, detail });
    else byOwner.set(owner, [{ marker, detail }]);
  }
  return byOwner;
}



/** A human-readable summary of one declaration, drawn from safe attributes only. */
function declarationDetail(node: { attributes?: Record<string, unknown> }): string {
  const attributes = node.attributes ?? {};
  const parts: string[] = [];
  if (typeof attributes.variable === 'string') parts.push(`variable=${attributes.variable}`);
  if (typeof attributes.volume === 'string') parts.push(`volume=${attributes.volume}`);
  if (typeof attributes.restart === 'string') parts.push(`restart=${attributes.restart}`);
  if (typeof attributes.user === 'string') parts.push(`user=${attributes.user}`);
  if (typeof attributes.path === 'string') parts.push(`path=${attributes.path}`);
  if (typeof attributes.ports === 'string') parts.push(`ports=${attributes.ports}`);
  if (typeof attributes.publishedPorts === 'string' && attributes.publishedPorts.length > 0) {
    parts.push(`ports=${attributes.publishedPorts}`);
  }
  if (typeof attributes.job === 'string') parts.push(`job=${attributes.job}`);
  if (typeof attributes.step === 'string') parts.push(`step=${attributes.step}`);
  return parts.join(' ');
}

/** Workflow modules present in the graph. */
function workflowModules(graph: { nodes: readonly { id: string; path?: string }[] }): string[] {
  return graph.nodes.filter((node) => (node.path ?? '').startsWith('.github/workflows/')).map((node) => node.id);
}