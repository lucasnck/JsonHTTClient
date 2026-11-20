import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePKCEAuthorization } from '../packages/core/src/oauth/pkce.js';
import { exchangeAuthorizationCode } from '../packages/runtime-node/src/oauth/token-exchange.js';
import type {
  OAuthCredential,
  OAuthCredentialVault,
} from '../packages/runtime-node/src/oauth/token-exchange.js';

const authorizationEndpoint = 'https://identity.example.test/authorize';
const tokenEndpoint = 'https://identity.example.test/token';
const lookup = async (_host: string) => ['93.184.216.34'];
function vault(): { store: OAuthCredentialVault; values: Map<string, OAuthCredential> } {
  const values = new Map<string, OAuthCredential>();
  return {
    values,
    store: {
      save: async (key, c) => {
        values.set(key, c);
      },
      load: async (key) => values.get(key),
    },
  };
}
void test('T06: PKCE creates S256 challenge, 128+ bit state and redirects correctly', async () => {
  const input = await preparePKCEAuthorization(
    { authorizationEndpoint },
    { clientId: 'myapp', redirectUri: 'http://127.0.0.1:55000/callback', scopes: ['read', 'write'] },
  );
  const url = new URL(input.authorizationUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'myapp');
  assert.equal(url.searchParams.get('scope'), 'read write');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(input.verifier.length, 43);
  assert.ok(input.state.length >= 43);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.verifier));
  assert.equal(url.searchParams.get('code_challenge'), Buffer.from(digest).toString('base64url'));
});
void test('T06: PKCE rejects non-loopback HTTP callback', async () => {
  await assert.rejects(
    preparePKCEAuthorization(
      { authorizationEndpoint },
      { clientId: 'x', redirectUri: 'http://example.com/callback' },
    ),
  );
});
void test('T06: Code+PKCE exchange rejects wrong state without network', async () => {
  const pkce = await preparePKCEAuthorization(
    { authorizationEndpoint },
    { clientId: 'a', redirectUri: 'http://127.0.0.1:5000/callback' },
  );
  const secret = vault();
  let calls = 0;
  await assert.rejects(
    exchangeAuthorizationCode(
      { tokenEndpoint },
      { clientId: 'a' },
      pkce,
      { code: 'code', state: 'wrong' },
      {
        vault: secret.store,
        vaultKey: 'dev-OAuthToken',
        lookupHost: lookup,
        fetcher: async () => {
          calls++;
          return new Response('{}');
        },
      },
    ),
    { code: 'STATE_MISMATCH' },
  );
  assert.equal(calls, 0);
  assert.equal(secret.values.size, 0);
});
void test('T06: Exchange sends verifier to HTTPS endpoint and saves tokens only in vault', async () => {
  const pkce = await preparePKCEAuthorization(
    { authorizationEndpoint },
    { clientId: 'a', redirectUri: 'http://127.0.0.1:5000/callback' },
  );
  const secret = vault();
  let called = 0;
  const result = await exchangeAuthorizationCode(
    { tokenEndpoint },
    { clientId: 'a' },
    pkce,
    { code: 'server-code', state: pkce.state },
    {
      vault: secret.store,
      vaultKey: 'dev-OAuthToken',
      lookupHost: lookup,
      now: () => 1000,
      fetcher: async (url, opts) => {
        called++;
        assert.equal(url, tokenEndpoint);
        assert.equal(opts?.redirect, 'error');
        assert.equal(typeof opts?.body, 'string');
        const form = new URLSearchParams(opts?.body as string);
        assert.equal(form.get('code_verifier'), pkce.verifier);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('client_id'), 'a');
        return new Response(
          JSON.stringify({
            token_type: 'Bearer',
            access_token: 'SECRET-ACCESS',
            refresh_token: 'SECRET-REFRESH',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(called, 1);
  assert.deepEqual(result, { tokenType: 'Bearer', expiresAt: 3601000 });
  assert.equal(secret.values.get('dev-OAuthToken')?.accessToken, 'SECRET-ACCESS');
  assert.equal(secret.values.get('dev-OAuthToken')?.refreshToken, 'SECRET-REFRESH');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
void test('T06: Exchange rejects non-Bearer and private token destinations', async () => {
  const pkce = await preparePKCEAuthorization(
    { authorizationEndpoint },
    { clientId: 'a', redirectUri: 'http://127.0.0.1:55000/callback' },
  );
  const secret = vault();
  await assert.rejects(
    exchangeAuthorizationCode(
      { tokenEndpoint },
      { clientId: 'a' },
      pkce,
      { code: 'c', state: pkce.state },
      {
        vault: secret.store,
        vaultKey: 'x',
        lookupHost: lookup,
        fetcher: async () => new Response('{"access_token":"x","token_type":"Basic"}'),
      },
    ),
    { code: 'INVALID_TOKEN' },
  );
  await assert.rejects(
    exchangeAuthorizationCode(
      { tokenEndpoint },
      { clientId: 'a' },
      pkce,
      { code: 'c', state: pkce.state },
      {
        vault: secret.store,
        vaultKey: 'x',
        lookupHost: async () => ['127.0.0.1'],
        fetcher: async () => new Response('{}'),
      },
    ),
  );
  assert.equal(secret.values.size, 0);
});
