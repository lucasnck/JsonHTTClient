import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  oauthMetadataCandidates,
  parseOAuthMetadata,
  createOAuthDefinition,
} from '../packages/core/src/oauth/discovery.js';
import { discoverOAuthIssuer } from '../packages/runtime-node/src/oauth/discovery.js';
import { saveOAuthVariable } from '../packages/runtime-node/src/oauth/variable-writer.js';
import { loadVariableSnapshot } from '../packages/runtime-node/src/variable-files.js';

const issuer = 'https://identity.example.test/tenant';
const metadata = {
  issuer,
  authorization_endpoint: 'https://identity.example.test/oauth/authorize',
  token_endpoint: 'https://identity.example.test/oauth/token',
  scopes_supported: ['read', 'write'],
};
function mockedFetch(data: unknown = metadata, status = 200) {
  return async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
const lookup = async (_host: string) => ['93.184.216.34'];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'json-oauth-'));
  await mkdir(join(root, 'requests'));
  return { root, dir: join(root, 'requests'), close: () => rm(root, { recursive: true, force: true }) };
}

test('T06: OIDC and RFC 8414 metadata candidates preserve issuer path', () => {
  assert.deepEqual(oauthMetadataCandidates(issuer), [
    'https://identity.example.test/tenant/.well-known/openid-configuration',
    'https://identity.example.test/.well-known/oauth-authorization-server/tenant',
  ]);
});
test('T06: parse metadata rejects mismatched issuer and insecure endpoints', () => {
  assert.throws(() =>
    parseOAuthMetadata(issuer, 'https://identity.example.test/.well-known/openid-configuration', {
      ...metadata,
      issuer: 'https://evil.test',
    }),
  );
  assert.throws(() =>
    parseOAuthMetadata(issuer, 'https://identity.example.test/.well-known/openid-configuration', {
      ...metadata,
      token_endpoint: 'http://localhost/token',
    }),
  );
});
test('T06: discovery only reads metadata; no browser/session/write', async () => {
  const visited: string[] = [];
  const plan = await discoverOAuthIssuer(issuer, {
    fetcher: async (url, init) => {
      visited.push(url);
      assert.equal(init.redirect, 'error');
      return mockedFetch()(url, init);
    },
    lookupHost: lookup,
  });
  assert.equal(visited.length, 1);
  assert.equal(plan.issuer, issuer);
  assert.equal(plan.authorizationEndpoint, metadata.authorization_endpoint);
  assert.deepEqual(plan.scopesSupported, ['read', 'write']);
  assert.deepEqual(plan.requires, ['clientId', 'scopes', 'redirect']);
  assert.equal(Object.hasOwn(plan.suggestedDefinition, 'clientId'), false);
});
test('T06: discovery falls back to RFC8414 when OIDC unavailable', async () => {
  let count = 0;
  const plan = await discoverOAuthIssuer(issuer, {
    fetcher: async (url, opts) => {
      count++;
      return count === 1 ? new Response('missing', { status: 404 }) : mockedFetch()(url, opts);
    },
    lookupHost: lookup,
  });
  assert.equal(count, 2);
  assert.match(plan.metadataUrl, /oauth-authorization-server/);
});
test('T06: discovery blocks local issuer and DNS private addresses', async () => {
  await assert.rejects(
    discoverOAuthIssuer('http://localhost:5000', { fetcher: mockedFetch(), lookupHost: lookup }),
  );
  await assert.rejects(
    discoverOAuthIssuer(issuer, { fetcher: mockedFetch(), lookupHost: async () => ['127.0.0.1'] }),
  );
});
test('T06: discovery rejects oversized responses', async () => {
  await assert.rejects(
    discoverOAuthIssuer(issuer, { fetcher: mockedFetch(metadata), lookupHost: lookup, maxMetadataBytes: 30 }),
    { code: 'METADATA_TOO_LARGE' },
  );
});
test('T06: create config requires user-supplied client and never includes tokens', () => {
  assert.throws(() => createOAuthDefinition({ issuer }, { clientId: '' }));
  const config = createOAuthDefinition({ issuer }, { clientId: 'dev-client', scopes: ['read'] });
  assert.deepEqual(config, {
    type: 'oauth2',
    issuer,
    clientId: 'dev-client',
    flow: 'authorization_code_pkce',
    scopes: ['read'],
  });
  assert.equal(Object.hasOwn(config, 'accessToken'), false);
});
test('T06: save OAuth into chosen new file creates it disabled if an active sibling exists', async () => {
  const f = await temp();
  try {
    await writeFile(
      join(f.dir, 'dev.variables.json'),
      JSON.stringify({ enabled: true, baseUrl: 'https://dev.api.test' }),
    );
    const p = join(f.dir, 'prod.variables.json');
    const result = await saveOAuthVariable(createOAuthDefinition({ issuer }, { clientId: 'prod-client' }), {
      targetFile: p,
      authorizedRoot: f.root,
      variableName: 'OAuthToken',
    });
    assert.equal(result.created, true);
    assert.equal(result.enabled, false);
    const saved = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.enabled, false);
    assert.equal((saved.OAuthToken as { clientId: string }).clientId, 'prod-client');
    assert.equal(
      (JSON.parse(await readFile(join(f.dir, 'dev.variables.json'), 'utf8')) as { enabled: boolean }).enabled,
      true,
    );
    assert.doesNotMatch(JSON.stringify(saved), /accessToken|refreshToken|clientSecret/);
  } finally {
    await f.close();
  }
});
test('T06: save into existing chosen file keeps other variables and requires overwrite consent', async () => {
  const f = await temp();
  try {
    const p = join(f.dir, 'variables.json');
    await writeFile(
      p,
      JSON.stringify({
        enabled: true,
        baseUrl: 'https://api.test',
        OAuthToken: { type: 'oauth2', issuer, clientId: 'old' },
      }),
    );
    const config = createOAuthDefinition({ issuer }, { clientId: 'new-client' });
    await assert.rejects(
      saveOAuthVariable(config, { targetFile: p, authorizedRoot: f.root, variableName: 'OAuthToken' }),
      { code: 'ALREADY_EXISTS' },
    );
    await saveOAuthVariable(config, {
      targetFile: p,
      authorizedRoot: f.root,
      variableName: 'OAuthToken',
      overwrite: true,
    });
    const result = JSON.parse(await readFile(p, 'utf8')) as {
      baseUrl: string;
      OAuthToken: { clientId: string };
    };
    assert.equal(result.baseUrl, 'https://api.test');
    assert.equal(result.OAuthToken.clientId, 'new-client');
  } finally {
    await f.close();
  }
});
test('T06: D35 first file wins with two OAuth definitions active in same folder', async () => {
  const f = await temp();
  try {
    await writeFile(
      join(f.dir, 'dev.variables.json'),
      JSON.stringify({ enabled: true, OAuthToken: { type: 'oauth2', issuer, clientId: 'dev' } }),
    );
    await writeFile(
      join(f.dir, 'prod.variables.json'),
      JSON.stringify({ enabled: true, OAuthToken: { type: 'oauth2', issuer, clientId: 'prod' } }),
    );
    const req = join(f.dir, 'request.request.json');
    await writeFile(req, '{}');
    const snapshot = await loadVariableSnapshot(req, f.root);
    assert.equal((snapshot.get('OAuthToken')?.value as { clientId: string }).clientId, 'dev');
  } finally {
    await f.close();
  }
});
test('T06: reject traversal and invalid variable destination', async () => {
  const f = await temp();
  try {
    const config = createOAuthDefinition({ issuer }, { clientId: 'x' });
    await assert.rejects(
      saveOAuthVariable(config, {
        targetFile: join(f.root, '../../escape.variables.json'),
        authorizedRoot: f.root,
        variableName: 'OAuthToken',
      }),
    );
    await assert.rejects(
      saveOAuthVariable(config, {
        targetFile: join(f.dir, 'other.json'),
        authorizedRoot: f.root,
        variableName: 'OAuthToken',
      }),
    );
    await assert.rejects(
      saveOAuthVariable(config, {
        targetFile: join(f.dir, 'ok.variables.json'),
        authorizedRoot: f.root,
        variableName: '__proto__',
      }),
    );
  } finally {
    await f.close();
  }
});
