import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshMemory } from '../lib/memory.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const directory = mkdtempSync(join(tmpdir(), 'memory-status-'))
const memory = new DshMemory({ dataDir: directory, embedProvider: new EmbedProvider({ apiKey: null, cacheDir: join(directory, 'cache') }) })
try {
  memory.remember('fact', 'value')
  memory.kv.save('expired', 'old', 'global', { kind: 'debug', expiresAt: new Date(Date.now() - 1000).toISOString() })
  memory.kv.all = () => { throw new Error('status must not clone the entire KV store') }
  assert.deepEqual(memory.status().byKind, { fact: 1, convention: 0, debug: 1 })
  assert.equal(memory.status().expired, 1)
  const vectorFile = join(directory, 'vectors', 'default.jsonl')
  mkdirSync(join(directory, 'vectors'), { recursive: true })
  writeFileSync(vectorFile, Array.from({ length: 10000 }, (_, index) => JSON.stringify({ id: 'chunk-' + index, vector: [1, 2, 3], meta: { text: 'x'.repeat(2048) } })).join('\n') + '\n')
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 5)
  const first = await memory.statusAsync()
  clearTimeout(timer)
  assert.equal(heartbeat, true)
  assert.equal(first.chunks, 10000)
  assert.equal(first.kvEntries, 2)
  assert.equal(first.expired, 1)
  assert.equal(first.vectorMetadata.cacheHit, false)
  assert.equal((await memory.statusAsync()).vectorMetadata.cacheHit, true)
  memory.kv.save('expired', 'renewed', 'global', { kind: 'convention', expiresAt: null })
  assert.equal((await memory.statusAsync()).expired, 0)
  assert.equal((await memory.recallAsync('expired')).value, 'renewed')
  const original = readFileSync(vectorFile, 'utf8')
  writeFileSync(vectorFile, original + JSON.stringify({ id: 'extra', vector: [2, 3, 4] }) + '\n')
  assert.equal((await memory.statusAsync()).chunks, 10001)
  writeFileSync(vectorFile, '{corrupt\n')
  await assert.rejects(memory.statusAsync())
  console.log('PASS memory status: aggregate ownership, expiry, external changes, metadata-only cold scan, worker responsiveness and corruption')
} finally {
  memory.closeReadWorker?.()
  rmSync(directory, { recursive: true, force: true })
}
