// scripts/plugin-load-smoke.mjs — 插件**加载期**冒烟：证明每个插件都装得起来。
//
// 为什么必须有它（不是"锦上添花"）：
//   `check.mjs` 第 5 节记着一起真实事故——`defineTool` 会把每个工具的 `parameters`
//   送进 dsh-tools 的 schema 编译器，**未知关键字或缺少 type/oneOf 的节点会抛
//   `UNSUPPORTED_SCHEMA`，插件在加载期抛出就会把整个宿主带下水**：守候脚本反复重启
//   node、GUI 永远起不来。那次是 dsh-verify 的 `context` 参数与 dsh-ui-drive 的
//   `additionalItems`。
//
//   `check.mjs` 只能**静态**扫关键字（正则/白名单），它证明不了"这个插件真的能 import、
//   apply() 真的不抛、defineTool 真的编得过"。而真正会炸宿主的恰恰是运行期那一步。
//   于是需要这里：用**假的 ctx**（够用的 stub + 记录器）真的把插件装一遍。
//
//   它同时回答了另一个高频问题：「这个插件到底注册了哪些工具 / 路由 / 提示段？」
//   —— 两面工具集是否对称（E4）也能直接从这里看出来。
//
// 用法：
//   node scripts/plugin-load-smoke.mjs            # 默认对**运行时 profile** 冒烟（宿主真正加载的那份）
//   node scripts/plugin-load-smoke.mjs --json     # 机器读
//   node scripts/plugin-load-smoke.mjs --plugin dsh-hang-inspector
//   node scripts/plugin-load-smoke.mjs --root <dir>   # 指定 profile 目录
//
// 目标为什么默认是 profile 而不是仓库：
//   插件的 `import { defineTool } from '@deepseek-ai/dsh-tools'` 是**裸包名**，只能从
//   装了依赖的 profile 解析；在仓库里 import 必然失败（`Cannot find package`）。
//   而"宿主能不能装起这个插件"这件事，问的就是 profile 里那份 —— 所以默认它。
//
// 退出码：0 = 全部插件装起来了；非 0 = 有插件装不起来（**不要**在这种状态下重启宿主）。
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : '' }
const asJson = argv.includes('--json')
const only = argOf('plugin')

/** 目标根：显式 --root > DSH_PROFILE_DIR > $DSH_HOME/profiles/web > 仓库（只能做 import 冒烟）。 */
const candidates = [argOf('root'), process.env.DSH_PROFILE_DIR,
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web')].filter(Boolean)
const root = candidates.find((d) => existsSync(join(d, 'plugins'))) || REPO
const isRepo = root === REPO

/** 插件入口：根 index.js 优先，其次 lib/index.js（dsh-hang-inspector 用后者）。 */
function entryOf(dir) {
  for (const rel of ['index.js', 'lib/index.js']) {
    const p = join(dir, rel)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

/**
 * 假 ctx。除了显式 stub 的能力，其余成员用一个"记录型"兜底：
 * 既让插件能继续装下去，又**如实记下它要了什么**——那些正是真宿主才有的能力，
 * 也是"这个插件能不能在别的宿主里跑"的答案。
 */
function makeFakeCtx(record) {
  const disposers = []
  const stubReturning = (name) => {
    const fn = (...args) => { record.unknownCalls.push({ member: name, argCount: args.length }); return () => {} }
    return fn
  }
  const base = {
    effect: (fn, label) => {
      record.effects.push(label || '(unlabeled)')
      let d
      try { d = fn() } catch (e) { record.errors.push('effect ' + (label || '') + ': ' + e.message); return () => {} }
      return () => { try { if (typeof d === 'function') d() } catch { /* 拆解失败不影响结论 */ } }
    },
    tools: { register: (t) => { record.tools.push(t); return () => {} } },
    webServer: { register: (r) => { record.routes.push(r); return () => {} } },
    systemPrompt: { section: (s) => { record.sections.push(s); return () => {} } },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      // 记录一次：插件用到 target 上没有的能力
      record.unknownMembers.push(prop)
      return stubReturning(prop)
    },
    has: () => true,
  })
}

/** 工具参数 schema 的**运行期**校验：抛错即证明它会让宿主在加载期炸掉。
 *
 *  解析必须**锚在目标 profile 上**，不能用本脚本自己的位置：`@deepseek-ai/dsh-tools`
 *  是裸包名，只有 profile（或其父目录）的 node_modules 里才有；从仓库解析必然失败——
 *  而那会让校验被静默跳过，等于最关键的一关没跑（本脚本第一版就踩了这个坑）。 */
let assertSupported = null
let toolResolveError = ''
try {
  const { createRequire } = await import('node:module')
  const anchor = pathToFileURL(join(root, 'plugins', 'dsh-perf', 'index.js')).href
  const req = createRequire(anchor)
  const p = req.resolve('@deepseek-ai/dsh-tools')
  const mod = await import(pathToFileURL(p).href)
  assertSupported = mod.assertSupportedJsonSchema || null
} catch (e) {
  assertSupported = null
  toolResolveError = e && e.message ? String(e.message).split('\n')[0] : String(e)
}

const pluginsRoot = join(root, 'plugins')
const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(pluginsRoot, d.name))
  .filter((d) => !only || d.endsWith(only))
  .sort()

