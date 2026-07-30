import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.HMAC_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.MCP_UPSTREAM_URL = 'http://localhost:1';
process.env.JWKS_URI = 'http://localhost:1/jwks';
process.env.ID_JAG_ISSUER = 'test-issuer';
process.env.ID_JAG_AUDIENCE = 'test-audience';
process.env.ID_JAG_RESOURCE = 'test-resource';

const { issueResumeToken, verifyResumeToken, hashRequest } = await import('../../src/services/resumeTokenService.ts');
type JsonRpcRequestT = import('../../src/core/jsonRpc/types.ts').JsonRpcRequest;

let fakeNow: number;
const clock = () => fakeNow;
before(() => {
  fakeNow = Date.UTC(2026, 0, 1, 12, 0, 0);
});

describe('issueResumeToken / verifyResumeToken round trip', () => {
  test('a valid token verifies and its claims round-trip exactly', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'get_weather', requestHash: 'abc123' }, 15 * 60 * 1000, clock);
    const result = verifyResumeToken(token, clock);
    assert.equal(result.valid, true);
    assert.ok(result.valid);
    assert.equal(result.payload.teamId, 'team-x');
    assert.equal(result.payload.toolName, 'get_weather');
    assert.equal(result.payload.requestHash, 'abc123');
    assert.equal(result.payload.expiresAt, result.payload.issuedAt + 15 * 60 * 1000);
  });

  test('toolName: undefined round-trips as undefined, not the string "undefined"', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: undefined, requestHash: 'abc123' }, 15 * 60 * 1000, clock);
    const result = verifyResumeToken(token, clock);
    assert.ok(result.valid);
    assert.equal(result.payload.toolName, undefined);
  });
});

describe('expiry', () => {
  test('still valid comfortably inside the TTL', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'x', requestHash: 'h' }, 60_000, clock);
    const result = verifyResumeToken(token, () => fakeNow + 30_000);
    assert.equal(result.valid, true);
  });

  test('rejected well past the TTL', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'x', requestHash: 'h' }, 60_000, clock);
    const result = verifyResumeToken(token, () => fakeNow + 120_000);
    assert.equal(result.valid, false);
    assert.ok(!result.valid);
    assert.match(result.reason, /expired/);
  });
});

describe('tamper resistance', () => {
  test('a payload edited after signing (signature no longer matches) is rejected', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'x', requestHash: 'h' }, 60_000, clock);
    const [encodedPayload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8'));
    decoded.teamId = 'team-attacker';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    const result = verifyResumeToken(`${tamperedPayload}.${signature}`, clock);
    assert.equal(result.valid, false);
  });

  test('a token forged with a different secret is rejected', () => {
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'x', requestHash: 'h' }, 60_000, clock);
    const [encodedPayload] = token.split('.');
    const forgedSignature = createHmac('sha256', 'a-completely-different-secret-not-the-real-one').update(encodedPayload!).digest('base64url');
    const result = verifyResumeToken(`${encodedPayload}.${forgedSignature}`, clock);
    assert.equal(result.valid, false);
  });

  test('garbage input is always rejected and never throws', () => {
    const cases = ['not-a-token', '', 'only.two', '....', `${Buffer.from('{"broken', 'utf8').toString('base64url')}.fakesig`];
    for (const garbage of cases) {
      assert.doesNotThrow(() => {
        const result = verifyResumeToken(garbage, clock);
        assert.equal(result.valid, false);
      }, `garbage input threw: ${JSON.stringify(garbage)}`);
    }
  });
});

describe('hashRequest canonicalization', () => {
  test('object key order does not affect the hash', () => {
    const a: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50, to: 'acct-1' } } };
    const b = { params: { arguments: { to: 'acct-1', amount: 50 }, name: 'wire_transfer' }, method: 'tools/call', id: 1, jsonrpc: '2.0' } as JsonRpcRequestT;
    assert.equal(hashRequest(a), hashRequest(b));
  });

  test('array element order DOES affect the hash (order is semantically meaningful, unlike object keys)', () => {
    const a: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'batch_op', arguments: { steps: ['a', 'b', 'c'] } } };
    const b: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'batch_op', arguments: { steps: ['c', 'b', 'a'] } } };
    assert.notEqual(hashRequest(a), hashRequest(b));
  });

  test('changing the amount changes the hash (the security property that actually matters)', () => {
    const original: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50, to: 'acct-1' } } };
    const tampered: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50000, to: 'acct-1' } } };
    assert.notEqual(hashRequest(original), hashRequest(tampered));
  });

  test('changing the recipient changes the hash', () => {
    const original: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50, to: 'acct-1' } } };
    const tampered: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50, to: 'attacker-acct' } } };
    assert.notEqual(hashRequest(original), hashRequest(tampered));
  });

  test('end to end: a token issued for one request correctly fails the hash check against a substituted one', () => {
    const original: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50, to: 'acct-1' } } };
    const substituted: JsonRpcRequestT = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_transfer', arguments: { amount: 50000, to: 'acct-1' } } };
    const token = issueResumeToken({ teamId: 'team-x', toolName: 'wire_transfer', requestHash: hashRequest(original) }, 60_000, clock);
    const verification = verifyResumeToken(token, clock);
    assert.ok(verification.valid);
    // This is exactly what routes/resume.ts's Step 3 does: compare the
    // token's bound hash against a freshly-computed hash of whatever was
    // actually submitted.
    assert.notEqual(verification.payload.requestHash, hashRequest(substituted));
  });
});
