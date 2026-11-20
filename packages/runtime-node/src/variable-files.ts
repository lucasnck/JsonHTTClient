import { readFile, realpath, readdir, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createVariableSnapshot,
  isVariablesFileName,
  planVariableFileActivation,
  validateVariablesFile,
} from '../../core/src/variables/variables.js';
import type { VariableSnapshot, VariablesFile } from '../../core/src/variables/variables.js';

export class VariableFileError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_FILE'
      | 'OUTSIDE_ROOT'
      | 'NOT_FOUND'
      | 'UNSAFE_PATH'
      | 'ACTIVATION_FAILED'
      | 'CONCURRENT_WRITE',
    message: string,
  ) {
    super(message);
    this.name = 'VariableFileError';
  }
}
function assertInside(root: string, location: string): void {
  const r = relative(root, location);
  if (r === '..' || r.startsWith('..' + sep) || (r !== '' && r.startsWith(sep)))
    throw new VariableFileError('OUTSIDE_ROOT', `Caminho fora da raiz autorizada: ${location}`);
}
async function safeRoot(root: string): Promise<string> {
  return realpath(root);
}
async function assertFileInside(root: string, filePath: string): Promise<void> {
  assertInside(root, resolve(filePath));
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new VariableFileError('UNSAFE_PATH', `Arquivo inválido ou symlink: ${filePath}`);
  assertInside(root, await realpath(filePath));
}
function isFolderOrSame(base: string, current: string): boolean {
  const rel = relative(base, current);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep));
}
async function listFolder(
  root: string,
  folder: string,
): Promise<Array<{ filePath: string; filename: string; content: VariablesFile; raw: string }>> {
  assertInside(root, folder);
  const entries = await readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!isVariablesFileName(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new VariableFileError('UNSAFE_PATH', `Symlink ou arquivo inválido: ${entry.name}`);
    const p = join(folder, entry.name);
    await assertFileInside(root, p);
    const raw = await readFile(p, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new VariableFileError('INVALID_FILE', `JSON inválido: ${p}`);
    }
    const v = validateVariablesFile(json);
    if (!v.valid)
      throw new VariableFileError(
        'INVALID_FILE',
        `${p}: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
      );
    files.push({ filePath: p, filename: entry.name, content: v.value, raw });
  }
  return files;
}
/** Reads only the request's containing directory and ancestors up to authorizedRoot. */
export async function loadVariableSnapshot(
  requestFile: string,
  authorizedRoot: string,
): Promise<VariableSnapshot> {
  const root = await safeRoot(authorizedRoot);
  await assertFileInside(root, requestFile);
  let folder = dirname(await realpath(requestFile));
  if (!isFolderOrSame(root, folder))
    throw new VariableFileError('OUTSIDE_ROOT', 'Request não está dentro da raiz autorizada');
  const loaded = [];
  while (true) {
    const files = await listFolder(root, folder);
    loaded.push({ folderPath: folder, files });
    if (folder === root) break;
    const parent = dirname(folder);
    if (parent === folder) throw new VariableFileError('OUTSIDE_ROOT', 'Raiz física não encontrada');
    folder = parent;
  }
  return createVariableSnapshot(loaded);
}

/** Atomic *per file* replacement. Multi-file updates use best-effort rollback; not fully transactional across crashes. */
async function saveJsonAtomically(path: string, obj: VariablesFile): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
const inFlight = new Set<string>();
/** Activating a file disables all same-directory siblings; manual multi-active state is valid for reads. */
export async function setVariableFileEnabled(
  filePath: string,
  enabled: boolean,
  authorizedRoot: string,
): Promise<{ changedFiles: string[] }> {
  if (!isVariablesFileName(basename(filePath)))
    throw new VariableFileError('INVALID_FILE', 'O arquivo deve ser variables.json ou *.variables.json');
  const root = await safeRoot(authorizedRoot);
  assertInside(root, resolve(filePath));
  await assertFileInside(root, filePath);
  const folder = dirname(await realpath(filePath));
  if (inFlight.has(folder))
    throw new VariableFileError('CONCURRENT_WRITE', 'Outra ativação já está em andamento');
  inFlight.add(folder);
  try {
    const files = await listFolder(root, folder);
    const plan = planVariableFileActivation(files, resolve(filePath), enabled);
    const changed = plan.filter((x) => x.changed);
    // Verify current bytes before first write: do not overwrite edits that occurred after listFolder.
    for (const file of files) {
      const current = await readFile(file.filePath, 'utf8');
      if (current !== file.raw)
        throw new VariableFileError(
          'CONCURRENT_WRITE',
          `Arquivo alterado durante ativação: ${file.filename}`,
        );
    }
    const committed: string[] = [];
    try {
      for (const item of changed) {
        await saveJsonAtomically(item.filePath, item.content);
        committed.push(item.filePath);
      }
    } catch (e) {
      const failures = [];
      for (const path of committed.reverse()) {
        try {
          const original = files.find((f) => f.filePath === path)!;
          await saveRawAtomically(path, original.raw);
        } catch (error) {
          failures.push({ path, error: String(error) });
        }
      }
      throw new VariableFileError(
        'ACTIVATION_FAILED',
        `Falha ao ativar variáveis; rollback: ${JSON.stringify(failures)}; causa ${String(e)}`,
      );
    }
    return { changedFiles: committed };
  } finally {
    inFlight.delete(folder);
  }
}
async function saveRawAtomically(path: string, raw: string) {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, raw, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
