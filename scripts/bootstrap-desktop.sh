#!/usr/bin/env bash
# Tauri 2 desktop system bootstrap. No system mutation without --install-system.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SYSTEM=0
INSTALL_NPM=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --install-system) INSTALL_SYSTEM=1 ;;
    --install-npm) INSTALL_NPM=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo 'Usage: bash scripts/bootstrap-desktop.sh [--install-system] [--install-npm] [--dry-run]'
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
run() {
  if ((DRY_RUN)); then printf '[DRY RUN]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
report() { printf '%s\n' "[desktop setup] $*"; }
need_node() {
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  local version
  version="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
  (( version < 22 ))
}
install_portable_node_linux() {
  local arch version dir filename tmp checksum
  case "$(uname -m)" in
    x86_64) arch='x64';;
    aarch64|arm64) arch='arm64';;
    *) report 'Unsupported Node Linux architecture; install Node >=22 manually.'; return 1;;
  esac
  version='v22.23.5'
  dir="$HOME/.local/node-$version"
  if [[ -x "$dir/bin/node" ]]; then
    export PATH="$dir/bin:$PATH"
    return 0
  fi
  if ((DRY_RUN)); then
    report "Would download pinned official Node $version, verify SHA256, extract to $dir"
    return 0
  fi
  command -v curl >/dev/null || { report 'curl missing; install it via system package manager'; return 1; }
  command -v sha256sum >/dev/null || { report 'sha256sum missing'; return 1; }
  command -v tar >/dev/null || { report 'tar missing'; return 1; }
  tmp="$(mktemp -d)"
  filename="node-$version-linux-$arch.tar.xz"
  (
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL --retry 2 "https://nodejs.org/dist/$version/$filename" -o "$tmp/$filename"
    curl -fsSL --retry 2 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHA256SUMS"
    checksum="$(grep -F "  $filename" "$tmp/SHA256SUMS" || true)"
    [[ -n "$checksum" ]] || { report 'Official checksum not found'; exit 1; }
    cd "$tmp"
    printf '%s\n' "$checksum" | sha256sum -c -
    mkdir -p "$dir"
    tar -xf "$tmp/$filename" --strip-components=1 -C "$dir"
  )
  export PATH="$dir/bin:$PATH"
  report "Node $version installed in $dir (add $dir/bin to your shell PATH)"
}
install_system_linux() {
  if command -v apt-get >/dev/null; then
    local packages=(
      libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev
      libssl-dev librsvg2-dev libayatana-appindicator3-dev libgtk-3-dev pkg-config libudev-dev
    )
    local admin=()
    if [[ $EUID -ne 0 ]]; then admin=(sudo); fi
    report 'Installing native Tauri 2 development packages on Debian/Ubuntu.'
    run "${admin[@]}" apt-get update
    run "${admin[@]}" apt-get install -y "${packages[@]}"
  elif ((INSTALL_SYSTEM)); then
    report 'Linux distribution not auto-supported. Follow the Tauri 2 prerequisites for your package manager.'
    return 1
  fi
}
install_rust() {
  if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    report 'Rust and Cargo already installed; skipping.'; return
  fi
  if ((INSTALL_SYSTEM==0)); then report 'Rust/Cargo missing: use --install-system to install the stable toolchain.'; return; fi
  if ((DRY_RUN)); then report 'Would download installer from https://sh.rustup.rs and run it with -y --profile minimal.'; return; fi
  command -v curl >/dev/null || { report 'curl required for rustup'; return 1; }
  local temp
  temp="$(mktemp)"
  curl -fsSL --retry 2 'https://sh.rustup.rs' -o "$temp"
  sh "$temp" -y --profile minimal --no-modify-path
  rm -f "$temp"
  export PATH="$HOME/.cargo/bin:$PATH"
}

case "$(uname -s)" in
  Linux)
    if ((INSTALL_SYSTEM)); then install_system_linux; fi
    if need_node; then
      if ((INSTALL_SYSTEM)); then install_portable_node_linux;
      else report 'Node >=22 missing. Use --install-system (official SHA256-checked portable Node).'; fi
    else report "Node installed: $(node --version)"; fi
    install_rust
    ;;
  Darwin)
    if ! xcode-select -p >/dev/null 2>&1; then
      if ((INSTALL_SYSTEM)); then run xcode-select --install;
      else report 'Xcode Command Line Tools missing. Use --install-system.'; fi
    else report 'Xcode Command Line Tools installed; skipping.'; fi
    if need_node; then
      if ((INSTALL_SYSTEM)); then
        command -v brew >/dev/null || { report 'Homebrew required to install Node automatically on macOS.'; exit 1; }
        run brew install node@22
        if ! ((DRY_RUN)); then export PATH="$(brew --prefix node@22)/bin:$PATH"; fi
      else report 'Node >=22 missing. Install using Homebrew or --install-system.'; fi
    else report "Node installed: $(node --version)"; fi
    install_rust
    ;;
  *) report 'This script supports macOS and Debian/Ubuntu Linux. Use bootstrap-desktop.ps1 on Windows.';exit 1;;
esac

if ((INSTALL_NPM)); then
  if ((DRY_RUN)); then
    report 'Would run npm dependency setup for root, desktop UI, and Tauri CLI.'
    if command -v node >/dev/null 2>&1; then run node "$ROOT/tooling/desktop-workflow.mjs" setup --dry-run; fi
  else
    command -v node >/dev/null || { report 'Node not available in this shell. Restart terminal and rerun.'; exit 1; }
    node "$ROOT/tooling/desktop-workflow.mjs" setup
  fi
fi
if command -v node >/dev/null 2>&1; then
  if ((DRY_RUN)); then report 'Doctor available: npm run desktop:doctor';
  else node "$ROOT/tooling/desktop-workflow.mjs" doctor || true; fi
fi
report 'For development: npm run desktop:dev | For installer: npm run desktop:build'
