# ============================================================
# hang-loop.ps1 — 客户端「卡死」监测 + 证据打包（监测模式：不自动点击，用户自行操作）
#
# 原理：循环用 SendMessageTimeout(WM_NULL, SMTO_ABORTIFHUNG, ProbeTimeoutMs) 探测主窗口；
#       窗口在超时内不回应 = 判定卡死，立刻打包证据：
#         frozen-screen.png     冻结瞬间截图（CopyFromScreen，冻结窗口也能拍）
#         process-info.txt      进程 CPU/线程数/Responding/WorkingSet
#         net-trace-tail.txt    客户端网络跟踪日志尾部（有才收）
#         probe-echo.txt        进程内只读探针 echo（有才收）
#         frozen.dmp + procdump.*   完整 dump（面板/分析器按这个名字找）
#         summary.txt           时间线汇总
#
# 为什么这份在**仓库里**（2026-09-11 修）：
#   原先这个脚本只存在于某台机器的本地工具目录（不在仓库、不受版本控制），
#   里面**写死了进程名/客户端 exe/探针路径/输出目录**，而且插件默认只在
#   `~/.dsh-agent-toolchain/` 找它 —— 实测 `hang_run` 直接失败「未找到监测脚本」，
#   也就是"用户报卡死"这条主线在干净环境下**开箱即坏**。
#   现在：脚本进仓库、全部靠参数/环境变量、插件按候选顺序解析并如实回报找过哪些路径。
#
# 参数（都可省，取自环境变量）：
#   -ProcName     客户端进程名      ← DSH_UI_PROC_NAME（必填，否则明确报错）
#   -WindowName   窗口标题（可选，用于挑主窗口）
#   -ClientExe    客户端 exe 全路径  ← DSH_UI_CLIENT_EXE（未运行且允许自启时用）
#   -OutDir       证据根目录        ← DSH_HANG_EVIDENCE_DIR
#   -Procdump     procdump.exe      ← DSH_HANG_PROCDUMP / DSH_PERF_PROCDUMP
#   -UiProbe      进程内探针脚本    ← DSH_HANG_UIPROBE（可选，缺了就不收这项证据）
#   -TraceLog     网络跟踪日志      ← DSH_HANG_TRACELOG（默认 %TEMP%\uiprobe-net-trace.log）
# ============================================================
param(
  [string]$ProcName = '',
  [string]$WindowName = '',
  [string]$ClientExe = '',
  [int]$ProbeTimeoutMs = 2000,
  [int]$IntervalMs = 3000,
  [int]$MaxSeconds = 0,
  [int]$Consecutive = 1,
  [string]$OutDir = '',
  [string]$Procdump = '',
  [string]$UiProbe = '',
  [string]$TraceLog = '',
  [switch]$NoStart,
  [switch]$NoDump
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---- 参数解析（参数 > 环境变量 > 明确报错，绝不写死本机路径）----
if (-not $ProcName) { $ProcName = [string]$env:DSH_UI_PROC_NAME }
if (-not $WindowName) { $WindowName = [string]$env:DSH_UI_WINDOW_NAME }
if (-not $ClientExe) { $ClientExe = [string]$env:DSH_UI_CLIENT_EXE }
if (-not $TraceLog) { $TraceLog = if ($env:DSH_HANG_TRACELOG) { $env:DSH_HANG_TRACELOG } else { Join-Path $env:TEMP 'uiprobe-net-trace.log' } }
if (-not $UiProbe) { $UiProbe = [string]$env:DSH_HANG_UIPROBE }
$toolchainRoot = if ($env:DSH_HANG_UI_DRIVE) { $env:DSH_HANG_UI_DRIVE } else { Join-Path $env:USERPROFILE '.dsh-agent-toolchain' }
if (-not $OutDir) {
  $OutDir = if ($env:DSH_HANG_EVIDENCE_DIR) { $env:DSH_HANG_EVIDENCE_DIR } else { Join-Path $toolchainRoot 'hang-evidence' }
}
if (-not $Procdump) {
  $cand = if ($env:DSH_HANG_PROCDUMP) { $env:DSH_HANG_PROCDUMP } elseif ($env:DSH_PERF_PROCDUMP) { $env:DSH_PERF_PROCDUMP } else { '' }
  if ($cand) { $Procdump = $cand } else { $Procdump = Join-Path $toolchainRoot 'tools\procdump.exe' }
}

if (-not $ProcName) {
  Write-Output 'HANG_MONITOR_ERROR 未指定客户端进程名：请设 -ProcName 或环境变量 DSH_UI_PROC_NAME'
  exit 2
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HangLoopWin32 {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

$global:logLines = New-Object System.Collections.ArrayList
function Log([string]$msg) {
  $line = ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $msg)
  Write-Output $line            # stdout → 插件写进 run.log
  [void]$global:logLines.Add($line)
}

# 窗口是否在 ProbeTimeoutMs 内响应；hwnd=0 视为不响应
function Test-Responsive([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $out = [IntPtr]::Zero
  $r = [HangLoopWin32]::SendMessageTimeout($hwnd, 0, [IntPtr]::Zero, [IntPtr]::Zero, 0x2, [uint32]$ProbeTimeoutMs, [ref]$out)
  return ($r -ne [IntPtr]::Zero)
}

function Save-ScreenShot([IntPtr]$hwnd, [string]$path) {
  try {
    $r = New-Object HangLoopWin32+RECT
    [HangLoopWin32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $false }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $true
  } catch {
    Log ('[证据] 截图异常: ' + $_.Exception.Message)
    return $false
  }
}

# 带超时的子进程调用（窗口冻结时 UIA 可能把调用方也挂住）
function Invoke-Bounded([string]$exe, [string]$file, [string[]]$argsList, [int]$timeoutMs, [string]$outFile, [string]$errFile) {
  try {
    $p = Start-Process -FilePath $exe -ArgumentList (@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$file) + $argsList) -PassThru -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if ($p.WaitForExit($timeoutMs)) { $code = $p.ExitCode } else { $p.Kill(); $p.WaitForExit(); $code = -99 }
  } catch {
    $code = -1
    $null = Set-Content -Path $errFile -Value ('调用失败: ' + $_.Exception.Message) -Encoding UTF8
  }
  $outText = if (Test-Path $outFile) { Get-Content $outFile -Raw } else { '' }
  return @{ Code = $code; Out = $outText }
}

function Get-ClientProcess {
  $all = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
  if ($all.Count -eq 0) { return $null }
  if ($WindowName) {
    $titled = $all | Where-Object { $_.MainWindowTitle -like ('*' + $WindowName + '*') -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($titled) { return $titled }
  }
  $win = $all | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($win) { return $win }
  return $all | Select-Object -First 1
}

function Collect-Evidence([IntPtr]$hwnd, [int]$clientPid, [string]$note) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $OutDir $stamp
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Log ('!! 卡死证据包 -> ' + $dir)

  $shot = Join-Path $dir 'frozen-screen.png'
  if (Save-ScreenShot $hwnd $shot) { Log '[证据] 截图 frozen-screen.png' } else { Log '[证据] 截图失败' }

  $pinfo = Join-Path $dir 'process-info.txt'
  try {
    $proc = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
    if ($proc) {
      @(
        'Name=' + $proc.ProcessName
        'Pid=' + $proc.Id
        'CPU=' + [math]::Round($proc.CPU, 2) + 's'
        'Threads=' + $proc.Threads.Count
        'Responding=' + $proc.Responding
        'WorkingSetMB=' + [math]::Round($proc.WorkingSet64 / 1MB, 1)
        'StartTime=' + $proc.StartTime.ToString('s')
      ) | Set-Content $pinfo -Encoding UTF8
      Log '[证据] 进程信息 process-info.txt'
    } else {
      ('进程 ' + $clientPid + ' 已不在') | Set-Content $pinfo -Encoding UTF8
    }
  } catch {
    ('读取进程信息失败: ' + $_.Exception.Message) | Set-Content $pinfo -Encoding UTF8
  }

  if ($TraceLog -and (Test-Path $TraceLog)) {
    $tail = Join-Path $dir 'net-trace-tail.txt'
    Get-Content $TraceLog -Tail 80 | Set-Content $tail -Encoding UTF8
    Log '[证据] net-trace 尾部 net-trace-tail.txt'
  }

  if ($UiProbe -and (Test-Path $UiProbe)) {
    $echoOut = Join-Path $dir 'probe-echo.txt'
    $echoErr = Join-Path $dir 'probe-echo.err.txt'
    $r = Invoke-Bounded 'powershell.exe' $UiProbe @('-Action', 'echo', '-ProcId', "$clientPid") 30000 $echoOut $echoErr
    Log ('[证据] 进程内探针 echo exit=' + $r.Code)
  } else {
    Log '[证据] 未配置进程内探针（DSH_HANG_UIPROBE），跳过该项'
  }

  if (-not $NoDump) {
    if ($Procdump -and (Test-Path $Procdump)) {
      $dump = Join-Path $dir 'frozen.dmp'
      try {
        $pd = Start-Process -FilePath $Procdump -ArgumentList @('-accepteula', '-ma', "$clientPid", $dump) -PassThru -WindowStyle Hidden `
          -RedirectStandardOutput (Join-Path $dir 'procdump.out.txt') -RedirectStandardError (Join-Path $dir 'procdump.err.txt')
        $pd.WaitForExit(180000) | Out-Null
      } catch {
        Log ('[证据] procdump 调用失败: ' + $_.Exception.Message)
      }
      if (Test-Path $dump) { Log '[证据] 完整 dump frozen.dmp（面板可自动分析托管调用栈）' }
      else { Log '[证据] procdump 未生成 dump，看 procdump.out.txt / procdump.err.txt' }
    } else {
      Log ('[证据] 未找到 procdump（' + $Procdump + '），跳过 dump —— 没有 dump 就拿不到线程栈')
    }
  } else {
    Log '[证据] -NoDump：本次不抓 dump'
  }

  $summary = Join-Path $dir 'summary.txt'
  ('卡死证据包：' + $note + '（窗口 hwnd=' + $hwnd + '，进程 pid=' + $clientPid + '，进程名=' + $ProcName + '）') |
    Set-Content $summary -Encoding UTF8
  ($global:logLines -join [Environment]::NewLine) | Add-Content $summary -Encoding UTF8
  Log '[证据] 汇总 summary.txt'
  Write-Output ('HANG_DETECTED dir=' + $dir)
  return $dir
}

# ---- 主流程 ----
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Log '=== hang-monitor 启动（监测模式：不自动点击，请自行操作客户端）==='
Log ('参数：proc=' + $ProcName + ' window=' + ($(if ($WindowName) { $WindowName } else { '(未指定)' })) + ' probeTimeout=' + $ProbeTimeoutMs + 'ms interval=' + $IntervalMs + 'ms maxSeconds=' + $MaxSeconds)
Log ('证据目录=' + $OutDir)

$proc = Get-ClientProcess
if (-not $proc) {
  if ($NoStart -or -not $ClientExe) {
    Log ('进程 ' + $ProcName + ' 未运行' + $(if ($NoStart) { '（-NoStart）' } else { '且未配置 DSH_UI_CLIENT_EXE' }) + '，退出')
    Write-Output 'HANG_MONITOR_EXIT reason=client-not-running'
    exit 3
  }
  Log '客户端未运行，启动中…'
  try { Start-Process -FilePath $ClientExe -WorkingDirectory (Split-Path $ClientExe) } catch { Log ('启动失败: ' + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds(60)
  while (-not $proc -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; $proc = Get-ClientProcess }
  if (-not $proc) {
    Log '60 秒内未等到客户端进程，退出'
    Write-Output 'HANG_MONITOR_EXIT reason=client-start-timeout'
    exit 3
  }
}
Log ('客户端 pid=' + $proc.Id)
Write-Output ('HANG_MONITOR_TARGET pid=' + $proc.Id)

# 主窗口（Win32；不经过 UIA，卡死时 UIA 会挂）
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(30)
while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  try { $proc.Refresh() } catch { }
  if ($proc.MainWindowHandle -ne 0) { $hwnd = [IntPtr]$proc.MainWindowHandle } else { Start-Sleep -Seconds 2 }
}
if ($hwnd -eq [IntPtr]::Zero) {
  Log '未找到主窗口（可能未登录/启动失败），退出'
  Write-Output 'HANG_MONITOR_EXIT reason=no-main-window'
  exit 3
}
Log ('主窗口 hwnd=' + $hwnd)
Write-Output ('HANG_MONITOR_READY pid=' + $proc.Id + ' hwnd=' + $hwnd)

# 等窗口就绪（刚启动时初始化会忙几秒，别误判）
$readyDeadline = (Get-Date).AddSeconds(60)
$initResp = $false
while (-not $initResp -and (Get-Date) -lt $readyDeadline) {
  $initResp = Test-Responsive $hwnd
  if (-not $initResp) { Start-Sleep -Seconds 2 }
}
if (-not $initResp) {
  Log '启动后主窗口 60 秒内始终无响应 → 按卡死处理'
  [void](Collect-Evidence $hwnd $proc.Id '启动后主窗口 60 秒内始终无响应')
  Write-Output 'HANG_MONITOR_EXIT reason=hang-on-start'
  exit 0
}
Log '主窗口就绪（响应正常），开始监测'

$startedAt = Get-Date
$failStreak = 0
$probes = 0
$hang = $false
$note = ''
while ($true) {
  if ($MaxSeconds -gt 0 -and (((Get-Date) - $startedAt).TotalSeconds -ge $MaxSeconds)) {
    Log ('达到 -MaxSeconds=' + $MaxSeconds + '，正常退出（未检测到卡死）')
    break
  }
  try { $proc.Refresh() } catch { }
  if ($proc.HasExited) {
    Log '客户端进程已退出，结束监测'
    Write-Output 'HANG_MONITOR_EXIT reason=client-exited'
    exit 0
  }
  $probes++
  $resp = Test-Responsive $hwnd
  if ($resp) {
    if ($failStreak -gt 0) { Log ('窗口恢复响应（此前连续 ' + $failStreak + ' 次超时）') }
    $failStreak = 0
  } else {
    $failStreak++
    Log ('!! 探测超时 ' + $ProbeTimeoutMs + 'ms（连续 ' + $failStreak + '/' + $Consecutive + ' 次）')
    if ($failStreak -ge $Consecutive) {
      $hang = $true
      $note = '主窗口连续 ' + $failStreak + ' 次在 ' + $ProbeTimeoutMs + 'ms 内未响应（第 ' + $probes + ' 次探测）'
      break
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}

if ($hang) {
  Log ('判定卡死：' + $note)
  [void](Collect-Evidence $hwnd $proc.Id $note)
  Write-Output 'HANG_MONITOR_EXIT reason=hang-detected'
} else {
  Log ('监测结束（共 ' + $probes + ' 次探测，未发现卡死）')
  Write-Output 'HANG_MONITOR_EXIT reason=max-seconds'
}
exit 0
