import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const executable = process.env.DSH_RUNTIME_EXE || join(root, 'mcp/bin', `${process.platform}-${process.arch}`, 'dsh-toolchain' + (process.platform === 'win32' ? '.exe' : ''))
const directory = mkdtempSync(join(tmpdir(), 'dsh-native-runtime-'))
const unwrap = result => JSON.parse(result.content.find(block => block.type === 'text').text)
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let mutations = 0
let controlMutations = 0
let onWaiting
const fixture = createServer(async (request, response) => {
  if (request.url === '/redirect') { response.writeHead(307, { location: '/api/dsh-ui-drive/approvals/grant' }); response.end(); return }
  if (request.url.startsWith('/api/dsh-ui-drive/')) { controlMutations++; response.end('unexpected'); return }
  if (request.url === '/wait') { onWaiting?.(); return }
  if (request.url === '/large') { response.writeHead(200); response.write(Buffer.alloc(2 * 1024 * 1024 + 65536, 65)); return }
  if (request.url === '/unicode') { response.end(Buffer.concat([Buffer.alloc(2 * 1024 * 1024 - 1, 65), Buffer.from('中文')])); return }
  if (request.url === '/gzip') {
    const compressed = gzipSync('compressed response')
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length })
    response.end(compressed)
    return
  }
  if (request.url === '/mutate') { mutations++; await pause(50); response.end('once'); return }
  if (request.url === '/not-found') { response.writeHead(404); response.end('missing'); return }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ method: request.method, header: request.headers['x-fixture'] || '' }))
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + fixture.address().port
const clients = new Set()
async function open(legacy = false) {
  const client = new Client({ name: 'native-runtime-test', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: executable,
    args: legacy ? ['--legacy-server', join(root, 'mcp/server.mjs')] : ['--native-only'],
    env: { ...process.env, DSH_ENV_FILE: 'none', DSH_NO_ENV_FALLBACK: '1', DSH_TOOL_PROFILE: '',
      DSH_TASK_DIR: join(directory, 'tasks'), DSH_VERIFY_DIR: join(directory, 'reports'), DSH_FAILURE_CORPUS_DIR: join(directory, 'failures'),
      DSH_NODE_EXE: legacy ? process.execPath : 'node-must-not-be-required', DSH_RUNTIME_EXE: executable }, stderr: 'inherit' })
  await client.connect(transport)
  clients.add(client)
  return client
}
async function call(client, name, args, options) { return unwrap(await client.callTool({ name, arguments: args }, undefined, options)) }
async function terminal(client, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await call(client, 'toolchain_job', { action: 'status', jobId: id })
    if (['done', 'failed', 'cancelled', 'unknown'].includes(record.state)) return record
    await pause(20)
  }
  throw new Error('Task did not finish')
}

