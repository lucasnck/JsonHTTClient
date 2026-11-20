/** Static browser ESM dependency graph. No Node-only modules, no CDN endpoint invented. */
import { readFile, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path';
const cwd = process.cwd();
const dist = resolve(cwd, 'dist');
const out = resolve(cwd, 'artifacts/browser-esm');
const entry = resolve(dist, 'packages/sdk-js/src/index.browser.js');
const seen = new Set();
const imports = /\b(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;
async function walk(file) {
  const rel = relative(dist, file);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('Browser import escaped build root');
  if (seen.has(file)) return;
  const source = await readFile(file, 'utf8');
  if (
    /\b(?:from\s*['"]|import\s*\(['"])(?:node:|fs['"]|undici['"])/.test(source) ||
    /\bBuffer\./.test(source)
  )
    throw new Error(`Node-only dependency in browser build: ${rel}`);
  seen.add(file);
  for (const m of source.matchAll(imports)) {
    const sourcePath = m[1];
    if (!sourcePath) continue;
    await walk(resolve(dirname(file), sourcePath));
  }
}
await walk(entry);
await rm(out, { recursive: true, force: true });
for (const path of [...seen].sort()) {
  const target = resolve(out, relative(dist, path));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(path, target);
}
await writeFile(resolve(out, 'index.mjs'), "export * from './packages/sdk-js/src/index.browser.js';\n");
const version = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')).version;
await writeFile(resolve(out, 'package.json'), JSON.stringify({ type: 'module', version }, null, 2) + '\n');
await writeFile(
  resolve(out, 'README.md'),
  `# JsonHttp browser ESM ${version}\n\nStatic ESM module graph, browser-safe only. Host this entire folder on an HTTPS CDN with JavaScript MIME types, cache by immutable version, and import \`index.mjs\`. CORS restrictions remain enforced by the target API. No Node/filesystem/keychain. Not yet publicly deployed.\n`,
);
console.log(`Browser ESM built: ${seen.size} modules, ${out}`);
