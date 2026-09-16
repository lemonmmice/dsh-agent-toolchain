/**
 * MCP 面新增工具的**行为**验证 —— 不只是"注册上了"。
 *
 * 背景：`mcp/smoke.mjs` 现在能保证"注册的工具 == server.mjs 声明的工具"（精确比对），
 * 但那只证明 **tools/list 里有这个名字**，不证明**调用它会用到真实存在的接口**。
 * 本仓上一轮的教训正是"声明了但没接线"（ui_drive 丢 12 个参数、zod 剥掉 12 个字段），
 * 所以这里对每个新增工具做**直接调用**，断言返回的是结构化结果而不是异常/未定义。
 *
 * 覆盖面说明（诚实标注）：
 *   · ui_status / build_status / build_errors / memory_status —— 直接调用并断言返回对象，
 *     离线可跑（不依赖客户端/构建产物）。
 *   · ui_launch / ui_tree / ui_live / perf_* —— 需要真客户端或 procdump，**离线不可调用**；
 *     这里改为断言"模块确实导出了对应方法"（导入真模块检查 typeof），
 *     证明 registration 调用的接口存在，而不是走一个拼错的方法名。
 */
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { makeLive } from '../plugins/dsh-ui-drive/lib/live.mjs'
import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { makePerf } from '../plugins/dsh-perf/lib/perf.mjs'
import { DshMemory } from '../plugins/dsh-memory/lib/memory.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ------------------------------------------------- 1. 注册时调用的接口必须真实存在
// server.mjs 新增的注册分别调用 drv().launch/tree、liveCtl().{start,stop,status,frame,wait}、
// bld().{status,errorsOfLast}、mem().forget、prf().{dump,analyzeDump,heapStats}。
// 这里用与 server.mjs 相同的构造方式建实例，逐个断言这些方法存在。
{
  const drv = makeDriver({
    scriptsDir: join(repoRoot, 'plugins', 'dsh-ui-drive', 'scripts'),
    procName: 'x', windowName: 'x', clientExe: '', evidenceDir: '',
  })
  for (const m of ['launch', 'tree', 'drive', 'status']) {
    check(`driver.${m} 存在（ui_launch/ui_tree 依赖）`, typeof drv[m] === 'function')
  }

  const live = makeLive({ driver: drv })
  for (const m of ['start', 'stop', 'frame', 'wait', 'status']) {
    check(`live.${m} 存在（ui_live 依赖）`, typeof live[m] === 'function')
  }
  // status 必须能离线调用（纯内存快照，不碰客户端）
  const st = live.status()
  check('live.status() 离线可调用且返回对象', st !== null && typeof st === 'object', JSON.stringify(st).slice(0, 200))

  const b = makeBuilder({ clientRoot: '', repoRoot: '', msbuild: '', engine: 'msbuild', logsDir: '' })
  for (const m of ['status', 'errorsOfLast']) {
    check(`builder.${m} 存在（build_status/build_errors 依赖）`, typeof b[m] === 'function')
  }
  const bs = b.status()
  check('builder.status() 离线可调用且返回对象', bs !== null && typeof bs === 'object', JSON.stringify(bs).slice(0, 200))

  const p = makePerf({ scriptsDir: join(repoRoot, 'plugins', 'dsh-perf', 'scripts'), procName: 'x', windowName: 'x', evidenceDir: '' })
  for (const m of ['dump', 'analyzeDump', 'heapStats']) {
    check(`perf.${m} 存在（perf_dump/perf_analyze/perf_heap 依赖）`, typeof p[m] === 'function')
  }

  const mem = new DshMemory({})
  check('memory.forget 存在（memory_forget 依赖）', typeof mem.forget === 'function')
}

// ------------------------------------------------- 2. 无参只读工具必须真的返回结构化结果
// ⚠️ 不能断言 hasRun === false：日志目录是**全局共享**的，这台机器上已经有历史构建记录，
// 于是 hasRun 为 true 且带 logPath 才是正确行为（第一版测试就是错在这里 —— 那是断言写错，
// 不是被测代码有问题）。改为断言**结构与语义**：必须有 hasRun 布尔；为 true 时必须带 logPath。
{
  const b = makeBuilder({ clientRoot: '', repoRoot: '', msbuild: '', engine: 'msbuild', logsDir: '' })

  const s = await b.status()
  check('build_status 返回对象且带 hasRun 布尔', s !== null && typeof s === 'object' && typeof s.hasRun === 'boolean',
    JSON.stringify(s).slice(0, 160))
  // BV-04/BV-05（2026-09-11）：`logPath` 现在是**三态**的，断言必须跟着契约走。
  // 早返回（压根没跑，`didNotRun:true`）的 last.json 里 logPath **就是 null** —— 那次没有日志。
  // 旧断言无条件要求字符串，于是"最近一次是被挡下的构建"时会红 —— 那是断言过时，不是代码错。
  check('build_status：hasRun=true 时带 logPath（可追溯）；didNotRun 的记录允许 logPath=null',
    s.hasRun !== true || typeof s.logPath === 'string' || s.didNotRun === true,
    JSON.stringify(s).slice(0, 220))

  const e = await b.errorsOfLast()
  check('build_errors 返回对象且带 hasRun 布尔', e !== null && typeof e === 'object' && typeof e.hasRun === 'boolean',
    JSON.stringify(e).slice(0, 160))
  check('build_errors：hasRun=true 时 errors/warnings 都是数组',
    e.hasRun !== true || (Array.isArray(e.errors) && Array.isArray(e.warnings)),
    'errors=' + typeof e.errors + ' warnings=' + typeof e.warnings)
  check('build_errors：hasRun=false 时必须自带说明（不是空对象糊弄）',
    e.hasRun !== false || typeof e.logPath === 'string' || e.error !== undefined,
    JSON.stringify(e).slice(0, 160))
}

// ------------------------------------------------- 3. ui_live 的 action 分派必须是穷尽的
// server.mjs 里手写了 if 链；action 取值现在来自**注册表**（W1：ui_live 的 shape 走 mcpShape('ui_live')，
// 不再是内联 z.enum）。两者若不同步会出现"schema 允许但没人处理"。
// ⚠ 修（F-W1）：旧实现 ① 从内联 z.enum 抓取值，W1 后 ui_live 已无内联 enum；② 把分派块切到 'perf_probe'，
// 中间夹了 ui_act（它**有**内联 12 项 enum），于是抓错了工具的 enum（5→12）。现在：enum 从注册表读，
// 分派块只切 ui_live **自己**那段（到它之后的下一个 server.tool(）。
{
  const { readFileSync } = await import('node:fs')
  const { REGISTRY } = await import('./tool-registry.mjs')
  const src = readFileSync(join(repoRoot, 'mcp', 'server.mjs'), 'utf8')
  const liveStart = src.indexOf("'ui_live'")
  const nextTool = src.indexOf('server.tool(', liveStart + 1)
  const block = src.slice(liveStart, nextTool > 0 ? nextTool : undefined)
  const actionParam = (REGISTRY.ui_live.params || []).find((p) => p.name === 'action')
  const actions = actionParam && Array.isArray(actionParam.enum) ? actionParam.enum : []
  check('注册表给出 ui_live 的 action enum（5 个）', actions.length === 5, JSON.stringify(actions))
  for (const a of actions) {
    check(`ui_live 分派处理了 action=${a}`, new RegExp("action === '" + a + "'").test(block), '缺分支=' + a)
  }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: mcp new-tool surface behaves (not just registered)')
