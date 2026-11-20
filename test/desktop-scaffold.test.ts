import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const read = async (path: string) => readFile(join(process.cwd(), path), 'utf8');
test('F06 Tauri 2 manifest points to React/Monaco UI and native Rust IPC only', async () => {
  const config = JSON.parse(await read('apps/desktop/src-tauri/tauri.conf.json')) as any;
  const packageJson = JSON.parse(await read('apps/desktop/ui/package.json')) as any;
  const source = await read('apps/desktop/src-tauri/src/main.rs');
  assert.match(config.$schema, /tauri.app\/config\/2/);
  assert.equal(config.build.frontendDist, '../ui/dist');
  assert.equal(packageJson.dependencies['@monaco-editor/react'].startsWith('^'), true);
  assert.equal(packageJson.dependencies.react.startsWith('^'), true);
  assert.match(source, /rfd::FileDialog/);
  assert.match(source, /desktop_choose_workspace/);
  assert.match(source, /desktop_send/);
  assert.match(source, /"desktop-message"/);
  assert.doesNotMatch(source, /\.arg\("-c"\)/);
});
test('F06 release gate matches actual build readiness, not a hardcoded failure expectation', async () => {
  const paths = [
    'dist/apps/desktop/src/sidecar.js',
    'apps/desktop/ui/dist/index.html',
    `apps/desktop/src-tauri/resources/runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
  ];
  const ready = paths.every((path) => existsSync(join(process.cwd(), path)));
  const result = spawnSync(process.execPath, ['tooling/check-desktop-bundle.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (ready) assert.equal(result.status, 0, result.stderr);
  else {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Desktop bundle NOT READY/);
  }
});
test('F06 UI invokes only narrow Rust host calls and Monaco JS editor', async () => {
  const frontend = await read('apps/desktop/ui/src/App.tsx');
  const client = await read('apps/desktop/ui/src/native.ts');
  assert.match(frontend, /\bEditor\b/);
  assert.match(client, /desktop_choose_workspace/);
  assert.match(client, /desktop_send/);
  assert.match(await read('apps/desktop/ui/src/main.tsx'), /loader.config\(\{monaco\}\)/);
  assert.match(await read('apps/desktop/ui/src/main.tsx'), /JsonWorker/);
  assert.doesNotMatch(client, /node:fs|child_process|exec\(/);
  assert.match(frontend, /importPreview/);
});
