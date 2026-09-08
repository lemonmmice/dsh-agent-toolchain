# ============================================================
# pc-client-ui-drive 通用 UIA 驱动助手（PowerShell 5.1 兼容）
# 用途：程序化操作目标桌面客户端——找控件/点击/输入/读状态/截图。
# 用法（cwd 无关，绝对路径调用）：
#   & 'C:\path\to\ui-drive.ps1' -Action find  -Pid 15856 -Name '生成回测'
#   & '...ui-drive.ps1' -Action click -Name '生成回测'
#   & '...ui-drive.ps1' -Action setvalue -Aid 'StrategyNameInput' -Value '测试策略01'
#   & '...ui-drive.ps1' -Action read -Match '保存|回测'
#   & '...ui-drive.ps1' -Action shot -Out 'C:\Temp\shot.png'
#   & '...ui-drive.ps1' -Action key -Aid 'PART_TextBox' -Value '600519' -Ascii
# 规则：只操作 IsOffscreen=false 的元素；每次动作前重新定位。
# ============================================================
param(
  [string]$Action = 'read',     # find | click | setvalue | read | shot | key
  [int]$ProcId = 0,                # 0 = 自动找进程
  [string]$ProcName = '',             # 目标进程名（driver 总是显式传入）
  [string]$WindowName = '',
  [string]$Aid = '',            # AutomationId
  [string]$Name = '',           # Name
  [string]$Value = '',          # setvalue/key 的内容
  [switch]$Ascii,               # key 模式用 ASCII（否则走剪贴板粘贴，适合中文）
  [string]$Match = '',          # read 模式的正则过滤
  [string]$Out = '',            # shot 输出路径
  [int]$WaitMs = 1200
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UiDriveWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-ClientPid {
  if ($ProcId -gt 0) { return $ProcId }
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { return $p.Id }
  throw ($ProcName + ' 进程未运行')
}

function Get-MainWindow([int]$procId) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  # WindowName empty = not configured: take the first NAMED top-level window
  # (the main window), else the first window, instead of failing.
  $first = $null
  for ($i = 0; $i -lt $wins.Count; $i++) {
    $w = $wins.Item($i)
    if (-not $first) { $first = $w }
    if ($WindowName -and $w.Current.Name -eq $WindowName) { return $w }
    if (-not $WindowName -and $w.Current.Name) { return $w }
  }
  return $first
}

function Find-Element($main, [string]$aid, [string]$name) {
  $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $all.Count; $i++) {
    $el = $all.Item($i)
    if ($el.Current.IsOffscreen) { continue }
    if ($aid -and $el.Current.AutomationId -ne $aid) { continue }
    if ($name -and $el.Current.Name -ne $name) { continue }
    return $el
  }
  return $null
}

