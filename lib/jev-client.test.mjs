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
console.log('PASS: jev client validation, request shaping, timeout and usage')
