// D.1（2026-09-14 夜）：`ui_drive` / `ui_observe` / `ui_act` / `ui_live` 的**渲染层**与生产者的 action 分支对齐。
//
// 为什么这四个被点名：`plugins/dsh-perf/test/render-trace.test.mjs` 的「覆盖面登记」把它们钉成
// `KNOWN_UNCOVERED`（只许缩短），理由是 F-049 那类缺陷 —— **生产者加了新 action，渲染层没跟上**，
// 结构化结果掉进 `default`，被 `v.output || '完成'` 一句吞掉。而渲染文本是 **agent 唯一看得见的东西**。
//
// 本次一核就抓到 3 处（同一形状，且都不是"文字不好看"而是**信息被吞**）：
//   · `capture`       → 结果形状 `{ok,action,state,captureMethod,pid,window,path?,w?,h?}`，**没有 output 字段**
//                       ⇒ 渲染成「完成」，抓到的帧路径/方式/pid 全丢；
//   · `expectwindow` / `expecttext` → `{ok,action,found,waitedMs,detail?,count?,lines?}`，同样没有 output
//                       ⇒ 断言"成立"被渲染成「完成」——而这两个正是 README 里"判定登录结果的唯一可靠信号"；
//   · `waitany`       → `{ok,action,hitIndex,hitKind,hitLabel,waitedMs,detail?}`，没有 output
//                       ⇒ **"命中了哪一支"被吞掉**，而工具描述承诺的正是"一次同时押注三支，返回命中的那支"。
//
// 两条不变量（照 render-trace 的 I1/I2 定，不手抄文案）：
//   I1 **覆盖**：生产者声明的每个 action 都必须有明确渲染期望 —— 要么在手写 CASES 里，
//      要么登记进 OUTPUT_ONLY 并给出理由（并**验证**它确实走 output 这条路，而不是悄悄掉进兜底）；
//   I2 **不编造**：渲染文本里不许出现 `undefined` / `NaN`，也不许把带数据的结构化结果渲染成一句兜底话。
//
// ⚠ 本测试**从生产者读 enum**（`index.js` 的 `action.enum`），不手抄 —— 手抄两份必然漂移，
//   而漂移的那一刻测试还是绿的（那正是 F-049 能活到现网的原因）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDrive, renderLive } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(join(HERE, '..', 'index.js'), 'utf8')
const DRIVER = readFileSync(join(HERE, '..', 'lib', 'driver.mjs'), 'utf8')
// W1：已迁进注册表的工具，其 action enum 从注册表读；未迁移的仍扫 index.js 源码（内联 enum）。
const { REGISTRY } = await import('../../../lib/tool-registry.mjs')

/** 读工具的 action enum（不手抄）：优先注册表（已迁移），回落 index.js 源码正则（未迁移）。 */
function actionEnum(tool) {
  const entry = REGISTRY[tool]
  if (entry) {
    const p = (entry.params || []).find((x) => x.name === 'action' && Array.isArray(x.enum))
    if (p) return p.enum.slice()
  }
  const at = INDEX.indexOf("name: '" + tool + "'")
  if (at < 0) return null
  const seg = INDEX.slice(at, at + 4000)
  const m = seg.match(/action:\s*\{[^}]*enum:\s*\[([^\]]+)\]/)
  if (!m) return null
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

const D = { ui_drive: actionEnum('ui_drive'), ui_observe: actionEnum('ui_observe'), ui_act: actionEnum('ui_act') }
const LIVE = { ui_live: actionEnum('ui_live') }

// 先证明"确实读到了"：正则失效时空跑会把这一关变成**空断言**（本仓第 19/44 类）。
check('★ 读到四个工具的 action enum（读不到 ⇒ 整个文件退化成空断言）',
  Object.values(D).every((a) => Array.isArray(a) && a.length >= 5) && Array.isArray(LIVE.ui_live) && LIVE.ui_live.length >= 5,
  JSON.stringify({ ...D, ...LIVE }))

