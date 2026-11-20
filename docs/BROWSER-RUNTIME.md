# Browser runtime — T08 (development)

The HTTP Engine's Node-agnostic TypeScript modules are now consumed by a
browser-safe `executeBrowserRequest()` adapter. It accepts an already provided
`VariableSnapshot` (no filesystem scanning) and an optional host `fetch` and
approval callback. OAuth session/keychain/callbacks and directory loops are
**not** available in the default browser runtime. The browser cannot bypass
CORS restrictions imposed by the requested API.

```ts
import { executeBrowserRequest, createVariableSnapshot } from './index.mjs';
const snapshot = createVariableSnapshot([]);
const { result, diagnostic } = await executeBrowserRequest(
  {
    request: { method: 'GET', url: 'https://api.example.com/health' },
  },
  { snapshot },
);
```

By default this adapter enforces HTTPS and blocks private-hostname requests;
redirects are rejected, rather than silently navigating to an unchecked host.
It preserves 4xx/5xx bodies/status, masks only the known sensitive response and
request **headers** and returns `response:null` with an out-of-band diagnostic
when network access fails (which can be CORS or DNS; it cannot distinguish
browser failures precisely). It does not automatically mask HTTP response
bodies. Binary/stream requests/responses, filesystem, local OAuth and OS
secret-store APIs explicitly require an authorized external host adapter.

## Local build

```bash
npm run browser:pack
# outputs artifacts/browser-esm/index.mjs and dependent browser-safe ESM graph
```

The script traces static ESM dependencies from the browser entry and excludes
Node-only runtime packages. It does not reserve an npm name, deploy a CDN,
run a development web server, or claim a one-file bundle. Host the _entire_
`browser-esm` folder under an immutable versioned HTTPS CDN URL and serve JavaScript
with correct MIME type. The final npm/CDN publishing workflow remains F09/T10.

Validation: `test/browser-http.test.ts` and `test/browser-package.test.ts`
exercise mocked browser fetch, header masking, 404, network/CORS denial,
protected authorization, import of the generated browser graph and no Node
imports. Real browser/CORS integration test and CDN hosting remain PENDING.
