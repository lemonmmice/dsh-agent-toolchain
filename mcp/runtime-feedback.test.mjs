import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-feedback-'))
const client = new Client({ name: 'feedback-test', version: '1' })
const notifications = []
let responseClosed
const closed = new Promise((done) => { responseClosed = done })
const fixture = createServer((request, response) => {
  response.writeHead(200)
  response.write('pending')
  response.on('close', responseClosed)
})
try {
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')],
    env: { ...env, DSH_NO_ENV_FALLBACK: '1', DSH_MEMORY_DIR: join(scratch, 'memory'), DSH_FAILURE_CORPUS_DIR: join(scratch, 'failure'), DSH_HANG_EVIDENCE_DIR: join(scratch, 'hang'), DSH_VERIFY_DIR: join(scratch, 'verify') },
    stderr: 'pipe',
  }))
  for (const [name, args, code] of [
    ['ui_drive', { action: 'click', name: 'denied' }, 'side_effect_not_authorized'],
    ['ui_flow', { steps: [{ action: 'click', name: 'denied' }] }, 'side_effect_not_authorized'],
    ['hang_delete', { id: 'missing', confirm: false }, 'confirmation_required'],
    ['hang_delete', { confirm: true }, 'missing_target'],
    ['hang_pack', { id: 'missing' }, 'pack_not_found'],
    ['memory_save', { key: 'sensitive', value: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456789' }, 'memory_save_rejected'],
  ]) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, name)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.ok, false, name)
    assert.equal(payload.errorCode, code, name)
  }
  const invalidRequest = await client.callTool({ name: 'http_request', arguments: { url: 'invalid-url?token=fixture-private-token' } })
  assert.equal(invalidRequest.isError, true)
  const failures = await client.callTool({ name: 'failure_query', arguments: { q: 'http_request' } })
  assert.ok(!JSON.stringify(failures).includes('fixture-private-token'), 'failure corpus must not retain private request URLs')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 2300)
  try {
    await assert.rejects(client.callTool({ name: 'http_request', arguments: { url: `http://127.0.0.1:${fixture.address().port}/`, timeoutMs: 20000 } }, undefined, {
      signal: abort.signal,
      onprogress: (notification) => notifications.push(notification),
    }))
  } finally {
    clearTimeout(timer)
  }
  assert.ok(notifications.length >= 2)
  assert.match(notifications[0].message, /started/)
  assert.match(notifications.at(-1).message, /running/)
  let deadline
  await Promise.race([closed, new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('HTTP cancellation did not close the response')), 3000) })]).finally(() => clearTimeout(deadline))
  const healthy = await client.callTool({ name: 'memory_recall', arguments: { key: 'missing' } })
  assert.equal(healthy.isError, undefined)
  console.log('PASS: real MCP errors, progress and HTTP cancellation')
} finally {
  await client.close()
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
  rmSync(scratch, { recursive: true, force: true })
}
