import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  AnalysisError,
  describeError,
  CONFIDENCE_LEVELS,
  EDGE_KINDS,
  NODE_KINDS,
  type AnalysisRequest,
} from '@repoatlas/core';
import { ARTIFACTS } from '@repoatlas/artifacts';
import { loadConfig, type ServerConfig } from './config.js';
import { AnalysisService } from './service.js';
import { Store } from './store.js';
import { registerStaticUi, spaFallbackHandler, type NotFoundHandler } from './static.js';

/**
 * HTTP API.
 *
 * Contract principles:
 *  - every response is JSON with a stable shape; errors use `{ error: { code, message } }`;
 *  - request bodies are validated with zod and unknown fields are rejected, so a typo
 *    in a client is an error rather than a silently ignored setting;
 *  - repository paths are validated by the pipeline's containment rules, not by the
 *    route, so there is exactly one place that decides what may be read;
 *  - no endpoint ever returns filesystem contents verbatim. Evidence excerpts are
 *    redacted at ingest time and are the only source text the API exposes.
 */

/**
 * Drift query parameters.
 *
 * `against` is required: a drift report with only one side has no meaning, and defaulting
 * it to "the previous analysis" would silently pick whichever row happened to sort first.
 */
const driftQuerySchema = z.object({
  against: z.uuid(),
  /** Cap on returned change records. Summary counts are always complete. */
  limit: z.coerce.number().int().min(1).max(5_000).default(500),
  includeChanges: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
});

export interface BuildAppOptions {
  config?: ServerConfig;
  store?: Store;
  service?: AnalysisService;
}

/**
 * Validates a request fragment, converting a schema failure into a 400.
 *
 * Without this a malformed body reaches Fastify's default handler as an unexpected
 * error and the client sees a 500, which misattributes a caller mistake to the server
 * and hides the actual problem.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues
        .map((issue) => {
          const path = issue.path.join('.') || '(body)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
      throw new AnalysisError('BAD_REQUEST', `Invalid request — ${detail}`, 400);
    }
    throw error;
  }
}

const analyseBodySchema = z
  .object({
    repositoryPath: z.string().min(1).max(4_096),
    label: z.string().max(200).optional(),
    options: z
      .object({
        limits: z
          .object({
            maxFiles: z.number().int().positive().optional(),
            maxFileBytes: z.number().int().positive().optional(),
            maxTotalBytes: z.number().int().positive().optional(),
            maxParseErrorsPerFile: z.number().int().positive().optional(),
            maxExcerptChars: z.number().int().positive().optional(),
            maxNodes: z.number().int().positive().optional(),
            maxEdges: z.number().int().positive().optional(),
            maxCallRecordsPerFile: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        languages: z.array(z.string().max(40)).max(32).optional(),
        includeGitHistory: z.boolean().optional(),
        enableInference: z.boolean().optional(),
        maxCommits: z.number().int().positive().max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

/**
 * Graph query parameters.
 *
 * Node kind and edge kind are separate parameters on purpose. A single `kind` filter
 * cannot mean both, and letting it try produces a validation error that lists edge
 * kinds when the caller asked for node kinds.
 */
