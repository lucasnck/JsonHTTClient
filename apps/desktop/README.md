# Desktop F06 — Tauri 2 + React/Monaco development scaffold

**Status: partial implementation, NOT an installable desktop release.**

This app is designed to keep the single TypeScript HTTP engine from ADR-001.
- `src/tab-sessions.ts`: tabs, Run/Stop, edited Response Save As and restoration.
- `src/node-session-store.ts`: app-data-only session snapshots; only engine-generated masked headers are persisted. Unsaved edits are never written to session storage, and HTTP bodies may contain secrets.
- `src/sidecar-protocol.ts`: restricted JSON-line commands for listing requests, running, stopping, variable activation, import preview and optional Apply. All operations enforce workspace root.
- `src/sidecar.ts`: persistent Node process with stdin/stdout transport, no opened TCP port.
- `ui/`: React, Monaco, Vite application with Explorer, request and response tabs, Run/Stop, JSON editor, import preview.
- `src-tauri/`: Rust host picks a directory using an OS-native dialog and starts the sidecar for that directory. The webview cannot execute Node or arbitrary shell commands.

## Development dependencies

Requires Node.js >=22, Rust toolchain, Cargo/Tauri 2 toolchain, platform SDK/GTK/WebKit and npm access. These are **not available** in the current sandbox, so only the Node sidecar and pure SDK can be tested here.

```bash
# Project root; install packages for core and frontend
npm install
npm --prefix apps/desktop/ui install
npm --prefix apps/desktop install
npm run build
npm run desktop:tauri:dev
```

`npm run desktop:bundle:check` intentionally fails until a platform-specific Node runtime is staged in `apps/desktop/src-tauri/resources/runtime/` and the UI has been built. Release must embed this runtime rather than depend on system Node; do NOT override that check by ignoring failures. Rust must be compiled and smoke-tested on each supported OS.

## Security / limitations

- The Rust native dialog selects the trusted workspace; sidecar FS operations remain within the selected root. Session snapshots are stored separately under native app-data, not the project tree.
- Tauri `desktop_send` only accepts a small operation allowlist. The sidecar uses the same SDK security preflight as the CLI, never duplicates HTTP handling, and does not allow a frontend-provided `approval:true` flag to bypass `protected`.
- Import Apply requires `--allow-import-apply` supplied **at sidecar start by the native host**, not by an agent or request; the current native host does not grant it, so the preview works but Apply will be denied. File overwrite is always blocked.
- OAuth token storage, native protected dialog/approval, remote VSC host, signed desktop installers, native smoke tests and DNS/socket pinning are still pending.
- The current Save As is confined to the selected workspace; a future explicit native save-grant can allow an external path without granting general write access.
- This scaffold does not claim that Tauri was compiled or that npm dependencies are installed.
