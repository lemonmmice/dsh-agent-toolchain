// Import the actual host module; only the host framework's definition wrapper
// is stubbed. No proxy, capture engine or application process is started.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const toolStub = 'data:text/javascript,' + encodeURIComponent('export const defineTool = value => value')
const loader = `export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') return { url: ${JSON.stringify(toolStub)}, shortCircuit: true }
  return next(specifier, context)
}`
register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url)
const directory = mkdtempSync(join(tmpdir(), 'capture-host-native-'))
process.env.DSH_API_CAPTURE_STORE = directory
process.env.DSH_API_CAPTURE_MAX_BYTES = '8000'
process.env.DSH_NO_ENV_FALLBACK = '1'
try {
  const shared = await import('../../../lib/capture-store.mjs')
  const host = await import('../lib/index.js')
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: 'r' + i, ts: Date.now() + i,
    method: 'get', url: 'https://example.invalid/' + i, resBody: '中文😀'.repeat(60),
    ...(i === 24 ? { runId: 'explicit-run' } : {}),
  }))
  const appended = host.appendRecords(rows, { runId: 'host-run' })
  assert.equal(appended.ingested, 25)
  assert.ok(appended.total < 25)
  assert.deepEqual(shared.readAll(), host.readAll())
  assert.ok(shared.readAll().reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)) + 1, 0) <= 8000 * 0.9)
  assert.ok(shared.readAll().some(r => r.id === 'r24'), 'host trimming keeps the newest row')
  assert.equal(shared.queryRecords({ runId: 'explicit-run' }).length, 1)
  assert.equal(shared.readRetention().droppedTotal, 25 - appended.total, 'host trimming is visible to MCP')
  assert.ok(shared.readAll().some(r => r.runId === 'host-run'))
  shared.appendRecords([{ id: 'mcp', ts: Date.now() + 100, method: 'GET', url: 'https://example.invalid/mcp' }], { runId: 'mcp-run' })
  assert.ok(host.readAll().some(r => r.id === 'mcp' && r.runId === 'mcp-run'))
  const filter = { runId: 'mcp-run' }
  assert.deepEqual(host.applyFilters(host.readAll(), host.paramsFromObj(filter)), shared.queryRecords(filter))
  host.clearRecords()
  assert.equal(shared.readAll().length, 0)
  console.log('PASS host/MCP native storage parity: mutual visibility, runId, filtering, retention marker and clear')
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected test cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
