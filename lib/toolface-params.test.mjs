// lib/toolface-params.test.mjs — 两面工具的**参数级**对称 gate（E4 的第二半）。
//
// 为什么需要（这才是这一轮真正的修复）：
//   `toolface-parity.test.mjs` 比的是**工具名**，文件里明确写着「参数级的对称由各自的 smoke 保证」。
//   那句话是**空头保证**：插件加载冒烟只证明 schema **编得过**，从来不比较两面。
//   代价在本轮（r42）被量出来了（bench-runs/dbg-20260911/_probe-params.log）：
//     7 个工具的参数集不一致，而且**两个方向都有**：
//       · DSH 面 ui_drive 少 7 个**驱动层真实实现**的参数（winHandle/double/button/focus/
//         expectValue/observeMax/shotsDir）⇒ 我（DSH 侧 agent）按名字选 ui_drive 时这些能力**调不到**；
//       · DSH 面 ui_act 少 5 个（count/mods/x/y/observeMax）；ui_observe 少 stableCount；
//         ui_status/ui_state 少 procId（多实例无法消歧）；
//       · 反向还有**幽灵参数**：MCP 面 ui_drive 的 expectEnabled/expectMatch（只有流程的 expect 步会读，
//         而 ui_drive 的 action 枚举里没有 'expect'）、ui_act 的 shotsDir（动作枚举里没有 shot）。
//     ——也就是说：**同一个能力，在一面能调、在另一面根本不存在**，而两面的**工具名**完全一致。
//
// 判据（全部取**运行时真值**，静态正则两边都不用 —— 只认字面量会被动态注册绕过而假绿，@codex r35 的证伪）：
//   插件面 = 用假 ctx 真装载**仓库源码**的每个插件（`module.register` 解析钩子把裸包名
//            `@deepseek-ai/dsh-tools` 指到本机真实包 ⇒ 不必先 deploy，避免"比的是不同版本"）；
//   MCP 面 = 真起 `mcp/server.mjs`，走 JSON-RPC `initialize` + `tools/list` 读 `inputSchema`。
//   比较：参数名集合（两个方向）、同名参数的 `enum`、`required`。
//
// 退出码：0 = 通过；1 = 有断言不成立；拿不到运行时集合时**逐条 SKIP 并打印原因**（不静默当成通过）。
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
// r54：被调方读取点从"按名字在目录里搜"换成"按函数接线"（实现与理由见 lib/callee-wiring.mjs）
import { buildScope, analyzeParams, defineToolHandlerBody, handlerBodyOf, splitTopLevel } from './callee-wiring.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let skipped = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' — ' + why) }

// ── 自检：断言器不能恒真 ──
{
  let sawFail = false
  const probe = (c) => { if (!c) sawFail = true }
  probe(false)
  check('（自检）断言器有效', sawFail)
}

const { ALIASES, ALIAS_COUNT_EXPECTED, reverseAliases } = await import(pathToFileURL(join(REPO, 'lib', 'tool-aliases.mjs')).href)

// ── 比较器（与"抽取"分开，便于下面用合成数据反向自证它不是恒真） ──
/** 取一个参数 schema 的"嵌套属性名集合"（array items.properties / object properties）。
 *  返回 null = 这一侧**没有**嵌套 schema（数组/对象没有 item 结构 ⇒ 什么都收得下）。 */
export function nestedOf(p) {
  if (!p) return null
  const inner = p.items && p.items.properties ? p.items : (p.properties ? p : null)
  if (!inner) return null
  return { props: Object.keys(inner.properties).sort(), permissive: inner.additionalProperties !== false }
}

/** 比较器（与"抽取"分开，便于下面用合成数据反向自证它不是恒真）。 */
export function compareTool(a, b) {
  const pa = a?.properties || {}
  const pb = b?.properties || {}
  const ka = Object.keys(pa)
  const kb = Object.keys(pb)
  const onlyA = ka.filter((k) => !kb.includes(k)).sort()
  const onlyB = kb.filter((k) => !ka.includes(k)).sort()
  const enumDiffs = []
  const typeDiffs = []
  // r44：**类型**也是一条独立维度（G1 黑盒 #2 抓到 `ui_drive.mods` 一面 array、一面 string）。
  //   归一化：JSON Schema 的 `integer` 与 zod 的 `number` 是同一件事（实现里没差别），不算漂移；
  //   其余差异（string↔array/boolean…）都算 —— 因为调用方会按声明的类型构造参数。
  const normType = (t) => (t === 'integer' ? 'number' : (t === undefined ? '(无 type)' : t))
  for (const k of ka) {
    if (!kb.includes(k)) continue
    const ea = pa[k] && pa[k].enum !== undefined ? JSON.stringify(pa[k].enum) : null
    const eb = pb[k] && pb[k].enum !== undefined ? JSON.stringify(pb[k].enum) : null
    if (ea !== eb) enumDiffs.push({ param: k, a: ea, b: eb })
    const ta = normType(pa[k] && pa[k].type)
    const tb = normType(pb[k] && pb[k].type)
    // 一侧完全没有 type（例如只写了 description）+ 另一侧有：报出来但归为"表示法差异"（见下）
    if (ta !== tb) typeDiffs.push({ param: k, a: ta, b: tb, bothTyped: !!(pa[k] && pa[k].type) && !!(pb[k] && pb[k].type) })
  }
  const ra = JSON.stringify([...(a?.required || [])].slice().sort())
  const rb = JSON.stringify([...(b?.required || [])].slice().sort())
  // 嵌套层（r42 追加）：`ui_flow.steps` 这类"数组套对象"的参数，字段是写在 items 里的。
  //   —— 又一个"只查一层"的例子：顶层参数名一致，不代表步骤字段一致。
  const nested = []
  for (const k of ka) {
    if (!kb.includes(k)) continue
    const na = nestedOf(pa[k])
    const nb = nestedOf(pb[k])
    if (!na && !nb) continue
    if (!na || !nb) { nested.push({ param: k, kind: 'loose', a: na ? na.props : null, b: nb ? nb.props : null }); continue }
    const missingA = na.props.filter((x) => !nb.props.includes(x))
    const missingB = nb.props.filter((x) => !na.props.includes(x))
    if (!missingA.length && !missingB.length) continue
    // 判据：真正会**丢字段**的只有一种情况 —— 名字少的那一侧还是**严格模式**
    //（additionalProperties:false ⇒ 多出来的字段会被剥掉）。宽松模式只是"文档少写了"。
    const strictStrip = (missingA.length && !nb.permissive) || (missingB.length && !na.permissive)
    nested.push({ param: k, kind: strictStrip ? 'strict-strip' : 'doc-only', a: na.props, b: nb.props, missingA, missingB })
  }
  return { onlyA, onlyB, enumDiffs, typeDiffs, requiredDiff: ra === rb ? null : { a: ra, b: rb }, nested }
}

