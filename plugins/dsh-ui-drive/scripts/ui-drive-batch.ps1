# ============================================================
# ui-drive-batch.ps1 — 批量 UIA 驱动（单进程执行多步，PowerShell 5.1 兼容）
#
# 为什么存在：单步脚本每步都要新起一个 PowerShell 进程、重新 Add-Type 五个程序集、
# 重新遍历整棵 UIA 树，实测每步 1.5-3 秒；ui_flow 有 N 步就付 N 次进程启动代价。
# 本脚本把整个步骤序列交给一个进程，程序集只加载一次、主窗口只解析一次、
# 步间不留进程启动开销，实测每步降到 100-400ms。
#
# 用法（cwd 无关，绝对路径调用）：
#   & 'ui-drive-batch.ps1' -ProcName MyClient -WindowName '主窗口' -StepsFile steps.json
#   & 'ui-drive-batch.ps1' -ProcId 1234 -StepsFile steps.json -Out result.json
#
# steps.json：一个 JSON 数组，每步 {action, name?, aid?, value?, ascii?, match?,
#   waitMs?, out?, expectEnabled?, expectMatch?}；action ∈ find|click|setvalue|key|
#   read|shot|wait|expect。
# 输出：stdout 打印一行 RESULT_JSON=<json>，同时写 -Out 指定的文件。
# 结果数组每项：{step, action, ok, ...}，与 ui_drive 单步返回的字段保持一致，
# 便于 driver 侧统一消费。任一步失败不中断（由调用方决定 failFast）。
# ============================================================
param(
  [string]$ProcName = '',
  [string]$WindowName = '',
  [int]$ProcId = 0,
  [string]$StepsFile = '',
  [string]$Out = '',
  [int]$DefaultWaitMs = 250,
  [switch]$Status,
  [switch]$Serve
)

# ------------------------------------------------------------ status 快路径
# 只要进程/主窗口句柄与矩形时，绝不加载 UIA（省掉 ~600ms 程序集初始化）。
# 供 driver.status() 使用：ui_status / ui_launch 轮询都走这里。
if ($Status) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UiDriveStatusWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
  $sp = $null
  if ($ProcId -gt 0) { $sp = Get-Process -Id $ProcId -ErrorAction SilentlyContinue }
  elseif ($ProcName) { $sp = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $sp) { Write-Output 'NOT_RUNNING'; exit 2 }
  $h = $sp.MainWindowHandle
  if (-not $h -or $h -eq [IntPtr]::Zero) { Write-Output ('RUNNING pid=' + $sp.Id + ' window=NONE'); exit 0 }
  Write-Output ('RUNNING pid=' + $sp.Id + ' window=' + $sp.MainWindowTitle)
  Write-Output ('HANDLE ' + [int64]$h)
  $r = New-Object UiDriveStatusWin32+RECT
  [UiDriveStatusWin32]::GetWindowRect([IntPtr]$h, [ref]$r) | Out-Null
  Write-Output ('RECT ' + ($r.Right - $r.Left) + 'x' + ($r.Bottom - $r.Top) + ' @' + $r.Left + ',' + $r.Top)
  exit 0
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UiDriveBatchWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$UIA = [System.Windows.Automation.AutomationElement]

function Get-ClientPid {
  if ($ProcId -gt 0) { return $ProcId }
  if (-not $ProcName) { throw '未指定目标进程（-ProcName 或 -ProcId 至少一个）' }
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { return $p.Id }
  throw ($ProcName + ' 进程未运行')
}

function Get-MainWindow([int]$procId) {
  $root = $UIA::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, $procId)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $first = $null
  for ($i = 0; $i -lt $wins.Count; $i++) {
    $w = $wins.Item($i)
    if (-not $first) { $first = $w }
    if ($WindowName -and $w.Current.Name -eq $WindowName) { return $w }
    if (-not $WindowName -and $w.Current.Name) { return $w }
  }
  return $first
}

function Get-ControlTypeName($el) {
  return $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
}

