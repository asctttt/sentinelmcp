import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { Pool } from 'undici';
import { env, upstream } from './config/env.js';
import { jsonRpcErrorHandler } from './plugins/jsonRpcErrorHandler.js';
import { proxyInterceptor } from './middleware/proxyInterceptor.js';
import { resumeRoutes } from './routes/resume.js';
import { healthRoutes } from './routes/health.js';
// Note: types/fastify.d.ts is picked up automatically by tsconfig's
// "include" glob for the FastifyInstance.upstreamPool augmentation below —
// it must NOT be imported here. It's a pure ambient .d.ts with no runtime
// output, so a side-effect import would resolve to a .js file that doesn't
// exist (that's a type-checker-passes-but-Node-crashes bug, worth knowing
// about since it's an easy one to reintroduce).

/**
 * Composition root. Kept separate from `index.ts` on purpose: constructing
 * the app and running it are different concerns. This function returns a
 * fully wired Fastify instance without binding a port, which means Phase
 * 1.5's test suite can exercise the whole request pipeline via
 * `app.inject()` — no real socket, no port conflicts, no upstream needed for
 * most cases.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Structured JSON logs in production (what your log aggregator wants);
      // pretty-printed only for local development.
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    // SentinelMCP is expected to sit behind an LB/ingress; trust its forwarded headers.
    trustProxy: true,
    // Defensive cap — MCP tool schemas/results can be large but shouldn't be unbounded.
    bodyLimit: env.MAX_BODY_BYTES,
  });

  // One pooled, keep-alive connection to the upstream MCP server, created
  // once per process and reused across every request — see
  // types/fastify.d.ts for why this is safe under "stateless."
  const upstreamPool = new Pool(upstream.origin, {
    connections: 32,
    pipelining: 1,
    keepAliveTimeout: 30_000,
  });
  app.decorate('upstreamPool', upstreamPool);
  app.addHook('onClose', async () => {
    await upstreamPool.close();
  });

  app.register(sensible);
  app.register(cors, { origin: env.CORS_ORIGIN });

  // Registered before routes so it catches anything Fastify itself throws
  // during routing/parsing, not just handler-level errors.
  app.setErrorHandler(jsonRpcErrorHandler);

  app.register(healthRoutes);
  app.register(proxyInterceptor, { prefix: '/mcp' });
  // A separate plugin registration, not nested inside proxyInterceptor —
  // see routes/resume.ts's module doc for why it explicitly re-declares
  // its own originGuard hook rather than relying on inheriting one here.
  app.register(resumeRoutes, { prefix: '/mcp' });

  return app;
}
