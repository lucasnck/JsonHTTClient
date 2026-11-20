import type { RequestFile } from '../../core/src/contracts/types.js';
import { validateRequestFile } from '../../core/src/contracts/validation.js';
import { prepareRequestWithOAuth } from './oauth-request.js';
import type { OAuthTokenProvider } from './oauth-request.js';
import { approveProtectedExecution, checkHttpTarget } from '../../core/src/security/policies.js';
import type { ApprovalAdapter } from '../../core/src/security/policies.js';
import type { VariableSnapshot } from '../../core/src/variables/variables.js';
import { fetchHttpRequest } from '../../runtime-node/src/http/fetch-transport.js';
import type { FetchOptions, ExecutionSession } from '../../runtime-node/src/http/fetch-transport.js';
import type { TemplateOptions } from '../../core/src/templates/interpolation.js';

export interface ExecuteRequestOptions extends FetchOptions {
  readonly snapshot: VariableSnapshot;
  readonly approval?: ApprovalAdapter;
  readonly template?: TemplateOptions;
  readonly oauthTokenProvider?: OAuthTokenProvider;
}
/** Run-time boundary: parse/validate -> interpolate -> target policy -> protected approval -> network. */
export async function executeRequestFile(
  file: RequestFile,
  options: ExecuteRequestOptions,
): Promise<ExecutionSession> {
  const validation = validateRequestFile(file, 'run.request.json');
  if (!validation.valid)
    throw new Error(`RequestFile inválido: ${validation.issues.map((x) => x.path).join(', ')}`);
  if (file.loop) throw new Error('Loop deve ser executado pelo executor T05 (PENDING)');
  const prepared = prepareRequestWithOAuth(
    file.request,
    options.snapshot,
    options.template,
    options.oauthTokenProvider,
    options.signal,
  );
  const destination = checkHttpTarget(prepared.preflight.url, options.policy);
  await approveProtectedExecution(
    prepared.resolution.usedProtectedFiles,
    { method: prepared.preflight.method, url: destination.toString() },
    options.approval,
  );
  const request = await prepared.materialize();
  checkHttpTarget(request.url, options.policy);
  return fetchHttpRequest(request, {
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(file.options?.timeoutMs === undefined ? {} : { timeoutMs: file.options.timeoutMs }),
    ...(file.options?.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: file.options.maxResponseBytes }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
  });
}
