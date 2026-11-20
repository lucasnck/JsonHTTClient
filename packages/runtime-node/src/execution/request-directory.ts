import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateRequestFile } from '../../../core/src/contracts/validation.js';
import type { ExecutionBatchResult, ExecutionResult } from '../../../core/src/contracts/types.js';
import { loadVariableSnapshot } from '../variable-files.js';
import { executeRequestFile } from '../../../sdk-js/src/execution.js';
import { executeLoop } from '../../../sdk-js/src/loop-execution.js';
import type { ExecuteRequestOptions } from '../../../sdk-js/src/execution.js';
export interface DirectoryRunOptions extends Omit<ExecuteRequestOptions, 'snapshot'> {
  readonly authorizedRoot: string;
  readonly recursive?: boolean;
  readonly maxFiles?: number;
  readonly onFile?: (event: { ordinal: number; total: number; file: string }) => void;
  /** CLI-only opt-in; NEVER enabled for MCP or other remote agent interfaces. */
  readonly revealSensitiveHeaders?: boolean;
}
export interface DirectoryRunEntry {
  readonly file: string;
  readonly result?: ExecutionResult | ExecutionBatchResult;
  /** A short diagnostic code; never raw exception messages or credentials. */
  readonly error?: string;
}
export interface DirectoryRunResult {
  readonly summary: {
    status: 'succeeded' | 'partial_failed' | 'failed' | 'cancelled';
    total: number;
    executed: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    skipped: number;
  };
  readonly runs: DirectoryRunEntry[];
}
export class DirectoryRunError extends Error {
  constructor(
    public readonly code: 'OUTSIDE_ROOT' | 'UNSAFE_PATH' | 'LIMIT_EXCEEDED' | 'INVALID_DIRECTORY',
    message: string,
  ) {
    super(message);
    this.name = 'DirectoryRunError';
  }
}
function inside(root: string, location: string): void {
  const rel = relative(root, location);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new DirectoryRunError('OUTSIDE_ROOT', 'Outside authorized root');
}
async function checkDirectory(root: string, path: string): Promise<string> {
  inside(root, path);
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink())
    throw new DirectoryRunError('UNSAFE_PATH', 'Not a real directory');
  const physical = await realpath(path);
  inside(root, physical);
  return physical;
}
export async function discoverRequestFiles(
  directory: string,
  authorizedRoot: string,
  recursive = false,
  maxFiles = 500,
): Promise<string[]> {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 2000)
    throw new DirectoryRunError('LIMIT_EXCEEDED', 'Invalid maxFiles');
  const root = await realpath(resolve(authorizedRoot));
  const start = await checkDirectory(root, resolve(directory));
  const found: string[] = [];
  async function visit(folder: string, depth: number): Promise<void> {
    if (depth > 20) throw new DirectoryRunError('LIMIT_EXCEEDED', 'Max folder depth');
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // no filesystem traversal via links
      const path = join(folder, entry.name);
      if (entry.isDirectory() && recursive) {
        const real = await checkDirectory(root, path);
        await visit(real, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.request.json')) {
        const physical = await realpath(path);
        inside(root, physical);
        found.push(physical);
        if (found.length > maxFiles) throw new DirectoryRunError('LIMIT_EXCEEDED', 'Too many request files');
      }
    }
  }
  await visit(start, 0);
  return found.sort((a, b) => relative(root, a).localeCompare(relative(root, b), 'en'));
}
/** Run physical request files sequentially, using the same SDK and variables as single run. */
export async function executeRequestDirectory(
  directory: string,
  options: DirectoryRunOptions,
): Promise<DirectoryRunResult> {
  const root = await realpath(resolve(options.authorizedRoot));
  const files = await discoverRequestFiles(
    directory,
    root,
    options.recursive ?? false,
    options.maxFiles ?? 500,
  );
  const runs: DirectoryRunEntry[] = [];
  let succeeded = 0,
    failed = 0,
    cancelled = 0;
  for (const [index, path] of files.entries()) {
    if (options.signal?.aborted) break;
    const file = relative(root, path);
    try {
      options.onFile?.({ ordinal: index + 1, total: files.length, file });
    } catch {
      /* progress must not affect execution */
    }
    if (options.signal?.aborted) break;
    try {
      const parsed = validateRequestFile(JSON.parse(await readFile(path, 'utf8')) as unknown, basename(path));
      if (!parsed.valid) {
        failed++;
        runs.push({ file, error: 'INVALID_REQUEST' });
        continue;
      }
      const snapshot = await loadVariableSnapshot(path, root);
      const request = parsed.value;
      const common = { ...options, snapshot };
      if (request.loop) {
        const execution = await executeLoop(request, { ...common, requestPath: path, authorizedRoot: root });
        try {
          const result = options.revealSensitiveHeaders
            ? {
                ...execution.result,
                results: execution.sessions.map((s) => s.viewOriginalHeaders()),
              }
            : execution.result;
          runs.push({ file, result });
          if (result.summary.status === 'cancelled') cancelled++;
          else if (result.summary.status === 'succeeded') succeeded++;
          else failed++;
        } finally {
          execution.dispose();
        }
      } else {
        const session = await executeRequestFile(request, common);
        try {
          const result = options.revealSensitiveHeaders ? session.viewOriginalHeaders() : session.result;
          runs.push({ file, result });
          const status = session.result.response?.status;
          if (options.signal?.aborted || session.diagnostic?.code === 'ABORTED') cancelled++;
          else if (session.diagnostic || !session.result.response || status === undefined || status >= 400)
            failed++;
          else succeeded++;
        } finally {
          session.dispose();
        }
      }
    } catch (e) {
      // Do not leak request URLs, credentials or messages in diagnostics.
      failed++;
      runs.push({
        file,
        error:
          e instanceof SyntaxError
            ? 'INVALID_JSON'
            : e instanceof DirectoryRunError
              ? e.code
              : 'REQUEST_FAILED',
      });
    }
  }
  const executed = runs.length;
  const isCancelled = options.signal?.aborted === true || cancelled > 0;
  return {
    summary: {
      status: isCancelled
        ? 'cancelled'
        : failed === 0
          ? 'succeeded'
          : succeeded > 0
            ? 'partial_failed'
            : 'failed',
      total: files.length,
      executed,
      succeeded,
      failed,
      cancelled,
      skipped: files.length - executed,
    },
    runs,
  };
}
