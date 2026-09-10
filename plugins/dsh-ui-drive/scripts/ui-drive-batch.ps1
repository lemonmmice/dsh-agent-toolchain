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
#   waitMs?, out?, expectEnabled?, expectMatch?, index?, inAid?, inName?, waitFor?,
#   state?, keys?, fromX?, fromY?, toX?, toY?, x?, y?}；action ∈ find|click|setvalue|
#   key|type|drag|read|shot|wait|waitfor|expect|windows。
#
# 动态界面（登录、验证码、加载态）的关键三件套：
#   waitFor:{ms,interval,state:'appear'|'gone'|'enabled'|'disabled',match,index}
#     —— 先等条件成立再执行动作（click/setvalue/key/type 都支持），不再靠固定 sleep；
#   index / inAid|inName —— 同名控件按第 N 个、或限定在某个容器内找；
#   type —— 键盘序列（{ENTER}/{TAB}/{ESC}/{DOWN}/^a 等 SendKeys 语法），用于
#     回车提交、Tab 跳转、下拉选择等；drag —— 鼠标拖拽（滑块验证码）。
#
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
  [string]$ScriptStamp = '',
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
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int max);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
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

# 取控件类型名。UIA 在界面重绘/换指标/翻页的瞬间会枚举到 ControlType=null 的瞬时元素，
# 旧写法 $el.Current.ControlType.ProgrammaticName.Replace(...) 会把 null 当方法接收者，
# 抛「不能对 Null 值表达式调用方法」——整个 read/state 直接崩成 0 行（长跑里反复出现的假失败）。
# 现在统一降级为 Unknown，交给各处的类型白名单过滤掉，绝不让单个坏元素打断整次枚举。
function Get-ControlTypeName($el) {
  try {
    $ct = $el.Current.ControlType
    if ($null -eq $ct) { return 'Unknown' }
    $pn = $ct.ProgrammaticName
    if (-not $pn) { return 'Unknown' }
    return $pn.Replace('ControlType.', '')
  } catch {
    return 'Unknown'
  }
}

# 匹配目标控件：Name 与 HelpText 都参与。
# WPF 里只显示图标的按钮 Name 常为空、语义只写在 ToolTip 中，而 WPF 会把 ToolTip 作为
# UIA HelpText 暴露（AutomationProperties.HelpText 为空时回落 ToolTip）。
# 过去 click/find 只匹配 Name，导致这类按钮「读得到、点不到」，只能退化成坐标点击。
function Test-MatchText($el, [string]$re) {
  if (-not $re) { return $true }
  $n = ''; $h = ''
  try { $n = [string]$el.Current.Name } catch { }
  try { $h = [string]$el.Current.HelpText } catch { }
  return ($n -match $re) -or ($h -match $re)
}

# UIA 里有些元素（虚拟化列表项、折叠面板里的 TextBlock）BoundingRectangle 是 ±∞，
# 直接 [int] 会抛「值对于 Int32 太大或太小」把整个动作打断。统一按「不可用」处理。
function Is-RectUsable($rect) {
  if ($null -eq $rect) { return $false }
  foreach ($v in @($rect.X, $rect.Y, $rect.Width, $rect.Height)) {
    if ([double]::IsNaN([double]$v) -or [double]::IsInfinity([double]$v)) { return $false }
  }
  return $true
}

function Is-ElementUsable($el) {
  if ($el.Current.IsOffscreen) { return $false }
  return (Is-RectUsable $el.Current.BoundingRectangle)
}

# 安全取整：±∞/NaN 一律给 0，避免 [int] 转换抛异常
function Get-SafeInt($v) {
  $d = [double]$v
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
  return [int]$d
}

# UIA 原生 FindAll：单条件（aid 或 name）交给 UIA，双条件用 AndCondition，
# 不再手写遍历整棵树的循环——这是单步脚本里最大的开销来源。
# 返回所有可见匹配（按树序）；index 由调用方挑选（同名控件去重）。
# $scope 非空时只在子树内找（局部定位，避免命中另一个面板里的同名控件）。
function Find-Elements($main, [string]$aid, [string]$name, $scope = $null) {
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
  $root = $main
  if ($null -ne $scope) { $root = $scope }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $all.Count; $i++) {
    $el = $all.Item($i)
    if ($el.Current.IsOffscreen) { continue }
    if (-not (Is-RectUsable $el.Current.BoundingRectangle)) { continue }
    [void]$out.Add($el)
  }
  return $out
}

# 单条件找第一个（find/expect 的旧语义）
function Find-Element($main, [string]$aid, [string]$name, $scope = $null) {
  $list = Find-Elements $main $aid $name $scope
  if ($list.Count -eq 0) { return $null }
  return $list[0]
}

# 元素当前值：ValuePattern 优先，其次 TextPattern / Name（Edit 输入框的真实内容）
function Get-ElementValue($el) {
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$vp.Current.Value
  } catch { }
  try {
    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    return [string]$tp.DocumentRange.GetText(200)
  } catch { }
  return [string]$el.Current.Name
}

# 敏感控件（密码框/验证码/token）：值绝不回读进证据与模型上下文
$SECRET_NAME_RE = '密码|password|passwd|验证码|verify|code|captcha|token|secret|口令'

function Is-SecretControl($el) {
  $name = [string]$el.Current.Name
  $aid = [string]$el.Current.AutomationId
  if ($name -match $SECRET_NAME_RE) { return $true }
  if ($aid -match $SECRET_NAME_RE) { return $true }
  # WPF PasswordBox 的 UIA 控件类型是 Edit，但 IsPassword 为真。
  # 只对 Edit/Document 查这个属性：IsPassword 是一次跨进程 UIA 调用，
  # 对每个 Text/Button 都查会让 read 慢一个数量级（实测 770 元素 ~16s）。
  $t = ''
  try { $t = Get-ControlTypeName $el } catch { }
  if ($t -in @('Edit', 'Document', 'ComboBox')) {
    try { if ($el.Current.IsPassword -eq $true) { return $true } } catch { }
  }
  return $false
}

# read/state 用的「安全值」：敏感控件只回长度，不回内容
function Get-ElementValueForReport($el) {
  $v = Get-ElementValue $el
  if (Is-SecretControl $el) {
    if ($v.Length -eq 0) { return '<secret:empty>' }
    return ('<secret:' + $v.Length + 'chars>')
  }
  return $v
}

# 等待条件成立（动态界面的核心）：state=appear|gone|enabled|disabled
#   $spec = @{ ms=5000; interval=150; state='appear'; match='...'; index=0; enabled=$true }
# 返回 @{ ok; found; elapsedMs; error; el }；$ok=$true 表示条件已满足。
function Wait-ForCondition($main, [string]$aid, [string]$name, $spec, $scope = $null) {
  if ($null -eq $spec) { return @{ ok = $true; found = $null; elapsedMs = 0; skipped = $true } }
  $ms = 5000
  if ($spec.PSObject.Properties.Name -contains 'ms' -and $null -ne $spec.ms) { $ms = [int]$spec.ms }
  $ms = [Math]::Min([Math]::Max($ms, 0), 120000)
  $interval = 150
  if ($spec.PSObject.Properties.Name -contains 'interval' -and $null -ne $spec.interval) { $interval = [int]$spec.interval }
  $interval = [Math]::Min([Math]::Max($interval, 50), 2000)
  $state = 'appear'
  if ($spec.PSObject.Properties.Name -contains 'state' -and $spec.state) { $state = [string]$spec.state }
  $matchRe = ''
  if ($spec.PSObject.Properties.Name -contains 'match' -and $spec.match) { $matchRe = [string]$spec.match }
  $idx = 0
  if ($spec.PSObject.Properties.Name -contains 'index' -and $null -ne $spec.index) { $idx = [int]$spec.index }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $list = Find-Elements $main $aid $name $scope
    $el = $null
    if ($list.Count -gt 0) {
      $picked = @($list)
      if ($matchRe) {
        $picked = @($picked | Where-Object { Test-MatchText $_ $matchRe })
      }
      if ($picked.Count -gt $idx) { $el = $picked[$idx] }
    }
    $ok = $false
    if ($state -eq 'gone') { $ok = ($null -eq $el) }
    elseif ($null -eq $el) { $ok = $false }
    elseif ($state -eq 'enabled') { $ok = ($el.Current.IsEnabled -eq $true) }
    elseif ($state -eq 'disabled') { $ok = ($el.Current.IsEnabled -eq $false) }
    else { $ok = $true }
    if ($ok) { return @{ ok = $true; found = ($null -ne $el); elapsedMs = [int]$sw.ElapsedMilliseconds; el = $el } }
    if ($sw.ElapsedMilliseconds -ge $ms) {
      $detail = '条件未满足: state=' + $state + ' target=' + ($aid + '/' + $name)
      if ($matchRe -ne '') { $detail = $detail + ' match=/' + $matchRe + '/' }
      return @{ ok = $false; found = ($null -ne $el); elapsedMs = [int]$sw.ElapsedMilliseconds; error = ($detail + ' 超时 ' + $ms + 'ms') }
    }
    Start-Sleep -Milliseconds $interval
  }
}