try {
  const native = await open()
  assert.deepEqual((await native.listTools()).tools.map(tool => tool.name).sort(), ['http_request', 'toolchain_job', 'toolchain_status', 'ui_observe'])
  const invalid = await native.callTool({ name: 'http_request', arguments: { url: 123 } })
  assert.equal(invalid.isError, true)
  const reply = await call(native, 'http_request', { url: base, headers: { 'X-Fixture': 'unicode-safe' } })
  assert.equal(reply.ok, true)
  assert.deepEqual(JSON.parse(reply.body), { method: 'GET', header: 'unicode-safe' })
  assert.equal((await call(native, 'http_request', { url: base + '/not-found' })).status, 404)
  for (const path of ['/api/dsh-ui-drive/estop/reset', '/redirect']) {
    assert.equal((await call(native, 'http_request', { url: base + path, method: 'POST' })).errorCode, 'control_plane_forbidden')
  }
  assert.equal(controlMutations, 0)
  const large = await call(native, 'http_request', { url: base + '/large', timeoutMs: 2000 })
  assert.equal(large.truncated, true)
  assert.equal(large.retainedBytes, 2 * 1024 * 1024)
  assert.equal(large.sizeExact, false)
  const unicode = await call(native, 'http_request', { url: base + '/unicode' })
  assert.equal(unicode.body.includes('\ufffd'), false)
  const compressed = await call(native, 'http_request', { url: base + '/gzip' })
  assert.equal(compressed.body, 'compressed response')
  assert.equal(compressed.headers['content-encoding'], 'gzip')
  const timeout = await call(native, 'http_request', { url: base + '/wait', timeoutMs: 30 })
  assert.match(timeout.error, /timeout after 30ms/)
  const controller = new AbortController()
  const waiting = new Promise(resolve => { onWaiting = resolve })
  const pending = call(native, 'http_request', { url: base + '/wait' }, { signal: controller.signal }).catch(error => error)
  await waiting
  const status = await call(native, 'toolchain_status', {})
  assert.equal(status.runtime, 'rust')
  controller.abort()
  await pending
  const args = { url: base + '/mutate', method: 'POST', asyncJob: true, requestKey: 'exactly-once' }
  const first = await call(native, 'http_request', args)
  const second = await call(native, 'http_request', args)
  assert.equal(first.accepted, true)
  assert.equal(second.deduplicated, true)
  assert.equal(first.jobId, second.jobId)
  assert.equal((await terminal(native, first.jobId)).state, 'done')
  assert.equal(mutations, 1)
  assert.match((await call(native, 'http_request', { ...args, body: 'changed' })).error, /TASK_KEY_CONFLICT/)
  const result = await call(native, 'toolchain_job', { action: 'result', jobId: first.jobId })
  assert.equal(result.resultReady, true)
  assert.equal(unwrap(JSON.parse(readFileSync(result.result.path, 'utf8'))).body, 'once')
  const cancelled = await call(native, 'http_request', { url: base + '/wait', asyncJob: true, requestKey: 'cancelled' })
  await call(native, 'toolchain_job', { action: 'cancel', jobId: cancelled.jobId })
  assert.ok(['cancelled', 'unknown'].includes((await terminal(native, cancelled.jobId)).state))
  await native.close()
  clients.delete(native)
  const restarted = await open()
  const reused = await call(restarted, 'http_request', args)
  assert.equal(reused.jobId, first.jobId)
  assert.equal(reused.deduplicated, true)
  assert.equal(mutations, 1)
  const hybrid = await open(true)
  assert.equal((await hybrid.listTools()).tools.length, 56)
  assert.equal((await call(hybrid, 'http_request', { url: base })).ok, true)
  assert.equal((await call(hybrid, 'http_request', { url: 'invalid fixture URL' })).ok, false)
  const failures = readFileSync(join(directory, 'failures/records.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(failures.some(record => record.failureClass === 'tool-error' && record.task.includes('http_request')))
  const report = await call(hybrid, 'verify_report', { runId: 'rust-native-file', task: 'native report storage',
    claims: [{ kind: 'file', path: join(root, 'package.json'), statement: 'The fixture exists' }] })
  assert.equal(report.verdict, 'pass')
  assert.equal(JSON.parse(readFileSync(report.reportPath, 'utf8')).verdict, 'pass')
  const metadataReport = unwrap(await hybrid.callTool({ name: 'verify_report', _meta: { 'x-codex-turn-metadata': { thread_id: 'native-fixture', turn_id: 'turn-fixture' } },
    arguments: { runId: 'rust-provenance', task: 'bridge provenance', claims: [{ kind: 'file', path: join(root, 'package.json'), statement: 'The fixture exists' }] } }))
  assert.equal(JSON.parse(readFileSync(metadataReport.reportPath, 'utf8')).producer.agentTurn.turnId, 'turn-fixture')
  console.log('PASS Rust MCP: standalone HTTP, validation, bounded body, cancellation, concurrent status, durable tasks, deduplication, restart, 56-tool bridge and evidence storage')
} finally {
  for (const client of clients) await client.close()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
