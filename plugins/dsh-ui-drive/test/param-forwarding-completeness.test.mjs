// dsh-ui-drive 单测：**三个转发白名单 vs 执行器真正读取的字段**必须对齐。
//
// 为什么单独成文件：本轮（2026-09-11）这类"白名单漏参数"已经出现**三次**，每次都是静默的：
//   ① `cleanSteps`（flow/batch 步）漏了 8 个 drive() 认的字段，其中 `snapshotId` 一丢，
//      调用方要求的**新鲜度门**就静默失效；
//   ② warm 常驻进程的 payload 漏过参数（代码注释里记着两次："warm 路径下这些参数全部失效"
//      "move/wheel/clickat 收到 x=0,y=0"）；
//   ③ MCP 面 zod schema 没声明 → SDK 直接把未知键剥掉（另一条独立的白名单）。
// 逐个补字段是治标：**下一个新字段必然再犯**。所以这里改成不变量：
//   执行器（ui-drive-batch.ps1）里 `$step.X` / `$s.X` **真正读**的每个字段，
//   必须在两条转发路径（warm payload / cleanSteps）上都有归宿，或**显式登记**为"不经该路径"并写明理由。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const batchSrc = readFileSync(join(here, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
const driverSrc = readFileSync(join(here, '..', 'lib', 'driver.mjs'), 'utf8')

/** 执行器真正读取的字段：`$step.X` / `$s.X` / `$req.X`。 */
function executorFields() {
  const set = new Set()
  for (const m of batchSrc.matchAll(/\$(?:step|s|req)\.([A-Za-z_][A-Za-z0-9_]*)/g)) set.add(m[1])
  return set
}
/** 非 step 字段：来自其它上下文（warm 协议、C#/UIA 枚举名、PSObject 反射、别处的属性访问）。 */
const NOT_STEP_FIELDS = new Set([
  'PSObject',             // PowerShell 反射惯用法
  'cmd',                  // warm 常驻进程的协议字段（warmSend 自带），不是 step 字段
  'path', 'w', 'h',       // 截图结果对象的属性（$s.path/$s.w/$s.h 是**脚本内构造**的结果，不是入参）
  'GetText',              // [System.Windows.Automation.TextPattern]::…GetText(…) 的静态成员
  'MoveEndpointByRange', 'MoveEndpointByUnit', // TextPattern 的静态成员
])

