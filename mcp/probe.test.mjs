import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const probe = join(dirname(fileURLToPath(import.meta.url)), 'probe.mjs')
let firstFinished = false
let secondStartedAfterFirst = false
const fixture = createServer((request, response) => {
  if (request.url === '/first') {
    const timer = setTimeout(() => { firstFinished = true; response.end('first') }, 150)
    response.on('close', () => clearTimeout(timer))
  } else {
    secondStartedAfterFirst = firstFinished
    response.end('second')
  }
})
try {
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${fixture.address().port}`
  const options = { env: { ...process.env, DSH_NO_ENV_FALLBACK: '1' }, timeout: 15000, windowsHide: true }
  await execute(process.execPath, [probe, '--seq', JSON.stringify([
    ['http_request', { url: base + '/first' }],
    ['http_request', { url: base + '/second' }],
  ])], options)
  assert.equal(secondStartedAfterFirst, true, '--seq must await each result before sending the next request')
  const started = performance.now()
  await assert.rejects(execute(process.execPath, [probe, 'memory_recall', '{}'], options), (error) => error.code === 1 && /isError: true/.test(error.stdout))
  assert.ok(performance.now() - started < 10000, 'schema errors must finish without waiting for the 240s tool timeout')
  console.log('PASS: probe executes sequentially and exits on MCP errors')
} finally {
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
}
