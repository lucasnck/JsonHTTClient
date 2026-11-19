import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {TextDecoder} from 'node:util';
import type {ExecutionResult, HttpRequestDefinition, HttpResponseProjection, NameValue, RequestBody, RequestProjection} from '../../../core/src/contracts/types.js';
import {checkHttpTarget, HttpPolicyError, isPrivateHostname} from '../../../core/src/security/policies.js';
import type {HttpNetworkPolicy} from '../../../core/src/security/policies.js';

export type HttpExecutionCode = 'NETWORK_ERROR' | 'ABORTED' | 'TIMEOUT' | 'BODY_TOO_LARGE' | 'UNSUPPORTED_BODY' | 'TOO_MANY_REDIRECTS';
export class HttpExecutionError extends Error {
  constructor(public readonly code: HttpExecutionCode, message: string) {
    super(message);
    this.name = 'HttpExecutionError';
  }
}
export interface FetchOptions {
  readonly policy?: HttpNetworkPolicy;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  /** Optional host override used by tests and alternative fetch-capable runtimes. */
  readonly fetch?: typeof fetch;
}
const MASKED_HEADERS = new Set(['authorization','cookie','set-cookie','x-api-key']);

function redact(headers: readonly NameValue[]): NameValue[] {
  return headers.map(({name,value}) => ({
    name,
    value: MASKED_HEADERS.has(name.toLowerCase()) ? (name.toLowerCase() === 'authorization' && /^Bearer /i.test(value) ? 'Bearer [REDACTED]' : '[REDACTED]') : value,
  }));
}
function copyProjection(request: RequestProjection, visible: boolean): RequestProjection {
  return {...request, headers: visible ? request.headers.map(x=>({...x})) : redact(request.headers)};
}
function copyResponse(response: HttpResponseProjection | null, visible: boolean): HttpResponseProjection | null {
  return response ? {...response, headers: visible ? response.headers.map(x=>({...x})) : redact(response.headers)} : null;
}
/** Holds original HTTP headers in a private session; no re-request needed to reveal locally. */
export class ExecutionSession {
  private original: ExecutionResult | undefined;
  private readonly publicResult: ExecutionResult;
  constructor(original: ExecutionResult, public readonly diagnostic?: {code: HttpExecutionCode; message: string}) {
    this.original = original;
    this.publicResult = {
      request: copyProjection(original.request, false),
      response: copyResponse(original.response, false),
      timings: original.timings,
    };
  }
  get result(): ExecutionResult {return this.publicResult;}
  viewOriginalHeaders(): ExecutionResult {
    if (!this.original) throw new HttpExecutionError('ABORTED','Headers originais não estão mais disponíveis em memória');
    return {
      request: copyProjection(this.original.request,true),
      response: copyResponse(this.original.response,true),
      timings: this.original.timings,
    };
  }
  dispose(): void {this.original = undefined;}
}

const mapHeaders = (headers: Headers): NameValue[] => Array.from(headers.entries(),([name,value])=>({name,value}));

function encodeBody(input: RequestBody | undefined, headers: Headers): BodyInit | undefined {
  if (!input || input.type === 'none') return undefined;
  if (input.type === 'json') {
    if (!headers.has('content-type')) headers.set('content-type','application/json');
    return JSON.stringify(input.value);
  }
  if (input.type === 'text') return input.value;
  if (input.type === 'urlencoded') {
    if (!headers.has('content-type')) headers.set('content-type','application/x-www-form-urlencoded;charset=UTF-8');
    const data=new URLSearchParams();for(const item of input.value)data.append(item.name,item.value);
    return data;
  }
  if (input.type === 'multipart') {
    const data = new FormData();
    for (const item of input.parts) {
      if (item.file !== undefined) throw new HttpExecutionError('UNSUPPORTED_BODY','Upload de arquivo ainda requer adapter de filesystem autorizado');
      data.append(item.name,item.value ?? '');
    }
    if (headers.has('content-type')) throw new HttpExecutionError('UNSUPPORTED_BODY','Não informar boundary multipart manualmente');
    return data;
  }
  throw new HttpExecutionError('UNSUPPORTED_BODY','Body binary/stream requer adapter autorizado ainda não implementado');
}
async function checkDnsTarget(url: URL, policy: HttpNetworkPolicy): Promise<void> {
  if (policy.allowPrivateNetworks || isIP(url.hostname.replace(/^\[|\]$/g,'')) !== 0) return;
  let addresses: Awaited<ReturnType<typeof lookup>>;
  try {addresses = await lookup(url.hostname, {all:true,verbatim:true}) as never;}catch {
    // DNS failure is handled by the fetch adapter; no request must be sent yet.
    throw new HttpExecutionError('NETWORK_ERROR','Falha de DNS antes do envio HTTP');
  }
  const results = addresses as unknown as Array<{address:string}>;
  if (!results.length || results.some(({address})=>isPrivateHostname(address))) {
    throw new HttpPolicyError('BLOCKED_PRIVATE_NETWORK','DNS retornou IP privado ou inválido');
  }
  // NOTE: fetch may perform a SECOND DNS lookup. DNS pinning requires a dispatcher and is pending T09.
}

