/**
 * MCP-specific shapes layered on top of generic JSON-RPC (see
 * `core/jsonRpc/types.ts`). Only what Phase 1 routing/error-handling needs
 * to reference is modeled here — full tool/resource/prompt schemas are out
 * of scope for this pass.
 */

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Claims SentinelMCP cares about from a validated Identity Assertion JWT
 * Authorization Grant (ID-JAG), per MCP's Enterprise-Managed Authorization
 * extension. A real ID-JAG's JOSE header carries `typ: "oauth-id-jag+jwt"`,
 * and the payload carries standard `iss`/`aud`/`sub`/`exp` plus a `resource`
 * claim binding the grant to one specific MCP server — that binding is what
 * makes the grant non-replayable against a different deputy and is the
 * mechanism that closes the confused-deputy hole. See
 * `services/idJagValidator.ts` for the real JWKS-backed verification.
 */
export interface IdJagClaims {
  issuer: string;
  /** Opaque per-issuer subject — always pair with `issuer` when using as a key, never use alone. */
  subject: string;
  audience: string;
  /** The specific MCP resource server this grant was scoped to. */
  resource: string;
  expiresAt: number;
}

/** Outcome of a policy/budget gate. (Identity has its own richer `IdentityAssertion` shape as of Phase 3 — see `services/idJagValidator.ts` — so this is used for the simpler pass/fail gates.) */
export interface GateDecision {
  allowed: boolean;
  reasonCode?: string;
  message?: string;
}

/**
 * The data an approver or an agent's own UI needs to make an informed
 * override decision when a budget gate pauses a call. Phase 4.
 *
 * Two independent things can trigger a pause, and `triggeredBy` says which:
 * a cumulative `HARD_CAP` breach (the trailing 7-day ledger, plus this
 * request, would exceed the team's configured budget), or an
 * `ANOMALOUS_GROWTH_RATE` early warning (usage is accelerating sharply
 * versus this team's own recent baseline, even though the cumulative total
 * hasn't breached the hard cap yet) — the mechanism `checkBudget` uses to
 * "catch exponential consumption growth early" per the brief, rather than
 * only reacting once the whole budget is already gone.
 */
export interface BudgetProjection {
  /** Weighted tokens already consumed in the trailing 7-day window, before this request. */
  windowUsageTokens: number;
  /** The team's configured 7-day weighted-token budget. */
  limitTokens: number;
  /** How far over the limit this request would push the cumulative ledger. 0 for a purely rate-based (spike-only) trigger. */
  overageTokens: number;
  /** This request's own estimated cost (input + projected output, weighted) — the thing that tipped the scale. */
  requestTokens: number;
  /** Observed weighted tokens/hour over the trailing short window (see SPIKE_WINDOW_HOURS in budgetGuard.ts). */
  currentRunRatePerHour: number;
  /** Weighted tokens/hour over the OLDER portion of the trailing 7-day window — the pre-spike baseline this is measured against. Null without enough history yet to trust a baseline. */
  baselineRunRatePerHour: number | null;
  /** currentRunRatePerHour / baselineRunRatePerHour — the "run-rate forecast spike" metric. Null when baselineRunRatePerHour is null. */
  spikeFactor: number | null;
  /** At the current run rate, hours until the cumulative ledger would hit the limit. Null when not meaningfully projectable (e.g. rate is ~0, or the limit is already breached). */
  projectedHoursToExhaustion: number | null;
  /** Which rule tripped this pause. */
  triggeredBy: 'HARD_CAP' | 'ANOMALOUS_GROWTH_RATE';
}

/**
 * The human-in-the-loop pause response for a budget-gated call. Sketched in
 * Phase 1, wired up for real in Phase 4 — see `services/budgetGuard.ts` and
 * `middleware/proxyInterceptor.ts`. Note this travels as a JSON-RPC
 * *result*, not an *error*: a paused call isn't a protocol failure, it's a
 * legitimate outcome the calling agent loop should branch on, the same way
 * it would branch on any other tool result.
 */
export interface InputRequiredResult {
  status: 'input_required';
  reasonCode: 'BUDGET_EXCEEDED' | 'POLICY_REVIEW';
  message: string;
  /**
   * HMAC-SHA256-signed, request-bound capability token — see
   * `services/resumeTokenService.ts` for the real implementation (Phase 5).
   * Was a bare `randomUUID()` placeholder through Phase 4.
   */
  resumeToken: string;
  /** Present when reasonCode is BUDGET_EXCEEDED. */
  projection?: BudgetProjection;
  /**
   * A minimal, constrained schema describing the input a human approver
   * should supply to resume this call — deliberately an enum decision, not
   * free text. This is a security-relevant choice, not just a UX one: on a
   * gateway whose whole job is guarding against untrusted input reaching an
   * agent loop, a free-text "authorization" channel would itself be a new
   * unvalidated channel back into that loop. An enum can't smuggle
   * instructions.
   */
  authorizationSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

/**
 * The result of a human approver choosing DENY at `POST /mcp/resume`
 * (Phase 5). Travels as a JSON-RPC *result*, same reasoning as
 * `InputRequiredResult` above: the calling agent asked a question ("should
 * this proceed?") and got a real, legitimate answer — "no" — not a
 * protocol failure.
 */
export interface UserCancelledResult {
  status: 'cancelled';
  reasonCode: 'USER_DENIED';
  message: string;
}
