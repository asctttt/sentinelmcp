import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';

/**
 * Shared setup for the integration suite: a real (self-signed, in-process)
 * mock IdP — genuine RSA keypair, genuine JWKS HTTP endpoint, genuinely
 * signed JWTs — and a real mock upstream MCP server, both bound to
 * OS-assigned ephemeral ports (never a hardcoded port) so this suite is
 * safe to run in parallel or on a shared CI machine without collisions.
 *
 * Builds a real `buildApp()` instance for use with `.inject()` — no real
 * listening socket for the gateway itself, no network involved for the
 * *gateway's own* HTTP surface, only for its two real dependencies (JWKS,
 * upstream), exactly mirroring how it behaves in production.
 *
 * Env vars are set BEFORE the dynamic `import('../../../src/app.ts')` —
 * config/env.ts validates and freezes its config at first import, so this
 * ordering is load-bearing, not stylistic. See the file-level comment in
 * any test file that imports this for why dynamic import (not a static
 * one) is required.
 */

export interface HarnessOptions {
  deniedTools?: string;
  defaultTeamTokenBudget7d?: number;
  allowedOrigins?: string;
}

export interface UpstreamRequestLog {
  method: string | undefined;
  body: Record<string, unknown>;
}

export interface TestHarness {
  app: FastifyInstance;
  /** Signs a real JWT against the mock IdP's real key. Overrides let a test deliberately construct a wrong-resource/wrong-issuer token to verify the gateway's real end-to-end rejection of it. */
  signToken(
    subject: string,
    overrides?: Partial<{ resource: string; audience: string; issuer: string; typ: string }>,
  ): Promise<string>;
  getUpstreamRequests(): UpstreamRequestLog[];
  clearUpstreamRequests(): void;
  cleanup(): Promise<void>;
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('failed to determine ephemeral port'));
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function createTestHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  // --- mock upstream MCP server ---
  const upstreamRequests: UpstreamRequestLog[] = [];
  const upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        // logged as an empty body below; not a scenario any test exercises deliberately
      }
      upstreamRequests.push({ method: typeof parsed.method === 'string' ? parsed.method : undefined, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (parsed.id as string | number | null | undefined) ?? null,
          result: { content: [{ type: 'text', text: `mock upstream received ${String(parsed.method)}` }] },
        }),
      );
    });
  });
  const upstreamPort = await listenEphemeral(upstreamServer);

  // --- mock IdP: real keypair + real JWKS HTTP endpoint ---
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const publishedJwk = { ...publicJwk, kid, alg: 'RS256', use: 'sig' };

  const jwksServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publishedJwk] }));
  });
  const jwksPort = await listenEphemeral(jwksServer);

  const issuer = 'https://test-idp.internal';
  const audience = 'sentinelmcp-test';
  const resource = 'https://test-upstream.internal';

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.MCP_UPSTREAM_URL = `http://127.0.0.1:${upstreamPort}/mcp`;
  process.env.JWKS_URI = `http://127.0.0.1:${jwksPort}/jwks`;
  process.env.ID_JAG_ISSUER = issuer;
  process.env.ID_JAG_AUDIENCE = audience;
  process.env.ID_JAG_RESOURCE = resource;
  process.env.HMAC_SECRET = 'integration-test-secret-at-least-32-characters-long';
  process.env.MCP_DENIED_TOOLS = options.deniedTools ?? '';
  process.env.DEFAULT_TEAM_TOKEN_BUDGET_7D = String(options.defaultTeamTokenBudget7d ?? 5_000);
  if (options.allowedOrigins !== undefined) {
    process.env.ALLOWED_ORIGINS = options.allowedOrigins;
  }

  const { buildApp } = await import('../../../src/app.ts');
  const app = buildApp();
  await app.ready();

  async function signToken(
    subject: string,
    overrides: Partial<{ resource: string; audience: string; issuer: string; typ: string }> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: overrides.issuer ?? issuer,
      aud: overrides.audience ?? audience,
      sub: subject,
      resource: overrides.resource ?? resource,
      exp: now + 3600,
      iat: now,
    })
      .setProtectedHeader({ alg: 'RS256', typ: overrides.typ ?? 'oauth-id-jag+jwt', kid })
      .sign(privateKey);
  }

  return {
    app,
    signToken,
    getUpstreamRequests: () => upstreamRequests,
    clearUpstreamRequests: () => {
      upstreamRequests.length = 0;
    },
    cleanup: async () => {
      await app.close();
      await closeServer(upstreamServer);
      await closeServer(jwksServer);
    },
  };
}
