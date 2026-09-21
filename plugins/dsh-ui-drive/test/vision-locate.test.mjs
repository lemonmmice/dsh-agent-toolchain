import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeVision, parseLocateResponse } from '../lib/vision.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-locate-'))
const png = join(dir, 'frame.png')
writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
const calls = []
const response = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) })

try {
  assert.deepEqual(parseLocateResponse('{"x":12,"y":34,"confidence":0.91,"reason":"中心"}'), { ok: true, x: 12, y: 34, confidence: 0.91, reason: '中心' })
  assert.equal(parseLocateResponse('```json\n{"x":12,"y":34,"confidence":0.91}\n```').ok, false)
  assert.equal(parseLocateResponse('{"x":null,"y":null,"confidence":0,"reason":"not found"}').error, '视觉定位未找到目标')
  for (const value of [
    '{"x":1.2,"y":2,"confidence":0.9}',
    '{"x":1,"y":2,"confidence":2}',
    '{"x":-1,"y":2,"confidence":0.9}',
    '{"x":1,"y":2,"confidence":0.9,"reason":4}',
    '{"x":1,"y":2,"confidence":0.9,"extra":{}}',
  ]) assert.equal(parseLocateResponse(value).ok, false)

  const vision = makeVision({
    timeoutMs: 200,
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'redacted-test-key' }),
    fetch: async (url, options) => {
      calls.push({ url, options })
      return response('{"x":17,"y":23,"confidence":0.88,"reason":"按钮中心"}')
    },
  })
  const located = await vision.locateImage(png, '删除按钮', 0.8)
  assert.deepEqual(located, { ok: true, x: 17, y: 23, confidence: 0.88, reason: '按钮中心', model: 'test-model' })
  assert.match(calls[0].options.body, /删除按钮/)
  assert.equal(calls[0].options.signal instanceof AbortSignal, true)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer redacted-test-key')
  assert.equal((await vision.locateImage(png, '删除按钮', 0.9)).ok, false)
  assert.equal((await vision.locateImage(png, '', 0.8)).error, '视觉定位目标描述无效')
  assert.equal((await vision.locateImage(png, '目标', 0.49)).error, 'visualMinConfidence 必须在 0.5 到 1 之间')

  const httpError = makeVision({
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'secret-key' }),
    fetch: async () => ({ ok: false, status: 401, text: async () => 'Bearer secret-key and private response' }),
  })
  const failed = await httpError.describeImage(png)
  assert.deepEqual(failed, { ok: false, error: 'vision HTTP 401' })
  assert.equal(JSON.stringify(failed).includes('secret-key'), false)
  assert.equal(JSON.stringify(failed).includes('private response'), false)

  const timed = makeVision({
    timeoutMs: 25,
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'secret-key' }),
    fetch: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })
  const started = Date.now()
  const timeout = await timed.describeImage(png)
  assert.equal(timeout.ok, false)
  assert.match(timeout.error, /超时/)
  assert.ok(Date.now() - started < 1000)
  assert.equal(JSON.stringify(timeout).includes('secret-key'), false)
  let bodySignal
  const stalledBody = makeVision({
    timeoutMs: 25,
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'secret-key' }),
    fetch: async (_url, options) => {
      bodySignal = options.signal
      return { ok: true, json: () => new Promise(() => {}) }
    },
  })
  assert.match((await stalledBody.describeImage(png)).error, /超时/)
  assert.equal(bodySignal.aborted, true)
  const malformedBody = makeVision({
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'secret-key' }),
    fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('private response containing secret-key') } }),
  })
  const malformed = await malformedBody.describeImage(png)
  assert.equal(malformed.ok, false)
  assert.equal(JSON.stringify(malformed).includes('private response'), false)
  assert.equal(JSON.stringify(malformed).includes('secret-key'), false)
  let successSignal
  const fast = makeVision({
    timeoutMs: 25,
    resolveConfig: () => ({ baseURL: 'https://vision.invalid/v1', model: 'test-model', apiKey: 'test-key' }),
    fetch: async (_url, options) => { successSignal = options.signal; return response('ok') },
  })
  assert.equal((await fast.describeImage(png)).ok, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(successSignal.aborted, false)
  console.log('PASS vision locate: strict JSON, confidence gate, injected fetch, timeout and response redaction')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