const results = []
let failed = 0

for (const dir of dirs) {
  const name = relative(pluginsRoot, dir)
  const entry = entryOf(dir)
  const result = {
    plugin: name, entry: entry ? relative(root, entry) : null,
    ok: false, errors: [], tools: [], toolCount: 0,
    routes: 0, sections: [], unknownMembers: [], schemaChecked: Boolean(assertSupported),
  }

  if (!entry) {
    result.errors.push('找不到插件入口（index.js / lib/index.js 都不存在）')
    results.push(result); failed++
    continue
  }

  const record = { tools: [], routes: [], sections: [], effects: [], errors: [], unknownMembers: [], unknownCalls: [] }
  try {
    const mod = await import(pathToFileURL(entry).href)
    if (typeof mod.apply !== 'function') result.errors.push('模块没有导出 apply(ctx)')
    else {
      const ctx = makeFakeCtx(record)
      mod.apply(ctx)
      // 注意：apply 里注册工具是通过 ctx.effect 包的，上面 effect 已同步执行
      result.tools = record.tools.map((t) => t && t.name).filter(Boolean).sort()
      result.toolCount = record.tools.length
      result.routes = record.routes.length
      result.sections = record.sections.map((s) => (s && s.name) || '(unnamed)')
      // 运行期 schema 校验：defineTool 内部已编过一次；这里再对每个工具的 parameters
      // 显式过一遍 dsh-tools 的校验器，把"哪个工具、哪个字段"点出来。
      if (assertSupported) {
        for (const t of record.tools) {
          try { assertSupported(t.parameters || {}) } catch (e) {
            result.errors.push('工具 ' + (t && t.name) + ' 的参数 schema 不被支持：' + (e && e.message ? e.message : e))
          }
        }
      }
      // 未命名工具 = 注册了但 agent 永远选不到
      const unnamed = record.tools.filter((t) => !t || !t.name).length
      if (unnamed > 0) result.errors.push('有 ' + unnamed + ' 个工具没写 name（agent 无法选择）')
      const noDesc = record.tools.filter((t) => t && t.name && (!t.description || String(t.description).trim() === '')).map((t) => t.name)
      if (noDesc.length) result.errors.push('这些工具没有 description（agent 无从判断何时用）：' + noDesc.join(', '))
    }
  } catch (e) {
    result.errors.push('import/apply 抛出：' + (e && e.message ? e.message : String(e)))
  }

  result.errors.push(...record.errors)
  result.unknownMembers = [...new Set(record.unknownMembers)].sort()
  result.ok = result.errors.length === 0
  if (!result.ok) failed++
  results.push(result)
}

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), target: root, isRepo, dshToolsResolved: Boolean(assertSupported), failed, plugins: results }, null, 2))
} else {
  console.log('插件加载冒烟（假 ctx 真装载；这一关不过就不该重启宿主）')
  console.log('目标：' + root + (isRepo ? '　⚠ 这是仓库源码，不是运行时 profile —— 裸包名 @deepseek-ai/dsh-tools 解析不到，必然全红' : ''))
  console.log('dsh-tools 可解析：' + (assertSupported ? '是（已做运行期 schema 校验）' : '否 —— schema 校验已跳过，结论不完整' + (toolResolveError ? '（' + toolResolveError + '）' : '')))
  console.log('')
  for (const r of results) {
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.plugin + '  ← ' + (r.entry || '(无入口)'))
    console.log('        工具 ' + r.toolCount + ' 个' + (r.toolCount ? '：' + r.tools.join(', ') : '') +
      '｜路由 ' + r.routes + ' 条｜提示段 ' + r.sections.length + ' 个')
    if (r.unknownMembers.length) console.log('        （还依赖宿主能力：' + r.unknownMembers.join(', ') + '）')
    for (const e of r.errors) console.log('        ✗ ' + e)
  }
  console.log('')
  console.log(failed ? 'LOAD SMOKE FAILED: ' + failed + ' 个插件装不起来' : 'LOAD SMOKE PASSED: ' + results.length + ' 个插件全部装载成功')
}

process.exit(failed ? 1 : 0)