// ── ★★ 反向自证：合成的不一致必须被同一套比较器抓出来 ──
{
  const A = { properties: { keep: { type: 'string' }, onlyA: { type: 'number' }, e: { type: 'string', enum: ['x'] } }, required: ['keep'] }
  const B = { properties: { keep: { type: 'string' }, onlyB: { type: 'boolean' }, e: { type: 'string', enum: ['y'] } }, required: ['keep', 'onlyB'] }
  const r = compareTool(A, B)
  check('（反向自证）比较器能抓出"只在 A"的参数', JSON.stringify(r.onlyA) === '["onlyA"]', JSON.stringify(r.onlyA))
  check('（反向自证）比较器能抓出"只在 B"的参数', JSON.stringify(r.onlyB) === '["onlyB"]', JSON.stringify(r.onlyB))
  check('（反向自证）比较器能抓出 enum 不一致', r.enumDiffs.length === 1 && r.enumDiffs[0].param === 'e', JSON.stringify(r.enumDiffs))
  check('（反向自证）比较器能抓出 required 不一致', r.requiredDiff !== null, JSON.stringify(r.requiredDiff))
  const same = compareTool(A, A)
  check('（反向自证）完全相同的两侧必须报"无差异"（否则比较器恒报错，gate 会变成噪声）',
    same.onlyA.length === 0 && same.onlyB.length === 0 && same.enumDiffs.length === 0 && same.requiredDiff === null)
  // 嵌套层也要自证：严格模式少字段 = 会丢字段；宽松模式少字段 = 只是文档少写
  //   ⚠ 构造时先想清楚"哪一侧名字更少"，再由**那一侧**决定结论 —— 第一版我就把两侧写反了，
  //     断言失败时看着像比较器坏了，其实是自证用例自己搭错了（这正是"要被证伪的是用例"的活例子）。
  const mk = (names, permissive) => ({ properties: { s: { type: 'array', items: { type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])), additionalProperties: permissive ? {} : false } } } })
  const strict = compareTool(mk(['x', 'y'], true), mk(['x'], false)).nested
  check('（反向自证）嵌套层：少字段的那侧是**严格模式** ⇒ 报 strict-strip（会真的丢字段）',
    strict.length === 1 && strict[0].kind === 'strict-strip', JSON.stringify(strict))
  const loose = compareTool(mk(['x', 'y'], true), mk(['x'], true)).nested
  check('（反向自证）嵌套层：少字段的那侧是**宽松模式** ⇒ 只报 doc-only（不丢字段，别当故障）',
    loose.length === 1 && loose[0].kind === 'doc-only', JSON.stringify(loose))
  // 类型维度也要自证（r44 新增）
  const typeA = { properties: { z: { type: 'string' } } }
  const typeB = { properties: { z: { type: 'array' } } }
  const td = compareTool(typeA, typeB).typeDiffs
  check('（反向自证）比较器能抓出 type 漂移（string vs array），且标成"两侧都写了 type"',
    td.length === 1 && td[0].bothTyped === true, JSON.stringify(td))
  const intNum = compareTool({ properties: { n: { type: 'integer' } } }, { properties: { n: { type: 'number' } } }).typeDiffs
  check('（反向自证）`integer` 与 `number` **不算**漂移（JSON Schema 与 zod 的表示法差异，实现上无差别）',
    intNum.length === 0, JSON.stringify(intNum))
}

// ── 解析钩子：把裸包名指到本机真实包，让**仓库源码**也能 import 插件 ──
//    为什么值得这么做：否则插件面只能从 profile（部署副本）装载 ⇒ 比的是"仓库的 MCP 面 vs 部署的插件面"，
//    一旦忘了 deploy，这个 gate 就在比较两个不同版本，而它**看不出来**。
let dshToolsEntry = ''
{
  try {
    const { createRequire } = await import('node:module')
    const anchor = pathToFileURL(join(process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'profiles', 'web', 'plugins', 'dsh-perf', 'index.js')).href
    dshToolsEntry = createRequire(anchor).resolve('@deepseek-ai/dsh-tools')
  } catch (e) { dshToolsEntry = '' }
}
const hookDir = mkdtempSync(join(tmpdir(), 'dsh-param-gate-'))
const hookPath = join(hookDir, 'resolve-hook.mjs')
// 钩子做两件事，缺一不可：
//   ① 显式把 `@deepseek-ai/dsh-tools` 指到真实包（这个包是插件**加载期**就要用的）；
//   ② 任何**其它裸包名**（`ws` 等）也从 profile 的 node_modules 兜底解析 ——
//      只映射 dsh-tools 是不够的：第一版就因此让 dsh-postman 装载失败（找不到 `ws`），
//      而它的失败会级联成"http_request 在插件面不存在"，看起来像"两面工具集不一致"（假阳性）。
// 钩子的做法：仓库里**没有** node_modules（插件用的是裸包名），所以第一次解析必然失败；
// 这时把这次解析**换个父路径**（改挂到 profile 里那个真装了依赖的插件入口上）再试一次 —
// 由 Node 自己按 `import` 条件解析，而不是我拿 `require.resolve` 猜一个路径。
//   ⚠ 第一版就是"自己猜路径"（`require.resolve` + pathToFileURL）：`ws` 的 require 入口与
//     import 入口**不是同一个文件**，猜出来的 CJS 入口在 ESM 下没有具名导出 ⇒
//     `The requested module 'ws' does not provide an export named 'WebSocket'` ⇒ dsh-postman 装载失败
//     ⇒ 级联成"http_request 在插件面不存在"的**假阳性**。
const anchorEntry = join(process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'profiles', 'web', 'plugins', 'dsh-perf', 'index.js')
writeFileSync(hookPath, `import { pathToFileURL } from 'node:url'
const anchor = pathToFileURL(process.env.DSH_RESOLVE_ANCHOR).href
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (e) {
    // 只有"裸包名"才换父路径重试：相对/绝对/file:/node: 的失败必须原样抛出（否则会掩盖真实错误）
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('node:')) throw e
    try {
      return await nextResolve(specifier, { ...context, parentURL: anchor })
    } catch { throw e }
  }
}
`, 'utf8')
process.env.DSH_RESOLVE_ANCHOR = anchorEntry
if (dshToolsEntry) {
  const { register } = await import('node:module')
  register(pathToFileURL(hookPath).href)
}

// ── 插件面：真装载（假 ctx） ──
function makeFakeCtx(record) {
  const stub = (name) => (...args) => { record.unknownCalls.push(name + '/' + args.length); return () => {} }
  const base = {
    effect: (fn, label) => {
      try { const d = fn(); return () => { try { if (typeof d === 'function') d() } catch { /* 拆解失败不改结论 */ } } }
      catch (e) { record.applyErrors.push((label || '(no label)') + ': ' + e.message); return () => {} }
    },
    tools: { register: (t) => { record.tools.push(t); return () => {} } },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : (typeof p === 'string' ? stub(p) : undefined)), has: () => true })
}

const pluginTools = new Map() // name → { properties, required }
const toolOwner = new Map() // 工具名 → 插件目录名（被调方读取点检查要按插件目录找源码）
const toolHandlers = new Map() // 工具名 → execute（F-051 的回归：**必须有人真的执行它**，见 1e 节）
const toolOutputs = new Map() // 工具名 → output（F-055 的回归：**返回结果必须能被它自己的 output.schema 接受**）
const pluginProblems = []
{
  const pluginsRoot = join(REPO, 'plugins')
  for (const d of readdirSync(pluginsRoot, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const entry = ['index.js', join('lib', 'index.js')].map((r) => join(pluginsRoot, d.name, r)).find((p) => existsSync(p) && statSync(p).isFile())
    if (!entry) { pluginProblems.push(d.name + ': 找不到入口'); continue }
    const record = { tools: [], applyErrors: [], unknownCalls: [] }
    try {
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.apply !== 'function') { pluginProblems.push(d.name + ': 没有导出 apply(ctx)'); continue }
      mod.apply(makeFakeCtx(record))
    } catch (e) {
      pluginProblems.push(d.name + ' 装载失败: ' + (e && e.message ? e.message : String(e)))
      continue
    }
    for (const e of record.applyErrors) pluginProblems.push(d.name + ' effect 内抛错: ' + e)
    for (const t of record.tools) {
      if (!t || !t.name) { pluginProblems.push(d.name + ': 有工具没写 name'); continue }
      if (pluginTools.has(t.name)) pluginProblems.push('工具名重复: ' + t.name)
      pluginTools.set(t.name, t.parameters || {})
      toolOwner.set(t.name, d.name)
      toolHandlers.set(t.name, t.execute)
      toolOutputs.set(t.name, t.output)
    }
  }
}

