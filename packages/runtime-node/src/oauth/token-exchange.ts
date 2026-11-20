import { lookup } from 'node:dns/promises';
import { checkHttpTarget, isPrivateHostname } from '../../../core/src/security/policies.js';
import type { PKCEAuthorization } from '../../../core/src/oauth/pkce.js';
import type { OAuthDiscoveryPlan } from '../../../core/src/oauth/discovery.js';

/** No tokens or credentials should be persisted in variables.json or diagnostics. */
export interface OAuthCredential {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
}
export interface OAuthCredentialVault {
  save(key: string, credential: OAuthCredential): Promise<void>;
  load(key: string): Promise<OAuthCredential | undefined>;
}
export interface OAuthAuthorizationHost {
  /** The host handles external browser and local callback only when supported. */
  authorize(request: {
    authorizationUrl: string;
    state: string;
    redirectUri: string;
  }): Promise<{ code: string; state: string }>;
}
export class OAuthTokenError extends Error {
  constructor(
    public readonly code: 'STATE_MISMATCH' | 'INVALID_TOKEN' | 'NETWORK_ERROR' | 'TOKEN_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}
const MAX_BYTES = 256 * 1024;
/** Exchange code+PKCE with an explicit fetch adapter and host-provided secret vault. */
export async function exchangeAuthorizationCode(
  metadata: Pick<OAuthDiscoveryPlan, 'tokenEndpoint'>,
  config: { clientId: string },
  pkce: PKCEAuthorization,
  callback: { code: string; state: string },
  options: {
    fetcher?: typeof fetch;
    vault: OAuthCredentialVault;
    vaultKey: string;
    now?: () => number;
    timeoutMs?: number;
    lookupHost?: (hostname: string) => Promise<readonly string[]>;
  },
): Promise<{ tokenType: 'Bearer'; expiresAt?: number }> {
  if (!callback.state || callback.state !== pkce.state)
    throw new OAuthTokenError('STATE_MISMATCH', 'OAuth state inválido');
  if (!callback.code || !pkce.verifier || !config.clientId || !options.vaultKey)
    throw new OAuthTokenError('INVALID_TOKEN', 'OAuth callback ou configuração inválidos');
  const endpoint = checkHttpTarget(metadata.tokenEndpoint);
  if (endpoint.hash) throw new OAuthTokenError('INVALID_TOKEN', 'Token endpoint inválido');
  const addresses = await (
    options.lookupHost ??
    (async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((x) => x.address))
  )(endpoint.hostname);
  if (addresses.length === 0 || addresses.some((ip) => isPrivateHostname(ip)))
    throw new OAuthTokenError('NETWORK_ERROR', 'OAuth token endpoint DNS não permitido');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: pkce.redirectUri,
    client_id: config.clientId,
    code_verifier: pkce.verifier,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(endpoint.href, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) throw new OAuthTokenError('NETWORK_ERROR', 'OAuth token endpoint rejeitou a troca');
    const length = response.headers.get('content-length');
    if (length && Number(length) > MAX_BYTES)
      throw new OAuthTokenError('TOKEN_TOO_LARGE', 'Resposta OAuth excede limite');
    if (!response.body) throw new OAuthTokenError('INVALID_TOKEN', 'Resposta OAuth vazia');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new OAuthTokenError('TOKEN_TOO_LARGE', 'Resposta OAuth excede limite');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new OAuthTokenError('INVALID_TOKEN', 'Token endpoint retornou JSON inválido');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new OAuthTokenError('INVALID_TOKEN', 'Resposta OAuth inválida');
    const obj = value as Record<string, unknown>;
    if (obj.token_type !== 'Bearer' || typeof obj.access_token !== 'string' || !obj.access_token)
      throw new OAuthTokenError('INVALID_TOKEN', 'Token endpoint não retornou Bearer válido');
    if (obj.refresh_token !== undefined && typeof obj.refresh_token !== 'string')
      throw new OAuthTokenError('INVALID_TOKEN', 'refresh_token inválido');
    const seconds = obj.expires_in;
    if (seconds !== undefined && (!Number.isSafeInteger(seconds) || Number(seconds) < 1))
      throw new OAuthTokenError('INVALID_TOKEN', 'expires_in inválido');
    const credential: OAuthCredential = { accessToken: obj.access_token, tokenType: 'Bearer' };
    if (typeof obj.refresh_token === 'string') credential.refreshToken = obj.refresh_token;
    if (typeof obj.scope === 'string') credential.scope = obj.scope;
    if (typeof seconds === 'number') credential.expiresAt = (options.now ?? Date.now)() + seconds * 1000;
    await options.vault.save(options.vaultKey, credential);
    return {
      tokenType: 'Bearer',
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    };
  } finally {
    clearTimeout(timer);
  }
}
