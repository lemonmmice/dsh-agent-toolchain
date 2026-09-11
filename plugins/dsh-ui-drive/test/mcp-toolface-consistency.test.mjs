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

/**
 * 取该工具 action 参数上的 enum 取值。
 * 支持三种写法：单行内联、多行内联（可含注释）、`const uiAction = z.enum([...])` 间接引用。
 * ⚠️ 只取**单引号字符串**：多行 enum 里会写注释（`// …`），按"逗号切分"会把注释文字一起吞进来
 *    （实测就报出了 `"// … \r\n 'move"` 这种假值，反而把好 enum 判成坏的）。
 */
function toolEnum(callSrc, src) {
  const values = (body) => [...body.matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1])
  // 写法 A：action: z.enum([ ... ])   或   action: <Name>.enum([ ... ])
  let m = /action:\s*(?:z|[A-Za-z_$][\w$]*)\s*\.?\s*enum\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(callSrc)
  if (!m) {
    // 写法 B：action: uiAction（先找引用名，再回到文件里找它的定义）
    const ref = /action:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(callSrc)
    if (ref) {
      const v = ref[1]
      const at = src.lastIndexOf(`const ${v} = `)
      if (at >= 0) m = /\.enum\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(src.slice(at, at + 1200))
    }
  }
  if (!m) return null
  const out = values(m[1])
  return out.length ? out : null
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

/** 取某个 server.tool('name', ...) 注册块（到下一个 server.tool( 为止）。 */
function toolBlock(name) {
  const m = new RegExp(`server\\.tool\\(\\s*'${name}'`).exec(serverSrc)
  if (!m) return ''
  const next = serverSrc.indexOf('server.tool(', m.index + 1)
  return serverSrc.slice(m.index, next < 0 ? serverSrc.length : next)
}

