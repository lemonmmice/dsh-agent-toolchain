import assert from 'node:assert/strict'
import { createJevClient, parseJevArguments } from './jev-client.mjs'

const request = parseJevArguments({
  stateJson: '{"goal":"查看详情"}',
  questionsJson: '{"next":{"type":"choice","instructions":"Which action?","criteria":{"inspect":"Read only","defer":"Do not act"}}}',
})
assert.equal(request.ok, true)
assert.equal(request.request.model, 'jev-1.13.0')
assert.equal(parseJevArguments({ stateJson: '{}', questionsJson: '{}' }).ok, false)
assert.equal(parseJevArguments({ stateJson: '{}', questionsJson: '{"x":{"type":"noul","instructions":"?"}}', timeoutMs: 50 }).errorCode, 'jev_invalid_timeout')

let seen
const client = createJevClient({ apiKey: 'test-key-that-is-long-enough', fetchImpl: async (_url, options) => {
  seen = options
  return {
    ok: true,
    json: async () => ({ model: 'jev-1.13.0', answers: { next: { type: 'choice', choice: 'inspect', confidence: 0.9 } }, usage: { input_tokens: 11, output_tokens: 7 } }),
  }
} })
const response = await client.evaluate({ state: { goal: 'inspect' }, questions: { next: { type: 'choice', instructions: 'Which?', criteria: { inspect: 'Read', defer: 'Wait' } } } })
assert.equal(response.ok, true)
assert.equal(response.usage.inputTokens, 11)
assert.match(seen.headers.authorization, /^Bearer /)
assert.equal(JSON.parse(seen.body).state.goal, 'inspect')

const timeoutClient = createJevClient({ apiKey: 'test-key-that-is-long-enough', fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
}) })
const timeout = await timeoutClient.evaluate({ timeoutMs: 100, state: 'x', questions: { ok: { type: 'noul', instructions: 'Is this true?' } } })
assert.equal(timeout.errorCode, 'jev_timeout')
const unconfigured = await createJevClient({ apiKey: '' }).evaluate({ state: 'x', questions: { ok: { type: 'noul', instructions: 'Is this true?' } } })
assert.equal(unconfigured.errorCode, 'jev_not_configured')

// 响应体有界读：真实 fetch 流超过 2MiB 上限时返回 jev_response_too_large，不把无界响应读进内存。
const bigClient = createJevClient({ apiKey: 'test-key-that-is-long-enough', fetchImpl: async () => {
  let sent = false
  return { ok: true, body: { getReader: () => ({
    read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(3 * 1024 * 1024) })),
    cancel: async () => {},
    releaseLock: () => {},
  }) } }
} })
const big = await bigClient.evaluate({ state: 'x', questions: { ok: { type: 'noul', instructions: 'Is this true?' } } })
assert.equal(big.errorCode, 'jev_response_too_large')

// single-flight：无 signal 的完全相同请求并发时只打一次 TypeSafe，搭车者共享同一个只读结果。
let sfCalls = 0
const sfClient = createJevClient({ apiKey: 'test-key-that-is-long-enough', fetchImpl: async () => {
  sfCalls++
  await new Promise((r) => setTimeout(r, 20))
  return { ok: true, json: async () => ({ answers: { x: { type: 'noul', value: true } } }) }
} })
const sfReq = { state: 'same', questions: { x: { type: 'noul', instructions: 'q' } } }
const [sfA, sfB] = await Promise.all([sfClient.evaluate(sfReq), sfClient.evaluate(sfReq)])
assert.equal(sfCalls, 1)
assert.equal(sfA, sfB)
assert.equal(sfA.ok, true)
// 不同请求不去重：换个 state 必须另打一次。
await sfClient.evaluate({ state: 'other', questions: { x: { type: 'noul', instructions: 'q' } } })
assert.equal(sfCalls, 2)

// 外部 signal 贯穿：调用方取消（任务取消 / 期限）立即结束，返回 jev_cancelled（区别于 jev_timeout）。
const ac = new AbortController()
const cancelClient = createJevClient({ apiKey: 'test-key-that-is-long-enough', fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
}) })
const cancelPromise = cancelClient.evaluate({ state: 'x', questions: { ok: { type: 'noul', instructions: 'q' } }, signal: ac.signal, timeoutMs: 5000 })
ac.abort()
const cancelled = await cancelPromise
assert.equal(cancelled.errorCode, 'jev_cancelled')

console.log('PASS: jev client validation, request shaping, timeout, usage, bounded read, single-flight, external cancel')
