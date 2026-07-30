import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { JsonRpcErrorCode, buildJsonRpcError } from '../core/jsonRpc/errors.js';

/**
 * Global safety net. Anything that throws — including failures Fastify
 * itself raises, like a body over `bodyLimit` or invalid JSON caught by
 * Fastify's own content-type parser — lands here. The gateway's entire job
 * is to speak JSON-RPC even when something goes wrong, so a calling agent
 * never has to special-case "the gateway itself broke" versus "the upstream
 * MCP server returned an error."
 */
export function jsonRpcErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  request.log.error({ err: error }, 'unhandled error in request pipeline');

  // Verified against node_modules/fastify/lib/errors.js — Fastify's own
  // content-type parser uses these exact codes for a malformed or empty
  // JSON body. (Worth verifying directly rather than assuming: an earlier
  // draft of this handler guessed FST_ERR_CTP_INVALID_JSON, which does not
  // exist — it silently fell through to INTERNAL_ERROR instead of
  // PARSE_ERROR until a smoke test against a real malformed request caught it.)
  const isBodyParseFailure = error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY';
  const isBodyTooLarge = error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';

  const code = isBodyParseFailure ? JsonRpcErrorCode.PARSE_ERROR : JsonRpcErrorCode.INTERNAL_ERROR;

  const status = isBodyParseFailure || isBodyTooLarge ? 400 : (error.statusCode ?? 500);

  // No JSON-RPC id is knowable if we never got far enough to parse a body —
  // the spec explicitly allows `id: null` for exactly this case.
  reply.status(status).send(buildJsonRpcError(null, code, error.message));
}
