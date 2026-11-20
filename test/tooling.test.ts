import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const readText = (name: string): Promise<string> => readFile(resolve(process.cwd(), name), 'utf8');

const readJson = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readText(name)) as Record<string, unknown>;

void test('T11: mandatory quality commands and dependencies are declared', async () => {
  const manifest = await readJson('package.json');
  const scripts = manifest.scripts as Record<string, string>;
  const deps = manifest.devDependencies as Record<string, string>;
  for (const name of ['format', 'format:check', 'lint', 'lint:fix', 'typecheck', 'build', 'test', 'check']) {
    assert.equal(typeof scripts[name], 'string', `Missing npm run ${name}`);
  }
  assert.match(scripts.check ?? '', /format:check.*lint.*typecheck.*test/);
  for (const name of [
    'eslint',
    'typescript-eslint',
    '@eslint/js',
    'eslint-config-prettier',
    'prettier',
    'typescript',
  ]) {
    assert.equal(typeof deps[name], 'string', `Missing devDependency ${name}`);
  }
});

void test('T11: TypeScript strict baseline is shared with the root project', async () => {
  const base = await readJson('tsconfig.base.json');
  const project = await readJson('tsconfig.json');
  const options = base.compilerOptions as Record<string, unknown>;
  for (const name of [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'isolatedModules',
  ]) {
    assert.equal(options[name], true, `Missing compiler option ${name}`);
  }
  assert.equal(options.module, 'NodeNext');
  assert.equal(project.extends, './tsconfig.base.json');
});

void test('T11: flat ESLint, Prettier and EditorConfig are configured', async () => {
  const eslint = await readText('eslint.config.mjs');
  const prettier = await readText('prettier.config.mjs');
  const editorconfig = await readText('.editorconfig');
  assert.match(eslint, /recommendedTypeChecked/);
  assert.match(eslint, /projectService: true/);
  assert.match(eslint, /eslint-config-prettier/);
  assert.match(prettier, /singleQuote: true/);
  assert.match(prettier, /endOfLine: 'lf'/);
  assert.match(editorconfig, /root = true/);
  assert.match(editorconfig, /insert_final_newline = true/);
});

void test('T11: toolchain JavaScript configs are syntactically valid without installing plugins', () => {
  for (const file of ['eslint.config.mjs', 'prettier.config.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
