// 两面工具集**必须一致**（清单 E4，P0；对应 findings.md 的 F-003）。
//
// 为什么需要这个 gate（这才是本轮真正的修复）：
//   F-003 在**第一天就被"已确证"**（`findings.md`：DSH 面拿不到 MCP 面的工具集），
//   后来 `hang_*` 那条被补上了 —— 但**残余的两处不对称一直没人再查**：
//     · `perf_trace` / `perf_hotstacks` 只有 DSH 面有 ⇒ **MCP 连接的 agent 拿不到 ETW 调用链**，
//       也就是「间歇性卡顿/重绘风暴」唯一有效的通路对它关着（而"抓一个瞬间"的 perf_dump 反而开着，
//       恰好把 agent 推向"猜"）；
//     · `failure_*` 四个只有 MCP 面有 ⇒ **DSH 侧的 agent 看不了、也撤不了失败样本库**。
//       实测代价：上一轮我要撤回两条被工具诬告的记录时**没有工具可用**，只能临时写脚本调 lib。
//   **根因不是"忘了加"，而是"没有任何 gate 在查它"** —— E4 写在清单里，却从来没有对应的测试。
//   所以本文件的价值不在于"这次补上了"，而在于**下次再缺一个工具就会红**。
//
// 判据：两面名字集合相等（允许一个**显式登记**的别名映射，见 ALIASES）。
// 说清口径：比的是**工具名**，不是参数 schema —— 参数级的对称由各自的 smoke 保证。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  console.log((sawFail ? '  ok   ' : '  FAIL ') + '（自检）断言器有效')
  if (!sawFail) failures++
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * **显式**别名映射：同一个能力在两个面用了不同名字。
 * ⚠ 这是一条**有风险的**机制（@claude r35 构造了它的滥用方式，见下面的 ALIAS_COUNT_EXPECTED）：
 *   只要把任意 MCP-only 工具**映射到对面任一既有工具名**，`onlyMcp` 就空了 ⇒ gate 变绿。
 *   也就是说「别名」可以把真实的缺失**洗成"已对齐"**。
 *   本文件**没法**自动判断"两个名字是不是同一个能力"，所以采取的是**绊线**策略：
 *   别名条目数被钉死（见 ALIAS_COUNT_EXPECTED）—— 增删别名都必须显式改那一行，逼出一次人工判断。
 *   每条都必须写明理由，且**两个端点都必须在各自面上真实存在**。
 *
 * ★ r42：这份映射已**抽到 `lib/tool-aliases.mjs`**（本文件与 `toolface-params.test.mjs` 共用一份）——
 *   参数 gate 也需要同一张表，抄第二份的那天起两份就会开始漂移，而"两处实现漂移"正是本轮反复抓到的错法。
 *   （`ALIAS_COUNT_EXPECTED` 也一并在那边，语义不变。）
 */
const { ALIASES, ALIAS_COUNT_EXPECTED } = await import('./tool-aliases.mjs')

// 插件面（DSH）：扫 plugins 下每个插件的 index.js，取 `defineTool({ ... name: 'x' ... })`。
function pluginFaceNames() {
  const out = new Set()
  const root = join(REPO, 'plugins')
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    for (const rel of ['index.js', join('lib', 'index.js')]) {
      const f = join(root, d.name, rel)
      if (!existsSync(f)) continue
      const src = readFileSync(f, 'utf8')
      // 从每个 `defineTool(` 之后取**最近**的 `name: '...'`（顺序扫描）
      const re = /defineTool\(\s*\{|name:\s*'([^']+)'/g
      let pending = false
      let m
      while ((m = re.exec(src)) !== null) {
        if (m[0].startsWith('defineTool')) { pending = true; continue }
        if (pending && m[1]) { out.add(m[1]); pending = false }
      }
    }
  }
  return out
}

/** MCP 面：扫 mcp/server.mjs 里 `server.tool(\n  'x',`（**静态**，只作兜底与交叉核对）。 */
function mcpFaceNames() {
  const src = readFileSync(join(REPO, 'mcp', 'server.mjs'), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/server\.tool\(\s*'([^']+)'/g)) out.add(m[1])
  return out
}

