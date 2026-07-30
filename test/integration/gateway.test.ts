import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness, type TestHarness } from './helpers/testHarness.ts';

/**
 * End-to-end integration coverage using `fastify.inject()` against a real
 * `buildApp()` instance — the whole hook/plugin/routing pipeline runs
 * exactly as it would over a real socket, minus the socket itself. Real
 * dependencies (JWKS, upstream MCP server) are real, in-process, ephemeral-
 * port HTTP servers, not stubs — see helpers/testHarness.ts.
 *
 * Deliberately NOT covering the legacy SSE transport here: GET /mcp
 * hijacks the raw response and streams indefinitely, which is a poor fit
 * for `.inject()` (built for request/response, not long-lived streams).
 * That transport already has thorough, repeated real-socket verification
 * from Phases 2–4; a real-socket test could be added later if this
 * boundary ever needs closing, but forcing it through `.inject()` here
 * would trade robustness for coverage that already exists elsewhere.
 *
 * One harness, one shared app, for the whole file — every scenario uses
 * its own distinct team (JWT subject) specifically so ledger state from
 * one test can never leak into another's expectations.
 */

let harness: TestHarness;

before(async () => {
  harness = await createTestHarness({ deniedTools: 'delete_production_database', defaultTeamTokenBudget7d: 5_000 });
});

after(async () => {
  await harness.cleanup();
});

describe('health check', () => {
  test('GET /healthz returns 200 with the expected shape', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'sentinelmcp');
  });
});

describe('Origin validation', () => {
  test('a hostile Origin on POST /mcp is rejected before anything else runs', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {} } },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, -32006); // ORIGIN_REJECTED
  });
});

describe('request shape validation', () => {
  test('a body that is valid JSON but not a JSON-RPC envelope is rejected', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, -32600); // INVALID_REQUEST
  });
});

describe('policy (tool denylist)', () => {
  test('the header fast-path rejects a denylisted tool BEFORE the body is even validated', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', 'mcp-name': 'delete_production_database' },
      payload: 'this is not even valid JSON at all {{{',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, -32001); // POLICY_DENIED -- fired pre-body-parse, so the garbage body never mattered
  });

  test('the authoritative body-based check rejects a denylisted tool with no fast-path headers present', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_production_database', arguments: {} } },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, -32001);
  });
});

describe('identity (ID-JAG)', () => {
  test('no Authorization header at all is rejected', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {} } },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, -32004); // IDENTITY_REJECTED
  });

  test('a token signed for the WRONG resource is rejected end to end (the anti-confused-deputy binding, exercised through the real gateway)', async () => {
    const token = await harness.signToken('team-wrong-resource', { resource: 'https://a-different-mcp-server.internal' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {} } },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, -32004);
  });
});

describe('the full allowed path', () => {
  test('a valid, well-under-budget call is relayed to and from the real mock upstream', async () => {
    harness.clearUpstreamRequests();
    const token = await harness.signToken('team-happy-path');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 'req-1', method: 'tools/call', params: { name: 'get_weather', arguments: { city: 'x' } } },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 'req-1');
    assert.ok(body.result, 'expected a result field, not an error');

    const upstreamCalls = harness.getUpstreamRequests();
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0]?.method, 'tools/call');
  });

  test('a notification (no id) that passes all gates is forwarded and gets an empty 202', async () => {
    harness.clearUpstreamRequests();
    const token = await harness.signToken('team-notification-path');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 50 } },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, '');
    assert.equal(harness.getUpstreamRequests().length, 1, 'the notification should still have been forwarded upstream');
  });
});

