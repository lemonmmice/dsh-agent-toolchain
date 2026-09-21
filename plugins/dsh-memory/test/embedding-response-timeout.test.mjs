import assert from 'node:assert/strict'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const originalFetch = globalThis.fetch
const previousTimeout = process.env.DSH_MEMORY_EMBED_TIMEOUT_MS
process.env.DSH_MEMORY_EMBED_TIMEOUT_MS = '1000'
const provider = new EmbedProvider({ apiKey: 'fixture-private-key' })
try {
  let signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return { ok: true, status: 200, json: () => new Promise(() => {}) }
  }
  const started = Date.now()
  await assert.rejects(provider.embed('fixture content'), /超时 1000ms/)
  assert.ok(Date.now() - started < 1800)
  assert.equal(signal.aborted, true)

  let cancelled = false
  let parsedErrorBody = false
  globalThis.fetch = async () => ({
    ok: false, status: 401,
    body: { cancel: async () => { cancelled = true } },
    json: async () => { parsedErrorBody = true; return { error: 'fixture-private-key private response' } },
  })
  await assert.rejects(provider.embed('fixture content'), error => /HTTP 401/.test(error.message) && !/private/.test(error.message))
  assert.equal(cancelled, true)
  assert.equal(parsedErrorBody, false)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('fixture-private-key in response') } })
  await assert.rejects(provider.embed('fixture content'), error => /响应格式错误/.test(error.message) && !/fixture-private-key/.test(error.message))
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ vectors: [[1, null]] }) })
  await assert.rejects(provider.embed('fixture content'), /响应格式错误/)
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return { ok: true, status: 200, json: async () => ({ vectors: [[1, 2, 3]] }) }
  }
  assert.deepEqual(await provider.embed('fixture content'), [1, 2, 3])
  await new Promise(resolve => setTimeout(resolve, 1050))
  assert.equal(signal.aborted, false)
  console.log('PASS embedding response timeout: stalled body bounded, error body cancelled/redacted, vector validation and timer cleanup')
} finally {
  globalThis.fetch = originalFetch
  if (previousTimeout === undefined) delete process.env.DSH_MEMORY_EMBED_TIMEOUT_MS
  else process.env.DSH_MEMORY_EMBED_TIMEOUT_MS = previousTimeout
}
