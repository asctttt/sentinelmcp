# Engineering log

This is the detailed build record for SentinelMCP: what was verified, how,
what broke during development and how it was fixed, and every known
limitation that's been deliberately accepted rather than silently ignored.
The top-level [README](../README.md) is the pitch and the quickstart; this
is the paper trail behind it.

If you're deciding whether to deploy this, the "Known gaps and constraints"
section at the bottom is the one to read first.

---

# SentinelMCP — Phases 1 through 6

Stateless enterprise policy firewall and cost proxy for the Model Context
Protocol (MCP).

- **Phase 1:** Fastify gateway, JSON-RPC protocol routing, error handling,
  Streamable HTTP transport.
- **Phase 2:** legacy HTTP+SSE transport (deprecated since MCP spec
  2025-03-26, kept for backward compatibility only).
- **Phase 3:** Origin header validation (DNS-rebinding mitigation) and real
  ID-JAG verification via JWKS.
- **Phase 4:** real token-cost estimation and sliding-window budget
  enforcement. A denied call *pauses* (`InputRequiredResult`, a JSON-RPC
  success) rather than hard-erroring.
- **Phase 5:** `POST /mcp/resume` — the human-in-the-loop resume endpoint.
  Stateless, HMAC-SHA256-signed, request-bound resume tokens; APPROVE
  bypasses the budget gate for that one call, DENY returns an explicit
  cancellation result.
- **Phase 6:** a permanent, checked-in automated test suite — see
  "Testing" below. Every prior phase was hand-verified but nothing was
  kept; this closes that gap.

The original brief's every stated mechanism is now real. `policyStore.ts`
(tool denylist) and `budgetGuard.ts`'s per-team policy overrides remain
deliberately simple in-memory stand-ins for what would be a database in
production — same reasoning as always: mock what's genuinely out of scope
for a given phase, with a clean swap-out interface.

## Testing

Every phase of this project was verified by hand — real running processes,
real signed tokens, real HTTP calls — but that verification lived in
throwaway scripts, explicitly excluded from every deliverable. Phase 6
converts that into a permanent, checked-in suite:

```bash
npm test          # human-readable output (spec reporter)
npm run test:watch  # re-runs on file changes
npm run test:ci     # plain TAP, for machine-parseable CI output
```

**63 tests, 19 suites, all passing.** No new test-framework dependency —
built on Node's own `node:test` + `node:assert/strict`, matching this
project's general preference for minimal dependencies where reasonable
(the same reasoning behind hand-rolling `isJsonRpcRequest` and using
`node:crypto` directly for `resumeTokenService.ts`).

```
test/
├── unit/
│   ├── jsonRpc.test.ts       # isJsonRpcRequest, isNotification, buildJsonRpcError (22)
│   ├── mcpHeaders.test.ts    # fast-path header hint vs. body-derived route info (8)
│   ├── resumeToken.test.ts   # HMAC issue/verify, expiry, tampering, canonicalization (12)
│   └── budgetGuard.test.ts   # sliding window, spike detection, true-up, clock-injected (7)
└── integration/
    ├── helpers/testHarness.ts # real ephemeral-port mock IdP + mock upstream, real buildApp()
    └── gateway.test.ts        # fastify.inject() end-to-end: origin, policy, identity,
                                # the full allowed path, and the complete pause→resume flow (14)
```

