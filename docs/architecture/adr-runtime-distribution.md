# ADR-T08 — Execution model and distribution (PROPOSED, NOT APPROVED)

## Decision to make

A. One TypeScript implementation bundled with each client (extension host, CLI, MCP, desktop sidecar).
B. Mandatory separately installed engine process exposing local IPC.
C. Optional shared daemon for multiple clients.

Provisional preference: A for the MVP because VS Code-only installations should require only the extension and because a local daemon adds lifecycle, authentication and version compatibility work. This is NOT an approved decision; compare OS coverage, remote VS Code, secret storage isolation, desktop sidecar and npm vs standalone CLI before committing. No daemon is implemented by this bootstrap.
