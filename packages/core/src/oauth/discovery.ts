import type { JsonValue, VariablesFile } from '../variables/variables.js';
import {validateVariablesFile} from '../variables/variables.js';

export interface OAuthDefinition {
  type: 'oauth2';
  issuer: string;
  clientId: string;
  scopes?: string[];
  flow?: 'authorization_code_pkce';
  redirect?: 'loopback';
}
export interface OAuthDiscoveryPlan {
  issuer: string;
  metadataUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported: string[];
  supportedGrantTypes: string[];
  suggestedDefinition: {type: 'oauth2'; issuer: string; flow: 'authorization_code_pkce'};
  /** Client registration, scopes and redirects are application-specific and never invented. */
  requires: readonly ['clientId', 'scopes', 'redirect'];
}
export class OAuthConfigError extends Error {
  constructor(public readonly code: 'INVALID_ISSUER'|'INVALID_METADATA'|'INVALID_CONFIG'|'INVALID_VARIABLE_NAME', message: string) {
    super(message);this.name='OAuthConfigError';
  }
}
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const validHttps=(value:string):boolean=>{
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.search;}
  catch{return false;}
};
export function normalizeOAuthIssuer(issuer:string):string {
  if(!validHttps(issuer))throw new OAuthConfigError('INVALID_ISSUER','OAuth issuer deve ser URL HTTPS sem query, fragment ou usuário');
  const u=new URL(issuer);return u.origin+(u.pathname==='/'?'':u.pathname.replace(/\/$/,''));
}
export function oauthMetadataCandidates(issuer:string):string[] {
  const normalized=normalizeOAuthIssuer(issuer);
  const u=new URL(normalized);
  const suffix=u.pathname==='/'?'':u.pathname;
  return [
    `${u.origin}${suffix}/.well-known/openid-configuration`,
    `${u.origin}/.well-known/oauth-authorization-server${suffix}`,
  ];
}
/** Verify the metadata instead of trusting any arbitrary JSON obtained from the network. */
export function parseOAuthMetadata(issuer:string,metadataUrl:string,data:unknown):OAuthDiscoveryPlan {
  const normalized=normalizeOAuthIssuer(issuer);
  if(!isRecord(data)||typeof data.issuer!=='string'||normalizeOAuthIssuer(data.issuer)!==normalized)
    throw new OAuthConfigError('INVALID_METADATA','Issuer nos metadados OAuth não corresponde ao solicitado');
  const endpoints=['authorization_endpoint','token_endpoint'] as const;
  for(const key of endpoints){
    if(typeof data[key]!=='string'||!validHttps(data[key]))
      throw new OAuthConfigError('INVALID_METADATA',`Endpoint OAuth inválido: ${key}`);
  }
  if(data.scopes_supported!==undefined&&(!Array.isArray(data.scopes_supported)||!data.scopes_supported.every(v=>typeof v==='string')))
    throw new OAuthConfigError('INVALID_METADATA','scopes_supported inválidos');
  if(data.grant_types_supported!==undefined&&(!Array.isArray(data.grant_types_supported)||!data.grant_types_supported.every(v=>typeof v==='string')))
    throw new OAuthConfigError('INVALID_METADATA','grant_types_supported inválidos');
  return {
    issuer:normalized,metadataUrl,
    authorizationEndpoint:data.authorization_endpoint as string,
    tokenEndpoint:data.token_endpoint as string,
    scopesSupported:(data.scopes_supported as string[]|undefined)??[],
    supportedGrantTypes:(data.grant_types_supported as string[]|undefined)??[],
    suggestedDefinition:{type:'oauth2',issuer:normalized,flow:'authorization_code_pkce'},
    requires:['clientId','scopes','redirect'] as const,
  };
}
/** Builds configuration only; token exchanges require a future authenticated credential adapter. */
export function createOAuthDefinition(plan:Pick<OAuthDiscoveryPlan,'issuer'>,input:{clientId:string;scopes?:string[];redirect?:'loopback'}):OAuthDefinition {
  if(!input.clientId?.trim())throw new OAuthConfigError('INVALID_CONFIG','clientId deve ser informado pelo usuário');
  if(input.scopes&&!input.scopes.every(s=>typeof s==='string'&&s.length>0))throw new OAuthConfigError('INVALID_CONFIG','Scopes inválidos');
  const config:OAuthDefinition={type:'oauth2',issuer:normalizeOAuthIssuer(plan.issuer),clientId:input.clientId,flow:'authorization_code_pkce'};
  if(input.scopes)config.scopes=[...input.scopes];
  if(input.redirect)config.redirect=input.redirect;
  const candidate:VariablesFile={enabled:true,OAuthToken:config as unknown as JsonValue};
  const parsed=validateVariablesFile(candidate);
  if(!parsed.valid)throw new OAuthConfigError('INVALID_CONFIG','Definição OAuth inválida');
  return config;
}
export function assertOAuthVariableName(name:string):void {
  if(!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)||
    ['enabled','protected','variables','$format','schemaVersion','exclusiveGroup','__proto__','prototype','constructor'].includes(name)){
    throw new OAuthConfigError('INVALID_VARIABLE_NAME','Nome de variável OAuth inválido ou reservado');
  }
}
