// dsh-ui-drive W2 端到端测试：policy / 急停门真的挂在写侧单点上，且**被拒时执行器一次都没被调用**
//
// 为什么需要它：模块级单测（policy.test.mjs）只证明 `check()` 的返回值。
// 本测试走**完整驱动链路**（makeDriver → driveOnce → checkSideEffectGate → 假 PowerShell），
// 用哨兵文件数「执行器被调用的次数」，把"没被执行"落成可数的事实。
//
// 覆盖矩阵：deny 规则 / 无匹配规则 / 规则冲突 / 急停哨兵 / 未配置策略（对照组） / allow 规则（对照组）。
// 其中「未配置策略」对照组是**必须有的**：它证明本测试确实能观测到执行（否则全 0 的断言毫无意义）。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'ui-drive-w2e2e-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-w2e2e-ev-'))
const sentinel = join(dir, 'executed.log')
const statusSentinel = join(dir, 'status.log')

/** 假脚本：-Status 只回报身份（不写哨兵）；任何**真正执行**的路径都往哨兵追加一行。 */
function installFakeScripts() {
  const batch = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Status) {
  if ($env:FAKE_STATUS_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_STATUS_SENTINEL, 'status' + [Environment]::NewLine) }
  Write-Output 'RUNNING pid=4242 window=FakeWin'
  Write-Output 'HANDLE 777'
  $json = '{"exe":"C:/App/client.exe","exeCanonical":"c:/app/client.exe"}'
  Write-Output ('IDENT ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  Write-Output 'RECT 800x600 @0,0'
  exit 0
}
if ($Serve) {
  # Fake resident (serve) impl mirroring the real ui-drive-batch.ps1 -Serve protocol:
  #   ping -> {ok:true,pong:true} (handshake); any other request -> append one 'serve' line to the
  #   sentinel and reply ok. The unique 'serve' marker proves execution really went through the
  #   resident process (not a fallback to one-shot batch/oneshot). ASCII-only on purpose: this fake
  #   is written UTF-8 without BOM, and PowerShell 5.1 on a CN-locale host would GBK-mangle non-ASCII.
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
  $seq = 0
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $seq++
    try {
      $req = $line | ConvertFrom-Json
      $cmd = 'step'
      if ($req.PSObject.Properties.Name -contains 'cmd' -and $req.cmd) { $cmd = [string]$req.cmd }
      if ($cmd -eq 'ping') {
        $writer.WriteLine('RESP_JSON={"id":' + $seq + ',"ok":true,"pong":true}')
      } else {
        if ($env:FAKE_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_SENTINEL, 'serve' + [Environment]::NewLine) }
        $act = 'step'
        if ($req.PSObject.Properties.Name -contains 'action' -and $req.action) { $act = [string]$req.action }
        $writer.WriteLine('RESP_JSON={"id":' + $seq + ',"ok":true,"action":"' + $act + '","output":"CLICKED"}')
      }
    } catch {
      $writer.WriteLine('RESP_JSON={"id":' + $seq + ',"ok":false,"error":"parse"}')
    }
  }
  exit 0
}
if ($env:FAKE_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_SENTINEL, 'batch' + [Environment]::NewLine) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  // 一次性脚本路径（click/setvalue/key 等非 batch-only 动作走这里）——它被执行就记一次
  const oneShot = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='',[string]$Value='',[int]$WaitMs=250,[switch]$Ascii,[string]$Match='',[string]$Out='')
