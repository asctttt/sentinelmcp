import { env } from '../config/env.js';

/**
 * MOCK — Phase 1 placeholder.
 *
 * The real implementation (Phase 2+) will query a policy service or config
 * database keyed on team + tool + method, almost certainly with a cache in
 * front of it. For now, a static denylist parsed from an env var is enough
 * to exercise both the fast-path (`onRequest`) and authoritative (body)
 * checks in `middleware/proxyInterceptor.ts` end to end.
 */
const deniedTools = new Set(
  env.MCP_DENIED_TOOLS.split(',')
    .map((t) => t.trim())
    .filter(Boolean),
);

export function isToolDenied(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return deniedTools.has(toolName);
}
