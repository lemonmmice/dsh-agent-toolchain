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

const tools = new Map()
const plugin = await import('../index.js')
plugin.apply({
  effect: callback => callback(),
  tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
})
const client = spawn(process.execPath, ['--import', pathToFileURL(bootstrap).href, path.join(repo, 'mcp/server.mjs')], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_NO_ENV_FALLBACK: '1', DSH_TOOL_TRACE: '0', DSH_OUTPUT_MAX_TOKENS: '0' },
})
const pending = new Map()
let sequence = 0
let output = ''
let stderr = ''
// 预算从 15s 提到 60s：`mcp/server.mjs` 冷启动要 import 一大片模块，CI runner 比暖机开发机慢得多
// （2026-09-23 实测：CI 上正是撞在 15s 上 —— 15220ms 失败，而本机 989ms 绿）。
// ⚠ 这不是"用超时掩盖失败"：下面给 child 的 exit 挂了竞速 —— **进程一死就立刻带 stderr 失败**，
//   只有"还活着但慢"才会等到预算耗尽。原来那句 `MCP timeout: <method>` 把 child 的 stderr 一起吞了，
//   而 runner 只留输出尾部 ⇒ 失败原因在 CI 上根本读不到（2026-09-23 复核：失败步骤日志 12KB，无该字样）。
const RPC_BUDGET_MS = Number(process.env.DSH_TEST_RPC_TIMEOUT_MS || 60000)
const failPending = (reason) => {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    pending.delete(id)
    p.reject(new Error(reason + '（请求 ' + p.method + ' 未完成）\n--- child stderr ---\n' + stderr.slice(-4000)))
  }
}
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
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP 无响应 ${RPC_BUDGET_MS}ms：${method}\nchild exitCode=${client.exitCode}\n--- child stderr ---\n${stderr.slice(-4000)}`))
    }, RPC_BUDGET_MS)
    pending.set(id, { method, resolve, reject, timer })
    client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'clr-interface-test', version: '1' } })
  client.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const listed = (await rpc('tools/list')).tools.find(tool => tool.name === 'perf_clrevents')
  assert.equal(tools.get('perf_clrevents').parameters.pid.type, 'string')
  assert.equal(listed.inputSchema.properties.pid.type, 'string')
  assert.match(listed.description, /machine-wide/)
  for (const pid of [undefined, '32412']) {
    const args = { etlPath: 'C:/fixture.etl', xmlPath: 'C:/fixture.xml', maxXmlMb: 64, timeoutMs: 10000, ...(pid ? { pid } : {}) }
    const dsh = await tools.get('perf_clrevents').execute(args)
    assert.deepEqual(JSON.parse(JSON.stringify(dsh.received)), args)
    const mcp = await rpc('tools/call', { name: 'perf_clrevents', arguments: args })
    assert.notEqual(mcp.isError, true, JSON.stringify(mcp))
    assert.deepEqual(JSON.parse(mcp.content.find(block => block.type === 'text').text).received, args)
  }
  console.log('PASS CLR interfaces: optional PID schema and actual DSH/MCP handler forwarding')
} finally {
  client.kill()
  await new Promise(resolve => { if (client.exitCode !== null) resolve(); else client.once('exit', resolve) })
  fs.rmSync(directory, { recursive: true, force: true })
}
