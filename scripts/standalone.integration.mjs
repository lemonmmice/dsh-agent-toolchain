import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { parse } from 'smol-toml'
import { updateJson, updateToml, planClientConfigs, writeWithBackup, applyConfigPlans } from './lib/client-config.mjs'
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const directory = mkdtempSync(join(tmpdir(), 'dsh-install-中文 space-'))
const root = process.env.DSH_INTEGRATION_ROOT || fileURLToPath(new URL('../', import.meta.url))
const entry = { command: process.execPath, args: [join(root, 'mcp', 'standalone.mjs')], env: { DSH_ENV_FILE: join(directory, 'env.json') } }
const originalJson = JSON.stringify({ preferences: { keep: true }, mcpServers: { other: { command: 'untouched' }, 'dsh-agent-toolchain': { command: 'old', env: { CUSTOM_SETTING: 'keep' } } } })
const changedJson = updateJson(originalJson, entry, 'claude-desktop')
assert.equal(JSON.parse(changedJson).preferences.keep, true)
assert.equal(JSON.parse(changedJson).mcpServers.other.command, 'untouched')
assert.equal(JSON.parse(changedJson).mcpServers['dsh-agent-toolchain'].env.CUSTOM_SETTING, 'keep')
assert.equal(updateJson(changedJson, entry, 'claude-desktop'), changedJson)
assert.throws(() => updateJson('{broken', entry, 'claude-code'))
const originalToml = '# keep comment\nmodel = "existing"\nnotes = """\n[mcp_servers.dsh-agent-toolchain]\nnot a table\n"""\n[mcp_servers.other]\ncommand = "keep"\n[mcp_servers."dsh-agent-toolchain"]\ncommand = "old"\ntool_timeout_sec = 420\n[mcp_servers."dsh-agent-toolchain".env]\nCUSTOM_SETTING = "keep"\n[projects."C:/example"]\ntrust_level = "trusted"\n'
const changedToml = updateToml(originalToml, entry)
assert.equal(parse(changedToml).mcp_servers['dsh-agent-toolchain'].tool_timeout_sec, 420)
assert.equal(parse(changedToml).mcp_servers['dsh-agent-toolchain'].env.CUSTOM_SETTING, 'keep')
assert.equal(parse(changedToml).projects['C:/example'].trust_level, 'trusted')
assert.ok(changedToml.startsWith('# keep comment\n'))
assert.equal(parse(changedToml).notes, parse(originalToml).notes)
assert.equal(updateToml(changedToml, entry), changedToml)
assert.throws(() => updateToml('[mcp_servers]\ndsh-agent-toolchain = { command = "old" }', entry), /inline TOML/)
assert.throws(() => updateToml('broken = [', entry))
const configPath = join(directory, 'backup.json')
writeFileSync(configPath, originalJson)
const write = writeWithBackup(configPath, changedJson, originalJson)
assert.equal(readFileSync(write.backup, 'utf8'), originalJson)
assert.throws(() => writeWithBackup(configPath, 'other', originalJson), /changed during installation/)
assert.equal(planClientConfigs({ home: directory, appData: directory, clients: ['codex', 'claude-code', 'claude-desktop'], entry }).length, 3)
const blockedParent = join(directory, 'file-not-directory')
writeFileSync(blockedParent, 'keep')
assert.throws(() => applyConfigPlans([
  { path: configPath, before: changedJson, after: 'temporary change' },
  { path: join(blockedParent, 'child'), before: '', after: '{}' },
]))
assert.equal(readFileSync(configPath, 'utf8'), changedJson)
console.log('PASS: configuration preservation, multiline TOML, idempotency, backups, invalid input')

