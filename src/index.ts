/**
 * src/index.ts
 *
 * Process entry point. Intentionally thin: everything that constitutes "the
 * app" — plugins, hooks, routes — lives in app.ts. This file's only job is
 * to turn that app into a running process: bind a port, and shut down
 * cleanly when asked to.
 *
 * That split matters for a service that's meant to run as many identical,
 * stateless replicas behind a load balancer: buildApp() has zero knowledge
 * of "am I the only instance," and this file has zero knowledge of "what do
 * requests do" — the two concerns don't leak into each other.
 */

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { verifyLicenseAtBoot } from './license.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await verifyLicenseAtBoot(app.log);
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start SentinelMCP gateway');
    process.exit(1);
  }
}

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then let Fastify's onClose hooks (see app.ts — the upstream
 * connection pool) release their resources before the process exits. This
 * matters in any orchestrated environment (Kubernetes, ECS, etc.) that sends
 * SIGTERM before forcibly killing a container.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'received shutdown signal, closing gracefully');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();