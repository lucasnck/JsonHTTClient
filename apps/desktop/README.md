# Desktop F06 — foundation (not yet a Tauri installer)

This directory contains the **testable, host-independent desktop session controller**. The
Tauri 2 + React/Monaco UI and signed installers remain **PENDING**. Do not call this
an installed desktop application or use it for privileged untrusted workspaces.

## Shared pieces

- `src/tab-sessions.ts`: request/response tab state, Run/Stop, edit/Save As,
  active tab and restoration. Never re-executes HTTP on restoration.
- `src/node-bridge.ts`: development adapter for authorized root filesystem and
  the **shared** `packages/runtime-node/src/editor-execution.ts` engine. Does
  not install a daemon, require a separate CLI, or implement HTTP itself.
- `src/node-session-store.ts`: atomic per-session JSON metadata/snapshots in a
  host-selected app-data directory (not in the workspace), files mode 0600.

On purpose, edited unsaved request/response buffers are **not** persisted.
Open Response tabs restore only their last **engine-produced** response JSON,
with known sensitive HTTP headers masked. The engine does not automatically
redact HTTP response bodies: these may contain confidential application data.
An eventual desktop release should let the host opt out of snapshots or use
protected encrypted storage. OAuth credentials must reside in the OS secure
store; session metadata is NEVER a token vault.

The future Tauri host should implement a narrow IPC bridge for: open folder,
read request, Run/Stop, save via explicit file picker, protected approval,
secret store, and session persistence in `app_data_dir`. No arbitrary Node APIs
should be exposed to the webview, and network requests must be executed by a
privileged host adapter with the same HTTP security policy as the CLI.

## Current validation

`npm run check:offline` executes `test/desktop-sessions.test.ts`, including a
local HTTP fixture, masked Authorization header, edited Response Save As, no
re-run on restore, closed-tab removal, abort and symlink confinement.

Still missing: Tauri/Rust manifest and host commands; React + Monaco integration;
installation, smoke UI tests, OS keychain, remote/browser capability tests.
