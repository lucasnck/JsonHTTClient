import type {OAuthDiscoveryPlan} from './discovery.js';
import {OAuthConfigError} from './discovery.js';

export interface PKCEAuthorization {
  authorizationUrl:string;
  verifier:string;
  state:string;
  redirectUri:string;
}
function base64url(bytes:Uint8Array):string{
  // No Node Buffer dependency: safe in browser bundles as well as Node.
  let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function randomString():string{
  if(!globalThis.crypto?.getRandomValues)throw new OAuthConfigError('INVALID_CONFIG','Cryptographic randomness unavailable');
  const bytes=new Uint8Array(32);globalThis.crypto.getRandomValues(bytes);return base64url(bytes);
}
export function validateOAuthRedirectUri(uri:string):void{
  let url:URL;
  try{url=new URL(uri);}catch{throw new OAuthConfigError('INVALID_CONFIG','Redirect OAuth inválido');}
  const local=url.hostname==='127.0.0.1'||url.hostname==='[::1]';
  if(!((url.protocol==='https:')||(url.protocol==='http:'&&local))||url.username||url.password||url.hash)
    throw new OAuthConfigError('INVALID_CONFIG','Redirect requer HTTPS ou loopback HTTP sem credenciais');
}
/** Pure browser/Node Code+PKCE S256 preparation. It never opens a browser or stores a token. */
export async function preparePKCEAuthorization(
  metadata:Pick<OAuthDiscoveryPlan,'authorizationEndpoint'>,
  options:{clientId:string;redirectUri:string;scopes?:readonly string[]},
):Promise<PKCEAuthorization>{
  if(!options.clientId?.trim())throw new OAuthConfigError('INVALID_CONFIG','clientId é obrigatório');
  validateOAuthRedirectUri(options.redirectUri);
  let endpoint:URL;
  try{endpoint=new URL(metadata.authorizationEndpoint);}catch{throw new OAuthConfigError('INVALID_CONFIG','Endpoint authorize inválido');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)
    throw new OAuthConfigError('INVALID_CONFIG','Authorize endpoint requer HTTPS');
  const verifier=randomString(),state=randomString();
  const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  const challenge=base64url(new Uint8Array(digest));
  endpoint.searchParams.set('response_type','code');
  endpoint.searchParams.set('client_id',options.clientId);
  endpoint.searchParams.set('redirect_uri',options.redirectUri);
  endpoint.searchParams.set('state',state);
  endpoint.searchParams.set('code_challenge',challenge);
  endpoint.searchParams.set('code_challenge_method','S256');
  if(options.scopes?.length)endpoint.searchParams.set('scope',options.scopes.join(' '));
  return {authorizationUrl:endpoint.href,verifier,state,redirectUri:options.redirectUri};
}