const portProbe = createServer()
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
const port = portProbe.address().port
await new Promise(resolve => portProbe.close(resolve))
const envFile = join(directory, 'env.json')
const settings = {
  DSH_STANDALONE: '1', DSH_NO_ENV_FALLBACK: '1', DSH_CAPTURE_BACKEND: 'standalone',
  DSH_CAPTURE_SERVICE_PORT: String(port), DSH_CAPTURE_SERVICE_DIR: join(directory, 'service'),
  DSH_API_CAPTURE_STORE: join(directory, 'capture'), DSH_UI_PROC_NAME: '', DSH_UI_CLIENT_EXE: '',
  DSH_MEMORY_DIR: join(directory, 'memory'), DSH_FAILURE_CORPUS_DIR: join(directory, 'failures'),
  DSH_PERF_EVIDENCE_DIR: join(directory, 'perf'), DSH_HANG_EVIDENCE_DIR: join(directory, 'hang'),
}
writeFileSync(envFile, JSON.stringify(settings))
const clients = []
const transports = []
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  const value = JSON.parse(result.content.find(block => block.type === 'text').text)
  assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(value))
  assert.notEqual(value.ok, false, name + ': ' + JSON.stringify(value))
  return value
}
try {
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: 'standalone-install-integration-' + index, version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(root, 'mcp', 'standalone.mjs')],
      env: { ...process.env, DSH_ENV_FILE: envFile, DSH_UI_PROC_NAME: 'MustNotLeakFromHost' }, stderr: 'inherit',
    })
    clients.push(client)
    transports.push(transport)
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    assert.ok(tools.some(tool => tool.name === 'capture_start'))
  }
  const statuses = await Promise.all(clients.map(client => call(client, 'capture_status')))
  assert.ok(statuses.every(status => status.backend === 'standalone'))
  const token = readFileSync(join(directory, 'service', 'token'), 'utf8')
  const health = await (await fetch('http://127.0.0.1:' + port + '/health', { headers: { authorization: 'Bearer ' + token } })).json()
  assert.equal(health.ready, true)
  assert.equal((await fetch('http://127.0.0.1:' + port + '/health')).status, 403)
  const started = await call(clients[0], 'capture_start', { logPath: join(directory, 'absent.log') })
  assert.equal(started.logExists, false)
  assert.ok(started.warnings.length > 0)
  assert.equal((await call(clients[1], 'capture_status')).running, true)
  const shutdownActive = await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token } })
  assert.equal(shutdownActive.status, 409)
  await call(clients[1], 'capture_stop')
  await call(clients[0], 'capture_append', { records: [{ method: 'GET', url: 'https://example.invalid/install-check', ts: Date.now(), status: 200 }] })
  const captured = await call(clients[1], 'capture_query', { q: 'install-check' })
  assert.ok(JSON.stringify(captured).includes('https://example.invalid/install-check'))
  await call(clients[0], 'capture_rules', { action: 'list' })
  await call(clients[1], 'capture_netsim', { action: 'get' })
  const mockUrl = 'http://example.invalid/standalone-mock'
  await call(clients[0], 'capture_rules', { action: 'mock', url: mockUrl, method: 'GET', preset: 'empty-array' })
  const proxyPortProbe = createServer()
  await new Promise(resolve => proxyPortProbe.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxyPortProbe.address().port
  await new Promise(resolve => proxyPortProbe.close(resolve))
  const route = async (path, body) => {
    const response = await fetch('http://127.0.0.1:' + port + '/api/dsh-api-visualizer' + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    assert.ok(response.ok, await response.text())
  }
  await route('/proxy/start', { port: proxyPort, upstream: '' })
  try {
    const mocked = await new Promise((resolve, reject) => {
      const outgoing = request({ hostname: '127.0.0.1', port: proxyPort, method: 'GET', path: mockUrl, headers: { host: 'example.invalid' } }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      })
      outgoing.on('error', reject)
      outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Proxy fixture timed out')))
      outgoing.end()
    })
    assert.equal(mocked.status, 200)
    assert.deepEqual(JSON.parse(mocked.body), [])
  } finally {
    await route('/proxy/stop', {})
  }
  const status = await call(clients[0], 'toolchain_status')
  assert.equal(status.items.find(item => item.key === 'pluginDeploy').value, 'standalone')
  assert.ok(!JSON.stringify(status).includes('MustNotLeakFromHost'))
  console.log('PASS: two MCP clients share one capture engine, real HTTP proxy mock, storage/rules/netsim, auth, active-capture shutdown refusal, environment isolation')
} finally {
  for (const client of clients) await client.close()
  for (const transport of transports) await transport.close()
  Object.assign(process.env, settings)
  const { stopStandalone } = await import('../lib/capture-host.mjs')
  await stopStandalone()
}

const installHome = join(directory, 'install-home')
mkdirSync(join(installHome, '.codex'), { recursive: true })
mkdirSync(join(installHome, '.dsh-agent-toolchain'), { recursive: true })
writeFileSync(join(installHome, '.dsh-agent-toolchain', 'env.json'), JSON.stringify({ DSH_CAPTURE_SERVICE_PORT: String(port) }))
writeFileSync(join(installHome, '.codex', 'config.toml'), '# retained\nmodel = "keep-model"\n')
async function runInstall() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(root, 'scripts', 'install-client.mjs'), '--in-place', '--non-interactive', '--clients', 'all',
      '--home', installHome, '--app-data', join(installHome, 'AppData'), '--codex-home', join(installHome, '.codex'),
      '--claude-config-dir', join(installHome, '.claude'),
    ], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, DSH_CAPTURE_SERVICE_PORT: String(port) } })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installer exit ' + code)))
  })
}
await runInstall()
await runInstall()
assert.equal(parse(readFileSync(join(installHome, '.codex', 'config.toml'), 'utf8')).model, 'keep-model')
assert.ok(JSON.parse(readFileSync(join(installHome, 'AppData', 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers['dsh-agent-toolchain'])
assert.ok(readdirSync(join(installHome, '.agents', 'skills')).includes('dsh-perf-triage'))
console.log('PASS: real installer twice, all three client configurations, bundled workflow skills')
console.log('Evidence: ' + directory)
