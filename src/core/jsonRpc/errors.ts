import type { JsonRpcFailure, JsonRpcId } from './types.js';

/**
 * JSON-RPC 2.0 reserves -32768..-32000 for spec/transport-level errors, and
 * carves -32000..-32099 out specifically as "implementation-defined server
 * errors." SentinelMCP's own policy/identity/budget failures all live in
 * that reserved sub-range so they can never collide with an error code a
 * downstream MCP server legitimately returns for its own reasons.
 */
export const JsonRpcErrorCode = {
  // --- Spec-defined; do not repurpose these ---
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // --- SentinelMCP's reserved server-error range (-32000 to -32099) ---
  POLICY_DENIED: -32001,
  BUDGET_EXCEEDED: -32002,
  UPSTREAM_UNAVAILABLE: -32003,
  IDENTITY_REJECTED: -32004,
  /** Phase 2: a POST arrived with ?sessionId= that has no matching open SSE stream. */
  SESSION_NOT_FOUND: -32005,
  /** Phase 3: Origin header present but not in the allowlist (DNS-rebinding mitigation). */
  ORIGIN_REJECTED: -32006,
  /** Phase 5: a resumeToken failed signature verification or has expired. Distinct from IDENTITY_REJECTED — this is about the token's own validity, not the caller's bearer credential. */
  RESUME_TOKEN_INVALID: -32007,
  /** Phase 5: a resumeToken verified fine, but the originalRequest submitted alongside it hashes to something different than what was actually paused — the tamper-detection signal specifically. */
  RESUME_REQUEST_MISMATCH: -32008,
} as const satisfies Record<string, number>;

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

export function buildJsonRpcError(
  id: JsonRpcId,
  code: JsonRpcErrorCode,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