/** 该工具 schema 里声明的参数名（zod 对象的键，缩进 4 空格）。 */
function declaredParams(block) {
  if (!block) return []
  const markers = ['{\n    ', '{\r\n    ']
  let schemaStart = -1
  for (const mk of markers) {
    const at = block.indexOf(mk)
    if (at >= 0 && (schemaStart < 0 || at < schemaStart)) schemaStart = at
  }
  const body = schemaStart >= 0 ? block.slice(schemaStart) : block
  return [...body.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
}

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

// ------------------------------------------------- 7. 声明的参数必须真的转发给驱动
// 第三类同类缺陷（2026-09-11 发现）：`ui_drive` 的 handler 用**手写清单**转发参数，
// 于是 schema 里后加的每一个参数都被静默丢掉——index / inAid / inName / waitFor / state /
// keys / fromX / fromY / toX / toY / steps / holdMs 全部只对模型"可见"、到不了驱动。
// 而**同一份描述**还在教模型 "use index for the Nth same-named control"、"pass waitFor=… on
// click/setvalue/…"、"drag: start X"——模型照做，参数凭空蒸发。
// 护栏：要么整个 `...args` 转发（推荐，schema 成为唯一真源），要么枚举清单必须覆盖全部声明。
{
  /** 取某个工具注册块（从 server.tool('name' 到下一个 server.tool(）——见文件顶部的 toolBlock */

  // 只检查"声明了参数、且有 handler"的工具（ui_status/ui_windows 之类无参工具跳过）
  const HANDLED = ['ui_drive', 'ui_observe', 'ui_act']
  for (const t of HANDLED) {
    const block = toolBlock(t)
    const declared = declaredParams(block)
    check(`${t}: 解析出声明的参数`, declared.length > 0, JSON.stringify(declared))

    // handler 里对该工具驱动调用的转发形态
    const usesSpread = /drv\(\)\.drive\(\{\s*\.\.\.args/.test(block) || /drv\(\)\.drive\(args\)/.test(block)
    if (usesSpread) {
      check(`${t}: 以 ...args 整体转发（schema 即唯一真源，不会再漂移）`, true)
      continue
    }
    // 否则：枚举清单必须覆盖全部声明参数
    const callM = /drv\(\)\.drive\(\{([\s\S]*?)\n\s*\}\)/.exec(block)
    const forwarded = callM ? [...callM[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]) : []
    check(`${t}: 解析出转发的参数`, forwarded.length > 0, JSON.stringify(forwarded))
    const dropped = declared.filter((d) => !forwarded.includes(d))
    check(`${t}: 声明的参数没有一个被静默丢掉`, dropped.length === 0,
      '被丢掉=' + JSON.stringify(dropped) + '（改用 {...args} 即可根治）')
  }

  // 钉死"u_drive 曾经的具体受害者"，防止有人改回手写清单
  const driveBlock = toolBlock('ui_drive')
  const priorVictims = ['index', 'inAid', 'inName', 'waitFor', 'state', 'keys', 'fromX', 'fromY', 'toX', 'toY', 'steps', 'holdMs']
  const stillSpread = /drv\(\)\.drive\(\{\s*\.\.\.args/.test(driveBlock)
  check('ui_drive 仍以 ...args 转发（历史上 12 个参数被丢的那批）', stillSpread,
    '否则 index/inAid/inName/waitFor/fromX… 会再次到不了驱动')
  for (const v of priorVictims) {
    check(`ui_drive 仍在 schema 里声明 ${v}`, new RegExp(`^\\s{4}${v}\\s*:`, 'm').test(driveBlock))
  }
}

// ------------------------------------------------- 8. 已实现的能力不得对模型不可达
// 第四类同类缺陷：驱动把 W5 原语（pattern/scroll/selecttext）实现完了，但 MCP 的 enum 没放进去，
// 于是这些能力对**模型**等于不存在（只是躺在代码里的死代码）。
// 判据：凡驱动 BATCH_ONLY / READ_ONLY 支持的动作，至少要有一个 MCP 工具能调到它。
{
  // 从驱动里读"它到底支持哪些动作"，而不是手抄
  const driverSrc = readFileSync(join(here, '..', 'lib', 'driver.mjs'), 'utf8')
  const setOf = (name) => {
    const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(driverSrc)
    return m ? [...m[1].matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1]) : []
  }
  const batchOnly = setOf('BATCH_ONLY_ACTIONS')
  const readOnly = setOf('READ_ONLY_ACTIONS')
  check('解析出驱动的 BATCH_ONLY_ACTIONS', batchOnly.length > 0, JSON.stringify(batchOnly))
  check('解析出驱动的 READ_ONLY_ACTIONS', readOnly.length > 0, JSON.stringify(readOnly))

  // MCP 工具 enum 的并集 + ui_flow 的**步骤** action enum = 模型实际能调到的动作全集
  const reachable = new Set()
  for (const t of TOOLS) for (const a of (parsed[t].enum || [])) reachable.add(a)
  // ui_flow 的步骤是另一套动作集（含只读伪动作 wait/expect），模型同样能调到
  const flowM = /server\.tool\(\s*'ui_flow'[\s\S]*?z\.enum\(\[([\s\S]*?)\]\s*\)/.exec(serverSrc)
  const flowActions = flowM ? [...flowM[1].matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]) : []
  check('解析出 ui_flow 的步骤动作集', flowActions.length > 0, JSON.stringify(flowActions))
  for (const a of flowActions) reachable.add(a)

  // W5 三原语必须可达（这次修复的核心）
  for (const a of ['pattern', 'scroll', 'selecttext']) {
    check(`W5 原语 ${a} 对模型可达（至少一个 MCP 工具能调）`, reachable.has(a),
      '可达集=' + JSON.stringify([...reachable].sort()))
  }
  // 其它已实现但曾经不可达的
  for (const a of ['clickat', 'doubleclick', 'capture']) {
    check(`已实现动作 ${a} 对模型可达`, reachable.has(a), '可达集=' + JSON.stringify([...reachable].sort()))
  }

  // 登记豁免：驱动里出现但**本来就不是动作**的名字，必须写明理由，不能沉默地漏
  const NOT_ACTIONS = new Set([
    'alt', 'ctrl', 'shift', // 键盘修饰键**子标签**（Get-ModVk 的 switch 分支），不是可调用动作
  ])
  const unreachable = [...new Set([...batchOnly, ...readOnly, ...DRIVER])]
    .filter((a) => !INTERNAL.has(a) && !NOT_ACTIONS.has(a) && !reachable.has(a))
  check('没有"驱动支持却对模型不可达"的动作（除已登记的非动作/内部名）', unreachable.length === 0,
    '不可达=' + JSON.stringify(unreachable.sort()))
}

// ------------------------------------------------- 9. 驱动接受的字段必须在 MCP schema 里声明
// 第五类同类缺陷（W5 独立核查发现）：MCP SDK 只把 **zod 解析后**的对象交给 handler
// （zod 默认 strip 未知键），所以**没在 schema 里声明的参数，无论 handler 怎么转发都到不了驱动**。
// 实测受害者：`count`（scroll 页数 — 缺了它 scroll 恒滚 1 页且不报错）、
//             `expectValue`（selecttext 的 suffix / type 的回读校验）。
// 真值来源用 `batch()` 的 cleanSteps —— 那份清单就是"驱动确实会交给执行器"的字段全集。
{
  const driverSrc = readFileSync(join(here, '..', 'lib', 'driver.mjs'), 'utf8')
  // cleanSteps 保留的字段就是执行器认识的字段
  const cleanSection = driverSrc.slice(driverSrc.indexOf('const cleanSteps'), driverSrc.indexOf('writeFileSync(stepsFile'))
  const executorFields = [...new Set([...cleanSection.matchAll(/if \(s\.([A-Za-z_][\w]*)\s*!==/g)].map((m) => m[1]))]
  check('解析出执行器可接受的字段集（cleanSteps）', executorFields.length > 5, JSON.stringify(executorFields))

  // MCP 三个工具声明的参数并集
  const declaredOnMcp = new Set()
  for (const t of TOOLS) for (const p of declaredParams(toolBlock(t))) declaredOnMcp.add(p)
  // ui_drive/ui_observe/ui_act 之外，ui_state 也接受 max 等
  for (const t of ['ui_state', 'ui_windows']) for (const p of declaredParams(toolBlock(t))) declaredOnMcp.add(p)

  // 这三个是**坐实过的受害者**，单独钉死（避免有人"清理"掉它们）
  for (const f of ['count', 'expectValue']) {
    check(`驱动接受的字段 ${f} 已在 MCP schema 里声明（否则被 zod 静默剥掉）`, declaredOnMcp.has(f),
      '已声明=' + JSON.stringify([...declaredOnMcp].sort()))
  }

  // 通用护栏：凡驱动交给执行器的字段，MCP 面必须至少有一个工具声明它；
  // 未声明的要么补上，要么登记为"不经 MCP 面暴露"并写明理由。
  const NOT_EXPOSED = new Set([
    'out', // 截图落盘路径，由驱动内部计算，不是模型该传的
  ])
  const missing = executorFields.filter((f) => !declaredOnMcp.has(f) && !NOT_EXPOSED.has(f))
  check('没有"驱动接受但 MCP 面未声明"的字段（除已登记的非模型参数）', missing.length === 0,
    '未声明=' + JSON.stringify(missing.sort()) + '（未声明 = zod 会剥掉 = 模型传了也没用）')
}

// ------------------------------------------------- 10. ui_flow 的步骤 enum 必须覆盖驱动的 FLOW_ACTIONS
// 第六处同类缺陷（独立 MCP/插件面对照审计发现）：驱动实现了 19 个 flow 动作，
// 但 MCP 的 ui_flow 步骤 enum 只列了 13 个 —— `pattern`/`scroll`/`selecttext`/
// `expectwindow`/`expecttext`/`waitany` 被 zod 在到达驱动前就拒掉（INVALID_ARGS），
// 而插件面（裸 array，无 item schema）却能通过 ⇒ 同一能力两个面行为不一致。
{
  const driverSrc2 = readFileSync(join(here, '..', 'lib', 'driver.mjs'), 'utf8')
  const fm = /const FLOW_ACTIONS = new Set\(\[([^\]]*)\]/.exec(driverSrc2)
  const flowTruth = fm ? [...fm[1].matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1]) : []
  check('解析出驱动的 FLOW_ACTIONS', flowTruth.length > 0, JSON.stringify(flowTruth))

  // MCP ui_flow 的步骤 action enum（多行，含注释）
  const flowBlock = /server\.tool\(\s*'ui_flow'/.exec(serverSrc)
  const flowRegion = flowBlock ? serverSrc.slice(flowBlock.index, serverSrc.indexOf('server.tool(', flowBlock.index + 1)) : ''
  const em = /action:\s*z\.enum\(\[([\s\S]*?)\]\s*\)/.exec(flowRegion)
  const flowEnum = em ? [...em[1].matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1]) : []
  check('解析出 MCP ui_flow 的步骤 enum', flowEnum.length > 0, JSON.stringify(flowEnum))

  const missingFlow = flowTruth.filter((a) => !flowEnum.includes(a))
  check('驱动能跑的每个 flow 动作都在 ui_flow 步骤 enum 里（否则被 zod 提前拒）', missingFlow.length === 0,
    '缺失=' + JSON.stringify(missingFlow) + '（插件面却可通过 ⇒ 两个面行为不一致）')

  // 反向：enum 里不该有驱动 flow 跑不了的动作（会变成"看着能跑其实必失败"）
  const extraFlow = flowEnum.filter((a) => !flowTruth.includes(a))
  check('ui_flow 步骤 enum 没有驱动跑不了的动作', extraFlow.length === 0,
    '多余=' + JSON.stringify(extraFlow))
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive MCP toolface consistency test')
