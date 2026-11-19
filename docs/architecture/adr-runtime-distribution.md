# ADR-001 — Embedded Engine + npm + CDN (APPROVED, 2026-11-19)

One TypeScript implementation of the HTTP Engine is reused by all clients. Every client bundles its own compatible compiled Core/SDK/runtime; there is **no mandatory global daemon or Core installation**. The runtime is also distributed as compiled JavaScript ESM + TypeScript declarations through npm, and a browser-safe ESM bundle through a versioned CDN. The CDN build does not grant access to Node filesystem/keychain APIs or bypass browser CORS.

- **VS Code desktop:** bundle SDK/runtime-node in VSIX Extension Host; no standalone CLI requirement.
- **CLI / MCP server:** Node-based npm executables using the same SDK.
- **Desktop Tauri:** package runtime inside the installer (sidecar/bridge implementation to validate).
- **Browser/CDN:** use runtime-browser with explicit capabilities; no Node APIs or OS credentials.

The exact npm package names, CDN URL, standalone CLI binary, VS Code remote/web support, and Tauri bridge remain implementation/release details. No SDK/CDN package has been published yet.

Authoritative decision: https://docs.google.com/document/d/1ZOyoBgnItyS_QQGgtaClwJwiPq7czJAmYSEnwpofGDc/edit
