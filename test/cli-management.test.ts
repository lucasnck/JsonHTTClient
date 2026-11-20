import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile),
  cli = resolve(process.cwd(), 'dist/apps/cli/src/main.js');
async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), 'json-cli-mgmt-'));
  await mkdir(join(root, 'api'));
  return { root, dir: join(root, 'api'), close: () => rm(root, { recursive: true, force: true }) };
}
async function invoke(args: string[]) {
  return exec(process.execPath, [cli, ...args], { encoding: 'utf8' });
}
test('F02: CLI oauth save writes selected new variable file without token or activation of sibling', async () => {
  const f = await rootFixture();
  try {
    await writeFile(
      join(f.dir, 'dev.variables.json'),
      JSON.stringify({ enabled: true, baseUrl: 'https://dev.test' }),
    );
    const target = join(f.dir, 'prod.variables.json');
    const { stdout } = await invoke([
      'oauth',
      'save',
      '--issuer',
      'https://id.example.test',
      '--client-id',
      'prod-app',
      '--file',
      target,
      '--name',
      'OAuthToken',
      '--root',
      f.root,
    ]);
    const result = JSON.parse(stdout) as { configurationSaved: boolean; created: boolean; enabled: boolean };
    assert.equal(result.configurationSaved, true);
    assert.equal(result.created, true);
    assert.equal(result.enabled, false);
    const saved = JSON.parse(await readFile(target, 'utf8')) as {
      OAuthToken: { clientId: string };
      enabled: boolean;
    };
    assert.equal(saved.enabled, false);
    assert.equal(saved.OAuthToken.clientId, 'prod-app');
    assert.equal(
      (JSON.parse(await readFile(join(f.dir, 'dev.variables.json'), 'utf8')) as { enabled: boolean }).enabled,
      true,
    );
    assert.doesNotMatch(JSON.stringify(saved), /accessToken|refreshToken/);
  } finally {
    await f.close();
  }
});
test('F02: CLI variables activate switches only siblings in same directory', async () => {
  const f = await rootFixture();
  try {
    await writeFile(join(f.dir, 'dev.variables.json'), JSON.stringify({ enabled: true, baseUrl: 'dev' }));
    await writeFile(join(f.dir, 'prod.variables.json'), JSON.stringify({ enabled: false, baseUrl: 'prod' }));
    const { stdout } = await invoke([
      'variables',
      'activate',
      join(f.dir, 'prod.variables.json'),
      '--root',
      f.root,
    ]);
    assert.equal((JSON.parse(stdout) as { changedFiles: string[] }).changedFiles.length, 2);
    assert.equal(
      (JSON.parse(await readFile(join(f.dir, 'dev.variables.json'), 'utf8')) as { enabled: boolean }).enabled,
      false,
    );
    assert.equal(
      (JSON.parse(await readFile(join(f.dir, 'prod.variables.json'), 'utf8')) as { enabled: boolean })
        .enabled,
      true,
    );
  } finally {
    await f.close();
  }
});
test('F02: CLI import curl previews only, then explicitly applies under output dir', async () => {
  const f = await rootFixture();
  try {
    const input = join(f.root, 'request.txt');
    await writeFile(
      input,
      `curl -X POST 'https://api.example.test/users' -H 'Authorization: Bearer SECRET' -d '{"name":"Ada"}'`,
    );
    const { stdout } = await invoke(['import', 'curl', '--file', input, '--root', f.root]);
    const plan = JSON.parse(stdout) as { operations: Array<{ filename: string }>; warnings: unknown[] };
    assert.equal(plan.operations.length, 1);
    assert.ok(plan.warnings.length > 0);
    assert.doesNotMatch(stdout, /SECRET/);
    assert.deepEqual(await readdir(f.dir), []);
    const applied = await invoke([
      'import',
      'curl',
      '--file',
      input,
      '--root',
      f.root,
      '--apply',
      '--output-dir',
      f.dir,
    ]);
    const saved = JSON.parse(applied.stdout) as { files: string[] };
    assert.equal(saved.files.length, 1);
    const result = JSON.parse(await readFile(saved.files[0]!, 'utf8')) as {
      request: { headers: Array<{ name: string; value: string }> };
    };
    assert.equal(result.request.headers[0]?.value, '{{authorizationToken}}');
    await assert.rejects(
      invoke(['import', 'curl', '--file', input, '--root', f.root, '--apply', '--output-dir', f.dir]),
    );
  } finally {
    await f.close();
  }
});
test('F02: CLI import openapi JSON previews multiple requests, no files written', async () => {
  const f = await rootFixture();
  try {
    const file = join(f.root, 'openapi.json');
    await writeFile(
      file,
      JSON.stringify({
        openapi: '3.0.3',
        servers: [{ url: 'https://api.example.test' }],
        paths: { '/a': { get: { operationId: 'listA' } }, '/b': { post: { operationId: 'createB' } } },
      }),
    );
    const { stdout } = await invoke(['import', 'openapi', '--file', file, '--root', f.root]);
    assert.equal((JSON.parse(stdout) as { operations: unknown[] }).operations.length, 2);
    assert.deepEqual(await readdir(f.dir), []);
  } finally {
    await f.close();
  }
});
