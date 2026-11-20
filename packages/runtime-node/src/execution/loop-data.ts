import { readFile, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonValue } from '../../../core/src/variables/variables.js';

export class LoopSourceError extends Error {
  constructor(
    public readonly code: 'INVALID_DATASET' | 'OUTSIDE_ROOT' | 'UNSAFE_DATASET' | 'TOO_MANY_ITEMS',
    message: string,
  ) {
    super(message);
    this.name = 'LoopSourceError';
  }
}
const contained = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
export async function readLoopItems(
  requestFile: string,
  authorizedRoot: string,
  sourcePath: string,
  maxItems: number,
): Promise<Array<Record<string, JsonValue>>> {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10_000)
    throw new LoopSourceError('TOO_MANY_ITEMS', 'maxItems deve ser 1..10000');
  if (isAbsolute(sourcePath))
    throw new LoopSourceError('OUTSIDE_ROOT', 'Dataset deve ter caminho relativo à request');
  const root = await realpath(authorizedRoot);
  const request = await realpath(requestFile);
  if (!contained(root, request)) throw new LoopSourceError('OUTSIDE_ROOT', 'Request fora da raiz autorizada');
  const pathname = resolve(dirname(request), sourcePath);
  if (!contained(root, pathname))
    throw new LoopSourceError('OUTSIDE_ROOT', 'Dataset fora da raiz autorizada');
  const stat = await lstat(pathname);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new LoopSourceError('UNSAFE_DATASET', 'Dataset deve ser arquivo regular, sem symlink');
  if (stat.size > 2_097_152) throw new LoopSourceError('INVALID_DATASET', 'Dataset excede 2 MiB');
  const real = await realpath(pathname);
  if (!contained(root, real)) throw new LoopSourceError('OUTSIDE_ROOT', 'Dataset físico fora da raiz');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pathname, 'utf8')) as unknown;
  } catch {
    throw new LoopSourceError('INVALID_DATASET', 'Dataset JSON inválido');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))
  ) {
    throw new LoopSourceError('INVALID_DATASET', 'Dataset deve ser array de objetos JSON');
  }
  if (parsed.length > maxItems)
    throw new LoopSourceError('TOO_MANY_ITEMS', 'Dataset contém mais itens que o limite');
  return parsed as Array<Record<string, JsonValue>>;
}
