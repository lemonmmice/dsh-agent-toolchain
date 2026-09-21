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
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  }
})
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method + '\n' + stderr)) }, 15000)
    pending.set(id, message => {
      clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
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
