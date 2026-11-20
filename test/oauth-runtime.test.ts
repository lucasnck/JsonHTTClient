import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVariableSnapshot } from '../packages/core/src/variables/variables.js';
import { executeRequestFile } from '../packages/sdk-js/src/execution.js';
import { executeLoop } from '../packages/sdk-js/src/loop-execution.js';
import { TemplateError } from '../packages/core/src/templates/interpolation.js';
import { HttpPolicyError } from '../packages/core/src/security/policies.js';
import {
  createOAuthVaultTokenProvider,
  OAuthSessionError,
  oauthVaultKey,
} from '../packages/runtime-node/src/oauth/session-resolver.js';
import type {
  OAuthCredential,
  OAuthCredentialVault,
} from '../packages/runtime-node/src/oauth/token-exchange.js';
import type { RequestFile } from '../packages/core/src/contracts/types.js';

const config = {
  type: 'oauth2',
  issuer: 'https://identity.example.test',
  clientId: 'public-client',
  scopes: ['read'],
};
const sourcePath = '/project/dev.variables.json';
const local = { allowHttp: true, allowPrivateNetworks: true };
function createSnapshot(url: string, protectedFile = false) {
  return createVariableSnapshot([
    {
      folderPath: '/project',
      files: [
        {
          filePath: sourcePath,
          filename: 'dev.variables.json',
          content: { enabled: true, protected: protectedFile, baseUrl: url, OAuthToken: config },
        },
      ],
    },
  ]);
}
function makeVault(token?: OAuthCredential): {
  vault: OAuthCredentialVault;
  values: Map<string, OAuthCredential>;
} {
  const values = new Map<string, OAuthCredential>();
  const key = oauthVaultKey({
    filePath: sourcePath,
    name: 'OAuthToken',
    issuer: config.issuer,
    clientId: config.clientId,
    scopes: config.scopes,
  });
  if (token) values.set(key, token);
  return {
    values,
    vault: {
      save: async (k, v) => {
        values.set(k, v);
      },
      load: async (k) => values.get(k),
    },
  };
}
const request: RequestFile = {
  request: { method: 'GET', url: '{{baseUrl}}/echo', auth: { type: 'bearer', token: '{{OAuthToken}}' } },
};
async function fixture() {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authorization: req.headers.authorization || null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
test('T06: OAuth injected vault token resolves only after preflight, never enters the variables file', async () => {
  const http = await fixture();
  try {
    const { vault } = makeVault({
      accessToken: 'SECRET-123',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 600_000,
    });
    const session = await executeRequestFile(request, {
      snapshot: createSnapshot(http.base),
      policy: local,
      oauthTokenProvider: createOAuthVaultTokenProvider(vault),
    });
    assert.equal(http.calls(), 1);
    assert.equal(session.result.response?.status, 200);
    assert.equal(
      session.result.request.headers.find((x) => x.name === 'authorization')?.value,
      'Bearer [REDACTED]',
    );
    assert.equal(
      session.viewOriginalHeaders().request.headers.find((x) => x.name === 'authorization')?.value,
      'Bearer SECRET-123',
    );
    assert.equal(
      JSON.stringify(createSnapshot(http.base).get('OAuthToken')?.value).includes('SECRET-123'),
      false,
    );
    session.dispose();
  } finally {
    await http.close();
  }
});
test('T06/T09: protected approval denial happens before vault access or HTTP', async () => {
  const http = await fixture();
  let lookedUp = 0;
  try {
    const vault: OAuthCredentialVault = {
      load: async () => {
        lookedUp++;
        return { accessToken: 'secret', tokenType: 'Bearer' };
      },
      save: async () => {},
    };
    await assert.rejects(
      executeRequestFile(request, {
        snapshot: createSnapshot(http.base, true),
        policy: local,
        oauthTokenProvider: createOAuthVaultTokenProvider(vault),
      }),
      (error: unknown) => error instanceof HttpPolicyError && error.code === 'APPROVAL_REQUIRED',
    );
    assert.equal(lookedUp, 0);
    assert.equal(http.calls(), 0);
  } finally {
    await http.close();
  }
});
test('T06: missing or expired credentials fail closed without outbound HTTP', async () => {
  const http = await fixture();
  try {
    const { vault } = makeVault();
    await assert.rejects(
      executeRequestFile(request, {
        snapshot: createSnapshot(http.base),
        policy: local,
        oauthTokenProvider: createOAuthVaultTokenProvider(vault),
      }),
      (error: unknown) => error instanceof OAuthSessionError && error.code === 'CREDENTIAL_MISSING',
    );
    const expired = makeVault({ accessToken: 'EXPIRED', tokenType: 'Bearer', expiresAt: 500 });
    await assert.rejects(
      executeRequestFile(request, {
        snapshot: createSnapshot(http.base),
        policy: local,
        oauthTokenProvider: createOAuthVaultTokenProvider(expired.vault, { now: () => 500 }),
      }),
      (error: unknown) => error instanceof OAuthSessionError && error.code === 'CREDENTIAL_EXPIRED',
    );
    await assert.rejects(
      executeRequestFile(request, { snapshot: createSnapshot(http.base), policy: local }),
      (error: unknown) => error instanceof TemplateError && error.code === 'OAUTH_ADAPTER_REQUIRED',
    );
    assert.equal(http.calls(), 0);
  } finally {
    await http.close();
  }
});
test('T06: OAuth must not change the URL after destination was approved', async () => {
  const http = await fixture();
  try {
    const file: RequestFile = { request: { method: 'GET', url: '{{baseUrl}}/{{OAuthToken}}' } };
    await assert.rejects(
      executeRequestFile(file, {
        snapshot: createSnapshot(http.base),
        policy: local,
        oauthTokenProvider: async () => 'TOKEN_IN_URL',
      }),
      (e: unknown) => e instanceof TemplateError && e.code === 'INVALID_TEMPLATE',
    );
    assert.equal(http.calls(), 0);
  } finally {
    await http.close();
  }
});
test('T05: loop OAuth materialization happens after aggregate protected approval', async () => {
  const http = await fixture();
  try {
    const file: RequestFile = {
      ...request,
      loop: { source: { kind: 'inline', items: [{ key: 1 }, { key: 2 }] } },
    };
    let checked = 0;
    let approved = 0;
    const result = await executeLoop(file, {
      snapshot: createSnapshot(http.base, true),
      policy: local,
      approval: async () => {
        approved++;
        return true;
      },
      oauthTokenProvider: async () => {
        checked++;
        return 'loop-token';
      },
    });
    assert.equal(approved, 1);
    assert.equal(checked, 2);
    assert.equal(http.calls(), 2);
    assert.equal(result.result.summary.status, 'succeeded');
    assert.equal(result.result.results.length, 2);
    result.dispose();
  } finally {
    await http.close();
  }
});
test('T06: host-authorized PKCE connect stores credential in host vault for subsequent HTTP execution', async () => {
  const { connectOAuthSession } = await import('../packages/runtime-node/src/oauth/connect.js');
  const http = await fixture();
  const { vault, values } = makeVault();
  const metadata = {
    issuer: config.issuer,
    metadataUrl: `${config.issuer}/.well-known/openid-configuration`,
    authorizationEndpoint: `${config.issuer}/authorize`,
    tokenEndpoint: `${config.issuer}/token`,
    scopesSupported: ['read'],
    supportedGrantTypes: ['authorization_code'],
    suggestedDefinition: {
      type: 'oauth2' as const,
      issuer: config.issuer,
      flow: 'authorization_code_pkce' as const,
    },
    requires: ['clientId', 'scopes', 'redirect'] as const,
  };
  try {
    let opened = 0;
    const result = await connectOAuthSession({
      definition: { ...config, type: 'oauth2' as const, flow: 'authorization_code_pkce' },
      metadata,
      filePath: sourcePath,
      variableName: 'OAuthToken',
      redirectUri: 'http://127.0.0.1:50999/callback',
      vault,
      authorizationHost: {
        authorize: async (req) => {
          opened++;
          assert.match(req.authorizationUrl, /code_challenge_method=S256/);
          return { code: 'mock-code', state: req.state };
        },
      },
      lookupHost: async () => ['93.184.216.34'],
      fetcher: async (_url, req) => {
        const form = new URLSearchParams(String(req?.body));
        assert.equal(form.get('code'), 'mock-code');
        return new Response(
          JSON.stringify({ access_token: 'CONNECTED_TOKEN', token_type: 'Bearer', expires_in: 3600 }),
          { status: 200 },
        );
      },
    });
    assert.equal(opened, 1);
    assert.equal(result.tokenType, 'Bearer');
    assert.equal(JSON.stringify(result).includes('CONNECTED_TOKEN'), false);
    assert.equal([...values.values()][0]?.accessToken, 'CONNECTED_TOKEN');
    const executed = await executeRequestFile(request, {
      snapshot: createSnapshot(http.base),
      policy: local,
      oauthTokenProvider: createOAuthVaultTokenProvider(vault),
    });
    assert.equal(executed.result.response?.status, 200);
    assert.equal(
      executed.result.request.headers.find((h) => h.name === 'authorization')?.value,
      'Bearer [REDACTED]',
    );
    executed.dispose();
  } finally {
    await http.close();
  }
});
test('T06: vault session keys differ for different source files, providers or scopes', () => {
  const base = {
    filePath: '/root/dev.variables.json',
    name: 'OAuthToken',
    issuer: config.issuer,
    clientId: config.clientId,
    scopes: ['read'],
  };
  assert.notEqual(oauthVaultKey(base), oauthVaultKey({ ...base, filePath: '/root/prod.variables.json' }));
  assert.notEqual(oauthVaultKey(base), oauthVaultKey({ ...base, scopes: ['write'] }));
  assert.notEqual(oauthVaultKey(base), oauthVaultKey({ ...base, clientId: 'other-client' }));
  assert.equal(
    oauthVaultKey({ ...base, scopes: ['read', 'write'] }),
    oauthVaultKey({ ...base, scopes: ['write', 'read'] }),
  );
});
