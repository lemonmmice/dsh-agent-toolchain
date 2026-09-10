<#
  dsh-ui-drive：read/state「跳过计数」的真路径现场验证（B-1 验收脚本）

  为什么需要它：单测（test/read-skips.test.mjs）只证明 Node 侧的字段映射；
  这份脚本证明**脚本层在真实 UIA 树持续变动时**确实「逐元素容错 + 报数」——
  旧版在这种窗口上会整段崩成 0 行，或者静默少几行而调用方毫不知情。

  做法：
    1. 起一个「疯狂重绘」的 WPF 窗口（自己的进程，与任何被测客户端无关）；
    2. 对它的 pid 跑 scripts/ui-drive-batch.ps1 的 read（真进程、真 UIA）；
    3. 断言 RESULT_JSON 里 skipped >= 1 且 count > 0（清单不空，且承认自己不完整）。

  用法（Windows PowerShell 5.1，与插件运行引擎一致）：
    powershell -NoProfile -ExecutionPolicy Bypass -File test\read-skips-live.ps1
    powershell ... -File test\read-skips-live.ps1 -Rounds 8 -OutDir D:\tmp\b1-evidence

  退出码：0 = 通过；1 = 未复现出 skipped（或清单为空）；2 = 环境问题（起不来窗口）
#>
param(
  [int]$BaseNodes = 200,       # 稳定基线控件数（永不改动 → 保证清单非空且可见）
  [int]$ChurnIntervalMs = 25,  # 虚拟化列表滚动/尾部拆建的间隔
  [int]$ChurnStartAfterMs = 5000, # 窗口起来多久后才开始 churn（前面几轮用来验「清单非空」）
  [int]$Rounds = 8,            # 最多跑几轮 read（瞬态元素是概率事件，跑多轮）
  [int]$Seconds = 120,         # 重绘窗口存活秒数
  [string]$OutDir = '',        # 证据目录，默认 %TEMP%\ui-drive-b1-read-skips
  [switch]$AsChurn             # 内部用：本进程充当「重绘窗口」宿主
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 疯狂重绘窗口
if ($AsChurn) {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
  $w = New-Object System.Windows.Window
  $w.Title = 'ChurnWin'
  $w.Width = 900; $w.Height = 600
  # 不能最小化：最小化会让所有元素 IsOffscreen=true，read 会把它们全过滤掉（清单变空，
  # 就验不出「清单非空 + 承认不完整」）。改成「右下角一个小窗 + 不抢焦点」。
  $w.ShowActivated = $false
  $w.WindowStartupLocation = 'Manual'
  $w.Left = [Math]::Max(0, [System.Windows.SystemParameters]::WorkArea.Right - 920)
  $w.Top = [Math]::Max(0, [System.Windows.SystemParameters]::WorkArea.Bottom - 640)
  # 内容分两段（两种「坏元素」形态各来一份）：
  #  A) 稳定基线：一次建好、永不改动的按钮 → 保证清单**非空且可见**（count>0）
  #  B) 虚拟化列表 + 高频滚动 → 容器不断实现/销毁，枚举途中快照里的元素会失效
  #     （这正是真实客户端 K 线/列表切换时「元素已失效」的形态；单纯高频重建整棵树的
  #      做法反而会让 WPF 来不及布局、全部元素 IsOffscreen=true，read 正常过滤成 0 行）
  $grid = New-Object System.Windows.Controls.Grid
  # 行高必须**固定**：Auto 行会随 churn 面板里控件的增删不断重排外层布局，
  # 结果连「不该动的基线按钮」也变成未渲染状态（实测 count 恒为 0 就是这个原因）。
  # 固定高度 + ClipToBounds 之后，churn 只影响它自己那一格。
  $rowBase = New-Object System.Windows.Controls.RowDefinition; $rowBase.Height = New-Object System.Windows.GridLength(200, [System.Windows.GridUnitType]::Pixel)
  $rowList = New-Object System.Windows.Controls.RowDefinition; $rowList.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
  $rowChurn = New-Object System.Windows.Controls.RowDefinition; $rowChurn.Height = New-Object System.Windows.GridLength(120, [System.Windows.GridUnitType]::Pixel)
  [void]$grid.RowDefinitions.Add($rowBase)
  [void]$grid.RowDefinitions.Add($rowList)
  [void]$grid.RowDefinitions.Add($rowChurn)
  $w.Content = $grid

  $list = New-Object System.Windows.Controls.ListBox
  # Standard（不是 Recycling）：容器会被真正销毁重建 → 枚举快照里的元素会失效
  [System.Windows.Controls.VirtualizingPanel]::SetVirtualizationMode($list, [System.Windows.Controls.VirtualizationMode]::Standard)
  $list.ItemsSource = (1..20000 | ForEach-Object { 'item' + $_ })
  [System.Windows.Controls.Grid]::SetRow($list, 1)
  [void]$grid.Children.Add($list)

  $panel = New-Object System.Windows.Controls.WrapPanel
  [System.Windows.Controls.Grid]::SetRow($panel, 0)
  [void]$grid.Children.Add($panel)
  $base = [Math]::Max(40, $BaseNodes)
  for ($i = 0; $i -lt $base; $i++) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = ('base' + $i)
    $b.Width = 60; $b.Height = 18
    [void]$panel.Children.Add($b)
  }

  # 第三个区：**尾部拆建 churn** —— 实测这一种才是真正逼出「元素已失效」的形态
  # （虚拟化列表滚动本身太温和，10 轮都没触发）。它会把快照里的元素在枚举途中销毁，
  # UIA 侧表现为 FindAll 直接抛「目标元素的对应 UI 不再可用」→ 整次枚举失败。
  $churnPanel = New-Object System.Windows.Controls.WrapPanel
  $churnPanel.ClipToBounds = $true
  [System.Windows.Controls.Grid]::SetRow($churnPanel, 2)
  [void]$grid.Children.Add($churnPanel)
  for ($i = 0; $i -lt 60; $i++) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = ('pre' + $i)
    $b.Width = 60; $b.Height = 18
    [void]$churnPanel.Children.Add($b)
  }
  $script:churnTick = 0
  $churnTimer = New-Object System.Windows.Threading.DispatcherTimer
  $churnTimer.Interval = [TimeSpan]::FromMilliseconds($ChurnIntervalMs)
  $churnTimer.Add_Tick({
    $script:churnTick++
    for ($k = 0; $k -lt 60; $k++) {
      if ($churnPanel.Children.Count -le 0) { break }
      $churnPanel.Children.RemoveAt($churnPanel.Children.Count - 1)   # 拆掉尾部
    }
    for ($i = 0; $i -lt 60; $i++) {
      $b = New-Object System.Windows.Controls.Button
      $b.Content = ('c' + $script:churnTick + '_' + $i)
      $b.Width = 60; $b.Height = 18
      [void]$churnPanel.Children.Add($b)                             # 重建（实例全换）
    }
  })
  # churnTimer 同样等到延迟启动点再开（见下面的 startTimer）

  $script:tick = 0
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds($ChurnIntervalMs)
  $timer.Add_Tick({
    $script:tick++
    # 大步长跳转（质数）→ 每次滚到完全不同的位置，容器成批销毁重建
    $idx = ($script:tick * 977) % 20000
    $list.ScrollIntoView($list.Items[$idx])
  })
  # 不立刻启动：先让调用方在「静止窗口」上验一次「清单非空」（阶段 A），
  # 再开始 churn 验「读不到的坏元素必须报数」（阶段 B）。
  $startTimer = New-Object System.Windows.Threading.DispatcherTimer
  $startTimer.Interval = [TimeSpan]::FromMilliseconds($ChurnStartAfterMs)
  $startTimer.Add_Tick({
    $timer.Start()
    $churnTimer.Start()
    $startTimer.Stop()
  })
  $startTimer.Start()
  $close = New-Object System.Windows.Threading.DispatcherTimer
  $close.Interval = [TimeSpan]::FromSeconds($Seconds)
  $close.Add_Tick({ $w.Close() })
  $close.Start()
  [void]$w.ShowDialog()
  exit 0
}

