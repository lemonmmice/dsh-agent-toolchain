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
    const missing = DECLARED.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !DECLARED.includes(n))
    if (missing.length > 0 || extra.length > 0) {
      if (missing.length) console.error('SMOKE FAIL: declared in server.mjs but NOT registered:', missing)
      if (extra.length) console.error('SMOKE FAIL: registered but not declared in server.mjs:', extra)
      console.error('got:', names.join(', '))
      child.kill()
      process.exit(1)
    }
    console.log('SMOKE PASS: ' + names.length + ' tools registered, matching server.mjs declarations (' + names.join(', ') + ')')
    child.kill()
    process.exit(0)
  }
}, 200)