# UIA 原生 FindAll：单条件（aid 或 name）交给 UIA，双条件用 AndCondition，
# 不再手写遍历整棵树的循环——这是单步脚本里最大的开销来源。
function Find-Element($main, [string]$aid, [string]$name) {
  $conds = @()
  if ($aid) { $conds += (New-Object System.Windows.Automation.PropertyCondition($UIA::AutomationIdProperty, $aid)) }
  if ($name) { $conds += (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $name)) }
  if ($conds.Count -eq 0) { throw 'find 需要 -Aid 或 -Name' }
  if ($conds.Count -eq 1) { $cond = $conds[0] }
  else {
    $arr = New-Object 'System.Windows.Automation.Condition[]' $conds.Count
    for ($i = 0; $i -lt $conds.Count; $i++) { $arr[$i] = $conds[$i] }
    $cond = New-Object System.Windows.Automation.AndCondition($arr)
  }
  $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  for ($i = 0; $i -lt $all.Count; $i++) {
    $el = $all.Item($i)
    if ($el.Current.IsOffscreen) { continue }
    return $el
  }
  return $null
}

function Get-ElementDetail($el) {
  $b = $el.Current.BoundingRectangle
  return ('[' + (Get-ControlTypeName $el) + '] name="' + $el.Current.Name + '" aid="' + $el.Current.AutomationId + '" enabled=' + $el.Current.IsEnabled + ' @' + [int]$b.X + ',' + [int]$b.Y + ' ' + [int]$b.Width + 'x' + [int]$b.Height)
}

function Invoke-Click($el) {
  try {
    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
    return 'invoke'
  } catch {
    $b = $el.Current.BoundingRectangle
    $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
    [UiDriveBatchWin32]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 120
    [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    return ('mouse@' + $cx + ',' + $cy)
  }
}

function Set-ElementValue($el, [string]$value) {
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($value)
    return $vp.Current.Value
  } catch {
    throw ('该控件不支持 ValuePattern: ' + $_.Exception.Message)
  }
}

function Send-KeyTo($el, [string]$value, [bool]$ascii, [int]$waitMs) {
  $b = $el.Current.BoundingRectangle
  [UiDriveBatchWin32]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2))
  Start-Sleep -Milliseconds 150
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  if ($ascii) {
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait($value)
  } else {
    Set-Clipboard -Value $value
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  Start-Sleep -Milliseconds $waitMs
}

function Save-Shot($main, [string]$outPath) {
  if (-not $outPath) { $outPath = Join-Path $env:TEMP ('uia-shot-' + (Get-Date -Format 'HHmmss') + '.png') }
  $dir = Split-Path -Parent $outPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $h = [IntPtr]$main.Current.NativeWindowHandle
  $r = New-Object UiDriveBatchWin32+RECT
  [UiDriveBatchWin32]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) { throw ('窗口尺寸非法 ' + $w + 'x' + $hh) }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return @{ path = $outPath; w = $w; h = $hh }
}

# ------------------------------------------------------------ 单步执行

