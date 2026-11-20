import { lstat, realpath, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertOAuthVariableName, createOAuthDefinition } from '../../../core/src/oauth/discovery.js';
import type { OAuthDefinition } from '../../../core/src/oauth/discovery.js';
import { isVariablesFileName, validateVariablesFile } from '../../../core/src/variables/variables.js';
import type { VariablesFile, JsonValue } from '../../../core/src/variables/variables.js';

export class OAuthSaveError extends Error {
  constructor(
    public readonly code:
      'INVALID_TARGET' | 'UNSAFE_PATH' | 'ALREADY_EXISTS' | 'CONCURRENT_WRITE' | 'INVALID_FILE',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthSaveError';
  }
}
const inProgress = new Set<string>();
function assertInside(root: string, p: string) {
  const rel = relative(root, p);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new OAuthSaveError('UNSAFE_PATH', 'OAuth target fora da raiz autorizada');
}
async function readVariables(p: string): Promise<{ data: VariablesFile; raw: string }> {
  const raw = await readFile(p, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new OAuthSaveError('INVALID_FILE', 'Arquivo de variáveis contém JSON inválido');
  }
  const parsed = validateVariablesFile(value);
  if (!parsed.valid) throw new OAuthSaveError('INVALID_FILE', 'Variáveis inválidas');
  return { data: parsed.value, raw };
}
export interface OAuthSaveOptions {
  targetFile: string;
  authorizedRoot: string;
  variableName: string;
  overwrite?: boolean;
}
/** Explicit write. Does not authenticate, activate sibling files, or persist credentials. */
export async function saveOAuthVariable(
  definition: OAuthDefinition,
  options: OAuthSaveOptions,
): Promise<{ filePath: string; created: boolean; enabled: boolean; variableName: string }> {
  assertOAuthVariableName(options.variableName);
  // Validate the OAuth object against the same contract used by the rest of the motor.
  const normalized = createOAuthDefinition(
    { issuer: definition.issuer },
    {
      clientId: definition.clientId,
      ...(definition.scopes === undefined ? {} : { scopes: definition.scopes }),
      ...(definition.redirect === undefined ? {} : { redirect: definition.redirect }),
    },
  );
  const target = resolve(options.targetFile);
  if (!isVariablesFileName(basename(target)))
    throw new OAuthSaveError('INVALID_TARGET', 'Destino deve ser variables.json ou *.variables.json');
  const root = await realpath(resolve(options.authorizedRoot));
  const realFolder = await realpath(dirname(target));
  assertInside(root, realFolder);
  if (target !== join(realFolder, basename(target)))
    throw new OAuthSaveError('UNSAFE_PATH', 'Diretório alvo contém links simbólicos');
  if (inProgress.has(target)) throw new OAuthSaveError('CONCURRENT_WRITE', 'Gravação OAuth já em andamento');
  inProgress.add(target);
  let temp = '';
  try {
    let original: string | undefined,
      base: VariablesFile = {},
      created = true;
    try {
      const st = await lstat(target);
      if (!st.isFile() || st.isSymbolicLink())
        throw new OAuthSaveError('UNSAFE_PATH', 'Destino é link ou não é arquivo');
      assertInside(root, await realpath(target));
      const current = await readVariables(target);
      original = current.raw;
      base = current.data;
      created = false;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (Object.hasOwn(base, options.variableName) && !options.overwrite)
      throw new OAuthSaveError('ALREADY_EXISTS', 'Variável já existe; confirmação de overwrite exigida');
    if (created) {
      let siblingActive = false;
      const entries = await readdir(realFolder, { withFileTypes: true });
      for (const entry of entries) {
        if (!isVariablesFileName(entry.name) || entry.name === basename(target)) continue;
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new OAuthSaveError('UNSAFE_PATH', 'Arquivo de variáveis irmão inválido');
        const sibling = await readVariables(join(realFolder, entry.name));
        if (sibling.data.enabled !== false) siblingActive = true;
      }
      base = { enabled: !siblingActive, protected: false };
    }
    const next: VariablesFile = { ...base, [options.variableName]: normalized as unknown as JsonValue };
    if (!validateVariablesFile(next).valid)
      throw new OAuthSaveError('INVALID_FILE', 'Arquivo resultante inválido');
    // Check before writing; prevents overwriting concurrent edits noticed in this process.
    if (!created && original !== (await readFile(target, 'utf8')))
      throw new OAuthSaveError('CONCURRENT_WRITE', 'Arquivo foi editado durante o salvamento');
    temp = join(realFolder, `.${basename(target)}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Recheck, then replace atomically within the same directory (not a cross-process transaction).
    if (!created && original !== (await readFile(target, 'utf8')))
      throw new OAuthSaveError('CONCURRENT_WRITE', 'Arquivo mudou durante salvamento');
    if (created) {
      try {
        await lstat(target);
        throw new OAuthSaveError('CONCURRENT_WRITE', 'Arquivo criado em paralelo');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    await rename(temp, target);
    temp = '';
    return { filePath: target, created, enabled: next.enabled !== false, variableName: options.variableName };
  } finally {
    if (temp) await unlink(temp).catch(() => undefined);
    inProgress.delete(target);
  }
}
