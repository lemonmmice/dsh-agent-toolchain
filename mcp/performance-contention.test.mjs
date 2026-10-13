import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const directory = mkdtempSync(join(tmpdir(), 'dsh-round2-mcp-'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
const client = new Client({ name: 'performance-contention', version: '1' })
const payload = result => {
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}
const result = { platform: process.platform, node: process.version, measuredAt: new Date().toISOString(), samples: {} }
try {
  const logPath = join(directory, 'build.log')
  writeFileSync(logPath, ('ordinary ' + 'x'.repeat(180) + '\n').repeat(355000) + 'A.cs(1,2): error CS1002: expected\n')
  writeFileSync(join(directory, 'last.json'), JSON.stringify({ ok: false, logPath }))
  const failures = join(directory, 'failures')
  mkdirSync(failures)
  const corpusFile = join(failures, 'records.jsonl')
  const timestamp = new Date().toISOString()
  writeFileSync(corpusFile, Array.from({ length: 50000 }, (_, index) => JSON.stringify({ id: 'fixture-' + index, ts: timestamp, failureClass: 'flaky', task: 'fixture', description: 'failure ' + index })).join('\n') + '\n')
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'server.mjs')], stderr: 'pipe', env: { ...environment, DSH_TEST: '1', DSH_NO_ENV_FALLBACK: '1', DSH_BUILD_LOGS_DIR: directory, DSH_FAILURE_CORPUS_DIR: failures, DSH_MEMORY_DIR: join(directory, 'memory'), DSH_VERIFY_DIR: join(directory, 'verify'), DSH_API_CAPTURE_STORE: join(directory, 'capture') } }))
  payload(await client.callTool({ name: 'build_status', arguments: { runId: 'missing' } }))
  for (const concurrency of [1, 4, 8]) {
    const samples = []
    let statusesDuringWork = 0
    for (let iteration = 0; iteration < 3; iteration++) {
      appendFileSync(logPath, `B.cs(${concurrency * 10 + iteration},1): warning CS0168: unused\n`)
      appendFileSync(corpusFile, JSON.stringify({ id: `added-${concurrency}-${iteration}`, ts: timestamp, failureClass: 'flaky', task: 'fixture', description: 'additional' }) + '\n')
      let completed = false
      const heavy = Promise.all([
        client.callTool({ name: 'build_errors', arguments: {} }).then(payload),
        client.callTool({ name: 'failure_stats', arguments: {} }).then(payload),
      ]).then(values => { completed = true; return values })
      await new Promise(resolve => setTimeout(resolve, 20))
      for (let batch = 0; batch < 8; batch++) {
        await Promise.all(Array.from({ length: concurrency }, async () => {
          const started = performance.now()
          const status = payload(await client.callTool({ name: 'build_status', arguments: { runId: 'missing' } }))
          assert.equal(status.hasRun, false)
          samples.push(+(performance.now() - started).toFixed(2))
          if (!completed) statusesDuringWork++
        }))
      }
      const [diagnostics, stats] = await heavy
      assert.equal(diagnostics.errors.length, 1)
      assert.equal(diagnostics.incomplete, false)
      assert.equal(stats.incomplete, false)
      assert.ok(stats.totalAllShards > 50000)
      result.lastReadMetrics = stats.readMetrics
    }
    assert.ok(statusesDuringWork > 0, 'status must complete before heavy work completes')
    const sorted = [...samples].sort((left, right) => left - right)
    const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
    result.samples[concurrency] = { count: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), statusesDuringWork, values: samples }
  }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await client.close(); rmSync(directory, { recursive: true, force: true }) }
