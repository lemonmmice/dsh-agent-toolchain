// dsh-ui-drive 观测完整性**不变量**测试（Claude 第九轮 Q1 之后新增，2026-09-11）。
//
// 为什么需要这个文件（而不是再加一条针对某个 action 的断言）：
//   同一类漏洞（"清单不完整，但工具不说"）在本轮被修了 **六次**，每次都是**只修一半**：
//     F-021 渲染层一半 / AV-03 限流一半 / UD-02 早返回一半 / UD-04 第三个产出点
//     / 第七轮 Q1 state-live 的范围 / 第九轮 Q1 state-live 的截断
//   共同形态：**产出点各写各的白名单** —— 脚本算了字段，driver 的白名单丢了；
//   driver 给了，live.mjs 手工重建对象又丢了；live 对象有了，渲染层没印。
//   逐个补的代价是"下一个产出点必然重犯"，所以这里改成**不变量**：
//     「引擎回报的完整性字段，必须在每一条读路径上都原样可见」——
//   读路径由 READ_PATHS 表驱动，新增一条读路径却不满足不变量 → 这个文件立刻红。
//
// 覆盖的不变量：
//   1. read / state / state-live 三条路径：truncated / maxApplied / narrowed / scope /
//      skipped / scanned / offscreen 一个都不能丢（数据层）；
//   2. 渲染层：外壳面（renderState/renderDrive）必须打出「已截断」「范围=」「skipped=N」（文本层）；
//   3. live.mjs：控件摘要必须经 driver.completenessInfo 取用，**不许手工重建对象**（源码守卫）；
//   4. driver：shapeResult 里的读分支必须走 completenessInfo，不许再写内联 spread（源码守卫）。
import { makeDriver } from '../lib/driver.mjs'
import { renderDrive, renderState, renderLive } from '../lib/render.mjs'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-completeness-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-completeness-evidence-'))

const LINES = ['#0 [Button] "HS300"', '#1 [Text] "自选"']

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
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

// ---------------------------------------------------------------- 1. 数据层不变量
// 三条读路径共用同一份"引擎回报"，任何一条丢字段都算违反不变量。
const READ_PATHS = [
  { action: 'read', needsMax: false, drive: (d) => d.drive({ action: 'read', inAid: 'MainTabPanel', index: 0 }) },
  { action: 'state', needsMax: true, drive: (d) => d.drive({ action: 'state', inAid: 'MainTabPanel', index: 0 }) },
  { action: 'state-live', needsMax: true, drive: (d) => d.drive({ action: 'state-live', inAid: 'MainTabPanel', index: 0 }) },
]

