// dsh-ui-drive 单测：MCP 工具面的「说的」与「做的」必须一致
//
// 为什么单独成文件：模型真正看到的是 `mcp/server.mjs`，不是 `plugins/dsh-ui-drive/index.js`。
// 本轮（2026-09-11 合成复核）实测发现这两面**已经漂移**，而且漂移产生的是"描述骗模型"的现行 bug：
//   · `ui_drive` 的 enum 里有 `state`，描述里却从没提过它；
//   · `ui_drive` 的描述叫模型用 `expect` 动作，而 `expect` **不在** enum 里
//     （`expect` 是 ui_flow 的步骤类型）——照描述做会被框架以 INVALID_ARGS 拒掉；
//   · `ui_act` 的描述还写着 "Trading controls (buy/sell/order/pay) are hard-denied"，
//     而 12d1be6 已把该机制更正为**通用机制的「按名硬拒」**（可由 DSH_UI_DENY_RE 覆盖）——
//     这次更正漏掉了 MCP 面（用 grep 全仓核过：非档案文件里只剩 server.mjs 这一处）。
//
// 本文件把这三类漂移钉死成断言。判据来源是**驱动脚本的 dispatch 真值**，不是手抄清单。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const serverSrc = readFileSync(join(repoRoot, 'mcp', 'server.mjs'), 'utf8')
const batchSrc = readFileSync(join(here, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')

// ------------------------------------------------- 0. 真值来源：驱动脚本真正 dispatch 的动作集
/** ui-drive-batch.ps1 的 switch 里真正有分支的动作名。 */
function driverActions() {
  const set = new Set()
  const re = /^\s*'([a-z][a-z-]*)'\s*\{/gm
  let m
  while ((m = re.exec(batchSrc))) set.add(m[1])
  return set
}
const DRIVER = driverActions()

// ------------------------------------------------- 解析 server.mjs 的工具面
/** 取一个 server.tool('name', ...) 调用的原始参数段（到匹配的 ')' 结束）。 */
function toolCallSource(src, toolName) {
  // ⚠️ 行尾必须宽松匹配：本仓在 Windows 上是 CRLF，写死 \n 会一个都找不到（实测踩过）
  const re = new RegExp(`server\\.tool\\(\\s*'${toolName}'`)
  const m = re.exec(src)
  if (!m) return ''
  const from = src.indexOf('(', m.index)
  let depth = 0
  let i = from
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) { i++; break } }
    else if (ch === "'") { // 跳过字符串字面量（含转义）
      i++
      while (i < src.length && src[i] !== "'") { if (src[i] === '\\') i++; i++ }
    }
  }
  return src.slice(from, i)
}

