import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, relative, resolve, sep, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { validateRequestFile } from '../../../packages/core/src/contracts/validation.js';
import type { RequestFile } from '../../../packages/core/src/contracts/types.js';
import {
  validateVariablesFile,
  isVariablesFileName,
} from '../../../packages/core/src/variables/variables.js';
import { hoverVariable } from '../../../packages/language-service/src/language-service.js';
import {
  loadVariableSnapshot,
  setVariableFileEnabled,
} from '../../../packages/runtime-node/src/variable-files.js';
import { executeRequestFile } from '../../../packages/sdk-js/src/execution.js';
import { executeLoop } from '../../../packages/sdk-js/src/loop-execution.js';
import { executeRequestDirectory } from '../../../packages/runtime-node/src/execution/request-directory.js';
import { applyImportPlan } from '../../../packages/runtime-node/src/importers/apply.js';
import { discoverOAuthIssuer } from '../../../packages/runtime-node/src/oauth/discovery.js';
import { saveOAuthVariable } from '../../../packages/runtime-node/src/oauth/variable-writer.js';
import { createOAuthDefinition } from '../../../packages/core/src/oauth/discovery.js';
import { importCurl } from '../../../packages/importers/src/curl.js';
import { importOpenApi } from '../../../packages/importers/src/openapi.js';
import type { HttpNetworkPolicy } from '../../../packages/core/src/security/policies.js';

