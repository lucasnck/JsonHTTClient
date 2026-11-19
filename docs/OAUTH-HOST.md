# OAuth — host adapter contract (T06 intermediate stage)

OAuth configuration is an object variable in **any** enabled `variables.json` / `*.variables.json`, e.g. `OAuthToken: {type: "oauth2", issuer: "https://id.example", clientId: "app", scopes:["read"]}`. Files may have both dev and prod OAuth definitions; the deterministic alphabetical first-definition rule applies when both files are manually enabled. No access/refresh token is stored in these JSON files.

`connectOAuthSession({definition, metadata, filePath, variableName, redirectUri, authorizationHost, vault, ...})` is an orchestration helper, **not** a browser/secret-store implementation. The host must:

1. Show an explicit login action and choose a valid callback URI.
2. Implement `OAuthAuthorizationHost.authorize` to open an external system browser, validate its loopback/redirect callback, and return `{code,state}`. Never silently open a browser during hover or file listing.
3. Provide a secure `OAuthCredentialVault` with `save/load` methods. On a successful Code+PKCE exchange the engine persists only to that injected vault.
4. Pass `createOAuthVaultTokenProvider(vault)` into `executeRequestFile` or `executeLoop`; the engine checks HTTP destination and protected-file approval **before** it calls this token resolver, then injects the token only for actual execution. Missing/expired tokens fail closed, and OAuth token interpolation is not allowed to change the approved URL.

Credentials are distinguished using file path, variable name, issuer, clientId and scopes. No token sharing between VS Code/CLI/Desktop/MCP is implied. Actual OS secret storage, OAuth refresh/revocation, DNS/sock pinning and remote-host callback workflows remain pending. This work is not safe to treat as finished OAuth support.
