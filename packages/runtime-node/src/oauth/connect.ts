import { preparePKCEAuthorization } from '../../../core/src/oauth/pkce.js';
import { normalizeOAuthIssuer } from '../../../core/src/oauth/discovery.js';
import type { OAuthDefinition, OAuthDiscoveryPlan } from '../../../core/src/oauth/discovery.js';
import { exchangeAuthorizationCode } from './token-exchange.js';
import type { OAuthCredentialVault, OAuthAuthorizationHost } from './token-exchange.js';
import { oauthVaultKey } from './session-resolver.js';

export interface ConnectOAuthOptions {
  readonly definition: OAuthDefinition;
  readonly metadata: OAuthDiscoveryPlan;
  readonly filePath: string;
  readonly variableName: string;
  readonly redirectUri: string;
  readonly authorizationHost: OAuthAuthorizationHost;
  readonly vault: OAuthCredentialVault;
  readonly fetcher?: typeof fetch;
  readonly lookupHost?: (hostname: string) => Promise<readonly string[]>;
  readonly now?: () => number;
}
/**
 * Host-mediated OAuth connect: discovery was already performed, and the host chooses
 * the browser/callback and secure vault. No localhost server or credential store is
 * silently created by the shared engine.
 */
export async function connectOAuthSession(
  options: ConnectOAuthOptions,
): Promise<{ tokenType: 'Bearer'; expiresAt?: number }> {
  if (normalizeOAuthIssuer(options.definition.issuer) !== normalizeOAuthIssuer(options.metadata.issuer))
    throw new Error('OAuth issuer da variável não corresponde aos metadados');
  const pkce = await preparePKCEAuthorization(options.metadata, {
    clientId: options.definition.clientId,
    redirectUri: options.redirectUri,
    ...(options.definition.scopes ? { scopes: options.definition.scopes } : {}),
  });
  const callback = await options.authorizationHost.authorize({
    authorizationUrl: pkce.authorizationUrl,
    state: pkce.state,
    redirectUri: pkce.redirectUri,
  });
  return exchangeAuthorizationCode(options.metadata, options.definition, pkce, callback, {
    vault: options.vault,
    vaultKey: oauthVaultKey({
      filePath: options.filePath,
      name: options.variableName,
      issuer: options.definition.issuer,
      clientId: options.definition.clientId,
      ...(options.definition.scopes ? { scopes: options.definition.scopes } : {}),
    }),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.lookupHost ? { lookupHost: options.lookupHost } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
