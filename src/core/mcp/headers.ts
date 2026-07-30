import type { JsonRpcRequest } from '../jsonRpc/types.js';
import type { McpToolCallParams } from './types.js';

/**
 * MCP header contracts.
 *
 * IMPORTANT — read this before pointing a spec-compliant MCP client at the
 * gateway. Per the MCP Streamable HTTP transport spec (2025-11-25), the only
 * headers a client is guaranteed to send are `MCP-Session-Id` (session
 * correlation, set once the server assigns one) and `MCP-Protocol-Version`
 * (version negotiation). There is no standard `Mcp-Method` / `Mcp-Name`
 * header — `method` and, for tool calls, `params.name` live in the JSON-RPC
 * body only.
 *
 * SentinelMCP still reads `Mcp-Method` / `Mcp-Name` as an OPTIONAL,
 * non-authoritative fast path: if something upstream of this gateway (an
 * internal sidecar, a service-mesh hop, a custom client shim) chooses to
 * mirror them onto the request, the `onRequest` hook can reject a
 * policy-denied call before Fastify even parses the body — real savings on
 * the deny path under load. A standards-compliant MCP client will simply
 * never set them, and that MUST be a fully supported, unremarkable case —
 * never a bypass. Hence two hard rules, both enforced in
 * `middleware/proxyInterceptor.ts`:
 *
 *   1. These headers may only be used to REJECT early.
 *   2. They may never be the sole basis to ALLOW a request through — the
 *      JSON-RPC body is re-parsed and re-checked before every forward,
 *      regardless of what the headers claimed.
 */
export const McpHeader = {
  /** Spec-defined: session correlation once a session is established. */
  SESSION_ID: 'mcp-session-id',
  /** Spec-defined: protocol version negotiation. */
  PROTOCOL_VERSION: 'mcp-protocol-version',
  /** SentinelMCP fast-path extension — NOT part of the MCP spec. See above. */
  FAST_PATH_METHOD: 'mcp-method',
  /** SentinelMCP fast-path extension — NOT part of the MCP spec. See above. */
  FAST_PATH_TOOL_NAME: 'mcp-name',
} as const;

export interface RouteHint {
  method: string | undefined;
  toolName: string | undefined;
  /** `true` when this hint came from headers rather than a parsed body. */
  fromFastPath: boolean;
}

/**
 * Reads the optional fast-path hint from request headers. Fastify lower-cases
 * incoming header names, so plain lookup with the lower-case constants above
 * is sufficient — no case-insensitive matching needed.
 */
export function readFastPathHint(headers: Record<string, string | string[] | undefined>): RouteHint {
  const rawMethod = headers[McpHeader.FAST_PATH_METHOD];
  const rawName = headers[McpHeader.FAST_PATH_TOOL_NAME];
  return {
    method: Array.isArray(rawMethod) ? rawMethod[0] : rawMethod,
    toolName: Array.isArray(rawName) ? rawName[0] : rawName,
    fromFastPath: true,
  };
}

/** Derives the same RouteHint shape from the authoritative, parsed JSON-RPC body. */
export function readRouteInfoFromBody(body: JsonRpcRequest): RouteHint {
  const params = body.params as McpToolCallParams | undefined;
  return {
    method: body.method,
    toolName: body.method === 'tools/call' ? params?.name : undefined,
    fromFastPath: false,
  };
}