# 键盘序列：SendKeys 语法（{ENTER}/{TAB}/{ESC}/{DOWN}/^a 等），$literal=$true 时转义 {}
function Send-TypeTo($el, [string]$text, [bool]$literal) {
  $b = $el.Current.BoundingRectangle
  [UiDriveBatchWin32]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2))
  Start-Sleep -Milliseconds 120
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  # 鼠标点过之后显式 SetFocus：SendKeys 只发给「有键盘焦点」的控件，
  # 只靠点击在 UIA 干预/多窗口场景下并不可靠（实测假登录页 type 完全没进去）。
  try { $el.SetFocus() } catch { }
  Start-Sleep -Milliseconds 200
  # 先全选：SendKeys 是「追加」语义，不清空会把新内容拼在旧值后面（实测撞过）
  $null = [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 100
  $payload = $text
  if ($literal) {
    # ascii=true 且是纯可打印 ASCII → 逐字符直发（比 SendKeys 稳，不受特殊字符转义影响）
    if ($payload -match '^[\x20-\x7e]*$' -and $payload.Length -gt 0) {
      Send-TextDirect $payload
      return
    }
    $payload = $payload.Replace('{', '{{').Replace('}', '}}').Replace('+', '{+}').Replace('^', '{^}').Replace('%', '{%}').Replace('~', '{~}').Replace('(', '{(}').Replace(')', '{)}')
  }
  # SendWait 返回布尔值，PS 5.1 会把它混进函数输出（外层收到 Object[] 会崩）——必须吞掉
  $null = [System.Windows.Forms.SendKeys]::SendWait($payload)
}

