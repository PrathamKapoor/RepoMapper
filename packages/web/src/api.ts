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
}

export interface ArtifactEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
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

  getGaps: (analysisId: string) => request<GapReport>(`/api/analyses/${analysisId}/gaps`),

  getDiagnostics: (analysisId: string) => request<{ diagnostics: Diagnostic[] }>(`/api/analyses/${analysisId}/diagnostics`),
};