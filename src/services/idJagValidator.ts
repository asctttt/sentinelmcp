import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env.js';
import type { IdJagClaims } from '../core/mcp/types.js';

/**
 * Real ID-JAG (Identity Assertion JWT Authorization Grant) verification,
 * per MCP's Enterprise-Managed Authorization extension. Replaces the Phase
 * 1 mock, which always returned `valid: true`.
 *
 * The client exchanges the user's IdP identity token for an ID-JAG scoped
 * to one specific MCP resource server via RFC 8693 token exchange, then
 * presents that grant to this gateway as a bearer token. Verifying it means:
 *
 *   1. Signature verification against the IdP's live JWKS. createRemoteJWKSet
 *      handles fetching, caching, and re-fetching on an unseen "kid" for us
 *      — no separate caching layer to build here.
 *   2. iss / aud / exp / typ, all checked via jose's built-in claim
 *      verification (`issuer`, `audience`, `typ`, `requiredClaims` options
 *      below) — jose throws a specifically-typed error for whichever one
 *      fails, which is what classifyAndLog() branches on.
 *   3. The "resource" claim — not a registered JWT claim, so jose has no
 *      built-in option for it — checked manually against ID_JAG_RESOURCE.
 *      This is the anti-confused-deputy binding: a grant scoped to a
 *      DIFFERENT MCP server must be rejected here even with a perfectly
 *      valid signature, issuer, and audience, or a grant legitimately
 *      issued for one deputy could be replayed against another.
 *
 * Unlike the Phase 1 mock, there is no permissive fallback for a missing or
 * unverifiable token: every call resolves to either `valid: true` with real
 * claims, or `valid: false`. This function never throws. jose's errors are
 * caught and translated into a generic, safe reason string — the detailed
 * error (which can include claim values from the token) is only ever
 * logged, never returned to the caller.
 */

export interface IdentityAssertion {
  valid: boolean;
  claims?: IdJagClaims;
  reason?: string;
}

/**
 * Extracts a bearer token from an `Authorization: Bearer <token>` header.
 * Lives here (not a generic HTTP-utils file) because its entire purpose is
 * producing the string `validateIdJag` needs — every caller that needs one
 * needs the other. Used by middleware/proxyInterceptor.ts and, as of Phase
 * 5, routes/resume.ts too (the resume endpoint re-verifies identity on its
 * own incoming request — see that file's module doc for why).
 */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

const REQUIRED_TYP = 'oauth-id-jag+jwt';

/**
 * Asymmetric algorithms only. Never allow a JWT to declare a symmetric alg
 * like HS256 here — accepting one would open the classic "trick the
 * verifier into treating a known public key as an HMAC secret" algorithm-
 * confusion attack. RS/ES cover the overwhelming majority of enterprise
 * IdPs (Okta, Auth0, Azure AD, etc.); extend only if a specific IdP needs it.
 */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

// Resolves and caches signing keys from the IdP's JWKS endpoint. Built once
// at module load — like the upstream undici Pool in app.ts — not per
// request. The returned function IS what gets passed to jwtVerify; it
// manages its own fetch/cache lifecycle (default: re-fetch on an unseen
// kid, no more than once per cooldownDuration).
const jwks = createRemoteJWKSet(new URL(env.JWKS_URI), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
});

export async function validateIdJag(token: string | undefined, log: Logger = consoleLogger): Promise<IdentityAssertion> {
  if (!token) {
    return { valid: false, reason: 'Missing bearer token.' };
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ID_JAG_ISSUER,
      audience: env.ID_JAG_AUDIENCE,
      algorithms: ALLOWED_ALGORITHMS,
      typ: REQUIRED_TYP,
      requiredClaims: ['exp', 'sub'],
      clockTolerance: 5, // seconds — absorbs small clock skew between hosts
    });

    if (typeof payload.resource !== 'string' || payload.resource !== env.ID_JAG_RESOURCE) {
      return { valid: false, reason: 'Token is not scoped to this MCP resource server.' };
    }

    // requiredClaims above already guarantees these are present at
    // runtime; TypeScript can't see that, so narrow explicitly rather than
    // cast, so IdJagClaims stays honestly typed as non-optional.
    if (typeof payload.sub !== 'string' || typeof payload.iss !== 'string' || typeof payload.exp !== 'number') {
      return { valid: false, reason: 'Token is missing required claims.' };
    }

    return {
      valid: true,
      claims: {
        issuer: payload.iss,
        subject: payload.sub,
        // The value THIS gateway validated against, not the token's raw
        // (possibly multi-valued) aud claim — more meaningful to record.
        audience: env.ID_JAG_AUDIENCE,
        resource: payload.resource,
        expiresAt: payload.exp,
      },
    };
  } catch (err) {
    return { valid: false, reason: classifyAndLog(err, log) };
  }
}

interface Logger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Falls back to plain console output for standalone/test usage outside a Fastify request. */
const consoleLogger: Logger = {
  warn: (obj, msg) => console.warn(`[idJagValidator] ${msg}`, obj),
  error: (obj, msg) => console.error(`[idJagValidator] ${msg}`, obj),
};

/**
 * Every jose error extends JOSEError with a stable `.code`; the more
 * specific subclasses carry extra structured detail (e.g.
 * JWTClaimValidationFailed.claim). Logging that detail server-side while
 * returning only a generic reason to the caller is the whole point of this
 * function — never let a verification failure leak claim values back out.
 */
function classifyAndLog(err: unknown, log: Logger): string {
  if (err instanceof joseErrors.JWTExpired) {
    log.warn({ code: err.code }, 'ID-JAG rejected: token expired');
    return 'Token has expired.';
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    log.warn({ code: err.code, claim: err.claim, reason: err.reason }, 'ID-JAG rejected: claim validation failed');
    return `Token claim "${err.claim}" is invalid.`;
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    log.warn({ code: err.code }, 'ID-JAG rejected: signature verification failed');
    return 'Token signature is invalid.';
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    log.warn({ code: err.code }, 'ID-JAG rejected: no matching key in JWKS');
    return 'Token was signed by an unrecognized key.';
  }
  if (err instanceof joseErrors.JWKSTimeout) {
    log.error({ code: err.code }, 'ID-JAG verification failed: JWKS endpoint unreachable or timed out');
    return 'Identity provider is temporarily unreachable.';
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    log.warn({ code: err.code }, 'ID-JAG rejected: disallowed signing algorithm');
    return 'Token uses an unsupported signing algorithm.';
  }
  if (err instanceof joseErrors.JOSEError) {
    log.warn({ code: err.code, message: err.message }, 'ID-JAG rejected: token verification failed');
    return 'Token could not be verified.';
  }
  log.error({ err }, 'ID-JAG verification failed: unexpected non-JOSE error');
  return 'Token could not be verified.';
}
