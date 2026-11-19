# JsonHttpEngineWorkspace — M0 development bootstrap

Initial implementation slice for **T01 (contracts)** and **T02 (variable files)** from the Google Drive roadmap. No HTTP transport, OAuth login, CLI, MCP, VS Code extension, desktop, or release installers are implemented yet.

## What is implemented

- Public TypeScript `RequestFile`, `ExecutionResult` and `ExecutionBatchResult` types.
- Draft 2020-12 JSON Schema documents for request, variables and response envelope.
- Runtime validation of request filename and file structure, status/headers/timings/root result shape and loop counters.
- A pure variable resolver and a Node adapter for `variables.json` / `*.variables.json` with nearest-folder precedence. Multiple manually enabled files are valid; names sort alphabetically (Unicode NFC, case-folded and original-name tie break), first definition of each variable wins.
- Explicit `Activate` deactivates every same-folder sibling; `Deactivate` deactivates only selected file. File replacement is atomic per file, best-effort rollback on multi-file errors (not crash-atomic across all files).
- Node test runner fixtures covering duplicates/dev-prod OAuth metadata, inheritance, protected provenance, activation and basic path/symlink protection.

## Requirements and test

Node.js 22+; TypeScript 5.8+; `@types/node` 22+. With dependencies installed:

```sh
npm install
npm run check
```

Run tests without network (with a preinstalled TypeScript and `@types/node`): `tsc && node --test dist/test/*.test.js`.

## Important limitations / next steps

1. T01: JSON Schema files and handwritten validator need a parity suite with a Draft 2020-12 validator before marking DONE. JSON Schema is not yet executed by the runtime. Body variants are authored but transport is not implemented.
2. T02: explicit Activate modifies files safely in common cases but cannot guarantee an all-or-nothing transaction across process crashes. Improve cross-process locking/atomic recovery and add file-watcher invalidation before marking DONE.
3. T03: interpolation, recursion/cycle checks, Language Service and tooltip pending.
4. T08: runtime packaging ADR is **not approved**. This archive is a development bootstrap, not a chosen installer architecture.
5. `OAuthToken` is only configuration metadata at this stage: no access/refresh token acquisition and no auth during tooltip.
6. No GitHub remote is configured by this bootstrap. Source is delivered as an archive until a target repository is provided.

Source decisions remain in `AiWorkspace/JsonHttpEngineWorkspace` on Google Drive. All product specs remain `PENDING` until their full acceptance criteria and integration tests are completed.
