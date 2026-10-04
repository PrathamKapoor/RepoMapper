import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  AnalysisError,
  buildGraph,
  computeStats,
  DiagnosticCollector,
  EvidenceStore,
  resolveLimits,
  toPosixPath,
  type AnalysisOptions,
  type AnalysisResult,
  type AnalysisSummary,
  type DeepPartial,
  type ParsedFile,
  type RepositoryRef,
} from '@repoatlas/core';
import { projectAtlas, type AtlasProjection } from '@repoatlas/artifacts';
import {
  discoverFiles,
  readGitMetadata,
  resolveRepositoryRoot,
} from '@repoatlas/ingest';
import { defaultParsers, parseFiles, ParserRegistry } from '@repoatlas/parsers';

/**
 * The analysis pipeline.
 *
 * ```
 * resolveRepositoryRoot()          path-safety: containment + allow-list
 *   +-- discoverFiles()            bounded walk, ignore rules, binary/size limits
 *       +-- readGitMetadata()      read-only git facts
 *           +-- parseFiles()       deterministic extraction per language
 *               +-- buildGraph()   the canonical Software Knowledge Graph
 *                   +-- projectAtlas()   artifact projections + gap analysis
 * ```
 *
 * Each stage is independently useful and independently testable, and each stage's
 * output is the next stage's only input. Nothing downstream re-reads the repository.
 */

export interface RunAnalysisOptions {
  repositoryPath: string;
  label?: string | undefined;
  options?: DeepPartial<AnalysisOptions> | undefined;
  allowedRoots?: readonly string[] | undefined;
  includeGitHistory?: boolean | undefined;
  /** Injected for tests; defaults to the real filesystem reader. */
  readSource?: ((absolutePath: string) => Promise<string | null>) | undefined;
}

export interface RunAnalysisOutput extends AnalysisResult {
  /** Artifact projections and gap analysis derived from the same graph. */
  projection: AtlasProjection;
  diagnostics: ReturnType<DiagnosticCollector['list']>;
  /** Raw parsed-file results, retained for debugging and for parser-level tests. */
  parsed: ParsedFile[];
  skipped: { path: string; reason: string; byteSize?: number }[];
}

export async function runAnalysis(request: RunAnalysisOptions): Promise<RunAnalysisOutput> {
  const started = performance.now();
  const diagnostics = new DiagnosticCollector();

  const limits = resolveLimits(request.options?.limits);
  const includeGitHistory = request.includeGitHistory ?? request.options?.includeGitHistory ?? true;
  const languageFilter = request.options?.languages ?? [];

  // ---------------------------------------------------------------- 1. resolve
  const root = await resolveRepositoryRoot(request.repositoryPath, request.allowedRoots ?? []);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new AnalysisError('PATH_NOT_A_DIRECTORY', `Not a directory: ${request.repositoryPath}`, 400);
  }

  const repository: RepositoryRef = {
    absolutePath: root,
    name: basename(root) || 'repository',
  };

  // ---------------------------------------------------------------- 2. discover
  const discovery = await discoverFiles(
    root,
    {
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxTotalBytes,
    },
    diagnostics,
  );

  if (discovery.files.length === 0) {
    diagnostics.error('REPOSITORY_EMPTY', 'Repository contains no analyzable files');
  }

  // ---------------------------------------------------------------- 3. git facts
  const git = await readGitMetadata(root, diagnostics, {
    includeHistory: includeGitHistory,
    maxCommits: request.options?.maxCommits ?? 2_000,
  });

  // ---------------------------------------------------------------- 4. parse
  const analyzableFiles = discovery.files.filter((file) => file.analyzable);
  const candidateFiles =
    languageFilter.length > 0
      ? analyzableFiles.filter((file) => languageFilter.includes(file.language))
      : analyzableFiles;

  const readSource = request.readSource ?? defaultReadSource;
  /**
   * Content digests are captured during the single read each file already requires, so
   * hashing adds no extra I/O. They are what let the drift engine prove a rename instead
   * of guessing one from a similar name.
   */
  const digestByPath = new Map<string, string>();

  const batch = await parseFiles(
    candidateFiles.map((file) => ({
      path: file.path,
      language: file.language,
      absolutePath: joinPath(root, file.path),
    })),
    new ParserRegistry(defaultParsers()),
    {
      maxProblems: limits.maxParseErrorsPerFile,
      maxCalls: limits.maxCallRecordsPerFile,
      maxBytes: limits.maxFileBytes,
      readFile: async (absolutePath: string, path: string) => {
        const text = await readSource(absolutePath);
        if (text !== null) digestByPath.set(path, contentDigest(text));
        return text;
      },
    },
    diagnostics,
  );

  // ---------------------------------------------------------------- 5. graph
  const evidence = new EvidenceStore({ maxExcerptChars: limits.maxExcerptChars });
  const built = buildGraph({
    repository,
    files: discovery.files,
    parsed: batch.results,
    commits: git.commits,
    headCommit: git.headCommit,
    branch: git.branch,
    evidence,
    diagnostics,
    limits: { maxNodes: limits.maxNodes, maxEdges: limits.maxEdges },
    includeGitHistory,
    digestByPath,
  });

  const graph = built.graph;
  if (graph.nodes.length === 0) {
    diagnostics.warn('EMPTY_GRAPH', 'The knowledge graph contains no entities; see diagnostics for reasons');
  }

  // ---------------------------------------------------------------- 6. project
  const projection = projectAtlas(graph);

  const durationMs = Math.round(performance.now() - started);
  const languageCounts = countLanguages(discovery.files);

  const summary: AnalysisSummary = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    evidenceCount: graph.evidence.length,
    fileCount: discovery.files.length,
    analyzableFileCount: analyzableFiles.length,
    skippedFileCount: discovery.skipped.length,
    parserCount: new Set(batch.results.map((result) => result.producer)).size,
    languageCounts,
    explicitNodeShare: projection.stats.explicitShare.nodes,
    durationMs,
    truncated: discovery.truncated || built.truncated,
  };

  return {
    analysis: {
      id: '',
      repositoryPath: root,
      repositoryName: repository.name,
      label: request.label ?? null,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      headCommit: git.headCommit,
      branch: git.branch,
      error: null,
      summary,
      warnings: diagnostics.summaryLines(),
    },
    graph,
    stats: computeStats(graph),
    projection,
    diagnostics: diagnostics.list(),
    parsed: batch.results,
    skipped: discovery.skipped,
  };
}

/**
 * Reads a file as UTF-8.
 *
 * `readFile` with an explicit encoding replaces invalid byte sequences rather than
 * throwing, which matters because real repositories contain files with mixed encodings
 * and a single bad byte should not fail an analysis.
 */
async function defaultReadSource(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EACCES') return null;
    return null;
  }
}

/**
 * Content digest of a source file.
 *
 * Hashes the decoded text rather than the raw bytes so the digest is stable across
 * platforms: a checkout with CRLF and one with LF are the same source, and treating them
 * as different would invent a change on every cross-platform checkout. Line endings are
 * normalised before hashing.
 */
export function contentDigest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Joins a repository-relative POSIX path onto the repository root.
 *
 * Ingestion already validated that every discovered path is inside the root, so this is
 * a plain join rather than a second containment check.
 */
function joinPath(root: string, relativePath: string): string {
  return resolve(root, ...toPosixPath(relativePath).split('/'));
}

function countLanguages(files: readonly { language: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return counts;
}