const graphQuerySchema = z.object({
  /** Node kinds to include. */
  kind: z.enum(NODE_KINDS).optional(),
  /** Relationship kinds to include. */
  edgeKind: z.enum(EDGE_KINDS).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(500),
  edgeLimit: z.coerce.number().int().min(1).max(10_000).default(2_000),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
});

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new Store(config.dbPath);
  const service = options.service ?? new AnalysisService({ config, store });

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    // Repositories are untrusted; a hard body cap keeps an oversized request from
    // reaching the JSON parser.
    bodyLimit: config.maxUploadBytes,
    trustProxy: false,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AnalysisError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    if (fastifyError.statusCode === 400) {
      void reply.status(400).send({ error: { code: 'BAD_REQUEST', message: fastifyError.message ?? 'Invalid request' } });
      return;
    }

    const described = describeError(error);
    // The message is logged but not echoed for unexpected failures: an internal error
    // string can contain paths or configuration that should not reach a client.
    request.log.error({ err: error }, 'unhandled request error');
    void reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: config.isProduction ? 'Internal server error' : described.message,
      },
    });
  });

  /**
   * The single not-found handler for this instance.
   *
   * Fastify permits one per prefix and throws on a second registration, so the static
   * UI swaps the implementation here rather than registering its own handler.
   */
  let notFound: NotFoundHandler = (request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  };
  app.setNotFoundHandler((request, reply) => notFound(request, reply));

  // ------------------------------------------------------------------- health
  app.get('/api/health', () => ({
    status: 'ok',
    version: '0.1.0',
    uptimeSeconds: Math.round(process.uptime()),
    environment: config.env,
    /** Surfaced so an operator can see when no filesystem boundary is enforced. */
    pathAllowListEnforced: config.pathAllowListEnforced,
    allowedRootCount: config.allowedRoots.length,
    analysesStored: store.countAnalyses(),
    analysisConcurrency: config.concurrency,
    maxUploadBytes: config.maxUploadBytes,
    gitHistoryEnabled: config.includeGitHistory,
    node: process.version,
  }));

  // ------------------------------------------------------------------ meta
  app.get('/api/meta', () => ({
    nodeKinds: NODE_KINDS,
    edgeKinds: EDGE_KINDS,
    confidenceLevels: CONFIDENCE_LEVELS,
    artifacts: ARTIFACTS.map((artifact) => ({ kind: artifact.kind, title: artifact.title })),
  }));

  // -------------------------------------------------------------- analyses
  app.get('/api/analyses', (request) => {
    const query = parseOrThrow(listQuerySchema, request.query ?? {});
    return { analyses: service.list(query.limit) };
  });

  app.post('/api/analyses', async (request, reply) => {
    const body = parseOrThrow(analyseBodySchema, request.body ?? {});
    const analysisRequest: AnalysisRequest = {
      repositoryPath: body.repositoryPath,
      ...(body.label ? { label: body.label } : {}),
      ...(body.options ? { options: body.options } : {}),
    };

    const { record, output } = await service.analyse(analysisRequest);
    void reply.status(201);
    return {
      analysis: record,
      stats: output.stats,
      summary: record.summary,
      gaps: output.projection.gaps,
      diagnostics: output.diagnostics,
    };
  });

  app.get('/api/analyses/:id', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = service.getResult(id);
    if (!result) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    return {
      analysis: result.analysis,
      stats: result.stats,
      gaps: result.projection.gaps,
      artifacts: result.projection.artifacts.map((artifact) => ({
        kind: artifact.kind,
        title: artifact.title,
        scope: artifact.scope,
        insufficientEvidence: artifact.insufficientEvidence,
        stats: artifact.stats,
        omitted: artifact.omitted,
        nodeCount: artifact.nodes.length,
        edgeCount: artifact.edges.length,
      })),
    };
  });

  app.get('/api/analyses/:id/diagnostics', (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    if (!store.getAnalysis(id)) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    return { diagnostics: store.getDiagnostics(id) };
  });

  app.delete('/api/analyses/:id', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    if (!service.remove(id)) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    void reply.status(204);
    return null;
  });

  // ------------------------------------------------------------------ graph
  app.get('/api/analyses/:id/graph', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const graph = store.getGraph(id);
    if (!graph) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }

    const query = parseOrThrow(graphQuerySchema, request.query ?? {});

    let nodes = graph.nodes;
    if (query.kind) nodes = nodes.filter((node) => node.kind === query.kind);
    if (query.confidence) nodes = nodes.filter((node) => node.confidence === query.confidence);
    if (query.q) {
      const needle = query.q.toLowerCase();
      nodes = nodes.filter(
        (node) =>
          node.name.toLowerCase().includes(needle) ||
          (node.qualifiedName?.toLowerCase().includes(needle) ?? false) ||
          (node.path?.toLowerCase().includes(needle) ?? false),
      );
    }
    const totalMatching = nodes.length;
    nodes = nodes.slice(0, query.limit);

    // Only edges whose endpoints survived filtering are returned, so the client never
    // receives a graph with dangling references.
    const nodeIds = new Set(nodes.map((node) => node.id));
    let edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    if (query.edgeKind) edges = edges.filter((edge) => edge.kind === query.edgeKind);
    edges = edges.slice(0, query.edgeLimit);

    return {
      analysisId: id,
      schemaVersion: graph.schemaVersion,
      nodes,
      edges,
      truncated: totalMatching > nodes.length,
      totals: { nodes: graph.nodes.length, edges: graph.edges.length, matching: totalMatching },
    };
  });

  app.get('/api/analyses/:id/nodes/:nodeId', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { nodeId } = parseOrThrow(z.object({ nodeId: z.string().min(1).max(1_024) }), request.params);

    const node = store.getNode(id, nodeId);
    if (!node) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No node ${nodeId} in analysis ${id}` } };
    }

    const { out, in: incoming } = store.getNeighbourhood(id, nodeId);
    const evidenceIds = new Set<string>();
    for (const ref of node.evidence) evidenceIds.add(ref.evidenceId);
    for (const edge of [...out, ...incoming]) {
      for (const ref of edge.evidence) evidenceIds.add(ref.evidenceId);
    }
    const evidence = store.getEvidence(id).filter((item) => evidenceIds.has(item.id));

    const relatedIds = new Set<string>([...out.map((edge) => edge.to), ...incoming.map((edge) => edge.from)]);
    const related = [...relatedIds]
      .map((relatedId) => store.getNode(id, relatedId))
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return { node, outgoing: out, incoming, related, evidence };
  });

  app.get('/api/analyses/:id/evidence', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    if (!store.getAnalysis(id)) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    const { path } = parseOrThrow(z.object({ path: z.string().max(4_096).optional() }), request.query ?? {});
    const evidence = store.getEvidence(id, path);
    return { evidence, total: evidence.length };
  });

  // -------------------------------------------------------------- artifacts
  app.get('/api/analyses/:id/artifacts', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = service.getResult(id);
    if (!result) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    return { artifacts: result.projection.artifacts };
  });

  app.get('/api/analyses/:id/artifacts/:kind', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { kind } = parseOrThrow(z.object({ kind: z.string().min(1).max(64) }), request.params);

    const result = service.getResult(id);
    if (!result) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    const artifact = result.projection.artifacts.find((item) => item.kind === kind);
    if (!artifact) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No artifact ${kind}; available: ${ARTIFACTS.map((a) => a.kind).join(', ')}` } };
    }
    return artifact;
  });

  // ------------------------------------------------------------------ drift
  /**
   * Compares two analyses.
   *
   * `against` names the other analysis; direction is resolved by creation time so the
   * caller cannot invert a report by swapping arguments.
   */
  app.get('/api/analyses/:id/drift', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { against, limit, includeChanges } = parseOrThrow(driftQuerySchema, request.query ?? {});

    if (!store.getAnalysis(id)) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    if (!store.getAnalysis(against)) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${against}` } };
    }

    const report = service.compareAnalyses(id, against, {
      includeChanges,
      maxChanges: limit,
    });
    if (!report) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: 'One or both analyses could not be loaded as snapshots' } };
    }

    return report;
  });

  /** Snapshot identity for an analysis, without its whole graph. */
  app.get('/api/analyses/:id/snapshot', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const snapshot = service.getSnapshot(id);
    if (!snapshot) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    return { snapshot: snapshot.provenance, stats: snapshot.stats };
  });

  // ----------------------------------------------------------------- gaps
  app.get('/api/analyses/:id/gaps', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = service.getResult(id);
    if (!result) {
      void reply.status(404);
      return { error: { code: 'NOT_FOUND', message: `No analysis with id ${id}` } };
    }
    return result.projection.gaps;
  });

  app.addHook('onClose', () => {
    // Close the store only when this app owns it; a test-provided store is the
    // caller's responsibility.
    if (!options.store) store.close();
  });

  if (config.staticDir && existsSync(config.staticDir)) {
    await registerStaticUi(app, config.staticDir);
    notFound = spaFallbackHandler();
  }

  return app;
}

export { loadConfig };
export type { ServerConfig };