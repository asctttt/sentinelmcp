import { hashRequest, issueResumeToken } from '../../services/resumeTokenService.js';
import { env } from '../../config/env.js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcSuccess } from '../jsonRpc/types.js';
import type { BudgetProjection, InputRequiredResult, UserCancelledResult } from './types.js';

/**
 * Assembles the two JSON-RPC success envelopes the Phase 5 human-in-the-loop
 * flow produces. Mirrors `core/jsonRpc/errors.ts`'s `buildJsonRpcError` —
 * same "types file stays pure types, this file builds the wire object" split.
 */

/**
 * Builds the pause payload, including a REAL, request-bound, HMAC-signed
 * resumeToken (Phase 5 — see `services/resumeTokenService.ts`). Through
 * Phase 4 this minted a bare `randomUUID()` with nothing on the other end
 * of it; `routes/resume.ts` is that other end now.
 *
 * Takes the full `originalRequest` (not just its id) because the token
 * must bind to the EXACT call that was paused — `hashRequest` computes a
 * canonical-JSON hash of it, which `routes/resume.ts` re-derives from
 * whatever the client submits back at resume-time and compares. That
 * comparison is what stops an approval for one call being redirected to a
 * different one.
 */
export function buildInputRequiredResult(
  id: JsonRpcId,
  projection: BudgetProjection,
  teamId: string,
  toolName: string | undefined,
  originalRequest: JsonRpcRequest,
): JsonRpcSuccess<InputRequiredResult> {
  const resumeToken = issueResumeToken(
    { teamId, toolName, requestHash: hashRequest(originalRequest) },
    env.RESUME_TOKEN_TTL_MS,
  );

  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'input_required',
      reasonCode: 'BUDGET_EXCEEDED',
      message: describeProjection(projection),
      resumeToken,
      projection,
      authorizationSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            // Must match exactly what POST /mcp/resume actually accepts
            // (routes/resume.ts) — this schema is a machine-readable
            // contract, not just descriptive text; a mismatch here would
            // mean a well-behaved caller following the schema still gets
            // rejected by the real endpoint.
            enum: ['APPROVE', 'DENY'],
            description: 'Whether a human approver authorizes this specific call to proceed despite the budget breach.',
          },
          justification: {
            type: 'string',
            description: 'Free-text reason for the override decision, recorded for audit purposes only — not interpreted as an instruction.',
          },
        },
        required: ['decision'],
      },
    },
  };
}

/** Builds the DENY-path response for routes/resume.ts. Kept here alongside buildInputRequiredResult since both are "assemble the wire result for a human-in-the-loop outcome." */
export function buildCancelledResult(id: JsonRpcId): JsonRpcSuccess<UserCancelledResult> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'cancelled',
      reasonCode: 'USER_DENIED',
      message: 'A human approver denied this call. It was not executed.',
    },
  };
}

function describeProjection(projection: BudgetProjection): string {
  if (projection.triggeredBy === 'HARD_CAP') {
    return (
      `Team token budget exceeded: this call would use the team's trailing 7-day budget to ` +
      `${projection.windowUsageTokens + projection.requestTokens} tokens against a limit of ` +
      `${projection.limitTokens} (${projection.overageTokens} over). Human authorization is required to proceed.`
    );
  }
  const spike = projection.spikeFactor?.toFixed(1) ?? 'n/a';
  return (
    `Team token budget paused: usage is running at ~${Math.round(projection.currentRunRatePerHour)} tokens/hour, ` +
    `${spike}x this team's recent baseline of ~${Math.round(projection.baselineRunRatePerHour ?? 0)} tokens/hour. ` +
    `Human authorization is required before continuing at this rate.`
  );
}