function Invoke-Step($main, $step, [int]$index) {
  $action = [string]$step.action
  $waitMs = $DefaultWaitMs
  if ($step.PSObject.Properties.Name -contains 'waitMs' -and $null -ne $step.waitMs) { $waitMs = [int]$step.waitMs }
  $res = @{ step = ($index + 1); action = $action; ok = $false }
  try {
    switch ($action) {
      'wait' {
        $ms = [Math]::Min([Math]::Max($waitMs, 50), 30000)
        Start-Sleep -Milliseconds $ms
        $res.ok = $true; $res.waitedMs = $ms
      }
      'find' {
        $el = Find-Element $main ([string]$step.aid) ([string]$step.name)
        $res.ok = $true
        if ($el) { $res.found = $true; $res.detail = (Get-ElementDetail $el) }
        else { $res.found = $false }
      }
      'expect' {
        $el = Find-Element $main ([string]$step.aid) ([string]$step.name)
        $res.ok = ($null -ne $el); $res.found = ($null -ne $el)
        if ($el) {
          $detail = Get-ElementDetail $el
          $res.detail = $detail
          $enM = $detail -match 'enabled=(True|False)'
          $enabled = $null
          if ($enM) { $enabled = ($matches[1] -eq 'True') }
          $res.enabled = $enabled
          $reasons = @()
          if (($step.PSObject.Properties.Name -contains 'expectEnabled') -and $null -ne $step.expectEnabled) {
            $want = [bool]$step.expectEnabled
            if ($enabled -ne $want) { $res.ok = $false; $reasons += ('enabled=' + $enabled + ' 期望 ' + $want) }
          }
          if (($step.PSObject.Properties.Name -contains 'expectMatch') -and $step.expectMatch) {
            if ($detail -notmatch [string]$step.expectMatch) { $res.ok = $false; $reasons += ('name 不匹配 /' + $step.expectMatch + '/') }
          }
          if ($reasons.Count -gt 0) { $res.reasons = ($reasons -join '; ') }
        }
      }
      'click' {
        $el = Find-Element $main ([string]$step.aid) ([string]$step.name)
        if (-not $el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $how = Invoke-Click $el
          Start-Sleep -Milliseconds $waitMs
          $res.ok = $true; $res.output = ('CLICKED "' + $el.Current.Name + '" via ' + $how)
        }
      }
      'setvalue' {
        $el = Find-Element $main ([string]$step.aid) ([string]$step.name)
        if (-not $el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $v = Set-ElementValue $el ([string]$step.value)
          Start-Sleep -Milliseconds $waitMs
          $res.ok = $true; $res.output = ('SET "' + $step.value + '" -> "' + $v + '"')
        }
      }
      'key' {
        $el = Find-Element $main ([string]$step.aid) ([string]$step.name)
        if (-not $el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          Send-KeyTo $el ([string]$step.value) ([bool]$step.ascii) $waitMs
          $res.ok = $true; $res.output = ('KEYED "' + $step.value + '" into ' + $el.Current.AutomationId)
        }
      }
      'read' {
        $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $match = [string]$step.match
        $lines = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $all.Count; $i++) {
          $el = $all.Item($i)
          if ($el.Current.IsOffscreen) { continue }
          $t = Get-ControlTypeName $el
          if ($t -notin @('Button', 'Edit', 'Text', 'RadioButton', 'CheckBox', 'TabItem', 'ComboBox')) { continue }
          $n = $el.Current.Name
          if (-not $n) { $n = '' }
          if ($n.Length -gt 60) { $n = $n.Substring(0, 60) }
          if ($match -and $n -notmatch $match) { continue }
          $b = $el.Current.BoundingRectangle
          [void]$lines.Add('[' + $t + '] "' + $n + '" aid="' + $el.Current.AutomationId + '" enabled=' + $el.Current.IsEnabled + ' @' + [int]$b.X + ',' + [int]$b.Y)
        }
        $res.ok = $true; $res.count = $lines.Count; $res.lines = $lines
      }
      'shot' {
        $s = Save-Shot $main ([string]$step.out)
        $res.ok = $true; $res.path = $s.path; $res.w = $s.w; $res.h = $s.h
      }
      default {
        $res.error = '非法动作 ' + $action
      }
    }
  } catch {
    $res.ok = $false
    $res.error = $_.Exception.Message
  }
  return $res
}

# ------------------------------------------------------------ 主流程

function AsciiJson($obj) {
  # 协议层强制 ASCII：非 ASCII 全部转成 \uXXXX。
  # 这样 stdout 完全 ASCII，Node 侧不用猜 GBK/UTF-8，中文也不会变问号。
  $j = $obj | ConvertTo-Json -Depth 10 -Compress
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $j.Length; $i++) {
    $ch = $j[$i]
    $code = [int][char]$ch
    if ($code -lt 128) { [void]$sb.Append($ch) }
    else { [void]$sb.AppendFormat('\u{0:x4}', $code) }
  }
  return $sb.ToString()
}

