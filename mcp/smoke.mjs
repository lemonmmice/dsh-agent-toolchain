// mcp/smoke.mjs — offline MCP server smoke test.
// Spawns server.mjs over stdio, runs initialize + tools/list, and asserts
// the expected tool set is present. No network, no side effects.
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })

const EXPECTED = ['build_run', 'ui_status', 'ui_drive', 'http_request', 'memory_index', 'memory_search', 'memory_save', 'memory_recall', 'memory_status', 'failure_record', 'failure_query', 'failure_stats', 'capture_query', 'capture_append', 'verify_report']

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
}, 30000)

child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } }))
child.stdin.write(rpc(2, 'tools/list'))

// Read until we have the tools/list response (id 2), then verify and exit.
const timer = setInterval(() => {
  const text = Buffer.concat(chunks).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.includes('"id":2')) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    clearInterval(timer)
    clearTimeout(timeout)
    const names = (msg.result?.tools ?? []).map((t) => t.name).sort()
    const missing = EXPECTED.filter((n) => !names.includes(n))
    if (missing.length > 0) {
      console.error('SMOKE FAIL: missing tools', missing)
      console.error('got:', names.join(', '))
      child.kill()
      process.exit(1)
    }
    console.log('SMOKE PASS: ' + names.length + ' tools registered (' + names.join(', ') + ')')
    child.kill()
    process.exit(0)
  }
}, 200)