# 直接发字符（keybd_event + VkKeyScan）：比 SendKeys 可靠——不依赖 .NET 的
# 活动窗口假设，也不受 SendKeys 对特殊字符的转义影响。只处理单行可打印字符。
function Send-TextDirect([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -gt 127) { continue }   # 非 ASCII 走剪贴板路径
    $vks = [UiDriveBatchWin32]::VkKeyScan([char]$ch)
    if ($vks -eq -1) { continue }
    $vkey = $vks -band 0xFF
    $shift = (($vks -shr 8) -band 1) -eq 1
    if ($shift) { [UiDriveBatchWin32]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
    [UiDriveBatchWin32]::keybd_event([byte]$vkey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 15
    [UiDriveBatchWin32]::keybd_event([byte]$vkey, 0, 2, [UIntPtr]::Zero)
    if ($shift) { [UiDriveBatchWin32]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 15
  }
}

# key 的 ASCII 路径：先 ^a 全选清空，再逐字符直发（可靠），失败再退回 SendKeys
function Send-KeyAscii([string]$value) {
  $null = [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 120
  if ($value -match '^[\x20-\x7e]*$' -and $value.Length -gt 0) {
    Send-TextDirect $value
  } else {
    $null = [System.Windows.Forms.SendKeys]::SendWait($value)
  }
}

# UIA 元素级双击：用 GetClickablePoint（物理像素）定位，绕开坐标口径问题。
# 表格行双击必须走这条——实测按 BoundingRectangle 换算的坐标点击会偏。
function Invoke-DoubleClickElement($el, $main) {
  # GetClickablePoint() 返回 System.Windows.Point（UIAutomationTypes 里就有），
  # 不要 New-Object System.Windows.Point —— 本进程没加载 PresentationCore，会编译失败。
  $sx = $null; $sy = $null
  try {
    $pt = $el.GetClickablePoint()
    $sx = [int]$pt.X; $sy = [int]$pt.Y
  } catch {
    $b = $el.Current.BoundingRectangle
    if (Is-RectUsable $b) { $sx = [int]($b.X + $b.Width / 2); $sy = [int]($b.Y + $b.Height / 2) }
  }
  if ($null -eq $sx) { throw '元素没有可点击点（GetClickablePoint 失败）' }
  try { $el.SetFocus() } catch { }
  if ($null -ne $main) { try { [UiDriveBatchWin32]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle) | Out-Null } catch { } }
  Start-Sleep -Milliseconds 80
  [UiDriveBatchWin32]::SetCursorPos($sx, $sy) | Out-Null
  Start-Sleep -Milliseconds 120
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  return ('doubleClick @' + $sx + ',' + $sy + ' (' + (Get-ControlTypeName $el) + ')')
}

# 坐标点击（窗口客户区）：表格行、图表点位等 UIA 元素不稳定的地方
# $button: left(默认) | right（右键菜单）| middle
function Invoke-ClickAt($main, [int]$x, [int]$y, [bool]$double, [string]$button) {
  $r = Get-MainRect $main
  $sx = $r.Left + $x; $sy = $r.Top + $y
  [UiDriveBatchWin32]::SetCursorPos($sx, $sy) | Out-Null
  Start-Sleep -Milliseconds 120
  $down = 2; $up = 4
  if ($button -eq 'right') { $down = 8; $up = 16 }
  elseif ($button -eq 'middle') { $down = 32; $up = 64 }
  [UiDriveBatchWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [UiDriveBatchWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  if ($double) {
    # 双击间隔要短（默认双击时间约 500ms，但 60ms 实测被识别成两次单击）
    Start-Sleep -Milliseconds 120
    [UiDriveBatchWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [UiDriveBatchWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  }
  return ('clickAt ' + $x + ',' + $y + ' ' + $(if ($button) { $button } else { 'left' }) + $(if ($double) { ' x2' } else { '' }))
}

# 鼠标拖拽（滑块验证码 / K线平移）：窗口客户区坐标 → 屏幕坐标，按住左键移动后释放
# $keyMods：按住不放的修饰键（shift/ctrl/alt），K线拖动/十字光标常用
function Get-ModVk([string]$name) {
  switch ($name.Trim().ToLowerInvariant()) {
    'shift' { return 0x10 }
    'ctrl' { return 0x11 }
    'control' { return 0x11 }
    'alt' { return 0x12 }
    default { return 0 }
  }
}

function Get-MainRect($main) {
  $r = New-Object UiDriveBatchWin32+RECT
  if ($null -ne $main) {
    [UiDriveBatchWin32]::GetWindowRect([IntPtr]$main.Current.NativeWindowHandle, [ref]$r) | Out-Null
  }
  return $r
}

# 鼠标移动到窗口客户区坐标（K线十字光标靠它）
function Invoke-Move($main, [int]$x, [int]$y, [int]$holdMs) {
  $r = Get-MainRect $main
  $sx = $r.Left + $x; $sy = $r.Top + $y
  [UiDriveBatchWin32]::SetCursorPos($sx, $sy) | Out-Null
  if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
  return ('move ' + $x + ',' + $y)
}

# 滚轮：$delta>0 上滚（放大/上翻），<0 下滚；K线缩放/滚动都靠它
function Invoke-Wheel($main, [int]$x, [int]$y, [int]$delta, [int]$count, [int]$holdMs) {
  $r = Get-MainRect $main
  [UiDriveBatchWin32]::SetCursorPos($r.Left + $x, $r.Top + $y) | Out-Null
  Start-Sleep -Milliseconds 80
  if ($count -lt 1) { $count = 1 }
  for ($i = 0; $i -lt $count; $i++) {
    # mouse_event 的 dwData 是 DWORD：PowerShell 拒绝把负数转成 UInt32（-band 也不行），
    # 必须显式加 2^32 得到无符号值（-120 → 4294967176）——实测 probe 确认过。
    $wd = [int64]$delta
    if ($wd -lt 0) { $wd = $wd + 4294967296 }
    [UiDriveBatchWin32]::mouse_event(0x0800, 0, 0, [uint32]$wd, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $holdMs
  }
  return ('wheel delta=' + $delta + ' x' + $count + ' @' + $x + ',' + $y)
}

# 按住修饰键 → 执行 → 释放（K线 Shift+拖动、Ctrl+滚轮等）
function Invoke-WithMods([string]$mods, [scriptblock]$body) {
  $vks = @()
  if ($mods) {
    foreach ($m in ($mods -split '[,+ ]+')) {
      if (-not $m) { continue }
      $vk = Get-ModVk $m
      if ($vk -gt 0) { $vks += $vk; [UiDriveBatchWin32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
    }
    Start-Sleep -Milliseconds 60
  }
  try { return (& $body) } finally {
    foreach ($vk in $vks) { [UiDriveBatchWin32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
  }
}

function Invoke-Drag($main, [int]$fromX, [int]$fromY, [int]$toX, [int]$toY, [int]$steps, [int]$holdMs) {
  $h = [IntPtr]$main.Current.NativeWindowHandle
  $r = New-Object UiDriveBatchWin32+RECT
  [UiDriveBatchWin32]::GetWindowRect($h, [ref]$r) | Out-Null
  [UiDriveBatchWin32]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 100
  $x0 = $r.Left + $fromX; $y0 = $r.Top + $fromY
  $x1 = $r.Left + $toX; $y1 = $r.Top + $toY
  [UiDriveBatchWin32]::SetCursorPos($x0, $y0) | Out-Null
  Start-Sleep -Milliseconds $holdMs
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  if ($steps -lt 1) { $steps = 12 }
  for ($i = 1; $i -le $steps; $i++) {
    $x = [int]($x0 + ($x1 - $x0) * $i / $steps)
    $y = [int]($y0 + ($y1 - $y0) * $i / $steps)
    [UiDriveBatchWin32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds $holdMs
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  return ('drag ' + $fromX + ',' + $fromY + ' -> ' + $toX + ',' + $toY + ' (' + $steps + ' steps)')
}

# 进程的所有顶层窗口（登录窗口/主窗口/弹窗各自一行；弹窗常常不是「主窗口」）
function Get-Windows([int]$procId) {
  $wins = Get-WindowElements $procId
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $wins.Count; $i++) { [void]$out.Add((Get-WindowLine $wins[$i])) }
  return $out
}

# Win32 级顶层窗口枚举（EnumWindows，不走 UIA）：返回 @{Handle; Title; Visible}。
# 用途：capture 动作解析主窗口——UIA 路径在登录/弹窗阶段可能拿不到主窗口元素，
# 而 MainWindowHandle 常被输入法状态条（CiceroUIWndFrame）抢占（实测）。
# 注意标题用 GetText 读（UTF-16），中文标题可靠。
function Get-ProcessTopWindows([int]$procId) {
  $out = New-Object System.Collections.ArrayList
  $cb = {
    param($h, $lp)
    $winPid = 0
    [UiDriveBatchWin32]::GetWindowThreadProcessId($h, [ref]$winPid) | Out-Null
    if ($winPid -eq $procId) {
      $sb = New-Object System.Text.StringBuilder 512
      [UiDriveBatchWin32]::GetWindowTextW($h, $sb, 512) | Out-Null
      $visible = [UiDriveBatchWin32]::IsWindowVisible($h)
      [void]$out.Add(@{ Handle = $h; Title = $sb.ToString(); Visible = $visible })
    }
    return $true
  }
  [UiDriveBatchWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $out
}

# 顶层窗口元素列表（跨窗口原语的基础）
function Get-WindowElements([int]$procId) {
  $root = $UIA::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, $procId)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $wins.Count; $i++) { [void]$out.Add($wins.Item($i)) }
  return $out
}

# 按标题正则挑窗口；空正则 = 第一个有名字的窗口（主窗口优先）。找不到返回 $null。
function Find-WindowByTitle([int]$procId, [string]$titleRe) {
  $wins = Get-WindowElements $procId
  if ($titleRe) {
    for ($i = 0; $i -lt $wins.Count; $i++) {
      if ([string]$wins[$i].Current.Name -match $titleRe) { return $wins[$i] }
    }
    return $null
  }
  for ($i = 0; $i -lt $wins.Count; $i++) {
    if ([string]$wins[$i].Current.Name) { return $wins[$i] }
  }
  if ($wins.Count -gt 0) { return $wins[0] }
  return $null
}

# 单个窗口的一行文本（与 Get-Windows 同格式）
function Get-WindowLine($w) {
  $b = $w.Current.BoundingRectangle
  return ('[' + (Get-ControlTypeName $w) + '] "' + $w.Current.Name + '" handle=' + [int64]$w.Current.NativeWindowHandle + ' pid=' + $w.Current.ProcessId + ' @' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y) + ' ' + (Get-SafeInt $b.Width) + 'x' + (Get-SafeInt $b.Height) + ' offscreen=' + $w.Current.IsOffscreen)
}

# 进程所有窗口的可见文本（含 Edit/Document 的真实值）——expectText / waitAny(text) 用
function Get-ProcessTextLines([int]$procId, [string]$re, [int]$max) {
  $lines = New-Object System.Collections.ArrayList
  $wins = Get-WindowElements $procId
  for ($i = 0; $i -lt $wins.Count; $i++) {
    $all = $wins[$i].FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($k = 0; $k -lt $all.Count; $k++) {
      $el = $all.Item($k)
      if ($el.Current.IsOffscreen) { continue }
      $t = Get-ControlTypeName $el
      if ($t -notin @('Text', 'Edit', 'Document', 'Button', 'Hyperlink')) { continue }
      $n = [string]$el.Current.Name
      $val = ''
      if ($t -in @('Edit', 'Document')) { $val = Get-ElementValueForReport $el }
      $hay = ($n + ' ' + $val).Trim()
      if ($hay -eq '') { continue }
      if ($re -and $hay -notmatch $re) { continue }
      if ($hay.Length -gt 120) { $hay = $hay.Substring(0, 120) }
      [void]$lines.Add(('[' + $t + '] "' + $hay + '" @win="' + [string]$wins[$i].Current.Name + '"'))
      if ($max -gt 0 -and $lines.Count -ge $max) { return $lines }
    }
  }
  return $lines
}

function Get-ElementDetail($el) {
  $b = $el.Current.BoundingRectangle
    $help = ''
  try { $help = [string]$el.Current.HelpText } catch { }
    $h = ''
    if ($help) { $h = ' help="' + $help + '"' }
  return ('[' + (Get-ControlTypeName $el) + '] name="' + $el.Current.Name + '" aid="' + $el.Current.AutomationId + '"' + $h + ' enabled=' + $el.Current.IsEnabled + ' @' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y) + ' ' + (Get-SafeInt $b.Width) + 'x' + (Get-SafeInt $b.Height))
}

# 当前焦点元素（UIA FocusedElement）+ 它所属的顶层窗口名。
# 动态界面的关键信号：焦点在哪、当前是哪个窗口，比「我刚才点了什么」可靠得多。
function Get-FocusedInfo {
  $fe = $null
  try { $fe = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { }
  if ($null -eq $fe) { return @{ detail = $null; window = $null } }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $fe
  $top = $fe
  for ($i = 0; $i -lt 30; $i++) {
    $parent = $null
    try { $parent = $walker.GetParent($node) } catch { break }
    if ($null -eq $parent) { break }
    if ($parent -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
    $top = $parent
    $node = $parent
  }
  $winName = ''
  try { $winName = [string]$top.Current.Name } catch { }
  return @{ detail = (Get-ElementDetail $fe); window = $winName }
}

# 交互型控件过滤（ui_state 用：只列能点/能输的东西，避免 900+ 行文本淹没上下文）
$INTERACTIVE_TYPES = @('Button', 'Edit', 'RadioButton', 'CheckBox', 'TabItem', 'ComboBox', 'ListItem', 'MenuItem', 'TreeItem', 'DataItem', 'Hyperlink', 'Slider', 'Spinner', 'Document', 'Custom')

function Get-InteractiveLines($main, [string]$match, [int]$max) {
  $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $lines = New-Object System.Collections.ArrayList
  $seen = @{}
  for ($i = 0; $i -lt $all.Count; $i++) {
    $el = $all.Item($i)
    if ($el.Current.IsOffscreen) { continue }
    $b = $el.Current.BoundingRectangle
    if (-not (Is-RectUsable $b)) { continue }
    $t = Get-ControlTypeName $el
    if ($t -notin $INTERACTIVE_TYPES) { continue }
    $n = $el.Current.Name
    if (-not $n) { $n = '' }
    if ($n.Length -gt 60) { $n = $n.Substring(0, 60) }
    if ($match -and $n -notmatch $match) { continue }
    $key = $t + '|' + $n + '|' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y)
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $val = ''
    if ($t -in @('Edit', 'ComboBox', 'Document')) { $val = Get-ElementValueForReport $el }
    if ($val.Length -gt 60) { $val = $val.Substring(0, 60) }
    $line = '#' + $lines.Count + ' [' + $t + '] "' + $n + '" aid="' + $el.Current.AutomationId + '" enabled=' + $el.Current.IsEnabled + ' @' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y)
    if ($val -and $val -ne $n) { $line = $line + ' value="' + $val + '"' }
    [void]$lines.Add($line)
    if ($max -gt 0 -and $lines.Count -ge $max) { break }
  }
  return $lines
}

# 凭据占位符：${cred:name} → 环境变量 DSH_CRED_name（也试 DSH_CRED_NAME）。
# 密码永远不进工具参数/证据文件/模型上下文，只在驱动进程内展开。
function Resolve-Value([string]$value) {
  if ($value -match '^\$\{cred:([A-Za-z0-9_.-]+)\}$') {
    $name = $matches[1]
    $envName = 'DSH_CRED_' + $name
    $v = [System.Environment]::GetEnvironmentVariable($envName)
    if (-not $v) { $v = [System.Environment]::GetEnvironmentVariable($envName.ToUpperInvariant()) }
    if (-not $v) { throw ('凭据占位符未解析：' + $envName + ' 未设置（环境变量注入，不要写进参数）') }
    return $v
  }
  return $value
}

# 回读校验：输入类动作写完后比对控件真实值，不一致就是「假成功」——必须报失败。
# 注意：错误信息里绝不回显期望值/实际值（可能是密码）。
function Assert-ValueWritten($el, [string]$want) {
  if ([string]::IsNullOrEmpty($want)) { return $null }
  $got = Get-ElementValue $el
  if ($got -eq $want) { return $null }
  return ('输入未生效（回读不一致）：控件="' + $el.Current.AutomationId + '" 期望长度=' + $want.Length + ' 实际长度=' + $got.Length + '（值不回显）')
}

# 证据/输出里打码
function Mask-Value([string]$v, [bool]$secret) {
  if (-not $secret) { return $v }
  if ($v.Length -le 2) { return '***' }
  return ($v.Substring(0, 1) + '***' + $v.Substring($v.Length - 1, 1))
}

# 交易类硬 deny：买入/卖出/下单/委托/支付/提现等入口，任何参数都不能解锁。
# 这是驱动层强制（不是提示词），因为误点会真下单。
$DENY_RE = '买入|卖出|下单|委托|交易|支付|提现|申购|赎回|撤单|平仓|开仓'
function Test-DenyTarget($el) {
  $name = [string]$el.Current.Name
  $aid = [string]$el.Current.AutomationId
  if (($name -match $DENY_RE) -or ($aid -match $DENY_RE)) {
    return ('交易类控件被驱动层硬拒绝（不可解锁）：name="' + $name + '" aid="' + $aid + '"')
  }
  return $null
}

function Invoke-Click($el, $main) {
  # 按 pattern 分派：Button/MenuItem→Invoke，CheckBox/RadioButton→Toggle/SelectionItem，其余鼠标兜底。
  # 登录 Tab 是 RadioButton（没有 InvokePattern），必须走 SelectionItemPattern，否则会落到鼠标点击。
  $type = Get-ControlTypeName $el
  try {
    if ($type -in @('Button', 'MenuItem', 'Hyperlink', 'ListItem', 'TabItem', 'TreeItem')) {
      $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $null = $ip.Invoke()
      return 'invoke'
    }
    if ($type -eq 'CheckBox') {
      $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $null = $tp.Toggle()
      return 'toggle'
    }
    if ($type -eq 'RadioButton') {
      $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $null = $sp.Select()
      return 'select'
    }
  } catch {
    # 落下去走鼠标兜底
  }
  $b = $el.Current.BoundingRectangle
  $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
  if ($null -ne $main) {
    try { [UiDriveBatchWin32]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle) | Out-Null } catch { }
    Start-Sleep -Milliseconds 80
  }
  [UiDriveBatchWin32]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 120
  [UiDriveBatchWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [UiDriveBatchWin32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  return ('mouse@' + $cx + ',' + $cy)
}

function Set-ElementValue($el, [string]$value) {
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    # SetValue 直接写属性，绕过 PreviewKeyDown 的按键过滤（登录页手机号框只放行数字键）
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
  try { $el.SetFocus() } catch { }
  Start-Sleep -Milliseconds 300
  if ($ascii) {
    Send-KeyAscii $value
  } else {
    Set-Clipboard -Value $value
    Start-Sleep -Milliseconds 150
    $null = [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 120
    $null = [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  Start-Sleep -Milliseconds $waitMs
}

# 动作是否需要窗口在前台：只有鼠标/键盘/屏幕截图类需要；
# 纯 UIA 只读动作（find/read/state/windows/waitfor/expect*）绝不抢焦点、绝不改窗口状态。
function Test-NeedsForeground($step) {
  $ro = @('find','read','state','windows','waitfor','expectwindow','expecttext','waitany','state-live')
  $acts = New-Object System.Collections.ArrayList
  if ($step.PSObject.Properties.Name -contains 'action' -and $step.action) { [void]$acts.Add(([string]$step.action).Trim().ToLowerInvariant()) }
  if ($step.PSObject.Properties.Name -contains 'steps' -and $step.steps) {
    foreach ($s in $step.steps) {
      if ($s.PSObject.Properties.Name -contains 'action' -and $s.action) { [void]$acts.Add(([string]$s.action).Trim().ToLowerInvariant()) }
    }
  }
  if ($acts.Count -eq 0) { return $true }
  foreach ($a in $acts) { if ($ro -notcontains $a) { return $true } }
  return $false
}

function Save-Shot($main, [string]$outPath) {
  if (-not $outPath) { $outPath = Join-Path $env:TEMP ('uia-shot-' + (Get-Date -Format 'HHmmss') + '.png') }
  $dir = Split-Path -Parent $outPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $h = [IntPtr]$main.Current.NativeWindowHandle
  $r = New-Object UiDriveBatchWin32+RECT
  [UiDriveBatchWin32]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) {
    # 最小化/隐藏的窗口 GetWindowRect 返回 0x0：先恢复再量一次（截图不该因为窗口最小化就失败）
    [UiDriveBatchWin32]::ShowWindow($h, 9) | Out-Null
    Start-Sleep -Milliseconds 350
    [UiDriveBatchWin32]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  }
  if ($w -le 0 -or $hh -le 0) { throw ('窗口尺寸非法 ' + $w + 'x' + $hh) }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return @{ path = $outPath; w = $w; h = $hh }
}

# ------------------------------------------------------------ 单步执行

# 目标窗口解析：winTitle 正则 / winHandle 指定；都没有 = 主窗口。
# 跨窗口能力的地基：登录窗关闭后主窗才出现，find/read/waitfor 必须能换窗口找。
function Resolve-Window($main, $step, [int]$procId) {
  $titleRe = ''
  $handle = 0
  if ($step.PSObject.Properties.Name -contains 'winTitle' -and $step.winTitle) { $titleRe = [string]$step.winTitle }
  if ($step.PSObject.Properties.Name -contains 'winHandle' -and $null -ne $step.winHandle) { $handle = [int64]$step.winHandle }
  if ($titleRe -or $handle) {
    $wins = Get-WindowElements $procId
    for ($i = 0; $i -lt $wins.Count; $i++) {
      $nm = [string]$wins[$i].Current.Name
      $hd = [int64]$wins[$i].Current.NativeWindowHandle
      if ($handle -gt 0 -and $hd -eq $handle) { return $wins[$i] }
      if ($titleRe -and $nm -match $titleRe) { return $wins[$i] }
    }
    return $null
  }
  return $main
}

# 目标解析：容器范围（inAid/inName）→ 候选列表 → index/match 挑选
function Resolve-Target($main, $step, [int]$procId) {
  $root = Resolve-Window $main $step $procId
  if ($null -eq $root) { return @{ ok = $false; error = '未找到目标窗口（winTitle/winHandle）' } }
  $scope = $null
  $inAid = ''; $inName = ''
  if ($step.PSObject.Properties.Name -contains 'inAid' -and $step.inAid) { $inAid = [string]$step.inAid }
  if ($step.PSObject.Properties.Name -contains 'inName' -and $step.inName) { $inName = [string]$step.inName }
  if ($inAid -or $inName) {
    $scope = Find-Element $root $inAid $inName
    if (-not $scope) { return @{ ok = $false; error = ('未找到容器控件（' + $inAid + '/' + $inName + '）') } }
  }
  $list = Find-Elements $root ([string]$step.aid) ([string]$step.name) $scope
  $matchRe = ''
  if ($step.PSObject.Properties.Name -contains 'match' -and $step.match -and $step.action -ne 'read') { $matchRe = [string]$step.match }
  if ($matchRe) { $list = @($list | Where-Object { Test-MatchText $_ $matchRe }) }
  $idx = 0
  if ($step.PSObject.Properties.Name -contains 'index' -and $null -ne $step.index) { $idx = [int]$step.index }
  $el = $null
  if ($list.Count -gt $idx) { $el = $list[$idx] }
  return @{ ok = $true; el = $el; count = $list.Count; scope = $scope; root = $root }
}

# 条件等待包装：$step.waitFor 存在时先等条件成立；未配置则退化为「找到即用」
function Wait-Target($main, $step, $spec, [int]$procId) {
  # 无 waitFor 时直接交给 Resolve-Target（它会自己解析窗口）——曾经这里先解析一次窗口、
  # 再调 Resolve-Target 又解析一次，每个动作多付一整轮 UIA 扫描（实测 find 7s）。
  if ($null -eq $spec) {
    $t = Resolve-Target $main $step $procId
    if (-not $t.ok) { return $t }
    return @{ ok = $true; el = $t.el; count = $t.count; elapsedMs = 0 }
  }
  $root = Resolve-Window $main $step $procId
  if ($null -eq $root) { return @{ ok = $false; error = '未找到目标窗口（winTitle/winHandle）' } }
  $scope = $null
  $inAid = ''; $inName = ''
  if ($step.PSObject.Properties.Name -contains 'inAid' -and $step.inAid) { $inAid = [string]$step.inAid }
  if ($step.PSObject.Properties.Name -contains 'inName' -and $step.inName) { $inName = [string]$step.inName }
  if ($inAid -or $inName) {
    $scope = Find-Element $root $inAid $inName
    if (-not $scope) { return @{ ok = $false; error = ('未找到容器控件（' + $inAid + '/' + $inName + '）') } }
  }
  return (Wait-ForCondition $root ([string]$step.aid) ([string]$step.name) $spec $scope)
}

function Invoke-Step($main, $step, [int]$index, [int]$procId) {
  # 动作名归一化：模型可能写 waitFor/WaitFor，统一小写
  $action = [string]$step.action
  if ($action) { $action = $action.Trim().ToLowerInvariant() }
  $waitMs = $DefaultWaitMs
  if ($step.PSObject.Properties.Name -contains 'waitMs' -and $null -ne $step.waitMs) { $waitMs = [int]$step.waitMs }
  $hasWaitFor = ($step.PSObject.Properties.Name -contains 'waitFor' -and $null -ne $step.waitFor)
  $waitSpec = $null
  if ($hasWaitFor) { $waitSpec = $step.waitFor }
  $res = @{ step = ($index + 1); action = $action; ok = $false }
  try {
    # $null = $(...) 吞掉 switch 分支里漏网的表达式输出：PS 5.1 会把它们拼进函数
    # 返回值，外层拿到 Object[] 就在 Remove/Keys 上崩（type 动作踩过一次）。
    $null = $(switch ($action) {
      'wait' {
        $ms = [Math]::Min([Math]::Max($waitMs, 50), 30000)
        Start-Sleep -Milliseconds $ms
        $res.ok = $true; $res.waitedMs = $ms
      }
      'windows' {
        $lines = Get-Windows $procId
        $res.ok = $true; $res.count = $lines.Count; $res.lines = $lines
      }
      'state' {
        # 动作后/决策前的「界面快照」：当前窗口 + 焦点元素 + 交互控件清单
        $foc = Get-FocusedInfo
        $res.ok = $true
        $res.window = ''
        if ($main) { $res.window = [string]$main.Current.Name }
        $res.focusedWindow = $foc.window
        $res.focused = $foc.detail
        $max = 40
        if ($step.PSObject.Properties.Name -contains 'max' -and $null -ne $step.max) { $max = [int]$step.max }
        $matchRe = ''
        if ($step.PSObject.Properties.Name -contains 'match' -and $step.match) { $matchRe = [string]$step.match }
        $lines = Get-InteractiveLines $main $matchRe $max
        $res.count = $lines.Count; $res.lines = $lines
      }
      'state-live' {
        # live 循环专用「免前台」界面快照：与 state 相同内容，但主窗口在分支内
        # 自行解析（UIA 按 WindowName，绝不 ShowWindow/SetForegroundWindow ——
        # Claude 评审 1.1：state 走 serve 主窗口路径会把最小化窗口弹起、抢焦点，
        # 直接破坏「后台非侵入」承诺）。
        # 额外输出 secretFocused（live 敏感帧防线用）：焦点元素是否命中敏感词表
        # 或 IsPassword，供 Node 侧识别密码/验证码输入瞬间。
        $foc = Get-FocusedInfo
        $res.ok = $true
        $res.window = ''
        if ($main) { $res.window = [string]$main.Current.Name }
        else {
          try {
            $wins = Get-WindowElements $procId
            for ($i = 0; $i -lt $wins.Count; $i++) {
              if ($WindowName -and [string]$wins[$i].Current.Name -eq $WindowName) { $res.window = [string]$wins[$i].Current.Name; break }
            }
            if (-not $res.window -and $wins.Count -gt 0) { $res.window = [string]$wins[0].Current.Name }
          } catch { }
        }
        $res.focusedWindow = $foc.window
        $res.focused = $foc.detail
        $max = 40
        if ($step.PSObject.Properties.Name -contains 'max' -and $null -ne $step.max) { $max = [int]$step.max }
        $matchRe = ''
        if ($step.PSObject.Properties.Name -contains 'match' -and $step.match) { $matchRe = [string]$step.match }
        # 免前台遍历：自行解析主窗口元素（不 ShowWindow/不 SetForegroundWindow）
        $target = $null
        try {
          $wins = Get-WindowElements $procId
          for ($i = 0; $i -lt $wins.Count; $i++) {
            if ($WindowName -and [string]$wins[$i].Current.Name -eq $WindowName) { $target = $wins[$i]; break }
          }
          if (-not $target -and $wins.Count -gt 0) { $target = $wins[0] }
        } catch { }
        if ($target) {
          $lines = Get-InteractiveLines $target $matchRe $max
          $res.count = $lines.Count; $res.lines = $lines
        } else {
          $res.count = 0; $res.lines = @()
        }
        # 敏感焦点标记（供 live 跳帧）：focused 明细命中敏感词表，或焦点元素 IsPassword
        $res.secretFocused = $false
        if ($foc.detail) {
          if ($foc.detail -match '密码|password|passwd|验证码|verify|code|captcha|token|secret|口令') { $res.secretFocused = $true }
          else {
            try {
              $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
              if ($null -ne $fe) {
                $n = [string]$fe.Current.Name; $aid = [string]$fe.Current.AutomationId
                $t = ''
                try { $t = Get-ControlTypeName $fe } catch { }
                if ($t -in @('Edit', 'Document', 'ComboBox')) {
                  try { if ($fe.Current.IsPassword -eq $true) { $res.secretFocused = $true } } catch { }
                }
                if ($n -match '密码|password|passwd|验证码|verify|code|captcha|token|secret|口令' -or $aid -match '密码|password|passwd|验证码|verify|code|captcha|token|secret|口令') { $res.secretFocused = $true }
              }
            } catch { }
          }
        }
      }
      'waitfor' {
        # waitfor 的等待参数优先取 step.waitFor（与其它动作统一），没有就用 step 自身（ms/state/match/index 平铺写法）
        $spec = $step
        if ($hasWaitFor) { $spec = $step.waitFor }
        $root = Resolve-Window $main $step $procId
        $w = Wait-ForCondition $root ([string]$step.aid) ([string]$step.name) $spec $null
        $res.ok = ($w.ok -eq $true)
        $res.found = ($w.found -eq $true)
        $res.waitedMs = $w.elapsedMs
        if ($w.el -and $w.el -isnot [bool]) { $res.detail = (Get-ElementDetail $w.el) }
        if (-not $res.ok) { $res.error = [string]$w.error }
      }
      'expectwindow' {
        # 跨窗口断言：某个顶层窗口出现/消失（登录成功的唯一可靠信号）
        $titleRe = ''
        if ($step.PSObject.Properties.Name -contains 'titleRe' -and $step.titleRe) { $titleRe = [string]$step.titleRe }
        if (-not $titleRe) { $titleRe = [string]$step.value }
        $wantGone = (($step.PSObject.Properties.Name -contains 'gone') -and $step.gone)
        $ms = 5000
        if ($step.PSObject.Properties.Name -contains 'ms' -and $null -ne $step.ms) { $ms = [int]$step.ms }
        $interval = 150
        if ($step.PSObject.Properties.Name -contains 'interval' -and $null -ne $step.interval) { $interval = [int]$step.interval }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $hit = $null
        while ($true) {
          $found = Find-WindowByTitle $procId $titleRe
          if ($wantGone) { if ($null -eq $found) { $hit = $true; break } }
          elseif ($null -ne $found) { $hit = $found; break }
          if ($sw.ElapsedMilliseconds -ge $ms) { break }
          Start-Sleep -Milliseconds $interval
        }
        $res.ok = ($null -ne $hit)
        $res.found = ($null -ne $hit)
        $res.waitedMs = [int]$sw.ElapsedMilliseconds
        if ($null -ne $hit -and $hit -isnot [bool]) { $res.detail = (Get-WindowLine $hit) }
        if (-not $res.ok) {
          $res.error = ('窗口条件未满足：titleRe=/' + $titleRe + '/ gone=' + $wantGone + ' 超时 ' + $ms + 'ms；当前窗口：' + ((Get-Windows $procId) -join ' | '))
        }
      }
      'expecttext' {
        # 跨窗口文本断言：抓 ErrorInfo / 提示语（失败信息常常只在一段 Text 里）
        $re = ''
        if ($step.PSObject.Properties.Name -contains 'textRe' -and $step.textRe) { $re = [string]$step.textRe }
        if (-not $re) { $re = [string]$step.value }
        $ms = 5000
        if ($step.PSObject.Properties.Name -contains 'ms' -and $null -ne $step.ms) { $ms = [int]$step.ms }
        $interval = 150
        if ($step.PSObject.Properties.Name -contains 'interval' -and $null -ne $step.interval) { $interval = [int]$step.interval }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $lines = @()
        while ($true) {
          $lines = Get-ProcessTextLines $procId $re 20
          if ($lines.Count -gt 0) { break }
          if ($sw.ElapsedMilliseconds -ge $ms) { break }
          Start-Sleep -Milliseconds $interval
        }
        $res.ok = ($lines.Count -gt 0)
        $res.found = $res.ok
        $res.waitedMs = [int]$sw.ElapsedMilliseconds
        $res.count = $lines.Count
        $res.lines = @($lines)
        if (-not $res.ok) { $res.error = ('文本条件未满足：textRe=/' + $re + '/ 超时 ' + $ms + 'ms') }
      }
      'waitany' {
        # 竞速等待：一次调用同时押注成功/失败/需人工分支，返回命中的那一支。
        # conds: [{kind:'window'|'text'|'appear'|'gone'|'enabled'|'disabled', titleRe?, textRe?, name?, aid?, match?, index?, label?}]
        $conds = @()
        if ($step.PSObject.Properties.Name -contains 'conds' -and $step.conds) { $conds = @($step.conds) }
        $ms = 15000
        if ($step.PSObject.Properties.Name -contains 'ms' -and $null -ne $step.ms) { $ms = [int]$step.ms }
        $interval = 150
        if ($step.PSObject.Properties.Name -contains 'interval' -and $null -ne $step.interval) { $interval = [int]$step.interval }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $hitIndex = -1
        $hitInfo = @{}
        while ($true) {
          for ($ci = 0; $ci -lt $conds.Count; $ci++) {
            $c = $conds[$ci]
            $kind = 'appear'
            if ($c.PSObject.Properties.Name -contains 'kind' -and $c.kind) { $kind = [string]$c.kind }
            $kind = $kind.Trim().ToLowerInvariant()
            $matched = $false
            $detail = ''
            if ($kind -eq 'window') {
              $tre = ''
              if ($c.PSObject.Properties.Name -contains 'titleRe' -and $c.titleRe) { $tre = [string]$c.titleRe }
              $wEl = Find-WindowByTitle $procId $tre
              $matched = ($null -ne $wEl)
              if ($matched) { $detail = Get-WindowLine $wEl }
            } elseif ($kind -eq 'text') {
              $tre = ''
              if ($c.PSObject.Properties.Name -contains 'textRe' -and $c.textRe) { $tre = [string]$c.textRe }
              if (-not $tre -and ($c.PSObject.Properties.Name -contains 'match') -and $c.match) { $tre = [string]$c.match }
              $ls = Get-ProcessTextLines $procId $tre 5
              $matched = ($ls.Count -gt 0)
              if ($matched) { $detail = ($ls -join ' | ') }
            } else {
              $cspec = @{ ms = 0; state = $kind }
              $root = Resolve-Window $main $c $procId
              $w = Wait-ForCondition $root ([string]$c.aid) ([string]$c.name) $cspec $null
              $matched = ($w.ok -eq $true)
              if ($w.el -and $w.el -isnot [bool]) { $detail = Get-ElementDetail $w.el }
            }
            if ($matched) {
              # 稳定性确认：渲染瞬时状态容易误判（如窗口刚创建就重排），
              # 命中后再连续确认 stable 次（默认 2）才认。
              $stable = 2
              if ($step.PSObject.Properties.Name -contains 'stableCount' -and $null -ne $step.stableCount) { $stable = [Math]::Min([Math]::Max([int]$step.stableCount, 1), 10) }
              $okStable = $true
              for ($si = 1; $si -lt $stable; $si++) {
                Start-Sleep -Milliseconds $interval
                $again = $false
                if ($kind -eq 'window') {
                  $again = ($null -ne (Find-WindowByTitle $procId $tre))
                } elseif ($kind -eq 'text') {
                  $again = ((Get-ProcessTextLines $procId $tre 1).Count -gt 0)
                } else {
                  $root2 = Resolve-Window $main $c $procId
                  $w2 = Wait-ForCondition $root2 ([string]$c.aid) ([string]$c.name) @{ ms = 0; state = $kind } $null
                  $again = ($w2.ok -eq $true)
                }
                if (-not $again) { $okStable = $false; break }
              }
              if ($okStable) {
                $hitIndex = $ci
                $hitInfo = @{ index = $ci; kind = $kind; label = [string]$c.label; detail = $detail }
                break
              }
            }
          }
          if ($hitIndex -ge 0) { break }
          if ($sw.ElapsedMilliseconds -ge $ms) { break }
          Start-Sleep -Milliseconds $interval
        }
        $res.waitedMs = [int]$sw.ElapsedMilliseconds
        if ($hitIndex -ge 0) {
          $res.ok = $true
          $res.hitIndex = $hitInfo.index
          $res.hitKind = $hitInfo.kind
          $res.hitLabel = $hitInfo.label
          $res.detail = $hitInfo.detail
        } else {
          $res.ok = $false
          $res.hitIndex = -1
          $res.error = ('waitany 超时 ' + $ms + 'ms：' + $conds.Count + ' 个条件都没命中；当前窗口：' + ((Get-Windows $procId) -join ' | '))
        }
      }
      'find' {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.ok = $false; $res.error = [string]$w.error; $res.found = ($w.found -eq $true) }
        else {
          $res.ok = $true
          $el = $w.el
          if ($el) { $res.found = $true; $res.detail = (Get-ElementDetail $el); $res.count = $w.count; $res.waitedMs = $w.elapsedMs }
          else { $res.found = $false; $res.count = $w.count; $res.waitedMs = $w.elapsedMs }
        }
      }
      'expect' {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.ok = $false; $res.found = ($w.found -eq $true); $res.error = [string]$w.error }
        else {
          $el = $w.el
          $res.ok = ($null -ne $el); $res.found = ($null -ne $el); $res.waitedMs = $w.elapsedMs
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
      }
      'click' {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.notFound = $true; $res.error = [string]$w.error }
        elseif (-not $w.el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $el = $w.el
          # 交易类硬 deny：驱动层强制，allowSideEffects 也解锁不了
          $deny = Test-DenyTarget $el
          if ($deny) { $res.error = $deny }
          else {
            try { $el.SetFocus() } catch { }
            try {
              $si = $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
              $si.ScrollIntoView()
              Start-Sleep -Milliseconds 120
            } catch { }
            if ($el.Current.IsEnabled -eq $false) {
              $res.error = ('控件已找到但处于禁用态（enabled=False）：' + $el.Current.Name)
            } else {
              $how = Invoke-Click $el $main
              Start-Sleep -Milliseconds $waitMs
              $res.ok = $true; $res.output = ('CLICKED "' + $el.Current.Name + '" via ' + $how)
            }
          }
        }
      }
      'setvalue' {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.notFound = $true; $res.error = [string]$w.error }
        elseif (-not $w.el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $el = $w.el
          # 敏感标记：显式 secret=true / 控件本身是密码框 / 值来自凭据占位符 —— 三者任一都打码
          $secret = ((($step.PSObject.Properties.Name -contains 'secret') -and $step.secret)) -or (Is-SecretControl $el) -or (([string]$step.value) -match '^\$\{cred:')
          $raw = Resolve-Value ([string]$step.value)
          $v = Set-ElementValue $el $raw
          Start-Sleep -Milliseconds $waitMs
          $verify = Assert-ValueWritten $el $raw
          if ($verify) { $res.error = $verify } else {
            $res.ok = $true; $res.output = ('SET "' + (Mask-Value ([string]$step.value) $secret) + '" -> ' + (Mask-Value ([string]$v) $secret))
          }
        }
      }
      'key' {
        # focus=true：不定位控件，直接把按键发给当前焦点（列表行选中后按 F5 这类）
        $focusOnly = (($step.PSObject.Properties.Name -contains 'focus') -and $step.focus)
        if ($focusOnly) {
          $kv = [string]$step.value
          if ($kv -match '^\{[A-Za-z0-9]+\}$' -or $kv -match '[\^%+~]') {
            $null = [System.Windows.Forms.SendKeys]::SendWait($kv)
          } elseif ($kv -match '^[\x20-\x7e]+$') {
            Send-TextDirect $kv
          } else {
            $null = [System.Windows.Forms.SendKeys]::SendWait($kv)
          }
          Start-Sleep -Milliseconds $waitMs
          $res.ok = $true; $res.output = ('KEYED ' + $kv + ' to focused element')
        } else {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.notFound = $true; $res.error = [string]$w.error }
        elseif (-not $w.el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $el = $w.el
          $secret = (($step.PSObject.Properties.Name -contains 'secret') -and $step.secret)
          $raw = Resolve-Value ([string]$step.value)
          Send-KeyTo $el $raw ([bool]$step.ascii) $waitMs
          $verify = Assert-ValueWritten $el $raw
          if ($verify) { $res.error = $verify } else {
            $res.ok = $true; $res.output = ('KEYED "' + (Mask-Value ([string]$step.value) $secret) + '" into ' + $el.Current.AutomationId)
          }
        }
        }
      }
      'type' {
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.notFound = $true; $res.error = [string]$w.error }
        elseif (-not $w.el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $el = $w.el
          $keys = [string]$step.value
          if (($step.PSObject.Properties.Name -contains 'keys') -and $step.keys) { $keys = [string]$step.keys }
          $literal = $false
          if (($step.PSObject.Properties.Name -contains 'ascii') -and $step.ascii) { $literal = $true }
          Send-TypeTo $el $keys $literal
          Start-Sleep -Milliseconds $waitMs
          # type 常见用途是回车/Tab 提交，不强制回读；给了 expectValue 才校验
          if (($step.PSObject.Properties.Name -contains 'expectValue') -and $null -ne $step.expectValue) {
            $verify = Assert-ValueWritten $el ([string]$step.expectValue)
            if ($verify) { $res.error = $verify } else { $res.ok = $true; $res.output = ('TYPED "' + $keys + '" into ' + $el.Current.AutomationId + '（回读一致）') }
          } else {
            $res.ok = $true; $res.output = ('TYPED "' + $keys + '" into ' + $el.Current.AutomationId)
          }
        }
      }
      'drag' {
        $fx = 0; $fy = 0; $tx = 0; $ty = 0; $dst = 0; $hold = 120
        if (($step.PSObject.Properties.Name -contains 'fromX') -and $null -ne $step.fromX) { $fx = [int]$step.fromX }
        if (($step.PSObject.Properties.Name -contains 'fromY') -and $null -ne $step.fromY) { $fy = [int]$step.fromY }
        if (($step.PSObject.Properties.Name -contains 'toX') -and $null -ne $step.toX) { $tx = [int]$step.toX }
        if (($step.PSObject.Properties.Name -contains 'toY') -and $null -ne $step.toY) { $ty = [int]$step.toY }
        if (($step.PSObject.Properties.Name -contains 'steps') -and $null -ne $step.steps) { $dst = [int]$step.steps }
        if (($step.PSObject.Properties.Name -contains 'holdMs') -and $null -ne $step.holdMs) { $hold = [int]$step.holdMs }
        $mods = ''
        if (($step.PSObject.Properties.Name -contains 'mods') -and $step.mods) { $mods = [string]$step.mods }
        $out = Invoke-WithMods $mods { Invoke-Drag $main $fx $fy $tx $ty $dst $hold }
        Start-Sleep -Milliseconds $waitMs
        $res.ok = $true; $res.output = ([string]$out)
      }
      'move' {
        # 鼠标移到窗口客户区坐标（K线十字光标：移动后截图看读数）
        $mx = 0; $my = 0; $hold = 200
        if (($step.PSObject.Properties.Name -contains 'x') -and $null -ne $step.x) { $mx = [int]$step.x }
        if (($step.PSObject.Properties.Name -contains 'y') -and $null -ne $step.y) { $my = [int]$step.y }
        if (($step.PSObject.Properties.Name -contains 'holdMs') -and $null -ne $step.holdMs) { $hold = [int]$step.holdMs }
        $out = Invoke-Move $main $mx $my $hold
        Start-Sleep -Milliseconds $waitMs
        $res.ok = $true; $res.output = $out
      }
      'clickat' {
        # 坐标点击（窗口客户区坐标）：表格行、图表点位这类 UIA 拿不到稳定元素的地方
        $cx = 0; $cy = 0; $dbl = $false; $btn = 'left'
        if (($step.PSObject.Properties.Name -contains 'x') -and $null -ne $step.x) { $cx = [int]$step.x }
        if (($step.PSObject.Properties.Name -contains 'y') -and $null -ne $step.y) { $cy = [int]$step.y }
        if (($step.PSObject.Properties.Name -contains 'double') -and $step.double) { $dbl = $true }
        if (($step.PSObject.Properties.Name -contains 'button') -and $step.button) { $btn = [string]$step.button }
        $out = Invoke-ClickAt $main $cx $cy $dbl $btn
        Start-Sleep -Milliseconds $waitMs
        $res.ok = $true; $res.output = $out
      }
      'doubleclick' {
        # UIA 元素级双击（表格行进详情等）：用 GetClickablePoint，不靠坐标换算
        $w = Wait-Target $main $step $waitSpec $procId
        if (-not $w.ok) { $res.notFound = $true; $res.error = [string]$w.error }
        elseif (-not $w.el) { $res.notFound = $true; $res.error = '未找到目标控件' }
        else {
          $out = Invoke-DoubleClickElement $w.el $main
          Start-Sleep -Milliseconds $waitMs
          $res.ok = $true; $res.output = ([string]$out)
        }
      }
      'wheel' {
        # 滚轮（K线缩放/平移、列表滚动）；delta>0 上滚，count 为次数
        $wx = 0; $wy = 0; $delta = -120; $count = 1; $hold = 120
        if (($step.PSObject.Properties.Name -contains 'x') -and $null -ne $step.x) { $wx = [int]$step.x }
        if (($step.PSObject.Properties.Name -contains 'y') -and $null -ne $step.y) { $wy = [int]$step.y }
        if (($step.PSObject.Properties.Name -contains 'delta') -and $null -ne $step.delta) { $delta = [int]$step.delta }
        if (($step.PSObject.Properties.Name -contains 'count') -and $null -ne $step.count) { $count = [int]$step.count }
        if (($step.PSObject.Properties.Name -contains 'holdMs') -and $null -ne $step.holdMs) { $hold = [int]$step.holdMs }
        $mods = ''
        if (($step.PSObject.Properties.Name -contains 'mods') -and $step.mods) { $mods = [string]$step.mods }
        $out = Invoke-WithMods $mods { Invoke-Wheel $main $wx $wy $delta $count $hold }
        Start-Sleep -Milliseconds $waitMs
        $res.ok = $true; $res.output = ([string]$out)
      }
      'read' {
        $match = [string]$step.match
        $lines = New-Object System.Collections.ArrayList
        $attempt = 0
        while ($true) {
          $attempt++
          $lines = New-Object System.Collections.ArrayList
          $seen = @{}
          $all = $null
          try { $all = $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { $all = $null }
          if ($null -ne $all) {
          for ($i = 0; $i -lt $all.Count; $i++) {
          $el = $null
          try { $el = $all.Item($i) } catch { continue }
          if ($null -eq $el) { continue }
          $cur = $null
          try { $cur = $el.Current } catch { continue }
          if ($null -eq $cur) { continue }
          if ($cur.IsOffscreen) { continue }
          $t = Get-ControlTypeName $el
          if ($t -notin @('Button', 'Edit', 'Text', 'RadioButton', 'CheckBox', 'TabItem', 'ComboBox', 'ListItem', 'MenuItem', 'TreeItem', 'DataItem', 'Hyperlink', 'Image', 'Slider', 'Spinner', 'Group', 'Custom', 'Pane', 'Document')) { continue }
          $n = $cur.Name
          if (-not $n) { $n = '' }
          if ($n.Length -gt 60) { $n = $n.Substring(0, 60) }
          $help = ''
          try { $help = [string]$cur.HelpText } catch { }
          if ($match -and ($n -notmatch $match) -and ($help -notmatch $match)) { continue }
          $b = $cur.BoundingRectangle
          $val = ''
          if ($t -in @('Edit', 'ComboBox', 'Document')) { $val = Get-ElementValueForReport $el }
          if ($val.Length -gt 60) { $val = $val.Substring(0, 60) }
          # 同名同坐标只留一条（UIA 里 TextBlock 常被内外层各报一次）
          $key = $t + '|' + $n + '|' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y)
          if ($seen.ContainsKey($key)) { continue }
          $seen[$key] = $true
          $line = '#' + $lines.Count + ' [' + $t + '] "' + $n + '" aid="' + $cur.AutomationId + '" enabled=' + $cur.IsEnabled + ' @' + (Get-SafeInt $b.X) + ',' + (Get-SafeInt $b.Y) + ' ' + (Get-SafeInt $b.Width) + 'x' + (Get-SafeInt $b.Height)
          if ($help) { $line = $line + ' help="' + $help + '"' }
          if ($val -and $val -ne $n) { $line = $line + ' value="' + $val + '"' }
          [void]$lines.Add($line)
          # 已经够 300 行就停：继续遍历整棵树只为了截断，纯浪费（read 曾 22s）
          if ($lines.Count -ge 320) { break }
          }
          }
          if ($lines.Count -gt 0 -or -not $match -or $attempt -ge 2) { break }
          Start-Sleep -Milliseconds 250
        }
        $res.ok = $true; $res.count = $lines.Count; $res.attempts = $attempt
        # 单次 read 上限 300 行：主界面可达 900+ 条，全量返回会挤爆模型上下文
        # （需要全量时分 match 多次读，或用 state 只看交互控件）
        if ($lines.Count -gt 300) {
          $res.lines = @($lines | Select-Object -First 300)
          $res.truncated = $true
        } else {
          $res.lines = $lines
        }
      }
      'shot' {
        $s = Save-Shot $main ([string]$step.out)
        $res.ok = $true; $res.path = $s.path; $res.w = $s.w; $res.h = $s.h
      }
      'capture' {
        # agent 实时视图专用：抓「窗口内容」而非屏幕合成区域。
        # 与 shot 的区别（都是踩过或被评审指出的坑）：
        #   - 不 ShowWindow(SW_RESTORE)/不 SetForegroundWindow → 绝不抢用户焦点；
        #   - 最小化（IsIconic）或不可见时直接返回 state，不强制恢复；
        #   - PrintWindow(PW_RENDERFULLCONTENT) 优先 → 被遮挡也能拿到窗口自身内容
        #     （CopyFromScreen 抓的是屏幕矩形，实时循环每 1-2s 一次会把别的窗口内容
        #     当客户端画面喂给 agent——变化检测会撒谎、隐私会外溢）。
        #   - 主窗口解析：绝不用 Process.MainWindowHandle——它返回「第一个可见窗口」，
        #     输入法状态条（CiceroUIWndFrame）会抢先命中（实测 47x23 图标被抓成画面）。
        #   - 主窗口解析：绝不用 Process.MainWindowHandle——它返回「第一个可见窗口」，
        #     输入法状态条（CiceroUIWndFrame）会抢先命中（实测 47x23 图标被抓成画面）。
        #     解析顺序：① UIA 按 WindowName 匹配（Current.Name 是 WPF 原生标题，可靠——
        #     GetWindowTextW 对 WPF 自绘窗口返回垃圾字符，实测某 WPF 自绘标题栏客户端标题被读成乱码 4 字符，
        #     Win32 匹配永远失败）；② 不行再 Win32 枚举 + 可见窗口标题最长者兜底
        #     （DSH 浏览器窗口标题较长可能抢赢，所以 ① 必须可行才是主路径）。
        # 返回：{path,w,h,state:visible|minimized|hidden|nowindow,captureMethod:print|screen,pid,window}
        $sp = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $sp) { $res.error = ('进程未运行: ' + $procId) }
        else {
          $h = [IntPtr]::Zero
          # ① UIA 原名匹配（WPF 主窗口标题可靠）
          if ($WindowName) {
            try {
              $uaWins = Get-WindowElements $procId
              for ($i = 0; $i -lt $uaWins.Count; $i++) {
                if ([string]$uaWins[$i].Current.Name -eq $WindowName) { $h = [IntPtr]$uaWins[$i].Current.NativeWindowHandle; break }
              }
            } catch { }
          }
          # ② Win32 兜底：可见窗口里挑标题最长（主窗口）；全不可见/无标题 → 无窗口
          if ($h -eq [IntPtr]::Zero) {
            $hwnds = Get-ProcessTopWindows $procId
            $best = $null
            for ($i = 0; $i -lt $hwnds.Count; $i++) {
              $wd = $hwnds[$i]
              if (-not $wd.Visible) { continue }
              if (-not $wd.Title) { continue }
              if ($null -eq $best -or $wd.Title.Length -gt $best.Title.Length) { $best = $wd }
            }
            if ($best) { $h = $best.Handle }
          }
          if ($h -eq [IntPtr]::Zero) { $res.ok = $true; $res.state = 'nowindow' }
          elseif ([UiDriveBatchWin32]::IsIconic($h)) { $res.ok = $true; $res.state = 'minimized' }
          elseif (-not [UiDriveBatchWin32]::IsWindowVisible($h)) { $res.ok = $true; $res.state = 'hidden' }
          else {
            $r = New-Object UiDriveBatchWin32+RECT
            [UiDriveBatchWin32]::GetWindowRect($h, [ref]$r) | Out-Null
            $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
            if ($w -le 0 -or $hh -le 0) { $res.ok = $true; $res.state = 'nowindow' }
            else {
              $outPath = [string]$step.out
              if (-not $outPath) { $outPath = Join-Path $env:TEMP ('uia-capture-' + (Get-Date -Format 'HHmmss') + '.png') }
              $dir = Split-Path -Parent $outPath
              if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
              $bmp = New-Object System.Drawing.Bitmap($w, $hh)
              $g = [System.Drawing.Graphics]::FromImage($bmp)
              $hdc = $g.GetHdc()
              $method = 'print'
              # PW_RENDERFULLCONTENT=2：抓 DWM 合成后的窗口内容（含 WPF），
              # 某些无 DWM 的窗口会失败 → 退回 CopyFromScreen（记 captureMethod 区别）。
              $ok = [UiDriveBatchWin32]::PrintWindow($h, $hdc, 2)
              $g.ReleaseHdc($hdc)
              if (-not $ok) {
                $method = 'screen'
                # 退回屏幕矩形抓取：需要窗口在前台才有意义（被遮挡时画的是别人的内容）
                $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
              }
              $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
              $g.Dispose(); $bmp.Dispose()
              $res.ok = $true; $res.path = $outPath; $res.w = $w; $res.h = $hh
              $res.state = 'visible'; $res.captureMethod = $method
            }
          }
          if ($sp) { $res.pid = $sp.Id; $res.window = [string]$sp.MainWindowTitle }
        }
      }
      default {
        $res.error = '非法动作 ' + $action
      }
    })
  } catch {
    $res.ok = $false
    $res.error = $_.Exception.Message
  }
  # 只返回结果对象本身：PS 5.1 会把 try 块内未抑制的表达式结果一起放进函数输出，
  # 外层拿到 Object[] 就会在 Remove/Keys 上崩（表现为「集合的大小是固定的」）。
  return ,$res
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
          # 脚本被改过（开发中热改）→ 让 Node 侧重启常驻进程，避免跑到旧代码。
          # 口径必须与 Node 的 statSync().mtimeMs 一致：Ticks(100ns)/10000 = 毫秒。
          # 曾经直接用 Ticks 比 mtimeMs，单位不一致 → 每个请求都误判 STALE_SCRIPT，
          # 常驻进程自杀、所有动作退化到 30s+ 的一次性进程路径（夜间循环被拖死）。
          if ($ScriptStamp) {
            try {
              # 用 DateTimeOffset 转 Unix 毫秒，与 Node 的 statSync().mtimeMs 同口径
              $cur = [string]([DateTimeOffset]::new([System.IO.File]::GetLastWriteTimeUtc($PSCommandPath)).ToUnixTimeMilliseconds())
              if ($cur -ne $ScriptStamp) {
                $resp.ok = $false
                $resp.error = 'STALE_SCRIPT'
                $writer.WriteLine('RESP_JSON=' + (AsciiJson $resp))
                exit 0
              }
            } catch { }
          }
          $wantAction = 'step'
          if ($req.PSObject.Properties.Name -contains 'action' -and $req.action) { $wantAction = [string]$req.action }
          $wantAction = $wantAction.Trim().ToLowerInvariant()
          # 请求里带了 procId 且与当前不同 → 换目标进程（多客户端/测试宿主场景），并重解析窗口
          if ($req.PSObject.Properties.Name -contains 'procId' -and $null -ne $req.procId -and [int]$req.procId -gt 0 -and [int]$req.procId -ne $procId) {
            $procId = [int]$req.procId
            $main = $null
          }
          if (@('windows','expectwindow','expecttext','waitany','capture','state-live') -contains $wantAction) {
            # 窗口枚举/捕获/免前台状态采样不需要主窗口（登录窗口/弹窗场景下主窗口可能都还没出现；
            # capture 直接在窗口消失时返回 state；state-live 自行解析主窗口元素且绝不抢前台
            # —— live 后台循环的「非侵入」承诺靠这张清单 + state-live 分支保证）
            $procId = Get-ClientPid
            $res = Invoke-Step $null $req 0 $procId
          } else {
            # 客户端可能已重启（PID 变化）：缓存的 $main 指向已销毁的窗口 → UIA 遍历静默返回空。
            # 实测：不校验的话，客户端重启后 read 会 5s 返回 n=0，所有断言假失败。
            $livePid = Get-ClientPid
            if ($livePid -ne $procId) { $procId = $livePid; $main = $null }
            if ($main) {
              # 失效的 UIA 元素访问 .Current 不一定抛异常（可能返回缓存值），
              # 必须比对 ProcessId：与当前客户端 PID 不一致就是死元素，重解析。
              try {
                if ([int]$main.Current.ProcessId -ne $procId) { $main = $null }
              } catch { $main = $null }
            }
            if (-not $main) {
              $procId = Get-ClientPid
              $main = Get-MainWindow $procId
              if (-not $main) { throw ('未找到主窗口（' + $WindowName + '）') }
              # 只读动作绝不改变窗口状态；输入/截图类才需要前台。
              # 旧实现无条件 ShowWindow(SW_RESTORE)：对已最大化窗口等价于「还原成非最大化」
              # → 每次工具调用窗口尺寸都变（用户可见的“缩小一下”），也让所有坐标标定失效
              # （K 线缩放/平移坐标漂移的真正根因）。
              $mh = [IntPtr]$main.Current.NativeWindowHandle
              if ([UiDriveBatchWin32]::IsIconic($mh)) {
                [UiDriveBatchWin32]::ShowWindow($mh, 9) | Out-Null
                Start-Sleep -Milliseconds 200
              }
              if (Test-NeedsForeground $req) {
                [UiDriveBatchWin32]::SetForegroundWindow($mh) | Out-Null
                Start-Sleep -Milliseconds 150
              }
            }
            $res = Invoke-Step $main $req 0 $procId
          }
          # Invoke-Step 出错时返回的可能不是 hashtable（PS 5.1 的 ErrorRecord 会混进管道），
          # 这里做形状保护：否则 Remove 的二次异常会盖掉真正的错误信息（排查黑洞）。
          if ($res -is [hashtable] -or $res -is [System.Collections.IDictionary]) {
            if ($res.Contains('step')) { $res.Remove('step') | Out-Null }
            $stepOk = ($res['ok'] -eq $true)
            foreach ($k in $res.Keys) { $resp[$k] = $res[$k] }
            $resp.ok = $stepOk
          } else {
            $resp.ok = $false
            $resp.error = ('步骤返回了非预期类型 ' + ($res.GetType().FullName) + '：' + ([string]$res))
          }
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
# windows/capture/state-live 动作只枚举顶层窗口/抓 MainWindowHandle/免前台采样，
# 不依赖主窗口（登录页/弹窗阶段主窗口可能还没出现）
$needsMain = $false
for ($i = 0; $i -lt $steps.Count; $i++) {
  if (@('windows','expectwindow','expecttext','waitany','capture','state-live') -notcontains [string]$steps[$i].action) { $needsMain = $true; break }
}
$main = $null
if ($needsMain) {
  $main = Get-MainWindow $procId
  if (-not $main) { throw ('未找到主窗口（' + $WindowName + '）' ) }
  $mh = [IntPtr]$main.Current.NativeWindowHandle
  if ([UiDriveBatchWin32]::IsIconic($mh)) {
    [UiDriveBatchWin32]::ShowWindow($mh, 9) | Out-Null
    Start-Sleep -Milliseconds 200
  }
  $needsFg = $false
  for ($i = 0; $i -lt $steps.Count; $i++) { if (Test-NeedsForeground $steps[$i]) { $needsFg = $true; break } }
  if ($needsFg) {
    [UiDriveBatchWin32]::SetForegroundWindow($mh) | Out-Null
    Start-Sleep -Milliseconds 200
  }
}

$results = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $steps.Count; $i++) {
  [void]$results.Add((Invoke-Step $main $steps[$i] $i $procId))
}
$sw.Stop()

$winName = ''
if ($main) { $winName = $main.Current.Name }
$payload = @{ ok = $true; steps = $results; elapsedMs = [int]$sw.ElapsedMilliseconds; pid = $procId; window = $winName }
$json = $payload | ConvertTo-Json -Depth 8 -Compress
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output ('RESULT_JSON=' + $json)
