# JsonHttpEngineWorkspace — M0 development bootstrap

Initial implementation slice for **T01 (contracts)**, **T02 (variable files)** and **T11 (code-quality toolchain)** from the Google Drive roadmap. **No HTTP transport, OAuth login, CLI, MCP server, VS Code extension, desktop, npm publish or CDN release is implemented yet.**

## Architecture

The engine is one TypeScript implementation shared across clients. The [approved distribution ADR](docs/architecture/adr-runtime-distribution.md) calls for client-embedded builds, npm JavaScript ESM + `.d.ts`, and a browser-safe CDN ESM build, without a mandatory global daemon. These delivery targets are *planned*, not released.

## Current code

- Public TypeScript request, single-result and batch-result types.
- Draft 2020-12 JSON Schema for requests, variables and execution results.
- Runtime validation of request filename/structure and result shape.
- Pure variable resolver and Node filesystem adapter with nearest-folder precedence, deterministic filename ordering and effective value provenance. Multiple manually enabled variable files are allowed; Activate disables siblings.
- Tests for dev/prod OAuth metadata, ancestry, permissions, contracts, and the T11 configuration baseline.
- Shared TypeScript strict options, ESLint 9 flat config with type-aware TypeScript rules, Prettier, EditorConfig and suggested VS Code settings.

## Requirements and commands

Node.js **22+**, npm **10+**. Install dependencies when registry access is available:

```sh
npm install
npm run check
```

The quality scripts are:

| Command | Purpose |
| --- | --- |
| `npm run format` | Format repository with Prettier. |
| `npm run format:check` | Verify formatting without changes. |
| `npm run lint` | ESLint flat config, type-aware rules; no warnings permitted. |
| `npm run lint:fix` | Auto-fix eligible ESLint problems. |
| `npm run typecheck` | Compile-check strict TypeScript without emitting files. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm test` | Build, then run Node's test runner. |
| `npm run check` | **Full gate:** Prettier, ESLint, TypeScript, tests. |
| `npm run check:offline` | **Limited fallback** running only TypeScript and tests; not equivalent to the full gate. |

`package-lock.json` and `npm ci` are pending a successful online dependency installation. The current sandbox cannot reach the npm registry. No ESLint or Prettier execution is claimed until they can actually be installed and run. Existing files may require `npm run format` before `format:check` succeeds.

## Current limitations

1. T01: handwritten runtime validator does not yet consume the JSON Schema definitions; parity suite required.
2. T02: Activate writes atomically per file with best-effort rollback, not a cross-process/crash-safe transaction; file watchers and races pending.
3. T11: actual ESLint/Prettier commands and npm lockfile/CI gate pending dependency installation; TypeScript and Node test gate can run with locally available compiler/node typings.
4. T03+ and all clients still pending; `OAuthToken` is metadata only, not authentication.
5. No remote GitHub repository has been found. Source can be restored from the supplied Git bundle and source ZIP; no push is claimed.

See the Google Drive specs: [T11 — toolchain](https://docs.google.com/document/d/18yqUFX1BfEQYnDlmsdAuJOuB1TV5FPPVl5SxmtkuJzI/edit), [T08 — runtime/distribution](https://docs.google.com/document/d/1tQ2aBbyo3Z8pu-yFdDx3C-_mQrIMF75V0blgqLEyeJA/edit).
