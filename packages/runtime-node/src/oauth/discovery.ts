import { lookup } from 'node:dns/promises';
import { checkHttpTarget, isPrivateHostname } from '../../../core/src/security/policies.js';
import { oauthMetadataCandidates, parseOAuthMetadata } from '../../../core/src/oauth/discovery.js';
import type { OAuthDiscoveryPlan } from '../../../core/src/oauth/discovery.js';

export type MetadataFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface OAuthDiscoveryOptions {
  fetcher?: MetadataFetch;
  lookupHost?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
  maxMetadataBytes?: number;
}
export class OAuthDiscoveryError extends Error {
  constructor(
    public readonly code: 'METADATA_NOT_FOUND' | 'METADATA_TOO_LARGE' | 'NETWORK_ERROR' | 'INVALID_METADATA',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthDiscoveryError';
  }
}
const DEFAULT_MAX = 256 * 1024;
const defaultLookup = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((x) => x.address);
function assertPublicIps(addresses: readonly string[]): void {
  if (addresses.length === 0 || addresses.some((ip) => isPrivateHostname(ip)))
    throw new OAuthDiscoveryError('NETWORK_ERROR', 'Endereço DNS local/privado não é permitido');
}
/** Read-only discovery; never starts a login, follows a redirect, or writes token/config files. */
export async function discoverOAuthIssuer(
  issuer: string,
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthDiscoveryPlan> {
  const timeout = options.timeoutMs ?? 5000,
    max = options.maxMetadataBytes ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(max) || max < 1)
    throw new OAuthDiscoveryError('NETWORK_ERROR', 'Limites de discovery inválidos');
  const fetcher = options.fetcher ?? fetch;
  const resolveHost = options.lookupHost ?? defaultLookup;
  let reason = 'Nenhuma URL de metadados suportada respondeu';
  for (const candidate of oauthMetadataCandidates(issuer)) {
    const u = checkHttpTarget(candidate);
    try {
      // Best-effort DNS check; final socket pinning remains a T09 requirement.
      assertPublicIps(await resolveHost(u.hostname));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetcher(candidate, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          reason = `Metadados indisponíveis (${response.status})`;
          continue;
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > max)
          throw new OAuthDiscoveryError('METADATA_TOO_LARGE', 'Metadados OAuth excedem limite');
        if (!response.body) throw new OAuthDiscoveryError('INVALID_METADATA', 'Corpo OAuth vazio');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) {
              void reader.cancel().catch(() => undefined);
              throw new OAuthDiscoveryError('METADATA_TOO_LARGE', 'Metadados OAuth excedem limite');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let data: unknown;
        try {
          data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
        } catch {
          throw new OAuthDiscoveryError('INVALID_METADATA', 'Metadados OAuth não são JSON válido');
        }
        return parseOAuthMetadata(issuer, candidate, data);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof OAuthDiscoveryError && error.code === 'METADATA_TOO_LARGE') throw error;
      if (error instanceof Error && 'code' in error && String(error.code) === 'INVALID_METADATA')
        throw new OAuthDiscoveryError('INVALID_METADATA', 'OAuth discovery retornou metadados inválidos');
      reason = error instanceof OAuthDiscoveryError ? error.message : 'Falha ao descobrir metadados OAuth';
    }
  }
  throw new OAuthDiscoveryError('METADATA_NOT_FOUND', reason);
}