if ($env:FAKE_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_SENTINEL, 'oneshot' + [Environment]::NewLine) }
Write-Output 'NOT_FOUND'
`
  writeFileSync(join(dir, 'ui-drive-batch.ps1'), batch, 'utf8')
  writeFileSync(join(dir, 'ui-drive.ps1'), oneShot, 'utf8')
  writeFileSync(join(dir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_SENTINEL = sentinel
  process.env.FAKE_STATUS_SENTINEL = statusSentinel
  process.env.FAKE_BATCH_PAYLOAD = JSON.stringify({ ok: true, elapsedMs: 3, steps: [{ step: 1, action: 'click', ok: true, output: 'CLICKED "x"' }] })
}

function resetSentinel() { if (existsSync(sentinel)) rmSync(sentinel) }
function execCount() {
  if (!existsSync(sentinel)) return 0
  return readFileSync(sentinel, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length
}
/** 哨兵原文（用于区分执行走的是哪条路径：serve / batch / oneshot）。 */
function sentinelText() { return existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : '' }

function newDriver() {
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir: dir, evidenceDir, procName: 'FakeProc' })
}

/** 常驻 serve 路径的 driver（DSH_UI_SERVE=1）。用于证明门在 serve 路径同样先于执行生效。 */
function newServeDriver() {
  process.env.DSH_UI_SERVE = '1'
  process.env.DSH_UI_SERVE_IDLE_MS = '60000'
  return makeDriver({ scriptsDir: dir, evidenceDir, procName: 'FakeProc' })
}

/** 每次用例前把三个 env 清干净，避免互相污染。 */
function clearEnv() {
  delete process.env.DSH_UI_APP_POLICY
  delete process.env.DSH_UI_ESTOP_FILE
  delete process.env.DSH_UI_SAFETY_POLICY_FILE
}

function writePolicy(name, rules) {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(rules), 'utf8')
  return p
}

installFakeScripts()

// ------------------------------------------------- 对照组 1：未配置策略 → 执行器**必须**被调用
// （这条是本测试的"自检"：若它不通过，说明哨兵观测不到执行，后面所有 0 的断言都没有意义）
{
  clearEnv()
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('【自检】未配置策略时执行器确实被调用（哨兵>0）', execCount() > 0, 'sentinel=' + execCount() + ' r=' + JSON.stringify(r).slice(0, 120))
  d.warmShutdown()
}

// ------------------------------------------------- 用例 1：规则 deny → 拒绝 + 执行器 0 次
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('deny.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('deny 规则 → 拒绝', r.ok === false, JSON.stringify(r).slice(0, 160))
  check('deny 规则 → 带稳定码 policy_unavailable', r.policyCode === 'policy_unavailable', String(r.policyCode))
  check('deny 规则 → **执行器调用计数 = 0**', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 2：allowSideEffects=true 也解锁不了 deny
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('deny2.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true, force: true })
  check('deny + force 仍拒绝且未执行', r.ok === false && execCount() === 0, JSON.stringify(r).slice(0, 140) + ' sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 3：配了策略但无匹配规则 → deny-first
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('other.json', [{ exe: 'C:/Other/app.exe', effect: 'allow' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('无匹配规则 → 拒绝（deny-first）', r.ok === false, JSON.stringify(r).slice(0, 160))
  check('无匹配规则 → 执行器调用计数 = 0', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 4：规则冲突（同身份 allow+deny）→ 拒绝
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('conflict.json', [
    { exe: 'C:/App/client.exe', effect: 'allow' },
    { exe: 'c:/app/client.exe', effect: 'deny' },
  ])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('规则冲突 → policy_conflict', r.policyCode === 'policy_conflict', String(r.policyCode))
  check('规则冲突 → 执行器调用计数 = 0', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 5：策略文件解析失败 → 拒绝
{
  clearEnv()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ 这不是 JSON', 'utf8')
  process.env.DSH_UI_APP_POLICY = bad
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('策略解析失败 → 拒绝', r.ok === false, JSON.stringify(r).slice(0, 140))
  check('策略解析失败 → 执行器调用计数 = 0', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 6：急停哨兵（**不配策略也要生效**）→ 拒绝 + 0 次
{
  clearEnv()
  const estop = join(dir, 'ESTOP')
  writeFileSync(estop, 'stop', 'utf8')
  process.env.DSH_UI_ESTOP_FILE = estop
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('急停（未配策略）→ stopped_by_user', r.policyCode === 'stopped_by_user', String(r.policyCode))
  check('急停 → 执行器调用计数 = 0', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 对照组 2：规则 allow → 执行器**必须**被调用
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('allow.json', [{ exe: 'C:/App/client.exe', effect: 'allow' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('【自检】allow 规则时执行器被调用（哨兵>0）', execCount() > 0, 'sentinel=' + execCount() + ' r=' + JSON.stringify(r).slice(0, 120))
  d.warmShutdown()
}

// ------------------------------------------------- 用例 7：只读动作不受 policy 门影响
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('deny3.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.drive({ action: 'read', match: 'x' })
  check('只读动作不受 policy 门影响（不被 deny 规则拦）', r.policyCode === undefined, JSON.stringify(r).slice(0, 140))
  d.warmShutdown()
}

// ------------------------------------------------- 用例 8：ui_flow 的副作用步**不得绕过** policy 门
// （集成时发现的绕过口：flow 原先只查 allowSideEffects，policy deny 与急停哨兵对它完全失效）
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('deny-flow.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.flow({ steps: [{ action: 'click', name: '确定' }], tag: 'w2e2e-deny', allowSideEffects: true })
  check('ui_flow + deny 规则 → 整段被拒', r.ok === false && r.policyCode === 'policy_unavailable', JSON.stringify(r).slice(0, 160))
  check('ui_flow + deny 规则 → **执行器调用计数 = 0**', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 9：ui_flow 也不得绕过急停（外部总闸）
{
  clearEnv()
  const estop = join(dir, 'ESTOP2')
  writeFileSync(estop, 'stop', 'utf8')
  process.env.DSH_UI_ESTOP_FILE = estop
  resetSentinel()
  const d = newDriver()
  const r = await d.flow({ steps: [{ action: 'click', name: '确定' }], tag: 'w2e2e-estop', allowSideEffects: true })
  check('ui_flow + 急停 → stopped_by_user', r.policyCode === 'stopped_by_user', String(r.policyCode))
  check('ui_flow + 急停 → 执行器调用计数 = 0', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 对照组 3：未配置策略时 ui_flow 照常执行（不能被误杀）
{
  clearEnv()
  resetSentinel()
  const d = newDriver()
  const r = await d.flow({ steps: [{ action: 'click', name: '确定' }], tag: 'w2e2e-ok', allowSideEffects: true })
  check('【自检】未配置策略时 ui_flow 仍会执行（哨兵>0）', execCount() > 0, 'sentinel=' + execCount() + ' r=' + JSON.stringify(r).slice(0, 120))
  d.warmShutdown()
}

// ------------------------------------------------- 用例 10：纯只读 flow 不受 policy 门影响
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('deny-flow2.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.flow({ steps: [{ action: 'read', match: 'x' }], tag: 'w2e2e-read' })
  check('纯只读 ui_flow 不被 policy 门拦截', r.policyCode === undefined, JSON.stringify(r).slice(0, 140))
  d.warmShutdown()
}

// ------------------------------------------------- 用例 11（洞 #3 回归）：flow **逐步**过门，按 aid 的规则不得漏
// 复核复现的原缺陷：只判 sideEffectSteps[0] → steps=[ok,sell] 放行、[sell,ok] 拒绝（同一组规则顺序不同结论相反）。
{
  clearEnv()
  // 规则只允许 aid="ok"：同一 exe 下，第二步 aid="sell" 没有任何规则匹配 → 必须整段拒
  process.env.DSH_UI_APP_POLICY = writePolicy('per-aid.json', [{ exe: 'C:/App/client.exe', aid: 'ok', effect: 'allow' }])
  resetSentinel()
  const d = newDriver()
  const r = await d.flow({
    steps: [{ action: 'click', name: 'a', aid: 'ok' }, { action: 'click', name: 'b', aid: 'sell' }],
    tag: 'w2e2e-peraid', allowSideEffects: true,
  })
  check('flow 逐步判定：后面的 aid 未获允许 → 整段拒（洞 #3 回归）',
    r.ok === false && r.policyCode === 'policy_unavailable', JSON.stringify(r).slice(0, 160))
  check('flow 逐步判定 → **执行器调用计数 = 0**（第一步虽获准也不得执行）', execCount() === 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 对照组 4：所有 aid 都获准 → flow 照常执行（不能误杀）
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('per-aid-ok.json', [{ exe: 'C:/App/client.exe', aid: 'ok', effect: 'allow' }])
  resetSentinel()
  const d = newDriver()
  await d.flow({ steps: [{ action: 'click', name: 'a', aid: 'ok' }], tag: 'w2e2e-peraid-ok', allowSideEffects: true })
  check('【自检】aid 全部获准时 flow 照常执行（哨兵>0）', execCount() > 0, 'sentinel=' + execCount())
  d.warmShutdown()
}

// ------------------------------------------------- 用例 12（洞 #2 回归）：身份缓存必须随 warmRestart（gen）失效
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('ident.json', [{ exe: 'C:/App/client.exe', effect: 'allow' }])
  if (existsSync(statusSentinel)) rmSync(statusSentinel)
  resetSentinel()
  const d = newDriver()
  const statusCount = () => (existsSync(statusSentinel) ? readFileSync(statusSentinel, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length : 0)
  await d.drive({ action: 'click', name: 'a', allowSideEffects: true })
  const c1 = statusCount()
  await d.drive({ action: 'click', name: 'a', allowSideEffects: true })
  const c2 = statusCount()
  check('身份按缓存复用（连续动作不重复解析 status）', c2 === c1, `${c1} -> ${c2}`)
  d.warmRestart()
  await d.drive({ action: 'click', name: 'a', allowSideEffects: true })
  const c3 = statusCount()
  check('warmRestart（gen++）后身份缓存失效并重解析（洞 #2 回归）', c3 > c2, `${c2} -> ${c3}`)
  d.warmShutdown()
}

// ============================================================ SERVE=1 常驻路径（复核盲区补齐）
// 既有用例只走 DSH_UI_SERVE=0（一次性/batch 路径）。门在 driveOnce 最前面、结构上先于
// serve / batch / oneshot 三条执行路径 —— 但"结构上先于"需要**证明**而不是推断：
// 这里用 SERVE=1 起**真常驻进程**，先证明 serve 路径确实是本配置下的执行路径（对照组：哨兵标记=serve），
// 再证明 deny/急停在同一配置下拦得住（执行器 0 次，且常驻进程**根本没被 warmStart** —— 门在启动常驻进程之前就短路了）。

// 对照组（serve 自检）：未配策略 → 常驻进程照常执行；哨兵标记必须是 'serve'（证明没回退到 batch/oneshot）。
// 若这条不过，说明常驻路径没真正跑起来，后面两条 deny/急停 的"0 次"就没有意义 —— 故必须先立住它。
{
  clearEnv()
  resetSentinel()
  const d = newServeDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('【自检·serve】未配策略时常驻路径照常执行（哨兵>0）', execCount() > 0, 'sentinel=' + execCount() + ' r=' + JSON.stringify(r).slice(0, 120))
  check('【自检·serve】执行确实走常驻进程（哨兵标记=serve，非 batch/oneshot）', /serve/.test(sentinelText()), 'text=' + JSON.stringify(sentinelText()))
  check('【自检·serve】常驻进程确已起来（warmStatus.alive=true）', d.warmStatus().alive === true, JSON.stringify(d.warmStatus()))
  d.warmShutdown()
}

// serve + deny → 拒绝 + 执行器 0 次 + 常驻进程未被启动（门先于 warmStart）
{
  clearEnv()
  process.env.DSH_UI_APP_POLICY = writePolicy('serve-deny.json', [{ exe: 'C:/App/client.exe', effect: 'deny' }])
  resetSentinel()
  const d = newServeDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('serve 路径 + deny → 拒绝（policy_unavailable）', r.ok === false && r.policyCode === 'policy_unavailable', JSON.stringify(r).slice(0, 160))
  check('serve 路径 + deny → **执行器调用计数 = 0**', execCount() === 0, 'sentinel=' + execCount())
  check('serve 路径 + deny → 常驻进程根本未启动（门在 warmStart 之前短路）', d.warmStatus().alive === false, JSON.stringify(d.warmStatus()))
  d.warmShutdown()
}

// serve + 急停（外部总闸，不配策略也要拦）→ 拒绝 + 执行器 0 次 + 常驻进程未被启动
{
  clearEnv()
  const estop = join(dir, 'ESTOP-SERVE')
  writeFileSync(estop, 'stop', 'utf8')
  process.env.DSH_UI_ESTOP_FILE = estop
  resetSentinel()
  const d = newServeDriver()
  const r = await d.drive({ action: 'click', name: '确定', allowSideEffects: true })
  check('serve 路径 + 急停 → stopped_by_user', r.policyCode === 'stopped_by_user', String(r.policyCode))
  check('serve 路径 + 急停 → **执行器调用计数 = 0**', execCount() === 0, 'sentinel=' + execCount())
  check('serve 路径 + 急停 → 常驻进程根本未启动', d.warmStatus().alive === false, JSON.stringify(d.warmStatus()))
  d.warmShutdown()
}
// serve 收尾：恢复 SERVE=0（本文件已到末尾，纯为环境卫生）
process.env.DSH_UI_SERVE = '0'
delete process.env.DSH_UI_SERVE_IDLE_MS

clearEnv()
try { rmSync(dir, { recursive: true, force: true }); rmSync(evidenceDir, { recursive: true, force: true }) } catch { }

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive W2 policy-gate end-to-end sentinel test')