// ── MCP 面：运行时 tools/list ──
async function mcpTools() {
  let child
  try {
    child = spawn(process.execPath, [join(REPO, 'mcp', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch { return null }
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(d))
  const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  try {
    child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'param-gate', version: '0' } }))
    child.stdin.write(rpc(2, 'tools/list'))
  } catch { try { child.kill() } catch { /* ignore */ } ; return null }
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ } ; resolve(null) }, 60000)
    const iv = setInterval(() => {
      for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
        if (!line.includes('"id":2')) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        clearInterval(iv); clearTimeout(t)
        try { child.kill() } catch { /* ignore */ }
        resolve(msg.result?.tools ?? null)
        return
      }
    }, 150)
  })
}

// ---------------------------------------------------------------------------
// 0. ★ 抽取器自证：两边都必须**真的抽到东西**
//    （本 gate 的探针第一版就踩过：插件面因为解析不到裸包名抽到 **0** 个工具，
//      而"0 个"在下游差集逻辑里看起来只是"少了些工具" —— 空抽取的假绿。）
// ---------------------------------------------------------------------------
check('★ 插件面抽取有效（≥40 个工具）', pluginTools.size >= 40, 'plugin=' + pluginTools.size)
if (pluginTools.size === 0 && !dshToolsEntry) {
  skip('插件面装载', '解析不到 @deepseek-ai/dsh-tools（无 profile / 未安装）—— 参数级对称**未验证**')
}
check('插件面装载无问题（每个插件都 apply 成功、工具都有 name）', pluginProblems.length === 0, pluginProblems.join(' ; '))

const mcpList = await mcpTools()
const mcpToolsMap = new Map()
for (const t of mcpList || []) mcpToolsMap.set(t.name, t.inputSchema || {})
check('★ MCP 面抽取有效（≥40 个工具）', mcpToolsMap.size >= 40, 'mcp=' + mcpToolsMap.size)
if (mcpToolsMap.size === 0) skip('MCP 面比对', 'tools/list 没拿到（子进程起不来/超时）—— 参数级对称**未验证**')

// 别名表本身要有人看着（绊线）
check('别名条目数与钉死的常量一致（增删别名必须显式改这一行）',
  Object.keys(ALIASES).length === ALIAS_COUNT_EXPECTED,
  '实际 ' + Object.keys(ALIASES).length + ' 条')
for (const [mcpName, dshName] of Object.entries(ALIASES)) {
  check('别名两端都真实存在：' + mcpName + ' ↔ ' + dshName,
    mcpToolsMap.has(mcpName) && pluginTools.has(dshName),
    'mcp=' + mcpToolsMap.has(mcpName) + ' dsh=' + pluginTools.has(dshName))
}

// ---------------------------------------------------------------------------
// 1. 参数级对称：逐个工具比 **参数名集合 / enum / required**
// ---------------------------------------------------------------------------
if (pluginTools.size && mcpToolsMap.size) {
  const rev = reverseAliases()
  const nameMismatch = []
  const nestedNotes = []
  const typeNotes = []
  for (const [name, props] of pluginTools) {
    const mcpName = rev[name] || name
    const other = mcpToolsMap.get(mcpName)
    if (!other) { nameMismatch.push(name + '（MCP 面没有 ' + mcpName + '）'); continue }
    const r = compareTool(props, other)
    const label = name + (mcpName === name ? '' : ' (mcp: ' + mcpName + ')')
    if (r.onlyA.length) check('★ ' + label + '：只在 DSH 面的参数（DSH 侧 agent 能传、MCP 侧传不了）', false, r.onlyA.join(', '))
    else check('★ ' + label + '：没有"只在 DSH 面"的参数', true)
    if (r.onlyB.length) check('★ ' + label + '：只在 MCP 面的参数（MCP 侧能传、DSH 侧传不了）', false, r.onlyB.join(', '))
    else check('★ ' + label + '：没有"只在 MCP 面"的参数', true)
    if (r.enumDiffs.length) check('★ ' + label + '：同名参数的 enum 一致', false,
      r.enumDiffs.map((d) => d.param + ' DSH=' + d.a + ' MCP=' + d.b).join(' ; '))
    else check('★ ' + label + '：同名参数的 enum 一致', true)
    // 类型：两侧**都写了 type** 却不一样 ⇒ 真漂移（调用方会按声明的类型构造参数）；一侧没写 type ⇒ 只记录
    const typeReal = r.typeDiffs.filter((d) => d.bothTyped)
    check('★ ' + label + '：同名参数的 **type** 一致', typeReal.length === 0,
      typeReal.map((d) => d.param + ' DSH=' + d.a + ' MCP=' + d.b).join(' ; '))
    for (const d of r.typeDiffs) if (!d.bothTyped) typeNotes.push(label + '.' + d.param + '（一侧未声明 type：DSH=' + d.a + ' MCP=' + d.b + '）')
    if (r.requiredDiff) check('★ ' + label + '：required 一致', false, JSON.stringify(r.requiredDiff))
    else check('★ ' + label + '：required 一致', true)
    // 嵌套层：会真的丢字段的（strict-strip）必须红；只是"文档少写了"（doc-only）单独报出来、不算故障
    const strictNested = r.nested.filter((n) => n.kind === 'strict-strip')
    check('★ ' + label + '：嵌套字段不会被对面剥掉（严格模式下的少字段会丢）', strictNested.length === 0,
      strictNested.map((n) => n.param + ' 少=' + JSON.stringify(n.missingA.length ? n.missingA : n.missingB)).join(' ; '))
    for (const n of r.nested) if (n.kind !== 'strict-strip') nestedNotes.push(label + '.' + n.param + (n.kind === 'loose' ? '（一侧无 item 结构 ⇒ 什么都收得下）' : '（宽松模式，仅文档差异）'))
  }
  check('每个插件面工具都能在 MCP 面找到对应工具', nameMismatch.length === 0, nameMismatch.join(' ; '))
  // 反向：MCP 面独有的名字（别名洗白会让这里为空 —— 与 toolface-parity 的绊线同一逻辑）
  const onlyMcp = [...mcpToolsMap.keys()].filter((n) => !pluginTools.has(n) && !ALIASES[n]).sort()
  check('★ MCP 面没有"对面完全没有"的工具', onlyMcp.length === 0, onlyMcp.join(', '))
  // 嵌套层的"文档差异"如实列出来 —— 不算故障，但不许悄悄消失（否则下一个人不知道这里本来就有差异）
  console.log('       嵌套层差异（doc-only，不丢字段）：' + (nestedNotes.length ? nestedNotes.join(' ; ') : '无'))
  console.log('       类型差异（一侧未声明 type）：' + (typeNotes.length ? typeNotes.join(' ; ') : '无'))
}

