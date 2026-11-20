import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as browserApi from '../packages/sdk-js/src/index.browser.js';

void test('T08: browser-safe entry compiles/imports and exposes pure interpolation', () => {
  assert.equal(typeof browserApi.interpolateRequest, 'function');
  assert.equal(typeof browserApi.validateRequestFile, 'function');
  assert.equal(typeof browserApi.hoverVariable, 'function');
  assert.equal(typeof browserApi.checkHttpTarget, 'function');
  assert.equal('executeRequestFile' in browserApi, false);
});
void test('T08: browser entry and pure core sources never import Node-only APIs', async () => {
  const files = [
    'packages/sdk-js/src/index.browser.ts',
    'packages/core/src/contracts/validation.ts',
    'packages/core/src/contracts/types.ts',
    'packages/core/src/variables/variables.ts',
    'packages/core/src/templates/interpolation.ts',
    'packages/core/src/security/policies.ts',
    'packages/language-service/src/language-service.ts',
  ];
  for (const file of files) {
    const text = await readFile(resolve(file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"](?:node:|fs['"]|http['"]|undici['"])/, file);
    assert.doesNotMatch(text, /\bBuffer\./, file);
  }
});