function Invoke-Click($el) {
  # 优先 InvokePattern（逻辑点击），否则鼠标点中心
  try {
    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
    return 'invoke'
  } catch {
    $b = $el.Current.BoundingRectangle
    $cx = [int]($b.X + $b.Width/2); $cy = [int]($b.Y + $b.Height/2)
    [UiDriveWin32]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 150
    [UiDriveWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [UiDriveWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
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

# status：只报告进程/窗口状态，不要求窗口存在、不置前台
if ($Action -eq 'status') {
  if ($ProcId -gt 0) {
    $sp = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  } else {
    $sp = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $sp) { Write-Output 'NOT_RUNNING'; exit 2 }
  $sw = Get-MainWindow $sp.Id
  if (-not $sw) { Write-Output ('RUNNING pid=' + $sp.Id + ' window=NONE'); exit 0 }
  Write-Output ('RUNNING pid=' + $sp.Id + ' window=' + $sw.Current.Name)
  Write-Output ('HANDLE ' + $sw.Current.NativeWindowHandle)
  $sr = New-Object UiDriveWin32+RECT
  [UiDriveWin32]::GetWindowRect([IntPtr]$sw.Current.NativeWindowHandle, [ref]$sr) | Out-Null
  Write-Output ('RECT ' + ($sr.Right - $sr.Left) + 'x' + ($sr.Bottom - $sr.Top) + ' @' + $sr.Left + ',' + $sr.Top)
  exit 0
}

$procId = Get-ClientPid
$main = Get-MainWindow $procId
if (-not $main) { throw '未找到主窗口（' + $WindowName + '）' }
[UiDriveWin32]::ShowWindow([IntPtr]$main.Current.NativeWindowHandle, 9) | Out-Null   # SW_RESTORE（最小化时恢复）
[UiDriveWin32]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300

switch ($Action) {
  'find' {
    $el = Find-Element $main $Aid $Name
    if ($el) {
      $b = $el.Current.BoundingRectangle
      Write-Output ('FOUND [' + $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','') + '] name="' + $el.Current.Name + '" aid="' + $el.Current.AutomationId + '" enabled=' + $el.Current.IsEnabled + ' @' + [int]$b.X + ',' + [int]$b.Y + ' ' + [int]$b.Width + 'x' + [int]$b.Height)
    } else { Write-Output 'NOT_FOUND' }
  }
  'click' {
    $el = Find-Element $main $Aid $Name
    if (-not $el) { Write-Output 'NOT_FOUND'; exit 1 }
    $how = Invoke-Click $el
    Write-Output ('CLICKED "' + $el.Current.Name + '" via ' + $how)
    Start-Sleep -Milliseconds $WaitMs
  }
  'setvalue' {
    $el = Find-Element $main $Aid $Name
    if (-not $el) { Write-Output 'NOT_FOUND'; exit 1 }
    $v = Set-ElementValue $el $Value
    Write-Output ('SET "' + $Value + '" -> "' + $v + '"')
    Start-Sleep -Milliseconds $WaitMs
  }
  'read' {
    $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $el = $all.Item($i)
      if ($el.Current.IsOffscreen) { continue }
      $t = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
      $n = $el.Current.Name
      if (-not $n) { $n = '' }
      if ($n.Length -gt 60) { $n = $n.Substring(0,60) }
      $b = $el.Current.BoundingRectangle
      if ($Match -and $n -notmatch $Match) { continue }
      if ($t -in @('Button','Edit','Text','RadioButton','CheckBox','TabItem','ComboBox')) {
        Write-Output ('[' + $t + '] "' + $n + '" aid="' + $el.Current.AutomationId + '" enabled=' + $el.Current.IsEnabled + ' @' + [int]$b.X + ',' + [int]$b.Y)
      }
    }
  }
  'shot' {
    if (-not $Out) { $Out = Join-Path $env:TEMP ('uia-shot-' + (Get-Date -Format 'HHmmss') + '.png') }
    $h = [IntPtr]$main.Current.NativeWindowHandle
    $r = New-Object UiDriveWin32+RECT
    [UiDriveWin32]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output ('SHOT ' + $Out + ' ' + $w + 'x' + $hh)
  }
  'key' {
    $el = Find-Element $main $Aid $Name
    if (-not $el) { Write-Output 'NOT_FOUND'; exit 1 }
    $b = $el.Current.BoundingRectangle
    [UiDriveWin32]::SetCursorPos([int]($b.X+$b.Width/2), [int]($b.Y+$b.Height/2))
    Start-Sleep -Milliseconds 200
    [UiDriveWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [UiDriveWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
    if ($Ascii) {
      [System.Windows.Forms.SendKeys]::SendWait('^a')
      Start-Sleep -Milliseconds 150
      [System.Windows.Forms.SendKeys]::SendWait($Value)
    } else {
      Set-Clipboard -Value $Value
      Start-Sleep -Milliseconds 200
      [System.Windows.Forms.SendKeys]::SendWait('^a')
      Start-Sleep -Milliseconds 150
      [System.Windows.Forms.SendKeys]::SendWait('^v')
    }
    Start-Sleep -Milliseconds $WaitMs
    Write-Output ('KEYED "' + $Value + '" into ' + $el.Current.AutomationId)
  }
  default { Write-Output 'UNKNOWN_ACTION' }
}
