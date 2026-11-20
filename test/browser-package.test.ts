import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
test('T08 browser ESM graph packs standalone without Node-only runtime modules', async () => {
  await exec(process.execPath, ['tooling/package-browser.mjs'], { cwd: process.cwd() });
  const base = resolve('artifacts/browser-esm');
  const entry = await readFile(join(base, 'index.mjs'), 'utf8');
  assert.match(entry, /index\.browser\.js/);
  const api = (await import(new URL(`file://${join(base, 'index.mjs')}`).href)) as {
    executeBrowserRequest?: unknown;
    BROWSER_CAPABILITIES?: { filesystem: boolean };
  };
  assert.equal(typeof api.executeBrowserRequest, 'function');
  assert.equal(api.BROWSER_CAPABILITIES?.filesystem, false);
  const seen = async (folder: string): Promise<string[]> => {
    let all: string[] = [];
    for (const f of await readdir(folder, { withFileTypes: true })) {
      if (f.isDirectory()) all.push(...(await seen(join(folder, f.name))));
      if (f.isFile() && f.name.endsWith('.js')) all.push(join(folder, f.name));
    }
    return all;
  };
  for (const file of await seen(base)) {
    const code = await readFile(file, 'utf8');
    assert.doesNotMatch(code, /from\s+['"]node:/, file);
  }
});
