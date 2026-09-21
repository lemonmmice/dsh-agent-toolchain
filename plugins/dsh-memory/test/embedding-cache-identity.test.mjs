import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-embedding-cache-'))
const originalFetch = globalThis.fetch
let calls = 0
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ vectors: [[++calls, 1]] }) })
try {
  writeFileSync(join(cacheDir, 'emb-1mo.json'), JSON.stringify({ vector: [-1, -1] }))
  const provider = new EmbedProvider({ apiKey: 'fixture-key', cacheDir })
  const first = await provider.embed('Aa')
  const collision = await provider.embed('BB')
  assert.deepEqual(first, [1, 1])
  assert.deepEqual(collision, [2, 1])
  assert.equal(calls, 2)
  assert.deepEqual(await provider.embed('Aa'), first)
  assert.equal(calls, 2)

  provider.model = 'fixture-other-model'
  assert.deepEqual(await provider.embed('Aa'), [3, 1])
  provider.baseURL = 'https://fixture-private-endpoint.invalid/v1'
  assert.deepEqual(await provider.embed('Aa'), [4, 1])
  assert.equal(calls, 4)
  const files = readdirSync(cacheDir)
  assert.equal(files.filter(name => /^emb-[0-9a-f]{64}\.json$/.test(name)).length, 4)
  assert.equal(files.some(name => /fixture|Aa|BB|private/.test(name)), false)
  assert.ok(files.includes('emb-1mo.json'))
  console.log('PASS embedding cache identity: Aa/BB collision eliminated, model/endpoint isolation, stable hits and old cache ignored')
} finally {
  globalThis.fetch = originalFetch
  rmSync(cacheDir, { recursive: true, force: true })
}