Integration tests use `fastify.inject()` against a real `buildApp()`
instance — this is exactly what Phase 1's own `app.ts` doc comment
anticipated ("buildApp() returns a fully wired Fastify instance without
binding a port... no real socket, no port conflicts, no upstream needed
for most cases"), finally acted on. The mock IdP is a genuine RSA keypair
and a genuine JWKS HTTP endpoint on an OS-assigned ephemeral port — not a
stub — so identity tests exercise the real `jose`-based verification path,
including the anti-confused-deputy resource-binding check, through the
actual gateway.

**Not covered here, deliberately:** the legacy SSE transport. `GET /mcp`
hijacks the raw response and streams indefinitely, a poor fit for
`.inject()` (built for request/response, not long-lived streams). It has
thorough, repeated real-socket verification across Phases 2–4 already; a
real-socket test could be added later if this boundary needs closing.

**One real bug this immediately caught:** `LOG_LEVEL`'s zod enum was
missing `'silent'` — a genuine, documented pino level — since Phase 1.
Harmless in practice (nothing defaults to it), but a real gap in what
operators could legally configure. Fixed in `config/env.ts`.

## The resume flow (Phase 5)

`POST /mcp/resume` with `{ resumeToken, decision: 'APPROVE'|'DENY', originalRequest }`.

**Security model** — a resumeToken alone is NOT sufficient to execute a
call. It proves "this exact call was legitimately paused, recently, for
this team" — not "the bearer of this HTTP request is authorized to act as
that team." The token travels back through the same channel the original
call used (the agent's own response, or an SSE stream), which isn't a
"humans only" channel — anything that can read that response can read the
token. So beyond what the brief asked (bypass budget only), this endpoint
also:
- **Re-verifies identity** (ID-JAG) on the resume request itself, and
  requires the caller's team to match the token's `teamId` — without this,
  anyone holding a copy of a token, not just its legitimate recipient,
  could execute the call; without the team-match check specifically,
  one team's paused call could be resumed with a different team's
  credentials.
- **Re-checks policy** (tool denylist) against the token's `toolName` — a
  tool that was fine at pause-time might have been denylisted since (an
  admin reacting to exactly the kind of spend this pause already flagged).

Validation order, cheapest/most-fundamental first: request-body shape →
token signature + expiry (pure crypto) → request-hash tamper check (pure
hashing) → identity (JWKS-backed, may involve network I/O) → policy →
the decision itself.

**Request-hash binding** — the token encodes a SHA-256 hash of a
*canonical* (recursively key-sorted) serialization of the original
request, so a client re-serializing it differently at resume-time doesn't
false-positive as tampering, while any actual change to the content
(amount, recipient, arguments — anything) does correctly invalidate the
hash. Array order is preserved (semantically meaningful), only object key
order is normalized.

**Replay is NOT prevented.** This is the accepted, documented trade-off of
a purely stateless token — see the warning at the top of
`services/resumeTokenService.ts`. The same valid resumeToken can be
resubmitted within its expiry window and (if APPROVE) re-executes the
call each time. `recordApprovedUsage` still charges the ledger on every
resume, replayed or not, which is a partial throttle, not a fix. Two real
upgrade paths documented in that file if your threat model needs this
closed, neither built by default here (both would add state to a
component whose entire point, as specified, is to have none).

## What's verified

Every phase has been actually run, not just typed — see prior review notes
for Phases 1–4. Phase 5 specifically:

**`resumeTokenService.ts` directly (23 checks, all passing):** valid
issue/verify round-trip; `toolName: undefined` round-trips as `undefined`,
not the string `"undefined"`; still-valid vs. expired at the right
boundary; a tampered payload (flipped field, unfixed signature) rejected;
a token forged with the wrong secret rejected; five kinds of garbage input
all rejected without throwing; canonicalization confirmed key-order-
independent for objects; a full issue→verify→tamper-check round trip
confirming a substituted `amount` or recipient is caught; array
*reordering* confirmed to correctly change the hash (unlike object keys).

**Live gateway, full resume flow (10 scenarios, all against the real
running gateway with a real signed pause and a real upstream call):** a
real pause captured with a real signed resumeToken; APPROVE actually
executing the upstream call (confirmed via the mock upstream's own
request log, not just the HTTP status) and returning a correctly-shaped,
non-double-wrapped response; DENY returning the cancellation result
*and* confirmed not reaching upstream; a tampered `originalRequest`
correctly rejected with `409 RESUME_REQUEST_MISMATCH`; a cross-tenant
resume attempt (team A's token, team B's valid credentials) correctly
rejected; a resumeToken crafted for a since-irrelevant-but-denylisted tool
correctly rejected by the policy re-check; a genuinely expired token
correctly rejected; a replayed APPROVE token confirmed to succeed again
(empirically validating the documented limitation, not just asserting it
in a comment); the Origin guard confirmed to apply to `/mcp/resume`
itself, proving the explicit (not inherited) hook registration works;
and independent per-team ledger isolation confirmed for a fresh team.

**Two real bugs found and fixed during this build:**
1. The APPROVE success path was wrapping the upstream's own already-
   complete JSON-RPC envelope inside a second one
   (`{jsonrpc,id,result:{jsonrpc,id,result:{...}}}`) — caught by actually
   reading the response body in the first test run, not just checking the
   HTTP status code, which alone would have shown a clean `200`. Fixed to
   relay `upstreamResult` directly, matching the established pattern in
   `proxyInterceptor.ts`'s own direct path.
2. My own first attempt at an "expired token" test used a TTL offset
   (-1000ms) smaller than `CLOCK_TOLERANCE_MS` (5000ms), so the crafted
   token was legitimately still inside the tolerance window — the
   verification logic was working correctly; the test parameter wasn't
   unambiguous. Traced through the exact tolerance arithmetic before
   concluding that, fixed the test (-60000ms), re-confirmed genuine
   rejection.

## Directory structure

```
src/
├── index.ts, app.ts                # app.ts: + resumeRoutes registration
├── config/env.ts                    # + HMAC_SECRET, RESUME_TOKEN_TTL_MS
├── core/
│   ├── jsonRpc/                     # + RESUME_TOKEN_INVALID, RESUME_REQUEST_MISMATCH
│   └── mcp/
│       ├── types.ts                 # + UserCancelledResult
│       └── inputRequired.ts         # buildInputRequiredResult now mints a REAL signed
│                                     # token; + buildCancelledResult
├── middleware/
│   ├── proxyInterceptor.ts          # forwardToUpstream/extractBearerToken extracted out;
│   │                                 # buildInputRequiredResult call site updated
│   └── originGuard.ts               # unchanged (Phase 3), reused directly by resume.ts
├── routes/
│   ├── health.ts                    # unchanged
│   └── resume.ts                    # NEW — POST /mcp/resume
├── services/
│   ├── resumeTokenService.ts        # NEW — HMAC signing/verification, canonical hashing
│   ├── upstreamClient.ts            # NEW — forwardToUpstream, extracted from proxyInterceptor.ts
│   ├── idJagValidator.ts            # + extractBearerToken (moved here from proxyInterceptor.ts)
│   ├── budgetGuard.ts               # + recordApprovedUsage
│   ├── policyStore.ts               # still mocked, deliberately
│   └── sessionManager.ts            # unchanged (Phase 2)
├── plugins/, types/                 # unchanged
test/
├── unit/                             # jsonRpc, mcpHeaders, resumeToken, budgetGuard
└── integration/                      # gateway.test.ts + the shared mock-IdP/upstream harness
```

(src/config/env.ts also gained `'silent'` to the `LOG_LEVEL` enum in
Phase 6 — a genuine gap since Phase 1, caught by the test harness's own
setup, not a Phase 6-specific addition.)

## Known gaps and constraints (tracked, not forgotten)

- **Resume-token replay is not prevented** — see "The resume flow" above.
- **Legacy SSE statelessness constraint, budget-ledger statelessness
  constraint** — unchanged from Phases 2/4; still the two stateful
  subsystems. `resumeTokenService.ts` is deliberately NOT a third one.
- **Resuming a call originally paused over the legacy SSE transport
  delivers its result directly in the resume POST's own response, not
  back over the original SSE stream.** The resume request body (per spec)
  carries no `sessionId`, and re-correlating to a possibly-already-closed
  SSE session on a possibly-different replica would be real, unrequested
  complexity for this phase. Noted as a boundary, not a bug.
- **No admin UI / notification channel for surfacing a pause to an actual
  human.** Out of scope for this phase — SentinelMCP produces the
  `InputRequiredResult` and consumes the resulting decision; how a human
  actually sees the pause and records APPROVE/DENY is the calling agent
  platform's concern.
- **`Origin` validation, real ID-JAG verification, real budget accounting**
  — unchanged from Phases 3–4; all real now, no remaining TODOs there.
