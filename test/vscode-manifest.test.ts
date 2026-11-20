import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('F04 VS Code extension is native with Run/Stop and editor JSON schema mappings', async () => {
  const manifest = JSON.parse(await readFile(resolve('apps/vscode/package.json'), 'utf8')) as {
    type: string;
    main: string;
    contributes: {
      commands: Array<{ command: string }>;
      menus: Record<string, Array<{ command: string; when: string }>>;
      jsonValidation: Array<{ fileMatch: string | string[]; url: string }>;
    };
  };
  assert.equal(manifest.type, 'module');
  assert.match(manifest.main, /dist\/apps\/vscode\/src\/extension\.js$/);
  assert(manifest.contributes.commands.some((x) => x.command === 'jsonHttp.run'));
  assert(manifest.contributes.commands.some((x) => x.command === 'jsonHttp.stop'));
  assert(
    manifest.contributes.menus['editor/title']?.some(
      (x) => x.command === 'jsonHttp.stop' && x.when.includes('jsonHttp.running'),
    ),
  );
  assert(
    manifest.contributes.menus['explorer/context']?.some((x) => x.command === 'jsonHttp.activateVariables'),
  );
  assert(manifest.contributes.jsonValidation.some((x) => x.url.includes('request-file.schema.json')));
  assert(manifest.contributes.jsonValidation.some((x) => x.url.includes('variables-file.schema.json')));
  const extension = await readFile(resolve('apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /openTextDocument\(\{language:'json',content:output\.json\}\)/);
  assert.doesNotMatch(extension, /(createWebviewPanel|WebviewViewProvider|TreeDataProvider)/);
});
