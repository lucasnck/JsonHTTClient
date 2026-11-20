import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequestFile,
  validateExecutionBatchResult,
  validateExecutionResult,
} from '../packages/core/src/contracts/validation.js';

const single = {
  request: {
    method: 'GET',
    url: 'https://api.example.test/customers',
    headers: [{ name: 'Authorization', value: 'Bearer [REDACTED]' }],
  },
  response: {
    status: 400,
    statusText: 'Bad Request',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: { type: 'json', value: { error: 'Invalid customer' } },
  },
  timings: { totalMs: 24.4 },
};
void test('T01: accepts request file identified by *.request.json suffix', () => {
  const request = {
    request: {
      method: 'POST',
      url: '{{baseUrl}}/customers',
      headers: [{ name: 'Accept', value: 'application/json' }],
      body: { type: 'json', value: { active: true } },
    },
  };
  const v = validateRequestFile(request, 'create.request.json');
  assert.equal(v.valid, true, JSON.stringify(v));
});
void test('T01: regular data.json never becomes an executable request', () => {
  const v = validateRequestFile({ request: { method: 'GET', url: 'https://example.test' } }, 'data.json');
  assert.equal(v.valid, false);
});
void test('T01: legacy schemaVersion/$format/execution-style keys are rejected', () => {
  const v = validateRequestFile(
    { $format: 'http', schemaVersion: 1, request: { method: 'GET', url: 'https://example.test' } },
    'test.request.json',
  );
  assert.equal(v.valid, false);
  if (!v.valid) assert.ok(v.issues.some((i) => i.path === '/schemaVersion'));
});
void test('T01: body discriminator, loop and options validated', () => {
  const value = {
    request: { method: 'GET', url: 'https://example.test', body: { type: 'binary', path: '../../binary' } },
    loop: { source: { kind: 'inline', items: [{ id: 1 }, { id: 2 }] }, onError: 'continue', maxItems: 10 },
    options: { timeoutMs: 5000 },
  };
  assert.equal(validateRequestFile(value, 'loop.request.json').valid, true);
  const bad = {
    request: { method: 'GET', url: 'x', body: { type: 'unknown' } },
    loop: { source: { kind: 'inline', items: ['not-an-object'] } },
  };
  assert.equal(validateRequestFile(bad, 'loop.request.json').valid, false);
});
void test('T01: HTTP 400 retains real server status, headers and error body', () => {
  assert.equal(validateExecutionResult(single).valid, true);
  assert.deepEqual(Object.keys(single), ['request', 'response', 'timings']);
  assert.deepEqual(single.response.body, { type: 'json', value: { error: 'Invalid customer' } });
});
void test('T01: transport failure has response:null without fabricated HTTP payload', () => {
  assert.equal(validateExecutionResult({ ...single, response: null }).valid, true);
});
void test('T01: no legacy root execution metadata', () => {
  const v = validateExecutionResult({ ...single, executionId: 'not-allowed', ok: false });
  assert.equal(v.valid, false);
});
void test('T01: one batch JSON with per-item exactly the single result shape', () => {
  const batch = {
    summary: {
      status: 'partial_failed',
      total: 2,
      executed: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      skipped: 0,
    },
    timings: { totalMs: 65 },
    results: [single, { ...single, response: { ...single.response, status: 200, statusText: 'OK' } }],
  };
  assert.equal(validateExecutionBatchResult(batch).valid, true);
  const wrong = { ...batch, results: [{ ...single, outcome: 'failed' }] };
  assert.equal(validateExecutionBatchResult(wrong).valid, false);
});
void test('T01: invalid batch accounting is rejected', () => {
  const batch = {
    summary: {
      status: 'cancelled',
      total: 10,
      executed: 3,
      succeeded: 2,
      failed: 0,
      cancelled: 1,
      skipped: 0,
    },
    timings: { totalMs: 65 },
    results: [single],
  };
  assert.equal(validateExecutionBatchResult(batch).valid, false);
});