/** warm payload（drive() 的常驻快路径）里实际发出去的键。用**括号配对**取对象体，别靠缩进。 */
function warmPayloadKeys() {
  const at = driverSrc.indexOf('const payload = {')
  if (at < 0) return new Set()
  const from = driverSrc.indexOf('{', at)
  let depth = 0
  let end = from
  for (let i = from; i < driverSrc.length; i++) {
    const ch = driverSrc[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const body = driverSrc.slice(from + 1, end)
  const set = new Set()
  // 对象字面量里的键（简写 `name,` 与 `key: value`）
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/\/\/.*$/, '').trim()   // 去注释后可能是空行
    if (!t) continue
    for (const part of t.split(',')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/.exec(part.trim())
      if (m) set.add(m[1])
    }
  }
  // 条件写入（`if (action === 'shot') payload.out = …`）：也是转发，必须算数。
  // 注意它在对象字面量**之后**，所以扫描窗口要放宽到字面量起点之后的一段。
  for (const m of driverSrc.slice(from, from + 2000).matchAll(/payload\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) set.add(m[1])
  return set
}

/** cleanSteps（batch/flow 步）保留的字段。三种写法都要抓：
 *   `if (s.X !== undefined …)`（常规）
 *   `if (s.X === true) o.X = true`（布尔）
 *   以及对象字面量里的显式赋值 `action:`（action 是 normalized 后写的） */
function cleanStepsKeys() {
  const at = driverSrc.indexOf('const cleanSteps')
  const end = driverSrc.indexOf('writeFileSync(stepsFile', at)
  const body = driverSrc.slice(at, end)
  const set = new Set()
  for (const m of body.matchAll(/if \(s\.([A-Za-z_][A-Za-z0-9_]*)\s*[!=]==/g)) set.add(m[1])
  for (const m of body.matchAll(/o\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) set.add(m[1])
  // 对象字面量里的显式赋值（`const o = { action: normAction(s.action) }` 是单行，行首锚点抓不到）
  for (const m of body.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) set.add(m[1])
  for (const m of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)) set.add(m[1])
  return set
}

/**
 * 显式登记：**不经某条路径**的字段 + 理由。
 * 加新条目必须能说清"为什么这条路径不需要它"，而不是"先加上让它变绿"。
 */
const EXEMPT_FROM_WARM = {
  expectEnabled: 'expect 是 flow 步骤类型，单动作 ui_drive 不收（warm 是单动作路径）',
  expectMatch: '同上：expect 断言只在 ui_flow 的步骤里使用',
  maxDepth: 'tree 动作走批量路径（ui_tree → batch），单动作路径不读它',
}
const EXEMPT_FROM_CLEAN = {
  procId: 'flow/batch 走 -ProcId 全局参数指定目标进程；PS 只在**常驻 serve 请求**里读 $req.procId（切目标），' +
    '批量步本身不读 step.procId —— 单动作路径的 procId 由 warm payload 顶层携带',
}

const EXEC = [...executorFields()].filter((f) => !NOT_STEP_FIELDS.has(f)).sort()
const WARM = warmPayloadKeys()
const CLEAN = cleanStepsKeys()

// ------------------------------------------------- 0. 解析器自检（否则"全绿"可能只是没解析到东西）
{
  check('解析出执行器读取的字段（>25 个）', EXEC.length > 25, 'n=' + EXEC.length + ' ' + JSON.stringify(EXEC.slice(0, 10)))
  check('解析出 warm payload 的键（>25 个）', WARM.size > 25, 'n=' + WARM.size)
  check('解析出 cleanSteps 的键（>25 个）', CLEAN.size > 25, 'n=' + CLEAN.size)
  check('已知字段都能解析到（抽查 action/name/aid/value/match/inAid/winTitle）',
    ['action', 'name', 'aid', 'value', 'match', 'inAid', 'winTitle'].every((f) => EXEC.includes(f)),
    JSON.stringify(EXEC.slice(0, 20)))
}

// ------------------------------------------------- 1. 批量路径：执行器读的字段必须能被转发
{
  const missing = EXEC.filter((f) => !CLEAN.has(f) && !(f in EXEMPT_FROM_CLEAN))
  check('批量/flow 路径：执行器读的每个字段 cleanSteps 都会转发', missing.length === 0,
    '未转发=' + JSON.stringify(missing) + '（写 flow 步时会静默丢参）')
}

// ------------------------------------------------- 2. 常驻快路径：同样必须转发（或显式登记）
{
  const missing = EXEC.filter((f) => !WARM.has(f) && !(f in EXEMPT_FROM_WARM))
  check('常驻(warm)路径：执行器读的每个字段 payload 都会转发', missing.length === 0,
    '未转发=' + JSON.stringify(missing) + '（同一次调用走 warm 时该参数静默失效）')
}

// ------------------------------------------------- 3. 反向：白名单里不许有执行器根本不认的字段（写进去也没用，是假承诺）
{
  const unknown = [...WARM].filter((k) => !EXEC.includes(k) && k !== 'out')
  check('warm payload 不含执行器不认识的字段', unknown.length === 0,
    '多余=' + JSON.stringify(unknown))
}

// ------------------------------------------------- 4. 登记项必须真的有理由（理由字符串非空且能读懂）
{
  for (const [f, why] of Object.entries(EXEMPT_FROM_WARM)) {
    check(`豁免项 ${f} 写明了理由`, typeof why === 'string' && why.length > 6, String(why))
  }
  // 豁免项本身必须仍然是执行器会读的字段 —— 否则豁免是僵尸条目（字段没了，条目还在）
  for (const f of Object.keys(EXEMPT_FROM_WARM)) {
    check(`豁免项 ${f} 仍是执行器读取的字段（不是僵尸条目）`, EXEC.includes(f), JSON.stringify({ f, inExec: EXEC.includes(f) }))
  }
}

// ------------------------------------------------- 5. 坐实的历史受害者：单独钉死（防止有人"清理"掉）
{
  for (const f of ['inAid', 'winTitle', 'fromX', 'count', 'maxDepth']) {
    check(`历史受害者 ${f} 仍在 cleanSteps 里（否则 flow 步静默丢参）`, CLEAN.has(f), JSON.stringify([...CLEAN].sort()))
  }
  for (const f of ['inAid', 'winTitle', 'x', 'y', 'count']) {
    check(`历史受害者 ${f} 仍在 warm payload 里（否则常驻路径下失效）`, WARM.has(f), JSON.stringify([...WARM].sort()))
  }
}

// ------------------------------------------------- 6. MCP 的 ui_flow 步骤 schema 也必须声明 cleanSteps 的字段
// Claude 第十轮真机发现（2026-09-11）：驱动的 cleanSteps **认** max/maxDepth，但 ui_flow 的步骤 schema
// 没声明 → zod 在到达驱动前剥掉 → `steps:[{action:'state',max:5}]` 真机返回 count=40（max 被静默丢弃）。
// 这是第四次"驱动修了、schema 没暴露"。凡是 cleanSteps 会转发的字段，flow 步骤 schema 都必须有声明的归宿。
{
  const serverSrc = readFileSync(join(here, '..', '..', '..', 'mcp', 'server.mjs'), 'utf8')
  const at = serverSrc.indexOf("server.tool(\n  'ui_flow'")
  const from = at >= 0 ? at : serverSrc.indexOf("'ui_flow'")
  const end = serverSrc.indexOf('server.tool(', from + 10)
  const region = serverSrc.slice(from, end < 0 ? from + 6000 : end)
  const stepsAt = region.indexOf('steps: z.array(z.object({')
  const stepsEnd = region.indexOf('})).describe', stepsAt)
  const stepBody = stepsAt >= 0 ? region.slice(stepsAt, stepsEnd < 0 ? stepsAt + 4000 : stepsEnd) : ''
  check('能解析出 ui_flow 的步骤 schema', stepBody.length > 200, 'len=' + stepBody.length)
  const declaredInSteps = new Set([...stepBody.matchAll(/^\s{6}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]))
  check('解析出步骤 schema 声明的字段（>15 个）', declaredInSteps.size > 15, 'n=' + declaredInSteps.size)
  // 不是所有 cleanSteps 字段都该出现在 flow 步骤里（有些是 drive 专用的 Node 侧参数），显式登记：
  const NOT_IN_FLOW_STEPS = {
    out: '截图落盘路径由驱动内部计算，不是步骤参数',
    maxDepth: 'tree 只在 ui_tree 工具里用；flow 步骤不含 tree 动作',
    observe: '动作后快照只在单动作路径（ui_drive/ui_act）支持',
    observeMatch: '同上',
    observeMax: '同上',
    shotsDir: '同上（截图目录由驱动/工具参数决定）',
    workspace: '同上',
    secret: 'ui_flow 用 allowSideEffects 统一授权；secret 只用于单动作的输入打码',
    // 这几个字段服务于**不在 flow 动作集里**的动作（clickat/move/wheel/坐标双击）：
    // 它们在 cleanSteps 里会被转发，但 flow 的 action enum 里没有对应动作 → 传了也没有动作会读它。
    x: '坐标动作 clickat/move/wheel 不在 flow 步骤的 action 集里',
    y: '同上',
    delta: '同上（wheel 专用）',
    button: '同上（坐标动作的鼠标键）',
    double: '同上（坐标双击）',
    // 逐步新鲜度门：flow 是**预排序列**，驱动明确不做逐步 snapshotId 校验（见 flow 注释）。
    // 这里登记为"不经 flow 暴露"，而不是让它被 zod 悄悄剥掉。
    snapshotId: 'flow 不做逐步新鲜度门（预排序列）；单动作路径的 snapshotId 不受影响',
  }
  const missingInSteps = [...CLEAN].filter((f) => !declaredInSteps.has(f) && !(f in NOT_IN_FLOW_STEPS))
  check('cleanSteps 会转发的字段在 ui_flow 步骤 schema 里都有声明（否则 zod 剥掉=静默丢参）',
    missingInSteps.length === 0, '未声明=' + JSON.stringify(missingInSteps.sort()))
  for (const f of ['max', 'inAid', 'inName', 'waitFor', 'expectValue']) {
    check(`flow 步骤 schema 声明了 ${f}`, declaredInSteps.has(f), JSON.stringify([...declaredInSteps].sort()))
  }
}

console.log(failures === 0 ? '\nPASS: ui-drive 参数转发完整性（三条白名单 vs 执行器）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
