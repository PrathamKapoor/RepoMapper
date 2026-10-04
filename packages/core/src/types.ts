/**
 * Canonical domain types for RepoAtlas.
 *
 * Everything the product knows about a repository is expressed with the types in
 * this file. Parsers, the graph, artifacts, the consistency engine and the API all
 * speak this vocabulary, which is what keeps independent projections consistent.
 */

// ---------------------------------------------------------------------------
// Evidence & confidence
// ---------------------------------------------------------------------------

/**
 * How strongly RepoAtlas believes a fact.
 *
 * The rule the whole product obeys: an inference is never presented as a fact.
 * `EXPLICIT` means the repository literally states it; anything else is labelled.
 */
export const CONFIDENCE_LEVELS = [
  'EXPLICIT',
  'STRONGLY_INFERRED',
  'WEEKLY_INFERRED',
  'UNKNOWN',
] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Ordered from strongest to weakest, used when merging duplicate facts. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  EXPLICIT: 3,
  STRONGLY_INFERRED: 2,
  WEEKLY_INFERRED: 1,
  UNKNOWN: 0,
};

/** Returns the weaker of two confidence levels. A fact is never upgraded by merging. */
export function weakerConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/** Numeric strength used for sorting and for "how much of this graph is inferred?" metrics. */
export function confidenceScore(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence];
}

