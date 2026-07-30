import { z } from 'zod';

/**
 * All runtime configuration is validated once, at boot, via zod — the one
 * place in this codebase where "validate thoroughly" ergonomics are allowed
 * to win over hot-path performance, because this code runs exactly once per
 * process lifetime. Compare to `core/jsonRpc/types.ts`, which hand-rolls its
 * validation because it runs on every request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Upstream MCP server this gateway forwards allowed calls to. */
  MCP_UPSTREAM_URL: z.string().url(),

  /** Comma-separated tool names blocked at the policy layer (mock for Phase 1). */
  MCP_DENIED_TOOLS: z.string().default(''),

  /** Defensive cap on inbound body size, in bytes — MCP payloads can carry large schemas. */
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576), // 1 MiB

  /** Upstream request timeout, in milliseconds. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  CORS_ORIGIN: z.string().default('*'),

  /**
   * Phase 2 (legacy HTTP+SSE transport): interval between keep-alive
   * comment-pings on an open SSE stream. 15-30s is the guideline — long
   * enough to not be chatty, short enough to stay under most intermediate
   * proxies' idle-connection timeouts (commonly 60s).
   */
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20_000),

  /**
   * Phase 3: comma-separated exact-match allowlist for the Origin header,
   * required by the Streamable HTTP spec as a DNS-rebinding mitigation.
   * Left unset, the gateway defaults to loopback-only (any port) — safe for
   * local development, deliberately NOT something to leave unset for a
   * deployment reachable from anywhere but the same machine. See
   * middleware/originGuard.ts.
   */
  ALLOWED_ORIGINS: z.string().optional(),

  /**
   * Phase 3: real ID-JAG verification config. All four are required —
   * unlike ALLOWED_ORIGINS, there's no safe default for "which IdP and
   * which resource should this gateway trust." A missing value here is a
   * deploy-time configuration bug, not something to silently fall back on.
   */
  JWKS_URI: z.string().url(),
  /** Expected "iss" claim — the IdP that must have issued the ID-JAG. */
  ID_JAG_ISSUER: z.string().min(1),
  /** Expected "aud" claim — who the ID-JAG is addressed to (this gateway / EMA client). */
  ID_JAG_AUDIENCE: z.string().min(1),
  /**
   * Expected "resource" claim — the specific MCP server this grant is
   * scoped to. This is the anti-confused-deputy binding: a grant issued for
   * a different resource server must be rejected here even if its
   * signature, issuer, and audience all check out.
   */
  ID_JAG_RESOURCE: z.string().min(1),

  /**
   * Phase 4 — budget/cost-control policy knobs. These are deliberately env
   * vars (ops-configurable business policy) rather than constants in
   * budgetGuard.ts (which holds the token-shape *calibration* constants —
   * how many characters approximate a token — a different, more
   * engineering-facing kind of knob). See services/budgetGuard.ts for the
   * per-team override mechanism layered on top of these defaults.
   */
  /** Default trailing-7-day weighted-token budget for any team without an explicit override. Illustrative default — calibrate to your real provider pricing and team sizes. */
  DEFAULT_TEAM_TOKEN_BUDGET_7D: z.coerce.number().int().positive().default(2_000_000),
  /** How many times a team's recent run-rate must exceed its own pre-spike baseline before that alone (independent of the hard cap) triggers a pause. */
  BUDGET_SPIKE_THRESHOLD_MULTIPLIER: z.coerce.number().positive().default(5),
  /** Weight applied to output tokens (vs. input tokens) in the budget ledger. Illustrative default reflecting that output tokens commonly cost several times more than input tokens across most LLM providers — calibrate to your actual contract pricing. */
  OUTPUT_TOKEN_COST_WEIGHT: z.coerce.number().positive().default(3),

  /**
   * Phase 5 — resume-token signing. Required, no default, same reasoning as
   * JWKS_URI/ID_JAG_* in Phase 3: there is no safe default for a secret
   * that everything downstream trusts. min(32) is a floor on LENGTH, not a
   * guarantee of entropy — generate this with something like
   * `openssl rand -base64 32`, not a human-chosen passphrase.
   *
   * CRITICAL FOR MULTI-REPLICA DEPLOYMENTS: this value MUST be identical
   * across every replica. The entire point of the stateless-signed-token
   * pattern (services/resumeTokenService.ts) is that any replica can verify
   * a token issued by any other replica, with no shared session state. If
   * replicas somehow end up with different secrets (e.g. each generating
   * its own at boot instead of reading a shared configured value), resume
   * verification starts failing unpredictably depending on which replica
   * happens to handle the resume call — silently reintroducing the exact
   * session-affinity requirement this design exists to avoid. This is
   * exactly why there is no auto-generated fallback here.
   */
  HMAC_SECRET: z.string().min(32),
  /** How long a human has to act on a paused call before its resumeToken stops verifying. Ops policy knob, not a crypto parameter — env var, not a code constant, matching the other Phase 4 budget policy knobs above. */
  RESUME_TOKEN_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
});

// Fail fast and loud: an invalid or missing config at boot is a deploy-time
// bug, not something the gateway should limp along with in production.
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

/**
 * Pre-split so `app.ts` (which needs just the origin, to construct the
 * undici `Pool`) and `middleware/proxyInterceptor.ts` (which needs the path,
 * for each individual request) share one parse of `MCP_UPSTREAM_URL` instead
 * of each re-deriving it.
 */
const upstreamUrl = new URL(env.MCP_UPSTREAM_URL);
export const upstream = {
  origin: upstreamUrl.origin,
  path: upstreamUrl.pathname + upstreamUrl.search,
};

/**
 * `null` means "ALLOWED_ORIGINS was not set" — middleware/originGuard.ts
 * treats that as "loopback only, any port," not as "allow everything."
 * An explicitly-configured list REPLACES that default; it does not extend
 * it, so a production deployment that sets this must include its own
 * loopback entries if local access should still work.
 */
export const allowedOrigins: string[] | null = env.ALLOWED_ORIGINS
  ? env.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : null;