async function boundedResponse(response: Response, maxBytes: number): Promise<HttpResponseProjection['body']> {
  if (!response.body || response.status === 204 || response.status === 304) return {type:'none'};
  const reader=response.body.getReader();
  const chunks: Uint8Array[]=[];
  let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done)break;
      size+=value.byteLength;
      if (size>maxBytes) {
        await reader.cancel().catch(()=>undefined);
        throw new HttpExecutionError('BODY_TOO_LARGE','Limite de bytes da resposta excedido');
      }
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  if (size===0)return {type:'none'};
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const mime=response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!mime || mime.includes('json') || mime.startsWith('text/') || mime.includes('xml') || mime.includes('x-www-form-urlencoded')) {
    const string=new TextDecoder('utf-8').decode(bytes);
    if (mime.includes('json')) {
      try{return {type:'json',value:JSON.parse(string) as unknown};}catch {return {type:'text',value:string};}
    }
    return {type:'text',value:string};
  }
  // Binary cannot be represented without a durable artifact reference. Fail explicitly instead of losing bytes.
  throw new HttpExecutionError('UNSUPPORTED_BODY','Response binária requer armazenamento de artefato autorizado');
}

/** Node fetch first vertical slice; response/error envelopes never contain diagnostic keys. */
export async function fetchHttpRequest(request: HttpRequestDefinition, options: FetchOptions = {}): Promise<ExecutionSession> {
  const begun=performance.now();
  const policy=options.policy ?? {};
  const maxBytes=options.maxResponseBytes ?? 2_097_152;
  const timeout=options.timeoutMs ?? 30_000;
  const maxRedirects=options.maxRedirects ?? 4;
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || !Number.isSafeInteger(timeout) || timeout<1)
    throw new HttpExecutionError('UNSUPPORTED_BODY','Limites HTTP inválidos');
  let target=checkHttpTarget(request.url,policy);
  for (const item of request.query ?? [])target.searchParams.append(item.name,item.value);
  const headers=new Headers();
  for (const {name,value} of request.headers ?? [])headers.append(name,value);
  if (request.auth?.type === 'bearer') headers.set('authorization',`Bearer ${request.auth.token}`);
  if (request.auth?.type === 'basic') {
    headers.set('authorization',`Basic ${Buffer.from(`${request.auth.username}:${request.auth.password}`).toString('base64')}`);
  }
  const body=encodeBody(request.body,headers);
  if ((request.method==='GET' || request.method==='HEAD') && body !== undefined)
    throw new HttpExecutionError('UNSUPPORTED_BODY','GET e HEAD não podem enviar body neste adapter');
  const outgoing: RequestProjection={method:request.method,url:target.toString(),headers:mapHeaders(headers),...(request.body===undefined?{}:{body:request.body})};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new HttpExecutionError('TIMEOUT','Timeout HTTP excedido')),timeout);
  const abort=()=>controller.abort(new HttpExecutionError('ABORTED','Execução cancelada pelo usuário'));
  options.signal?.addEventListener('abort',abort,{once:true});
  if (options.signal?.aborted)abort();
  try {
    const adapter=options.fetch ?? fetch;
    let response: Response | undefined;
    for(let hop=0;hop<=maxRedirects;hop++){
      checkHttpTarget(target.toString(),policy);
      await checkDnsTarget(target,policy);
      try {
        response=await adapter(target,{method:request.method,headers,...(body === undefined ? {} : {body}),signal:controller.signal,redirect:'manual'});
      }catch(error){
        const cause=controller.signal.reason;
        const code=controller.signal.aborted && cause instanceof HttpExecutionError ? cause.code
          : controller.signal.aborted ? 'ABORTED' : 'NETWORK_ERROR';
        return new ExecutionSession({request:outgoing,response:null,timings:{totalMs:performance.now()-begun}},
          {code,message:code==='ABORTED'?'Execução cancelada':code==='TIMEOUT'?'Tempo limite excedido':'Falha no transporte HTTP'});
      }
      if (![301,302,303,307,308].includes(response.status) || !response.headers.has('location'))break;
      if (hop===maxRedirects)throw new HttpExecutionError('TOO_MANY_REDIRECTS','Limite de redirects excedido');
      const next=checkHttpTarget(new URL(response.headers.get('location')!,target).toString(),policy);
      if (next.origin !== target.origin) {
        headers.delete('authorization');headers.delete('cookie');
      }
      if ([301,302,303].includes(response.status) && request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpExecutionError('UNSUPPORTED_BODY','Redirect de método não seguro requer decisão explícita do host');
      }
      target=next;
    }
    if (!response)throw new HttpExecutionError('NETWORK_ERROR','Transporte não retornou response');
    const out: HttpResponseProjection={status:response.status,statusText:response.statusText,headers:mapHeaders(response.headers),body:await boundedResponse(response,maxBytes)};
    return new ExecutionSession({request:outgoing,response:out,timings:{totalMs:performance.now()-begun}});
  }finally{
    clearTimeout(timer);
    options.signal?.removeEventListener('abort',abort);
  }
}
