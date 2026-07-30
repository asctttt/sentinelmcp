/**
 * src/middleware/proxyInterceptor.ts
 *
 * The Fastify plugin that turns SentinelMCP into an actual gateway.
 * Registered with `{ prefix: '/mcp' }` in app.ts. Two transports live here
 * side by side:
 *
 *   - Streamable HTTP (Phase 1, current MCP standard since spec 2025-03-26):
 *     POST /mcp with no `sessionId` query param. Request in, response out,
 *     same HTTP round trip. This is what a current Claude Desktop or Cursor
 *     custom connector actually speaks — it is the PRIMARY path, not a
 *     fallback.
 *
 *   - Legacy HTTP+SSE (Phase 2, spec 2024-11-05, deprecated since
 *     2025-03-26): GET /mcp opens a stream and hands back a session-scoped
 *     POST URL; POST /mcp?sessionId=... delivers a request whose result is
 *     pushed back asynchronously as an SSE `message` event, not in the POST
 *     response. Compatibility-only; new integrations should not target it.
 *
 * Request lifecycle, POST /mcp (either transport):
 *
 *   onRequest   (headers only — Fastify has not parsed the body yet)
 *     -> Stage 0 (Phase 3): Origin header validation. See originGuard.ts.
 *     -> Stage 1: fast-path pre-filter, unchanged from Phase 1: optional
 *        Mcp-Method/Mcp-Name headers can only REJECT early, never allow.
 *
 *   route handler
 *     1. Validate the JSON-RPC 2.0 envelope shape.
 *     2. Resolve method/tool name from the BODY — authoritative.
 *     3. Re-run the policy check unconditionally.
 *     4. Validate identity (ID-JAG — real JWKS-backed verification, Phase 3).
 *     5. Check team budget (Phase 4: real sliding-window enforcement). A
 *        denial no longer hard-errors the call — see "The pause flow" below.
 *     6. A notification (no `id`) is fire-and-forget on every transport —
 *        forward it, 202, done. There's nothing to correlate a response to.
 *     7. A real request with `?sessionId=` present: forward asynchronously,
 *        push the result to that SSE stream as an `event: message`, and
 *        respond 202 to *this* POST immediately — the 202 means "accepted,"
 *        not "completed," which is the entire point of the async pattern.
 *     8. A real request with no `sessionId`: Phase 1 behavior, unchanged —
 *        await the upstream call, true up the budget ledger with the REAL
 *        response size (Phase 4), and return the result directly.
 *
 * Request lifecycle, GET /mcp (legacy transport only):
 *     1. Require `Accept: text/event-stream` — this transport IS an SSE
 *        stream, there's no alternative representation to negotiate.
 *     2. Generate a sessionId, open the stream, send the `endpoint` event.
 *     3. Register with sessionManager (heartbeats, cleanup-on-close).
 *
 * The pause flow (Phase 4, resumable since Phase 5): when checkBudget
 * denies a request, the call is NOT hard-errored — it's paused. The client
 * gets a normal JSON-RPC *success* response whose result is an
 * `InputRequiredResult` (see core/mcp/types.ts and core/mcp/inputRequired.ts),
 * carrying the cost projection, a signed resumeToken, and a constrained
 * schema for a human approver's decision. Two subtleties this needed:
 *
 *   - TRANSPORT-AWARE DELIVERY. A legacy-SSE client is listening on its
 *     open GET stream for `event: message`, not on this POST's own response
 *     body (which it already expects to be an empty 202, per the Phase 2
 *     handshake contract). If the pause notice only ever went out as this
 *     POST's direct response, an SSE-transport agent would never see it —
 *     so the budget-denial branch below re-checks `sessionId`, the same way
 *     the eventual real-result branch further down already does, and routes
 *     the pause payload through whichever channel this call's transport
 *     actually uses.
 *   - NOTIFICATIONS CANNOT BE PAUSED. A notification has no `id` and, by
 *     the JSON-RPC 2.0 contract, expects no response of any kind — there is
 *     nothing to correlate a future human-authorized "resume" against, and
 *     no caller-side handler waiting to receive one. So a budget-denied
 *     notification is simply dropped (not forwarded) with a server-side log
 *     line, never turned into an InputRequiredResult.
 *
 * The resumeToken minted here (core/mcp/inputRequired.ts, via
 * services/resumeTokenService.ts) is consumed by routes/resume.ts
 * (POST /mcp/resume, Phase 5) — a separate top-level plugin, not nested in
 * this one; see that file's module doc for why, and for the identity/policy
 * re-checks it layers on top of what the brief asked it to bypass (budget
 * only).
 *
 * STATELESSNESS WARNING — TWO subsystems in this file are stateful, not
 * the whole thing: services/sessionManager.ts (Phase 2, SSE sessions) and
 * services/budgetGuard.ts (Phase 4, the team token ledger). Read both
 * files' own warnings before deploying more than one replica. (Phase 5's
 * resumeTokenService.ts is, by design, NOT a third one — see its own doc
 * comment for the one real limitation that trade-off still carries:
 * replay is not prevented by a purely stateless token.)
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isJsonRpcRequest, isNotification, type JsonRpcId, type JsonRpcRequest } from '../core/jsonRpc/types.js';
import { JsonRpcErrorCode, buildJsonRpcError } from '../core/jsonRpc/errors.js';
import { readFastPathHint, readRouteInfoFromBody, type RouteHint } from '../core/mcp/headers.js';
import { buildInputRequiredResult } from '../core/mcp/inputRequired.js';
import { isToolDenied } from '../services/policyStore.js';
import { validateIdJag, extractBearerToken } from '../services/idJagValidator.js';
import { checkBudget, estimateRequestCost, recordActualUsage, type RequestCostEstimate } from '../services/budgetGuard.js';
import { registerSession, hasSession, sendMessageEvent, removeSession } from '../services/sessionManager.js';
import { forwardToUpstream } from '../services/upstreamClient.js';
import { originGuard } from './originGuard.js';

interface McpPostQuery {
  /** Present only on the legacy HTTP+SSE transport's correlation requests. */
  sessionId?: string;
}

