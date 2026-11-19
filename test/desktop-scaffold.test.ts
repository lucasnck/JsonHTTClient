import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const read=async(path:string)=>readFile(join(process.cwd(),path),'utf8');
test('F06 Tauri 2 manifest points to React/Monaco UI and native Rust IPC only',async()=>{
  const config=JSON.parse(await read('apps/desktop/src-tauri/tauri.conf.json')) as any;
  const packageJson=JSON.parse(await read('apps/desktop/ui/package.json')) as any;
  const source=await read('apps/desktop/src-tauri/src/main.rs');
  assert.match(config.$schema,/tauri.app\/config\/2/);
  assert.equal(config.build.frontendDist,'../ui/dist');
  assert.equal(packageJson.dependencies['@monaco-editor/react'].startsWith('^'),true);
  assert.equal(packageJson.dependencies.react.startsWith('^'),true);
  assert.match(source,/rfd::FileDialog/);
  assert.match(source,/desktop_choose_workspace/);
  assert.match(source,/desktop_send/);
  assert.match(source,/"desktop-message"/);
  assert.doesNotMatch(source,/\.arg\("-c"\)/);
});
test('F06 release gate blocks packaging without a bundled runtime or missing UI build',async()=>{
  assert.throws(()=>execFileSync(process.execPath,['tooling/check-desktop-bundle.mjs'],{cwd:process.cwd(),stdio:'pipe'}));
});
test('F06 UI invokes only narrow Rust host calls and Monaco JS editor',async()=>{
  const frontend=await read('apps/desktop/ui/src/App.tsx');
  const client=await read('apps/desktop/ui/src/native.ts');
  assert.match(frontend,/\bEditor\b/);
  assert.match(client,/desktop_choose_workspace/);
  assert.match(client,/desktop_send/);
  assert.match(await read('apps/desktop/ui/src/main.tsx'),/loader.config\(\{monaco\}\)/);
  assert.match(await read('apps/desktop/ui/src/main.tsx'),/JsonWorker/);
  assert.doesNotMatch(client,/node:fs|child_process|exec\(/);
  assert.match(frontend,/importPreview/);
});
