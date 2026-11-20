#!/usr/bin/env node
/** Desktop sidecar: JSON-lines over stdin/stdout. Never opens a network port. */
import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDesktopProtocol, maxDesktopProtocolBytes } from './sidecar-protocol.js';

function argumentsForSidecar(argv: string[]) {
  const fields = new Map<string, string>();
  const allowed = new Set(['--root', '--app-data']);
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (allowed.has(token)) {
      const next = argv[++i];
      if (!next) throw new Error('INVALID_STARTUP');
      fields.set(token, next);
    } else if (
      token === '--allow-http' ||
      token === '--allow-private-network' ||
      token === '--allow-import-apply' ||
      token === '--native-approval' ||
      token === '--native-import-approval'
    ) {
      flags.add(token);
    } else throw new Error('INVALID_STARTUP');
  }
  if (!fields.get('--root') || !fields.get('--app-data')) throw new Error('INVALID_STARTUP');
  return { root: fields.get('--root')!, appData: fields.get('--app-data')!, flags };
}
export async function startDesktopSidecar(argv: string[]): Promise<void> {
  const args = argumentsForSidecar(argv);
  const root = await realpath(resolve(args.root));
  const protocol = await createDesktopProtocol({
    root,
    appData: args.appData,
    policy: {
      allowHttp: args.flags.has('--allow-http'),
      allowPrivateNetworks: args.flags.has('--allow-private-network'),
    },
    importWriteEnabled: args.flags.has('--allow-import-apply'),
    nativeApprovalEnabled: args.flags.has('--native-approval'),
    nativeImportEnabled: args.flags.has('--native-import-approval'),
    emit: (packet) => process.stdout.write(JSON.stringify(packet) + '\n'),
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > maxDesktopProtocolBytes()) {
      process.stdout.write(
        JSON.stringify({ id: 'invalid', ok: false, error: { code: 'MESSAGE_TOO_LARGE' } }) + '\n',
      );
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      process.stdout.write(
        JSON.stringify({ id: 'invalid', ok: false, error: { code: 'INVALID_JSON' } }) + '\n',
      );
      continue;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.op === '__nativeApprovalResponse') {
      // This reserved operation is accepted solely on the process's private
      // stdin. The Tauri desktop_send webview allowlist rejects it.
      protocol.resolveNativeApproval(record.challenge, record.approved);
      continue;
    }
    if (typeof record.id !== 'string' || typeof record.op !== 'string') continue;
    const job = protocol.dispatch({
      id: record.id,
      op: record.op,
      ...(record.args !== undefined ? { args: record.args } : {}),
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.allSettled([...pending]);
}
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  startDesktopSidecar(process.argv.slice(2)).catch(() => {
    process.stderr.write('desktop-sidecar: STARTUP_FAILED\n');
    process.exitCode = 1;
  });
}
