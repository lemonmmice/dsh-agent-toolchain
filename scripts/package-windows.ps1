[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string]$NodeVersion = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot '.dsh-agent-toolchain\dist' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package targets Windows x64.' }

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit $LASTEXITCODE" }
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

Push-Location $repoRoot
try {
    if (-not $SkipBuild) {
        Invoke-Checked 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-Checked 'npm.cmd' @('ci', '--prefix', 'mcp', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        foreach ($build in @('build:capture-store', 'build:memory-store', 'build:trace-fold', 'build:terminal-inspector')) {
            Invoke-Checked 'npm.cmd' @('run', $build)
        }
        $publishTargets = @(
            @{ Project = 'tools/dumpstack/DumpStack.csproj'; Rid = 'win-x86'; Output = 'tools/dumpstack/publish-x86' },
            @{ Project = 'plugins/dsh-perf/tools/heaproots/HeapRoots.csproj'; Rid = 'win-x86'; Output = 'tools/heaproots/publish-x86' },
            @{ Project = 'plugins/dsh-perf/tools/uifreeze/UiFreezeStacks.csproj'; Rid = 'win-x64'; Output = 'plugins/dsh-perf/bin/uifreeze' }
        )
        foreach ($target in $publishTargets) {
            Invoke-Checked 'dotnet' @('publish', $target.Project, '-c', 'Release', '-r', $target.Rid, '--self-contained', 'true', '-o', $target.Output)
        }
    }
    $required = @(
        'plugins/dsh-api-visualizer/bin/win32-x64',
        'plugins/dsh-memory/bin/win32-x64',
        'plugins/dsh-perf/bin/win32-x64',
        'plugins/dsh-win-terminal-inspector/bin/win32-x64',
        'tools/dumpstack/publish-x86/DumpStack.exe',
        'tools/heaproots/publish-x86/HeapRoots.exe',
        'plugins/dsh-perf/bin/uifreeze/UiFreezeStacks.exe'
    )
    foreach ($relativePath in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $relativePath))) { throw "Build artifact missing: $relativePath" }
    }
    $buildId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stage = Join-Path $OutputDirectory $buildId
    New-Item -ItemType Directory -Path $stage | Out-Null
    $files = & git -c core.quotepath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'git file inventory failed' }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    foreach ($relativePath in $files) {
        if ($relativePath -notmatch '^(lib/|mcp/|plugins/|skills/|hooks/|scripts/lib/|scripts/install-client\.mjs$|docs/|README\.md$|LICENSE$|package(-lock)?\.json$|setup\.cmd$)') { continue }
        if ($relativePath -match '(^|/)(node_modules|target|bin|obj|publish[^/]*)(/|$)') { continue }
        $destination = Join-Path $stage $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot $relativePath) -Destination $destination
    }
    $artifactDirectories = @(
        'plugins/dsh-api-visualizer/bin/win32-x64',
        'plugins/dsh-memory/bin/win32-x64',
        'plugins/dsh-perf/bin/win32-x64',
        'plugins/dsh-win-terminal-inspector/bin/win32-x64',
        'plugins/dsh-perf/bin/uifreeze',
        'tools/dumpstack/publish-x86',
        'tools/heaproots/publish-x86'
    )
    foreach ($relativePath in $artifactDirectories) {
        $destination = Join-Path $stage $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        $artifactRoot = Join-Path $repoRoot $relativePath
        foreach ($artifact in (Get-ChildItem -LiteralPath $artifactRoot -Recurse -File)) {
            if ($artifact.Extension -eq '.pdb') { continue }
            $artifactRelative = $artifact.FullName.Substring($artifactRoot.Length).TrimStart('\')
            $artifactDestination = Join-Path $destination $artifactRelative
            New-Item -ItemType Directory -Path (Split-Path -Parent $artifactDestination) -Force | Out-Null
            Copy-Item -LiteralPath $artifact.FullName -Destination $artifactDestination
        }
    }
    Invoke-Checked 'npm.cmd' @('ci', '--prefix', $stage, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
    Invoke-Checked 'npm.cmd' @('ci', '--prefix', (Join-Path $stage 'mcp'), '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
    if (-not $NodeVersion) {
        $versions = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
        $NodeVersion = ($versions | Where-Object { $_.version -match '^v24\.' -and $_.lts } | Select-Object -First 1).version
    }
    if ($NodeVersion -notmatch '^v24\.\d+\.\d+$') { throw 'Expected an official Node.js 24 LTS version.' }
    $nodeName = "node-$NodeVersion-win-x64"
    $nodeZip = Join-Path $OutputDirectory ($nodeName + '.zip')
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
    $checksumLine = $checksums -split "\r?\n" | Where-Object { $_ -match ("  " + [regex]::Escape($nodeName + '.zip') + '$') } | Select-Object -First 1
    if (-not $checksumLine) { throw 'Node archive checksum was not published.' }
    $expectedHash = ($checksumLine -split '\s+')[0]
    if (-not (Test-Path -LiteralPath $nodeZip)) { Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/$nodeName.zip" -OutFile $nodeZip }
    if ((Get-Sha256 $nodeZip) -ne $expectedHash) { throw 'Node archive SHA256 mismatch.' }
    $nodeExtract = Join-Path $OutputDirectory ('runtime-' + $buildId)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $nodeExtract)
    $runtime = Join-Path $stage 'runtime'
    New-Item -ItemType Directory -Path $runtime | Out-Null
    foreach ($name in @('node.exe', 'LICENSE', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $nodeExtract $nodeName) $name) -Destination (Join-Path $runtime $name)
    }
    $manifest = @{ format = 1; buildId = $buildId; platform = 'win32-x64'; nodeVersion = $NodeVersion; sourceCommit = (& git rev-parse HEAD); selfContainedAnalyzers = $true }
    [IO.File]::WriteAllText((Join-Path $stage 'standalone-manifest.json'), ($manifest | ConvertTo-Json), $utf8NoBom)
    $zipPath = Join-Path $OutputDirectory 'dsh-agent-toolchain-win-x64.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $zipPath) { throw "Output already exists. Choose a new -OutputDirectory: $zipPath" }
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $zipHash = Get-Sha256 $zipPath
    [IO.File]::WriteAllText(($zipPath + '.sha256'), "$zipHash  dsh-agent-toolchain-win-x64.zip`n", $utf8NoBom)
    Write-Host "Package: $zipPath"
    Write-Host "Stage: $stage"
} finally {
    Pop-Location
}