// ---------------------------------------------------------------------------
// 1b. ★★ 能力**基线**（Codex r42 复核的 P1）
//
// 起因（它给了可复现的做法）：上面的比较是**两两对照** —— 如果**两面同时**删掉同一个参数，
// `onlyA/onlyB/enum/type/required/nested` 全空 ⇒ gate 全绿。也就是说
// **"两面对称"证明不了"能力还在"**，这是 pairwise gate 的**结构性上限**（我在聊天室里也担心过这一点）。
//
// 对策：把当前能力快照**钉死**成 `lib/toolface-baseline.json`，断言"基线 ⊆ 两面"：
//   · 删参数（任意一面、或两面一起删）⇒ **红**（这正是要拦的：静默的能力消失）；
//   · 加参数 ⇒ 只**提示**（新增能力是好事，但要让基线跟着走，免得基线慢慢脱节）；
//   · 工具集也钉死（少一个工具 = 红），因为 `≥40 个工具` 只是下限，不是完整性。
// 刷新基线必须显式做：`$env:DSH_TOOLFACE_BASELINE_UPDATE=1; node lib/toolface-params.test.mjs`
// —— 加个环境变量这道手续，是为了让"基线变了"成为一次**有意识**的动作（同 ALIASES 的绊线逻辑）。
// ---------------------------------------------------------------------------
if (pluginTools.size && mcpToolsMap.size) {
  const rev = reverseAliases()
  const baselinePath = join(REPO, 'lib', 'toolface-baseline.json')
  const snapshot = {}
  for (const [name, params] of pluginTools) snapshot[name] = Object.keys(params.properties || {}).sort()
  const header = {
    version: 1,
    note: '工具**能力基线**：两面（DSH 插件面 / MCP 面）都必须至少提供这些参数。' +
      '由 lib/toolface-params.test.mjs 维护；刷新须显式带 DSH_TOOLFACE_BASELINE_UPDATE=1 跑一次。' +
      '删除条目 = 声明"这个能力不要了"，请在提交说明里写理由。',
  }
  const hadBaseline = existsSync(baselinePath)
  if (process.env.DSH_TOOLFACE_BASELINE_UPDATE === '1' || !hadBaseline) {
    writeFileSync(baselinePath, JSON.stringify({ ...header, generatedAt: new Date().toISOString(), tools: snapshot }, null, 2) + '\n', 'utf8')
    console.log('  ok   能力基线已' + (hadBaseline ? '刷新' : '写入（首次）') + '：' + Object.keys(snapshot).length + ' 个工具')
  }
  let baseline = null
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) } catch (e) { baseline = null }
  check('能读到能力基线 lib/toolface-baseline.json', baseline !== null && baseline.tools && typeof baseline.tools === 'object')
  if (baseline && baseline.tools) {
    const missingTools = Object.keys(baseline.tools).filter((t) => !pluginTools.has(t))
    check('★★ 基线里的工具**一个都没少**（少一个 = 能力被拿掉了，不是"少抽到了"）', missingTools.length === 0, missingTools.join(', '))
    const newTools = [...pluginTools.keys()].filter((t) => !(t in baseline.tools))
    if (newTools.length) console.log('       （新增工具，未在基线里：' + newTools.join(', ') + ' —— 刷新基线即可纳入）')
    const droppedParams = []
    for (const [tool, params] of Object.entries(baseline.tools)) {
      if (!pluginTools.has(tool)) continue
      const dshParams = Object.keys((pluginTools.get(tool).properties) || {})
      const mcpMap = mcpToolsMap.get(rev[tool] || tool)
      const mcpParams = mcpMap ? Object.keys(mcpMap.properties || {}) : []
      for (const p of params) {
        if (!dshParams.includes(p)) droppedParams.push(tool + '.' + p + '（DSH 面已无）')
        if (mcpMap && !mcpParams.includes(p)) droppedParams.push(tool + '.' + p + '（MCP 面已无）')
      }
    }
    check('★★ 基线里的**参数**两面的都还在（删参数必红 —— 这是"两面一起退化"唯一的护栏）',
      droppedParams.length === 0, droppedParams.join(' ; '))
    const newParams = []
    for (const [name, params] of pluginTools) {
      for (const p of Object.keys(params.properties || {})) if (baseline.tools[name] && !baseline.tools[name].includes(p)) newParams.push(name + '.' + p)
    }
    if (newParams.length) console.log('       （新增参数，未在基线里：' + newParams.slice(0, 12).join(', ') + (newParams.length > 12 ? ' …共 ' + newParams.length + ' 个' : '') + '）')
  }
}