/** The kind of repository artefact that justifies a fact. */
export const EVIDENCE_KINDS = [
  'DECLARATION',
  'IMPORT_STATEMENT',
  'CALL_SITE',
  'TYPE_REFERENCE',
  'ROUTE_DECLARATION',
  'SCHEMA_DDL',
  'MANIFEST_FIELD',
  'CONFIG_KEY',
  'MARKDOWN_SECTION',
  'GIT_COMMIT',
  'INFRASTRUCTURE_FILE',
  'TEST_ASSERTION',
  'DERIVED',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * A single, citable location inside the analysed repository.
 *
 * `path` is always POSIX-relative to the repository root so evidence is stable
 * across machines and operating systems.
 */
export interface Evidence {
  /** Deterministic id derived from location + kind. */
  id: string;
  kind: EvidenceKind;
  /** POSIX-relative path from the repository root. */
  path: string;
  /** 1-based inclusive start line, or 0 when the fact has no line granularity. */
  startLine: number;
  /** 1-based inclusive end line. Equals `startLine` for single-line evidence. */
  endLine: number;
  /** Enclosing symbol when known, e.g. `ReportService.list`. */
  symbol?: string;
  /** Short, redacted excerpt of the source that justifies the fact. */
  excerpt?: string;
  /** Which extractor produced this evidence, e.g. `typescript-compiler-api`. */
  producer: string;
}

/** A pointer to evidence, used on nodes and edges so the graph stays serialisable. */
export interface EvidenceRef {
  evidenceId: string;
  kind: EvidenceKind;
  path: string;
  startLine: number;
  endLine: number;
  producer: string;
}

/** Builds a lightweight reference from full evidence. */
export function toEvidenceRef(evidence: Evidence): EvidenceRef {
  return {
    evidenceId: evidence.id,
    kind: evidence.kind,
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    producer: evidence.producer,
  };
}

// ---------------------------------------------------------------------------
// Graph entities
// ---------------------------------------------------------------------------

export const NODE_KINDS = [
  'repository',
  'directory',
  'file',
  'module',
  'package',
  'function',
  'class',
  'interface',
  'type',
  'constant',
  'api_endpoint',
  'service',
  'database',
  'table',
  'column',
  'queue',
  'event',
  'actor',
  'use_case',
  'requirement',
  'test',
  'deployment_component',
  'configuration',
  'commit',
  'contributor',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/** Node kinds that represent runnable or structural code (used by artifact selection). */
export const CODE_NODE_KINDS: readonly NodeKind[] = [
  'module',
  'package',
  'class',
  'interface',
  'function',
  'type',
  'constant',
  'api_endpoint',
  'service',
  'test',
];

export type AttributeValue = string | number | boolean | null;

export interface GraphNode {
  /** Stable, deterministic id: `<kind>:<slug>`. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Language- or system-level unique name, e.g. `services/report.ts#ReportService`. */
  qualifiedName?: string;
  /** Detected language for code entities. */
  language?: string;
  /** Owning repository-relative path, when the entity is file-backed. */
  path?: string;
  startLine?: number;
  endLine?: number;
  /**
   * Content digest of the underlying source, present on module nodes.
   *
   * This is what makes a rename provable rather than guessed: two nodes with the same
   * digest and a different path are the same bytes under a different name. See
   * `drift.ts` for the rules, which are deliberately narrow.
   */
  digest?: string;
  attributes?: Record<string, AttributeValue>;
  evidence: EvidenceRef[];
  confidence: Confidence;
}

export const EDGE_KINDS = [
  'contains',
  'declared_in',
  'declares_schema',
  'imports',
  'calls',
  'extends',
  'implements',
  're_exports',
  'exposes',
  'consumes',
  'produces',
  'reads',
  'writes',
  'depends_on',
  'deploys',
  'authenticates',
  'authorizes',
  'tests',
  'documents',
  'implements_requirement',
  'belongs_to',
  'communicates_with',
  'transforms',
  'triggers',
  'modifies',
  'supersedes',
  'authored_by',
  'configures',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Edge kinds whose absence is meaningful (used by gap analysis). */
export const STRUCTURAL_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'calls',
  'tests',
  'documents',
  'implements_requirement',
  'depends_on',
];

export interface GraphEdge {
  /** Stable, deterministic id: `<from>|<kind>|<to>`. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  evidence: EvidenceRef[];
  attributes?: Record<string, AttributeValue>;
  /** Optional human-readable label, e.g. HTTP method or call site count. */
  label?: string;
}

// ---------------------------------------------------------------------------
// The canonical graph
// ---------------------------------------------------------------------------

export interface SoftwareGraph {
  /** Schema version of the serialised graph. Bumped on breaking model changes. */
  schemaVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: Evidence[];
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  /** Fraction of nodes/edges that are explicitly evidenced (0..1). */
  explicitShare: { nodes: number; edges: number };
}

// ---------------------------------------------------------------------------
// Ingestion inputs
// ---------------------------------------------------------------------------

export interface RepositoryRef {
  /** Absolute, resolved path on the analysis host. */
  absolutePath: string;
  /** Display name, usually the directory basename. */
  name: string;
}

export interface SourceFile {
  /** POSIX-relative path from the repository root. */
  path: string;
  absolutePath: string;
  byteSize: number;
  /** Detected language id such as `typescript`, `python`, or `unknown`. */
  language: string;
  /** False when the file was skipped by limits (size, binary, ignore rules). */
  analyzable: boolean;
  /** Reason a non-analyzable file was skipped. */
  skipReason?: SkipReason;
}

export interface GitMetadata {
  available: boolean;
  headCommit: string | null;
  branch: string | null;
  /** Files known to git. Empty when git is unavailable. */
  trackedFiles: string[];
  commits: CommitRecord[];
  contributorCount: number;
}

export const SKIP_REASONS = [
  'binary',
  'too_large',
  'ignored_by_vcs',
  'ignored_by_default',
  'unsupported_extension',
  'symlink_escape',
  'unreadable',
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export interface DiscoveredFile {
  path: string;
  byteSize: number;
  language: string;
  analyzable: boolean;
  skipReason?: SkipReason;
}

export interface IngestResult {
  repository: RepositoryRef;
  /** Commit of HEAD, or `null` for a non-git directory. */
  headCommit: string | null;
  branch: string | null;
  files: DiscoveredFile[];
  skipped: { path: string; reason: SkipReason; byteSize?: number }[];
  /** Directories excluded before walking. */
  excludedDirectories: string[];
  truncated: boolean;
  warnings: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Parser outputs
// ---------------------------------------------------------------------------

/**
 * A deterministic extraction result for one file.
 *
 * Parsers never infer intent; they report what the source literally contains plus
 * the evidence span for each fact.
 */
export interface ParsedFile {
  path: string;
  language: string;
  /** Parser that produced this result. */
  producer: string;
  imports: ImportRecord[];
  entities: ExtractedEntity[];
  calls: CallRecord[];
  /** Free-form facts such as framework markers or route tables. */
  markers: Marker[];
  /** Non-fatal problems: syntax errors, unsupported syntax, truncation. */
  problems: ParseProblem[];
  durationMs: number;
}

export interface ImportRecord {
  /** Module specifier exactly as written in source. */
  specifier: string;
  /** Imported symbol names, empty for namespace or side-effect imports. */
  names: string[];
  kind: 'static' | 'dynamic' | 'require' | 'type_only' | 'reexport';
  line: number;
  /** Resolved repository-relative path when the specifier points inside the repo. */
  resolvedPath?: string;
  isExternal: boolean;
}

export interface ExtractedEntity {
  kind: ExtractableEntityKind;
  name: string;
  /** Unique within the file, e.g. `ReportService.list`. */
  qualifiedName: string;
  startLine: number;
  endLine: number;
  language: string;
  parentQualifiedName?: string;
  attributes?: Record<string, AttributeValue>;
  /** Base type names for classes/interfaces/types when the source states them. */
  extendsFrom?: string[];
  implementsFrom?: string[];
  modifiers?: string[];
  signature?: string;
}

export const EXTRACTABLE_ENTITY_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'constant',
  'api_endpoint',
  'test',
] as const;

export type ExtractableEntityKind = (typeof EXTRACTABLE_ENTITY_KINDS)[number];

export interface CallRecord {
  /** Callee name as written, e.g. `render` or `reportRepo.findById`. */
  callee: string;
  line: number;
  /** Enclosing function qualified name when resolvable. */
  fromQualifiedName?: string;
  /** Argument count when the source states it. */
  argCount?: number;
  /** True when the callee is a local identifier (no member access, no import). */
  isLocalIdentifier: boolean;
}

export interface Marker {
  /** Machine-readable marker name, e.g. `express.route`. */
  name: string;
  line: number;
  attributes: Record<string, AttributeValue>;
}

export interface ParseProblem {
  message: string;
  line: number;
  code: string;
}

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

/** One commit as read from git history. A domain type so the graph builder stays independent of ingest. */
export interface CommitRecord {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author timestamp. */
  timestamp: string;
  subject: string;
  /** Repository-relative POSIX paths touched by the commit. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Analysis configuration & results
// ---------------------------------------------------------------------------

export interface AnalysisLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxParseErrorsPerFile: number;
  maxExcerptChars: number;
  maxNodes: number;
  maxEdges: number;
  maxCallRecordsPerFile: number;
}

export interface AnalysisOptions {
  limits: AnalysisLimits;
  /** Languages to attempt. Empty means "all registered languages". */
  languages: string[];
  includeGitHistory: boolean;
  /** Emit inference-pass nodes in addition to deterministic ones. */
  enableInference: boolean;
  /** Maximum commits read from git history. */
  maxCommits: number;
}

export interface AnalysisRequest {
  repositoryPath: string;
  label?: string;
  options?: DeepPartial<AnalysisOptions>;
}

/** Recursively optional, used for request payloads that override analysis options. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type AnalysisStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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

export interface AnalysisRecord {
  id: string;
  repositoryPath: string;
  repositoryName: string;
  label: string | null;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  headCommit: string | null;
  branch: string | null;
  error: { code: string; message: string } | null;
  summary: AnalysisSummary | null;
  warnings: string[];
  /**
   * Content digest of the graph this analysis produced. Null for failed analyses.
   *
   * Two analyses of unchanged content share this value, which is what makes "nothing
   * changed" decidable without comparing timestamps.
   */
  graphDigest?: string | null;
  /** Extractor version in force when the analysis ran. Null for failed analyses. */
  extractorVersion?: string | null;
  /** Graph schema version the analysis produced. Null for failed analyses. */
  graphSchemaVersion?: number | null;
}

export interface AnalysisResult {
  analysis: AnalysisRecord;
  graph: SoftwareGraph;
  stats: GraphStats;
}

// ---------------------------------------------------------------------------
// Evidence status vocabulary (gap analysis)
// ---------------------------------------------------------------------------

/**
 * How much support the repository provides for a claim.
 *
 * `NOT_FOUND` never means "the file is absent"; it means "no evidence was found
 * anywhere in the analysed repository".
 */
export const EVIDENCE_STATUSES = ['EXPLICIT', 'PARTIALLY_EVIDENCED', 'INFERRED', 'NOT_FOUND'] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