# ---------------------------------------------------------------- 主流程
$scriptDir = Split-Path -Parent $PSCommandPath
$batch = Join-Path (Split-Path -Parent $scriptDir) 'scripts\ui-drive-batch.ps1'
if (-not (Test-Path $batch)) { Write-Output ('FAIL: 找不到 ' + $batch); exit 2 }
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'ui-drive-b1-read-skips' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }

Write-Output ('[1/4] 启动重绘窗口（稳定基线 ' + $BaseNodes + ' + 虚拟化列表滚动 ' + $ChurnIntervalMs + 'ms）…')
# 两个踩过的坑，都写在这儿免得下次再踩：
#  1) 不能用 -WindowStyle Hidden：隐藏启动时 WPF 子元素**从未真正渲染**，枚举出来全部
#     IsOffscreen=true（实测 descendants≈17 / visible=0），read 会正常过滤成 0 行——
#     那样只能验出「整次枚举失败」，验不出「清单非空 **且** 承认不完整」。
#  2) powershell.exe 自带控制台窗口且 Name 非空，Get-MainWindow 会优先选中它（读到空控制台），
#     所以下面显式用 -WindowName 'ChurnWin' 定位目标窗口。
$churn = Start-Process -FilePath $psExe -PassThru -ArgumentList @(
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
  '-AsChurn', '-BaseNodes', $BaseNodes, '-ChurnIntervalMs', $ChurnIntervalMs, '-ChurnStartAfterMs', $ChurnStartAfterMs, '-Seconds', $Seconds
)
$churnPid = $churn.Id

# 等它的顶层窗口出现在 UIA 里（窗口没起来就 read 不到东西）
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$UIA = [System.Windows.Automation.AutomationElement]
$deadline = (Get-Date).AddSeconds(20)
$winCount = 0
while ((Get-Date) -lt $deadline) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, $churnPid)
  $wins = $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $winCount = $wins.Count
  if ($winCount -gt 0) { break }
  Start-Sleep -Milliseconds 300
}
if ($winCount -eq 0) { Write-Output ('FAIL: 重绘窗口没起来（pid=' + $churnPid + '）'); Stop-Process -Id $churnPid -Force -ErrorAction SilentlyContinue; exit 2 }
Write-Output ('      窗口已就绪 pid=' + $churnPid + ' 顶层窗口=' + $winCount)

