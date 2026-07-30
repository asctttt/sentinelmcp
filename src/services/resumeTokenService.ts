import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import type { JsonRpcRequest } from '../core/jsonRpc/types.js';

/**
 * Stateless, HMAC-SHA256-signed resume tokens for the Phase 5
 * human-in-the-loop flow (see routes/resume.ts). Deliberately built on
 * Node's native `crypto` rather than `jose` (already a dependency, used for
 * ID-JAG in Phase 3) — this is a narrow, symmetric, internally-issued
 * capability token, not an identity credential, and doesn't need JOSE's
 * header/claims machinery. Format is JWT-*shaped* (two base64url segments
 * joined by `.`) for familiarity, but deliberately does NOT claim to BE a
 * JWT (no `alg`/`typ` header segment) — it isn't interoperable with JWT
 * tooling and shouldn't imply that it is.
 *
 * SECURITY PROPERTIES this token provides:
 *   - Unforgeable without HMAC_SECRET (signature verified in constant time).
 *   - Tamper-evident: any change to teamId/toolName/requestHash/timestamps
 *     invalidates the signature.
 *   - Request-bound: `requestHash` ties the token to the EXACT JSON-RPC
 *     call that was paused, via a canonical (key-order-independent)
 *     serialization — see canonicalJsonStringify below for why this
 *     matters. Without this binding, an approval for one call could be
 *     silently redirected to execute a different one.
 *   - Time-bounded: expires on its own, no revocation needed for that.
 *
 * SECURITY PROPERTY THIS TOKEN DOES **NOT** PROVIDE — replay prevention.
 * This is a real, known limitation of the pattern, not an oversight: a
 * purely stateless token has no server-side record of "already used," so
 * the same valid resumeToken can be submitted to POST /mcp/resume more
 * than once within its expiry window, and (if decision=APPROVE) would
 * execute the underlying call again each time. This is the direct
 * trade-off for the property this design exists to provide — any replica
 * can verify any other replica's token with zero shared state. Two ways to
 * close this, if your threat model needs it, neither implemented here to
 * keep this phase's stated architecture intact:
 *   (a) A short-TTL "seen" cache (even an in-memory Set, expiring
 *       naturally alongside the token) — cheap, but reintroduces
 *       per-replica state, the same category of trade-off already made
 *       explicitly for services/sessionManager.ts and the ledger in
 *       services/budgetGuard.ts.
 *   (b) A real shared store (Redis SETNX on the token's signature, TTL'd
 *       to match expiresAt) — closes the gap even across replicas, at the
 *       cost of a network round-trip on every resume.
 * Note `routes/resume.ts` still calls `recordApprovedUsage` on every
 * resume, replayed or not — so a replayed APPROVE isn't a "free" bypass,
 * it keeps charging the team's ledger each time, which is a partial,
 * indirect throttle but not a real fix.
 */

export interface ResumeTokenPayload {
  teamId: string;
  /** Absent for a paused call that didn't resolve to a specific tool. */
  toolName: string | undefined;
  /** Hex-encoded SHA-256 digest of the canonicalized original JSON-RPC request. */
  requestHash: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * A discriminated union on `valid`, matching the pattern already used for
 * `BudgetCheck` in services/budgetGuard.ts: lets a caller that has checked
 * `.valid === true` access `.payload` with TypeScript proving it's present,
 * no non-null assertion needed.
 */
export type ResumeTokenVerification =
  | { valid: true; payload: ResumeTokenPayload }
  | { valid: false; reason: string };

/** Injectable clock, same pattern as services/budgetGuard.ts, so expiry logic is deterministically testable. Kept as its own tiny local type rather than importing budgetGuard's — not worth coupling two otherwise-unrelated services over a one-line alias. */
type Clock = () => number;
const realClock: Clock = () => Date.now();

/** Absorbs small clock skew between replicas issuing vs. verifying a token — same reasoning as the 5s clockTolerance already used for jose's jwtVerify in services/idJagValidator.ts. */
const CLOCK_TOLERANCE_MS = 5_000;

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Canonical JSON — makes hashRequest robust to key-order differences
// between how proxyInterceptor.ts happened to receive the original request
// and how a client re-serializes it into `originalRequest` on resume.
// Object keys are sorted recursively; array element ORDER is preserved
// (unlike object keys, array order is semantically meaningful — reordering
// `arguments: [1,2,3]` to `[3,2,1]` is a different call, not the same call
// serialized differently).
// ---------------------------------------------------------------------------

function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) return 'null'; // shouldn't occur for a real parsed JSON-RPC body; fail to a deterministic, safe representation rather than producing the bare word `undefined`
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined) // matches JSON.stringify's own behavior: undefined-valued properties are omitted, not serialized
    .sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return '{' + parts.join(',') + '}';
}

