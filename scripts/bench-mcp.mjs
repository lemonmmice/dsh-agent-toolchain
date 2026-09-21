import { performance } from 'node:perf_hooks'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { estimateTokens } from '../lib/output-budget.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-bench-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
Object.assign(env, {
  DSH_NO_ENV_FALLBACK: '1',
  DSH_MEMORY_DIR: join(scratch, 'memory'),
  DSH_FAILURE_CORPUS_DIR: join(scratch, 'failures'),
  DSH_API_CAPTURE_STORE: join(scratch, 'capture'),
  DSH_HANG_EVIDENCE_DIR: join(scratch, 'hang'),
  DSH_PERF_EVIDENCE_DIR: join(scratch, 'perf'),
  DSH_BUILD_LOGS_DIR: join(scratch, 'build'),
  DSH_VERIFY_DIR: join(scratch, 'verify'),
})
const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, isolated: true, startupMs: [], tools: {} }
const round = (value) => Math.round(value * 100) / 100
const stats = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return { samples: values.map(round), median: round(sorted[Math.floor(sorted.length / 2)]), max: round(sorted.at(-1)) }
}
let client
let fixture
try {
  for (let iteration = 0; iteration < 3; iteration++) {
    client = new Client({ name: 'dsh-benchmark', version: '1' })
    const started = performance.now()
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'mcp/server.mjs')], cwd: root, env, stderr: 'pipe' }))
    const listed = await client.listTools()
    report.startupMs.push(round(performance.now() - started))
    const serialized = JSON.stringify(listed)
    report.discovery = { tools: listed.tools.length, bytes: Buffer.byteLength(serialized), estimatedTokens: estimateTokens(serialized) }
    if (iteration < 2) await client.close()
  }
  for (const name of ['toolchain_status', 'failure_stats', 'memory_status', 'memory_recall', 'ui_status', 'hang_packs']) {
    const samples = []
    let result
    for (let iteration = 0; iteration < 5; iteration++) {
      const started = performance.now()
      result = await client.callTool({ name, arguments: name === 'memory_recall' ? { key: 'missing-benchmark-key' } : {} })
      samples.push(performance.now() - started)
    }
    report.tools[name] = { ms: stats(samples), bytes: Buffer.byteLength(JSON.stringify(result)), isError: result.isError === true }
  }
  fixture = createServer((request, response) => {
    const timer = setTimeout(() => response.end('{"fixture":true}'), 2300)
    response.on('close', () => clearTimeout(timer))
  })
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const notifications = []
  const started = performance.now()
  const result = await client.callTool({ name: 'http_request', arguments: { url: `http://127.0.0.1:${fixture.address().port}/`, timeoutMs: 5000 } }, undefined, {
    timeout: 10000,
    onprogress: (progress) => notifications.push({ atMs: round(performance.now() - started), progress: progress.progress, message: progress.message }),
  })
  report.feedback = { durationMs: round(performance.now() - started), notifications, isError: result.isError === true }
  const rejected = await client.callTool({ name: 'ui_drive', arguments: { action: 'click', name: 'benchmark-denied' } })
  report.deniedAction = { isError: rejected.isError === true, text: rejected.content?.[0]?.text }
  report.startup = stats(report.startupMs)
  const outputIndex = process.argv.indexOf('--output')
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    const destination = resolve(process.argv[outputIndex + 1])
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (client) await client.close()
  if (fixture) {
    fixture.closeAllConnections()
    await new Promise((done) => fixture.close(done))
  }
  rmSync(scratch, { recursive: true, force: true })
}