# ------------------------------------------------------------ serve 模式（常驻进程）
# 为什么存在：每次动作新起一个 PowerShell 进程要付 ~400ms 固定成本（进程启动 +
# 脚本解析 + 5 个程序集加载）。常驻进程把这份成本只付一次，之后每个动作只付
# UIA 调用本身（实测 30-150ms），这才叫「实时点控件」。
#
# 协议（stdin/stdout 各一行一条，全部 ASCII）：
#   请求  {"action":"find","name":"..."} | {"cmd":"status"} | {"cmd":"reload"} | {"cmd":"ping"}
#   响应  {"id":<n>,"ok":true,...}  失败 {"id":<n>,"ok":false,"error":"..."}
# 输出前缀 RESP_JSON= 便于 Node 侧按行识别；非 ASCII 用 \uXXXX 转义。
if ($Serve) {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
  $main = $null
  $procId = 0
  $seq = 0
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $seq++
    $resp = @{ id = $seq; ok = $false }
    try {
      $req = $line | ConvertFrom-Json
      $cmd = 'step'
      if ($req.PSObject.Properties.Name -contains 'cmd' -and $req.cmd) { $cmd = [string]$req.cmd }
      switch ($cmd) {
        'ping' { $resp.ok = $true; $resp.pong = $true }
        'reload' {
          $main = $null; $procId = 0
          $resp.ok = $true; $resp.reloaded = $true
        }
        'status' {
          $sp = $null
          if ($ProcId -gt 0) { $sp = Get-Process -Id $ProcId -ErrorAction SilentlyContinue }
          elseif ($ProcName) { $sp = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1 }
          if (-not $sp) { $resp.error = 'NOT_RUNNING' }
          else {
            $resp.ok = $true; $resp.pid = $sp.Id; $resp.window = $sp.MainWindowTitle
            $resp.handle = [int64]$sp.MainWindowHandle
          }
        }
        default {
          if (-not $main) {
            $procId = Get-ClientPid
            $main = Get-MainWindow $procId
            if (-not $main) { throw ('未找到主窗口（' + $WindowName + '）') }
            [UiDriveBatchWin32]::ShowWindow([IntPtr]$main.Current.NativeWindowHandle, 9) | Out-Null
            [UiDriveBatchWin32]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle) | Out-Null
            Start-Sleep -Milliseconds 150
          }
          $res = Invoke-Step $main $req 0
          $res.Remove('step') | Out-Null
          $stepOk = ($res['ok'] -eq $true)
          foreach ($k in $res.Keys) { $resp[$k] = $res[$k] }
          $resp.ok = $stepOk
        }
      }
    } catch {
      # 窗口可能已关闭：下一轮重新解析主窗口
      $main = $null
      $resp.ok = $false
      $resp.error = $_.Exception.Message
    }
    $writer.WriteLine('RESP_JSON=' + (AsciiJson $resp))
  }
  exit 0
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$steps = @()
if ($StepsFile) {
  if (-not (Test-Path $StepsFile)) { throw ('步骤文件不存在: ' + $StepsFile) }
  $raw = Get-Content -Raw -Encoding UTF8 $StepsFile
  # 注意：PS 5.1 里 @($x | ConvertFrom-Json) 会把整个数组再包成单元素数组
  # （$steps[0] 变成 Object[]，$steps[0].action 退化成整串拼接），必须用 @((...))。
  $steps = @(($raw | ConvertFrom-Json))
}
if ($steps.Count -eq 0) { throw '步骤为空' }
if ($env:UI_DRIVE_BATCH_DEBUG) { Write-Host ('DBG steps=' + $steps.Count + ' type=' + $steps.GetType().Name + ' a0=' + $steps[0].action) }

$procId = Get-ClientPid
$main = Get-MainWindow $procId
if (-not $main) { throw ('未找到主窗口（' + $WindowName + '）' ) }
[UiDriveBatchWin32]::ShowWindow([IntPtr]$main.Current.NativeWindowHandle, 9) | Out-Null
[UiDriveBatchWin32]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 200

$results = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $steps.Count; $i++) {
  [void]$results.Add((Invoke-Step $main $steps[$i] $i))
}
$sw.Stop()

$payload = @{ ok = $true; steps = $results; elapsedMs = [int]$sw.ElapsedMilliseconds; pid = $procId; window = $main.Current.Name }
$json = $payload | ConvertTo-Json -Depth 8 -Compress
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output ('RESULT_JSON=' + $json)
