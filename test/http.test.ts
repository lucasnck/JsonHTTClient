import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVariableSnapshot } from '../packages/core/src/variables/variables.js';
import { executeRequestFile } from '../packages/sdk-js/src/execution.js';
import { fetchHttpRequest, HttpExecutionError } from '../packages/runtime-node/src/http/fetch-transport.js';
import {
  checkHttpTarget,
  HttpPolicyError,
  isPrivateHostname,
} from '../packages/core/src/security/policies.js';
import { validateExecutionResult } from '../packages/core/src/contracts/validation.js';

async function fixture() {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url?.startsWith('/error')) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', ['id=secret; HttpOnly', 'other=secret']);
      res.end(JSON.stringify({ message: 'Bad request', debug: 'body must remain original' }));
    } else if (req.url?.startsWith('/fatal')) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'Server error' }));
    } else if (req.url?.startsWith('/redirect')) {
      res.statusCode = 302;
      res.setHeader('location', '/ok');
      res.end();
    } else if (req.url?.startsWith('/untrusted')) {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.2:7777/forbidden');
      res.end();
    } else if (req.url?.startsWith('/large')) {
      res.setHeader('content-type', 'text/plain');
      res.end('x'.repeat(8192));
    } else if (req.url?.startsWith('/delay')) {
      setTimeout(() => {
        if (!res.destroyed) res.end('waited');
      }, 180);
    } else if (req.url?.startsWith('/echo')) {
      const chunks: Buffer[] = [];
      req.on('data', (x) => chunks.push(x as Buffer));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            headers: req.headers,
            url: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    count: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const local = { allowHttp: true, allowPrivateNetworks: true };
const vars = (base: string, protectedFile = false) =>
  createVariableSnapshot([
    {
      folderPath: '/root',
      files: [
        {
          filename: 'dev.variables.json',
          filePath: '/root/dev.variables.json',
          content: { enabled: true, protected: protectedFile, baseUrl: base, apiKey: 'topsecret' },
        },
      ],
    },
  ]);

// Tests use local-only server; permission for loopback is deliberately explicit.
void test('T09: safe default rejects HTTP, private endpoints and credential URLs', () => {
  assert.throws(
    () => checkHttpTarget('http://public.example.com'),
    (e: unknown) => e instanceof HttpPolicyError && e.code === 'BLOCKED_SCHEME',
  );
  assert.throws(
    () => checkHttpTarget('https://127.0.0.1'),
    (e: unknown) => e instanceof HttpPolicyError && e.code === 'BLOCKED_PRIVATE_NETWORK',
  );
  assert.throws(
    () => checkHttpTarget('https://user:pass@example.com'),
    (e: unknown) => e instanceof HttpPolicyError && e.code === 'INVALID_URL',
  );
  assert.throws(
    () => checkHttpTarget('https://a.example', { allowedHosts: ['b.example'] }),
    (e: unknown) => e instanceof HttpPolicyError && e.code === 'BLOCKED_HOST',
  );
  assert.equal(isPrivateHostname('::1'), true);
  assert.equal(isPrivateHostname('10.0.0.1'), true);
  assert.equal(isPrivateHostname('8.8.8.8'), false);
});

void test('T04: real HTTP 200 response has canonical request/response/timings', async () => {
  const server = await fixture();
  try {
    const session = await executeRequestFile(
      { request: { method: 'GET', url: '{{baseUrl}}/ok' } },
      { snapshot: vars(server.base), policy: local },
    );
    assert.deepEqual(Object.keys(session.result), ['request', 'response', 'timings']);
    assert.equal(session.result.response?.status, 200);
    assert.deepEqual(session.result.response?.body, { type: 'json', value: { ok: true } });
    assert.equal(session.result.request.url, `${server.base}/ok`);
    assert.equal(validateExecutionResult(session.result).valid, true);
  } finally {
    await server.close();
  }
});
void test('T04: HTTP 400 response preserves body, status, headers and redacts Set-Cookie', async () => {
  const server = await fixture();
  try {
    const session = await fetchHttpRequest({ method: 'GET', url: `${server.base}/error` }, { policy: local });
    assert.equal(session.result.response?.status, 400);
    assert.deepEqual(session.result.response?.body, {
      type: 'json',
      value: { message: 'Bad request', debug: 'body must remain original' },
    });
    const cookie = session.result.response?.headers.find((h) => h.name.toLowerCase() === 'set-cookie');
    assert.equal(cookie?.value, '[REDACTED]');
    assert.equal(validateExecutionResult(session.result).valid, true);
  } finally {
    await server.close();
  }
});
void test('T04: HTTP 500 status is response not network error', async () => {
  const server = await fixture();
  try {
    const session = await fetchHttpRequest({ method: 'GET', url: `${server.base}/fatal` }, { policy: local });
    assert.equal(session.result.response?.status, 500);
    assert.equal(session.diagnostic, undefined);
  } finally {
    await server.close();
  }
});
void test('T04: Authorization is really sent but masked in default view; reveal is memory only', async () => {
  const server = await fixture();
  try {
    const session = await fetchHttpRequest(
      {
        method: 'GET',
        url: `${server.base}/echo`,
        headers: [
          { name: 'Authorization', value: 'Bearer actual-token' },
          { name: 'X-API-Key', value: 'raw-key' },
        ],
      },
      { policy: local },
    );
    const json = session.result.response?.body;
    assert.equal(json?.type, 'json');
    const echoed = (json as { type: 'json'; value: { headers: Record<string, string> } }).value.headers;
    assert.equal(echoed.authorization, 'Bearer actual-token');
    assert.equal(echoed['x-api-key'], 'raw-key');
    assert.equal(
      session.result.request.headers.find((h) => h.name === 'authorization')?.value,
      'Bearer [REDACTED]',
    );
    assert.equal(session.result.request.headers.find((h) => h.name === 'x-api-key')?.value, '[REDACTED]');
    assert.equal(
      session.viewOriginalHeaders().request.headers.find((h) => h.name === 'authorization')?.value,
      'Bearer actual-token',
    );
    session.dispose();
    assert.throws(() => session.viewOriginalHeaders(), HttpExecutionError);
    assert.equal(
      session.result.request.headers.find((h) => h.name === 'authorization')?.value,
      'Bearer [REDACTED]',
    );
  } finally {
    await server.close();
  }
});
void test('T04: POST JSON sends genuine JSON, form urlencoded body preserves repeated query', async () => {
  const server = await fixture();
  try {
    const result = await fetchHttpRequest(
      {
        method: 'POST',
        url: `${server.base}/echo`,
        query: [
          { name: 'x', value: '1' },
          { name: 'x', value: '2' },
        ],
        body: { type: 'json', value: { id: 42 } },
      },
      { policy: local },
    );
    const echoed = (
      result.result.response?.body as {
        type: 'json';
        value: { body: string; url: string; headers: Record<string, string> };
      }
    ).value;
    assert.equal(echoed.body, '{"id":42}');
    assert.match(echoed.headers['content-type'] ?? '', /application\/json/);
    assert.equal(echoed.url, '/echo?x=1&x=2');
    const form = await fetchHttpRequest(
      {
        method: 'POST',
        url: `${server.base}/echo`,
        body: { type: 'urlencoded', value: [{ name: 'a', value: 'a b' }] },
      },
      { policy: local },
    );
    assert.equal(
      (form.result.response?.body as { type: 'json'; value: { body: string } }).value.body,
      'a=a+b',
    );
  } finally {
    await server.close();
  }
});
void test('T09: protected effective variable requires approved preflight and sends nothing on deny', async () => {
  const server = await fixture();
  try {
    const file = { request: { method: 'GET' as const, url: '{{baseUrl}}/ok' } };
    await assert.rejects(
      executeRequestFile(file, { snapshot: vars(server.base, true), policy: local }),
      (error: unknown) => error instanceof HttpPolicyError && error.code === 'APPROVAL_REQUIRED',
    );
    assert.equal(server.count(), 0);
    let got: string[] = [];
    const session = await executeRequestFile(file, {
      snapshot: vars(server.base, true),
      policy: local,
      approval: async (req) => {
        got = [...req.protectedFiles];
        return true;
      },
    });
    assert.equal(session.result.response?.status, 200);
    assert.deepEqual(got, ['/root/dev.variables.json']);
    assert.equal(server.count(), 1);
  } finally {
    await server.close();
  }
});
void test('T09: blocked target has no network side effect', async () => {
  const server = await fixture();
  try {
    await assert.rejects(fetchHttpRequest({ method: 'GET', url: `${server.base}/ok` }), HttpPolicyError);
    assert.equal(server.count(), 0);
  } finally {
    await server.close();
  }
});
void test('T04: redirect follows authorized location but refuses redirect to another private host', async () => {
  const server = await fixture();
  try {
    const a = await fetchHttpRequest({ method: 'GET', url: `${server.base}/redirect` }, { policy: local });
    assert.equal(a.result.response?.status, 200);
    await assert.rejects(
      fetchHttpRequest(
        { method: 'GET', url: `${server.base}/untrusted` },
        { policy: { allowHttp: true, allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true } },
      ),
      HttpPolicyError,
    );
  } finally {
    await server.close();
  }
});
void test('T04: response payload limit returns typed error and not truncated fake JSON', async () => {
  const server = await fixture();
  try {
    await assert.rejects(
      fetchHttpRequest(
        { method: 'GET', url: `${server.base}/large` },
        { policy: local, maxResponseBytes: 100 },
      ),
      (error: unknown) => error instanceof HttpExecutionError && error.code === 'BODY_TOO_LARGE',
    );
  } finally {
    await server.close();
  }
});
void test('T04: network abort results in response:null with diagnostic out of band', async () => {
  const server = await fixture();
  try {
    const ctrl = new AbortController();
    const request = fetchHttpRequest(
      { method: 'GET', url: `${server.base}/delay` },
      { policy: local, signal: ctrl.signal, timeoutMs: 1000 },
    );
    setTimeout(() => ctrl.abort(), 20);
    const session = await request;
    assert.equal(session.result.response, null);
    assert.equal(session.diagnostic?.code, 'ABORTED');
    assert.equal(validateExecutionResult(session.result).valid, true);
  } finally {
    await server.close();
  }
});
void test('T04: timeout results in typed diagnostic and response:null', async () => {
  const server = await fixture();
  try {
    const session = await fetchHttpRequest(
      { method: 'GET', url: `${server.base}/delay` },
      { policy: local, timeoutMs: 15 },
    );
    assert.equal(session.result.response, null);
    assert.equal(session.diagnostic?.code, 'TIMEOUT');
  } finally {
    await server.close();
  }
});
void test('T04: unsupported binary body fails before sending a request', async () => {
  const server = await fixture();
  try {
    await assert.rejects(
      fetchHttpRequest(
        { method: 'POST', url: `${server.base}/echo`, body: { type: 'binary', path: '../file.bin' } },
        { policy: local },
      ),
      (error: unknown) => error instanceof HttpExecutionError && error.code === 'UNSUPPORTED_BODY',
    );
    assert.equal(server.count(), 0);
  } finally {
    await server.close();
  }
});
