// dsh-ui-drive UD-04 / UD-05 单测：read·state 的「读取范围」与 waitFor 的目标解析。
//
// 背景（2026-09-11 真机确证，两个都是**静默**缺陷，都不会报错，只会给一份错的答案）：
//
//  UD-04 · read / state 写死 `$main.FindAll(Descendants)`，于是三个参数被静默吞掉：
//          winTitle/winHandle（读的永远是主窗口）、inAid/inName（读的永远是整棵树）、
//          waitFor（直接跳过等待）—— 而渲染层的截断提示还在教模型
//          「用 match 正则过滤、或用 inAid/inName 限定容器后重读」。
//          参数收下了、行为没变、还不报错，就是工具在撒谎（验收判据 G2）。
//
//  UD-05 · waitFor 的目标原来只认 step 的 aid/name，二者皆空时 Find-Elements 直接 throw
//          「find 需要 -Aid 或 -Name」；而 schema 里 waitFor 的 match 被描述成「控件名正则」，
//          所以「read + waitFor={state:'appear', match:'确定'}」（等列表刷出来再读）必然失败，
//          且错误信息里看不出「少给了目标」。
//
// 本单测锁死两件在**数据层**就必须成立的事（渲染层只印得出来它拿得到的东西）：
//   1. 脚本/引擎回报的 narrowed / scope / waitedMs 必须穿过 driver 的白名单到渲染文本里 ——
//      一份「只覆盖某个容器」的清单如果不标注，会被当成整个窗口的清单；
//   2. 容器找不到 / waitFor 未满足时，必须是 ok:false + 可执行的错误，绝不退化成读整窗。
// 另附**源码守卫**：read/state 的枚举根必须来自 Resolve-ReadScope（防止下次改动再漂回 $main）。
import { makeDriver } from '../lib/driver.mjs'
import { renderDrive, renderState, renderFlow } from '../lib/render.mjs'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-ud04-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-ud04-evidence-'))

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
  process.env.DSH_UI_SERVE = '0' // 只验批量/回退路径（常驻进程另有专项）
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

const LINES = ['#0 [Button] "HS300"', '#1 [Text] "自选"']