// ---------------------------------------------------------------- 数据型 action 的真实形状
// 形状照抄 `lib/driver.mjs` 的 return（行号写在注释里），**不是我想象的**。
const CASES = {
  find: {
    // driver.mjs:1503 {ok,action,found,detail}
    result: { ok: true, action: 'find', found: true, detail: '[Button] name="下单" enabled=True @10,20 60x30', count: 1 },
    mustMatch: [/找到/, /下单/],
  },
  read: {
    // driver.mjs 的 read 分支 {ok,action,count,lines,skipped,…}
    result: { ok: true, action: 'read', count: 2, lines: ['#0 [Button] "确定"', '#1 [Edit] "搜索"'], skipped: 0 },
    mustMatch: [/读到 2 个控件/, /确定/, /skipped=0/],
  },
  state: {
    // renderDrive('state') → renderState：吃 window/focused/count/lines
    result: { ok: true, action: 'state', window: '示例终端', focused: '[Edit] "发消息"', count: 2, lines: ['#0 [Button] "自选"', '#1 [Edit] "搜索"'], skipped: 0 },
    mustMatch: [/窗口=示例终端/, /焦点=/, /skipped=0/],
  },
  'state-live': {
    result: { ok: true, action: 'state-live', window: '示例终端', focused: null, count: 1, lines: ['#0 [Button] "自选"'], skipped: 0 },
    mustMatch: [/窗口=示例终端/, /skipped=0/],
  },
  windows: {
    // driver 的 windows 分支 {ok,action,count,lines}
    result: { ok: true, action: 'windows', count: 2, lines: ['[Window] "示例终端" handle=1 @0,0 100x100', '[Window] "登录" handle=2 @0,0 50x50'] },
    mustMatch: [/2 个顶层窗口/, /登录/],
  },
  waitfor: {
    // driver.mjs:1584 {ok,action,found,detail,waitedMs}
    result: { ok: true, action: 'waitfor', found: true, detail: '[Button] name="确定"', waitedMs: 320 },
    mustMatch: [/条件已满足/, /320ms/, /确定/],
  },
  expectwindow: {
    // driver.mjs:1586 {ok,action,found,waitedMs,detail?,count?,lines?}
    result: { ok: true, action: 'expectwindow', found: true, waitedMs: 1450, detail: '[Window] "示例终端" handle=9' },
    mustMatch: [/1450ms/, /示例终端/],
  },
  expecttext: {
    result: { ok: true, action: 'expecttext', found: true, waitedMs: 880, lines: ['#0 [Text] "验证码错误"'] },
    mustMatch: [/880ms/, /验证码错误/],
  },
  waitany: {
    // driver.mjs:1593 {ok,action,hitIndex,hitKind,hitLabel,waitedMs,detail?}
    result: { ok: true, action: 'waitany', hitIndex: 1, hitKind: 'window', hitLabel: '主窗口出现', waitedMs: 2100, detail: '[Window] "示例终端" handle=9' },
    mustMatch: [/2100ms/, /主窗口出现/],
  },
  shot: {
    // driver.mjs:1627 shapeShot {ok,action,path,w,h,workspacePath}
    result: { ok: true, action: 'shot', path: 'D:\\ev\\shot.png', w: 2560, h: 1380, workspacePath: null },
    mustMatch: [/D:\\ev\\shot\.png/, /2560x1380/],
  },
  capture: {
    // driver.mjs:1603 {ok,action,state,captureMethod,pid,window,path?,w?,h?}
    // state/captureMethod 的取值照 scripts/ui-drive-batch.ps1:2045 的注释（visible|minimized|hidden|nowindow / print|screen）
    result: { ok: true, action: 'capture', state: 'minimized', captureMethod: 'screen', pid: 32748, window: '示例终端', path: 'D:\\ev\\live\\frame.png', w: 2560, h: 1380 },
    mustMatch: [/D:\\ev\\live\\frame\.png/, /32748/, /minimized/],
  },
}

