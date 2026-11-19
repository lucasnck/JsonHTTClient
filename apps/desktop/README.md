# Desktop F06 — Tauri 2 + React/Monaco development scaffold

**Status: partial implementation, NOT an installable desktop release.**

This app is designed to keep the single TypeScript HTTP engine from ADR-001.
- `src/tab-sessions.ts`: tabs, Run/Stop, edited Response Save As and restoration.
- `src/node-session-store.ts`: app-data-only session snapshots; only engine-generated masked headers are persisted. Unsaved edits are never written to session storage, and HTTP bodies may contain secrets.
- `src/sidecar-protocol.ts`: restricted JSON-line commands for requests, Stop, variable activation, import preview/Apply and native approval challenges. All operations enforce workspace root.
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

- The Rust host selects the trusted workspace, displays native Yes/No confirmations for protected HTTP and import Apply, and sends private one-time responses to the sidecar. See [desktop approval protocol](../../docs/DESKTOP-NATIVE-APPROVAL.md). Sidecar FS operations remain within the selected root. Session snapshots are stored separately under native app-data, not the project tree.
- Tauri `desktop_send` only accepts a small operation allowlist. The sidecar uses the same SDK security preflight as the CLI, never duplicates HTTP handling, and does not allow a frontend-provided `approval:true` flag to bypass `protected`.
- Import Apply requires either explicit `--allow-import-apply` in trusted direct sidecar tests or **per-operation native confirmation** when the Tauri host starts with `--native-import-approval`. JavaScript cannot grant this through request arguments. File overwrite is always blocked.
- OAuth token storage, remote VSC host, signed desktop installers, **native Rust dialog compilation/smoke tests** and DNS/socket pinning are still pending. Native approval protocol is tested only on the Node side.
- The current Save As is confined to the selected workspace; a future explicit native save-grant can allow an external path without granting general write access.
- This scaffold does not claim that Tauri was compiled or that npm dependencies are installed.

## Automated, idempotent machine setup (T11 / F06)

The supported desktop setup entrypoints are in the **repository root**, not inside the
Tauri `src-tauri` folder. They check installed prerequisites before attempting any
installation; system-level installation is **opt-in**.

### Windows (PowerShell)

```powershell
.\scripts\bootstrap-desktop.ps1 # inspect what is available
.\scripts\bootstrap-desktop.ps1 -InstallSystem -InstallNpm # install missing prerequisites
npm run desktop:doctor
npm run desktop:dev
npm run desktop:build
```

Run in an elevated PowerShell console when Windows prompts for Visual Studio Build Tools
installation. If Node/Rust was installed, reopen the terminal to refresh PATH. The
script checks for Node >=22, rustc/cargo, Microsoft C++ build workload and WebView2.
It uses winget only if `-InstallSystem` is specified, and does not install existing
components. In environments where Build Tools are installed **without** the C++
workload, use Visual Studio Installer to modify the installation.

### macOS / Debian and Ubuntu (Bash)

```bash
bash scripts/bootstrap-desktop.sh # check existing tools
bash scripts/bootstrap-desktop.sh --install-system --install-npm # explicit installation
npm run desktop:doctor
npm run desktop:dev
npm run desktop:build
```

On Debian/Ubuntu, the script installs the Tauri 2 GTK/WebKitGTK development dependencies
through apt only with `--install-system`; for Node it uses an official pinned Linux
binary with its official SHA256 checksums (unless Node >=22 is already available).
Rustup stable is downloaded from the official endpoint only with that opt-in flag.
On macOS, Xcode Command Line Tools may require manual confirmation and a terminal restart;
Node is installed via Homebrew if needed. Other Linux distributions should follow the
[official Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) instead of
assuming Debian package names exist.

### Commands and build order

| Command | What it does |
| --- | --- |
| `npm run desktop:doctor` | Inspects Node, Rust/Cargo, native OS libraries, npm modules, lockfiles and generated artifacts; no installation |
| `npm run desktop:setup` | Installs **missing** JavaScript dependencies in root, UI and Tauri host; uses `npm ci` when a lockfile exists |
| `npm run desktop:dev` | Ensures npm packages, compiles the shared TypeScript engine and launches `tauri dev` (which starts Vite) |
| `npm run desktop:runtime:stage` | Copies the currently executing Node binary into the native Tauri resources; validates OS, architecture and Node version; never commits the binary |
| `npm run desktop:build` | Ensures packages, compiles engine + UI, stages Node, checks the bundle and calls Tauri release build |
| `node tooling/desktop-workflow.mjs build --dry-run` | Prints all build steps without installing or modifying files |

The build must run **natively for each target OS and CPU architecture**. A Node
binary copied from Linux cannot be embedded into a Windows/macOS installer. The
build gate rejects a missing UI, engine or bundled runtime. A successful `npm run
desktop:build` only means that Tauri generated its target artifacts; real native
installation tests and signing remain separate release requirements.

Do not commit `resources/runtime/node(.exe)`; it is rebuilt locally. These scripts
will not disable TLS, protected approvals or file access policies.