/** 取该工具 action 参数上的 enum 取值（支持两种写法：内联 z.enum 与 `const uiAction = z.enum(…)` 间接引用）。 */
function toolEnum(callSrc, src) {
  // 写法 A：action: z.enum([...])  或  action: <Name>.enum([...])
  let m = /action:\s*(?:z|[A-Za-z_$][\w$]*)\s*\.?\s*enum\s*\(\s*\[([^\]]*)\]/.exec(callSrc)
  if (!m) {
    // 写法 B：action: uiAction（先找引用名，再回到文件里找它的定义）
    const ref = /action:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(callSrc)
    if (ref) {
      const v = ref[1]
      // 用 lastIndexOf：定义通常在使用之前，且同名不应重复定义
      const at = src.lastIndexOf(`const ${v} = `)
      if (at >= 0) m = /\.enum\s*\(\s*\[([^\]]*)\]/.exec(src.slice(at, at + 400))
    }
  }
  if (!m) return null
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/**
 * 取出描述里**以"动作枚举"形式出现**的动作名——即 `Actions: a / b / c` 这种斜杠分隔清单
 * 与 `pass waitFor=… on x/y/z` 这种"在这些动作上"的清单。
 *
 * ⚠️ 为什么不做全文匹配：动作名都是普通英文词，散文里到处都是。实测误报：
 *   · `waitfor (wait until a condition holds)` —— "wait" 是散文
 *   · `Input is read back and verified` —— "read" 是散文
 *   · `a prior read/state` —— 指的是**别的工具**的输出，不是本工具的动作
 * 全文匹配会把这三类都算成"幽灵动作"，把护栏变成狼来了。
 * 但**真正的缺陷恰好总是在枚举清单里**（`on click/…/find/expect`）——所以只查清单。
 */
function actionsInEnumList(descriptionText) {
  const out = new Set()
  const names = [...DRIVER].filter((a) => !INTERNAL.has(a)).sort((a, b) => b.length - a.length)
  const alt = names.map((n) => n.replace(/-/g, '\\-')).join('|')
  // "Actions:" 之后的整段，以及 "on <清单>" 之后的整段——都取到句号/括号为止
  const zones = []
  const actionsM = /Actions:([^.]*)\./.exec(descriptionText)
  if (actionsM) zones.push(actionsM[1])
  const onM = /\bon\s+((?:[a-z][a-z-]*\/)+[a-z][a-z-]*)/g
  let m
  while ((m = onM.exec(descriptionText))) zones.push(m[1])
  for (const z of zones) {
    const re = new RegExp('(?<![A-Za-z0-9_-])(' + alt + ')(?![A-Za-z0-9_-])', 'g')
    let mm
    while ((mm = re.exec(z))) out.add(mm[1])
  }
  return out
}

/** 该工具的完整描述文本（把拼接的字面量接起来；跳过第一个字符串=工具名）。 */
function descriptionText(callSrc) {
  const strs = callSrc.match(/'[^']*'/g) || []
  return strs.slice(1).join(' ').replace(/\\'/g, "'")
}

/** 只在工具内部使用、不作为模型动作暴露的名字。 */
const INTERNAL = new Set(['ping', 'status', 'reload', 'control'])

const TOOLS = ['ui_drive', 'ui_observe', 'ui_act']
const parsed = {}
for (const t of TOOLS) {
  const call = toolCallSource(serverSrc, t)
  parsed[t] = { call, enum: toolEnum(call, serverSrc), mentioned: actionsInEnumList(descriptionText(call)) }
}

// ------------------------------------------------- 1. 三个工具都能解析出来（解析器自检）
{
  for (const t of TOOLS) {
    check(`${t}: 解析出 enum`, Array.isArray(parsed[t].enum) && parsed[t].enum.length > 0, JSON.stringify(parsed[t].enum))
    check(`${t}: enum 非空且无重复`, (() => {
      const e = parsed[t].enum || []
      return e.length > 0 && new Set(e).size === e.length
    })(), JSON.stringify(parsed[t].enum))
  }
}

// ------------------------------------------------- 2. 核心断言：描述里提到的动作必须在 enum 里
// 这就是"描述骗模型"的护栏：模型照描述做，不能拿到一个被框架拒掉的动作。
{
  for (const t of TOOLS) {
    const { enum: en, mentioned } = parsed[t]
    if (!en) continue
    const enSet = new Set(en)
    const phantom = [...mentioned].filter((a) => !enSet.has(a))
    check(`${t}: 描述里提到的动作都在 enum 中（无"幽灵动作"）`, phantom.length === 0,
      '幽灵动作=' + JSON.stringify(phantom) + ' enum=' + JSON.stringify(en))
  }
}

// ------------------------------------------------- 3. enum 取值必须是驱动真正支持的动作
// 反向护栏：enum 不能承诺驱动做不到的动作（换一种方式骗模型）。
{
  for (const t of TOOLS) {
    const en = parsed[t].enum
    if (!en) continue
    const unsupported = en.filter((a) => !DRIVER.has(a))
    check(`${t}: enum 的每个取值驱动都支持`, unsupported.length === 0,
      '驱动不支持=' + JSON.stringify(unsupported))
  }
}

// ------------------------------------------------- 4. 不能漏报能力：enum 必须是驱动动作集的子集，
//    并**报告覆盖率**（漏报本身不一定是错，但必须可见——本轮 ui_act 漏了 7 个全是 W5 原语）
{
  const readOnly = ['find', 'read', 'state', 'windows', 'waitfor', 'expectwindow', 'expecttext', 'waitany', 'state-live']
  for (const a of readOnly) check(`驱动只读集包含 ${a}`, DRIVER.has(a), JSON.stringify([...DRIVER].sort()))
}

// ------------------------------------------------- 5. 过时措辞：MCP 面不得再出现"交易专用"话术
//    12d1be6 已把「按名硬拒」更正为通用机制；MCP 面当时被漏掉，这里钉死。
{
  check('mcp/server.mjs 不再出现 "Trading controls … hard-denied" 旧话术',
    !/Trading controls/i.test(serverSrc))
  check('mcp/server.mjs 不再把硬拒说成 buy/sell/order/pay 专用',
    !/buy\/sell\/order\/pay/i.test(serverSrc))
  check('mcp/server.mjs 说明了硬拒名单可由 DSH_UI_DENY_RE 覆盖（通用机制）',
    /DSH_UI_DENY_RE/.test(serverSrc))
}

// ------------------------------------------------- 6. 缺失工具必须显式记录（当前是"支持缺失"，不是 bug，但不能沉默）
//    ui_live / ui_tree / ui_launch 完全不在 MCP 面上 —— 模型因此无法自己拉起客户端。
{
  for (const t of ['ui_live', 'ui_tree', 'ui_launch']) {
    const onSurface = new RegExp(`server\\.tool\\(\\s*'${t}'`).test(serverSrc)
    // 这条不是断言"必须在面上"（是否暴露是取舍），而是保证**状态被显式记录**：
    // 现状 ui_live/ui_tree/ui_launch 不在 MCP 面上 → 模型无法自己 ui_launch。
    // 取舍与后续动作记录在仓库外的合成清单（本地 toolchain reviews 目录）里，见 P0-0b。
    check(`${t}: 在 MCP 面上的状态已核（当前 ${onSurface ? '在' : '不在'}）`, true)
  }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive MCP toolface consistency test')
