import { createHash } from 'node:crypto';
import type { JsonValue } from '../../../core/src/variables/variables.js';
import type { OAuthTokenProvider } from '../../../sdk-js/src/oauth-request.js';
import type { OAuthCredentialVault } from './token-exchange.js';

export type OAuthSessionErrorCode = 'INVALID_OAUTH_CONFIG' | 'CREDENTIAL_MISSING' | 'CREDENTIAL_EXPIRED';
export class OAuthSessionError extends Error {
  constructor(public readonly code: OAuthSessionErrorCode) {
    super('OAuth exige sessão válida no armazenamento seguro do host');
    this.name = 'OAuthSessionError';
  }
}
function isOAuthConfig(
  value: JsonValue,
): value is { type: 'oauth2'; issuer: string; clientId: string; scopes?: string[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'oauth2' &&
    typeof value.issuer === 'string' &&
    value.issuer.startsWith('https://') &&
    typeof value.clientId === 'string' &&
    !!value.clientId &&
    (value.scopes === undefined ||
      (Array.isArray(value.scopes) && value.scopes.every((s) => typeof s === 'string')))
  );
}
/** Stable, non-credential identifier: each physical source file and OAuth definition has its own session. */
export function oauthVaultKey(input: {
  filePath: string;
  name: string;
  issuer: string;
  clientId: string;
  scopes?: readonly string[];
}): string {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        input.filePath,
        input.name,
        input.issuer,
        input.clientId,
        [...(input.scopes ?? [])].sort(),
      ]),
    )
    .digest('hex');
  return `json-http:oauth:${fingerprint}`;
}
/**
 * Session-only provider: no implicit browser, refresh, token serialization or sign-in.
 * An authorized host must save a valid token in its own vault before execution.
 */
export function createOAuthVaultTokenProvider(
  vault: OAuthCredentialVault,
  options: { now?: () => number; expirySkewMs?: number } = {},
): OAuthTokenProvider {
  return async ({ name, definition, source, signal }) => {
    if (signal?.aborted) throw new OAuthSessionError('CREDENTIAL_MISSING');
    if (!source || !isOAuthConfig(definition)) throw new OAuthSessionError('INVALID_OAUTH_CONFIG');
    const key = oauthVaultKey({
      filePath: source.filePath,
      name,
      issuer: definition.issuer,
      clientId: definition.clientId,
      ...(definition.scopes ? { scopes: definition.scopes } : {}),
    });
    const credential = await vault.load(key);
    if (signal?.aborted) throw new OAuthSessionError('CREDENTIAL_MISSING');
    if (!credential?.accessToken || credential.tokenType !== 'Bearer')
      throw new OAuthSessionError('CREDENTIAL_MISSING');
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= (options.now ?? Date.now)() + (options.expirySkewMs ?? 30_000)
    )
      throw new OAuthSessionError('CREDENTIAL_EXPIRED');
    if (/[\r\n]/.test(credential.accessToken)) throw new OAuthSessionError('INVALID_OAUTH_CONFIG');
    return credential.accessToken;
  };
}
