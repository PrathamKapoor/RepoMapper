import type { SoftwareGraph } from '@repoatlas/core';
import { OmissionLog, type Artifact, type ArtifactNode, type ProjectionContext } from './contract.js';

/**
 * Security projection.
 *
 * This view reports what a repository *states about itself* in security-relevant terms: which
 * variables it expects to be configured with credential-like names, where each is referenced from,
 * what base image a container is built from, and which CI workflow steps name deployment work.
 *
 * It is deliberately incapable of the words `vulnerable`, `insecure`, `secure` or `safe`. A
 * repository does not contain the evidence any of those require. There is no exploit here, no
 * scan, no policy engine and no live system. What exists is a list of declarations and, for each,
 * whether any observed check covers it — which is a fact about *this analysis*, not a fact about
 * the repository's security posture.
 *
 * The distinction the view is built around:
 *
 *   referenced   a file names this variable or references this image
 *   protected by an observed check   this analysis found a check that examines it
 *   not observed   this analysis looked and found no such check
 *   unknown      the repository says nothing either way
 *
 * `not observed` is not a finding. It means the static reader did not see a check, which is a
 * statement about the reader. Reporting it as anything stronger is the single failure mode this
 * projection exists to avoid, so every absence carries its reason in `whatWouldResolve`.
 */

export interface SecretExpectation {
  name: string;
  referencedBy: { from: string; path?: string; line?: number }[];
  /** True when an observed check in this analysis examines this name. */
  coveredByObservedCheck: boolean;
}

export interface SecurityReport {
  secrets: SecretExpectation[];
  baseImages: { name: string; pinned: boolean; declaredIn?: string }[];
  ciWorkflows: { path: string; jobs: number; steps: number; deploymentNamed: number }[];
  checks: { name: string; path: string; kind: string }[];
}

export function buildSecurity(context: ProjectionContext): Artifact {
  const { graph, maxElements } = context;
  const omission = new OmissionLog();
  const report = analyseSecurity(graph, maxElements, omission);

  const artifactNodes: ArtifactNode[] = [];

  for (const secret of report.secrets) {
    if (artifactNodes.length >= maxElements) {
      omission.record('projection element limit reached', secret.name);
      break;
    }
    const first = secret.referencedBy[0];
    artifactNodes.push({
      id: `secret:${secret.name}`,
      label: secret.name,
      kind: 'secret_reference',
      confidence: 'EXPLICIT',
      detail: `referenced from ${secret.referencedBy.length} place(s) · ${protectionStatus(secret)}`,
      ...(first?.path ? { path: first.path } : {}),
      evidence: [],
      graphNodeIds: [nodeIdForSecret(secret.name)],
      derivation: `A repository file names \`${secret.name}\`. The value was never read, and the graph holds the name only.${
        secret.coveredByObservedCheck ? ' An observed check in this analysis examines it.' : ''
      }`,
    });
  }

  for (const image of report.baseImages) {
    if (artifactNodes.length >= maxElements) break;
    artifactNodes.push({
      id: `base_image:${image.name}`,
      label: image.name,
      kind: 'base_image',
      confidence: 'EXPLICIT',
      detail: image.pinned ? 'tag pinned' : 'tag not pinned to a version',
      ...(image.declaredIn ? { path: image.declaredIn } : {}),
      evidence: [],
      derivation: `Declared in ${image.declaredIn ?? 'a Dockerfile'}. Whether this image contains a known weakness is not determined: no image was pulled and no advisory database is consulted.`,
    });
  }

  for (const workflow of report.ciWorkflows) {
    if (artifactNodes.length >= maxElements) break;
    artifactNodes.push({
      id: `workflow:${workflow.path}`,
      label: workflow.path,
      kind: 'ci_workflow',
      confidence: 'EXPLICIT',
      detail: `${workflow.jobs} job(s), ${workflow.steps} step(s), ${workflow.deploymentNamed} naming deployment`,
      path: workflow.path,
      evidence: [],
      derivation: 'Read as text. No step was executed, so nothing is known about whether this workflow succeeds.',
    });
  }

  if (report.secrets.length === 0) {
    omission.record(
      'no credential-like variable name was referenced in the analysed files. This means no such reference was found, not that the repository needs no secrets.',
      graph.nodes.length > 0 ? String(graph.nodes.length) : '',
    );
  }

  const uncovered = report.secrets.filter((secret) => !secret.coveredByObservedCheck);
  omission.recordCount(
    'secret references with no observed check covering them. This is a limit of static reading, not a finding about the repository.',
    uncovered.length,
    uncovered.slice(0, 3).map((secret) => secret.name),
  );

  const unpinned = report.baseImages.filter((image) => !image.pinned);
  omission.recordCount(
    'base images declared without a version tag. Whether an update exists is unknown because no registry was queried.',
    unpinned.length,
    unpinned.slice(0, 3).map((image) => image.name),
  );

  omission.record(
    'this view reads declarations only. No vulnerability scan, no image inspection, no policy evaluation and no runtime observation was performed.',
    '',
  );

  return {
    kind: 'security',
    title: 'Security',
    format: 'json',
    scope:
      'Credential-like variable names a repository expects, the base images it declares, and its CI workflow steps. Every entry is a reference read from a file. The view does not assess whether anything is secure or insecure: that judgement needs evidence this product does not collect.',
    nodes: artifactNodes,
    edges: [],
    omitted: omission.list(),
    insufficientEvidence: report.secrets.length === 0 && report.baseImages.length === 0,
    stats: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      projectedNodes: artifactNodes.length,
      projectedEdges: 0,
    },
  };
}

