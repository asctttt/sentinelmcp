import type { Pool } from 'undici';

/**
 * Module augmentation for the decorator added in `app.ts`. Without this,
 * `fastify.upstreamPool` (and `request.server.upstreamPool`) would type as
 * `unknown` everywhere it's accessed, including inside
 * `middleware/proxyInterceptor.ts`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Shared, keep-alive connection pool to the upstream MCP server —
     * created once per process and reused across every request. This is
     * what "stateless but fast" means in practice: no per-request
     * connection setup, but nothing here ties a request's correctness to
     * *this* process instance. Any replica behaves identically with its own
     * pool.
     */
    upstreamPool: Pool;
  }
}
