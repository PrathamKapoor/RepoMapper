/**
 * API client.
 *
 * The UI reads only from these functions, so the response shapes the UI depends on are
 * declared in exactly one place. Every call surfaces the server's error code rather
 * than a generic failure, because the most common user error is a path outside the
 * allow-list and that specific message is actionable.
 */

export interface ApiErrorPayload {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the RepoAtlas API: ${(error as Error).message}`);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'API returned a non-JSON response');
    }
  }

  if (!response.ok) {
    const payloadError = payload as ApiErrorPayload | null;
    throw new ApiError(
      response.status,
      payloadError?.error?.code ?? 'HTTP_ERROR',
      payloadError?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Types mirroring the server contract
// ---------------------------------------------------------------------------

export type Confidence = 'EXPLICIT' | 'STRONGLY_INFERRED' | 'WEEKLY_INFERRED' | 'UNKNOWN';
export type EvidenceStatus = 'EXPLICIT' | 'PARTIALLY_EVIDENCED' | 'INFERRED' | 'NOT_FOUND';

export interface AnalysisSummary {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  fileCount: number;
  analyzableFileCount: number;
  skippedFileCount: number;
  parserCount: number;
  languageCounts: Record<string, number>;
  explicitNodeShare: number;
  durationMs: number;
  truncated: boolean;
}

export interface AnalysisListEntry {
  id: string;
  repositoryName: string;
  repositoryPath: string;
  label: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  durationMs: number | null;
  headCommit: string | null;
  branch: string | null;
  summary: AnalysisSummary | null;
  error: { code: string; message: string } | null;
}

export interface Evidence {
  id: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  excerpt?: string;
  producer: string;
}

export interface EvidenceRef {
  evidenceId: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  producer: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  language?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  attributes?: Record<string, string | number | boolean | null>;
  evidence: EvidenceRef[];
  confidence: Confidence;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  label?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface Gap {
  id: string;
  title: string;
  status: EvidenceStatus;
  whatWouldResolve: string;
  observations: string[];
  checked: string[];
  relatedNodeIds: string[];
  severity: 'info' | 'warning';
}

export interface GapReport {
  gaps: Gap[];
  counts: Record<EvidenceStatus, number>;
  notFoundShare: number;
}

export interface ArtifactNode {
  id: string;
  label: string;
  kind: string;
  confidence: Confidence;
  detail?: string;
  path?: string;
  evidence: EvidenceRef[];
  /** C4 abstraction level. Present only on C4 elements. */
  c4Level?: C4Level;
  /** C4 element kind. Present only on C4 elements. */
  c4Kind?: C4ElementKind;
  /** Technology named by repository evidence, e.g. a declared image. */
  technology?: string;
  /** Graph nodes this element was derived from. Never empty on a C4 element. */
  graphNodeIds?: string[];
  /** The explicit rule that produced this element, in words. */
  derivation?: string;
}

export type C4Level = 'context' | 'container' | 'component';

export type C4ElementKind = 'software_system' | 'container' | 'component' | 'external_system' | 'person';

export interface ArtifactEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
  label?: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
  c4Level?: C4Level;
  /** Graph edges that justify this relationship. */
  supportingEdgeIds?: string[];
  /** Graph nodes that justify this relationship where no edge does. */
  supportingNodeIds?: string[];
  derivation?: string;
}

export interface Artifact {
  kind: string;
  title: string;
  format: string;
  scope: string;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  omitted: { reason: string; count: number; examples: string[] }[];
  insufficientEvidence: boolean;
  stats: { graphNodes: number; graphEdges: number; projectedNodes: number; projectedEdges: number };
  mermaid: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  explicitShare: { nodes: number; edges: number };
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AnalysisDetail {
  analysis: AnalysisListEntry;
  stats: GraphStats;
  gaps: GapReport;
  artifacts: {
    kind: string;
    title: string;
    scope: string;
    insufficientEvidence: boolean;
    stats: Artifact['stats'];
    omitted: Artifact['omitted'];
    nodeCount: number;
    edgeCount: number;
  }[];
}

export interface GraphResponse {
  analysisId: string;
  schemaVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  totals: { nodes: number; edges: number; matching: number };
}

export interface NodeDetail {
  node: GraphNode;
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
  related: GraphNode[];
  evidence: Evidence[];
}

export interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
  environment: string;
  pathAllowListEnforced: boolean;
  allowedRootCount: number;
  analysesStored: number;
  analysisConcurrency: number;
  maxUploadBytes: number;
  gitHistoryEnabled: boolean;
  node: string;
}

export interface MetaResponse {
  nodeKinds: string[];
  edgeKinds: string[];
  confidenceLevels: string[];
  artifacts: { kind: string; title: string }[];
  useCaseStatuses: string[];
}

// ---------------------------------------------------------------------------
// Requirements, use cases, consistency, traceability, lineage
// ---------------------------------------------------------------------------

export type RequirementStatus = 'OBSERVED' | 'DERIVED' | 'PARTIAL' | 'UNKNOWN' | 'UNSUPPORTED';

export interface Requirement {
  id: string;
  category: string;
  statement: string;
  status: RequirementStatus;
  confidence: Confidence;
  /** `declared` means a document states it; `derived` means a fixed rule read it from the code. */
  origin: 'declared' | 'derived';
  derivation: string;
  evidence: EvidenceRef[];
  supportedByNodeIds: string[];
  supportedByEdgeIds: string[];
  declaredInPath?: string;
}

export interface RequirementModel {
  requirements: Requirement[];
  counts: Record<RequirementStatus, number>;
  documentsSearched: number;
  summary: {
    declared: number;
    derived: number;
    notRecovered: { reason: string; count: number }[];
  };
}

export type UseCaseStatus = 'OBSERVED' | 'PARTIAL' | 'UNKNOWN';

export interface UseCaseStep {
  nodeId: string;
  label: string;
  kind: string;
  viaEdgeIds: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
}

export interface UseCase {
  id: string;
  title: string;
  entryKind: string;
  entryNodeId: string;
  systemNodeId: string;
  actor: { nodeId: string; name: string; derivation: string; evidence: EvidenceRef[] } | null;
  trigger: string;
  preconditions: string[];
  steps: UseCaseStep[];
  postconditions: string[];
  status: UseCaseStatus;
  confidence: Confidence;
  derivation: string;
  evidence: EvidenceRef[];
  supportsRequirementIds: string[];
  /** What the repository does not evidence about this use case. */
  missing: string[];
}

export interface UseCaseModel {
  useCases: UseCase[];
  counts: Record<UseCaseStatus, number>;
  actors: { nodeId: string; name: string; derivation: string; evidence: EvidenceRef[] }[];
  entryPoints: Record<string, number>;
  notRecovered: { reason: string; count: number }[];
}

export type ConsistencyClass =
  | 'CONTRADICTION'
  | 'MISSING_EVIDENCE'
  | 'PARTIAL_EVIDENCE'
  | 'UNSUPPORTED_INFERENCE'
  | 'CONSISTENT';

export interface ConsistencyFinding {
  id: string;
  rule: string;
  class: ConsistencyClass;
  severity: 'info' | 'warning';
  title: string;
  detail: string;
  artifacts: string[];
  nodeIds: string[];
  edgeIds: string[];
  evidenceExpected: string;
  evidenceFound: string;
  derivation: string;
  confidence: Confidence;
}

export interface ConsistencyReport {
  findings: ConsistencyFinding[];
  counts: Record<ConsistencyClass, number>;
  compared: string[];
  summary: string;
}

export interface TraceLink {
  role: 'requirement' | 'use_case' | 'implementation' | 'test';
  id: string;
  label: string;
  kind: string;
  edgeIds: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  note?: string;
}

export interface Traceability {
  subject: { id: string; name: string; kind: string };
  links: TraceLink[];
  breaks: { kind: string; reason: string }[];
  complete: boolean;
  summary: string;
}

export interface TraceabilityIndex {
  rows: {
    subjectId: string;
    title: string;
    entryKind: string;
    requirements: number;
    useCases: number;
    implementation: number;
    tests: number;
    complete: boolean;
  }[];
  totals: { subjects: number; complete: number; incomplete: number };
}

export interface LineageHop {
  edgeId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  relation: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
}

export interface Lineage {
  subjectNodeId: string;
  subjectName: string;
  upstream: LineageHop[];
  downstream: LineageHop[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Snapshots and drift
// ---------------------------------------------------------------------------

/**
 * Identity of one repository state.
 *
 * `snapshotId` and `graphDigest` are content-derived: two analyses of unchanged content
 * share them, which is what makes "nothing changed" decidable. Provenance fields are
 * recorded but deliberately excluded from the identity.
 */
export interface SnapshotReference {
  snapshotId: string;
  analysisId: string;
  repositoryName: string;
  repositoryPath: string;
  sourceRevision: string | null;
  branch: string | null;
  createdAt: string;
  graphDigest: string;
  extractorVersion: string;
  graphSchemaVersion: number;
  truncated: boolean;
}

export interface SnapshotResponse {
  snapshot: SnapshotReference;
  stats: GraphStats;
}

export type DriftCategory =
  | 'NODE_ADDED'
  | 'NODE_REMOVED'
  | 'NODE_MODIFIED'
  | 'NODE_RENAMED'
  | 'EDGE_ADDED'
  | 'EDGE_REMOVED'
  | 'EDGE_MODIFIED'
  | 'EVIDENCE_ADDED'
  | 'EVIDENCE_REMOVED'
  | 'EVIDENCE_CHANGED'
  | 'CONFIDENCE_CHANGED';

/** How strongly the drift claim itself is supported, independent of the entity's confidence. */
export type DriftClaimConfidence = 'EXPLICIT' | 'STRONGLY_INFERRED' | 'INDETERMINATE';

export interface DriftChange {
  category: DriftCategory;
  entityKind: 'node' | 'edge' | 'evidence';
  entityId: string;
  previousEntityId?: string;
  label: string;
  changedFields?: string[];
  nodeKind?: string;
  edgeKind?: string;
  evidenceBefore: EvidenceRef[];
  evidenceAfter: EvidenceRef[];
  confidence: Confidence;
  claimConfidence: DriftClaimConfidence;
  /** True when the change could not be determined with certainty, for example under truncation. */
  indeterminate: boolean;
  reason?: string;
}

export interface DriftSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  nodesRenamed: number;
  relationshipsAdded: number;
  relationshipsRemoved: number;
  relationshipsModified: number;
  evidenceAdded: number;
  evidenceRemoved: number;
  evidenceChanged: number;
  confidenceChanged: number;
  totalChanges: number;
}

export interface DriftReport {
  base: SnapshotReference;
  target: SnapshotReference;
  identical: boolean;
  comparable: boolean;
  incomparabilityReason: string | null;
  targetIncomplete: boolean;
  removalConfidence: DriftClaimConfidence;
  counts: Record<DriftCategory, number>;
  summary: DriftSummary;
  changes: DriftChange[];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  meta: () => request<MetaResponse>('/api/meta'),

  listAnalyses: () => request<{ analyses: AnalysisListEntry[] }>('/api/analyses'),

  createAnalysis: (body: { repositoryPath: string; label?: string }) =>
    request<{ analysis: AnalysisListEntry; stats: GraphStats; summary: AnalysisSummary; gaps: GapReport; diagnostics: Diagnostic[] }>(
      '/api/analyses',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteAnalysis: (id: string) => request<void>(`/api/analyses/${id}`, { method: 'DELETE' }),

  getAnalysis: (id: string) => request<AnalysisDetail>(`/api/analyses/${id}`),

  getGraph: (
    id: string,
    params: { kind?: string; edgeKind?: string; q?: string; limit?: number; edgeLimit?: number; confidence?: string } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.kind) search.set('kind', params.kind);
    if (params.edgeKind) search.set('edgeKind', params.edgeKind);
    if (params.q) search.set('q', params.q);
    if (params.confidence) search.set('confidence', params.confidence);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.edgeLimit) search.set('edgeLimit', String(params.edgeLimit));
    const query = search.toString();
    return request<GraphResponse>(`/api/analyses/${id}/graph${query ? `?${query}` : ''}`);
  },

  getNode: (analysisId: string, nodeId: string) =>
    request<NodeDetail>(`/api/analyses/${analysisId}/nodes/${encodeURIComponent(nodeId)}`),

  getEvidence: (analysisId: string, path?: string) =>
    request<{ evidence: Evidence[]; total: number }>(
      `/api/analyses/${analysisId}/evidence${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  getArtifacts: (analysisId: string) => request<{ artifacts: Artifact[] }>(`/api/analyses/${analysisId}/artifacts`),

  getArtifact: (analysisId: string, kind: string) =>
    request<Artifact>(`/api/analyses/${analysisId}/artifacts/${encodeURIComponent(kind)}`),

  getSnapshot: (analysisId: string) => request<SnapshotResponse>(`/api/analyses/${analysisId}/snapshot`),

  /**
   * Compares two analyses.
   *
   * `against` is required by the server: a drift report with one side has no meaning, and
   * defaulting to "the previous analysis" would silently pick whichever row sorted first.
   */
  getDrift: (analysisId: string, against: string, options: { limit?: number; includeChanges?: boolean } = {}) => {
    const search = new URLSearchParams({ against });
    if (options.limit) search.set('limit', String(options.limit));
    if (options.includeChanges === false) search.set('includeChanges', 'false');
    return request<DriftReport>(`/api/analyses/${analysisId}/drift?${search.toString()}`);
  },

  getGaps: (analysisId: string) => request<GapReport>(`/api/analyses/${analysisId}/gaps`),

  getDiagnostics: (analysisId: string) => request<{ diagnostics: Diagnostic[] }>(`/api/analyses/${analysisId}/diagnostics`),

  /**
   * Requirements recovered for an analysis.
   *
   * Declared and derived requirements arrive together with their `origin`, because a reader
   * deciding how far to trust a statement needs to know whether the repository said it or a
   * fixed rule read it out of the code.
   */
  getRequirements: (analysisId: string) => request<RequirementModel>(`/api/analyses/${analysisId}/requirements`),

  /**
   * Use cases for an analysis, optionally filtered by status.
   *
   * No filter by default: partially evidenced use cases are the ones a reviewer needs, so
   * excluding them would hide the interesting half.
   */
  getUseCases: (analysisId: string, status?: UseCaseStatus) =>
    request<UseCaseModel & { filtered: boolean; totals: { useCases: number; returned: number } }>(
      `/api/analyses/${analysisId}/use-cases${status ? `?status=${status}` : ''}`,
    ),

  getUseCase: (analysisId: string, useCaseId: string) =>
    request<{ useCase: UseCase; actors: UseCaseModel['actors'] }>(
      `/api/analyses/${analysisId}/use-cases/${encodeURIComponent(useCaseId)}`,
    ),

  getConsistency: (analysisId: string) => request<ConsistencyReport>(`/api/analyses/${analysisId}/consistency`),

  getTraceabilityIndex: (analysisId: string) => request<TraceabilityIndex>(`/api/analyses/${analysisId}/traceability`),

  getTraceability: (analysisId: string, nodeId: string) =>
    request<Traceability>(`/api/analyses/${analysisId}/traceability/${encodeURIComponent(nodeId)}`),

  getLineage: (analysisId: string, nodeId: string) =>
    request<Lineage>(`/api/analyses/${analysisId}/lineage/${encodeURIComponent(nodeId)}`),
};