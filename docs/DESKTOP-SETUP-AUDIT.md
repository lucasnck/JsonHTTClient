# Desktop setup audit — T11 / F06 / F09 / T10

Date: 2026-11-19. Status: **PARTIAL** (automation implemented; native release validation not yet possible).

## What existed before this increment

- Root `desktop:tauri:dev` and `desktop:tauri:build`, but no cross-platform prerequisite installer.
- Three separate npm manifests: root TypeScript engine, `apps/desktop/ui` Vite/React/Monaco and `apps/desktop` Tauri CLI.
- A release gate that only checked the _existence_ of the Node executable, not that it would run on the build OS/architecture.
- A release command whose gate executed _before_ the frontend could be built/staged.
- Existing test that expected the desktop bundle gate to **always fail**, even after the environment was ready.

## New entrypoints

- `scripts/bootstrap-desktop.sh`: macOS/Debian/Ubuntu system prerequisites; opt-in `--install-system`, optional `--install-npm`; no silent mutations and `--dry-run` support.
- `scripts/bootstrap-desktop.ps1`: Windows prerequisite detection/winget install opt-in (`-InstallSystem`, `-InstallNpm`, `-DryRun`).
- `tooling/desktop-workflow.mjs`: Node >=22 orchestrator for `doctor`, `setup`, `dev`, `runtime`, `build`; validates installed npm dependencies, Cargo/Rust and native SDK, reuses existing dependencies, chooses `npm ci` when package locks exist.
- `tooling/check-desktop-bundle.mjs`: refuses missing engine/UI/Node and rejects a symlink, incompatible or nonexecuting Node binary; verifies the Tauri `bundle.resources` mapping.
- `package.json`: stable commands `desktop:doctor`, `desktop:setup`, `desktop:dev`, `desktop:runtime:stage`, `desktop:build`; previous `desktop:tauri:*` aliases retained.
- `test/desktop-workflow.test.ts`: unit-level CLI dry-run/doctor/guards/opt-in checks.
- `test/desktop-scaffold.test.ts`: gate now follows real build readiness rather than expecting permanent failure.

## How developers use it

Windows PowerShell:

```powershell
.\scripts\bootstrap-desktop.ps1 -InstallSystem -InstallNpm
npm run desktop:doctor
npm run desktop:dev
npm run desktop:build
```

Debian/Ubuntu and macOS Bash:

```bash
bash scripts/bootstrap-desktop.sh --install-system --install-npm
npm run desktop:doctor
npm run desktop:dev
npm run desktop:build
```

No system-level installation occurs unless requested by flag. On macOS, Xcode Command Line Tools may require manual confirmation. Windows C++ workloads may require an elevated Visual Studio Installer session; reopen terminal after a new Node/Rust installation.

## Build-order guarantee

`desktop:build`: ensure npm root/UI/Tauri packages, compile TS shared SDK, compile UI/Vite, stage a same-OS/architecture Node runtime (`process.execPath`) in Tauri resources, execute release gate, invoke `tauri build`. Cross-compilation with a different Node CPU or OS is not supported without platform-specific staging. `desktop:dev`: ensure modules + Rust toolchain, compile shared TS, start Tauri dev (which starts Vite).

The Node executable is a **local release artifact**, never checked into Git. Installers must include this executable; the end user must not be required to install Node, CLI or a daemon globally.

## Verified on this execution environment (Debian Linux x64)

- Node 22.16.0 and npm 10.9.2 detected; no Rust/Cargo.
- Tauri native development libraries missing (`webkit2gtk-4.1`, GTK3, Ayatana AppIndicator and librsvg); no desktop UI npm packages, nor root ESLint/Prettier, nor Tauri CLI package.
- `bash -n scripts/bootstrap-desktop.sh`: PASS.
- `bash scripts/bootstrap-desktop.sh --install-system --install-npm --dry-run`: PASS, no installations.
- `node tooling/desktop-workflow.mjs build --dry-run`: PASS, displays ordered commands without side effects.
- `node tooling/desktop-workflow.mjs runtime`: PASS. Staged Node executable ran, returned matching Linux/x64 Node 22.16.0; repeated staging skipped existing matching runtime. The staged binary was removed after verification (recreated by a real build).
- `node tooling/check-desktop-bundle.mjs`: correctly FAILED because the frontend Vite `dist/index.html` is missing; no fake installer generated.
- `npm run check:offline`: TypeScript typecheck PASS, compilation PASS, Node tests **153/153 PASS**, 0 FAIL.
- `npm run browser:pack`: PASS (12 static ESM modules).
- `npm run vscode:pack`: PASS (37 VSIX files).
- `npm run check`: FAIL/BLOCKED at `prettier --check .` because Prettier dependency is not installed.

## Not validated — mandatory before DONE/release

- `npm install`/`npm ci` on all three package roots from a machine with npm registry access, committed and reproducible `package-lock.json` files; full lint/format gate.
- Windows Powershell bootstrap execution; Linux/macOS actual system-level package installation; Windows C++ Build Tools workload and WebView2 smoke tests.
- macOS/Windows/Linux native Rust/Cargo compilation, Vite build with actual React types, Tauri dev startup, installer production/signing, installation and uninstall smoke tests on supported systems.
- OAuth keychain/redirect, import approvals, T09 DNS pinning and session storage hardening (separate TECH/FEATURE requirements).

Official prerequisite reference: https://v2.tauri.app/start/prerequisites/ . Bundled resources reference: https://v2.tauri.app/develop/resources/ .

This audit records automated local evidence only. It is not a product acceptance or a native install test.
