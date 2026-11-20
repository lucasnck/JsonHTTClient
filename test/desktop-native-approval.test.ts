import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  createDesktopProtocol,
  sanitizeNativeApprovalDisplayText,
} from '../apps/desktop/src/sidecar-protocol.js';
import type { DesktopMessage } from '../apps/desktop/src/sidecar-protocol.js';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'jhc-approve-'));
  const appData = await mkdtemp(join(tmpdir(), 'jhc-approve-data-'));
  return {
    root,
    appData,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(appData, { recursive: true, force: true });
    },
  };
}
async function listener() {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/do-not-send?token=keep-private`;
  return {
    url,
    get hits() {
      return hits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function approvalEvent(
  m: DesktopMessage,
): m is Extract<DesktopMessage, { event: 'native-approval-request' }> {
  return 'event' in m && m.event === 'native-approval-request';
}
function response(m: DesktopMessage) {
  assert.ok('ok' in m, 'Expected request response, not an event');
  return m;
}
async function waitFor(fn: () => boolean, limitMs = 800): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > limitMs) throw new Error('Timed out waiting for IPC event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function createProtectedRequest(root: string, url: string) {
  const file = join(root, 'dev.variables.json');
  await writeFile(
    file,
    JSON.stringify({ enabled: true, protected: true, baseUrl: url, authorizationToken: 'test-secret' }),
  );
  const request = join(root, 'test.request.json');
  await writeFile(
    request,
    JSON.stringify({
      request: {
        method: 'GET',
        url: '{{baseUrl}}',
        headers: [{ name: 'Authorization', value: 'Bearer {{authorizationToken}}' }],
      },
    }),
  );
  return request;
}
const localPolicy = { allowHttp: true, allowPrivateNetworks: true };

void test('F10 native challenge reveals origins, not tokens; approval is one-use and precedes HTTP', async () => {
  const w = await workspace();
  const server = await listener();
  const events: DesktopMessage[] = [];
  try {
    const path = await createProtectedRequest(w.root, server.url);
    const p = await createDesktopProtocol({
      root: w.root,
      appData: w.appData,
      policy: localPolicy,
      nativeApprovalEnabled: true,
      emit: (m) => events.push(m),
    });
    await p.dispatch({ id: 'open', op: 'open', args: { path } });
    const tab = (response(events.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      activeTabId: string;
    };
    const running = p.dispatch({ id: 'run', op: 'run', args: { tabId: tab.activeTabId, approved: true } });
    await waitFor(() => events.some(approvalEvent));
    const challenge = events.find(approvalEvent)!;
    assert.deepEqual(challenge.origins, [new URL(server.url).origin]);
    assert.deepEqual(challenge.protectedFiles, ['dev.variables.json']);
    assert.equal(challenge.method, 'GET');
    assert.equal(challenge.count, 1);
    assert.doesNotMatch(JSON.stringify(challenge), /keep-private|test-secret|authorizationToken/i);
    assert.equal(server.hits, 0, 'No HTTP before the native decision');
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), true);
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), false, 'Challenge cannot be replayed');
    await running;
    assert.equal(server.hits, 1);
    const result = (response(events.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      tabs: { kind: string; content: string }[];
    };
    assert.equal(result.tabs.at(-1)?.kind, 'response');
    assert.match(result.tabs.at(-1)!.content, /\[REDACTED\]/);
    assert.doesNotMatch(result.tabs.at(-1)!.content, /test-secret/);
  } finally {
    await server.close();
    await w.cleanup();
  }
});

void test('F10 default-deny, explicit refusal, timeout and malformed response never send HTTP', async () => {
  const w = await workspace();
  const server = await listener();
  try {
    const path = await createProtectedRequest(w.root, server.url);
    for (const scenario of ['disabled', 'denied', 'timeout'] as const) {
      const out: DesktopMessage[] = [];
      const p = await createDesktopProtocol({
        root: w.root,
        appData: w.appData,
        policy: localPolicy,
        nativeApprovalEnabled: scenario !== 'disabled',
        approvalTimeoutMs: 110,
        emit: (m) => out.push(m),
      });
      await p.dispatch({ id: 'open', op: 'open', args: { path } });
      const tab = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
        activeTabId: string;
      };
      const pending = p.dispatch({ id: 'run', op: 'run', args: { tabId: tab.activeTabId } });
      if (scenario !== 'disabled') {
        await waitFor(() => out.some(approvalEvent));
        const challenge = out.find(approvalEvent)!;
        if (scenario === 'denied') {
          assert.equal(
            p.resolveNativeApproval(challenge.challenge, 'true'),
            false,
            'String cannot grant permission',
          );
          assert.equal(p.resolveNativeApproval(challenge.challenge, false), true);
        }
      }
      await pending;
      assert.equal((response(out.at(-1)!) as Extract<DesktopMessage, { ok: false }>).ok, false, scenario);
      assert.equal(server.hits, 0, scenario);
    }
  } finally {
    await server.close();
    await w.cleanup();
  }
});

void test('F10 Stop cancels a pending native approval and ignores a late Yes', async () => {
  const w = await workspace();
  const server = await listener();
  const out: DesktopMessage[] = [];
  try {
    const path = await createProtectedRequest(w.root, server.url);
    const p = await createDesktopProtocol({
      root: w.root,
      appData: w.appData,
      policy: localPolicy,
      nativeApprovalEnabled: true,
      emit: (m) => out.push(m),
    });
    await p.dispatch({ id: 'open', op: 'open', args: { path } });
    const tab = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      activeTabId: string;
    };
    const running = p.dispatch({ id: 'run', op: 'run', args: { tabId: tab.activeTabId } });
    await waitFor(() => out.some(approvalEvent));
    const challenge = out.find(approvalEvent)!;
    await p.dispatch({ id: 'stop', op: 'stop', args: { tabId: tab.activeTabId } });
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), false, 'Expired approval must fail');
    await running;
    assert.equal(server.hits, 0);
  } finally {
    await server.close();
    await w.cleanup();
  }
});

void test('F10 sidecar sends protected challenge over private stdio and accepts a host reply', async () => {
  const w = await workspace();
  const server = await listener();
  const child = spawn(
    process.execPath,
    [
      'dist/apps/desktop/src/sidecar.js',
      '--root',
      w.root,
      '--app-data',
      w.appData,
      '--allow-http',
      '--allow-private-network',
      '--native-approval',
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const packets: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      packets.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* Ignore non-JSON diagnostic lines from the child process. */
    }
  });
  try {
    const path = await createProtectedRequest(w.root, server.url);
    const send = (id: string, op: string, args: Record<string, unknown> = {}) =>
      child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    send('open', 'open', { path });
    // Starting a Node child under the full Windows suite can exceed 800 ms.
    // Keep the shorter waits for protocol events after startup.
    await waitFor(() => packets.some((x) => x.id === 'open'), 10000);
    const open = packets.find((x) => x.id === 'open')!;
    const tab = (open.result as { activeTabId: string }).activeTabId;
    send('run', 'run', { tabId: tab, approved: true });
    await waitFor(() => packets.some((x) => x.event === 'native-approval-request'));
    assert.equal(server.hits, 0);
    const request = packets.find((x) => x.event === 'native-approval-request')!;
    const challenge = request.challenge;
    assert.equal(typeof challenge, 'string');
    // Only Rust can write this reserved response to stdin; desktop_send rejects it.
    child.stdin.write(JSON.stringify({ op: '__nativeApprovalResponse', challenge, approved: true }) + '\n');
    await waitFor(() => packets.some((x) => x.id === 'run'));
    assert.equal(packets.find((x) => x.id === 'run')!.ok, true);
    assert.equal(server.hits, 1);
  } finally {
    child.kill();
    await server.close();
    await w.cleanup();
  }
});

void test('F08 native import confirmation creates files only after OS-host approval', async () => {
  const w = await workspace();
  const out: DesktopMessage[] = [];
  try {
    const p = await createDesktopProtocol({
      root: w.root,
      appData: w.appData,
      nativeImportEnabled: true,
      emit: (m) => out.push(m),
    });
    await p.dispatch({
      id: 'preview',
      op: 'importPreview',
      args: {
        format: 'curl',
        text: 'curl -H "Authorization: Bearer super-secret" https://api.example.com/resource?token=hidden',
      },
    });
    const preview = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      planId: string;
      plan: { operations: { filename: string }[] };
    };
    const pending = p.dispatch({
      id: 'apply',
      op: 'importApply',
      args: { planId: preview.planId, folder: w.root, approved: true },
    });
    await waitFor(() => out.some((m) => 'event' in m && m.event === 'native-import-approval-request'));
    const challenge = out.find(
      (m): m is Extract<DesktopMessage, { event: 'native-import-approval-request' }> =>
        'event' in m && m.event === 'native-import-approval-request',
    )!;
    assert.equal(challenge.folder, '.');
    assert.equal(challenge.count, 1);
    assert.equal(challenge.files[0], preview.plan.operations[0]!.filename);
    assert.doesNotMatch(JSON.stringify(challenge), /super-secret|hidden|Bearer|https:\/\//);
    await assert.rejects(readFile(join(w.root, challenge.files[0]), 'utf8'));
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), true);
    await pending;
    assert.equal((response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).ok, true);
    assert.equal(
      (await readFile(join(w.root, challenge.files[0]), 'utf8')).includes('authorizationToken'),
      true,
    );
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), false, 'No replay');
    await p.dispatch({ id: 'repeat', op: 'importApply', args: { planId: preview.planId, folder: w.root } });
    assert.equal(
      (response(out.at(-1)!) as Extract<DesktopMessage, { ok: false }>).error.code,
      'PREVIEW_REQUIRED',
    );
  } finally {
    await w.cleanup();
  }
});

void test('F08 rejected or expired import challenge cannot create files or reuse preview', async () => {
  const w = await workspace();
  try {
    for (const decision of ['deny', 'timeout'] as const) {
      const out: DesktopMessage[] = [];
      const p = await createDesktopProtocol({
        root: w.root,
        appData: w.appData,
        nativeImportEnabled: true,
        approvalTimeoutMs: 110,
        emit: (m) => out.push(m),
      });
      await p.dispatch({
        id: 'preview',
        op: 'importPreview',
        args: { format: 'curl', text: `curl https://example.com/${decision}` },
      });
      const preview = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
        planId: string;
        plan: { operations: { filename: string }[] };
      };
      const running = p.dispatch({
        id: 'apply',
        op: 'importApply',
        args: { planId: preview.planId, folder: w.root },
      });
      await waitFor(() => out.some((m) => 'event' in m && m.event === 'native-import-approval-request'));
      const event = out.find(
        (m): m is Extract<DesktopMessage, { event: 'native-import-approval-request' }> =>
          'event' in m && m.event === 'native-import-approval-request',
      )!;
      if (decision === 'deny') assert.equal(p.resolveNativeApproval(event.challenge, false), true);
      await running;
      assert.equal(
        (response(out.at(-1)!) as Extract<DesktopMessage, { ok: false }>).error.code,
        'IMPORT_APPLY_NOT_AUTHORIZED',
      );
      assert.equal(p.resolveNativeApproval(event.challenge, true), false, 'Expired/denied confirmation');
      await p.dispatch({ id: 'replay', op: 'importApply', args: { planId: preview.planId, folder: w.root } });
      assert.equal(
        (response(out.at(-1)!) as Extract<DesktopMessage, { ok: false }>).error.code,
        'PREVIEW_REQUIRED',
      );
      await assert.rejects(readFile(join(w.root, preview.plan.operations[0]!.filename), 'utf8'));
    }
  } finally {
    await w.cleanup();
  }
});