// 结果里**只有 output** 的 action（点击类副作用动作）：登记 + 理由，并验证它确实走 output 这条路。
const OUTPUT_ONLY = {
  click: 'driver.mjs:1600 {ok,action,output} —— 点击是副作用动作，结果就是一句人读的结论',
  setvalue: 'driver.mjs:1600 同上（写值后回读校验的结论在 output 里）',
  key: 'driver.mjs:1600 同上',
  type: 'driver.mjs:1600 同上',
  drag: 'driver.mjs:1600 同上',
  clickat: 'driver.mjs:1616 兜底 {ok,action,output}（坐标类动作，结论在 output）',
  doubleclick: 'driver.mjs:1616 兜底（元素级双击）',
  pattern: 'driver.mjs:1616 兜底（调用 UIA pattern，结论在 output）',
  scroll: 'driver.mjs:1616 兜底（语义滚动）',
  selecttext: 'driver.mjs:1616 兜底（精确选区）',
  move: 'driver.mjs:1616 兜底（只移动鼠标）',
  wheel: 'driver.mjs:1616 兜底（只滚轮）',
}
const LIVE_CASES = {
  start: { result: { ok: true, live: { running: true, frameCount: 0, intervalMs: 1500 }, frame: null }, mustMatch: [/运行中/] },
  stop: { result: { ok: true, live: { running: false, frameCount: 42, intervalMs: 1500 }, frame: null }, mustMatch: [/已停止/, /42/] },
  status: { result: { ok: true, live: { running: true, frameCount: 7, intervalMs: 1500 }, frame: { seq: 7, state: 'ok', pathAbs: 'D:\\ev\\live\\f7.png', w: 100, h: 50 } }, mustMatch: [/运行中/, /D:\\ev\\live\\f7\.png/] },
  frame: { result: { ok: true, live: { running: true, frameCount: 8, intervalMs: 1500 }, frame: { seq: 8, state: 'ok', pathAbs: 'D:\\ev\\live\\f8.png', w: 100, h: 50 } }, mustMatch: [/D:\\ev\\live\\f8\.png/] },
  wait: { result: { ok: true, changed: true, hash: 'abcdef0123456789', seq: 9, timedOut: false, waitedMs: 3000, snapshot: { live: { running: true, frameCount: 9 }, frame: { seq: 9, pathAbs: 'D:\\ev\\live\\f9.png', w: 100, h: 50 } } }, mustMatch: [/已变化/, /3000ms/, /D:\\ev\\live\\f9\.png/] },
}

// ---------------------------------------------------------------- I2：不编造
const FABRICATED = /undefined|NaN|\[object Object\]/

function renderCase(tool, action, result) {
  const txt = tool === 'ui_live' ? renderLive(result) : renderDrive(result)
  return String(txt == null ? '' : txt)
}

// ---------------------------------------------------------------- I1 + I2 逐条跑
for (const tool of ['ui_drive', 'ui_observe', 'ui_act']) {
  const actions = D[tool] || []
  const unknown = actions.filter((a) => !(a in CASES) && !(a in OUTPUT_ONLY))
  check('★★ [' + tool + '] 每个声明的 action 都有明确渲染期望（新增 action 必须在这里登记）',
    unknown.length === 0, '未登记：' + unknown.join(', '))
  for (const a of actions) {
    const c = CASES[a]
    if (!c) continue
    const txt = renderCase(tool, a, c.result)
    check('★★ [' + tool + '/' + a + '] 结构化数据必须被渲染出来（不是掉进兜底那句"完成"）',
      c.mustMatch.every((re) => re.test(txt)) && !/^完成$/.test(txt.trim()), JSON.stringify(txt.slice(0, 200)))
    check('★ [' + tool + '/' + a + '] 渲染文本里不许出现编造的量',
      !FABRICATED.test(txt), JSON.stringify(txt.slice(0, 200)))
  }
}
for (const a of (LIVE.ui_live || [])) {
  const c = LIVE_CASES[a]
  check('★★ [ui_live/' + a + '] 有明确渲染期望（新增 action 必须登记）', Boolean(c), a)
  if (!c) continue
  const txt = renderCase('ui_live', a, c.result)
  check('★★ [ui_live/' + a + '] 数据被渲染出来', c.mustMatch.every((re) => re.test(txt)), JSON.stringify(txt.slice(0, 200)))
  check('★ [ui_live/' + a + '] 不许出现编造的量', !FABRICATED.test(txt), JSON.stringify(txt.slice(0, 200)))
}

