import type {ExecutionBatchResult, ExecutionResult, HttpRequestDefinition, LoopDefinition, RequestFile} from '../../core/src/contracts/types.js';
import {validateRequestFile} from '../../core/src/contracts/validation.js';
import {interpolateRequest} from '../../core/src/templates/interpolation.js';
import {approveProtectedExecution,checkHttpTarget} from '../../core/src/security/policies.js';
import {fetchHttpRequest, ExecutionSession, HttpExecutionError} from '../../runtime-node/src/http/fetch-transport.js';
import {readLoopItems} from '../../runtime-node/src/execution/loop-data.js';
import type {JsonValue} from '../../core/src/variables/variables.js';
import type {ExecuteRequestOptions} from './execution.js';

export type LoopEvent =
  | {type:'batch_started';total:number}
  | {type:'iteration_started';ordinal:number;total:number}
  | {type:'iteration_completed';ordinal:number;total:number;status:'succeeded'|'failed'|'cancelled';statusCode?:number}
  | {type:'cancelling'|'cancelled'|'batch_completed';total:number};
export interface LoopOptions extends ExecuteRequestOptions {
  /** When source.kind=file this root and the actual request filename are required. */
  readonly requestPath?: string;
  readonly authorizedRoot?: string;
  readonly onProgress?: (event:LoopEvent) => void;
}
export interface LoopExecution {
  readonly result: ExecutionBatchResult;
  readonly diagnostics: ReadonlyArray<{ordinal:number;code:string;message:string}>;
  readonly sessions: readonly ExecutionSession[];
  dispose():void;
}
const readDataset=async(loop:LoopDefinition,options:LoopOptions):Promise<Array<Record<string,JsonValue>>>=>{
  const maxItems=loop.maxItems??1_000;
  if(!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>10_000)throw new Error('maxItems deve ser 1..10000');
  if(loop.source.kind==='inline'){
    if(loop.source.items.length>maxItems)throw new Error('Loop excede maxItems');
    return loop.source.items as Array<Record<string,JsonValue>>;
  }
  if(!options.requestPath || !options.authorizedRoot)throw new Error('Dataset externo requer requestPath e authorizedRoot');
  return readLoopItems(options.requestPath,options.authorizedRoot,loop.source.path,maxItems);
};
const emit=(callback:LoopOptions['onProgress'],event:LoopEvent)=>{
  try {callback?.(event);}catch{/* UI progress must never decide HTTP success/failure */}
};
/** Sequential T05 vertical slice: resolve/approve the ENTIRE known batch before any HTTP I/O. */
export async function executeLoop(file:RequestFile,options:LoopOptions):Promise<LoopExecution>{
  const started=performance.now();
  const valid=validateRequestFile(file,'run.request.json');
  if(!valid.valid)throw new Error(`RequestFile inválido: ${valid.issues.map(x=>x.path).join(', ')}`);
  if(!file.loop)throw new Error('A request não possui loop');
  const items=await readDataset(file.loop,options);
  const total=items.length;
  // Important: preflight every item before the first I/O or approval; a failed item doesn't produce side-effects.
  const plans:Array<{request:HttpRequestDefinition;protectedFiles:readonly string[]}>=[];
  for(const locals of items){
    const {request,resolution}=interpolateRequest(file.request,options.snapshot,{
      ...options.template,
      locals:{...options.template?.locals,...locals},
    });
    checkHttpTarget(request.url,options.policy);
    plans.push({request,protectedFiles:resolution.usedProtectedFiles});
  }
  const protectedFiles=[...new Set(plans.flatMap(plan=>[...plan.protectedFiles]))];
  if(protectedFiles.length){
    const destinations=[...new Set(plans.map(plan=>new URL(plan.request.url).origin))];
    const target=plans[0]!.request;
    await approveProtectedExecution(protectedFiles,{method:target.method,url:target.url,count:total,destinations},options.approval);
  }
  const results: ExecutionResult[]=[];
  const sessions:ExecutionSession[]=[];
  const diagnostics:Array<{ordinal:number;code:string;message:string}>=[];
  let succeeded=0,failed=0,cancelled=0;
  let cancelledByUser=options.signal?.aborted??false;
  emit(options.onProgress,{type:'batch_started',total});
  for(const [index,plan] of plans.entries()){
    if(options.signal?.aborted){cancelledByUser=true;break;}
    const ordinal=index+1;
    emit(options.onProgress,{type:'iteration_started',ordinal,total});
    let session:ExecutionSession;
    try{
      session=await fetchHttpRequest(plan.request,{
        ...(options.policy===undefined?{}:{policy:options.policy}),
        ...(options.signal===undefined?{}:{signal:options.signal}),
        ...(file.options?.timeoutMs===undefined?{}:{timeoutMs:file.options.timeoutMs}),
        ...(file.options?.maxResponseBytes===undefined?{}:{maxResponseBytes:file.options.maxResponseBytes}),
        ...(options.fetch===undefined?{}:{fetch:options.fetch}),
        ...(options.maxRedirects===undefined?{}:{maxRedirects:options.maxRedirects}),
      });
    }catch(error){
      // An unsupported body/response limit is a transport error, not an invented HTTP response.
      const code=error instanceof HttpExecutionError ? error.code : 'NETWORK_ERROR';
      diagnostics.push({ordinal,code,message:'Erro de transporte durante loop'});
      session=new ExecutionSession({request:{method:plan.request.method,url:plan.request.url,headers:plan.request.headers??[],...(plan.request.body===undefined?{}:{body:plan.request.body})},response:null,timings:{totalMs:0}});
    }
    sessions.push(session);
    results.push(session.result);
    const statusCode=session.result.response?.status;
    let status:'succeeded'|'failed'|'cancelled';
    if(options.signal?.aborted || session.diagnostic?.code==='ABORTED'){
      status='cancelled';cancelled++;cancelledByUser=true;
    }else if(session.result.response && statusCode!==undefined && statusCode<400){
      status='succeeded';succeeded++;
    }else{status='failed';failed++;}
    if(session.diagnostic)diagnostics.push({ordinal,code:session.diagnostic.code,message:session.diagnostic.message});
    emit(options.onProgress,{type:'iteration_completed',ordinal,total,status,...(statusCode===undefined?{}:{statusCode})});
    if(cancelledByUser){emit(options.onProgress,{type:'cancelling',total});break;}
    if(status==='failed' && file.loop.onError!=='continue')break;
  }
  const executed=results.length;
  const status=cancelledByUser?'cancelled':failed===0?'succeeded':succeeded>0?'partial_failed':'failed';
  const result:ExecutionBatchResult={
    summary:{status,total,executed,succeeded,failed,cancelled,skipped:total-executed},
    timings:{totalMs:performance.now()-started},
    results,
  };
  emit(options.onProgress,{type:cancelledByUser?'cancelled':'batch_completed',total});
  return {result,diagnostics,sessions,dispose:()=>sessions.forEach(x=>x.dispose())};
}