// ---------------------------------------------------------------------------
// 1c. ★★ 幽灵参数检测（Codex r42 复核的第二条 P1）：**声明了，但实现里从来没读到**
//
// 活样本就在眼前：MCP 面 `ui_drive.describe` 曾经声明"describe=true 会返回视觉描述"，
// 而 handler 只把 args 转发给驱动 —— **从来没有实现**（r44 被 G1 黑盒抓到并修）。
// 上面那些断言都抓不到它：它**两面都有**（对称）、参数名在基线里、enum/required/type 都对。
//
// 判据（对每个工具的**定义块全文**查证据，两条任一成立即算有归宿）：
//   A. **点名读到**：`args.P` / `args?.P` / `args["P"]` / 解构 `{…P…} = args`；
//   B. **整包转发**：块里有把整个 args 交给别人的调用（`fn(args)` / `...args`）——
//      这类不算"读过"，只是**转交**；被转交的工具会**逐个列出来**（见输出），
//      它的读点必须由**被调方**的守卫负责（ui-drive 有 param-forwarding-completeness 那一套）。
// 判红：既没点名读到、也没有整包转发 ⇒ 这个参数**没有任何归宿** = 幽灵。
// ---------------------------------------------------------------------------
{
  /**
   * 先把注释挖掉，再做括号配对。
   *
   * ⚠ 第一版**没有**这一步，结果一个都没抓准：JS 注释里大量出现英文撇号（`driver's gate`、`don't`），
   *   而我的扫描器把 `'` 当字符串开头 ⇒ 一路吞到下一个引号 ⇒ 括号计数全乱 ⇒ 工具的"块"根本不是那个工具。
   *   （这类"注释里的引号"是解析源码时的经典坑，必须显式处理，注释掉的部分也不该参与判定。）
   */
  const stripComments = (src) => {
    let out = ''
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]
      const nx = src[i + 1]
      if (ch === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue }
      if (ch === '/' && nx === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue }
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch
        out += ch
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++ } out += src[i]; i++ }
        out += q
        continue
      }
      out += ch
    }
    return out
  }
  /** 括号配对取原文（跳过字符串字面量），用于把"一个工具的整块定义"抠出来。 */
  const sliceBalanced = (src, from, open, close) => {
    let depth = 0
    for (let i = from; i < src.length; i++) {
      const ch = src[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
        continue
      }
      if (ch === open) depth++
      else if (ch === close) { depth--; if (depth === 0) return src.slice(from, i + 1) }
    }
    return src.slice(from, from + 6000)
  }
  /** 插件面：defineTool({ … }) 的块（含 name / parameters / output / execute）。 */
  const defineToolBlocks = (src) => {
    const out = []
    for (const m of src.matchAll(/defineTool\(\s*\{/g)) {
      const at = src.indexOf('{', m.index)
      const body = sliceBalanced(src, at, '{', '}')
      const nm = /name:\s*'([^']+)'/.exec(body)
      if (nm) out.push({ name: nm[1], body })
    }
    return out
  }
  /** MCP 面：server.tool('name', …) 的块。 */
  const serverToolBlocks = (src) => {
    const out = []
    for (const m of src.matchAll(/server\.tool\(\s*'([^']+)'/g)) {
      const at = src.indexOf('(', m.index)
      out.push({ name: m[1], body: sliceBalanced(src, at, '(', ')') })
    }
    return out
  }
  const evidenceOf = (body, p) => {
    const named = new RegExp(
      'args\\??\\.' + p + '\\b' +
      '|args\\[\\s*[\'"]' + p + '[\'"]\\s*\\]' +
      '|\\{[^{}]*\\b' + p + '\\b[^{}]*\\}\\s*=\\s*args').test(body)
    if (named) return 'named'
    // 整包转发：把 args 整个交出去（而不是读某个字段）
    const forwarded = /\w+\(\s*args\s*\)|\.\.\.args\b|\w+\(\s*\{\s*\.\.\.args/.test(body)
    return forwarded ? 'forwarded' : 'none'
  }
  const ghosts = []
  const forwardedTools = []
  for (const d of readdirSync(join(REPO, 'plugins'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const entry = ['index.js', join('lib', 'index.js')].map((r) => join(REPO, 'plugins', d.name, r)).find((p) => existsSync(p) && statSync(p).isFile())
    if (!entry) continue
    const src = stripComments( readFileSync(entry, 'utf8'))
    const blocks = new Map(defineToolBlocks(src).map((b) => [b.name, b.body]))
    for (const [name, params] of pluginTools) {
      if (!(name in Object.fromEntries(blocks))) continue
      const body = blocks.get(name)
      for (const p of Object.keys(params.properties || {})) {
        const ev = evidenceOf(body, p)
        if (ev === 'none') ghosts.push('DSH ' + name + '.' + p)
        else if (ev === 'forwarded') forwardedTools.push('DSH ' + name)
      }
    }
  }
  if (mcpToolsMap.size) {
    const src = stripComments( readFileSync(join(REPO, 'mcp', 'server.mjs'), 'utf8'))
    const blocks = new Map(serverToolBlocks(src).map((b) => [b.name, b.body]))
    for (const [name, schema] of mcpToolsMap) {
      const body = blocks.get(name)
      if (!body) continue
      for (const p of Object.keys(schema.properties || {})) {
        const ev = evidenceOf(body, p)
        if (ev === 'none') ghosts.push('MCP ' + name + '.' + p)
        else if (ev === 'forwarded') forwardedTools.push('MCP ' + name)
      }
    }
  }
  console.log('       （整包转发给被调方的工具，读点由被调方守卫负责：' + [...new Set(forwardedTools)].sort().join(', ') + '）')
  check('★★ 没有任何"声明了、实现里从没读到"的参数（幽灵参数；活样本：MCP ui_drive.describe）',
    ghosts.length === 0, ghosts.sort().join(' ; '))
  // ⚠ **已知边界（如实登记，见 PROGRESS §38.4）**：spread 转发的工具（`drive({ ...args })`）对本闸**免检** ——
  //   它们的参数读点在**被调方**（drv().drive → driver.mjs/ui-drive-batch.ps1）。所以把"免检名单"钉死：
  //   它**可以缩小**（收紧规则），但**不许悄悄变大**（新增一个 spread 工具 = 多一个无人看守的角落）。
  const SPREAD_EXEMPT_EXPECTED = 28
  const spreadTools = [...new Set(forwardedTools)].sort()
  check('★ 整包转发（免检）的工具数没有悄悄变大：' + spreadTools.length + ' 个（上限钉死 ' + SPREAD_EXEMPT_EXPECTED + '）',
    spreadTools.length <= SPREAD_EXEMPT_EXPECTED, spreadTools.join(', '))
  const dshForwarded = new Set(spreadTools.filter((x) => x.startsWith('DSH ')).map((x) => x.slice(4)))
  check('★ 其中 ui-drive 那一族有**被调方守卫**（param-forwarding-completeness 覆盖了驱动读取点）',
    ['ui_drive', 'ui_act', 'ui_observe', 'ui_flow'].every((t) => dshForwarded.has(t)),
    [...dshForwarded].sort().join(', '))

  // -------------------------------------------------------------------------
  // 1e. ★★ **工具的 execute 体真的能被调用吗**（r54 新增，F-051 的回归钉）
  //
  // 为什么必须有这一节 —— 这一个 bug 把整套闸的盲区照亮了：
  //   `build_compile_check` 的 execute 从它加进来的那天起（r43）写的是
  //     `bld().config().clientRoot`
  //   —— 而 `makeBuilder()` 返回的 `{ config: c, … }` 里 **`config` 是对象、不是函数**。
  //   只要调用方**没显式传 repoRoot**（也就是工具的**默认推导路径**），它必定抛
  //     `TypeError: bld(...).config is not a function`。
  //   而它当时"通过"的全部是：**注册**（toolface-parity）、**参数集**（本节 1a–1d）、
  //   **插件加载冒烟**（plugin-load-smoke）—— **没有任何一关执行过 execute 体**。
  //   ⇒ 一个**从来没工作过**的工具能安静地躺在 47 个工具里两天，每一关都是绿的。
  //   MCP 面同一个工具写的是 `bld().config ? bld().config() : {}`：守卫判的是**真值**而不是
  //   **是不是函数**，对象恒为真 ⇒ 同样抛。**两面的写法不同、错得一样**。
  //
  // 口径（只测"能不能跑完"，不测业务正确性 —— 那由各自的单测负责）：
  //   · 只挑**只读**工具；带副作用的**逐个登记理由**，表只许缩小；
  //   · 断言 ① 拿得到 execute 且是函数 ② 调用**不抛** ③ 返回一个对象。
  // -------------------------------------------------------------------------
  {
    /** 只读、可安全执行（参数给最小合法值）。 */
    const READ_ONLY_CALLS = [
      ['build_compile_check', { file: 'lib/callee-wiring.mjs' }],   // F-051 的现场：不传 repoRoot 走默认推导
      ['build_status', {}],
      ['build_errors', {}],
      ['toolchain_status', {}],
      ['perf_clean', {}],                                            // 默认只看不删（有单测钉住）
      ['perf_report', {}],
      ['failure_stats', {}],
      ['failure_query', { limit: 1 }],
      ['hang_status', {}],
      ['hang_packs', {}],
      ['hang_pack', { id: 'no-such-pack-r54' }],                      // 故意给不存在的 id：要**报错**，不许抛
      ['api_capture_status', {}],
      ['api_capture_query', { limit: 1 }],
      ['memory_status', {}],
      ['memory_search', { query: 'r54-execute-smoke', k: 1 }],
      ['memory_recall', { key: 'r54-execute-smoke' }],
      ['ui_status', {}],
    ]
    /** 明确**不执行**的（会写盘/发网络/驱动客户端），登记理由；表只许缩小。 */
    const NOT_EXECUTED_HERE = {
      build_run: '会真的启动构建（几分钟 + 写日志）', perf_probe: '会真的起监测循环',
      perf_dump: '会挂起目标进程抓 dump', perf_trace: '要管理员 + 写 etl', perf_analyze: '需要真实 dump',
      perf_heap: '需要真实 dump', perf_hotstacks: '需要真实 etl', hang_run: '会起监测进程', hang_stop: '会停监测',
      hang_analyze: '需要真实证据包', hang_delete: '**会删证据**', ui_launch: '会启动真实客户端',
      ui_drive: '会真的操作客户端', ui_act: '会真的操作客户端', ui_observe: '要客户端在跑', ui_flow: '会真的操作客户端',
      ui_state: '要客户端在跑', ui_windows: '要客户端在跑', ui_tree: '要客户端在跑', ui_live: '会起抓帧循环',
      http_request: '会真的发网络请求', api_capture_start: '会起抓包引擎', api_capture_stop: '会停抓包引擎',
      api_capture_append: '会写捕获库', memory_save: '会写 KV', memory_forget: '会删 KV', memory_index: '会建索引（慢）',
      failure_record: '会写失败样本库', failure_retract: '会改失败样本库', verify_report: '会写裁决报告',
    }
    check('★ 只读执行清单非空**且只许变大**（读到 0 条 = 本节已变成空断言；从 17 掉下来 = 有人在悄悄缩覆盖）',
      READ_ONLY_CALLS.length >= 17, String(READ_ONLY_CALLS.length) + '（标定值 17）')
    // ---- ★★ 输出必须能被它**自己的** output.schema 接受（F-055）----
    // 为什么必须加这一关：`api_capture_query` 的 execute 返回里带着 `retention`/`retentionNote`，
    // 而它的 output.schema 是 `additionalProperties: false` 却**没声明这两个字段** ⇒
    // **宿主判"非法输出"，整个工具直接不可用**（调用方只拿到一行 Error，什么数据都没有）。
    // 这类漂移"注册/参数/加载"三关都看不见 —— 只有**真的执行一次，并拿宿主自己的校验器验一遍**才看得见。
    // 校验器就用宿主那一个：`@deepseek-ai/dsh-tools` 导出的 `validateJsonSchemaValue`（与它拒我们的那份同源）。
    let validateValue = null
    let whyNoValidator = ''
    try {
      const mod = await import(pathToFileURL(dshToolsEntry).href)
      validateValue = mod.validateJsonSchemaValue || null
      if (!validateValue) whyNoValidator = '包里没有导出 validateJsonSchemaValue'
    } catch (e) { whyNoValidator = e && e.message ? String(e.message).split('\n')[0] : String(e) }

    const asIssues = []
    const outputIssues = []
    const unverifiable = []
    let withSchema = 0
    for (const [name, args] of READ_ONLY_CALLS) {
      const fn = toolHandlers.get(name)
      if (typeof fn !== 'function') { asIssues.push(name + ': 拿不到 execute（注册了但没给函数）'); continue }
      let result
      try {
        result = await fn(args)
        if (!result || typeof result !== 'object') asIssues.push(name + ': execute 没返回对象（返回了 ' + typeof result + '）')
      } catch (e) {
        asIssues.push(name + ': execute **抛了** ' + (e && e.message ? e.message : String(e)))
        continue
      }
      const out = toolOutputs.get(name)
      if (!out || !out.schema) continue
      withSchema++
      if (!validateValue) continue
      try {
        // ⚠ **它是"返回违规数组"型、不是"抛错"型**（`validateJsonSchemaValue` 的文档原话：
        //   "returns path-qualified violations"）。第一版我把它包在 try/catch 里、把"不抛"当成合法
        //   ⇒ **这一关恒绿**（删掉 schema 声明也照样过）。**是证伪把它抓出来的**（第 19/44 类老毛病）。
        const violations = validateValue(out.schema, result)
        if (Array.isArray(violations) && violations.length) {
          outputIssues.push(name + ': ' + String(violations[0].message || violations[0]).split('\n')[0] +
            (violations.length > 1 ? '（共 ' + violations.length + ' 处）' : ''))
        } else if (!Array.isArray(violations)) {
          // 返回了不是数组的东西 ⇒ 判不了就**说出来**，不许当成通过
          unverifiable.push(name + ': 校验器返回了 ' + typeof violations + '（不是违规数组）⇒ 判不了')
        }
      } catch (e) {
        outputIssues.push(name + ': 校验器抛错 ' + String(e && e.message ? e.message : e).split('\n')[0])
      }
    }
    check('★★ 只读工具的 execute 体**都能跑完**（F-051：`build_compile_check` 曾因 `bld().config()` ' +
      '在"不传 repoRoot 的默认路径"上必定抛错，而当时每一关都是绿的）',
      asIssues.length === 0, asIssues.join(' | '))
    if (!validateValue) {
      skip('只读工具的返回值能否被自己声明的 output.schema 接受（F-055）', whyNoValidator)
    } else {
      check('★ 这一关真的覆盖到了带 output.schema 的工具（读到 0 个 = 空断言）', withSchema >= 12, String(withSchema))
      check('★★ 每个只读工具的**返回值**都能被它自己声明的 `output.schema` 接受（F-055：`api_capture_query` 因 ' +
        '`additionalProperties:false` 却没声明 `retention` 而被宿主判"非法输出"，**整个工具不可用**）',
        outputIssues.length === 0, outputIssues.join(' | '))
      check('★ 没有"判不了"的（校验器返回了非数组 ⇒ 那一格不算通过）', unverifiable.length === 0, unverifiable.join(' | '))
    }
    // 哨兵：登记表里的工具必须**确实**没被执行（哪天把它挪进只读清单，就该从表里删掉）
    const stale = Object.keys(NOT_EXECUTED_HERE).filter((t) => READ_ONLY_CALLS.some(([n]) => n === t))
    check('★ 未执行登记表没有僵尸项（挪进只读清单的应从表里删掉）', stale.length === 0, stale.join(', '))
    console.log('       （execute 冒烟：只读执行 ' + READ_ONLY_CALLS.length + ' 个；**因副作用不执行** ' +
      Object.keys(NOT_EXECUTED_HERE).length + ' 个（逐个写了理由）；⚠ **MCP 面的 execute 体仍未被执行** —— ' +
      '本轮只修了它的同一个 bug，没加执行覆盖）')
  }

  // -------------------------------------------------------------------------
  // 1d. ★★ **被调方读取点：按函数接线**（r54；取代 r47 的"按名字在目录里搜"）
  //
  // r47 那一版的边界被 §39.3 的证伪钉死了：它是**对整目录语料按名字搜**，
  // 删掉 `lib/failure-corpus.mjs` 里 `failure_query.q` 的真实读取（`q.q`）**闸不红**，
  // 因为 `lib/capture-store.mjs` 里另有一个也叫 `q` 且真被读的参数。
  // ⇒ 它只能证"整个语料里这名字没痕迹"，**不能**证"是这条工具的参数被读了"。
  //
  // 这一版把范围从「目录」收成「**接收这个整包的那一个函数体**」（实现见 `lib/callee-wiring.mjs`）：
  //   工具 handler → 整包转发的被调方 → 具体函数 → 在该函数体里证明参数被读
  //   （形参自身解构 / `opts.P` / `?.P` / 再转发一层，深度上限 4）。
  //   按**参数**分派（不是按工具）：handler 里具名读到了就算证到，否则才去被调方证 ——
  //   真实代码里两种形态**混在同一条 handler 里**（`drive({ action:'state', match: args.match || '' })`），
  //   按工具二选一会两头都错（Codex r54 §1.2 的反驳，已采纳）。
  //
  // 判红/口径（两条都是**只许缩小**，照本仓 `SPREAD_EXEMPT_EXPECTED` 的先例）：
  //   · `WIRED_ALL_PARAMS`：这些工具**每个参数**都能按函数证到 —— 一旦某个参数掉回 unresolved，立刻红（抓静默退化）；
  //   · `KNOWN_UNWIRED`：还有 unresolved 参数的工具 —— **精确登记**（钉死），未登记的工具冒出 unresolved 也算红；
  //     未解析的原因逐条打印（是"跨语言"还是"被调方形态接不上"要看得见，不许糊成一句"未查"）。
  // -------------------------------------------------------------------------
  {
    const REL = (abs) => relative(REPO, abs).replace(/\\/g, '/')
    const pluginLibDirs = readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => join(REPO, 'plugins', x.name, 'lib'))
      .filter((p) => existsSync(p))

    /** 只在 handler 体上判"整包转发"（r47 那一版是在**整个块**上判，会把 `async (args)` 也算进去）。 */
    const looksForwarded = (body) => /\w+\(\s*args\s*\)|\.\.\.args\b|\w+\(\s*\{\s*\.\.\.args/.test(body)

    const inputs = []
    for (const d of readdirSync(join(REPO, 'plugins'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const entry = ['index.js', join('lib', 'index.js')].map((r) => join(REPO, 'plugins', d.name, r)).find((p) => existsSync(p) && statSync(p).isFile())
      if (!entry) continue
      const src = stripComments(readFileSync(entry, 'utf8'))
      const blocks = new Map(defineToolBlocks(src).map((b) => [b.name, b.body]))
      for (const [name, schema] of pluginTools) {
        const block = blocks.get(name)
        if (!block) continue
        const h = defineToolHandlerBody(block)
        if (!looksForwarded(h.bodyRaw)) continue
        inputs.push({ face: 'DSH', tool: name, entryAbs: entry, h, params: Object.keys(schema.properties || {}) })
      }
    }
    if (mcpToolsMap.size) {
      const entry = join(REPO, 'mcp', 'server.mjs')
      const src = stripComments(readFileSync(entry, 'utf8'))
      for (const b of serverToolBlocks(src)) {
        const schema = mcpToolsMap.get(b.name)
        if (!schema) continue
        const h = handlerBodyOf(splitTopLevel(b.body.slice(1, -1)).slice(-1)[0] || '')
        if (!looksForwarded(h.bodyRaw)) continue
        inputs.push({ face: 'MCP', tool: b.name, entryAbs: entry, h, params: Object.keys(schema.properties || {}) })
      }
    }
    check('★ 两面的「整包转发」工具都扫到了（读到 0 个 = 本节已变成空断言）',
      inputs.filter((x) => x.face === 'DSH').length >= 15 && inputs.filter((x) => x.face === 'MCP').length >= 11,
      'DSH=' + inputs.filter((x) => x.face === 'DSH').length + ' MCP=' + inputs.filter((x) => x.face === 'MCP').length +
      '（下界是标定值；**变多**是好事，变少说明扫描器退化了）')

    const proved = new Map()     // 'DSH ui_drive.action' → 'plugins/…/driver.mjs:drive via=field'
    const unproved = []          // { key, tool, reason }
    const perTool = new Map()    // 'DSH ui_drive' → { total, ok }
    for (const w of inputs) {
      const scope = buildScope({
        entryAbs: w.entryAbs,
        extraDirs: w.face === 'DSH' ? [join(REPO, 'lib')] : [join(REPO, 'lib'), ...pluginLibDirs],
      })
      const r = analyzeParams({ scope, handlerBody: w.h.bodyRaw, params: w.params, argsIdent: w.h.argsIdent, repoRel: REL })
      const tag = w.face + ' ' + w.tool
      const all = w.params.length
      for (const [p, v] of r.reads) proved.set(tag + '.' + p, v.where + ' via=' + v.via + ' chain=' + (v.chain || []).join('→'))
      for (const u of r.unresolved) unproved.push({ key: tag + '.' + u.param, tool: tag, reason: u.reason })
      perTool.set(tag, { total: all, ok: all - r.unresolved.length })
    }

    // ---- 只许缩小的两张登记表 ----
    // WIRED_ALL_PARAMS：这些工具**每一个**参数都按函数证到了。只许**变大**（多了是好事），
    //   但表内工具一旦退化成"有 unresolved"就是**静默退化**，立刻红。
    const WIRED_ALL_PARAMS = [
      'DSH build_run', 'DSH failure_query', 'DSH failure_record', 'DSH failure_retract', 'DSH http_request',
      'DSH perf_dump', 'DSH perf_hotstacks', 'DSH perf_probe', 'DSH perf_trace', 'DSH ui_flow', 'DSH verify_report',
      'MCP capture_query', 'MCP failure_query', 'MCP failure_record', 'MCP failure_retract',
      'MCP perf_dump', 'MCP perf_hotstacks', 'MCP perf_trace', 'MCP verify_report',
    ]
    // KNOWN_UNWIRED：还有 unresolved 参数的工具（钉死当前集合）。**只许缩小**。
    //   ⚠ "未接线 **不等于** 有问题" —— 它就是**未证**（本仓第 35 类：窗口内没有 ≠ 不存在）。
    //   ⚠⚠ 理由必须**逐条写准**（Claude r54 §Q3 的实测反驳）：第一版把 7 个工具一律写成
    //      "参数交给 PowerShell、跨语言不在范围"—— 那句话**对 `api_capture_query` 是假的**，
    //      它全程纯 JS。把不同原因糊成一句，就是"把问题登记掉"而不是"把问题收小"。
    //   · ui-drive 一族（DSH/MCP 的 ui_drive / ui_observe / ui_act）：参数最终交给
    //     **PowerShell**（`ui-drive.ps1` / `ui-drive-batch.ps1`），跨语言那一截不在本模块范围内
    //     —— 它们另有 `param-forwarding-completeness` 覆盖（连 PS 脚本的 `$req.P` 一起查）。
    //   · `api_capture_query`：**纯 JS、没有 PowerShell**；真因是分析器跟不过
    //     `paramsFromObj(args)`（`Object.entries` 动态枚举 + `URLSearchParams.get`）→ `applyFilters(params)`
    //     这条**对象重建**链（读点确实存在：`plugins/dsh-api-visualizer/lib/index.js` 的 `applyFilters`）。
    //     ⇒ 这一条是"**分析器能力边界**"，不是"跨语言"，也不是"参数没被读"。
    const KNOWN_UNWIRED = [
      'DSH api_capture_query', 'DSH ui_act', 'DSH ui_drive', 'DSH ui_observe',
      'MCP ui_act', 'MCP ui_drive', 'MCP ui_observe',
    ]

    const regressed = WIRED_ALL_PARAMS.filter((t) => { const s = perTool.get(t); return s && s.ok !== s.total })
    // ⚠ 失败信息必须**点名到具体参数**：只报"某工具退化了"没法直接指认是哪条读取没了
    //   （Codex r54 §3 的要求：证伪要断言"失败项精确包含某个键"，不能只断言"有失败"）。
    const regressedDetail = regressed.map((t) => {
      const s = perTool.get(t)
      const keys = unproved.filter((u) => u.tool === t).map((u) => u.key + ' ← ' + u.reason)
      return t + '（' + (s ? s.ok + '/' + s.total : '未扫到') + '）：' + keys.join(' ; ')
    })
    check('★★ 已"每个参数都按函数证到"的工具没有退化（要么参数掉回 unresolved，要么工具/参数被改名）',
      regressed.length === 0, regressedDetail.join(' | '))
    const missingTool = WIRED_ALL_PARAMS.filter((t) => !perTool.has(t))
    check('★ WIRED_ALL_PARAMS 里没有僵尸项（工具不存在/不再整包转发 ⇒ 删掉这行）',
      missingTool.length === 0, missingTool.join(', '))

    const unwiredNow = [...new Set(unproved.map((u) => u.tool))].sort()
    const newlyUnwired = unwiredNow.filter((t) => !KNOWN_UNWIRED.includes(t))
    check('★★ 没有**新出现**的"接不上被调方"的工具（新工具带整包转发就得先接线，或显式登记）',
      newlyUnwired.length === 0, newlyUnwired.join(', ') +
      '\n        要登记就把它加进 KNOWN_UNWIRED 并写明原因；能接上就别登记。')
    const zombieUnwired = KNOWN_UNWIRED.filter((t) => !unwiredNow.includes(t))
    check('★ KNOWN_UNWIRED 只许缩小：登记里已经接上的应删掉',
      zombieUnwired.length === 0, '这些已经不再是 unresolved，请从表里删掉：' + zombieUnwired.join(', '))

    // ---- ★★ 参数级地板（**每个**被扫工具，不只 WIRED_ALL_PARAMS）----
    // Claude r54 §Q3 实测指出：工具级登记有个盲区 —— 一个工具**已经**在 KNOWN_UNWIRED 里，
    // 于是它内部"原本证得到的参数悄悄退化成 unresolved"**没有人报警**，
    // 而这恰恰与 Codex §3 要求的"失败要**点名到参数**"相反。
    // 所以给每个工具钉一条**参数数地板**（只许升不许降）。
    const PROVED_FLOOR = {
      'DSH api_capture_query': 4, 'DSH build_run': 9, 'DSH failure_query': 8, 'DSH failure_record': 7,
      'DSH failure_retract': 3, 'DSH http_request': 5, 'DSH perf_dump': 1, 'DSH perf_hotstacks': 8,
      'DSH perf_probe': 4, 'DSH perf_trace': 5, 'DSH ui_act': 9, 'DSH ui_drive': 10, 'DSH ui_flow': 4,
      'DSH ui_observe': 7, 'DSH verify_report': 4,
      'MCP capture_query': 20, 'MCP failure_query': 8, 'MCP failure_record': 7, 'MCP failure_retract': 3,
      'MCP perf_dump': 1, 'MCP perf_hotstacks': 8, 'MCP perf_trace': 5, 'MCP ui_act': 9, 'MCP ui_drive': 7,
      'MCP ui_observe': 4, 'MCP verify_report': 4,
    }
    const floorBreaches = Object.entries(PROVED_FLOOR)
      .map(([t, n]) => ({ t, floor: n, now: perTool.has(t) ? perTool.get(t).ok : -1 }))
      .filter((x) => x.now < x.floor)
      .map((x) => x.t + ' ' + x.now + ' < 地板 ' + x.floor +
        '（掉下来的：' + unproved.filter((u) => u.tool === x.t).map((u) => u.key).join(', ') + '）')
    check('★★ 每个工具"按函数证到的参数数"都不低于**参数级地板**（覆盖全部 26 个被扫工具 —— ' +
      '只覆盖 WIRED_ALL_PARAMS 会漏掉"已登记工具内部的悄悄退化"，那是 Claude r54 §Q3 指出的盲区）',
      floorBreaches.length === 0, floorBreaches.join(' | '))

    // 下面三个是 r47 时代的"函数参数解构"登记例外 —— 按函数接线之后它们**应当**被规则 A 命中。
    // 这条哨兵把这次**升级**钉住：哪天解构解析退化了，它会红。
    for (const key of ['DSH perf_probe.capture', 'DSH perf_probe.intervalMs', 'DSH verify_report.claims']) {
      check('★★ r47 当初只能"登记例外"的参数，现在由解构规则**证到了**：' + key,
        proved.has(key) && /via=destructure/.test(proved.get(key)), String(proved.get(key)))
    }

    const reasonTally = {}
    for (const u of unproved) { const k = String(u.reason).replace(/\(.*$/, ''); reasonTally[k] = (reasonTally[k] || 0) + 1 }
    // 标定开关：把两张表按**当前真实结果**打印成可直接粘贴的 JS 字面量。
    //   **刻意不写第二份实现** —— 打印用的就是上面同一份计算结果（本仓第 38 类：同一逻辑许两份必然漂移）。
    if (process.env.DSH_WIRING_PRINT_LISTS === '1') {
      const wired = [...perTool.entries()].filter(([, v]) => v.ok === v.total && v.total > 0).map(([t]) => t).sort()
      const unwired = [...new Set(unproved.map((u) => u.tool))].sort()
      console.log('    --- WIRED_ALL_PARAMS（' + wired.length + ' 个）---')
      for (const t of wired) console.log("      '" + t + "',")
      console.log('    --- KNOWN_UNWIRED（' + unwired.length + ' 个）---')
      for (const t of unwired) console.log("      '" + t + "',")
      console.log('    --- PROVED_FLOOR（每个工具按函数证到的参数数，参数级地板）---')
      for (const t of [...perTool.keys()].sort()) console.log("      '" + t + "': " + perTool.get(t).ok + ',')
      console.log('    --- 原因分布 --- ' + JSON.stringify(reasonTally))
    }
    console.log('       （按函数接线：' + inputs.length + ' 个整包转发工具 / ' + (proved.size + unproved.length) +
      ' 个参数；**按函数证到 ' + proved.size + ' 个**；未证 ' + unproved.length + ' 个：' +
      Object.entries(reasonTally).map(([k, v]) => k + '=' + v).join('、') + '）')
    if (unproved.length) {
      const byTool = {}
      for (const u of unproved) { (byTool[u.tool] = byTool[u.tool] || []).push(u.key.split('.').slice(1).join('.') + '(' + String(u.reason).replace(/\(.*$/, '') + ')') }
      for (const [t, list] of Object.entries(byTool)) {
        console.log('         · ' + t + ' 未证 ' + list.length + '/' + perTool.get(t).total + '：' + list.slice(0, 6).join(', ') + (list.length > 6 ? ' …' : ''))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. ★★ 陷阱断言：`enum` 必须与 `type` 同层
//    实测（本机 dsh-tools）：`{ enum: ['a','b'] }`（无 type）会被
//    `assertSupportedJsonSchema` 判为 `requires type or oneOf` ⇒ **插件加载期抛** ⇒ 整个宿主起不来。
//    这个断言在**仓库源码**上跑，等于把"加载冒烟"的那一关提前到改代码的当场。
// ---------------------------------------------------------------------------
{
  let assertSupported = null
  let why = ''
  try {
    const mod = await import(pathToFileURL(dshToolsEntry).href)
    assertSupported = mod.assertSupportedJsonSchema || null
    if (!assertSupported) why = '包里没有导出 assertSupportedJsonSchema'
  } catch (e) { why = e && e.message ? String(e.message).split('\n')[0] : String(e) }
  if (!assertSupported) {
    skip('参数的 JSON Schema 全部能被 dsh-tools 接受（enum 无 type 会让宿主加载期崩）', why)
  } else {
    const bad = []
    for (const [name, params] of pluginTools) {
      try { assertSupported(params) } catch (e) { bad.push(name + ': ' + (e && e.message ? e.message : e)) }
    }
    check('★★ 每个工具的 parameters 都能被 dsh-tools 的校验器接受（否则插件在加载期抛 ⇒ 宿主起不来）',
      bad.length === 0, bad.join(' ; '))
    // 反向自证：喂一个**已知非法**的 schema，校验器必须拒绝（证明这一关不是恒真）
    let rejected = false
    try { assertSupported({ type: 'object', properties: { x: { enum: ['a'] } } }) } catch { rejected = true }
    check('（反向自证）校验器确实会拒绝 `enum` 无 `type` 的 schema', rejected)
  }
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : `\nPASS: 两面工具**参数级**对称（E4 第二半 / r42）${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failures ? 1 : 0)
