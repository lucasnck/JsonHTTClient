import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpEngineMcpServer } from '../apps/mcp-server/src/server.js';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'json-http-mcp-'));
  const request = join(root, 'list.request.json');
  await writeFile(request, JSON.stringify({ request: { method: 'GET', url: '{{baseUrl}}/ok' } }));
  await writeFile(
    join(root, 'dev.variables.json'),
    JSON.stringify({ enabled: true, baseUrl: 'https://dev.example.com', secret: 'SECRET' }),
  );
  await writeFile(
    join(root, 'prod.variables.json'),
    JSON.stringify({ enabled: true, baseUrl: 'https://prod.example.com', secret: 'OTHER' }),
  );
  return { root, request, close: () => rm(root, { recursive: true, force: true }) };
}
const rpc = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const call = (id: number, name: string, args: Record<string, unknown>) =>
  rpc(id, 'tools/call', { name, arguments: args });
function content(reply: Record<string, unknown>) {
  const r = reply.result as { content: [{ text: string }]; isError?: boolean };
  return { value: JSON.parse(r.content[0].text) as Record<string, unknown>, isError: r.isError === true };
}
void test('F03: initialize advertises tools and ping responds with JSON-RPC 2.0', async () => {
  const f = await workspace();
  try {
    const mcp = new HttpEngineMcpServer({ root: f.root });
    const initialized = await mcp.process(rpc(1, 'initialize'));
    assert.equal((initialized?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    const list = await mcp.process(rpc(2, 'tools/list'));
    const names = (list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(names.includes('request_run'));
    assert.ok(names.includes('variables_activate_file'));
    assert.equal((await mcp.process(rpc(3, 'ping')))?.jsonrpc, '2.0');
    assert.equal(await mcp.process({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  } finally {
    await f.close();
  }
});
void test('F03: read-only tools list/validate/explain without exposing ordinary secret values', async () => {
  const f = await workspace();
  try {
    const mcp = new HttpEngineMcpServer({ root: f.root });
    const list = content((await mcp.process(call(1, 'request_list', {})))!);
    assert.deepEqual(list.value.requests, ['list.request.json']);
    const validation = content(
      (await mcp.process(call(2, 'request_validate', { file: 'list.request.json' })))!,
    );
    assert.equal(validation.value.valid, true);
    const explain = content(
      (await mcp.process(
        call(3, 'variables_explain', { requestFile: 'list.request.json', name: 'secret' }),
      ))!,
    );
    assert.equal(explain.value.origin, 'dev.variables.json');
    assert.equal(JSON.stringify(explain.value).includes('SECRET'), false);
    const variables = content((await mcp.process(call(4, 'variables_list', {})))!);
    assert.equal((variables.value.variableFiles as unknown[]).length, 2);
  } finally {
    await f.close();
  }
});
void test('F03: execution and variable mutations denied by default; tool arguments cannot grant permission', async () => {
  const f = await workspace();
  try {
    const mcp = new HttpEngineMcpServer({ root: f.root });
    const denied = content(
      (await mcp.process(call(1, 'request_run', { file: 'list.request.json', allowRun: true })))!,
    );
    assert.equal(denied.isError, true);
    assert.equal(denied.value.code, 'PERMISSION_DENIED');
    const mutate = content(
      (await mcp.process(call(2, 'variables_activate_file', { file: 'prod.variables.json' })))!,
    );
    assert.equal(mutate.value.code, 'PERMISSION_DENIED');
    const outside = content((await mcp.process(call(3, 'request_validate', { file: '../../etc/passwd' })))!);
    assert.equal(outside.isError, true);
    assert.equal(outside.value.code, 'OUTSIDE_ROOT');
    assert.equal(
      (JSON.parse(await readFile(join(f.root, 'dev.variables.json'), 'utf8')) as { enabled: boolean })
        .enabled,
      true,
    );
  } finally {
    await f.close();
  }
});
void test('F03: host-authorized variable activation applies exclusive sibling toggle', async () => {
  const f = await workspace();
  try {
    const mcp = new HttpEngineMcpServer({ root: f.root, allowWrite: true });
    const result = content(
      (await mcp.process(call(1, 'variables_activate_file', { file: 'prod.variables.json' })))!,
    );
    assert.equal(result.isError, false);
    assert.equal(
      (JSON.parse(await readFile(join(f.root, 'dev.variables.json'), 'utf8')) as { enabled: boolean })
        .enabled,
      false,
    );
    assert.equal(
      (JSON.parse(await readFile(join(f.root, 'prod.variables.json'), 'utf8')) as { enabled: boolean })
        .enabled,
      true,
    );
  } finally {
    await f.close();
  }
});
void test(
  'F03: host-authorized HTTP execution returns canonical masked result and Stop aborts in-flight request',
  { timeout: 15000 },
  async () => {
    const f = await workspace();
    let requests = 0;
    let signalWait!: () => void;
    const waitObserved = new Promise<void>((resolve) => {
      signalWait = resolve;
    });
    const server = createServer((req, res) => {
      requests++;
      if (req.url === '/wait') {
        signalWait();
        setTimeout(() => {
          if (!res.destroyed) res.end('ready');
        }, 3000);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await writeFile(join(f.root, 'dev.variables.json'), JSON.stringify({ enabled: true, baseUrl: url }));
      await writeFile(join(f.root, 'prod.variables.json'), JSON.stringify({ enabled: false }));
      const mcp = new HttpEngineMcpServer({
        root: f.root,
        allowRun: true,
        policy: { allowHttp: true, allowPrivateNetworks: true },
      });
      const result = content((await mcp.process(call(1, 'request_run', { file: 'list.request.json' })))!);
      assert.equal(result.isError, false);
      assert.deepEqual(Object.keys(result.value), ['request', 'response', 'timings']);
      assert.equal((result.value.response as { status: number }).status, 200);
      await writeFile(f.request, JSON.stringify({ request: { method: 'GET', url: '{{baseUrl}}/wait' } }));
      const running = mcp.process(call(2, 'request_run', { file: 'list.request.json' }));
      await waitObserved;
      const stopped = content((await mcp.process(call(3, 'execution_stop', {})))!);
      assert.equal(stopped.value.stopped, true);
      const response = content((await running)!);
      assert.equal(response.isError, false);
      assert.equal(response.value.response, null);
      assert.equal(requests, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  },
);
void test('F03: stdio process speaks newline-delimited JSON-RPC; no console banner', async () => {
  const f = await workspace();
  try {
    const child = spawn(process.execPath, ['dist/apps/mcp-server/src/main.js', '--root', f.root], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.write(JSON.stringify(rpc(1, 'initialize')) + '\n');
    child.stdin.write(JSON.stringify(rpc(2, 'tools/list')) + '\n');
    child.stdin.write(JSON.stringify(call(3, 'request_list', {})) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.end();
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', reject);
    });
    assert.equal(exit, 0, stderr);
    const lines = output
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x) as { id: number; result: unknown });
    assert.deepEqual(lines.map((x) => x.id).sort(), [1, 2, 3]);
    assert.equal(stderr, '');
  } finally {
    await f.close();
  }
});
void test('F03/T09: MCP host must expressly authorize protected run before any network I/O', async () => {
  const f = await workspace();
  let sent = 0;
  const server = createServer((_req, res) => {
    sent++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await writeFile(
      join(f.root, 'dev.variables.json'),
      JSON.stringify({ enabled: true, protected: true, baseUrl: url }),
    );
    await writeFile(join(f.root, 'prod.variables.json'), JSON.stringify({ enabled: false }));
    const policy = { allowHttp: true, allowPrivateNetworks: true };
    const denied = new HttpEngineMcpServer({ root: f.root, allowRun: true, policy });
    const reply = content((await denied.process(call(1, 'request_run', { file: 'list.request.json' })))!);
    assert.equal(reply.isError, true);
    assert.equal(reply.value.code, 'APPROVAL_REQUIRED');
    assert.equal(sent, 0);
    const approved = new HttpEngineMcpServer({ root: f.root, allowRun: true, allowProtected: true, policy });
    const permitted = content(
      (await approved.process(call(2, 'request_run', { file: 'list.request.json' })))!,
    );
    assert.equal(permitted.isError, false);
    assert.equal(sent, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
void test('F03: import_preview is read-only and cannot execute shell or create files', async () => {
  const f = await workspace();
  try {
    const mcp = new HttpEngineMcpServer({ root: f.root });
    const output = content(
      (await mcp.process(
        call(1, 'import_preview', {
          format: 'curl',
          source: 'curl -X GET https://public.example.com/customers',
        }),
      ))!,
    );
    assert.equal(output.isError, false);
    assert.equal((output.value.operations as unknown[]).length, 1);
    const names = (await import('node:fs/promises')).readdir(f.root);
    assert.deepEqual(
      (await names).filter((x) => x.endsWith('.request.json')),
      ['list.request.json'],
    );
    const evil = content(
      (await mcp.process(
        call(2, 'import_preview', { format: 'bash', source: 'curl https://example.com && echo PWNED' }),
      ))!,
    );
    assert.equal(evil.isError, true);
  } finally {
    await f.close();
  }
});
