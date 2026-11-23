[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
if ($Version -ne 'latest' -and $Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$releaseBase = if ($Version -eq 'latest') { 'https://github.com/lemonmmice/dsh-agent-toolchain/releases/latest/download' } else { "https://github.com/lemonmmice/dsh-agent-toolchain/releases/download/$Version" }
$downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-setup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadDir | Out-Null
$archive = Join-Path $downloadDir 'dsh-agent-toolchain-win-x64.zip'
try {
    Write-Host 'Downloading the standalone Windows package...'
    Invoke-WebRequest -UseBasicParsing -Uri ($releaseBase + '/dsh-agent-toolchain-win-x64.zip') -OutFile $archive
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($releaseBase + '/dsh-agent-toolchain-win-x64.zip.sha256')).Content
    if ($checksum -notmatch '^([a-fA-F0-9]{64})\s') { throw 'Invalid release checksum.' }
    $expectedHash = $Matches[1]
    $stream = [IO.File]::OpenRead($archive)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
    if ($actualHash -ne $expectedHash) { throw 'Package SHA256 mismatch.' }
    $packageDir = Join-Path $downloadDir 'package'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $packageDir)
    $installArgs = @((Join-Path $packageDir 'scripts\install-client.mjs'))
    if ($NonInteractive) { $installArgs += @('--non-interactive', '--clients', 'all') }
    & (Join-Path $packageDir 'runtime\node.exe') @installArgs
    if ($LASTEXITCODE -ne 0) { throw "Installation failed: $LASTEXITCODE" }
} catch {
    Write-Error ("Standalone installation failed. Confirm this release has the Windows ZIP and SHA256 assets. " + $_.Exception.Message)
    exit 1
}
