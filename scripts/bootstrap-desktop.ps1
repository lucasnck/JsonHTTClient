# Windows Tauri 2 bootstrap. No changes to system without -InstallSystem.
[CmdletBinding()]
param(
  [switch]$InstallSystem,
  [switch]$InstallNpm,
  [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Write-Step([string]$Message) { Write-Host "[desktop setup] $Message" }
function Invoke-Step([string]$Command, [string[]]$Arguments) {
  $printable = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  if ($DryRun) { Write-Step "[DRY RUN] $Command $printable"; return }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
function Has-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}
function Node-IsReady {
  if (-not (Has-Command 'node')) { return $false }
  $version = (& node -p 'Number(process.versions.node.split(".")[0])' 2>$null)
  return ([int]$version -ge 22)
}
function Has-VCBuildTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $false }
  $result = & $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath
  return -not [string]::IsNullOrWhiteSpace(($result | Out-String))
}
function Has-WebView2 {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'),
    (Join-Path $env:ProgramFiles 'Microsoft\EdgeWebView\Application')
  )
  foreach($path in $candidates) { if (Test-Path $path) { return $true } }
  return $false
}
function Install-WithWinget([string]$Id, [string[]]$Extra = @()) {
  if (-not $InstallSystem) { Write-Step "$Id missing. Add -InstallSystem to install it."; return }
  if (-not (Has-Command 'winget')) { throw 'winget is required for automatic Windows prerequisites installation. Install App Installer first.' }
  Invoke-Step 'winget' (@('install','--id',$Id,'--exact','--accept-package-agreements','--accept-source-agreements') + $Extra)
}

if (Node-IsReady) {
  Write-Step "Node already present: $(& node --version)"
} else {
  Install-WithWinget 'OpenJS.NodeJS.LTS'
  Write-Step 'If Node was just installed, open a new terminal to refresh PATH before npm setup.'
}

if ((Has-Command 'rustc') -and (Has-Command 'cargo')) {
  Write-Step 'Rust and Cargo already installed; skipping.'
} else {
  Install-WithWinget 'Rustlang.Rustup'
  Write-Step 'After Rustup installs, rustup default stable may be needed; reopen the terminal.'
}

if (Has-VCBuildTools) {
  Write-Step 'MSVC C++ build tools already installed; skipping.'
} else {
  # The C++ workload is required, not merely the Visual Studio installer shell.
  Install-WithWinget 'Microsoft.VisualStudio.2022.BuildTools' @('--override','--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
  Write-Step 'If VS Build Tools already exists without C++, modify it and select Desktop development with C++.'
}

if (Has-WebView2) {
  Write-Step 'Microsoft Edge WebView2 runtime already installed; skipping.'
} else {
  Install-WithWinget 'Microsoft.EdgeWebView2Runtime'
}

if ($InstallNpm) {
  if ($DryRun) {
    Write-Step '[DRY RUN] node tooling/desktop-workflow.mjs setup'
  } elseif (Node-IsReady) {
    & node (Join-Path $Root 'tooling\desktop-workflow.mjs') setup
    if ($LASTEXITCODE -ne 0) { throw 'Desktop npm setup failed.' }
  } else {
    Write-Step 'Node is not yet available on PATH; reopen the terminal, then run npm run desktop:setup.'
  }
}

if (-not $DryRun -and (Node-IsReady)) {
  & node (Join-Path $Root 'tooling\desktop-workflow.mjs') doctor
  # Missing native prerequisites are reported by doctor but do not hide earlier setup results.
}
Write-Step 'When prerequisites are ready: npm run desktop:dev | npm run desktop:build'
