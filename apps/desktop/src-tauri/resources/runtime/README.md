# Packaged runtime placeholder (NOT an installer)

The native bundle MUST contain the target-platform Node executable here
(`node` or `node.exe`) before creating an installable Tauri release. In
development the Rust bridge uses `node` from PATH and compiled dist output.
Do not ship an installer that depends on Node installed by the end user.
No Node executable is bundled in this repository or release scaffold yet.