/**
 * MCP 面的**运行时**工具集合：真的把 `mcp/server.mjs` 起起来，走 JSON-RPC 的 `initialize` + `tools/list`。
 *
 * 为什么必须这么做（@codex r35 的证伪，给了可复现反例）：
 *   静态正则**只认单引号字面量**。它构造了 `server.tool(nameVar, …)` 与 `defineTool({name: nameVar})`，
 *   实测「MCP 动态名 extracted=[]」「DSH 动态名 extracted=[null]」——
 *   **两面同时走变量/工厂注册时，两份扫描会同时漏掉同一个工具，集合仍然"相等" ⇒ gate 假绿**。
 *   `≥30` 只能防"整体扫成空"，防不了"少扫几个"。
 *   ⇒ 按它的建议：**以运行时真实注册集合为主断言，静态扫描只作覆盖辅助**。
 *   （插件面本来就有"真装载交叉核对"，MCP 面此前没有 —— 那正是那个洞。）
 */
async function mcpRuntimeNames() {
  const { spawn } = await import('node:child_process')
  let child
  try {
    child = spawn(process.execPath, [join(REPO, 'mcp', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch { return null }
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(d))
  const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  try {
    child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '0' } }))
    child.stdin.write(rpc(2, 'tools/list'))
  } catch { try { child.kill() } catch { /* ignore */ } ; return null }
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ } ; resolve(null) }, 30000)
    const iv = setInterval(() => {
      const text = Buffer.concat(chunks).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.includes('"id":2')) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        clearInterval(iv); clearTimeout(t)
        try { child.kill() } catch { /* ignore */ }
        resolve(new Set((msg.result?.tools ?? []).map((x) => x.name)))
        return
      }
    }, 150)
  })
}

const pluginNames = pluginFaceNames()

/**
 * 找出"**用变量/循环注册工具**"的插件源码文件。
 *
 * 存在的理由见下面 §3 里"拿不到运行时集合时"的那条断言：
 * 静态扫描器**只认字面量**，真装载又可能被跳过 —— 两者同时缺席就是**无人看守**。
 *
 * ⚠ 判据我**收紧过一次**（第一版太松、8 处假阳性）：原本还加了"注册点前 300 字符里出现
 *   for/forEach/map 就算循环注册"，结果任何一个 register 调用只要周围有循环就被点名 ——
 *   那是我自己在制造噪声。现在**只认一个信号**：`tools.register(` 之后的 `name:` **值不是引号字面量**。
 *   这个信号精确命中真正的危险写法（`for (const n of [...]) register(defineTool({name:n}))` ⇒ `name: n`），
 *   而对"字面量注册 + 周围恰好有循环"不误报。
 */
function findDynamicRegistration() {
  const out = []
  const root = join(REPO, 'plugins')
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    for (const rel of ['index.js', join('lib', 'index.js')]) {
      const f = join(root, d.name, rel)
      if (!existsSync(f)) continue
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/tools\.register\(/g)) {
        const seg = src.slice(m.index, m.index + 500)
        const nm = /name:\s*([^\s,}]+)/.exec(seg)
        if (nm === null) continue
        if (!/^['"]/.test(nm[1])) { out.push(rel + ' @' + m.index + ' → name:' + nm[1]); break }
      }
    }
  }
  return [...new Set(out)]
}

const mcpStatic = mcpFaceNames()
const mcpRuntime = await mcpRuntimeNames()
// ★ 主断言用**运行时**集合；拿不到才退回静态扫描（并明确标注）。
const mcpRaw = mcpRuntime !== null ? mcpRuntime : mcpStatic
const mcpNames = new Set([...mcpRaw].map((n) => (ALIASES[n] ? ALIASES[n] : n)))

