/**
 * src/routes/resume.ts
 *
 * POST /mcp/resume — the human-in-the-loop resume endpoint (Phase 5).
 * Consumes what middleware/proxyInterceptor.ts produces when
 * services/budgetGuard.ts pauses a call: a signed resumeToken, handed back
 * here alongside a human approver's decision and the original request.
 *
 * Registered as its own top-level plugin in app.ts (not nested inside
 * proxyInterceptor.ts), and deliberately re-declares its own `originGuard`
 * hook below rather than relying on inheriting one via Fastify's plugin
 * nesting. Both are the same choice made for the same reason: a reader
 * looking at ONLY this file should be able to see every security check
 * that applies to a resume call without first having to go trace how
 * app.ts happens to nest plugins today. Implicit inheritance is one
 * refactor away from silently breaking; an explicit hook here isn't.
 *
 * SECURITY MODEL — read this before assuming resumeToken possession alone
 * is sufficient to execute a call. It is NOT. A resumeToken proves "this
 * exact call was legitimately paused for this team, by this gateway,
 * recently" — it does not prove "the bearer of this HTTP request is
 * authorized to act as that team." The InputRequiredResult payload
 * carrying the token travels back through the SAME channel the ORIGINAL
 * call used (the calling agent's own response or SSE stream — see
 * proxyInterceptor.ts), which is not a channel scoped to "humans only";
 * anything that can read that response can read the token. So this
 * endpoint re-verifies identity (ID-JAG) and policy (the tool denylist) on
 * the incoming resume request itself, even though the brief only asked to
 * bypass the BUDGET check specifically:
 *
 *   - IDENTITY: re-run validateIdJag on this request's own Authorization
 *     header, and require identity.claims.subject to equal the token's
 *     teamId. Without this, anyone holding a copy of a resumeToken — not
 *     just its legitimate owner — could execute the underlying call with
 *     no credential of their own. Without the team-match check
 *     specifically, team A's paused call could be resumed using team B's
 *     otherwise-valid credentials — a cross-tenant hole.
 *   - POLICY: re-run isToolDenied against the token's toolName. A tool
 *     that was fine when the call was paused might have been denylisted
 *     in the meantime (an admin reacting to exactly the kind of runaway
 *     spend this pause was already warning about); resume shouldn't honor
 *     a stale approval against newly-known-bad state.
 *
 * Validation order below is cheapest/most-fundamental first, same
 * philosophy as proxyInterceptor.ts since Phase 1: body shape, then the
 * token's own validity (pure crypto, no I/O), then the tamper check (pure
 * hashing, no I/O), then identity (JWKS-backed, may involve network I/O),
 * then policy, then finally the side-effecting action itself.
 *
 * REPLAY — see the warning in services/resumeTokenService.ts. This
 * endpoint does not track "already used" tokens; that's an accepted,
 * documented limitation of the stateless design, not an oversight here.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isJsonRpcRequest, type JsonRpcId, type JsonRpcRequest } from '../core/jsonRpc/types.js';
import { JsonRpcErrorCode, buildJsonRpcError } from '../core/jsonRpc/errors.js';
import { buildCancelledResult } from '../core/mcp/inputRequired.js';
import { hashRequest, verifyResumeToken } from '../services/resumeTokenService.js';
import { extractBearerToken, validateIdJag } from '../services/idJagValidator.js';
import { isToolDenied } from '../services/policyStore.js';
import { recordApprovedUsage } from '../services/budgetGuard.js';
import { forwardToUpstream } from '../services/upstreamClient.js';
import { originGuard } from '../middleware/originGuard.js';

/**
 * Loosely typed at the zod layer on purpose: `originalRequest`'s REAL
 * structural validation is `isJsonRpcRequest` (core/jsonRpc/types.ts) —
 * the same function proxyInterceptor.ts uses for the main path. Re-running
 * a second, independent shape check here would just be two definitions of
 * "valid JSON-RPC request" that could quietly drift apart; zod's job is
 * only the outer resume-envelope shape.
 */
const ResumeRequestSchema = z.object({
  resumeToken: z.string().min(1),
  decision: z.enum(['APPROVE', 'DENY']),
  originalRequest: z.record(z.string(), z.unknown()),
});

