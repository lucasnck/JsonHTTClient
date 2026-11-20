import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DesktopTabSessions, DesktopSessionError } from '../apps/desktop/src/tab-sessions.js';
import type {
  SessionStore,
  DesktopEngineBridge,
  PersistedWorkspaceSession,
} from '../apps/desktop/src/tab-sessions.js';
import { createNodeDesktopBridge } from '../apps/desktop/src/node-bridge.js';
const makeStore = (): SessionStore & { peek(): unknown } => {
  let state: unknown = null;
  return {
    read: async () => state,
    write: async (next: PersistedWorkspaceSession) => {
      state = structuredClone(next);
    },
    peek: () => state,
  };
};
const makeBridge = (): DesktopEngineBridge & {
  runs: number;
  saves: Array<{ file: string; content: string }>;
} => {
  const bridge = {
    runs: 0,
    saves: [] as Array<{ file: string; content: string }>,
    readRequest: async (path: string) => `contents for ${path}`,
    runRequest: async () => {
      bridge.runs++;
      return {
        json: '{"request":{},"response":{"headers":[{"name":"Authorization","value":"[REDACTED]"}]},"timings":{}}\n',
        warnings: [],
      };
    },
    saveAs: async (file: string, content: string) => {
      bridge.saves.push({ file, content });
    },
  };
  return bridge;
};
test('F06 restores only open request and redacted response tabs, without re-running HTTP', async () => {
  const bridge = makeBridge();
  const store = makeStore();
  const ui = new DesktopTabSessions(bridge, store);
  const req = await ui.openRequest('/workspace/get.request.json');
  const response = await ui.run(req);
  assert.equal(bridge.runs, 1);
  assert.equal(ui.activeTabId, response);
  const old = ui.openTabs.find((t) => t.id === response)!;
  ui.editTab(response, '{"custom":"a secret typed by the user"}\n');
  assert.equal(ui.openTabs.find((t) => t.id === response)?.dirty, true);
  // The response snapshot in app data is always the original masked result, not edited credentials.
  assert.equal(JSON.stringify(store.peek()).includes('a secret typed'), false);
  const restored = new DesktopTabSessions(bridge, store);
  await restored.restore();
  assert.equal(bridge.runs, 1);
  assert.deepEqual(
    restored.openTabs.map((x) => x.kind),
    ['request', 'response'],
  );
  assert.equal(restored.openTabs[1]?.content, old.content);
  assert.equal(restored.openTabs[1]?.dirty, false);
  await restored.close(response);
  const again = new DesktopTabSessions(bridge, store);
  await again.restore();
  assert.equal(again.openTabs.length, 1);
  assert.equal(again.openTabs[0]?.kind, 'request');
  assert.equal(bridge.runs, 1);
});
test('F06 can save user-edited Response JSON unchanged (no sensitivity validation)', async () => {
  const b = makeBridge();
  const tabs = new DesktopTabSessions(b, makeStore());
  const request = await tabs.openRequest('/workspace/get.request.json');
  const response = await tabs.run(request);
  tabs.editTab(response, '{ invalid-json: user can save }');
  await tabs.saveResponseAs(response, '/workspace/response.json');
  assert.deepEqual(b.saves, [
    { file: '/workspace/response.json', content: '{ invalid-json: user can save }' },
  ]);
  assert.equal(tabs.openTabs.find((x) => x.id === response)?.dirty, false);
});
test('F06 rejects invalid snapshots, closed tabs never reappear and no stale write races', async () => {
  const store = makeStore();
  const b = makeBridge();
  const ui = new DesktopTabSessions(b, store);
  const first = await ui.openRequest('/x/one.request.json');
  const second = await ui.openRequest('/x/two.request.json');
  await Promise.all([ui.close(first), ui.selectTab(second)]);
  const restored = new DesktopTabSessions(b, store);
  await restored.restore();
  assert.equal(restored.openTabs.length, 1);
  assert.equal(restored.openTabs[0]?.id, second);
  const broken: SessionStore = {
    read: async () => ({ version: 1, tabs: [{ id: 'foo', kind: 'evil' }] }),
    write: async () => {},
  };
  await assert.rejects(new DesktopTabSessions(b, broken).restore(), DesktopSessionError);
});
test('F06 Stop aborts an active bridge request and does not create Response tab', async () => {
  const b = makeBridge();
  b.runRequest = async (_path, _content, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  const sessions = new DesktopTabSessions(b, makeStore());
  const request = await sessions.openRequest('/w/get.request.json');
  const pending = sessions.run(request);
  assert.equal(sessions.stop(request), true);
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(
    sessions.openTabs.map((t) => t.kind),
    ['request'],
  );
  assert.equal(sessions.openTabs[0]?.running, false);
});
test('F06 Node bridge runs the shared HTTP SDK and never serializes real Authorization headers', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'json-http-desktop-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = join(folder, 'run.request.json');
    await writeFile(
      path,
      JSON.stringify({
        request: { method: 'GET', url, headers: [{ name: 'Authorization', value: 'Bearer example-secret' }] },
      }),
    );
    const bridge = await createNodeDesktopBridge({
      root: folder,
      policy: { allowHttp: true, allowPrivateNetworks: true },
    });
    const session = new DesktopTabSessions(bridge, makeStore());
    const request = await session.openRequest(path);
    const response = await session.run(request);
    const json = session.openTabs.find((x) => x.id === response)?.content ?? '';
    assert.match(json, /\[REDACTED\]/);
    assert.doesNotMatch(json, /example-secret/);
    assert.match(json, /"status": 200/);
    const savePath = join(folder, 'saved.json');
    await session.saveResponseAs(response, savePath);
    assert.equal(await readFile(savePath, 'utf8'), json);
    await assert.rejects(session.saveResponseAs(response, savePath), /EEXIST/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});
test('F06 Node bridge disallows filesystem escape via request and write parent symlink', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'json-http-desktop-safe-'));
  const outside = await mkdtemp(join(tmpdir(), 'json-http-desktop-outside-'));
  try {
    const bridge = await createNodeDesktopBridge({ root: folder });
    await assert.rejects(bridge.readRequest(join(outside, 'other.request.json')), /OUTSIDE_ROOT/);
    await symlink(outside, join(folder, 'escape'));
    await assert.rejects(bridge.saveAs(join(folder, 'escape', 'unexpected.json'), 'oops'), /OUTSIDE_ROOT/);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('F06 Node app-data session store persists only metadata and masked canonical response', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'json-http-desktop-store-'));
  try {
    const { NodeDesktopSessionStore } = await import('../apps/desktop/src/node-session-store.js');
    const store = new NodeDesktopSessionStore(folder, 'workspace-1');
    const bridge = makeBridge();
    const ui = new DesktopTabSessions(bridge, store);
    const request = await ui.openRequest('/workspace/request.request.json');
    const response = await ui.run(request);
    ui.editTab(response, 'Authorization: Bearer secret typed by user');
    const stored = await readFile(join(folder, 'session-workspace-1.json'), 'utf8');
    assert.doesNotMatch(stored, /secret typed by user/);
    assert.match(stored, /REDACTED/);
    const disk = (await (await import('node:fs/promises')).stat(join(folder, 'session-workspace-1.json')))
      .mode;
    assert.equal(disk & 0o077, 0);
    await ui.close(response);
    const restored = new DesktopTabSessions(bridge, new NodeDesktopSessionStore(folder, 'workspace-1'));
    await restored.restore();
    assert.equal(restored.openTabs.length, 1);
    assert.equal(restored.openTabs[0]?.kind, 'request');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