// ---------------------------------------------------------------------------
// 0. ★ 抽取器自证：两个面都真的抽到了东西（否则下面的"相等"是空断言）
// ---------------------------------------------------------------------------
check('★ 抽取器有效：插件面抽到 ≥30 个工具名', pluginNames.size >= 30, 'plugin=' + pluginNames.size)
check('★ 抽取器有效：MCP 面抽到 ≥30 个工具名', mcpRaw.size >= 30, 'mcp=' + mcpRaw.size)
// ★★ @codex r35 证伪出来的洞：静态正则只认单引号字面量 ⇒
//    `server.tool(nameVar, …)` / `defineTool({name: nameVar})` 这类**动态注册**会被**两边同时漏掉**，
//    集合仍然"相等" ⇒ 假绿。所以 MCP 面**必须**以运行时 `tools/list` 为准。
check('★★ MCP 面用的是**运行时** `tools/list`（不是静态正则）—— 静态扫描会被动态注册绕过而假绿',
  mcpRuntime !== null, mcpRuntime === null ? '运行时集合取不到，已退回静态扫描（此时 gate 有假绿风险）' : '')
if (mcpRuntime !== null) {
  const onlyStatic = [...mcpStatic].filter((n) => !mcpRuntime.has(n)).sort()
  const onlyRuntime = [...mcpRuntime].filter((n) => !mcpStatic.has(n)).sort()
  check('★ 静态扫描与运行时集合一致（不一致本身就说明有人用变量/工厂注册了工具）',
    onlyStatic.length === 0 && onlyRuntime.length === 0,
    JSON.stringify({ 只在静态: onlyStatic, 只在运行时: onlyRuntime }))
}
check('别名映射只指向存在的插件面名字（防止写了错别名造成假相等）',
  Object.values(ALIASES).every((v) => pluginNames.has(v)),
  JSON.stringify(Object.values(ALIASES).filter((v) => !pluginNames.has(v))))

// ---------------------------------------------------------------------------
// 1. ★★ 集合相等
// ---------------------------------------------------------------------------
{
  const onlyMcp = [...mcpNames].filter((n) => !pluginNames.has(n)).sort()
  const onlyPlugin = [...pluginNames].filter((n) => !mcpNames.has(n)).sort()
  check('★★ MCP 有的，DSH 面也必须有（否则 DSH agent 拿不到这个能力）',
    onlyMcp.length === 0, '只在 MCP 面：' + onlyMcp.join(', '))
  check('★★ DSH 面有的，MCP 也必须能到（E4 原文：DSH 有的 MCP 也能到）',
    onlyPlugin.length === 0, '只在插件面：' + onlyPlugin.join(', '))
  console.log(`       （插件面 ${pluginNames.size} 个 / MCP 面 ${mcpRaw.size} 个 / 别名 ${Object.keys(ALIASES).length} 条）`)
}

// ---------------------------------------------------------------------------
// 2. 别名映射不许成为"掩盖缺失"的借口：每条别名两边都得有
// ---------------------------------------------------------------------------
{
  const bad = []
  for (const [mcp, plugin] of Object.entries(ALIASES)) {
    if (!mcpRaw.has(mcp)) bad.push(mcp + '（MCP 面无此名）')
    if (!pluginNames.has(plugin)) bad.push(plugin + '（插件面无此名）')
  }
  check('★ 每条别名在**两个面**都真实存在（否则别名是在掩盖一边的缺失）', bad.length === 0, bad.join(' , '))
check('★★ 别名条目数被钉死（= ' + ALIAS_COUNT_EXPECTED + '）—— 增删别名必须显式改这一行并写理由，'
  + '否则它能把**任意 MCP-only 工具洗成"已对齐"**（@claude r35 的构造）',
  Object.keys(ALIASES).length === ALIAS_COUNT_EXPECTED,
  '实际 ' + Object.keys(ALIASES).length + ' 条：' + Object.keys(ALIASES).join(', '))
}