export interface McpServerOptions {
  readonly root: string;
  readonly allowRun?: boolean;
  readonly allowImportApply?: boolean;
  readonly allowWrite?: boolean;
  readonly allowProtected?: boolean;
  readonly allowOAuthDiscovery?: boolean;
  readonly policy?: HttpNetworkPolicy;
}
type JsonRpcId = number | string | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}
const schema = (required: Record<string, unknown>, optional: Record<string, unknown> = {}) => ({
  type: 'object' as const,
  properties: { ...required, ...optional },
  required: Object.keys(required),
  additionalProperties: false,
});
const STRING = { type: 'string' };
const tools: readonly McpTool[] = [
  {
    name: 'request_list',
    description: 'List request filenames in a directory within configured root; does not execute requests.',
    inputSchema: schema({}, { directory: STRING }),
  },
  {
    name: 'request_validate',
    description: 'Validate an existing *.request.json file; no execution.',
    inputSchema: schema({ file: STRING }),
  },
  {
    name: 'variables_list',
    description: 'List variable file names, enabled/protected states and variable names only; no values.',
    inputSchema: schema({}, { directory: STRING }),
  },
  {
    name: 'variables_explain',
    description: 'Explain which variables file defines a name; returns provenance without raw values.',
    inputSchema: schema({ requestFile: STRING, name: STRING }),
  },
  {
    name: 'request_run',
    description:
      'Execute one request (or its foreach loop) only when the MCP host started this server with --allow-run. No sensitive headers in MCP result.',
    inputSchema: schema({ file: STRING }),
  },
  {
    name: 'request_run_dir',
    description:
      'Execute requests from a directory in lexical order, with --allow-run host permission; optional recursive traversal.',
    inputSchema: schema({ directory: STRING }, { recursive: { type: 'boolean' } }),
  },
  {
    name: 'execution_stop',
    description: 'Abort the one active HTTP run of this host process, if any.',
    inputSchema: schema({}),
  },
  {
    name: 'variables_activate_file',
    description: 'Activate one variable file, disabling siblings. Requires host --allow-write.',
    inputSchema: schema({ file: STRING }),
  },
  {
    name: 'variables_deactivate_file',
    description: 'Deactivate a variables file. Requires host --allow-write.',
    inputSchema: schema({ file: STRING }),
  },
  {
    name: 'import_preview',
    description: 'Parse cURL/Bash/OpenAPI JSON text without executing scripts or changing files.',
    inputSchema: schema({ format: { type: 'string', enum: ['curl', 'bash', 'openapi'] }, source: STRING }),
  },
  {
    name: 'import_apply',
    description:
      'Write imported requests in a host-authorized directory without executing them. Requires host --allow-write and --allow-import-apply.',
    inputSchema: schema({
      format: { type: 'string', enum: ['curl', 'bash', 'openapi'] },
      source: STRING,
      outputDir: STRING,
    }),
  },
  {
    name: 'oauth_discover',
    description: 'Read OAuth issuer metadata, if explicitly permitted by host startup.',
    inputSchema: schema({ issuer: STRING }),
  },
  {
    name: 'oauth_save_variable',
    description:
      'Write OAuth configuration to explicitly chosen variables file. No login/tokens. Requires --allow-write.',
    inputSchema: schema(
      { issuer: STRING, file: STRING, name: STRING, clientId: STRING },
      { scopes: { type: 'array', items: STRING }, overwrite: { type: 'boolean' } },
    ),
  },
];
class ToolError extends Error {
  constructor(
    public readonly code:
      'INVALID_ARGUMENTS' | 'PERMISSION_DENIED' | 'OUTSIDE_ROOT' | 'NOT_FOUND' | 'BUSY' | 'UNSUPPORTED_TOOL',
  ) {
    super('A ferramenta MCP não pôde concluir a operação');
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (obj: Record<string, unknown>, key: string): string => {
  const v = obj[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolError('INVALID_ARGUMENTS');
  return v;
};
const optional = (obj: Record<string, unknown>, key: string, defaultValue: string): string => {
  const v = obj[key];
  return v === undefined ? defaultValue : field(obj, key);
};
function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new ToolError('OUTSIDE_ROOT');
}
async function fileInRoot(root: string, input: string, kind: 'file' | 'directory' = 'file'): Promise<string> {
  const lexical = resolve(root, input);
  assertInside(root, lexical);
  const stat = await lstat(lexical);
  if (
    stat.isSymbolicLink() ||
    (kind === 'file' && !stat.isFile()) ||
    (kind === 'directory' && !stat.isDirectory())
  )
    throw new ToolError('INVALID_ARGUMENTS');
  const physical = await realpath(lexical);
  assertInside(root, physical);
  return physical;
}

export class HttpEngineMcpServer {
  private active: AbortController | undefined;
  constructor(private readonly options: McpServerOptions) {}
  get advertisedTools(): readonly McpTool[] {
    return tools;
  }
  /** Host configuration defines permissions. MCP tool inputs cannot grant themselves network or filesystem access. */
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const root = this.options.root;
    if (name === 'request_list' || name === 'variables_list') {
      const folder = await fileInRoot(root, optional(args, 'directory', '.'), 'directory');
      const entries = (await readdir(folder, { withFileTypes: true }))
        .filter((x) => x.isFile() && !x.isSymbolicLink())
        .slice(0, 2000);
      if (name === 'request_list')
        return {
          requests: entries
            .filter((e) => e.name.endsWith('.request.json'))
            .map((e) => e.name)
            .sort(),
        };
      const files = [];
      for (const entry of entries.filter((e) => isVariablesFileName(e.name))) {
        const raw = JSON.parse(await readFile(resolve(folder, entry.name), 'utf8')) as unknown;
        const parsed = validateVariablesFile(raw);
        if (!parsed.valid) throw new ToolError('INVALID_ARGUMENTS');
        files.push({
          file: entry.name,
          enabled: parsed.value.enabled !== false,
          protected: parsed.value.protected === true,
          keys: Object.keys(parsed.value).filter((k) => k !== 'enabled' && k !== 'protected'),
        });
      }
      return { variableFiles: files.sort((a, b) => a.file.localeCompare(b.file)) };
    }
    if (name === 'request_validate') {
      const path = await fileInRoot(root, field(args, 'file'));
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const parsed = validateRequestFile(value, basename(path));
      return { valid: parsed.valid, issues: parsed.valid ? [] : parsed.issues };
    }
    if (name === 'variables_explain') {
      const path = await fileInRoot(root, field(args, 'requestFile'));
      const found = hoverVariable(field(args, 'name'), await loadVariableSnapshot(path, root));
      if (!found) throw new ToolError('NOT_FOUND');
      // Do not expose ordinary variable values via MCP: filenames/types still allow provenance.
      return {
        name: found.name,
        type: found.type,
        origin: relative(root, found.origin),
        protected: found.protected,
      };
    }
    if (name === 'request_run_dir') {
      if (!this.options.allowRun) throw new ToolError('PERMISSION_DENIED');
      if (this.active) throw new ToolError('BUSY');
      const directory = await fileInRoot(root, field(args, 'directory'), 'directory');
      if (args.recursive !== undefined && typeof args.recursive !== 'boolean')
        throw new ToolError('INVALID_ARGUMENTS');
      const controller = new AbortController();
      this.active = controller;
      try {
        return await executeRequestDirectory(directory, {
          authorizedRoot: root,
          recursive: args.recursive === true,
          signal: controller.signal,
          policy: this.options.policy ?? {},
          approval: async () => this.options.allowProtected === true,
        });
      } finally {
        this.active = undefined;
      }
    }
    if (name === 'request_run') {
      if (!this.options.allowRun) throw new ToolError('PERMISSION_DENIED');
      if (this.active) throw new ToolError('BUSY');
      const path = await fileInRoot(root, field(args, 'file'));
      const parsed = validateRequestFile(JSON.parse(await readFile(path, 'utf8')) as unknown, basename(path));
      if (!parsed.valid) throw new ToolError('INVALID_ARGUMENTS');
      const controller = new AbortController();
      this.active = controller;
      try {
        const snapshot = await loadVariableSnapshot(path, root);
        const common = {
          snapshot,
          policy: this.options.policy ?? {},
          signal: controller.signal,
          approval: async () => this.options.allowProtected === true,
          requestPath: path,
          authorizedRoot: root,
        };
        if ((parsed.value as RequestFile).loop) {
          const batch = await executeLoop(parsed.value as RequestFile, common);
          try {
            return batch.result;
          } finally {
            batch.dispose();
          }
        }
        const session = await executeRequestFile(parsed.value as RequestFile, common);
        try {
          return session.result;
        } finally {
          session.dispose();
        }
      } finally {
        this.active = undefined;
      }
    }
    if (name === 'execution_stop') {
      if (!this.options.allowRun) throw new ToolError('PERMISSION_DENIED');
      const wasRunning = !!this.active;
      this.active?.abort();
      return { stopped: wasRunning };
    }
    if (name === 'variables_activate_file' || name === 'variables_deactivate_file') {
      if (!this.options.allowWrite) throw new ToolError('PERMISSION_DENIED');
      const path = await fileInRoot(root, field(args, 'file'));
      const changed = await setVariableFileEnabled(path, name === 'variables_activate_file', root);
      return { changedFiles: changed.changedFiles.map((f) => relative(root, f)) };
    }
    if (name === 'import_preview') {
      const format = field(args, 'format');
      const source = field(args, 'source');
      if (source.length > 300_000) throw new ToolError('INVALID_ARGUMENTS');
      if (format === 'curl' || format === 'bash') return importCurl(source, format);
      if (format === 'openapi') return importOpenApi(source);
      throw new ToolError('INVALID_ARGUMENTS');
    }
    if (name === 'import_apply') {
      if (!this.options.allowWrite || !this.options.allowImportApply)
        throw new ToolError('PERMISSION_DENIED');
      const format = field(args, 'format'),
        source = field(args, 'source');
      if (source.length > 300_000) throw new ToolError('INVALID_ARGUMENTS');
      const destination = await fileInRoot(root, field(args, 'outputDir'), 'directory');
      const plan =
        format === 'curl' || format === 'bash'
          ? importCurl(source, format)
          : format === 'openapi'
            ? importOpenApi(source)
            : undefined;
      if (!plan) throw new ToolError('INVALID_ARGUMENTS');
      const paths = await applyImportPlan(plan, destination, root);
      return { files: paths.map((p) => relative(root, p)), warnings: plan.warnings };
    }
    if (name === 'oauth_discover') {
      if (!this.options.allowOAuthDiscovery) throw new ToolError('PERMISSION_DENIED');
      return discoverOAuthIssuer(field(args, 'issuer'));
    }
    if (name === 'oauth_save_variable') {
      if (!this.options.allowWrite) throw new ToolError('PERMISSION_DENIED');
      const issuer = field(args, 'issuer');
      const clientId = field(args, 'clientId');
      const scopes = args.scopes;
      if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')))
        throw new ToolError('INVALID_ARGUMENTS');
      const overwrite = args.overwrite;
      if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new ToolError('INVALID_ARGUMENTS');
      const config = createOAuthDefinition(
        { issuer },
        { clientId, ...(scopes === undefined ? {} : { scopes: scopes as string[] }) },
      );
      const path = resolve(root, field(args, 'file'));
      assertInside(root, path);
      const saved = await saveOAuthVariable(config, {
        targetFile: path,
        variableName: field(args, 'name'),
        authorizedRoot: root,
        overwrite: overwrite === true,
      });
      return { configurationSaved: true, created: saved.created, file: relative(root, saved.filePath) };
    }
    throw new ToolError('UNSUPPORTED_TOOL');
  }
  async process(raw: unknown): Promise<Record<string, unknown> | undefined> {
    if (!object(raw))
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const id = raw.id;
    const validId = (typeof id === 'number' && Number.isSafeInteger(id)) || typeof id === 'string';
    const notification = id === undefined;
    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string')
      return { jsonrpc: '2.0', id: validId ? id : null, error: { code: -32600, message: 'Invalid Request' } };
    if (notification) return undefined;
    if (!validId) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    try {
      let result: unknown;
      switch (raw.method) {
        case 'initialize':
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'json-http-engine', version: '0.0.1' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: this.advertisedTools };
          break;
        case 'tools/call': {
          if (
            !object(raw.params) ||
            typeof raw.params.name !== 'string' ||
            !object(raw.params.arguments ?? {})
          )
            throw new ToolError('INVALID_ARGUMENTS');
          try {
            const output = await this.invoke(
              raw.params.name,
              raw.params.arguments as Record<string, unknown>,
            );
            result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
          } catch (e) {
            const code =
              e instanceof ToolError
                ? e.code
                : e instanceof Error &&
                    'code' in e &&
                    typeof e.code === 'string' &&
                    /^[A-Z_]{2,40}$/.test(e.code)
                  ? e.code
                  : 'OPERATION_FAILED';
            result = {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ code, message: 'Operação não concluída' }) }],
            };
          }
          break;
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
      }
      return { jsonrpc: '2.0', id, result };
    } catch {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } };
    }
  }
}
export async function serveMcpStdio(opts: McpServerOptions): Promise<void> {
  const server = new HttpEngineMcpServer(opts);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const pending = new Set<Promise<void>>();
  lines.on('line', (line) => {
    if (pending.size >= 64) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Too many concurrent requests' },
        }) + '\n',
      );
      return;
    }
    if (Buffer.byteLength(line, 'utf8') > 1_048_576) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Message too large' } }) +
          '\n',
      );
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
      );
      return;
    }
    const task = server
      .process(message)
      .then((response) => {
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
      })
      .catch(() => {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }) +
            '\n',
        );
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
  await Promise.allSettled([...pending]); // never lose a response when stdin closes right after a request
}
export async function startMcpFromCli(argv: string[]): Promise<void> {
  let rootArg: string | undefined;
  const settings = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      rootArg = argv[++i];
      if (!rootArg) throw new Error('MCP_ROOT_REQUIRED');
    } else if (
      [
        '--allow-run',
        '--allow-write',
        '--allow-protected',
        '--allow-http',
        '--allow-private-network',
        '--allow-oauth-discovery',
        '--allow-import-apply',
      ].includes(arg ?? '')
    )
      settings.add(arg!);
    else throw new Error('MCP_INVALID_FLAG');
  }
  if (!rootArg) throw new Error('MCP_ROOT_REQUIRED');
  const root = await realpath(resolve(rootArg));
  await serveMcpStdio({
    root,
    allowRun: settings.has('--allow-run'),
    allowWrite: settings.has('--allow-write'),
    allowProtected: settings.has('--allow-protected'),
    allowImportApply: settings.has('--allow-import-apply'),
    allowOAuthDiscovery: settings.has('--allow-oauth-discovery'),
    policy: {
      allowHttp: settings.has('--allow-http'),
      allowPrivateNetworks: settings.has('--allow-private-network'),
    },
  });
}
