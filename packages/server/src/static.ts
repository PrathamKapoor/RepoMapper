import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serves the built web UI.
 *
 * The SPA fallback only matches GET requests that accept HTML and are not API calls, so
 * a mistyped API route returns a JSON 404 rather than the application shell. That
 * distinction matters: silently returning HTML for an API path is a common source of
 * confusing client-side errors.
 *
 * Note that this module does *not* call `setNotFoundHandler`. Fastify permits exactly
 * one per prefix and throws on a second registration, so the single handler installed
 * by `buildApp` delegates here through `setSpaFallback`.
 */

const FALLBACK_FILE = 'index.html';

export type NotFoundHandler = (request: FastifyRequest, reply: FastifyReply) => void;

export async function registerStaticUi(app: FastifyInstance, staticDir: string): Promise<void> {
  if (!existsSync(join(staticDir, FALLBACK_FILE))) {
    app.log.warn({ staticDir }, 'static UI directory has no index.html; UI will not be served');
    return;
  }

  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    index: [FALLBACK_FILE],
    // Hashed asset filenames are safe to cache aggressively; index.html is not.
    setHeaders: (response, path) => {
      if (path.endsWith('.html')) {
        response.setHeader('Cache-Control', 'no-cache');
        return;
      }
      if (/\.[0-9a-f]{8,}\./.test(path)) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
}

/**
 * Returns the SPA fallback handler for a static directory.
 *
 * Exported separately so the single not-found handler registered by `buildApp` can be
 * pointed at it once the static plugin is in place.
 */
export function spaFallbackHandler(): NotFoundHandler {
  return (request, reply) => {
    const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
    if (request.method === 'GET' && !request.url.startsWith('/api/') && acceptsHtml) {
      void reply.type('text/html').sendFile(FALLBACK_FILE);
      return;
    }
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  };
}