// OUTPUT_ONLY 必须**真的**走 output 这条渲染路径（登记了却掉进别处 = 登记在骗人）
{
  const bad = []
  for (const a of Object.keys(OUTPUT_ONLY)) {
    const txt = renderCase('ui_drive', a, { ok: true, action: a, output: 'OK-' + a })
    if (txt !== 'OK-' + a) bad.push(a + '→' + JSON.stringify(txt.slice(0, 60)))
  }
  check('★ OUTPUT_ONLY 登记的 action 确实渲染 output（否则这条登记是假的）', bad.length === 0, bad.join(' ; '))
  // 登记项不许是僵尸（生产者的 enum 里已经没有它了）
  const allDeclared = new Set([...(D.ui_drive || []), ...(D.ui_observe || []), ...(D.ui_act || [])])
  const zombies = Object.keys(OUTPUT_ONLY).filter((a) => !allDeclared.has(a))
  check('★ OUTPUT_ONLY 里没有僵尸项（登记了但生产者已不再声明）', zombies.length === 0, zombies.join(', '))
  // 每一项都必须有理由（不是空字符串）
  const noReason = Object.entries(OUTPUT_ONLY).filter(([, r]) => !r || r.length < 8).map(([k]) => k)
  check('★ OUTPUT_ONLY 每一项都写了理由', noReason.length === 0, noReason.join(', '))
}

// ---------------------------------------------------------------- 失败路径也不许沉默
{
  const failCases = [
    ['find 未命中', { ok: true, action: 'find', found: false }],
    ['capture 失败', { ok: false, action: 'capture', error: '抓帧超时' }],
    ['waitany 超时', { ok: false, action: 'waitany', error: '三个条件都没成立', hitIndex: -1, waitedMs: 15000 }],
    ['expectwindow 超时', { ok: false, action: 'expectwindow', found: false, waitedMs: 5000, error: '窗口条件未满足：titleRe=/登录/ gone=False 超时 5000ms' }],
  ]
  for (const [name, r] of failCases) {
    const txt = renderCase('ui_drive', r.action, r)
    check('★ ' + name + '：必须说清是失败/未满足（不许渲染成"完成"）',
      /失败|未找到|未满足|没成立|超时/.test(txt) || txt.includes('完成') === false, JSON.stringify(txt.slice(0, 160)))
  }
}

// ---------------------------------------------------------------- 跨文件哨兵：钉子只许缩短
{
  const perf = readFileSync(join(HERE, '..', '..', 'dsh-perf', 'test', 'render-trace.test.mjs'), 'utf8')
  const m = perf.match(/const KNOWN_UNCOVERED = \[([^\]]*)\]/)
  check('★ 读到了 perf 那侧的未覆盖钉子（读不到 ⇒ 哨兵失效）', Boolean(m), '')
  const pinned = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
  const stillPinned = ['ui_drive', 'ui_observe', 'ui_act', 'ui_live'].filter((t) => pinned.includes(t))
  check('★★ 本文件核过的四个工具，不许还留在"未核渲染"名单里（核过就要把钉子拔掉）',
    stillPinned.length === 0, '仍被钉着：' + stillPinned.join(', '))
  const cov = perf.match(/const COVERED = new Set\(\[([^\]]*)\]\)/)
  const covered = cov ? cov[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
  check('★ 这四个工具应已被登记为"已核渲染"（COVERED）',
    ['ui_drive', 'ui_observe', 'ui_act', 'ui_live'].every((t) => covered.includes(t)), 'COVERED=' + covered.join(','))
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: dsh-ui-drive 渲染层与生产者的 action 分支对齐（ui_drive / ui_observe / ui_act / ui_live）')