/** Bundles the values `recordActualUsage` needs post-call, so forwardAndDeliverViaSse's already-long param list gains one object instead of three more positionals. */
interface UsageContext {
  teamId: string;
  toolName: string | undefined;
  costEstimate: RequestCostEstimate;
}

export const proxyInterceptor: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // -----------------------------------------------------------------------
  // Stage 0 — Origin validation (Phase 3). Registered first so it runs
  // before anything else in this plugin, including Stage 1 below: it's an
  // even cheaper, even more fundamental check (network-level trust
  // boundary) than the fast-path tool denylist, and applies to every route
  // here — GET included, which matters, since the legacy transport's
  // handshake is exactly what a browser-based DNS-rebinding attack would
  // target. See middleware/originGuard.ts for the full rationale.
  // -----------------------------------------------------------------------
  fastify.addHook('onRequest', originGuard);

  // -----------------------------------------------------------------------
  // Stage 1 — onRequest: cheap, header-only fast path. REJECT-ONLY.
  // Unchanged from Phase 1; applies to every route in this plugin, GET
  // included, but a handshake GET simply won't carry a Mcp-Name header, so
  // it falls through with no effect.
  // -----------------------------------------------------------------------
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const hint = readFastPathHint(request.headers);

    if (hint.toolName && isToolDenied(hint.toolName)) {
      request.log.warn({ tool: hint.toolName }, 'denied at fast-path (pre-body-parse)');
      await reply
        .status(403)
        .send(
          buildJsonRpcError(
            null,
            JsonRpcErrorCode.POLICY_DENIED,
            `Tool "${hint.toolName}" is denied by policy.`,
          ),
        );
      return;
    }
  });

  // -----------------------------------------------------------------------
  // GET /mcp — legacy HTTP+SSE handshake. Opens the stream, hands back the
  // session-scoped POST URL, then holds the connection open indefinitely.
  // -----------------------------------------------------------------------
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const acceptsSse = (request.headers.accept ?? '').includes('text/event-stream');
    if (!acceptsSse) {
      await reply
        .status(406)
        .send(
          buildJsonRpcError(
            null,
            JsonRpcErrorCode.INVALID_REQUEST,
            'GET /mcp requires "Accept: text/event-stream" (legacy HTTP+SSE transport).',
          ),
        );
      return;
    }

    const sessionId = randomUUID();

    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);

    registerSession(sessionId, reply);
    request.log.info({ sessionId }, 'legacy SSE session opened');

    request.raw.on('close', () => {
      removeSessionAndLog(sessionId, request);
    });
  });

  // -----------------------------------------------------------------------
  // POST /mcp[?sessionId=...] — message intake for both transports.
  // -----------------------------------------------------------------------
  fastify.post<{ Querystring: McpPostQuery }>(
    '/',
    async (request: FastifyRequest<{ Querystring: McpPostQuery }>, reply: FastifyReply) => {
      const body = request.body;

      if (!isJsonRpcRequest(body)) {
        await reply
          .status(400)
          .send(
            buildJsonRpcError(
              null,
              JsonRpcErrorCode.INVALID_REQUEST,
              'Body is not a valid JSON-RPC 2.0 request.',
            ),
          );
        return;
      }

      const id = body.id ?? null;
      const routeInfo: RouteHint = readRouteInfoFromBody(body);
      const { sessionId } = request.query;

      // Authoritative policy check — runs unconditionally, on both
      // transports, regardless of what the fast-path headers said.
      if (routeInfo.toolName && isToolDenied(routeInfo.toolName)) {
        await reply
          .status(403)
          .send(
            buildJsonRpcError(
              id,
              JsonRpcErrorCode.POLICY_DENIED,
              `Tool "${routeInfo.toolName}" is denied by policy.`,
            ),
          );
        return;
      }

      // --- Identity (ID-JAG) — real JWKS-backed verification (Phase 3); see services/idJagValidator.ts ---
      const idJagToken = extractBearerToken(request.headers.authorization);
      const identity = await validateIdJag(idJagToken, request.log);
      if (!identity.valid) {
        await reply
          .status(401)
          .send(
            buildJsonRpcError(
              id,
              JsonRpcErrorCode.IDENTITY_REJECTED,
              identity.reason ?? 'Identity assertion rejected.',
            ),
          );
        return;
      }
      const teamId = identity.claims?.subject ?? 'unknown-team';

      // --- Team token budget (Phase 4: real sliding-window enforcement) ---
      const costEstimate = estimateRequestCost(body, routeInfo.toolName);
      const budget = await checkBudget(teamId, costEstimate);

      if (!budget.allowed) {
        // A notification has no id and, by the JSON-RPC 2.0 contract,
        // expects no response of any kind — there's nothing to correlate a
        // future human-authorized "resume" against, and no caller-side
        // handler waiting for one. Enforce the budget by simply not
        // forwarding it; say so only in the logs.
        if (isNotification(body)) {
          request.log.warn(
            { teamId, tool: routeInfo.toolName, triggeredBy: budget.projection.triggeredBy },
            'notification dropped: team over budget',
          );
          await reply.status(202).send();
          return;
        }

        const pausePayload = buildInputRequiredResult(id, budget.projection, teamId, routeInfo.toolName, body);
        request.log.warn(
          { teamId, tool: routeInfo.toolName, projection: budget.projection },
          'call paused: team budget exceeded, awaiting human authorization',
        );

        // Transport-aware delivery — see the module doc's "pause flow"
        // section for why this mirrors the sessionId check the eventual
        // real result uses further down, rather than always replying
        // directly.
        if (sessionId !== undefined) {
          const delivered = sendMessageEvent(sessionId, pausePayload);
          if (!delivered) {
            request.log.warn({ sessionId }, 'SSE session closed before pause notice could be delivered');
          }
          await reply.status(202).send();
          return;
        }

        await reply.status(200).send(pausePayload);
        return;
      }

      // Gates passed below this line. A notification (no `id`) never gets a
      // correlated response on ANY transport — sessionId is irrelevant here,
      // there is nothing to push to it.
      if (isNotification(body)) {
        try {
          await forwardToUpstream(fastify, body, request.headers);
        } catch (err) {
          request.log.error({ err }, 'upstream delivery failed for a notification');
        }
        await reply.status(202).send();
        return;
      }

      const usageContext: UsageContext = { teamId, toolName: routeInfo.toolName, costEstimate };

      // A real request. Where its eventual result goes depends on transport.
      if (sessionId !== undefined) {
        if (!hasSession(sessionId)) {
          await reply
            .status(404)
            .send(
              buildJsonRpcError(
                id,
                JsonRpcErrorCode.SESSION_NOT_FOUND,
                `No active SSE session for sessionId "${sessionId}". Re-open GET /mcp.`,
              ),
            );
          return;
        }

        // Fire-and-forget: the eventual result — success or failure — is
        // delivered over the SSE stream, not this POST response. See the
        // module doc for why 202 is sent now, before the upstream call
        // resolves, rather than after.
        void forwardAndDeliverViaSse(fastify, sessionId, body, id, request.headers, request.log, usageContext);

        await reply.status(202).send();
        return;
      }

      // No sessionId: Phase 1 behavior, unchanged. Result goes directly in
      // this POST's own response body.
      try {
        const upstreamResult = await forwardToUpstream(fastify, body, request.headers);
        await recordActualUsage(teamId, routeInfo.toolName, costEstimate, upstreamResult);
        await reply.status(200).send(upstreamResult);
      } catch (err) {
        request.log.error({ err }, 'upstream MCP server call failed');
        await reply
          .status(502)
          .send(
            buildJsonRpcError(id, JsonRpcErrorCode.UPSTREAM_UNAVAILABLE, 'Upstream MCP server did not respond.'),
          );
      }
    },
  );
};

