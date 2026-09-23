<#
  uia-enum-probe.ps1 — UIA 枚举的成本归因（只读，不改界面、不点击）。

  背景：`state`（ui_observe / ui_drive action=state / ui_jev 每步的观察）在本机实测 p50 约 5.7 s
  （ui_observe 自己回报"共扫描到 2799 个元素"），且**与 max 无关**（max=40 也要 5.4 s）
  —— 贵在"走完整棵树"，不在"渲染多少行"。本探针在同一台机器、同一次会话里量 5 条写法：

    A 现状      ：FindAll(Descendants, TrueCondition) + 逐元素 .Current 读属性
    C 类型条件  ：FindAll(Descendants, OrCondition(<15 个交互 ControlType>))
    E 控件视图  ：FindAll(Descendants, PropertyCondition(IsControlElement, true))
                  —— C/E 用来验证"provider 端少返回元素能不能变快"
    D 定向查找  ：FindAll(Descendants, PropertyCondition(Name, <样本>))，即 resolve 走的那条路
    S 子树起算  ：从**某个子容器**起算 Descendants —— 验证"成本是否与子树规模成正比"
                  （若成正比，把观察 scope 到容器就是有效的省时手段；若仍是 5 s，就不是）

  任何一条替代路要能用，必须给出**与 A 相同的控件集合**（逐元素签名比对）。

  用法：
    pwsh -File scripts/uia-enum-probe.ps1 -ProcName <进程名> -WindowName <窗口名> -Repeat 3
#>
param(
  [string]$ProcName = $env:DSH_UI_PROC_NAME,
  [string]$WindowName = $env:DSH_UI_WINDOW_NAME,
  [int]$ProcId = 0,
  [int]$Repeat = 3,
  [string]$NameSample = '',
  [int]$ScanChildren = 3
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

$INTERACTIVE = @('Button', 'Edit', 'RadioButton', 'CheckBox', 'TabItem', 'ComboBox', 'ListItem',
  'MenuItem', 'TreeItem', 'DataItem', 'Hyperlink', 'Slider', 'Spinner', 'Document', 'Custom')

if (-not $ProcId) {
  if (-not $ProcName) { throw '需要 -ProcName 或 -ProcId（或用 DSH_UI_PROC_NAME 配置）' }
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { throw "进程未运行：$ProcName" }
  $ProcId = $p.Id
}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcId)
$wins = $AE::RootElement.FindAll($TS::Children, $pidCond)
$el = $wins | Where-Object { -not $WindowName -or $_.Current.Name -eq $WindowName } | Select-Object -First 1
if (-not $el) { throw "没找到 pid=$ProcId 的顶层窗口（WindowName=$WindowName）" }
$rootName = $el.Current.Name

$typeConds = @()
foreach ($t in $INTERACTIVE) { $typeConds += New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t) }
$typedCond = New-Object System.Windows.Automation.OrCondition($typeConds)
$viewCond = New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)

function Test-Interactive($c) {
  $t = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
  if ($t -notin $INTERACTIVE) { return $null }
  if ($c.IsOffscreen) { return $null }
  $r = $c.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
  return @{ type = $t; sig = ("{0}|{1}|{2}|{3},{4}" -f $t, $c.Name, $c.AutomationId, [int]$r.X, [int]$r.Y) }
}

function Measure-From($node, $condition) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $all = $node.FindAll($TS::Descendants, $condition)
  $walkMs = $sw.Elapsed.TotalMilliseconds
  $sigs = New-Object System.Collections.Generic.List[string]
  $types = @{}
  for ($i = 0; $i -lt $all.Count; $i++) {
    try { $x = Test-Interactive $all.Item($i).Current } catch { continue }
    if (-not $x) { continue }
    [void]$sigs.Add($x.sig)
    $types[$x.type] = 1 + [int]$types[$x.type]
  }
  $sw.Stop()
  @{ total = $all.Count; interactive = $sigs.Count; walkMs = [math]::Round($walkMs, 1)
    totalMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); types = $types; sigs = $sigs }
}