// ------------------------------------------------- 1. 范围限定必须一路走到渲染文本
{
  installFakeBatch({ ok: true, elapsedMs: 5, steps: [
    { step: 1, action: 'read', ok: true, count: 2, lines: LINES, skipped: 0, scanned: 12,
      narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  ] })
  const d = newDriver()
  // index 会强制走批量单步引擎（与常驻进程路径共用 shapeResult）
  const r = await d.drive({ action: 'read', inAid: 'MainTabPanel', index: 0 })
  check('UD-04 read 透传 narrowed', r.ok === true && r.narrowed === true, JSON.stringify(r).slice(0, 200))
  check('UD-04 read 透传 scope 原文', r.scope === 'inAid=MainTabPanel inName=', JSON.stringify(r.scope))
  const text = renderDrive(r)
  check('UD-04 渲染层印出范围', /范围=inAid=MainTabPanel/.test(text), text.slice(0, 300))
  check('UD-04 渲染层明说"不是整个窗口"', /不是整个窗口/.test(text), text.slice(0, 300))
  check('UD-04 控件清单仍在', /HS300/.test(text), text.slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 2. 没限定范围时不得凭空出现「范围=」
{
  installFakeBatch({ ok: true, elapsedMs: 3, steps: [
    { step: 1, action: 'read', ok: true, count: 2, lines: LINES, skipped: 0, scanned: 1962 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', index: 0 })
  check('UD-04 未限定 narrowed 不出现', r.narrowed === undefined, JSON.stringify(r.narrowed))
  check('UD-04 未限定时渲染不出现「范围=」', !/范围=/.test(renderDrive(r)), renderDrive(r).slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 3. state 同样（同一个 Resolve-ReadScope）
{
  installFakeBatch({ ok: true, elapsedMs: 3, steps: [
    { step: 1, action: 'state', ok: true, window: 'MainWin', focused: null, count: 2, lines: LINES,
      skipped: 0, scanned: 1789, narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'state', inAid: 'MainTabPanel', index: 0 })
  check('UD-04 state 透传 narrowed/scope', r.narrowed === true && /MainTabPanel/.test(r.scope || ''), JSON.stringify(r).slice(0, 200))
  const text = renderState(r)
  check('UD-04 state 渲染印出范围', /范围=inAid=MainTabPanel/.test(text), text.slice(0, 300))
  check('UD-04 限定后的清单仍带 skipped 尾巴', /skipped=0/.test(text), text.slice(0, 300))
  d.warmShutdown()
}

// ------------------------------------------------- 4. 容器找不到 → 明确失败，绝不退化成读整窗
{
  const err = '未找到容器控件（inAid=__no_such__ inName=）：read/state 的 inAid/inName 用来**限定读取范围**，' +
    '容器不存在就没有可读范围（不会退化成读整窗，免得把整窗清单冒充成容器清单）。'
  installFakeBatch({ ok: true, elapsedMs: 2, steps: [
    { step: 1, action: 'read', ok: false, error: err },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', inAid: '__no_such__', index: 0 })
  check('UD-04 容器不存在 → ok:false', r.ok === false, JSON.stringify(r).slice(0, 200))
  check('UD-04 错误原文透传（含容器名与修法）', /未找到容器控件/.test(r.error || '') && /不会退化成读整窗/.test(r.error || ''), String(r.error).slice(0, 200))
  check('UD-04 失败结果里没有控件清单（不冒充成功）', r.lines === undefined, JSON.stringify(r.lines))
  const text = renderDrive(r)
  check('UD-04 渲染层给出失败与下一步', /失败：/.test(text) && /未找到容器控件/.test(text), text.slice(0, 300))
  d.warmShutdown()
}

// ------------------------------------------------- 5. waitFor（UD-05）：成功要带 waitedMs，失败要说清目标
{
  installFakeBatch({ ok: true, elapsedMs: 9, steps: [
    { step: 1, action: 'read', ok: true, count: 2, lines: LINES, skipped: 0, scanned: 1962, waitedMs: 1080 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'read', waitFor: { ms: 3000, state: 'appear', match: 'HS300' }, index: 0 })
  check('UD-05 read+waitFor 成功且透传 waitedMs', r.ok === true && r.waitedMs === 1080, JSON.stringify({ ok: r.ok, waitedMs: r.waitedMs }))
  d.warmShutdown()

  installFakeBatch({ ok: true, elapsedMs: 9, steps: [
    { step: 1, action: 'read', ok: false, error: 'waitFor 未满足：条件未满足: state=appear target=match=/__无__/（整树正则，无 aid/name） 超时 600ms' },
  ] })
  const d2 = newDriver()
  const r2 = await d2.drive({ action: 'read', waitFor: { ms: 600, state: 'appear', match: '__无__' }, index: 0 })
  check('UD-05 waitFor 未满足 → ok:false', r2.ok === false, JSON.stringify(r2).slice(0, 200))
  check('UD-05 错误里带 state/target/超时（可据此改参数）', /state=appear/.test(r2.error || '') && /target=match=/.test(r2.error || '') && /超时 600ms/.test(r2.error || ''), String(r2.error).slice(0, 200))
  d2.warmShutdown()

  installFakeBatch({ ok: true, elapsedMs: 9, steps: [
    { step: 1, action: 'read', ok: false, error: 'waitFor 未满足：waitFor 缺少目标：至少要给 name 或 aid（写在动作参数上），或在 waitFor 里给 match 正则。三者全空无法等任何条件。' },
  ] })
  const d3 = newDriver()
  const r3 = await d3.drive({ action: 'read', waitFor: { ms: 500, state: 'appear' }, index: 0 })
  check('UD-05 目标全空 → 报「缺少目标」而不是内部断言', /缺少目标/.test(r3.error || '') && !/find 需要/.test(r3.error || ''), String(r3.error).slice(0, 200))
  d3.warmShutdown()
}

// ------------------------------------------------- 6. 范围限定在 ui_flow 的 transcript 里同样可见
{
  installFakeBatch({ ok: true, elapsedMs: 6, steps: [
    { step: 1, action: 'read', ok: true, count: 2, lines: LINES, skipped: 0, scanned: 12, narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  ] })
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-ud04', steps: [{ action: 'read', inAid: 'MainTabPanel' }] })
  check('UD-04 flow transcript 带 narrowed/scope', v.transcript[0].narrowed === true && /MainTabPanel/.test(v.transcript[0].scope || ''), JSON.stringify(v.transcript[0]).slice(0, 200))
  check('UD-04 renderFlow 仍是流程渲染（不串味）', /自验流程结束/.test(renderFlow(v)), renderFlow(v).slice(0, 160))
  d.warmShutdown()
}

// ------------------------------------------------- 7. 源码守卫：枚举根必须来自 Resolve-ReadScope
{
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  check('UD-04 脚本里有 Resolve-ReadScope', /function Resolve-ReadScope/.test(src))
  // read 分支：枚举必须走 $enumRoot（$main 是被修掉的那版写法）
  check('UD-04 read 分支枚举根是 $enumRoot', /\$all = \$enumRoot\.FindAll/.test(src))
  check('UD-04 read 分支不再直接枚举 $main', !/\$all = \$main\.FindAll\(\[System\.Windows\.Automation\]::TreeScope\]::Descendants, \[System\.Windows\.Automation\.Condition\]::TrueCondition\) \} catch \{ \$all = \$null; Add-Skip \('整次枚举失败/.test(src),
    'read 分支又出现 $main.FindAll 了——这正是 UD-04 的原样')
  // read / state 两个分支都必须调用 Resolve-ReadScope
  const calls = (src.match(/Resolve-ReadScope \$main \$step \$procId/g) || []).length
  check('UD-04 read/state 两处都调用 Resolve-ReadScope', calls >= 2, '调用次数=' + calls)
  // state 的交互控件枚举必须用 scope 根
  check('UD-04 state 用 $sc.root 枚举交互控件', /Get-InteractiveLines \$sc\.root \$matchRe \$max/.test(src))
  // UD-05：match-only 路径与「缺少目标」提示
  check('UD-05 有 Find-ElementsByMatch（只给正则也能定位）', /function Find-ElementsByMatch/.test(src) && /\$list = Find-ElementsByMatch \$main \$matchRe \$scope/.test(src))
  check('UD-05 缺少目标时给出可读错误', /waitFor 缺少目标/.test(src))
  check('UD-05 match-only 轮询间隔被抬到 ≥250ms（别 150ms 空转整树）', /if \(\$matchOnly -and \$interval -lt 250\) \{ \$interval = 250 \}/.test(src))
}

// ------------------------------------------------- 8. Claude 第七轮 Q1：state-live 是第四个读产出点
{
  // 真机反例：同一个 bogus inAid，state 明确失败，而 state-live 曾返回 ok:true + scanned=1962 + 无 narrowed/scope。
  installFakeBatch({ ok: true, elapsedMs: 4, steps: [
    { step: 1, action: 'state-live', ok: true, window: 'W', focused: null, count: 3, lines: LINES,
      skipped: 0, scanned: 1789, narrowed: true, scope: 'inAid=MainTabPanel inName=' },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'state-live', inAid: 'MainTabPanel', index: 0 })
  check('Q1 state-live 透传 narrowed/scope', r.ok === true && r.narrowed === true && /MainTabPanel/.test(r.scope || ''), JSON.stringify(r).slice(0, 220))
  check('Q1 state-live 未回报敏感焦点时保留未知与免前台标记', r.secretFocused === null && r.snapshotAuthoritative === false, JSON.stringify({ s: r.secretFocused, a: r.snapshotAuthoritative }))
  d.warmShutdown()

  installFakeBatch({ ok: true, elapsedMs: 3, steps: [
    { step: 1, action: 'state-live', ok: false, error: '未找到容器控件（inAid=__nope__ inName=）：read/state 的 inAid/inName 用来**限定读取范围**…' },
  ] })
  const d2 = newDriver()
  const r2 = await d2.drive({ action: 'state-live', inAid: '__nope__', index: 0 })
  check('Q1 state-live 容器不存在 → ok:false（不再静默吞）', r2.ok === false && /未找到容器控件/.test(String(r2.error)), JSON.stringify(r2).slice(0, 220))
  d2.warmShutdown()
}

// ------------------------------------------------- 9. Claude 第七轮 Q2：transcript 的 read 截断必须可见
{
  const many = Array.from({ length: 320 }, (_, i) => '# ' + i + ' [DataItem] "row' + i + '"')
  installFakeBatch({ ok: true, elapsedMs: 8, steps: [
    { step: 1, action: 'read', ok: true, count: 320, lines: many, skipped: 0, scanned: 1962, truncated: true },
    { step: 2, action: 'read', ok: true, count: 3, lines: ['#0 [Button] "A"'], skipped: 0, scanned: 12 },
  ] })
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-q2', steps: [{ action: 'read' }, { action: 'read' }] })
  const s0 = v.transcript[0]
  check('Q2 transcript 的 read 带 truncated', s0.truncated === true, JSON.stringify({ t: s0.truncated, count: s0.count, returned: s0.returned }))
  check('Q2 transcript 的 read 带 returned（实际给了几行）', s0.returned === 50 && s0.lines.length === 50, JSON.stringify({ returned: s0.returned, lines: s0.lines.length }))
  check('Q2 明说 transcript 的行数上限（不再是隐式信号）', s0.linesCappedAt === 50 && /不要把这份清单当成容器的全部控件/.test(String(s0.note)), String(s0.note).slice(0, 200))
  const s1 = v.transcript[1]
  check('Q2 未截断的 read 不带 truncated（不误报）', s1.truncated === undefined && s1.returned === 1, JSON.stringify({ t: s1.truncated, returned: s1.returned }))
  d.warmShutdown()
}

// ------------------------------------------------- 10. Claude 第七轮 Q3：match-only 的代价必须可见/可控
{
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  check('Q3 match-only 的 ms 上限收紧到 15000', /if \(\$matchOnly -and \$ms -gt 15000\) \{ \$ms = 15000; \$msCapped = \$true \}/.test(src))
  check('Q3 失败时回报 polls + 每轮耗时', /本轮询 ' \+ \$polls \+ ' 次，最近一轮 ' \+ \$lastPollMs \+ 'ms'/.test(src))
  check('Q3 ms 被收紧时给出改用 aid/name 的建议', /ms 已按上限 15000 收紧/.test(src) && /aid\/name/.test(src))
  check('Q3 waitfor 动作把 polls/lastPollMs 透出', /\$res\.polls = \$w\.polls/.test(src) && /\$res\.lastPollMs = \$w\.lastPollMs/.test(src))
  check('Q1 state-live 分支调用 Resolve-ReadScope', /# 修法：与 read\/state 走\*\*同一个\*\* Resolve-ReadScope/.test(src) || /state-live[\s\S]{0,2000}Resolve-ReadScope \$target \$step \$procId/.test(src))
  check('Q1 state-live 用 $sc.root 枚举（不再写死 $target）', /Get-InteractiveLines \$sc\.root \$matchRe \$max[\s\S]{0,80}state-live|\$lines = Get-InteractiveLines \$sc\.root \$matchRe \$max/.test(src))
}

// ------------------------------------------------- 11. Claude 第八轮 Q2 对称性：state 的 max 上限也要标
{
  installFakeBatch({ ok: true, elapsedMs: 4, steps: [
    { step: 1, action: 'state', ok: true, window: 'W', focused: null, count: 40, lines: LINES,
      skipped: 0, scanned: 900, truncated: true, maxApplied: 40 },
    { step: 2, action: 'state', ok: true, window: 'W', focused: null, count: 12, lines: LINES, skipped: 0, scanned: 12 },
  ] })
  const d = newDriver()
  const r = await d.drive({ action: 'state', index: 0 })
  check('Q2 state 透传 truncated + maxApplied', r.truncated === true && r.maxApplied === 40, JSON.stringify({ t: r.truncated, m: r.maxApplied }))
  const text = renderState(r)
  check('Q2 state 渲染明说"已截断"并指出 max 用满', /已截断/.test(text) && /max=40 已用满/.test(text), text.slice(0, 320))
  check('Q2 state 截断提示给出收窄办法（match/inAid/max）', /match/.test(text) && /inAid/.test(text) && /max/.test(text), text.slice(0, 360))
  d.warmShutdown()

  installFakeBatch({ ok: true, elapsedMs: 4, steps: [
    { step: 1, action: 'state', ok: true, window: 'W', focused: null, count: 12, lines: LINES, skipped: 0, scanned: 12 },
  ] })
  const d2 = newDriver()
  const r2 = await d2.drive({ action: 'state', index: 0 })
  check('Q2 state 未截断时不误报', r2.truncated === undefined && !/已截断/.test(renderState(r2)), JSON.stringify({ t: r2.truncated }))
  d2.warmShutdown()

  // ui_flow 的 state 步同样要带
  installFakeBatch({ ok: true, elapsedMs: 5, steps: [
    { step: 1, action: 'state', ok: true, window: 'W', focused: null, count: 40, lines: LINES, skipped: 0, scanned: 900, truncated: true, maxApplied: 40 },
  ] })
  const d3 = newDriver()
  const v = await d3.flow({ tag: 'unit-q2-state', steps: [{ action: 'state' }] })
  check('Q2 flow transcript 的 state 步带 truncated/maxApplied', v.transcript[0].truncated === true && v.transcript[0].maxApplied === 40, JSON.stringify(v.transcript[0]).slice(0, 220))
  d3.warmShutdown()

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  const caps = (src.match(/if \(\$max -gt 0 -and \$lines\.Count -ge \$max\) \{ \$res\.truncated = \$true; \$res\.maxApplied = \$max \}/g) || []).length
  check('Q2 state 与 state-live 两处都显式回报 max 截断', caps >= 2, '出现次数=' + caps)
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive UD-04/UD-05 read-scope unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