void test('F10/F08 Tauri Rust host intercepts native challenge and never routes it to webview send allowlist', async () => {
  const main = await readFile('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(main, /native-approval-request/);
  assert.match(main, /native-import-approval-request/);
  assert.match(main, /MessageDialog/);
  assert.match(main, /__nativeApprovalResponse/);
  const allowlist = main.slice(main.indexOf('const OPERATIONS:'), main.indexOf('if !OPERATIONS.contains'));
  assert.doesNotMatch(allowlist, /__nativeApprovalResponse/);
  assert.match(main, /continue;\s*}\s*let _=handle.emit\("desktop-message"/);
});

void test('F10 protected foreach shows entire batch and blocks every HTTP call until approval', async () => {
  const w = await workspace();
  const server = await listener();
  const out: DesktopMessage[] = [];
  try {
    const path = await createProtectedRequest(w.root, server.url);
    const contents = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    contents.loop = {
      source: { kind: 'inline', items: [{ seq: 'a' }, { seq: 'b' }, { seq: 'c' }] },
      mode: 'sequential',
      onError: 'continue',
    };
    await writeFile(path, JSON.stringify(contents));
    const p = await createDesktopProtocol({
      root: w.root,
      appData: w.appData,
      policy: localPolicy,
      nativeApprovalEnabled: true,
      emit: (m) => out.push(m),
    });
    await p.dispatch({ id: 'open', op: 'open', args: { path } });
    const tab = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      activeTabId: string;
    };
    const running = p.dispatch({ id: 'run', op: 'run', args: { tabId: tab.activeTabId } });
    await waitFor(() => out.some(approvalEvent));
    const challenge = out.find(approvalEvent)!;
    assert.equal(challenge.count, 3);
    assert.equal(server.hits, 0);
    assert.equal(p.resolveNativeApproval(challenge.challenge, true), true);
    await running;
    assert.equal(server.hits, 3);
  } finally {
    await server.close();
    await w.cleanup();
  }
});

