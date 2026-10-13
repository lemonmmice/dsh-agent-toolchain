import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { REGISTRY } from '../lib/tool-registry.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-harness-mcp-'))
const client = new Client({ name: 'harness-audit', version: '1' })
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
const payload = result => JSON.parse(result.content.find(block => block.type === 'text').text)
try {
  writeFileSync(join(scratch, 'slow.mjs'), 'setTimeout(() => console.log("verified fixture"), 1200)')
  writeFileSync(join(scratch, 'ui.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }))
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, 'server.mjs')],
    env: { ...environment, DSH_TEST: '1', DSH_NO_ENV_FALLBACK: '1', DSH_UI_LOCK: join(scratch, 'ui.lock'), DSH_API_CAPTURE_STORE: join(scratch, 'capture'), DSH_BUILD_LOGS_DIR: join(scratch, 'build'), DSH_MEMORY_DIR: join(scratch, 'memory'), DSH_FAILURE_CORPUS_DIR: join(scratch, 'failure'), DSH_VERIFY_DIR: join(scratch, 'verify') },
    stderr: 'pipe',
  }))
  const tools = (await client.listTools()).tools
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(REGISTRY).sort())
  const gate = client.callTool({ name: 'verify_report', arguments: { runId: 'latency-fixture', task: 'controlled delay', claims: [{ kind: 'gate', statement: 'fixture command completes', cmd: 'node slow.mjs', cwd: scratch }] } })
  await new Promise(resolve => setTimeout(resolve, 150))
  const started = performance.now()
  const status = payload(await client.callTool({ name: 'build_status', arguments: { runId: 'missing-run' } }))
  const statusMs = performance.now() - started
  assert.equal(status.hasRun, false)
  assert.ok(statusMs < 500, `independent status blocked for ${statusMs}ms`)
  assert.equal(payload(await gate).verdict, 'pass')
  const manual = payload(await client.callTool({ name: 'verify_report', arguments: { runId: 'manual-fixture', task: 'self report', claims: [{ kind: 'manual', statement: 'reported complete', status: 'pass' }] } }))
  assert.notEqual(manual.verdict, 'pass')
  await client.callTool({ name: 'capture_append', arguments: { runId: 'import-fixture', records: [{ method: 'GET', url: 'https://example.test/import', status: 200, evidenceLevel: 'observed' }] } })
  const imported = payload(await client.callTool({ name: 'verify_report', arguments: { runId: 'import-fixture', task: 'imported evidence', claims: [{ kind: 'api', statement: 'observed API success', expect: { min: 1, all2xx: true } }] } }))
  assert.notEqual(imported.verdict, 'pass')
  const records = payload(await client.callTool({ name: 'capture_query', arguments: { runId: 'import-fixture' } }))
  assert.equal(records.items[0].evidenceLevel, 'imported')
  assert.ok(records.freshness.hostStatus)
  const invalid = await client.callTool({ name: 'capture_query', arguments: { limit: 1.5 } })
  assert.equal(invalid.isError, true)
  const forgotten = payload(await client.callTool({ name: 'memory_forget', arguments: { key: 'never-saved' } }))
  assert.equal(forgotten.deleted, 0)
  assert.equal(forgotten.forgotten, false)
  const busy = payload(await client.callTool({ name: 'ui_status', arguments: {} }))
  assert.equal(busy.errorCode, 'UI_LOCK_BUSY')
  assert.equal(busy.retryable, true)
  assert.equal(busy.writesApplied, false)
  console.log('PASS MCP audit: ' + tools.length + ' tools, gate concurrency status=' + statusMs.toFixed(2) + 'ms, provenance, manual, integer schema, forget count')
} finally {
  await client.close()
  rmSync(scratch, { recursive: true, force: true })
}
