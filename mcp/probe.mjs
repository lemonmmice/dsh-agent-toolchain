// MCP tool probe: spawns server.mjs over stdio, calls any tool, prints the result.
// Purpose: drive the ui_* tools against a LIVE desktop client instead of only asserting on
// source text.
//
// Usage (set DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME to target your client):
//   node mcp/probe.mjs <tool> '<json-args>'                       single call
//   node mcp/probe.mjs --seq '[["tool",{...}],["tool",{...}]]'    several calls in one process
//
// Why --seq exists: some state lives INSIDE the server process (e.g. the read diff baseline).
// A fresh probe process only ever sees a first read, so a real diff can only be observed by
// issuing two reads against the same server.
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.mjs')

let calls
if (process.argv[2] === '--seq') {
  calls = JSON.parse(process.argv[3] || '[]')
} else {
  const tool = process.argv[2]
  if (!tool) { console.error('usage: node mcp/probe.mjs <tool> [json-args]  |  --seq \'[["tool",{}]]\''); process.exit(2) }
  calls = [[tool, process.argv[3] ? JSON.parse(process.argv[3]) : {}]]
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  // Target comes from the environment so this file stays free of machine-specific names.
  env: { ...process.env },
})

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
const note = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'

const chunks = []
const seen = new Set()
let done = false
const finish = (code) => {
  if (done) return
  done = true
  clearTimeout(timer)
  try { child.kill() } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* ignore */ }
  process.exit(code)
}
const timer = setTimeout(() => { console.error('TIMEOUT'); finish(1) }, 240000)

child.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

child.stdout.on('data', (d) => {
  chunks.push(d)
  const buf = Buffer.concat(chunks).toString('utf8')
  for (const line of buf.split('\n')) {
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (!msg.id || !msg.result || seen.has(msg.id)) continue
    // 只认我们发起的 call id（10, 11, 12, …）
    if (msg.id < 10) continue
    seen.add(msg.id)
    const idx = msg.id - 10
    const [tool, args] = calls[idx] || ['?', {}]
    console.log('=== [' + (idx + 1) + '/' + calls.length + '] ' + tool + ' ' + JSON.stringify(args) + ' ===')
    const raw = (msg.result.content && msg.result.content[0] && msg.result.content[0].text) || ''
    console.log('isError:', msg.result.isError === true)
    try {
      const o = JSON.parse(raw)
      // lines 很长：只打印前 3 条，其余字段全打（diff 正是我们要看的）
      if (o && Array.isArray(o.lines)) { o.lines = o.lines.slice(0, 3).concat(['…共 ' + o.count + ' 条']); o.linesTruncatedForDisplay = true }
      console.log(JSON.stringify(o, null, 1))
    } catch { console.log(raw) }
    console.log('')
    if (seen.size === calls.length) finish(0)
  }
})

child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.1' } }))
child.stdin.write(note('notifications/initialized'))
calls.forEach(([tool, args], i) => child.stdin.write(rpc(10 + i, 'tools/call', { name: tool, arguments: args })))
