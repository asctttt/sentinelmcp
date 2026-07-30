import type { FastifyInstance } from 'fastify';

/**
 * Liveness/readiness probe. Deliberately outside the `/mcp` prefix and the
 * JSON-RPC envelope — this is plain HTTP for load balancers and orchestrators,
 * not a protocol endpoint.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'sentinelmcp',
    ts: new Date().toISOString(),
  }));
}