$trueCond = [System.Windows.Automation.Condition]::TrueCondition
function Measure-True { Measure-From $el $trueCond }
function Measure-Typed { Measure-From $el $typedCond }
function Measure-View { Measure-From $el $viewCond }
function Measure-Name([string]$name) {
  if (-not $name) { return $null }
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $all = $el.FindAll($TS::Descendants, $c)
  @{ name = $name; count = $all.Count; totalMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
}

# 顶层子元素（子树起算的样本）：只取一次，保证各轮比的是同一批容器
$children = @($el.FindAll($TS::Children, $trueCond) | Select-Object -First $ScanChildren)

$sample = $NameSample
if (-not $sample) { $sample = ((Measure-True).sigs | Select-Object -First 1) -split '\|' | Select-Object -Index 1 }

$result = @{ root = $rootName; pid = $ProcId; nameSample = $sample; repeats = @() }
for ($i = 0; $i -lt $Repeat; $i++) {
  $a = Measure-True
  $c = Measure-Typed
  $e = Measure-View
  $d = Measure-Name $sample
  $scoped = @()
  foreach ($ch in $children) {
    $s = Measure-From $ch $trueCond
    $scoped += @{ name = [string]$ch.Current.Name; aid = [string]$ch.Current.AutomationId
      type = ($ch.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '')
      total = $s.total; interactive = $s.interactive; walkMs = $s.walkMs; totalMs = $s.totalMs }
  }
  $setA = [System.Collections.Generic.HashSet[string]]::new([string[]]$a.sigs)
  $setC = [System.Collections.Generic.HashSet[string]]::new([string[]]$c.sigs)
  $setE = [System.Collections.Generic.HashSet[string]]::new([string[]]$e.sigs)
  $result.repeats += @{
    trueCond = @{ total = $a.total; interactive = $a.interactive; walkMs = $a.walkMs; totalMs = $a.totalMs; types = $a.types }
    typedCond = @{ total = $c.total; interactive = $c.interactive; walkMs = $c.walkMs; totalMs = $c.totalMs }
    viewCond = @{ total = $e.total; interactive = $e.interactive; walkMs = $e.walkMs; totalMs = $e.totalMs }
    nameSearch = $d
    scoped = $scoped
    typedSameSet = (@($setC | Where-Object { -not $setA.Contains($_) }).Count -eq 0)
    viewSameSet = (@($setE | Where-Object { -not $setA.Contains($_) }).Count -eq 0) -and (@($setA | Where-Object { -not $setE.Contains($_) }).Count -eq 0)
  }
  Write-Host ("轮 {0}: A(True) {1,6}ms walk={2,6} 返回{3,5} 交互{4,4} | C(类型) {5,6}ms 返回{6,5} | E(视图) {7,6}ms 返回{8,5} | D(按名) {9,5}ms 命中{10}" -f `
      ($i + 1), $a.totalMs, $a.walkMs, $a.total, $a.interactive, $c.totalMs, $c.total, $e.totalMs, $e.total,
      ($(if ($d) { $d.totalMs } else { 0 })), ($(if ($d) { $d.count } else { 0 })))
  foreach ($s in $scoped) {
    # aid 一定要印出来：**快的子树恰好可能是匿名容器** —— 没有 aid/没有 name 的容器
    # 用 inAid/inName 根本指不到，"限定范围"这条优化就落不了地（这是可行性判据，不是装饰）。
    Write-Host ("        子树 {0,-24} [{1,-9}] aid={2,-18} 返回{3,5} 交互{4,4} walk={5,7}ms 合计{6,7}ms" -f `
        ($(if ($s.name) { $s.name.Substring(0, [math]::Min(24, $s.name.Length)) } else { '(无名)' })), $s.type,
        ($(if ($s.aid) { $s.aid } else { '(无 aid)' })), $s.total, $s.interactive, $s.walkMs, $s.totalMs)
  }
  $result.repeats[$result.repeats.Count - 1].scoped = $scoped
}
$med = { param($vals) $s = @($vals | Sort-Object); $s[[math]::Floor($s.Count / 2)] }
$aMed = & $med ($result.repeats | ForEach-Object { $_.trueCond.totalMs })
$cMed = & $med ($result.repeats | ForEach-Object { $_.typedCond.totalMs })
$eMed = & $med ($result.repeats | ForEach-Object { $_.viewCond.totalMs })
$dMed = & $med ($result.repeats | ForEach-Object { $_.nameSearch.totalMs })
$result.summary = @{
  trueP50Ms = $aMed
  typedP50Ms = $cMed
  viewP50Ms = $eMed
  nameSearchP50Ms = $dMed
  typedSpeedup = [math]::Round($aMed / [math]::Max(1, $cMed), 2)
  viewSpeedup = [math]::Round($aMed / [math]::Max(1, $eMed), 2)
  typedSetsAlwaysMatch = -not ($result.repeats | Where-Object { -not $_.typedSameSet })
  viewSetsAlwaysMatch = -not ($result.repeats | Where-Object { -not $_.viewSameSet })
  scopedP50 = @($result.repeats | ForEach-Object { $_.scoped } | Group-Object { $_.type + '|' + $_.total } | ForEach-Object {
      $g = $_.Group; @{ label = $_.Name; elements = $g[0].total; interactive = $g[0].interactive; p50Ms = (& $med ($g | ForEach-Object { $_.totalMs })) } })
}
$result | ConvertTo-Json -Depth 8
