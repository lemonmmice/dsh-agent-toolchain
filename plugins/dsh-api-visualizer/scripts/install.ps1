# install.ps1 — install the dsh-agent-toolchain panel plugins into a dsh web profile.
# Installs dsh-api-visualizer (API capture) and dsh-postman (API debug) from this
# monorepo, registers them in the profile's cordis.patch.yml (idempotent), and
# prints the restart hint.
#
# Usage (PowerShell 5+), from the monorepo root:
#   powershell -ExecutionPolicy Bypass -File plugins/dsh-api-visualizer/scripts/install.ps1
#   powershell -ExecutionPolicy Bypass -File plugins/dsh-api-visualizer/scripts/install.ps1 -RepoRoot D:\src\dsh-agent-toolchain
#
# Optional parameters:
#   -RepoRoot <path>    monorepo root (default: two directories up from this script)
#   -ProfileDir <path>  profile root (default: ~\.dsh\profiles\web)
#   -Plugins a,b        subset of plugins to install (default: both)
param(
  [string]$RepoRoot = '',
  [string]$ProfileDir = '',
  [string[]]$Plugins = @('dsh-api-visualizer', 'dsh-postman')
)
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($RepoRoot -eq '') { $RepoRoot = (Split-Path (Split-Path $scriptDir -Parent) -Parent) }

$entries = @{
  'dsh-api-visualizer' = @{ Id = 'api-visualizer'; Name = '@dsh-agent-toolchain/dsh-api-visualizer' }
  'dsh-postman'        = @{ Id = 'postman';        Name = '@dsh-agent-toolchain/dsh-postman' }
}

if ($ProfileDir -eq '') { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web' }
if (-not (Test-Path $ProfileDir)) { throw "dsh profile directory not found: $ProfileDir (install dsh first, or pass -ProfileDir)" }

$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$patchText = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
$registered = @()

foreach ($plugin in $Plugins) {
  if (-not $entries.ContainsKey($plugin)) { Write-Warning "unknown plugin '$plugin' skipped"; continue }
  $src = Join-Path $RepoRoot "plugins\$plugin"
  if (-not (Test-Path $src)) { Write-Warning "plugin source not found: $src"; continue }
  $dest = Join-Path $ProfileDir "node_modules\@dsh-agent-toolchain\$plugin"
  Write-Host "==> $plugin : copying from $src"
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Copy-Item -Path $src -Destination $dest -Recurse -Force
  Write-Host "    installed to $dest"

  if ($patchText -notmatch [regex]::Escape("id: $($entries[$plugin].Id)")) {
    $patchText = $patchText.TrimEnd() + "`n`n- insert:`n    - id: $($entries[$plugin].Id)`n      name: '$($entries[$plugin].Name)'`n"
    $registered += $plugin
    Write-Host "    registered in cordis.patch.yml"
  } else {
    Write-Host "    already registered"
  }
}

if ($registered.Count -gt 0) {
  [System.IO.File]::WriteAllText($patchFile, $patchText, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host 'Done. Restart the dsh web host (dsh web / your launcher), then refresh the page.'
Write-Host 'Sidebar entries: api-visualizer (API capture) and postman (API debug).'
