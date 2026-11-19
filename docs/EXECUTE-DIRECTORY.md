# Running request directories — F01/F03

The engine discovers **only** `*.request.json` files under a physical workspace
root. Files are ordered deterministically by relative path; ordinary JSON files
and symlinks are never executed. Without recursion, only the specified folder
is scanned. The default file cap is 500 (and hard limit 2,000 in the SDK);
MCP limits discovery to 100 via its host config.

## CLI

```bash
json-http run-dir ./requests --root .
json-http run-dir ./requests --root . --recursive
```

The CLI emits **one JSON object** to stdout. `summary` describes the directory
run, and `runs[]` associates each physical request filename with the unchanged
canonical single-request `{request,response,timings}` or foreach
`{summary,timings,results}`. This extra directory envelope does **not** change
T01's per-request or foreach schema. Progress is written only to stderr.

The command handles SIGINT via AbortSignal, reports skipped files and refuses
requests outside the authorized root. HTTP and private networks are prohibited
unless the host explicitly enables their CLI flags. A protected variable
requires the existing `--allow-protected` consent. `--show-sensitive` is a
CLI-only, explicit opt-in for original headers; do not use it in shared logs.

## MCP

`request_run_dir` requires the server to have been started with `--allow-run`.
It accepts `directory` and optional `recursive` boolean, and returns the same
safe directory result; **no unmasked headers** are returned by the MCP route.
`execution_stop` cancels an active directory execution. MCP is read-only unless
its host starts it with write permissions.

`import_preview` always does static conversion without file changes. The new
`import_apply` tool requires **both** `--allow-write` and
`--allow-import-apply` at process startup. It accepts format (`curl`, `bash`,
`openapi` JSON), source and outputDir; it cannot overwrite existing files or
write outside the root. Tool arguments cannot grant permissions to themselves.
Do not turn on write/run permissions for untrusted MCP hosts or workspaces.

Remaining: finer-grained per-action user consent in MCP, interoperability
against the official MCP SDK/Inspector and hardening against DNS rebinding.
