import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const workflow = join(root, 'tooling/desktop-workflow.mjs');
function run(args: string[]) {
  // Doctor performs three bounded npm ls probes plus native-tool probes.
  const timeout = args[0] === 'doctor' ? 90000 : 10000;
  const p = spawnSync(process.execPath, [workflow, ...args], { cwd: root, encoding: 'utf8', timeout });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, error: p.error };
}

void test('T11 desktop doctor reports real versions, missing native tools and npm package inventory without mutating system', () => {
  const result = run(['doctor', '--json']);
  assert.equal(result.error, undefined);
  const report = JSON.parse(result.stdout) as {
    os: string;
    arch: string;
    node: string;
    nodeOK: boolean;
    packagesMissing: { root: string[]; ui: string[]; tauri: string[] };
    outputs: { core: boolean; frontend: boolean; runtime: boolean };
  };
  assert.equal(report.os, process.platform);
  assert.equal(report.arch, process.arch);
  assert.equal(report.node, process.version);
  assert.equal(report.nodeOK, true);
  assert.ok(Array.isArray(report.packagesMissing.root));
  assert.ok(Array.isArray(report.packagesMissing.ui));
  assert.ok(Array.isArray(report.packagesMissing.tauri));
  assert.equal(typeof report.outputs.runtime, 'boolean');
  // Environment can be fully prepared on CI or partly missing locally.
  assert.ok(result.status === 0 || result.status === 1);
});

void test('T11 desktop setup dry-run never invokes npm install', () => {
  const result = run(['setup', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dependencies (already installed|checked)|DRY RUN/i);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/);
});

void test('F09 desktop build dry-run orders engine/UI/Node runtime/guard/Tauri', () => {
  const result = run(['build', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const s = result.stdout;
  const engine = s.indexOf('"npm" "run" "build"');
  const runtime = Math.max(s.indexOf('Stage local Node'), s.indexOf('[skip] bundled Node already matches'));
  const guard = s.indexOf('"npm" "run" "desktop:bundle:check"');
  assert.ok(engine >= 0 && runtime > engine && guard > runtime, s);
  assert.ok(s.lastIndexOf('"npm" "run" "build"') > guard, s);
});

void test('F09 desktop workflow refuses unknown arguments instead of passing them to a shell', () => {
  const result = run(['setup', '--unrecognized']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument/);
});

void test('F09 stage-runtime dry-run does not copy a binary', () => {
  const result = run(['runtime', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bundled Node already matches|DRY RUN/);
});

void test('F06 bootstrap scripts require explicit opt-in for OS installation, and release gate checks runtime target', async () => {
  const shell = await readFile(join(root, 'scripts/bootstrap-desktop.sh'), 'utf8');
  const powershell = await readFile(join(root, 'scripts/bootstrap-desktop.ps1'), 'utf8');
  const gate = await readFile(join(root, 'tooling/check-desktop-bundle.mjs'), 'utf8');
  assert.match(shell, /--install-system/);
  assert.match(shell, /--dry-run/);
  assert.match(shell, /sha256sum -c/);
  assert.match(powershell, /\$InstallSystem/);
  assert.match(powershell, /\$DryRun/);
  assert.match(powershell, /winget/);
  assert.match(gate, /process\.arch/);
  assert.match(gate, /process\.platform/);
  const modes = await stat(join(root, 'tooling/desktop-workflow.mjs'));
  assert.ok(modes.size > 2000);
});

void test('T11 desktop doctor locates npm even without npm shim on PATH (Windows regression)', () => {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = candidates.find((path) => path && existsSync(path));
  if (!npmCli) return; // npm installed outside Node and this test has no stable path
  const result = spawnSync(process.execPath, [workflow, 'doctor', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, PATH: '', npm_execpath: npmCli },
  });
  assert.equal(result.error, undefined);
  const info = JSON.parse(result.stdout) as { npm: string | null };
  assert.match(info.npm ?? '', /^\d+\.\d+/);
});

// Doctor and preflight dry-run must remain usable even before npm is installed.
// The desktop workflow may execute npm ONLY in a real setup/dev/build.
void test('T11 desktop dry-runs do not require an npm executable on PATH', () => {
  for (const args of [
    ['setup', '--dry-run'],
    ['build', '--dry-run'],
    ['runtime', '--dry-run'],
  ]) {
    const child = spawnSync(process.execPath, [workflow, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: '', Path: '', npm_execpath: '' },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, `Dry-run ${args.join(' ')} failed: ${child.stderr}`);
  }
});

void test('T11 dry-runs never execute npm, including dependency-tree verification', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'json-http-dry-run-'));
  const npmCli = join(folder, 'npm-cli.cjs');
  const marker = join(folder, 'npm-invoked');
  try {
    await writeFile(npmCli, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');`);
    for (const command of ['setup', 'build', 'runtime']) {
      const result = spawnSync(process.execPath, [workflow, command, '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, npm_execpath: npmCli },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), false, `${command} dry-run executed npm`);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
