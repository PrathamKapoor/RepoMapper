import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Server entry point.
 *
 * Boot order: load and validate configuration, then listen, then register signal
 * handlers. A configuration error exits with a readable message rather than a stack
 * trace, because the most common startup failure is a bad environment variable.
 */

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Resolves the built web UI directory.
 *
 * Walks up from the compiled file so the same code works whether it runs from
 * `packages/server/dist` in development or from `/app` in the container image.
 */
function findStaticDir(): string | undefined {
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../../../packages/web/dist'),
    resolve(process.cwd(), 'packages/web/dist'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[repoatlas] ${(error as Error).message}`);
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  if (config.isProduction && !config.pathAllowListEnforced) {
    // Not fatal, but never silent: an unconfined server can read any path it can reach.
    console.warn(
      '[repoatlas] WARNING: REPOATLAS_ALLOWED_ROOTS is not set. Any path this process can read may be analysed. ' +
        'Set REPOATLAS_ALLOWED_ROOTS to restrict analysis to specific directories.',
    );
  }
  if (config.isProduction && !config.staticDir) {
    const detected = findStaticDir();
    if (detected) config.staticDir = detected;
  }

  const app = await buildApp({ config });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const address = await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        address,
        env: config.env,
        allowList: config.pathAllowListEnforced ? config.allowedRoots : 'NOT ENFORCED',
        staticDir: config.staticDir ?? 'none',
      },
      'repoatlas listening',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exitCode = 1;
  }
}

await main();