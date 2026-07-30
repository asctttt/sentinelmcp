import type { FastifyReply, FastifyRequest } from 'fastify';
import { allowedOrigins } from '../config/env.js';
import { JsonRpcErrorCode, buildJsonRpcError } from '../core/jsonRpc/errors.js';

/**
 * Origin header validation — the Streamable HTTP transport spec requires
 * servers to validate Origin on every incoming connection to prevent DNS
 * rebinding attacks: a malicious page served from an external origin tricks
 * a victim's browser into re-resolving that origin's DNS to 127.0.0.1
 * (or another local address) so its script can reach a local MCP server
 * despite same-origin policy. The Origin header still reflects the
 * *original* external origin the script was served from, not the rebound
 * address — that's exactly what this check is looking at.
 *
 * Registered as an onRequest hook (not preValidation) deliberately: it's a
 * pure header check that needs nothing preValidation would give it, and
 * running earlier means a rejected request never pays for body parsing.
 * Same "cheap checks first" reasoning as the Mcp-Method/Mcp-Name fast path
 * in proxyInterceptor.ts.
 *
 * Only rejects when Origin is PRESENT and not allowed. Absence is the
 * normal case for non-browser MCP clients — Origin is fundamentally a
 * browser fetch/XHR concept, and the attack this defends against requires
 * a browser in the loop, so there's nothing to check (or gain by demanding)
 * when it's simply not there.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export async function originGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  if (origin === undefined) return;

  if (isOriginAllowed(origin)) return;

  request.log.warn({ origin }, 'rejected: Origin header not in allowlist');
  await reply
    .status(403)
    .send(
      buildJsonRpcError(
        null,
        JsonRpcErrorCode.ORIGIN_REJECTED,
        `Origin "${origin}" is not permitted.`,
      ),
    );
}

function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins !== null) {
    return allowedOrigins.includes(origin);
  }

  // No ALLOWED_ORIGINS configured: default to loopback-only, any port.
  try {
    const hostname = new URL(origin).hostname;
    return LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    // Not a parseable URL at all — fail closed rather than guess at intent.
    return false;
  }
}
