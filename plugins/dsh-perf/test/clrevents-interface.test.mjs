// 两面一致性：`perf_clrevents` 的 PID 参数是否**真的**从 DSH 面与 MCP 面都能送达处理器。
//
// 2026-09-23 修的两件事（都是 CI 连红那轮暴露的）：
//   ① **MCP 面段需要 `mcp/node_modules`**：本文件会真启 `mcp/server.mjs` 子进程，它 import
//      `@modelcontextprotocol/sdk`。CI 上依赖只在最后一步装 ⇒ 本步骤跑时子进程**启动即死**
//      （code=1 / ERR_MODULE_NOT_FOUND；本机把 `mcp/node_modules` 挪走可 1:1 复现）。
//      现在：没装依赖就**跳过 MCP 面段并计数**，DSH 面照测 —— 不假绿，也不把"环境没准备好"报成"代码错"。
//   ② **失败信息必须能读到**：runner 只保留失败输出的**尾部**，而原来的 `MCP timeout: <method>`
//      把 child stderr 一起吞了（CI 上那次失败步骤日志 12KB、无该字样）。现在：
//      rpc 预算 15s→60s（冷启动不是暖机），child 的 exit 事件**立刻**让在飞请求带证据失败，
//      并且失败信息压成**一行**在**最后**打印。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { spawn } from 'node:child_process'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clr-interface-'))
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = path.join(directory, 'trace.mjs')
const hook = path.join(directory, 'hook.mjs')
const bootstrap = path.join(directory, 'bootstrap.mjs')
fs.writeFileSync(fixture, 'export function makeTrace() { return { clrEvents: async received => ({ok:true,received}) } }', 'utf8')
fs.writeFileSync(hook, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') return {url:'data:text/javascript,export const defineTool = value => value',shortCircuit:true}
  if (specifier.endsWith('/trace.mjs') && ['/dsh-perf/index.js','/mcp/server.mjs'].some(suffix => (context.parentURL || '').endsWith(suffix))) return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true}
  return nextResolve(specifier, context)
}
`, 'utf8')
fs.writeFileSync(bootstrap, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)});`, 'utf8')
register(pathToFileURL(hook).href)

// MCP 面段的前置条件（能力探测，不是"这台机器应该装过什么"）。
const MCP_DEPS = path.join(repo, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')
const mcpDepsReady = fs.existsSync(MCP_DEPS)

// rpc 预算：`mcp/server.mjs` 冷启动要 import 一大片模块，CI runner 比暖机开发机慢得多。
// ⚠ 这不是"用超时掩盖失败"—— child 一退就立刻带 stderr 失败，只有"还活着但慢"才耗预算。
const RPC_BUDGET_MS = Number(process.env.DSH_TEST_RPC_TIMEOUT_MS || 60000)

const tools = new Map()
const plugin = await import('../index.js')
plugin.apply({
  effect: callback => callback(),
  tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
})

let client = null
let skips = 0
try {
  const tool = tools.get('perf_clrevents')
  assert.ok(tool, 'perf_clrevents 必须在插件里注册')

  // ---- DSH 面：不依赖 mcp/node_modules
  assert.equal(tool.parameters.pid.type, 'string')
  for (const pid of [undefined, '32412']) {
    const args = { etlPath: 'C:/fixture.etl', xmlPath: 'C:/fixture.xml', maxXmlMb: 64, timeoutMs: 10000, ...(pid ? { pid } : {}) }
    const dsh = await tool.execute(args)
    assert.deepEqual(JSON.parse(JSON.stringify(dsh.received)), args)
  }

  // ---- MCP 面：需要 mcp/node_modules（见文件头 ①）
  if (!mcpDepsReady) {
    skips++
    console.log('  skip MCP 面段 —— 未安装 mcp/node_modules（@modelcontextprotocol/sdk 缺）⇒ 未覆盖，不是通过')
  } else {
    client = spawn(process.execPath, ['--import', pathToFileURL(bootstrap).href, path.join(repo, 'mcp/server.mjs')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_NO_ENV_FALLBACK: '1', DSH_TOOL_TRACE: '0', DSH_OUTPUT_MAX_TOKENS: '0' },
    })
    const pending = new Map()
    let sequence = 0
    let output = ''
    let stderr = ''
    const failPending = (reason) => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer)
        pending.delete(id)
        p.reject(new Error(reason + '（请求 ' + p.method + ' 未完成）\n--- child stderr ---\n' + stderr.slice(-4000)))
      }
    }
    // 进程一死就立刻失败（带退出码与 stderr），而不是干等到预算耗尽 —— 这正是 CI 上那次
    // 「419ms 就失败」的原因：子进程启动即死，旧的 15s 写法只会说一句 timeout。
    client.on('exit', (code, signal) => failPending(`MCP 子进程退出 code=${code} signal=${signal}`))
    client.stderr.on('data', chunk => { stderr += chunk })
    client.stdout.on('data', chunk => {
      output += chunk
      for (;;) {
        const newline = output.indexOf('\n')
        if (newline < 0) break
        const line = output.slice(0, newline)
        output = output.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        const p = pending.get(message.id)
        if (p) {
          clearTimeout(p.timer)
          pending.delete(message.id)
          if (message.error) p.reject(new Error(JSON.stringify(message.error)))
          else p.resolve(message.result)
        }
      }
    })
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP 无响应 ${RPC_BUDGET_MS}ms：${method}\nchild exitCode=${client.exitCode}\n--- child stderr ---\n${stderr.slice(-4000)}`))
      }, RPC_BUDGET_MS)
      pending.set(id, { method, resolve, reject, timer })
      client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'clr-interface-test', version: '1' } })
    client.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listed = (await rpc('tools/list')).tools.find(t => t.name === 'perf_clrevents')
    assert.ok(listed, 'perf_clrevents 必须在 MCP 面暴露')
    assert.equal(listed.inputSchema.properties.pid.type, 'string')
    assert.match(listed.description, /machine-wide/)
    for (const pid of [undefined, '32412']) {
      const args = { etlPath: 'C:/fixture.etl', xmlPath: 'C:/fixture.xml', maxXmlMb: 64, timeoutMs: 10000, ...(pid ? { pid } : {}) }
      const mcp = await rpc('tools/call', { name: 'perf_clrevents', arguments: args })
      assert.notEqual(mcp.isError, true, JSON.stringify(mcp))
      assert.deepEqual(JSON.parse(mcp.content.find(block => block.type === 'text').text).received, args)
    }
  }

  console.log('PASS CLR interfaces: optional PID schema and actual DSH/MCP handler forwarding' +
    (skips ? `　⚠ 但 skipped ${skips} 段：MCP 面未覆盖，这不是通过` : ''))
} catch (e) {
  // runner 只留尾部 ⇒ 证据压成**一行**，且保证它是最后打印的东西（见文件头 ②）。
  console.error('CLR-INTERFACE TEST FAILED: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 1500))
  process.exitCode = 1
} finally {
  if (client) {
    client.kill()
    await new Promise(resolve => { if (client.exitCode !== null) resolve(); else client.once('exit', resolve) })
  }
  fs.rmSync(directory, { recursive: true, force: true })
}