describe('the budget pause and resume flow', () => {
  // A single request with a deliberately huge input payload -- large
  // enough that its OWN measured input-token cost alone guarantees a
  // breach of the 5,000-token test budget on the very first call,
  // regardless of any per-tool EMA state. This keeps each pause scenario
  // self-contained (one call, not a sequence building up over time).
  function oversizedRequest(id: string | number) {
    return {
      jsonrpc: '2.0' as const,
      id,
      method: 'tools/call' as const,
      params: { name: 'get_weather', arguments: { city: 'x'.repeat(50_000) } },
    };
  }

  test('a call that would breach the budget is paused, not hard-errored: JSON-RPC success with an InputRequiredResult', async () => {
    const token = await harness.signToken('team-pause-flow-1');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: oversizedRequest('pause-1'),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.error, undefined, 'a pause must be a JSON-RPC success, not an error');
    assert.equal(body.result.status, 'input_required');
    assert.equal(body.result.reasonCode, 'BUDGET_EXCEEDED');
    assert.equal(typeof body.result.resumeToken, 'string');
    assert.ok(body.result.resumeToken.length > 0);
    assert.equal(body.result.projection.triggeredBy, 'HARD_CAP');
    assert.ok(body.result.authorizationSchema.properties.decision.enum.includes('APPROVE'));
    assert.ok(body.result.authorizationSchema.properties.decision.enum.includes('DENY'));
  });

  test('resume with APPROVE bypasses the budget gate and actually executes the call', async () => {
    harness.clearUpstreamRequests();
    const token = await harness.signToken('team-pause-flow-2');
    const originalRequest = oversizedRequest('pause-2');
    const pauseRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: originalRequest,
    });
    const { resumeToken } = pauseRes.json().result;

    const resumeRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp/resume',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { resumeToken, decision: 'APPROVE', originalRequest },
    });
    assert.equal(resumeRes.statusCode, 200);
    const body = resumeRes.json();
    assert.ok(body.result, 'expected the real upstream result, not double-wrapped or an error');
    assert.equal(harness.getUpstreamRequests().length, 1, 'the approved call should have reached the real upstream exactly once');
  });

  test('resume with DENY returns a cancellation result and never reaches upstream', async () => {
    harness.clearUpstreamRequests();
    const token = await harness.signToken('team-pause-flow-3');
    const originalRequest = oversizedRequest('pause-3');
    const pauseRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: originalRequest,
    });
    const { resumeToken } = pauseRes.json().result;

    const resumeRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp/resume',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { resumeToken, decision: 'DENY', originalRequest },
    });
    assert.equal(resumeRes.statusCode, 200);
    const body = resumeRes.json();
    assert.equal(body.result.status, 'cancelled');
    assert.equal(body.result.reasonCode, 'USER_DENIED');
    assert.equal(harness.getUpstreamRequests().length, 0, 'a denied call must never reach upstream');
  });

  test('resume rejects a tampered originalRequest that does not match what was actually paused', async () => {
    const token = await harness.signToken('team-pause-flow-4');
    const originalRequest = oversizedRequest('pause-4');
    const pauseRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: originalRequest,
    });
    const { resumeToken } = pauseRes.json().result;

    const tamperedRequest = { ...originalRequest, params: { ...originalRequest.params, arguments: { city: 'a substituted value' } } };
    const resumeRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp/resume',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { resumeToken, decision: 'APPROVE', originalRequest: tamperedRequest },
    });
    assert.equal(resumeRes.statusCode, 409);
    assert.equal(resumeRes.json().error.code, -32008); // RESUME_REQUEST_MISMATCH
  });

  test('resume rejects a cross-tenant attempt: team A\'s token, resumed with team B\'s valid credentials', async () => {
    const tokenA = await harness.signToken('team-pause-flow-5a');
    const tokenB = await harness.signToken('team-pause-flow-5b');
    const originalRequest = oversizedRequest('pause-5');
    const pauseRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      payload: originalRequest,
    });
    const { resumeToken } = pauseRes.json().result;

    const resumeRes = await harness.app.inject({
      method: 'POST',
      url: '/mcp/resume',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenB}` },
      payload: { resumeToken, decision: 'APPROVE', originalRequest },
    });
    assert.equal(resumeRes.statusCode, 403);
    assert.equal(resumeRes.json().error.code, -32004); // IDENTITY_REJECTED, reused for the team-mismatch case
  });
});
