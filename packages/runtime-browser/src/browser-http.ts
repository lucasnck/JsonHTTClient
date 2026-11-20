/** T08: browser-safe HTTP adapter. No Node filesystem, privileged DNS or OS credentials. */
import type {
  ExecutionResult,
  HttpRequestDefinition,
  RequestBody,
  RequestFile,
  NameValue,
  ResponseBody,
} from '../../core/src/contracts/types.js';
import { validateRequestFile } from '../../core/src/contracts/validation.js';
import { interpolateRequest } from '../../core/src/templates/interpolation.js';
import type { TemplateOptions } from '../../core/src/templates/interpolation.js';
import type { VariableSnapshot } from '../../core/src/variables/variables.js';
import { approveProtectedExecution, checkHttpTarget } from '../../core/src/security/policies.js';
import type { HttpNetworkPolicy, ApprovalAdapter } from '../../core/src/security/policies.js';
export interface BrowserRuntimeOptions {
  readonly snapshot: VariableSnapshot;
  readonly template?: TemplateOptions;
  readonly policy?: HttpNetworkPolicy;
  readonly approval?: ApprovalAdapter;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}
export const BROWSER_CAPABILITIES = Object.freeze({
  fetch: true,
  filesystem: false,
  localOAuth: false,
  osSecretStore: false,
});
const PRIVATE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
const redact = (headers: readonly NameValue[]): NameValue[] =>
  headers.map((h) => ({
    name: h.name,
    value: PRIVATE_HEADERS.has(h.name.toLowerCase())
      ? h.name.toLowerCase() === 'authorization' && /^Bearer /i.test(h.value)
        ? 'Bearer [REDACTED]'
        : '[REDACTED]'
      : h.value,
  }));
export class BrowserTransportError extends Error {
  constructor(
    public readonly code: 'UNSUPPORTED_BODY' | 'RESPONSE_TOO_LARGE' | 'INVALID_LIMITS',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserTransportError';
  }
}
export interface BrowserExecution {
  readonly result: ExecutionResult;
  readonly diagnostic?: { code: 'NETWORK_OR_CORS_BLOCKED' | 'ABORTED' | 'TIMEOUT' };
}
function bodyOf(request: HttpRequestDefinition, headers: Headers): BodyInit | undefined {
  const body: RequestBody | undefined = request.body;
  if (!body || body.type === 'none') return undefined;
  if (body.type === 'text') return body.value;
  if (body.type === 'json') {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return JSON.stringify(body.value);
  }
  if (body.type === 'urlencoded') {
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    const values = new URLSearchParams();
    for (const p of body.value) values.append(p.name, p.value);
    return values;
  }
  if (body.type === 'multipart') {
    const form = new FormData();
    for (const part of body.parts) {
      if (part.file !== undefined)
        throw new BrowserTransportError('UNSUPPORTED_BODY', 'Browser file upload requires host adapter');
      form.append(part.name, part.value ?? '');
    }
    if (headers.has('content-type'))
      throw new BrowserTransportError('UNSUPPORTED_BODY', 'Multipart boundary must be generated');
    return form;
  }
  throw new BrowserTransportError(
    'UNSUPPORTED_BODY',
    'Binary and stream paths require a permitted host adapter',
  );
}
async function readResponse(res: Response, maxBytes: number): Promise<ResponseBody> {
  if (!res.body || res.status === 204 || res.status === 304) return { type: 'none' };
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const v = await reader.read();
      if (v.done) break;
      bytes += v.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BrowserTransportError('RESPONSE_TOO_LARGE', 'Response limit exceeded');
      }
      pieces.push(v.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) return { type: 'none' };
  const raw = new Uint8Array(bytes);
  let index = 0;
  for (const p of pieces) {
    raw.set(p, index);
    index += p.byteLength;
  }
  const mime = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (mime && !mime.includes('json') && !mime.startsWith('text/') && !mime.includes('xml'))
    throw new BrowserTransportError(
      'UNSUPPORTED_BODY',
      'Binary responses require authorized artifact storage',
    );
  const content = new TextDecoder().decode(raw);
  if (mime.includes('json')) {
    try {
      return { type: 'json', value: JSON.parse(content) as unknown };
    } catch {
      return { type: 'text', value: content };
    }
  }
  return { type: 'text', value: content };
}
/** Browser preflight, host protected approval, fetch without any CORS bypass or local I/O. */
export async function executeBrowserRequest(
  file: RequestFile,
  options: BrowserRuntimeOptions,
): Promise<BrowserExecution> {
  const validated = validateRequestFile(file, 'browser.request.json');
  if (!validated.valid || file.loop)
    throw new BrowserTransportError(
      'UNSUPPORTED_BODY',
      'Only single RequestFile is currently supported in browser runtime',
    );
  const start = performance.now();
  const { request, resolution } = interpolateRequest(file.request, options.snapshot, options.template);
  const target = checkHttpTarget(request.url, options.policy);
  await approveProtectedExecution(
    resolution.usedProtectedFiles,
    { method: request.method, url: target.toString() },
    options.approval,
  );
  for (const pair of request.query ?? []) target.searchParams.append(pair.name, pair.value);
  const headers = new Headers();
  for (const h of request.headers ?? []) headers.append(h.name, h.value);
  if (request.auth?.type === 'bearer') headers.set('authorization', `Bearer ${request.auth.token}`);
  if (request.auth?.type === 'basic')
    throw new BrowserTransportError(
      'UNSUPPORTED_BODY',
      'Basic auth is not supported by the default browser adapter',
    );
  const body = bodyOf(request, headers);
  if ((request.method === 'GET' || request.method === 'HEAD') && body !== undefined)
    throw new BrowserTransportError('UNSUPPORTED_BODY', 'GET/HEAD body unsupported');
  const size = options.maxResponseBytes ?? 2_097_152,
    timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(timeout) || timeout < 1)
    throw new BrowserTransportError('INVALID_LIMITS', 'Invalid browser limits');
  const projection = {
    method: request.method,
    url: target.toString(),
    headers: redact([...headers.entries()].map(([name, value]) => ({ name, value }))),
    ...(request.body ? { body: request.body } : {}),
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('TIMEOUT'), timeout);
  const abort = () => ctl.abort('ABORTED');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    let response: Response;
    try {
      // Redirects are rejected: browser would otherwise follow redirects without validating the destination.
      response = await (options.fetch ?? fetch)(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: ctl.signal,
      });
    } catch {
      return {
        result: { request: projection, response: null, timings: { totalMs: performance.now() - start } },
        diagnostic: {
          code: ctl.signal.aborted
            ? ctl.signal.reason === 'TIMEOUT'
              ? 'TIMEOUT'
              : 'ABORTED'
            : 'NETWORK_OR_CORS_BLOCKED',
        },
      };
    }
    const bodyResponse = await readResponse(response, size);
    return {
      result: {
        request: projection,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: redact([...response.headers.entries()].map(([name, value]) => ({ name, value }))),
          body: bodyResponse,
        },
        timings: { totalMs: performance.now() - start },
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
