#!/usr/bin/env node
/** Reproducible, platform-aware desktop workflow. No shell-evaluated user inputs. */
import { spawnSync, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const desktop = join(root, 'apps', 'desktop');
const ui = join(desktop, 'ui');
const native = join(desktop, 'src-tauri');
const runtimeFolder = join(native, 'resources', 'runtime');
const runtimeFile = join(runtimeFolder, process.platform === 'win32' ? 'node.exe' : 'node');
const supportedOS = ['win32', 'darwin', 'linux'];

export function invoke(bin, args, { cwd = root, dryRun = false } = {}) {
  const shown = [bin, ...args].map((x) => JSON.stringify(x)).join(' ');
  process.stdout.write(`${dryRun ? '[DRY RUN] ' : '> '}${shown}\n`);
  if (dryRun) return;
  const r = spawnSync(bin, args, { cwd, stdio: 'inherit', shell: false, env: process.env });
  if (r.error) throw new Error(`Unable to launch ${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} exited with status ${r.status ?? 'unknown'}`);
}

function probe(bin, args = []) {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
  return res.error || res.status !== 0 ? null : String(res.stdout || res.stderr || '').trim();
}
function major(version) {
  const match = /v?(\d+)/.exec(version ?? '');
  return match ? Number(match[1]) : 0;
}
function packageManifest(cwd) {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
}
function missingPackages(cwd) {
  const pkg = packageManifest(cwd);
  const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    (name) => !existsSync(join(cwd, 'node_modules', ...name.split('/'), 'package.json')),
  );
  if (missing.length) return missing;
  const verified = spawnSync('npm', ['ls', '--depth=0', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    shell: false,
  });
  return verified.status === 0 ? [] : ['npm dependency tree is invalid (npm ls --depth=0)'];
}
function linuxDependencies() {
  if (process.platform !== 'linux') return [];
  const packages = [
    ['webkit2gtk-4.1', 'WebKitGTK 4.1 development libraries'],
    ['gtk+-3.0', 'GTK 3 headers'],
    ['ayatana-appindicator3-0.1', 'Ayatana AppIndicator headers'],
    ['librsvg-2.0', 'librsvg headers'],
  ];
  if (!probe('pkg-config', ['--version'])) return ['pkg-config executable'];
  const missing = packages.filter(([name]) => probe('pkg-config', ['--exists', name]) === null);
  if (!probe('cc', ['--version'])) missing.push(['cc', 'C compiler']);
  return missing.map(([name, description]) => `${name} (${description})`);
}
function platformDependencies() {
  if (process.platform === 'linux') return linuxDependencies();
  if (process.platform === 'darwin') return probe('xcode-select', ['-p']) ? [] : ['Xcode Command Line Tools'];
  if (process.platform === 'win32') {
    const issues = [];
    const vswhere = join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    );
    if (
      !existsSync(vswhere) ||
      !probe(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ])
    )
      issues.push('Visual Studio C++ Build Tools');
    const webview = join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft',
      'EdgeWebView',
      'Application',
    );
    if (!existsSync(webview)) issues.push('Microsoft Edge WebView2 Runtime (verify installation)');
    return issues;
  }
  return ['Unsupported OS'];
}
export function inspect() {
  const packages = { root: missingPackages(root), ui: missingPackages(ui), tauri: missingPackages(desktop) };
  const config = JSON.parse(readFileSync(join(native, 'tauri.conf.json'), 'utf8'));
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    nodeOK: major(process.version) >= 22,
    npm: probe('npm', ['--version']),
    cargo: probe('cargo', ['--version']),
    rustc: probe('rustc', ['--version']),
    systemMissing: platformDependencies(),
    packagesMissing: packages,
    lockfiles: {
      root: existsSync(join(root, 'package-lock.json')),
      ui: existsSync(join(ui, 'package-lock.json')),
      tauri: existsSync(join(desktop, 'package-lock.json')),
    },
    outputs: {
      core: existsSync(join(root, 'dist', 'apps', 'desktop', 'src', 'sidecar.js')),
      frontend: existsSync(join(ui, 'dist', 'index.html')),
      runtime: existsSync(runtimeFile),
    },
    config: {
      bundled: config.bundle?.active === true,
      frontendDist: config.build?.frontendDist,
      runtimeResource: config.bundle?.resources?.['resources/runtime/'],
      engineResource: config.bundle?.resources?.['../../../dist/'],
    },
  };
}
function showDoctor(info, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  const mark = (v) => (v ? 'OK' : 'MISSING');
  process.stdout.write(`Desktop environment (${info.os}/${info.arch})\n`);
  process.stdout.write(`  Node ${info.node} (>=22): ${mark(info.nodeOK)}; npm: ${info.npm ?? 'MISSING'}\n`);
  process.stdout.write(`  Cargo: ${info.cargo ?? 'MISSING'}; Rust: ${info.rustc ?? 'MISSING'}\n`);
  process.stdout.write(`  Native SDK: ${info.systemMissing.length ? info.systemMissing.join(', ') : 'OK'}\n`);
  for (const [key, missing] of Object.entries(info.packagesMissing)) {
    process.stdout.write(
      `  npm ${key}: ${missing.length ? `${missing.length} missing (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''})` : 'OK'}; lockfile: ${mark(info.lockfiles[key])}\n`,
    );
  }
  process.stdout.write(
    `  compiled engine: ${mark(info.outputs.core)}; UI: ${mark(info.outputs.frontend)}; bundled Node: ${mark(info.outputs.runtime)}\n`,
  );
  process.stdout.write(
    'System prerequisite setup: scripts/bootstrap-desktop.sh or scripts/bootstrap-desktop.ps1.\n',
  );
}
function verifyBasics({ nativeRequired = true } = {}) {
  if (!supportedOS.includes(process.platform)) throw new Error(`Unsupported desktop OS: ${process.platform}`);
  if (major(process.version) < 22) throw new Error('Node >=22 required. Use the platform bootstrap script.');
  if (!probe('npm', ['--version'])) throw new Error('npm executable not available');
  if (nativeRequired) {
    if (!probe('cargo', ['--version']) || !probe('rustc', ['--version']))
      throw new Error('Rust/Cargo missing. Use bootstrap scripts with --install-system / -InstallSystem.');
    const missing = platformDependencies();
    if (missing.length) throw new Error(`Native Tauri prerequisites missing: ${missing.join(', ')}`);
  }
}
function installPackages({ dryRun = false, offline = false } = {}) {
  for (const [name, dir] of [
    ['root', root],
    ['ui', ui],
    ['tauri', desktop],
  ]) {
    const missing = missingPackages(dir);
    if (!missing.length) {
      process.stdout.write(`[skip] ${name}: dependencies already installed\n`);
      continue;
    }
    const method = existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install';
    invoke('npm', [method, '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], {
      cwd: dir,
      dryRun,
    });
  }
}
export function stageRuntime({ dryRun = false } = {}) {
  verifyBasics({ nativeRequired: false });
  if (!existsSync(process.execPath)) throw new Error('Node executable could not be resolved');
  if (process.platform === 'win32' && !process.execPath.toLowerCase().endsWith('.exe'))
    throw new Error('Unsupported Windows Node executable');
  if (existsSync(runtimeFile)) {
    if (lstatSync(runtimeFile).isSymbolicLink()) throw new Error('Refusing symlink as bundled Node runtime');
    const line = probe(runtimeFile, [
      '-p',
      'JSON.stringify([process.platform,process.arch,process.versions.node])',
    ]);
    try {
      const [p, a, v] = JSON.parse(line ?? 'null');
      if (p === process.platform && a === process.arch && v === process.versions.node) {
        process.stdout.write(`[skip] bundled Node already matches ${p}/${a} v${v}\n`);
        return;
      }
    } catch {
      /* stale or corrupt runtime */
    }
  }
  process.stdout.write(
    `Stage local Node ${process.version} (${process.platform}/${process.arch}) into desktop release resources\n`,
  );
  if (dryRun) {
    process.stdout.write(`[DRY RUN] copy ${process.execPath} -> ${runtimeFile}\n`);
    return;
  }
  mkdirSync(runtimeFolder, { recursive: true });
  if (lstatSync(runtimeFolder).isSymbolicLink()) throw new Error('Refusing symlink runtime directory');
  const temp = join(runtimeFolder, `node.tmp-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
  try {
    copyFileSync(process.execPath, temp);
    if (process.platform !== 'win32') chmodSync(temp, 0o755);
    const result = probe(temp, [
      '-p',
      'JSON.stringify([process.platform,process.arch,process.versions.node])',
    ]);
    const expected = JSON.stringify([process.platform, process.arch, process.versions.node]);
    if (result !== expected)
      throw new Error('Bundled Node verification failed: wrong OS, architecture or version');
    if (existsSync(runtimeFile)) rmSync(runtimeFile);
    renameSync(temp, runtimeFile);
  } finally {
    if (existsSync(temp)) rmSync(temp);
  }
}
function help() {
  process.stdout.write(
    `Usage: node tooling/desktop-workflow.mjs <doctor|setup|dev|build|runtime> [--dry-run] [--offline] [--json]\n`,
  );
}
export function main(argv = process.argv.slice(2)) {
  const [command = 'doctor', ...rest] = argv;
  const allowed = ['--dry-run', '--offline', '--json'];
  for (const arg of rest) if (!allowed.includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  const dryRun = rest.includes('--dry-run'),
    offline = rest.includes('--offline');
  if (command === 'doctor') {
    const info = inspect();
    showDoctor(info, { json: rest.includes('--json') });
    return info.nodeOK &&
      info.npm &&
      info.cargo &&
      info.rustc &&
      info.systemMissing.length === 0 &&
      Object.values(info.packagesMissing).every((items) => items.length === 0)
      ? 0
      : 1;
  }
  if (rest.includes('--json')) throw new Error('--json is only supported by doctor');
  if (command === 'setup') {
    verifyBasics({ nativeRequired: false });
    installPackages({ dryRun, offline });
    process.stdout.write(
      'JavaScript dependencies checked. Native prerequisites must also pass desktop:doctor.\n',
    );
    return 0;
  }
  if (command === 'runtime') {
    stageRuntime({ dryRun });
    return 0;
  }
  if (command === 'dev' || command === 'build') {
    verifyBasics({ nativeRequired: !dryRun });
    installPackages({ dryRun, offline });
    invoke('npm', ['run', 'build'], { cwd: root, dryRun });
    if (command === 'dev') {
      invoke('npm', ['run', 'dev'], { cwd: desktop, dryRun });
    } else {
      invoke('npm', ['run', 'build'], { cwd: ui, dryRun });
      stageRuntime({ dryRun });
      invoke('npm', ['run', 'desktop:bundle:check'], { cwd: root, dryRun });
      invoke('npm', ['run', 'build'], { cwd: desktop, dryRun });
    }
    return 0;
  }
  help();
  return 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`Desktop workflow FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