export const resumeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', originGuard);

  fastify.post('/resume', async (request: FastifyRequest, reply: FastifyReply) => {
    // --- Step 1: outer envelope shape ---
    const parsedBody = ResumeRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      await reply
        .status(400)
        .send(buildJsonRpcError(null, JsonRpcErrorCode.INVALID_REQUEST, 'Malformed resume request body.'));
      return;
    }
    const { resumeToken, decision, originalRequest: rawOriginalRequest } = parsedBody.data;

    if (!isJsonRpcRequest(rawOriginalRequest)) {
      await reply
        .status(400)
        .send(
          buildJsonRpcError(null, JsonRpcErrorCode.INVALID_REQUEST, 'originalRequest is not a valid JSON-RPC 2.0 request.'),
        );
      return;
    }
    const originalRequest: JsonRpcRequest = rawOriginalRequest;
    const id: JsonRpcId = originalRequest.id ?? null;

    // --- Step 2: the resumeToken's own validity (signature + expiry) ---
    const tokenVerification = verifyResumeToken(resumeToken);
    if (!tokenVerification.valid) {
      request.log.warn({ reason: tokenVerification.reason }, 'resume rejected: invalid or expired resumeToken');
      await reply
        .status(401)
        .send(buildJsonRpcError(id, JsonRpcErrorCode.RESUME_TOKEN_INVALID, 'Resume token is invalid or has expired.'));
      return;
    }
    const { payload: tokenPayload } = tokenVerification;

    // --- Step 3: tamper check — does originalRequest hash to what was actually paused? ---
    if (hashRequest(originalRequest) !== tokenPayload.requestHash) {
      request.log.warn(
        { teamId: tokenPayload.teamId, toolName: tokenPayload.toolName },
        'resume rejected: originalRequest does not match the hash bound to this resumeToken (tampering suspected)',
      );
      await reply
        .status(409)
        .send(
          buildJsonRpcError(
            id,
            JsonRpcErrorCode.RESUME_REQUEST_MISMATCH,
            'The submitted request does not match what was originally paused.',
          ),
        );
      return;
    }

    // --- Step 4: identity — re-verify the CALLER of this resume request, not just the token ---
    const idJagToken = extractBearerToken(request.headers.authorization);
    const identity = await validateIdJag(idJagToken, request.log);
    if (!identity.valid) {
      await reply
        .status(401)
        .send(buildJsonRpcError(id, JsonRpcErrorCode.IDENTITY_REJECTED, identity.reason ?? 'Identity assertion rejected.'));
      return;
    }
    const callerTeamId = identity.claims?.subject ?? 'unknown-team';
    if (callerTeamId !== tokenPayload.teamId) {
      request.log.warn(
        { callerTeamId, tokenTeamId: tokenPayload.teamId },
        'resume rejected: caller identity does not match the team this resumeToken was issued for',
      );
      await reply
        .status(403)
        .send(
          buildJsonRpcError(
            id,
            JsonRpcErrorCode.IDENTITY_REJECTED,
            'Caller identity does not match the team this resume token was issued for.',
          ),
        );
      return;
    }

    // --- Step 5: policy — re-check the tool isn't denylisted NOW, even if it wasn't when paused ---
    if (tokenPayload.toolName && isToolDenied(tokenPayload.toolName)) {
      await reply
        .status(403)
        .send(
          buildJsonRpcError(id, JsonRpcErrorCode.POLICY_DENIED, `Tool "${tokenPayload.toolName}" is denied by policy.`),
        );
      return;
    }

    // --- Step 6: the decision itself ---
    if (decision === 'DENY') {
      request.log.info({ teamId: callerTeamId, toolName: tokenPayload.toolName }, 'call cancelled: human approver denied');
      await reply.status(200).send(buildCancelledResult(id));
      return;
    }

    // decision === 'APPROVE': bypass the standard budget gate for this one
    // request specifically — everything above it (identity, policy,
    // tamper-binding) still applied in full.
    try {
      const upstreamResult = await forwardToUpstream(fastify, originalRequest, request.headers);
      await recordApprovedUsage(callerTeamId, tokenPayload.toolName, originalRequest, upstreamResult);
      request.log.info(
        { teamId: callerTeamId, toolName: tokenPayload.toolName },
        'call resumed: human approver approved, budget gate bypassed for this call',
      );
      // Relay directly, same as proxyInterceptor.ts's own direct (no-
      // sessionId) path — upstreamResult IS already a complete JSON-RPC
      // envelope (the upstream MCP server's own jsonrpc/id/result object),
      // not a bare payload that needs wrapping. Wrapping it again here
      // would nest one JSON-RPC envelope inside another.
      await reply.status(200).send(upstreamResult);
    } catch (err) {
      request.log.error({ err }, 'upstream MCP server call failed on resume');
      await reply
        .status(502)
        .send(buildJsonRpcError(id, JsonRpcErrorCode.UPSTREAM_UNAVAILABLE, 'Upstream MCP server did not respond.'));
    }
  });
};
