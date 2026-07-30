/**
 * JSON-RPC 2.0 wire types.
 *
 * Deliberately generic and decoupled from MCP-specific semantics (those live
 * in `core/mcp/`). MCP is an application protocol layered *on top of*
 * JSON-RPC 2.0 — keeping this layer protocol-agnostic means SentinelMCP's
 * transport, error handling, and id-correlation logic isn't hard-wired to
 * MCP and could front other JSON-RPC-based protocols later without a rewrite.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  /**
   * Absent `id` denotes a JSON-RPC *notification* — the caller has
   * explicitly signalled it does not want a correlated response. This is
   * distinct from `id: null`, which is a request with an id that happens to
   * be JSON null (rare, but spec-legal).
   */
  id?: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

/**
 * Hand-rolled structural type guard — intentionally NOT a schema-validation
 * library (Ajv/zod/etc.). This check runs on the hot path for every request
 * the gateway receives, so it's a handful of `O(1)` property checks with no
 * per-call schema-compilation or parsing overhead. Compare to
 * `config/env.ts`, which reaches for zod precisely because it runs once at
 * process boot, where ergonomics matter more than per-call cost.
 */
export function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  const candidate = body as Record<string, unknown>;

  const hasValidId =
    !('id' in candidate) ||
    typeof candidate.id === 'string' ||
    typeof candidate.id === 'number' ||
    candidate.id === null;

  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string' && candidate.method.length > 0 && hasValidId;
}

/** True when a validated request is a notification (no response expected). */
export function isNotification(request: JsonRpcRequest): boolean {
  return !('id' in request) || request.id === undefined;
}