$stepsFile = Join-Path $OutDir 'steps.json'
$outFile = Join-Path $OutDir 'result.json'
# 两步：read（验收主判据）+ state（另一条枚举路径，同样必须报数）
[System.IO.File]::WriteAllText($stepsFile, '[{"action":"read"},{"action":"state","max":40}]', (New-Object System.Text.UTF8Encoding($false)))

Write-Output ('[2/4] 对 pid=' + $churnPid + ' 跑 read/state（真进程 + 真 UIA），最多 ' + $Rounds + ' 轮…')
# 两个阶段（都在真实脚本层跑，各自独立可判定）：
#   阶段 A（churn 未启动）：read 必须拿到**非空清单** → 证明正常路径没坏、skipped 不是假警报；
#   阶段 B（churn 已启动）：read/state 必须回报 **skipped>=1** → 这就是 B-1 的核心：
#                          读不到的元素要**报数**，而不是静默少几行（旧版此时要么整段崩成 0 行、
#                          要么悄悄漏元素，调用方把「没读到」当成「界面上没有」）。
# 另加一条硬条件：任何一轮都不允许 ok!=true（异常要显式暴露，不能被当成「界面为空」）。
$phaseARounds = 3
$skippedRounds = 0
$nonEmptyRounds = 0
$badRounds = 0
$firstHit = $null
$log = New-Object System.Collections.ArrayList
for ($r = 1; $r -le $Rounds; $r++) {
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $batch -ProcId $churnPid -WindowName 'ChurnWin' -StepsFile $stepsFile -Out $outFile | Out-Null
  if (-not (Test-Path $outFile)) { [void]$log.Add("round $r : 无输出（脚本异常）"); $badRounds++; continue }
  $res = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $st = @($res.steps)[0]
  $stateStep = @($res.steps)[1]
  $sk = $st.skipped
  $stateSk = if ($stateStep) { $stateStep.skipped } else { $null }
  $phase = if ($r -le $phaseARounds) { 'A' } else { 'B' }
  $why = ''
  if ($st.skippedReasons) { $why = (@($st.skippedReasons) -join '；') }
  $stateNote = if ($stateStep) { "state: count=$($stateStep.count) skipped=$stateSk" } else { 'state: -' }
  if ($st.ok -ne $true) { $badRounds++ }
  $anySkip = (($null -ne $sk -and [int]$sk -ge 1) -or ($null -ne $stateSk -and [int]$stateSk -ge 1))
  if ($anySkip) { $skippedRounds++; if (-not $firstHit) { $firstHit = $st } }
  if ([int]$st.count -ge 1) { $nonEmptyRounds++ }
  [void]$log.Add("round $r (阶段$phase) : window=$($res.window) read: ok=$($st.ok) count=$($st.count) skipped=$sk attempts=$($st.attempts) | $stateNote | why=$why")
  Write-Output ('      round ' + $r + ' [阶段' + $phase + '] : read count=' + $st.count + ' skipped=' + $sk + ' | ' + $stateNote)
  if ($r -eq $phaseARounds) { Write-Output ('      —— 阶段 A 结束，等 churn 启动（' + $ChurnStartAfterMs + 'ms 后）——'); Start-Sleep -Milliseconds ($ChurnStartAfterMs + 800) }
}

Write-Output '[3/4] 清理重绘窗口…'
Stop-Process -Id $churnPid -Force -ErrorAction SilentlyContinue

$pass = ($skippedRounds -ge 1) -and ($nonEmptyRounds -ge 1) -and ($badRounds -eq 0)
Write-Output '[4/4] 结论：'
foreach ($l in $log) { Write-Output ('      ' + $l) }
$evidence = Join-Path $OutDir 'verdict.json'
$verdict = @{
  pass = $pass
  skippedRounds = $skippedRounds
  nonEmptyRounds = $nonEmptyRounds
  badRounds = $badRounds
  rounds = $Rounds
  baseNodes = $BaseNodes; churnIntervalMs = $ChurnIntervalMs
  firstSkippedRound = if ($firstHit) { @{ count = [int]$firstHit.count; skipped = [int]$firstHit.skipped; reasons = @($firstHit.skippedReasons) } } else { $null }
  log = @($log)
}
[System.IO.File]::WriteAllText($evidence, ($verdict | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('      证据：' + $evidence)

if (-not $pass) {
  Write-Output ('FAIL: 条件未满足（skipped 轮数=' + $skippedRounds + '，非空清单轮数=' + $nonEmptyRounds + '，异常轮数=' + $badRounds + '）')
  exit 1
}
Write-Output ('PASS: ' + $skippedRounds + ' 轮报出 skipped>=1（读不到的坏元素被计数），' + $nonEmptyRounds + ' 轮清单非空，且无异常轮')
exit 0