// ---------------------------------------------------------------------------
// 3. 与真装载交叉核对：profile 存在时，实际 register 出来的名字必须与扫出来的一致
//    （正则抽取是手段，不是目的 —— 这一条防"扫描器写错了却一直绿"）
//
//    ⚠ 本节的**已知盲区**（我自己做回归实验时暴露的）：
//      上面对插件面用的是**正则**扫 `defineTool({ name: '…' })`，
//      它**看不见"用循环/数组批量注册"的工具名**（`for (const n of [...]) ctx.tools.register(defineTool({name:n}))`）。
//      本仓目前没有这种写法（真装载 41 = 扫描 41），所以现在没有假阴性；
//      但只要有人改成循环注册，扫描器就会漏 —— **这一节（真装载）就是用来兜住它的**：
//      真装载是**权威**，扫描器只是"在仓库里也能跑"的近似。
// ---------------------------------------------------------------------------
{
  // ★ 口径修正：显式设了 DSH_PROFILE_DIR 却无效时，**必须跳过**而不是"悄悄回退到真实 profile"。
  //   （我第一版就是无条件 `find(existsSync)`，于是显式指向一个不存在的目录时会**静默**用真实 profile，
  //     回归实验里因此得到了误导性的失败 —— 又一次"我以为它按我说的做了"。）
  const explicit = process.env.DSH_PROFILE_DIR
  const fallback = join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'profiles', 'web')
  const profile = explicit
    ? (existsSync(join(explicit, 'plugins')) ? explicit : '')
    : (existsSync(join(fallback, 'plugins')) ? fallback : '')
  if (!profile) {
    skip('真装载交叉核对', explicit
      ? 'DSH_PROFILE_DIR 已显式设为 ' + explicit + ' 但那里没有 plugins/（**不**回退到真实 profile）'
      : '未找到 profile（~/.dsh/profiles/web）')
    // ★★ @claude r35 的洞(b)：真装载**可以**被跳过，而跳过**仍然 PASS** ——
    //   于是"任何没有部署 profile 的环境（CI / 别人的机器 / 新 clone）"里，
    //   插件面若用**循环/变量**注册工具，就没有任何东西在看守它，gate 照绿。
    //   **gate 的可靠性不该依赖"这台机器恰好部署了 profile"。**
    //   对策：没有运行时兜底时，**自己去源码里找"动态注册"的痕迹**；找到就不许 PASS。
    const dyn = findDynamicRegistration()
    check('★★ 拿不到运行时集合时，插件面**源码里不许有动态注册**（否则无人看守，gate 会假绿）',
      dyn.length === 0,
      '这些文件用变量/循环注册工具，而本机没有 profile 可做运行时核对 ⇒ 无法保证查全：' + dyn.join(', '))
    if (dyn.length === 0) console.log('       （无 profile，但源码里只有字面量注册 ⇒ 静态扫描可信）')
  } else {
    const loaded = new Set()
    const loadedTools = []
    for (const d of readdirSync(join(profile, 'plugins'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      let entry = null
      for (const rel of ['index.js', join('lib', 'index.js')]) {
        const p = join(profile, 'plugins', d.name, rel)
        if (existsSync(p)) { entry = p; break }
      }
      if (!entry) continue
      const rec = { tools: [] }
      const base = {
        effect: (fn) => { try { fn() } catch { /* ignore */ } ; return () => {} },
        tools: { register: (t) => { rec.tools.push(t); return () => {} } },
        webServer: { register: () => () => {} },
        systemPrompt: { section: () => () => {} },
      }
      const ctx = new Proxy(base, { get: (t, p) => (p in t ? t[p] : (typeof p === 'string' ? () => () => {} : undefined)), has: () => true })
      try {
        const mod = await import('file:///' + entry.replace(/\\/g, '/'))
        if (typeof mod.apply === 'function') await mod.apply(ctx)
      } catch { continue }
      for (const t of rec.tools) {
        if (!t || !t.name) continue
        loaded.add(t.name)
        loadedTools.push({ name: t.name, description: String(t.description || '') })
      }
    }
    if (loaded.size === 0) {
      skip('真装载交叉核对', '装载到 0 个工具（profile 里插件可能未部署）')
    } else {
      const missing = [...loaded].filter((n) => !pluginNames.has(n)).sort()
      check('★ 真装载出来的工具名，正则扫描器一个都没漏（防"扫描器写废了"）',
        missing.length === 0, '扫描器漏了：' + missing.join(', '))
      // ★★ 反向也要查（@codex r35 建议的"以运行时集合为主断言"落到插件面）：
      //    扫描器**凭空多出来的名字**同样是洞 —— 那说明它匹配到了根本不是工具注册的东西，
      //    而"集合相等"会因为这份噪声而**掩盖真正的缺失**（一边多一个假名、一边少一个真名，仍可能相等）。
      const phantom = [...pluginNames].filter((n) => !loaded.has(n)).sort()
      check('★★ 反向：扫描器没有凭空多出名字（多出来的假名会掩盖真实缺失）',
        phantom.length === 0, '扫描器多出来的：' + phantom.join(', '))
      console.log(`       （真装载 ${loaded.size} 个；注意：这是**部署副本**，扫的是**仓库源码**，
        两者应一致 —— 不一致说明忘了 deploy）`)

      // -------------------------------------------------------------------
      // 3b. ★★ F-040：**描述里点名的工具必须真的存在**（描述里的工具名也是断言）
      //
      //   由来：G1 黑盒测试（一个全新会话的 agent，只读工具目录）报告说：
      //     「`verify_report` 正文写 `capture_append({runId})` 而工具实际叫 `api_capture_append`，
      //       **我会去找不存在的工具**。」
      //   核实：DSH 面的 `verify_report` 描述确实写着 `capture_append({runId})` ——
      //   那是 **MCP 面**的名字，DSH 面根本没这个工具。**描述把人指去空处**。
      //   这类错误手工很难查全（41 个工具、每个描述几百字），但**机器一秒就能查**：
      //   把描述里 `` `ident(` `` 形式的标识符抠出来，逐个要求在**本面**的工具名里存在。
      // -------------------------------------------------------------------
      const NON_PLUGIN_TOOLS = new Set([
        // 宿主提供、不在插件面注册的工具（描述里引用它们是合理的）
        'read_image', 'describe_image',
      ])
      const offside = []
      for (const t of loadedTools) {
        for (const m of t.description.matchAll(/`([a-z][a-z0-9_]{3,})\s*\(/g)) {
          const id = m[1]
          if (loaded.has(id) || NON_PLUGIN_TOOLS.has(id)) continue
          offside.push(t.name + ' → `' + id + '(`')
        }
      }
      check('★★ 描述里 `` `工具名(` `` 指到的工具，**在本面必须真的存在**（F-040：描述不许把人指去空处）',
        offside.length === 0, offside.join(' ; '))
      console.log(`       （检查了 ${loadedTools.length} 个工具的 description；`
        + `宿主工具白名单 ${[...NON_PLUGIN_TOOLS].length} 个）`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. dsh-verify 里那份**抄下来的**失败类别清单，必须与 lib 的导出一致
//    （参数 enum 必须在加载期就绪 ⇒ 只能抄；抄了就必须有人查）
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(REPO, 'plugins', 'dsh-verify', 'index.js'), 'utf8')
  const m = /const FAILURE_CLASS_LIST = \[([\s\S]*?)\]/.exec(src)
  check('找到 dsh-verify 里的 FAILURE_CLASS_LIST', m !== null, '')
  if (m) {
    const local = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    const lib = (await import('file:///' + join(REPO, 'lib', 'failure-corpus.mjs').replace(/\\/g, '/'))).FAILURE_CLASSES.slice().sort()
    check('★ 抄写的失败类别与 lib/failure-corpus.mjs 的 FAILURE_CLASSES **一致**（防漂移）',
      JSON.stringify(local) === JSON.stringify(lib),
      'local=' + JSON.stringify(local) + ' lib=' + JSON.stringify(lib))
  }
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : `\nPASS: 两面工具集一致（E4 / F-003）${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failures ? 1 : 0)
