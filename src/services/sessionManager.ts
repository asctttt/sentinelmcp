import type { FastifyReply } from 'fastify';
import { env } from '../config/env.js';

/**
 * Tracks open legacy-transport SSE connections in process memory, keyed by
 * sessionId, so a later `POST /mcp?sessionId=...` can find the stream to
 * push its result onto.
 *
 * IMPORTANT — this is the one piece of SentinelMCP that is NOT stateless.
 * Everything in Phase 1 (and the Phase 2 Streamable-HTTP-style POST path
 * with no sessionId) is safe behind a plain round-robin load balancer
 * because any replica can handle any request. This module breaks that: a
 * session lives only in the memory of whichever process accepted its GET.
 * If you run more than one replica, `POST /mcp?sessionId=X` MUST reach the
 * same replica that owns X's GET connection, or the result has nowhere to
 * go. That means L7 session affinity (sticky routing keyed on the
 * sessionId query param) on this path specifically — this module's
 * connection-manager pattern doesn't remove that requirement, it just
 * contains it to one file. This is, not coincidentally, one of the
 * documented reasons the legacy transport was deprecated in favor of
 * Streamable HTTP, which doesn't have this constraint.
 */

interface ManagedSession {
  reply: FastifyReply;
  heartbeatTimer: ReturnType<typeof setInterval>;
  createdAt: number;
}

const sessions = new Map<string, ManagedSession>();

/**
 * Registers a newly-opened SSE stream and starts its heartbeat. The
 * heartbeat writes an SSE *comment* line (`: ...`), not a typed event —
 * comment lines are defined by the EventSource spec to be ignored by the
 * parser, so the MCP client's JSON-RPC layer never sees them, but the
 * bytes still cross the wire and reset any intermediate proxy's idle timer.
 * A typed `event: ping` would risk a client trying to treat it as a
 * protocol message.
 */
export function registerSession(sessionId: string, reply: FastifyReply): void {
  const heartbeatTimer = setInterval(() => {
    try {
      reply.raw.write(': heartbeat\n\n');
    } catch {
      // The write can fail if the socket died between ticks, in a way that
      // hasn't reached the 'close' listener yet — not fatal, the close
      // handler will clean the session up shortly regardless.
    }
  }, env.SSE_HEARTBEAT_MS);

  // Don't let a live SSE connection hold the event loop open on its own —
  // heartbeats are a courtesy to proxies, not a reason to block shutdown.
  heartbeatTimer.unref?.();

  sessions.set(sessionId, { reply, heartbeatTimer, createdAt: Date.now() });
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Writes a JSON-RPC payload onto the sessionId's SSE stream as a `message`
 * event. Returns false (rather than throwing) if the session is unknown or
 * has already closed, so callers can decide how to handle "nowhere to
 * deliver this" without a try/catch at every call site.
 */
export function sendMessageEvent(sessionId: string, payload: unknown): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.reply.raw.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  return true;
}

/** Stops the heartbeat and forgets the session. Idempotent. */
export function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearInterval(session.heartbeatTimer);
  sessions.delete(sessionId);
}

/** Exposed for /healthz-style observability, not used in the request path. */
export function activeSessionCount(): number {
  return sessions.size;
}