/**
 * Public entry point for both sides of the hash-binding check: called in
 * proxyInterceptor.ts at pause-time (hashing the real, parsed `body`) and
 * again in routes/resume.ts at resume-time (hashing the client-submitted
 * `originalRequest`). Both call sites MUST use this same function — that's
 * the whole guarantee.
 */
export function hashRequest(body: JsonRpcRequest): string {
  return createHash('sha256').update(canonicalJsonStringify(body)).digest('hex');
}

// ---------------------------------------------------------------------------
// Sign / issue
// ---------------------------------------------------------------------------

function sign(encodedPayload: string): string {
  return createHmac('sha256', env.HMAC_SECRET).update(encodedPayload).digest('base64url');
}

export function issueResumeToken(
  claims: Pick<ResumeTokenPayload, 'teamId' | 'toolName' | 'requestHash'>,
  ttlMs: number = DEFAULT_TTL_MS,
  clock: Clock = realClock,
): string {
  const issuedAt = clock();
  const payload: ResumeTokenPayload = { ...claims, issuedAt, expiresAt: issuedAt + ttlMs };
  // Plain JSON.stringify here, deliberately — this object is constructed
  // by exactly one piece of code (this function), always in the same key
  // order, so there is no "a different party might reorder these keys"
  // risk the way there is for hashRequest's input. Canonicalization exists
  // to solve a specific cross-party problem this isn't.
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/** Decodes two base64url strings and compares them in constant time. Node's Buffer decoder is lenient (never throws on malformed base64url — it just decodes what it can), so this never throws; a garbled signature simply fails the length or byte comparison like any other wrong signature. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'base64url');
  const bufB = Buffer.from(b, 'base64url');
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false — checking first both avoids the throw AND is safe to do with a
  // plain (non-constant-time) comparison, since signature length isn't
  // secret-dependent (HMAC-SHA256 always produces the same length output).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyResumeToken(token: string, clock: Clock = realClock): ResumeTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'malformed token structure' };
  }
  const [encodedPayload, providedSignature] = parts as [string, string];

  // Signature check BEFORE touching payload contents at all — an attacker
  // who can't produce a valid signature shouldn't get any additional
  // information from how their forged payload happens to parse.
  if (!constantTimeEqual(sign(encodedPayload), providedSignature)) {
    return { valid: false, reason: 'signature verification failed' };
  }

  let payload: ResumeTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as ResumeTokenPayload;
  } catch {
    return { valid: false, reason: 'payload is not valid JSON' };
  }

  if (
    typeof payload.teamId !== 'string' ||
    typeof payload.requestHash !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'payload is missing required fields' };
  }

  const now = clock();
  if (now > payload.expiresAt + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'token has expired' };
  }
  // Defense-in-depth sanity check, not the primary security property (that's
  // the signature + expiry above) — catches a token whose issuedAt is
  // nonsensically in the future, which shouldn't occur from this module's
  // own issueResumeToken but is cheap to rule out explicitly.
  if (payload.issuedAt > now + CLOCK_TOLERANCE_MS) {
    return { valid: false, reason: 'token issuedAt is in the future' };
  }

  return { valid: true, payload };
}
