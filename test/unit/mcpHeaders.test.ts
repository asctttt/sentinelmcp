import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFastPathHint, readRouteInfoFromBody } from '../../src/core/mcp/headers.ts';
import type { JsonRpcRequest } from '../../src/core/jsonRpc/types.ts';

describe('readFastPathHint', () => {
  test('extracts method and tool name when both headers present', () => {
    const hint = readFastPathHint({ 'mcp-method': 'tools/call', 'mcp-name': 'get_weather' });
    assert.deepEqual(hint, { method: 'tools/call', toolName: 'get_weather', fromFastPath: true });
  });

  test('handles entirely absent headers (the normal case for a spec-compliant client)', () => {
    const hint = readFastPathHint({});
    assert.equal(hint.method, undefined);
    assert.equal(hint.toolName, undefined);
    assert.equal(hint.fromFastPath, true);
  });

  test('takes the first value when Fastify gives an array (repeated header)', () => {
    const hint = readFastPathHint({ 'mcp-name': ['first_tool', 'second_tool'] });
    assert.equal(hint.toolName, 'first_tool');
  });

  test('ignores unrelated headers', () => {
    const hint = readFastPathHint({ authorization: 'Bearer xyz', 'content-type': 'application/json' });
    assert.equal(hint.method, undefined);
    assert.equal(hint.toolName, undefined);
  });
});

describe('readRouteInfoFromBody', () => {
  test('extracts toolName from params.name for a tools/call request', () => {
    const body: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: {} } };
    const info = readRouteInfoFromBody(body);
    assert.deepEqual(info, { method: 'tools/call', toolName: 'get_weather', fromFastPath: false });
  });

  test('toolName is undefined for a non-tools/call method, even if params happens to have a name field', () => {
    const body: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { name: 'irrelevant' } };
    const info = readRouteInfoFromBody(body);
    assert.equal(info.method, 'resources/read');
    assert.equal(info.toolName, undefined);
  });

  test('toolName is undefined for a tools/call with no params at all', () => {
    const body: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
    const info = readRouteInfoFromBody(body);
    assert.equal(info.toolName, undefined);
  });

  test('fromFastPath is always false for body-derived info (this is the authoritative source)', () => {
    const body: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/progress' };
    assert.equal(readRouteInfoFromBody(body).fromFastPath, false);
  });
});
