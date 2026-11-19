import type {HttpRequestDefinition} from '../../core/src/contracts/types.js';
import type {JsonValue,VariableSnapshot,VariableSource} from '../../core/src/variables/variables.js';
import {interpolateRequest,TemplateError} from '../../core/src/templates/interpolation.js';
import type {TemplateOptions,TemplateResolution} from '../../core/src/templates/interpolation.js';

/** The host owns consent, token lifetime and secure storage; the motor never persists tokens. */
export interface OAuthTokenRequest {
  readonly name:string;
  readonly definition:JsonValue;
  readonly source:VariableSource|undefined;
  readonly signal?:AbortSignal;
}
export type OAuthTokenProvider=(request:OAuthTokenRequest)=>Promise<string>;

interface Reference {name:string;definition:JsonValue;source:VariableSource|undefined}
export interface PreparedRequest {
  /** No access token: used only for policy/protected preflight. */
  readonly preflight:HttpRequestDefinition;
  readonly resolution:TemplateResolution;
  materialize():Promise<HttpRequestDefinition>;
}

const PENDING='OAUTH_CREDENTIAL_NOT_YET_RESOLVED';
/**
 * Two-phase interpolation: inspect/protect/authorize the network target BEFORE asking
 * the host for a credential; only after approval materialize the real request.
 */
export function prepareRequestWithOAuth(
  request:HttpRequestDefinition,
  snapshot:VariableSnapshot,
  options:TemplateOptions={},
  provider?:OAuthTokenProvider,
  signal?:AbortSignal,
):PreparedRequest {
  const references=new Map<string,Reference>();
  const preflight=interpolateRequest(request,snapshot,{
    ...options,
    resolveOAuth:(name,definition,source)=>{
      if(!provider)throw new TemplateError('OAUTH_ADAPTER_REQUIRED',`OAuth ${name} exige sessão autorizada`,name);
      references.set(name,{name,definition,source});
      return PENDING;
    },
  });
  return {
    preflight:preflight.request,
    resolution:preflight.resolution,
    async materialize(){
      if(references.size===0)return preflight.request;
      if(!provider)throw new TemplateError('OAUTH_ADAPTER_REQUIRED','Provedor OAuth ausente');
      const tokens=new Map<string,string>();
      for(const ref of references.values()){
        if(signal?.aborted)throw new TemplateError('OAUTH_ADAPTER_REQUIRED','Execução cancelada antes do OAuth');
        const token=await provider({name:ref.name,definition:ref.definition,source:ref.source,...(signal?{signal}:{})});
        if(typeof token!=='string'||!token||/[\r\n]/.test(token))
          throw new TemplateError('OAUTH_ADAPTER_REQUIRED','O provedor OAuth retornou token inválido');
        tokens.set(ref.name,token);
      }
      const actual=interpolateRequest(request,snapshot,{
        ...options,resolveOAuth:name=>{
          const token=tokens.get(name);
          if(!token)throw new TemplateError('OAUTH_ADAPTER_REQUIRED',`OAuth ${name} não resolvido`);
          return token;
        },
      });
      // A credential must not rewrite the already approved destination. In practice this
      // prevents accidental OAuth access tokens in URLs, protecting them from URL logs.
      if(actual.request.url!==preflight.request.url)
        throw new TemplateError('INVALID_TEMPLATE','OAuth não pode ser usado na URL da request');
      return actual.request;
    },
  };
}
