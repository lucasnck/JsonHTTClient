/** Native VS Code host-independent Run bridge. No editor or VS Code APIs in the engine. */
import {basename} from 'node:path';
import {loadVariableSnapshot} from './variable-files.js';
import {validateRequestFile} from '../../core/src/contracts/validation.js';
import {executeRequestFile} from '../../sdk-js/src/execution.js';
import {executeLoop} from '../../sdk-js/src/loop-execution.js';
import type {LoopEvent} from '../../sdk-js/src/loop-execution.js';
import type {ApprovalAdapter, HttpNetworkPolicy} from '../../core/src/security/policies.js';
import type {RequestFile, ExecutionResult, ExecutionBatchResult} from '../../core/src/contracts/types.js';
import type {OAuthTokenProvider} from '../../sdk-js/src/oauth-request.js';

export type RunResult = {
  readonly json: string;
  readonly result: ExecutionResult | ExecutionBatchResult;
  readonly warnings: readonly string[];
};
export interface EditorRunOptions {
  readonly requestPath: string;
  readonly authorizedRoot: string;
  /** The current editor buffer, not necessarily saved to disk. */
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly approval?: ApprovalAdapter;
  readonly policy?: HttpNetworkPolicy;
  readonly oauthTokenProvider?: OAuthTokenProvider;
  readonly onProgress?: (event: LoopEvent) => void;
}

/** May throw on invalid JSON/request, unsafe root, policy, protection or network errors. */
export async function runEditorRequest(options: EditorRunOptions): Promise<RunResult> {
  if (!basename(options.requestPath).endsWith('.request.json'))
    throw new Error('Somente *.request.json pode ser executado');
  let json: unknown;
  try {json=JSON.parse(options.text) as unknown;} catch {throw new Error('JSON da request inválido');}
  const validated=validateRequestFile(json,basename(options.requestPath));
  if (!validated.valid) throw new Error(`RequestFile inválido: ${validated.issues.map(x=>x.path).join(', ')}`);
  const request=validated.value as RequestFile;
  // loadVariableSnapshot also enforces the request's canonical path and the authorized root.
  const snapshot=await loadVariableSnapshot(options.requestPath,options.authorizedRoot);
  const common={
    snapshot,
    ...(options.signal ? {signal:options.signal} : {}),
    ...(options.approval ? {approval:options.approval} : {}),
    ...(options.policy ? {policy:options.policy} : {}),
    ...(options.oauthTokenProvider ? {oauthTokenProvider:options.oauthTokenProvider} : {}),
  };
  if (request.loop){
    const execution=await executeLoop(request,{
      ...common,
      requestPath:options.requestPath,authorizedRoot:options.authorizedRoot,
      ...(options.onProgress ? {onProgress:options.onProgress} : {}),
    });
    try {
      return {
        json:JSON.stringify(execution.result,null,2)+'\n',
        result:execution.result,
        warnings:execution.diagnostics.map(x=>`${x.ordinal}: ${x.code}`),
      };
    } finally {execution.dispose();}
  }
  const session=await executeRequestFile(request,common);
  try {
    return {
      json:JSON.stringify(session.result,null,2)+'\n',
      result:session.result,
      warnings:session.diagnostic ? [session.diagnostic.code] : [],
    };
  } finally {session.dispose();}
}
