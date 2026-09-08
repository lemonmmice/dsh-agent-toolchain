# ============================================================
# perf-probe.ps1 — UI 卡顿监测（dsh-perf 插件）
# 原理：循环 SendMessageTimeout 给主窗口发 WM_NULL，实测处理耗时——
#       窗口空闲时毫秒级返回；UI 线程忙则同步挂起到处理完，
#       实测耗时 ≈ 当前 UI 线程忙碌程度。超过阈值记一次卡顿事件。
# 与 hang-inspector（卡死）区分：本脚本测 500ms~数秒的「卡顿」。
# 用法：
#   powershell -File perf-probe.ps1 -Seconds 60 -ThresholdMs 500 -Capture shot
# ============================================================
param(
  [int]$Seconds = 60,             # 监测时长（秒）
  [int]$ThresholdMs = 500,        # 卡顿判定阈值（毫秒）
  [string]$Capture = 'log',       # log=只记录 | shot=事件时截图 | dump=首次事件抓全dump
  [string]$OutDir = '',
  [int]$IntervalMs = 300,         # 采样间隔（毫秒）
  [int]$ProcId = 0,
  [string]$ProcName = '',
  [string]$WindowName = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PerfProbeWin32 {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$procdump = if ($env:DSH_PERF_PROCDUMP) { $env:DSH_PERF_PROCDUMP } else { $env:DSH_TOOLCHAIN_ROOT + '\tools\procdump.exe' }

# 1. 找进程与主窗口
if ($ProcId -le 0) {
  if (-not $ProcName) { Write-Output 'CLIENT_NOT_RUNNING'; Write-Error '未配置目标进程（DSH_UI_PROC_NAME / -ProcName）'; exit 2 }
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { Write-Output 'CLIENT_NOT_RUNNING'; exit 2 }
  $ProcId = $p.Id
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
# WindowName 为空 = 未配置：取第一个有标题的顶层窗口（主窗口），而不是直接失败
$main = $null
for ($i = 0; $i -lt $wins.Count; $i++) {
  if ($WindowName -and $wins.Item($i).Current.Name -eq $WindowName) { $main = $wins.Item($i); break }
  if (-not $WindowName -and $wins.Item($i).Current.Name) { $main = $wins.Item($i); break }
}
if (-not $main) { Write-Output 'WINDOW_NOT_FOUND'; exit 3 }
$hWnd = [IntPtr]$main.Current.NativeWindowHandle
Write-Output ('TARGET pid=' + $ProcId + ' hwnd=' + $hWnd)

# 2. 证据目录
if (-not $OutDir) { $OutDir = if ($env:DSH_PERF_EVIDENCE_DIR) { $env:DSH_PERF_EVIDENCE_DIR } else { "$env:DSH_TOOLCHAIN_ROOT\perf-evidence" } }
$runDir = Join-Path $OutDir (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
Write-Output ('EVIDENCE_DIR=' + $runDir)

function Save-Screenshot([string]$path) {
  $r = New-Object PerfProbeWin32+RECT
  [PerfProbeWin32]::GetWindowRect($hWnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $true
}

# 3. 监测循环
$samples = New-Object System.Collections.Generic.List[int]
$stutters = New-Object System.Collections.Generic.List[object]
$dumpTaken = $false
$start = Get-Date
$deadline = $start.AddSeconds($Seconds)
$seq = 0

while ((Get-Date) -lt $deadline) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = [IntPtr]::Zero
  # SMTO_ABORTIFHUNG | SMTO_BLOCK = 0x2 | 0x1 = 3；timeout 8 秒兜底（真卡死）
  $null = [PerfProbeWin32]::SendMessageTimeout($hWnd, 0, [IntPtr]::Zero, [IntPtr]::Zero, 3, 8000, [ref]$res)
  $sw.Stop()
  $ms = [int]$sw.ElapsedMilliseconds
  $samples.Add($ms)
  $seq++

  if ($ms -gt $ThresholdMs) {
    $evt = @{ seq = $seq; at = (Get-Date -Format 'HH:mm:ss.fff'); ms = $ms }
    if ($Capture -eq 'shot') {
      $shot = Join-Path $runDir ('stutter-' + $seq + '.png')
      if (Save-Screenshot $shot) { $evt.shot = (Split-Path $shot -Leaf) }
    }
    if ($Capture -eq 'dump' -and -not $dumpTaken) {
      $dump = Join-Path $runDir 'stutter.dmp'
      Start-Process -FilePath $procdump -ArgumentList @('-ma','-accepteula',[string]$ProcId,$dump) -NoNewWindow -Wait
      if (Test-Path $dump) { $evt.dump = (Split-Path $dump -Leaf); $dumpTaken = $true }
    }
    $stutters.Add($evt)
    Write-Output ('STUTTER seq=' + $seq + ' ms=' + $ms + ' at=' + $evt.at)
  }
  if ($seq % 20 -eq 0) { Write-Output ('progress ' + $seq + ' samples, latest ' + $ms + 'ms') }

  $sleep = $IntervalMs - $ms
  if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}

# 4. 统计与报告
$arr = $samples.ToArray()
[Array]::Sort($arr)
$n = $arr.Length
function Percentile([double]$q) {
  $idx = [int][Math]::Floor($q * ($n - 1))
  if ($idx -lt 0) { $idx = 0 }
  if ($idx -ge $n) { $idx = $n - 1 }
  return $arr[$idx]
}
$report = @{
  startedAt = $start.ToString('yyyy-MM-dd HH:mm:ss')
  durationSec = [int]((Get-Date) - $start).TotalSeconds
  pid = $ProcId
  thresholdMs = $ThresholdMs
  capture = $Capture
  samples = $n
  minMs = if ($n -gt 0) { $arr[0] } else { 0 }
  maxMs = if ($n -gt 0) { $arr[$n-1] } else { 0 }
  avgMs = if ($n -gt 0) { [int](($arr | Measure-Object -Average).Average) } else { 0 }
  p50Ms = if ($n -gt 0) { Percentile 0.50 } else { 0 }
  p95Ms = if ($n -gt 0) { Percentile 0.95 } else { 0 }
  p99Ms = if ($n -gt 0) { Percentile 0.99 } else { 0 }
  stutterCount = $stutters.Count
  stutters = @($stutters | Select-Object -First 50)
  evidenceDir = $runDir
}
$reportPath = Join-Path $runDir 'report.json'
$json = $report | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($reportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('DONE report=' + $reportPath + ' samples=' + $n + ' stutters=' + $stutters.Count + ' max=' + $report.maxMs + 'ms p95=' + $report.p95Ms + 'ms')
