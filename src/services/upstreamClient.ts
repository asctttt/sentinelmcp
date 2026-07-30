import type { FastifyInstance, FastifyRequest } from 'fastify';
import { upstream, env } from '../config/env.js';
import { McpHeader } from '../core/mcp/headers.js';
import type { JsonRpcRequest } from '../core/jsonRpc/types.js';

/**
 * The single place that actually talks to the upstream MCP server, over
 * the shared, pooled undici connection decorated onto the Fastify instance
 * in app.ts. Extracted out of middleware/proxyInterceptor.ts in Phase 5 so
 * routes/resume.ts (the human-in-the-loop APPROVE path) calls the exact
 * same upstream-calling logic — same timeout, same session/protocol-
 * version header passthrough, same 5xx-becomes-a-thrown-error behavior —
 * rather than risk a second, possibly-drifting copy of it.
 */
export async function forwardToUpstream(
  fastify: FastifyInstance,
  body: JsonRpcRequest,
  inboundHeaders: FastifyRequest['headers'],
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);

  try {
    const { statusCode, body: upstreamBody } = await fastify.upstreamPool.request({
      path: upstream.path,
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Session continuity is what keeps THIS proxy stateless on the
        // Streamable HTTP path: the upstream server owns the session,
        // SentinelMCP just relays the ids it's handed.
        ...forwardHeaderIfPresent(inboundHeaders, McpHeader.SESSION_ID),
        ...forwardHeaderIfPresent(inboundHeaders, McpHeader.PROTOCOL_VERSION),
      },
      body: JSON.stringify(body),
    });

    if (statusCode >= 500) {
      throw new Error(`upstream MCP server responded with HTTP ${statusCode}`);
    }

    return await upstreamBody.json();
  } finally {
    clearTimeout(timeout);
  }
}

function forwardHeaderIfPresent(headers: FastifyRequest['headers'], name: string): Record<string, string> {
  const value = headers[name];
  if (typeof value !== 'string') return {};
  return { [name]: value };
}
