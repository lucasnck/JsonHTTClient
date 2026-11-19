# HTTP Engine — MCP server (F03 initial integration)

Status: **development only**, not a published MCP package. Tested locally through newline-delimited JSON-RPC 2.0 over `stdio`. The official MCP SDK and external host interoperability have **not** yet been validated. Do not expose this unfinished runtime to untrusted workspaces or networks (T09 remains PENDING).

## Running from the monorepo

```bash
npm run build
node dist/apps/mcp-server/src/main.js --root /absolute/path/to/http-requests
# or: node dist/apps/cli/src/main.js mcp serve --root /absolute/path/to/http-requests
```

The default server is **read-only**. It handles MCP `initialize`, `ping`, `tools/list`, `tools/call` and `notifications/initialized`. Each JSON-RPC message is one line on stdin; stdout is reserved for protocol responses (diagnostics, if any, go to stderr). It does not install or inspect third-party MCP servers.

To grant additional privileges **only through host/operator startup configuration** (never through an agent-supplied tool argument):

- `--allow-run`: enable HTTP request execution and Stop, confined to an explicitly configured filesystem root; HTTPS/public hosts only by default.
- `--allow-write`: enable variable-file Activate/Deactivate and explicit OAuth configuration saves.
- `--allow-protected`: explicit host authorization for protected variables **in this initial implementation**; protect with host-side consent, not an agent-generated flag.
- `--allow-oauth-discovery`: permit OAuth issuer metadata network lookups.
- `--allow-http` and `--allow-private-network`: explicitly relax network policy, e.g. for local test environments. Both should remain off for untrusted content.

Server tools currently implemented: `request_list`, `request_validate`, `variables_list`, `variables_explain` (provenance only, not raw values), `request_run`, `execution_stop`, `variables_activate_file`, `variables_deactivate_file`, `import_preview`, `oauth_discover`, `oauth_save_variable`.

Features not implemented: `request_run_dir`, `import_apply`, real OAuth login/callback/secure vault in MCP, per-request elicitation, official MCP SDK conformance and published installer. These belong to F03/T06/T09/T10. The server does **not** silently log in or retrieve tokens when a request contains `{{OAuthToken}}` and no host vault is configured.

## Example read-only host configuration

```json
{
  "mcpServers": {
    "json-http-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/build/dist/apps/mcp-server/src/main.js",
        "--root",
        "/absolute/path/to/http-requests"
      ]
    }
  }
}
```

The exact host's configuration format may differ; this is a generic illustration, not a claim of compatibility with every host.

## Safety notes

Every tool resolves paths against the configured physical workspace root. Write and run are disabled unless the host explicitly enables them. The result is the engine's canonical JSON (HTTP errors include real status/body), with only named sensitive request/response HTTP headers masked; the API's response **body is not redacted**. No raw normal variable values are returned by `variables_explain`. Full SSRF/DNS pinning, host-assisted approvals and secure credential stores must be completed before production use.