/** The wording for whether an observed check covers a reference. Never a risk verdict. */
function protectionStatus(secret: SecretExpectation): string {
  return secret.coveredByObservedCheck
    ? 'protected by an observed check in this analysis'
    : 'no check observed; static reading cannot tell whether one exists';
}

function nodeIdForSecret(name: string): string {
  return `secret:${name.replace(/[^A-Za-z0-9_.-]+/g, '-').toLowerCase()}`;
}

export function analyseSecurity(graph: SoftwareGraph, maxElements: number, omission: OmissionLog): SecurityReport {
  const secrets: SecretExpectation[] = [];
  const byName = new Map<string, SecretExpectation>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'references_secret') continue;
    const name = graph.nodes.find((node) => node.id === edge.to)?.name ?? secretNameFromId(edge.to);
    const source = graph.nodes.find((node) => node.id === edge.from);
    const existing = byName.get(name);
    if (existing) {
      existing.referencedBy.push({ from: edge.from, ...(source?.path ? { path: source.path } : {}) });
      continue;
    }
    const entry: SecretExpectation = {
      name,
      referencedBy: [{ from: edge.from, ...(source?.path ? { path: source.path } : {}) }],
      coveredByObservedCheck: false,
    };
    if (secrets.length >= maxElements) {
      omission.record('projection element limit reached', name);
      continue;
    }
    byName.set(name, entry);
    secrets.push(entry);
  }

  // Mark a reference as covered only when this analysis actually observed a check that examines
  // it. Nothing is "protected" by assumption, and nothing is left unprotected by assumption
  // either — the difference is reported per reference.
  for (const secret of secrets) {
    secret.coveredByObservedCheck = observedCheckCovers(graph, secret.name);
  }

  // `declaredAs` is the attribute the builder records; `role` is kept for older snapshots so a
  // stored Phase 4 graph still projects rather than silently losing its base images.
  const baseImages = graph.nodes
    .filter(
      (node) =>
        node.kind === 'deployment_component' &&
        (node.attributes?.declaredAs === 'base_image' || node.attributes?.role === 'base_image'),
    )
    .slice(0, maxElements)
    .map((node) => ({
      name: node.name,
      pinned: isPinned(node.name),
      ...(node.path ? { declaredIn: node.path } : {}),
    }));

  const workflows = workflowSummaries(graph, maxElements);

  const checks = graph.nodes
    .filter((node) => node.kind === 'test')
    .slice(0, maxElements)
    .map((node) => ({ name: node.name, path: node.path ?? '', kind: 'test' }));

  return { secrets, baseImages, ciWorkflows: workflows, checks };
}

/**
 * Whether an observed check names the same identifier.
 *
 * Deliberately narrow: it matches the identifier in the *text of an observed test*, which is the
 * only evidence of a check this analysis holds. No rule engine is applied and no policy is
 * assumed.
 */
function observedCheckCovers(graph: SoftwareGraph, secretName: string): boolean {
  return graph.nodes
    .filter((node) => node.kind === 'test')
    .some((test) => test.name.includes(secretName) || (test.qualifiedName ?? '').includes(secretName));
}

function isPinned(image: string): boolean {
  // A digest (`@sha256:…`) or an explicit version tag is pinned; a bare `latest` is not.
  if (image.includes('@sha256:')) return true;
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
  return tag.length > 0 && tag !== 'latest';
}

function secretNameFromId(id: string): string {
  return id.slice('secret:'.length);
}

function workflowSummaries(graph: SoftwareGraph, maxElements: number): SecurityReport['ciWorkflows'] {
  const paths = new Set<string>();
  for (const node of graph.nodes) {
    if ((node.path ?? '').startsWith('.github/workflows/')) paths.add(node.path ?? '');
  }

  const summaries: SecurityReport['ciWorkflows'] = [];
  for (const path of [...paths].sort()) {
    if (summaries.length >= maxElements) break;
    const jobs = graph.nodes.filter(
      (node) => node.kind === 'configuration' && node.path === path && node.attributes?.marker === 'workflow.job',
    );
    const steps = graph.nodes.filter(
      (node) => node.kind === 'configuration' && node.path === path && node.attributes?.marker === 'workflow.step',
    );
    const deployment = steps.filter((node) => node.attributes?.namesDeployment === 'true');
    summaries.push({ path, jobs: jobs.length, steps: steps.length, deploymentNamed: deployment.length });
  }
  return summaries;
}