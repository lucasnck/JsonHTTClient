# Tauri native confirmations — F10 / F08 (partial)

The desktop UI does **not** grant privileges. The Tauri Rust host picks the authorized
workspace root and starts the Node sidecar with `--native-approval` and
`--native-import-approval`. The sidecar has no network listening port.

## Protected HTTP requests (F10)

1. The SDK resolves request variables, checks target policy and determines which
   **effective** variable files are protected (including alphabetical precedence).
2. **Before** HTTP or OAuth-token retrieval, the Node sidecar generates a
   cryptographically random, one-use challenge and sends a
   `native-approval-request` event through its private stdout to the Rust host.
   The event includes only the HTTP method, destination **origins**, protected
   file names and batch count. It excludes raw token values, headers, query
   parameters and response bodies.
3. Rust intercepts this event **before** publishing general `desktop-message`
   events to the webview. It shows a native Yes/No dialog. The private
   ChildStdin receives `__nativeApprovalResponse` with the challenge and
   Boolean decision. The Tauri `desktop_send` allowlist **never** accepts this
   reserved operation from JavaScript.
4. The sidecar consumes the decision once. Denial, 45-second timeout, Stop,
   malformed replies and replay fail closed. A loop requires a single native
   confirmation for its entire preflighted batch, before its first HTTP call.

## Import Apply (F08)

The static `importPreview` never creates files, starts a process or sends HTTP.
For `importApply` the sidecar validates the pending preview and destination
folder, consumes the plan ID, and emits `native-import-approval-request` to the
Rust host. The native dialog summarizes **only** output folder and generated
filenames (not imported Authorization headers or source URLs). A positive
one-use reply allows `applyImportPlan`; existing files are never overwritten.
Denial, timeout and replay cannot write any files. An untrusted JavaScript
`approved: true` argument does not confer permission.

## Boundaries and remaining work

- The local Node/TypeScript IPC protocol, cancellation and timeout behavior are
  covered by automated tests. Rust/`rfd` dialogs have **not** been compiled or
  exercised on Windows, macOS or Linux because the Rust toolchain is not
  available in the current environment. They are not a shipping desktop feature.
- No OAuth keychain, secure token persistence or production DNS/socket pinning
  is provided here. The Tauri installer, Node runtime bundle and native smoke
  tests are also still pending.
- The response editor remains an ordinary editable JSON tab. HTTP response
  bodies are not automatically redacted; saved or persisted JSON may include
  sensitive information and should be handled accordingly.
