# ============================================================
# ui-probe.ps1 — 进程内只读诊断探针（复用 Snoop 的通用 CLR 注入器）
# 用法：
#   & '...\scripts\ui-probe.ps1' -Action echo
#   & '...\scripts\ui-probe.ps1' -Action dump-tree -MaxDepth 6
#   & '...\scripts\ui-probe.ps1' -Action run-script -Script 'C:\Temp\my.ps1'
#   & '...\scripts\ui-probe.ps1' -Action dump-tree -ProcId 12345
# 结果打印到 stdout（注入器日志 + 探针结果文件）。
# 注意：本环境 PowerShell 的 "&" 启动原生 exe 不可靠，统一走 Start-Process。
# ============================================================
param(
  [int]$ProcId = 0,
  [string]$Action = 'echo',
  [string]$Script = '',
  [int]$MaxDepth = 8,
  [string]$ProcName = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$skillRoot = Split-Path $PSScriptRoot -Parent   # 插件目录（probe\UiProbe.cs 在插件根下）
$snoop = $env:DSH_SNOOP_DIR   # Snoop 注入器目录（环境变量指定）
$csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
$refAsm = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.5.2'
$tmpRoot = [System.IO.Path]::GetTempPath()
if (-not (Test-Path $refAsm)) { $refAsm = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.0' }
if (-not (Test-Path $csc)) { throw '未找到 csc.exe' }
if (-not (Test-Path $snoop)) { throw '未找到 Snoop 目录: ' + $snoop }

function Read-FileBytes($path) {
  if (-not (Test-Path $path)) { return '' }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  return [System.Text.Encoding]::GetEncoding(936).GetString($bytes)
}

# 1. 目标进程
if ($ProcId -le 0) {
  if (-not $ProcName) { $ProcName = $env:DSH_UI_PROC_NAME }
  if (-not $ProcName) { throw '未指定目标进程（-ProcId 或 -ProcName，或用环境变量 DSH_UI_PROC_NAME）' }
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { throw ('进程未运行: ' + $ProcName) }
  $ProcId = $p.Id
}
Write-Output ('TARGET PID=' + $ProcId)

# 清理历史探针目录（被客户端进程锁住的删不掉，静默跳过）
Get-ChildItem $tmpRoot -Directory -Filter 'uiprobe-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 2. 编译探针（csc 响应文件方式）
$guid = [guid]::NewGuid().ToString('N').Substring(0,8)
$binDir = Join-Path $tmpRoot ('uiprobe-' + $guid)
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dll = Join-Path $binDir ('UiProbe-' + $guid + '.dll')   # 程序集名唯一，避免 LoadFrom 上下文按标识命中旧副本
$refs = @(
  (Join-Path $refAsm 'PresentationFramework.dll'),
  (Join-Path $refAsm 'PresentationCore.dll'),
  (Join-Path $refAsm 'WindowsBase.dll'),
  (Join-Path $refAsm 'System.Xaml.dll'),
  (Join-Path $snoop 'net452\System.Management.Automation.dll')
)
$src = Join-Path $skillRoot 'probe\UiProbe.cs'
$rsp = Join-Path $tmpRoot 'uiprobe.rsp'
$rspLines = @('/nologo', '/target:library', '/platform:anycpu', ('/r:"' + ($refs -join '","') + '"'), ('/out:"' + $dll + '"'), ('"' + $src + '"'))
[System.IO.File]::WriteAllLines($rsp, $rspLines, (New-Object System.Text.UTF8Encoding($false)))
$cscOut = Join-Path $tmpRoot 'uiprobe-csc-out.txt'
$cscErr = Join-Path $tmpRoot 'uiprobe-csc-err.txt'
Remove-Item $cscOut, $cscErr -ErrorAction SilentlyContinue
$pCsc = Start-Process -FilePath $csc -ArgumentList ('@' + $rsp) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $cscOut -RedirectStandardError $cscErr
if ($pCsc.ExitCode -ne 0) {
  Write-Output ('CSC_EXIT=' + $pCsc.ExitCode)
  Write-Output (Read-FileBytes $cscOut)
  Write-Output (Read-FileBytes $cscErr)
  throw 'csc 编译失败'
}
Copy-Item (Join-Path $snoop 'net452\System.Management.Automation.dll') $binDir -Force
Write-Output ('PROBE DLL=' + $dll)

# 3. 载荷文件（第0行=结果路径；第1行=动作；第2行=参数）
$payload = Join-Path $tmpRoot 'uiprobe-payload.txt'
$result  = Join-Path $tmpRoot 'uiprobe-result.txt'
Remove-Item $result -ErrorAction SilentlyContinue
$lines = @($result, $Action)
if ($Action -eq 'dump-tree') { $lines += [string]$MaxDepth }
if ($Action -eq 'hook-net') { $lines += (Join-Path $tmpRoot 'uiprobe-net.log') }
if ($Action -eq 'run-script') {
  if (-not $Script -or -not (Test-Path $Script)) { throw 'run-script 需要 -Script <存在的.ps1路径>' }
  $lines += $Script
}
[System.IO.File]::WriteAllLines($payload, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))

# 4. 注入执行
$inj = Join-Path $snoop 'Snoop.InjectorLauncher.x86.exe'
$injOut = Join-Path $tmpRoot 'uiprobe-inj-out.txt'
$injErr = Join-Path $tmpRoot 'uiprobe-inj-err.txt'
Remove-Item $injOut, $injErr -ErrorAction SilentlyContinue
$pInj = Start-Process -FilePath $inj -ArgumentList @('--targetPID', [string]$ProcId, '--assembly', $dll, '--className', 'UiProbe.Entry', '--methodName', 'Run', '--settingsFile', $payload, '--attachConsoleToParent') -NoNewWindow -Wait -PassThru -RedirectStandardOutput $injOut -RedirectStandardError $injErr
Write-Output ('INJECT_EXIT=' + $pInj.ExitCode)
Write-Output '--- INJECTOR LOG ---'
Write-Output (Read-FileBytes $injOut)
Write-Output (Read-FileBytes $injErr)

# 5. 输出结果
if (Test-Path $result) {
  Write-Output '--- RESULT ---'
  Get-Content $result -Encoding UTF8 -Raw
} else {
  Write-Output '--- NO RESULT FILE ---'
}