function removeSessionAndLog(sessionId: string, request: FastifyRequest): void {
  removeSession(sessionId);
  request.log.info({ sessionId }, 'legacy SSE session closed, resources released');
}

/**
 * Forwards a validated JSON-RPC request to the upstream MCP server, then
 * delivers the result — success or failure — onto the given legacy-SSE
 * session as an `event: message`. Runs fire-and-forget from the POST
 * handler's perspective; errors here are terminal for this call (there's
 * no synchronous HTTP response left to attach them to), so they're logged
 * and, where possible, still surfaced to the client via the SSE channel
 * instead of vanishing silently.
 */
async function forwardAndDeliverViaSse(
  fastify: FastifyInstance,
  sessionId: string,
  body: JsonRpcRequest,
  id: JsonRpcId,
  inboundHeaders: FastifyRequest['headers'],
  log: FastifyRequest['log'],
  usage: UsageContext,
): Promise<void> {
  try {
    const result = await forwardToUpstream(fastify, body, inboundHeaders);
    await recordActualUsage(usage.teamId, usage.toolName, usage.costEstimate, result);
    const delivered = sendMessageEvent(sessionId, result);
    if (!delivered) {
      log.warn({ sessionId }, 'upstream responded after the SSE session had already closed; result dropped');
    }
  } catch (err) {
    log.error({ err, sessionId }, 'upstream call failed for an SSE-correlated request');
    sendMessageEvent(
      sessionId,
      buildJsonRpcError(id, JsonRpcErrorCode.UPSTREAM_UNAVAILABLE, 'Upstream MCP server did not respond.'),
    );
  }
}
