import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { sendRequest, MAX_RESP_BYTES } from '../lib/http.mjs'
import { renderHttp, toListItem } from '../lib/view.mjs'

let requests = 0
let streamClosed = false
let onBodyStarted
const server = createServer((request, response) => {
  requests++
  if (request.url === '/large-stream') {
    response.on('close', () => { streamClosed = true })
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.write(Buffer.alloc(MAX_RESP_BYTES + 65536, 65))
    return
  }
  if (request.url === '/body-wait') {
    response.writeHead(200)
    response.write('received headers and partial body')
    onBodyStarted?.()
    return
  }
  if (request.url === '/wait') return
  if (request.url === '/unicode') {
    response.end(Buffer.concat([Buffer.alloc(MAX_RESP_BYTES - 1, 65), Buffer.from('中文')]))
    return
  }
  response.end(request.url === '/exact' ? Buffer.alloc(MAX_RESP_BYTES, 65) : 'small response')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
try {
  const started = Date.now()
  const large = await sendRequest({ url: base + '/large-stream', timeoutMs: 2000 })
  assert.equal(large.ok, true)
  assert.equal(large.truncated, true)
  assert.equal(large.sizeExact, false)
  assert.ok(large.size > MAX_RESP_BYTES)
  assert.equal(large.retainedBytes, MAX_RESP_BYTES)
  assert.equal(Buffer.byteLength(large.body), MAX_RESP_BYTES)
  assert.ok(Date.now() - started < 1500)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(streamClosed, true)
  assert.match(renderHttp({}, large)[0].text, /总大小未知/)
  const item = toListItem({ id: 'fixture', response: large })
  assert.equal(item.sizeExact, false)
  assert.equal(item.truncated, true)

  const exact = await sendRequest({ url: base + '/exact' })
  assert.equal(exact.truncated, false)
  assert.equal(exact.sizeExact, true)
  assert.equal(exact.size, MAX_RESP_BYTES)
  const small = await sendRequest({ url: base + '/small' })
  assert.equal(small.body, 'small response')
  assert.equal(small.sizeExact, true)
  const unicode = await sendRequest({ url: base + '/unicode' })
  assert.equal(unicode.truncated, true)
  assert.equal(unicode.body.includes('\ufffd'), false)
  assert.ok(Buffer.byteLength(unicode.body) <= MAX_RESP_BYTES)

  const before = requests
  const preCancelled = new AbortController()
  preCancelled.abort(new Error('private cancel reason'))
  const preResult = await sendRequest({ url: base + '/small', signal: preCancelled.signal })
  assert.equal(preResult.cancelled, true)
  assert.equal(requests, before)
  assert.equal(preResult.error, 'request cancelled')

  const bodyCancellation = new AbortController()
  const bodyStarted = new Promise(resolve => { onBodyStarted = resolve })
  const pending = sendRequest({ url: base + '/body-wait', timeoutMs: 2000, signal: bodyCancellation.signal })
  await bodyStarted
  bodyCancellation.abort(new Error('private cancel reason'))
  const bodyResult = await pending
  assert.equal(bodyResult.cancelled, true)
  assert.equal(bodyResult.error, 'request cancelled')
  onBodyStarted = null
  const timed = await sendRequest({ url: base + '/wait', timeoutMs: 30 })
  assert.equal(timed.cancelled, undefined)
  assert.match(timed.error, /timeout after 30ms/)

  const invalidHeader = await sendRequest({ url: base, headers: { Authorization: 'private-header-value\ninvalid' } })
  assert.equal(invalidHeader.ok, false)
  assert.equal(JSON.stringify(invalidHeader).includes('private-header-value'), false)
  const invalidUrl = await sendRequest({ url: 'private-token invalid url' })
  assert.equal(JSON.stringify(invalidUrl).includes('private-token'), false)
  console.log('PASS HTTP boundaries: stream cap/cancel, exact size, UTF-8, caller cancellation, timeout and error redaction')
} finally {
  const closing = once(server, 'close')
  server.closeAllConnections()
  server.close()
  await closing
}