void test('F10 native dialog display strips control characters from protected filenames', async () => {
  const w = await workspace();
  const server = await listener();
  const out: DesktopMessage[] = [];
  try {
    const path = await createProtectedRequest(w.root, server.url);
    // A newline is illegal in Windows filenames; exercise sanitization as
    // pure data while retaining an actual protected-file approval round-trip.
    assert.equal(
      sanitizeNativeApprovalDisplayText('dev\nApprove anyway.variables.json', 100),
      'dev Approve anyway.variables.json',
    );
    const p = await createDesktopProtocol({
      root: w.root,
      appData: w.appData,
      policy: localPolicy,
      nativeApprovalEnabled: true,
      emit: (m) => out.push(m),
    });
    await p.dispatch({ id: 'open', op: 'open', args: { path } });
    const tab = (response(out.at(-1)!) as Extract<DesktopMessage, { ok: true }>).result as {
      activeTabId: string;
    };
    const pending = p.dispatch({ id: 'run', op: 'run', args: { tabId: tab.activeTabId } });
    await waitFor(() => out.some(approvalEvent));
    const event = out.find(approvalEvent)!;
    assert.deepEqual(event.protectedFiles, ['dev.variables.json']);
    assert.equal(event.protectedFiles[0]!.includes('\n'), false);
    p.resolveNativeApproval(event.challenge, false);
    await pending;
    assert.equal(server.hits, 0);
  } finally {
    await server.close();
    await w.cleanup();
  }
});
