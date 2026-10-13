// 工具 profile 集成测试：设 DSH_TOOL_PROFILE=ui 启动 server，tools/list 必须只含 ui + core，
// 不含 perf_/memory_/capture_/hang_/build_/failure_ 工具；默认（不设）全开由 mcp/smoke 覆盖。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { toolGroup } from '../lib/tool-profiles.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-tool-profile-'))
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_TOOL_PROFILE: 'ui',
    DSH_TEST: '1',
    DSH_FAILURE_CORPUS_DIR: join(tmp, 'fc'),
    DSH_VERIFY_DIR: join(tmp, 'vr'),
    DSH_PERF_EVIDENCE_DIR: join(tmp, 'ev'),
  },
})
const chunks = []
child.stdout.on('data', (d) => chunks.push(d))
child.stderr.on('data', () => {})

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'profile-test', version: '0.0.1' } }))
child.stdin.write(rpc(2, 'tools/list'))

const tools = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('timeout waiting for tools/list')) }, Number(process.env.DSH_MCP_SMOKE_TIMEOUT_MS || 60000))
  const onData = () => {
    const text = Buffer.concat(chunks).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) { clearTimeout(timer); resolve(msg.result.tools) }
    }
  }
  child.stdout.on('data', onData)
})
child.kill()

const names = tools.map((t) => t.name)
assert.ok(names.length > 0, 'tools/list 应返回工具')
const groups = new Set(names.map(toolGroup))
for (const g of groups) {
  assert.ok(g === 'ui' || g === 'core', `profile=ui 不应出现 ${g} 组工具：${names.filter((n) => toolGroup(n) === g).join(', ')}`)
}
assert.ok(names.includes('ui_launch'), '应含 ui_launch')
assert.ok(names.includes('toolchain_status'), '应含 core:toolchain_status')
assert.ok(names.includes('verify_report'), '应含 core:verify_report')
assert.ok(names.includes('toolchain_job'), '应含 core:toolchain_job')
assert.ok(!names.includes('perf_dump'), '不应含 perf_dump')
assert.ok(!names.includes('memory_save'), '不应含 memory_save')
assert.ok(!names.includes('build_run'), '不应含 build_run')
assert.ok(!names.includes('failure_stats'), '不应含 failure_stats')
console.log(`PASS: tool profile (DSH_TOOL_PROFILE=ui) → ${names.length} tools, groups=${[...groups].sort().join('+')}`)