for (const p of READ_PATHS) {
  installFakeBatch({ ok: true, elapsedMs: 4, steps: [
    { step: 1, action: p.action, ok: true, window: 'W', focusedWindow: 'W', focused: null,
      count: 40, lines: LINES, skipped: 3, skippedReasons: ['元素已失效'], scanned: 1962, offscreen: 7,
      truncated: true, maxApplied: 40, narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  ] })
  const d = newDriver()
  const r = await p.drive(d)
  const tag = '不变量[' + p.action + ']'
  check(tag + ' ok=true', r.ok === true, JSON.stringify(r).slice(0, 200))
  check(tag + ' 透传 truncated', r.truncated === true, JSON.stringify({ t: r.truncated }))
  check(tag + ' 透传 narrowed/scope', r.narrowed === true && /MainTabPanel/.test(r.scope || ''), JSON.stringify({ n: r.narrowed, s: r.scope }))
  check(tag + ' 透传 skipped/scanned/offscreen', r.skipped === 3 && r.scanned === 1962 && r.offscreen === 7,
    JSON.stringify({ sk: r.skipped, sc: r.scanned, off: r.offscreen }))
  check(tag + ' 带 skipped>0 的 warn（不许静默）', /不完整/.test(String(r.warn || '')), String(r.warn).slice(0, 160))
  if (p.needsMax) check(tag + ' 透传 maxApplied', r.maxApplied === 40, JSON.stringify({ m: r.maxApplied }))
  // 渲染层（外壳面）必须把三件事都印出来 —— 数据到位但没印 = 同一类漏洞的另一半
  const text = p.action === 'read' ? renderDrive(r) : renderDrive({ ...r, action: p.action })
  check(tag + ' 渲染印出「已截断」', /已截断/.test(text), text.slice(0, 240))
  check(tag + ' 渲染印出「范围=」', /范围=inAid=MainTabPanel/.test(text), text.slice(0, 240))
  check(tag + ' 渲染印出 skipped=3（且判为不完整）', /skipped=3（读不到状态的元素/.test(text), text.slice(0, 240))
  check(tag + ' 渲染**不是** default 分支的"完成"', !/\n完成$|^完成$/.test(text), text.slice(0, 120))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 2. 不截断时不许误报
for (const p of READ_PATHS) {
  installFakeBatch({ ok: true, elapsedMs: 3, steps: [
    { step: 1, action: p.action, ok: true, window: 'W', focused: null, count: 2, lines: LINES,
      skipped: 0, scanned: 12, truncated: false },
  ] })
  const d = newDriver()
  const r = await p.drive(d)
  const tag = '不误报[' + p.action + ']'
  check(tag + ' truncated 不为 true', r.truncated !== true, JSON.stringify({ t: r.truncated }))
  const text = p.action === 'read' ? renderDrive(r) : renderState(r)
  check(tag + ' 渲染无「已截断」', !/已截断/.test(text), text.slice(0, 160))
  check(tag + ' 渲染无「范围=」', !/范围=/.test(text), text.slice(0, 160))
  check(tag + ' 渲染标 skipped=0（清单完整）', /skipped=0（清单完整）/.test(text), text.slice(0, 200))
  check(tag + ' maxApplied 不出现', r.maxApplied === undefined, JSON.stringify({ m: r.maxApplied }))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 2b. observe 快照也必须带完整性
// Claude 第十轮真机反例（2026-09-11）：`attachObserve` 手工挑 `{window,focused,count,lines}`，
// 把 truncated/scanned/skipped 全丢了 —— 于是"动作后快照"看起来永远是一份完整清单
// （真机：`ui_state(max=15)` 给 `{count:15,truncated:true,scanned:1828}`，剥掉字段就只剩"15 个控件"）。
// 用一个**每次调用返回不同结果**的假批量脚本钉死它（attachObserve 内部会再调一次 drive）。
{
  const countFile = join(scriptsDir, 'call-count.txt')
  const p1 = JSON.stringify({ ok: true, elapsedMs: 2, steps: [{ step: 1, action: 'click', ok: true, output: 'clicked' }] })
  const p2 = JSON.stringify({ ok: true, elapsedMs: 3, steps: [{ step: 1, action: 'state', ok: true, window: 'W', focused: null, count: 15, lines: LINES, skipped: 2, scanned: 1828, truncated: true, maxApplied: 15 }] })
  writeFileSync(join(scriptsDir, 'payload-1.json'), p1, 'utf8')
  writeFileSync(join(scriptsDir, 'payload-2.json'), p2, 'utf8')
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
$cf = $env:FAKE_COUNT_FILE
$n = 0
if (Test-Path $cf) { $n = [int]((Get-Content $cf -Raw).Trim()) }
$n++
[System.IO.File]::WriteAllText($cf, [string]$n, (New-Object System.Text.UTF8Encoding($false)))
$idx = [Math]::Min($n, 2)
$payload = [System.IO.File]::ReadAllText($env:FAKE_PAYLOAD_DIR + '\\payload-' + $idx + '.json')
if ($Out) { [System.IO.File]::WriteAllText($Out, $payload, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + $payload)
`
  process.env.FAKE_COUNT_FILE = countFile
  process.env.FAKE_PAYLOAD_DIR = scriptsDir
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: 'Btn', allowSideEffects: true, observe: true, observeMax: 15 })
  const snap = (r && r.observe) || {}
  const tag = 'observe 快照'
  check(tag + '：动作成功且带快照', r.ok === true && !!r.observe, JSON.stringify(r).slice(0, 220))
  check(tag + '：带 truncated（旧实现把它丢了）', snap.truncated === true, JSON.stringify({ t: snap.truncated }))
  check(tag + '：带 skipped 与 scanned（"清单不完整"的依据）', snap.skipped === 2 && snap.scanned === 1828, JSON.stringify({ s: snap.skipped, sc: snap.scanned }))
  check(tag + '：仍带 count/lines（信息没被一起砍掉）', snap.count === 15 && Array.isArray(snap.lines), JSON.stringify({ c: snap.count }))
  const txt = renderLive({ live: { running: true, frameCount: 1 }, frame: { seq: 1, state: 'ok' }, ui: snap })
  check(tag + '：过渲染层能印出"已截断"或 skipped', /已截断/.test(txt) || /skipped=2/.test(txt), txt.slice(0, 220))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 3. completenessInfo 是单一产出点
{
  const d = newDriver()
  check('driver 暴露 completenessInfo（其它模块的唯一取用口）', typeof d.completenessInfo === 'function')
  const fake = d.completenessInfo({ truncated: true, maxApplied: 5, narrowed: true, scope: 'inAid=X inName=', skipped: 2, scanned: 900, offscreen: 1 })
  check('completenessInfo 一次给全范围/截断/跳过', fake.truncated === true && fake.maxApplied === 5 &&
    fake.narrowed === true && fake.scope === 'inAid=X inName=' && fake.skipped === 2 && fake.scanned === 900 && fake.offscreen === 1,
    JSON.stringify(fake))
  check('completenessInfo 对空输入不炸', JSON.stringify(d.completenessInfo({})) === '{"skipped":null,"observationWarning":"跳过计数未回报（引擎或脚本未提供），本次观测完整性未知"}',
    JSON.stringify(d.completenessInfo({})))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 4. live 快照渲染（ui_live）
{
  // 直接构造 live 快照形状喂渲染层：live 的控件摘要也必须带完整性尾巴。
  const snap = {
    live: { running: true, frameCount: 3, intervalMs: 1500 },
    client: { pid: 1234, window: 'W' },
    frame: { seq: 3, state: 'ok', pathAbs: 'C:\\ev\\latest.png', w: 100, h: 80, hash: 'abc', changed: true },
    ui: { window: 'W', focused: 'Button', count: 40, skipped: 3, scanned: 1962, truncated: true, maxApplied: 40,
      narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  }
  const text = renderLive(snap)
  check('ui_live 渲染印出截断', /已截断/.test(text), text.slice(0, 400))
  check('ui_live 渲染印出范围限定', /范围=inAid=MainTabPanel/.test(text), text.slice(0, 400))
  check('ui_live 渲染印出 skipped=3 不完整', /skipped=3（读不到状态的元素/.test(text), text.slice(0, 400))

  const clean = { ...snap, ui: { window: 'W', focused: null, count: 2, skipped: 0, scanned: 12 } }
  const text2 = renderLive(clean)
  check('ui_live 完整清单不误报截断', !/已截断/.test(text2) && /skipped=0（清单完整）/.test(text2), text2.slice(0, 300))

  // 缺 skipped 字段（老引擎/版本不匹配）→ 必须说"未知"，不许显示得像完整
  const unknown = { ...snap, ui: { window: 'W', focused: null, count: 2 } }
  const text3 = renderLive(unknown)
  check('ui_live 缺跳过计数 → 打印"完整性未知"', /skipped=\?/.test(text3) && /完整性未知/.test(text3), text3.slice(0, 300))
}

// ---------------------------------------------------------------- 5. 源码守卫（防下一条读路径重犯）
{
  const driverSrc = readFileSync(join(pluginDir, 'lib', 'driver.mjs'), 'utf8')
  const liveSrc = readFileSync(join(pluginDir, 'lib', 'live.mjs'), 'utf8')
  const renderSrc = readFileSync(join(pluginDir, 'lib', 'render.mjs'), 'utf8')

  // driver：读分支必须走 completenessInfo/capInfo，且不得再出现"内联 spread（只印一半）"的写法
  const uses = (driverSrc.match(/\.\.\.completenessInfo\(res\)/g) || []).length
  check('driver: state/state-live 都走 completenessInfo', uses >= 2, '出现次数=' + uses)
  // read 分支（从 `if (action === 'read') {` 到 `if (action === 'windows')`）：必须用 capInfo
  const readBlock = driverSrc.slice(driverSrc.indexOf("if (action === 'read') {"), driverSrc.indexOf("if (action === 'windows')"))
  check('driver: read 分支走 capInfo（不再手工列 truncated/maxApplied）', /\.\.\.capInfo\(res\)/.test(readBlock),
    readBlock.slice(0, 200))
  check('driver: 不再有内联的 truncated 白名单 spread（Q1 的形态）',
    !/\.\.\.\(res\.truncated === true \? \{ truncated: true/.test(driverSrc),
    '又出现了内联白名单 spread —— 请改用 completenessInfo')

  // live：不许手工重建对象（那正是把 skipped/truncated 丢掉的那行）
  check('live: 经 driver.completenessInfo 取完整性字段', /driver\.completenessInfo\(r\)/.test(liveSrc))
  check('live: 不再手工重建 ui 白名单', !/const ui = \{ window: r\.window \?\? null, focused: r\.focused \?\? null, count: r\.count \|\| 0, lines: lines\.slice\(0, c\.maxControls\) \}\n\s*ui\.hash/.test(liveSrc))
  check('live: 取不到完整性字段时 fail-visible', /observationWarning = 'live 未从 driver 取到观测完整性字段/.test(liveSrc))

  // render：state-live 必须有分支（否则外壳面落到 default 只印"完成"）
  check('render: renderDrive 有 state-live 分支', /case 'state-live': return renderState\(v\)/.test(renderSrc))
  check('render: renderLive 用 completenessTail 收尾', /completenessTail\(ui, ui\.count \|\| 0\)/.test(renderSrc))
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive 观测完整性不变量测试' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
