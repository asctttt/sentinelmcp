import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isJsonRpcRequest, isNotification } from '../../src/core/jsonRpc/types.ts';
import { buildJsonRpcError, JsonRpcErrorCode } from '../../src/core/jsonRpc/errors.ts';

describe('isJsonRpcRequest', () => {
  test('accepts a well-formed request with a string id', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'tools/call' }), true);
  });

  test('accepts a well-formed request with a numeric id', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 42, method: 'tools/call' }), true);
  });

  test('accepts a well-formed request with id: null (spec-legal, distinct from absent id)', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: null, method: 'tools/call' }), true);
  });

  test('accepts a notification (no id key at all)', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/progress' }), true);
  });

  test('accepts params of any shape', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'x', params: { anything: [1, 2, 3] } }), true);
  });

  test('rejects null', () => {
    assert.equal(isJsonRpcRequest(null), false);
  });

  test('rejects a bare array', () => {
    assert.equal(isJsonRpcRequest([{ jsonrpc: '2.0', id: 1, method: 'x' }]), false);
  });

  test('rejects a primitive', () => {
    assert.equal(isJsonRpcRequest('not an object'), false);
    assert.equal(isJsonRpcRequest(42), false);
  });

  test('rejects a missing jsonrpc field', () => {
    assert.equal(isJsonRpcRequest({ id: 1, method: 'x' }), false);
  });

  test('rejects the wrong jsonrpc version', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'x' }), false);
  });

  test('rejects a missing method', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1 }), false);
  });

  test('rejects an empty-string method', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: '' }), false);
  });

  test('rejects a non-string method', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 123 }), false);
  });

  test('rejects an id that is a boolean (JsonRpcId is only string | number | null)', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: true, method: 'x' }), false);
  });

  test('rejects an id that is an object', () => {
    assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: {}, method: 'x' }), false);
  });
});

describe('isNotification', () => {
  test('true when the id key is entirely absent', () => {
    assert.equal(isNotification({ jsonrpc: '2.0', method: 'x' }), true);
  });

  test('false when id is a real value', () => {
    assert.equal(isNotification({ jsonrpc: '2.0', id: 1, method: 'x' }), false);
  });

  // The one genuinely easy-to-get-wrong case: id: null is NOT a
  // notification. It's a request with an id that happens to be JSON null
  // -- rare, but spec-legal and distinct from "no id at all". Confirmed
  // against the documented behavior in core/jsonRpc/types.ts.
  test('false when id is explicitly null (distinct from absent)', () => {
    assert.equal(isNotification({ jsonrpc: '2.0', id: null, method: 'x' }), false);
  });
});

describe('buildJsonRpcError', () => {
  test('builds the correct shape without a data field', () => {
    const err = buildJsonRpcError('req-1', JsonRpcErrorCode.POLICY_DENIED, 'denied');
    assert.deepEqual(err, {
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: JsonRpcErrorCode.POLICY_DENIED, message: 'denied' },
    });
  });

  test('includes data only when explicitly provided', () => {
    const err = buildJsonRpcError(1, JsonRpcErrorCode.BUDGET_EXCEEDED, 'over budget', { detail: 'x' });
    assert.deepEqual(err, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: JsonRpcErrorCode.BUDGET_EXCEEDED, message: 'over budget', data: { detail: 'x' } },
    });
  });

  test('supports id: null for errors that occur before an id is knowable', () => {
    const err = buildJsonRpcError(null, JsonRpcErrorCode.PARSE_ERROR, 'bad json');
    assert.equal(err.id, null);
  });

  test("SentinelMCP's reserved error codes stay within the -32000..-32099 server-error range", () => {
    const reserved = [
      JsonRpcErrorCode.POLICY_DENIED,
      JsonRpcErrorCode.BUDGET_EXCEEDED,
      JsonRpcErrorCode.UPSTREAM_UNAVAILABLE,
      JsonRpcErrorCode.IDENTITY_REJECTED,
      JsonRpcErrorCode.SESSION_NOT_FOUND,
      JsonRpcErrorCode.ORIGIN_REJECTED,
      JsonRpcErrorCode.RESUME_TOKEN_INVALID,
      JsonRpcErrorCode.RESUME_REQUEST_MISMATCH,
    ];
    for (const code of reserved) {
      assert.ok(code <= -32000 && code >= -32099, `${code} is outside the reserved server-error range`);
    }
    // And no two codes collide with each other.
    assert.equal(new Set(reserved).size, reserved.length, 'duplicate error codes found');
  });
});
