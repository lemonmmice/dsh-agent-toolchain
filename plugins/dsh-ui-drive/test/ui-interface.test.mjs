import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'dsh-ui-interface-'))
const hookPath = join(directory, 'hook.mjs')
const fixturePath = join(directory, 'driver.mjs')
const bootstrapPath = join(directory, 'bootstrap.mjs')
writeFileSync(fixturePath, `
export function makeDriver() {
  let listFailure = false
  return {
    classifyAction: action => action === 'read' ? 'read' : 'effect',
    drive: async received => ({ok:true,action:received.action,received}),
    flow: async received => ({ok:true,received}),
    replay: async received => ({ok:true,received}),
    approvalStatus: () => listFailure ? {ok:false,code:'approval_store_unavailable'} : [],
    estopStatus: () => ({approvalFile:'fixture.json'}),
    grantApproval: approval => !approval.identity ? {ok:false,code:'approval_invalid'} :
      approval.identity.exe === 'store-error' ? {ok:false,code:'approval_store_unavailable'} : {ok:true,approval},
    revokeApproval: id => {
      if (id === 'list-failure') listFailure = true
      return {ok:false,code:id === 'store-error' ? 'approval_store_unavailable' : 'approval_not_found'}
    },
  }
}
`, 'utf8')
writeFileSync(hookPath, `
const fixture = ${JSON.stringify(pathToFileURL(fixturePath).href)}
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') return {url:'data:text/javascript,export const defineTool = value => value',shortCircuit:true}
  if (specifier.endsWith('/driver.mjs') && ['/dsh-ui-drive/index.js', '/mcp/server.mjs'].some(suffix => (context.parentURL || '').endsWith(suffix))) return {url:fixture,shortCircuit:true}
  return nextResolve(specifier, context)
}
`, 'utf8')
writeFileSync(bootstrapPath, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(hookPath).href)});`, 'utf8')
register(pathToFileURL(hookPath).href)

const tools = new Map()
const routes = []
const plugin = await import('../index.js')
plugin.apply({
  effect: callback => callback(),
  tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
  webServer: { register: route => { routes.push(route); return () => {} } },
  systemPrompt: { section: () => () => {} },
})

async function request(method, rest, body = '', headers = {}) {
  const req = new PassThrough()
  req.method = method
  req.url = '/api/dsh-ui-drive' + rest
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:9000', 'content-type': 'application/json', ...headers }
  let response
  const res = {
    writeHead: status => { response = { status } },
    end: data => { response.body = JSON.parse(data) },
  }
  const completed = routes[0].handler(req, res)
  req.end(body)
  await completed
  return response
}

const client = spawn(process.execPath, ['--import', pathToFileURL(bootstrapPath).href, join(repoRoot, 'mcp/server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, DSH_NO_ENV_FALLBACK: '1', DSH_UI_LOCK: '', DSH_TOOL_TRACE: '0', DSH_OUTPUT_MAX_TOKENS: '0' },
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
    const complete = pending.get(message.id)
    if (complete) { pending.delete(message.id); complete(message) }
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
const extended = { approvalId: 'test-approval', sessionId: 'test-session', visualFallback: true, visualMinConfidence: 0.93, visualTarget: '测试按钮' }
async function mcpCall(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return JSON.parse(result.content.find(part => part.type === 'text').text)
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ui-interface-test', version: '1' } })
  client.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const listed = new Map((await rpc('tools/list')).tools.map(tool => [tool.name, tool]))
  for (const name of ['ui_drive', 'ui_act']) {
    for (const key of Object.keys(extended)) {
      assert.ok(tools.get(name).parameters[key], 'DSH schema missing ' + name + '.' + key)
      assert.ok(listed.get(name).inputSchema.properties[key], 'MCP schema missing ' + name + '.' + key)
    }
    const args = { action: 'click', name: '测试按钮', allowSideEffects: true, ...extended }
    assert.deepEqual((await tools.get(name).execute(args)).received, args)
    assert.deepEqual((await mcpCall(name, args)).received, args)
  }
  const flowArgs = { steps: [{ action: 'click', name: '确认', ...extended, secret: true }], tag: 'test', failFast: true, allowSideEffects: true, ...extended, secret: true }
  for (const key of [...Object.keys(extended), 'secret']) {
    assert.ok(tools.get('ui_flow').parameters[key], 'DSH flow missing ' + key)
    assert.ok(listed.get('ui_flow').inputSchema.properties[key], 'MCP flow missing ' + key)
    assert.ok(listed.get('ui_flow').inputSchema.properties.steps.items.properties[key], 'MCP step missing ' + key)
  }
  assert.deepEqual((await tools.get('ui_flow').execute(flowArgs)).received, flowArgs)
  assert.deepEqual((await mcpCall('ui_flow', flowArgs)).received, flowArgs)
  const replayArgs = { replayPath: 'C:/evidence/replay.json', allowSideEffects: true, failFast: true, tag: 'test', approvalId: 'test-approval', sessionId: 'test-session' }
  assert.deepEqual((await tools.get('ui_replay').execute(replayArgs)).received, replayArgs)
  assert.deepEqual((await mcpCall('ui_replay', replayArgs)).received, replayArgs)
  assert.notEqual(listed.get('ui_replay').annotations?.readOnlyHint, true)
  assert.equal([...tools.keys(), ...listed.keys()].some(name => /approval.*grant|grant.*approval/.test(name)), false)

  const grant = { scope: 'session', sessionId: 'test-session', actions: ['click'], ttlMs: 1000, identity: { exe: 'C:/App/client.exe' } }
  assert.deepEqual(await request('POST', '/approvals/grant?exe=ignored', JSON.stringify(grant)), { status: 200, body: { ok: true, approval: grant } })
  assert.equal((await request('POST', '/approvals/grant', '{}')).status, 400)
  assert.equal((await request('POST', '/approvals/grant', '{broken')).status, 400)
  assert.equal((await request('POST', '/approvals/grant', '[]')).status, 400)
  assert.equal((await request('POST', '/approvals/grant', JSON.stringify(grant), { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await request('POST', '/approvals/grant', JSON.stringify({ padding: 'a'.repeat(16384) }))).status, 413)
  assert.equal((await request('POST', '/approvals/grant', JSON.stringify({ identity: { exe: 'store-error' } }))).status, 500)
  assert.equal((await request('DELETE', '/approvals/missing')).status, 404)
  assert.equal((await request('DELETE', '/approvals/store-error')).status, 500)
  assert.equal((await request('DELETE', '/approvals/%XX')).status, 400)
  assert.equal((await request('POST', '/approvals/grant', JSON.stringify(grant), { origin: 'https://untrusted.example' })).status, 403)
  assert.equal((await request('GET', '/approvals')).status, 200)
  await request('DELETE', '/approvals/list-failure')
  assert.equal((await request('GET', '/approvals')).status, 500)
  console.log('PASS UI interfaces: DSH/MCP parameter forwarding, replay registration, bounded approval routes and HTTP errors')
} finally {
  client.kill()
  await new Promise(resolve => { if (client.exitCode !== null) resolve(); else client.once('exit', resolve) })
  rmSync(directory, { recursive: true, force: true })
}
