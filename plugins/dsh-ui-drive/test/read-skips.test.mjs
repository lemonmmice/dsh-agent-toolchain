// dsh-ui-drive 观测完整性单测（B-1，离线：不需要客户端、不启动 PowerShell）
//
// 背景：为修「read 假空」，逐元素读取改成 try/catch 继续；但静默 continue 会制造
// **新一轮假空**——调用方拿到「变少了的清单」，却不知道少了几行。本单测锁死三件事：
//   1. 引擎回报了 skipped → driver 结果带 skipped/skippedReasons/warn，且渲染层把 warn 打出来；
//   2. 引擎没回报 skipped（老脚本/未知路径）→ skipped=null（未知），**绝不谎报 0**；
//   3. 一次性回退脚本的 `SKIPPED n` 协议行被解析（那条路上的 read 曾整段崩成 0 行）。
import { makeDriver } from '../lib/driver.mjs'
import { renderDrive, renderState } from '../lib/render.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-skips-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-skips-evidence-'))

/** 假 batch 脚本：把 payload 写到 -Out 并打印 RESULT_JSON=（与 flow-batch 单测同一套路）。 */
function installFakeBatch(payload) {
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_BATCH_PAYLOAD = JSON.stringify(payload)
}

function newDriver() {
  process.env.DSH_UI_SERVE = '0' // 本单测只验批量/回退路径，常驻进程另有专项
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

const REASONS = ['读取元素状态失败: 不能对 Null 值表达式调用方法。']

// ------------------------------------------------- 1. 引擎报 skipped>0 → 三个字段齐出且渲染可见
{
  installFakeBatch({ ok: true, elapsedMs: 5, steps: [
    { step: 1, action: 'read', ok: true, count: 2, lines: ['#0 [Button] "A"', '#1 [Text] "B"'], skipped: 3, skippedReasons: REASONS },
  ] })
  const d = newDriver()
  // index 会强制走批量单步引擎（与常驻进程路径共用 shapeResult，映射逻辑一致）
  const r = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('read 透传 skipped=3', r.ok === true && r.skipped === 3, JSON.stringify(r).slice(0, 200))
  check('read 透传 skippedReasons', Array.isArray(r.skippedReasons) && /Null/.test(r.skippedReasons[0]), JSON.stringify(r.skippedReasons))
  check('skipped>0 一定带 warn', typeof r.warn === 'string' && /跳过 3/.test(r.warn) && /不完整/.test(r.warn), String(r.warn))
  const text = renderDrive(r)
  check('渲染层把 warn 打给 agent', /读到 2 个控件/.test(text) && /跳过 3/.test(text), text.slice(0, 200))
  check('渲染层仍保留控件清单', /\[Button\] "A"/.test(text), text.slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 2. skipped=0 是「完整」，不能误报
{
  installFakeBatch({ ok: true, elapsedMs: 3, steps: [
    { step: 1, action: 'read', ok: true, count: 1, lines: ['#0 [Button] "A"'], skipped: 0 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('skipped=0 如实回报 0', r.skipped === 0, JSON.stringify(r.skipped))
  check('skipped=0 不带 warn', r.warn === undefined, String(r.warn))
  check('skipped=0 渲染不出现「跳过」', !/跳过/.test(renderDrive(r)), renderDrive(r))
  d.warmShutdown()
}

// ------------------------------------------------- 3. 引擎没回报 → null（未知），绝不谎报 0
{
  installFakeBatch({ ok: true, elapsedMs: 4, steps: [
    { step: 1, action: 'read', ok: true, count: 1, lines: ['#0 [Button] "A"'] },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('未回报时 skipped=null（未知 ≠ 0）', r.skipped === null, JSON.stringify(r.skipped))
  check('未回报时不伪造 warn', r.warn === undefined, String(r.warn))
  d.warmShutdown()
}

// ------------------------------------------------- 4. ui_flow 每一步同样带 skipped
{
  installFakeBatch({ ok: true, elapsedMs: 6, steps: [
    { step: 1, action: 'read', ok: true, count: 1, lines: ['#0 [Button] "A"'], skipped: 2, skippedReasons: REASONS },
    { step: 2, action: 'state', ok: true, window: '主窗口', focused: null, count: 1, lines: ['#0 [Button] "A"'], skipped: 1 },
  ] })
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-skips', steps: [{ action: 'read', match: 'x' }, { action: 'state' }] })
  check('transcript read 步带 skipped', v.transcript[0].skipped === 2, JSON.stringify(v.transcript[0].skipped))
  check('transcript state 步带 skipped', v.transcript[1].skipped === 1, JSON.stringify(v.transcript[1].skipped))
  check('read 步 skipped>0 时带 warn', /跳过 2/.test(v.transcript[0].warn || ''), String(v.transcript[0].warn))
  d.warmShutdown()
}

// ------------------------------------------------- 5. state 渲染同样显式提示
{
  const state = { ok: true, action: 'state', window: '主窗口', focused: null, count: 1, lines: ['#0 [Button] "A"'], skipped: 2, skippedReasons: REASONS,
    warn: '⚠ 跳过 2 个读不到状态的元素，本次清单不完整（读取元素状态失败）×——不要把「没读到」当成「界面上没有」' }
  const text = renderState(state)
  check('state 渲染带控件清单', /交互控件 1 个/.test(text) && /#0 \[Button\]/.test(text), text.slice(0, 160))
  check('state 渲染带跳过提示', /跳过 2/.test(text), text.slice(0, 200))
  check('read/state 走 renderDrive 时 state 有分支（不再回落到「完成」）', /交互控件 1 个/.test(renderDrive(state)), renderDrive(state).slice(0, 160))
  const clean = renderState({ ...state, skipped: 0, warn: undefined })
  check('state skipped=0 时无跳过提示', !/跳过/.test(clean), clean.slice(0, 160))
}

// ------------------------------------------------- 6. 一次性回退脚本的 SKIPPED 协议行
{
  installFakeBatch({ ok: true, elapsedMs: 1, steps: [] }) // 让 warm 不可用时的 batch 场景无害
  const oneShot = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='',[string]$Match='',[int]$WaitMs=0)
Write-Output '[Button] "A" enabled=True @1,1 10x10'
Write-Output 'SKIPPED 2'
Write-Output 'SKIPREASON ElementNotAvailable'
`
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), oneShot, 'utf8')
  process.env.DSH_UI_SERVE = '0'
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
  const r = await d.drive({ action: 'read' })
  check('回退脚本 read 解析出 1 行', r.ok === true && r.count === 1, JSON.stringify(r).slice(0, 160))
  check('回退脚本 SKIPPED 行被解析成 skipped=2', r.skipped === 2, JSON.stringify(r.skipped))
  check('回退脚本 SKIPREASON 进 skippedReasons', Array.isArray(r.skippedReasons) && /ElementNotAvailable/.test(r.skippedReasons[0]), JSON.stringify(r.skippedReasons))
  check('回退脚本路径也带 warn', /跳过 2/.test(r.warn || ''), String(r.warn))
  d.warmShutdown()
}

// ------------------------------------------------- 7. 空枚举必须显式提示（UIA 给空集合、不报错）
{
  installFakeBatch({ ok: true, elapsedMs: 2, steps: [
    { step: 1, action: 'read', ok: true, count: 0, lines: [], skipped: 0, scanned: 0 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('空枚举透传 scanned=0', r.scanned === 0, JSON.stringify(r.scanned))
  check('空枚举必带 warn（0 行不能静默）', /0 个元素/.test(r.warn || ''), String(r.warn))
  check('空枚举的 warn 渲染给 agent', /0 个元素/.test(renderDrive(r)), renderDrive(r).slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 8. 有元素但全被过滤 ≠ 没看到（别误报）
{
  installFakeBatch({ ok: true, elapsedMs: 2, steps: [
    { step: 1, action: 'read', ok: true, count: 0, lines: [], skipped: 0, scanned: 240, offscreen: 240 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('全过滤：scanned/offscreen 透传', r.scanned === 240 && r.offscreen === 240, JSON.stringify(r).slice(0, 160))
  check('全过滤：不误报「空枚举」', r.warn === undefined, String(r.warn))
  d.warmShutdown()
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive read skip-count unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
