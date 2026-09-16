// mcp/smoke.mjs — offline MCP server smoke test.
// Spawns server.mjs over stdio, runs initialize + tools/list, and asserts the
// RUNTIME tool set equals the set of tools server.mjs statically declares.
// No network, no side effects.
//
// Why an exact match against the source instead of a hand-maintained list:
// this file previously carried a 15-name EXPECTED array checked with a SUBSET
// assertion, so it was structurally incapable of noticing a tool that went
// missing — the list and the server could drift apart indefinitely and the smoke
// test stayed green (an independent audit found 11 plugin tools unreachable over
// MCP while this test passed). Deriving the expectation from the source makes the
// comparison bidirectional and removes the second hand-written list that caused
// the drift: a declared-but-unregistered tool now fails, and so does a
// registered-but-undeclared one.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.mjs')
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })

/** Every tool name statically declared by `server.tool('...')` in server.mjs. */
const declared = [...readFileSync(serverPath, 'utf8').matchAll(/server\.tool\(\s*'([^']+)'/g)].map((m) => m[1])
const DECLARED = [...new Set(declared)].sort()

function rpc(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
}

const chunks = []
child.stdout.on('data', (d) => chunks.push(d))
child.stderr.on('data', (d) => process.stderr.write(d))
let closed = false
child.on('exit', () => { closed = true })

const timeout = setTimeout(() => {
  console.error('SMOKE FAIL: timeout waiting for server response')
  child.kill()
  process.exit(1)
}, Number(process.env.DSH_MCP_SMOKE_TIMEOUT_MS || 120000))

child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } }))
child.stdin.write(rpc(2, 'tools/list'))

// ---------------------------------------------------------------------------
// D.2（2026-09-14 夜）：**只读工具的 `execute` 体必须真的被执行过一次**。
//
// 为什么需要这一段：`tools/list` 只证明"工具**注册**了"，完全不碰 execute 体 ——
// 而 F-051（`build_compile_check` 在 MCP 面调用即抛 TypeError）就是这么藏了两天的：
// 声明、schema、渲染层全都对，只有真正跑一次才会炸。DSH 面早已有 execute 冒烟，
// MCP 面一直没有 —— 于是"注册 ≠ 能跑"这个缝只在 MCP 面留着。
//
// 判据（只读、无副作用 —— 这一段绝不启动/停止/删除任何东西）：
//   · **不许有 JSON-RPC error**：那是 execute 体抛异常（或没接上），就是 F-051 那一类；
//   · result 必须是对象、`content` 必须是非空数组、首条 text 必须非空（空壳结果同样是坏结果）；
//   · `isError:true`（工具**自己**报"这次没做成"）不算崩溃：按 expect 分级 ——
//     `ok` 的必须在任何情况下都能做（不依赖客户端在跑），`any` 的允许如实报失败。
// ---------------------------------------------------------------------------
const READONLY_CALLS = {
  // expect:'ok' —— 不依赖客户端进程/不依赖上一次运行，任何环境都该能给出结论
  toolchain_status: { tool: 'toolchain_status', args: {}, expect: 'ok' },
  // ⚠ `capture_status` 在 MCP 面是**代理回宿主**的（回环 HTTP 打 `…/capture/status`），
  //   所以它的成败取决于"宿主此刻忙不忙"，不取决于这个 execute 体本身。
  //   实测（2026-09-14 夜）：宿主正在跑 ETW 符号解析时，这条会以
  //   `The operation was aborted due to timeout` 失败 —— 而那是**环境**，不是 F-051 那类执行体缺陷。
  //   所以按 expect:'any' 归类（**并保留这条注释**，免得下一个人又把它改回 'ok' 再被坑一次）。
  capture_status: { tool: 'capture_status', args: {}, expect: 'any' },
  hang_status: { tool: 'hang_status', args: {}, expect: 'ok' },
  hang_packs: { tool: 'hang_packs', args: {}, expect: 'ok' },
  build_status: { tool: 'build_status', args: {}, expect: 'ok' },
  build_errors: { tool: 'build_errors', args: {}, expect: 'ok' },
  failure_stats: { tool: 'failure_stats', args: {}, expect: 'ok' },
  memory_status: { tool: 'memory_status', args: {}, expect: 'ok' },
  // F-051 的原案发现场：带 file 调一次，必须能返回对象。
  // ⚠ 「找不到工程」是它**结构化的如实拒绝**（原话还写着"这说明不了它没被编译"），
  //   不拿它当失败判据；真正的"能答上来"路径见下面的 src 那条（有源码根时才跑）。
  build_compile_check: { tool: 'build_compile_check', args: { file: 'lib/toolchain-status.mjs' }, expect: 'any' },
  // 默认 dry-run（只看不删）：这里绝不传 confirm
  perf_clean: { tool: 'perf_clean', args: {}, expect: 'ok' },
  // expect:'any' —— 依赖客户端在跑 / 依赖上一次运行留下的报告，允许如实报"没做成"
  ui_status: { tool: 'ui_status', args: {}, expect: 'any' },
  ui_windows: { tool: 'ui_windows', args: {}, expect: 'any' },
  ui_state: { tool: 'ui_state', args: {}, expect: 'any' },
  ui_live: { tool: 'ui_live', args: { action: 'status' }, expect: 'any' },
  perf_report: { tool: 'perf_report', args: {}, expect: 'any' },
  failure_query: { tool: 'failure_query', args: { limit: 1 }, expect: 'any' },
  capture_query: { tool: 'capture_query', args: { limit: 1 }, expect: 'any' },
}

