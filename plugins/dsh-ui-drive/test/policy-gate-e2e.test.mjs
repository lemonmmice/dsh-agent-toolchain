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

/** 假脚本：-Status 只回报身份（不写哨兵）；任何**真正执行**的路径都往哨兵追加一行。 */
function installFakeScripts() {
  const batch = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Status) {
  Write-Output 'RUNNING pid=4242 window=FakeWin'
  Write-Output 'HANDLE 777'
  $json = '{"exe":"C:/App/client.exe","exeCanonical":"c:/app/client.exe"}'
  Write-Output ('IDENT ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  Write-Output 'RECT 800x600 @0,0'
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
  process.env.FAKE_BATCH_PAYLOAD = JSON.stringify({ ok: true, elapsedMs: 3, steps: [{ step: 1, action: 'click', ok: true, output: 'CLICKED "x"' }] })
}

function resetSentinel() { if (existsSync(sentinel)) rmSync(sentinel) }
function execCount() {
  if (!existsSync(sentinel)) return 0
  return readFileSync(sentinel, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length
}

function newDriver() {
  process.env.DSH_UI_SERVE = '0'
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

clearEnv()
try { rmSync(dir, { recursive: true, force: true }); rmSync(evidenceDir, { recursive: true, force: true }) } catch { }

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive W2 policy-gate end-to-end sentinel test')
