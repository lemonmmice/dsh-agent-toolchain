# install.ps1 — put this toolchain's plugins into a live DSH profile, then report readiness.
#
# This is a thin wrapper, on purpose: scripts/deploy-plugins.mjs is the supported
# copy path (it knows the plugin/lib layout and validates the native binaries
# before copying anything). This script adds the two things a first-time user
# needs around it — a dry run you can read, and a "what do I do next" summary.
#
# Dry run by default. Nothing is copied until you pass -Apply.
#
# Usage:
#   pwsh -File install.ps1                       # dry run: how far off is the profile?
#   pwsh -File install.ps1 -Apply                # copy plugins + lib into the profile
#   pwsh -File install.ps1 -Profile D:\dsh\profiles\web
#   pwsh -File install.ps1 -Apply -Only dsh-build
#
# After -Apply: register the plugins in the profile's cordis.patch.yml and
# restart the host. Then run `npm run demo` to see the loop end to end.

[CmdletBinding()]
param(
  [string]$Profile = '',
  [switch]$Apply,
  [string]$Only = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Write-Head($text) { Write-Host ''; Write-Host "== $text" }

Write-Head 'dsh-agent-toolchain installer'
Write-Host "repo root : $repoRoot"

# --- node -------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'node not found on PATH. Install Node.js 20+ first.' -ForegroundColor Red
  exit 2
}
Write-Host "node      : $($node.Source) ($(node --version))"

# --- profile ----------------------------------------------------------------
if (-not $Profile) {
  if ($env:DSH_PROFILE_DIR) { $Profile = $env:DSH_PROFILE_DIR }
  elseif ($env:DSH_HOME) { $Profile = Join-Path $env:DSH_HOME 'profiles\web' }
  else { $Profile = Join-Path $HOME '.dsh\profiles\web' }
}
Write-Host "profile   : $Profile"

if (-not (Test-Path $Profile)) {
  Write-Host 'profile dir does not exist yet. Start the DSH host once, or pass -Profile <dir>.' -ForegroundColor Red
  exit 2
}

$patch = Join-Path $Profile 'cordis.patch.yml'
$mode = if ($Apply) { 'apply' } else { 'dry run (add -Apply to copy)' }
Write-Host "mode      : $mode"
Write-Host "patch file: $(if (Test-Path $patch) { 'found' } else { 'NOT found - plugins will not load until it references them' })"

# --- deploy -----------------------------------------------------------------
Write-Head 'deploy'
$deployArgs = @((Join-Path $repoRoot 'scripts\deploy-plugins.mjs'), '--profile', $Profile)
if (-not $Apply) { $deployArgs += '--check' }
if ($Only) { $deployArgs += @('--only', $Only) }

& node @deployArgs
$deployExit = $LASTEXITCODE

# --- native modules ---------------------------------------------------------
Write-Head 'native modules'
$native = @(
  @{ name = 'trace-fold (dsh-perf flame folding)'; cmd = 'npm run build:trace-fold' },
  @{ name = 'memory-store (dsh-memory index/search)'; cmd = 'npm run build:memory-store' },
  @{ name = 'capture-store (capture storage, shared by panel/MCP/verify)'; cmd = 'npm run build:capture-store' },
  @{ name = 'terminal-inspector (win32 process table)'; cmd = 'npm run build:terminal-inspector' }
)
foreach ($n in $native) {
  Write-Host ("  {0,-58} {1}" -f $n.name, $n.cmd)
}
Write-Host '  (needs Rust + MSVC build tools; skip any whose plugin you do not use)'

# --- next steps -------------------------------------------------------------
Write-Head 'next'
Write-Host '  1. register the plugins in the profile cordis.patch.yml (see README "Install")'
Write-Host '  2. restart the DSH host'
Write-Host '  3. npm run demo        # build -> drive a real window -> read it -> verdict'
Write-Host '  4. ask the agent for toolchain_status to see what is configured'

if ($deployExit -ne 0) {
  Write-Host ''
  Write-Host "deploy-plugins.mjs exited $deployExit (see its output above)." -ForegroundColor Yellow
}
exit $deployExit