// 有源码根时，**真的**跑一次 build_compile_check 的成功路径（F-051 就是在这一层炸的）。
// 没有源码根就明说跳过 —— 静默少跑一条比不做更糟（那会变成又一层"看着绿其实没测"）。
{
  const { existsSync, readdirSync, statSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  // ⚠ 用 env-fallback 读（进程环境 → HKCU\Environment）：源码根常常只配在**用户级环境变量**里，
  //   而本进程是宿主启动之后才拉起的，环境块里没有它 —— 直接读 `process.env` 会**误判成"没配"**，
  //   于是这段本该跑的冒烟静默跳过（正是本仓反复出现的那类"看着绿其实没测"）。
  const { envValue } = await import('../lib/env-fallback.mjs')
  const root = String(envValue('DSH_HANG_SRC_ROOT').value || envValue('DSH_PERF_SRC_ROOT').value || '')
  let cs = null
  const walk = (d, depth) => {
    if (cs || depth > 3) return
    let ents = []
    try { ents = readdirSync(d) } catch { return }
    for (const e of ents) {
      if (cs) return
      const p = j(d, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (!['bin', 'obj', '.git', 'node_modules'].includes(e)) walk(p, depth + 1) }
      else if (/\.cs$/i.test(e) && st.size > 0) cs = p
    }
  }
  if (root && existsSync(root)) walk(root, 0)
  if (cs) READONLY_CALLS['build_compile_check(src)'] = { tool: 'build_compile_check', args: { file: cs }, expect: 'ok' }
  else console.log('SMOKE NOTE: 未配置可用的源码根（DSH_HANG_SRC_ROOT / DSH_PERF_SRC_ROOT）—— 跳过 build_compile_check 的成功路径；' +
    '**这不等于它没问题**，配好源码根后这段才会真的跑起来。')
}

let listDone = false
const callIds = new Map()   // id(string) → name
const results = new Map()   // name → {msg, ms}
let nextId = 100
function fireCalls() {
  for (const [name, spec] of Object.entries(READONLY_CALLS)) {
    const id = String(nextId++)
    callIds.set(id, name)
    results.set(name, { msg: null, sentAt: Date.now() })
    child.stdin.write(rpc(Number(id), 'tools/call', { name: spec.tool, arguments: spec.args }))
  }
}
function finish() {
  clearInterval(timer)
  clearTimeout(timeout)
  const failures = []
  const errTools = []
  let okCount = 0
  for (const [name, spec] of Object.entries(READONLY_CALLS)) {
    const r = results.get(name) || {}
    const msg = r.msg
    if (!msg) { failures.push(name + ': 没有收到响应'); continue }
    if (msg.error) { failures.push(name + ': **JSON-RPC error**（execute 体抛异常/没接上）=' + JSON.stringify(msg.error).slice(0, 200)); continue }
    const res = msg.result
    if (!res || typeof res !== 'object') { failures.push(name + ': result 不是对象'); continue }
    const content = Array.isArray(res.content) ? res.content : null
    if (!content || content.length === 0) { failures.push(name + ': content 为空（空壳结果）'); continue }
    const text = String((content[0] && content[0].text) || '')
    if (!text.trim()) { failures.push(name + ': content[0].text 为空'); continue }
    if (res.isError === true) {
      errTools.push(name + ' → ' + text.slice(0, 90).replace(/\n/g, ' '))
      if (spec.expect === 'ok') failures.push(name + ': 本不该失败（expect=ok），却报了 isError：' + text.slice(0, 140))
    } else okCount++
  }
  if (failures.length) {
    console.error('SMOKE FAIL: 只读 tools/call 冒烟 ' + failures.length + ' 项不合格')
    for (const f of failures) console.error('  ✗ ' + f)
    child.kill()
    process.exit(1)
  }
  console.log('SMOKE PASS(execute): ' + Object.keys(READONLY_CALLS).length + ' 个只读工具真的跑过 execute —— ' +
    okCount + ' 个返回结论' + (errTools.length ? '，' + errTools.length + ' 个如实报失败（expect=any，不算崩溃）：\n  · ' + errTools.join('\n  · ') : ''))
  child.kill()
  process.exit(0)
}

// Read until we have the tools/list response (id 2), then verify and exit.
const timer = setInterval(() => {
  const text = Buffer.concat(chunks).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.includes('"id":')) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    // 第二段：只读 tools/call 的响应
    if (msg.id !== undefined && callIds.has(String(msg.id))) {
      const name = callIds.get(String(msg.id))
      const cur = results.get(name)
      if (cur && cur.msg === null) { cur.msg = msg; cur.ms = Date.now() - cur.sentAt }
    }
    if (msg.id === 2) {
      if (listDone) continue
      listDone = true
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort()
      const missing = DECLARED.filter((n) => !names.includes(n))
      const extra = names.filter((n) => !DECLARED.includes(n))
      if (missing.length > 0 || extra.length > 0) {
        if (missing.length) console.error('SMOKE FAIL: declared in server.mjs but NOT registered:', missing)
        if (extra.length) console.error('SMOKE FAIL: registered but not declared in server.mjs:', extra)
        console.error('got:', names.join(', '))
        child.kill()
        process.exit(1)
      }
      console.log('SMOKE PASS: ' + names.length + ' tools registered, matching server.mjs declarations')
      // 漏项哨兵：登记表里的工具必须真的存在（否则这段冒烟会静默少跑几个）
      const phantom = Object.entries(READONLY_CALLS).filter(([, s]) => !names.includes(s.tool)).map(([k]) => k)
      if (phantom.length) {
        console.error('SMOKE FAIL: 只读冒烟表里列了并不存在的工具：', phantom)
        child.kill()
        process.exit(1)
      }
      fireCalls()
      // 收尾由外层轮询负责：下一拍发现每条调用都应答了就 finish()
      continue
    }
  }
  if (listDone && [...results.values()].every((r) => r.msg !== null)) finish()
}, 200)
