import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshMemory } from '../lib/memory.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const directory = mkdtempSync(join(tmpdir(), 'memory-write-'))
const memory = new DshMemory({ dataDir: directory, embedProvider: new EmbedProvider({ apiKey: null }) })
try {
  writeFileSync(memory.kv.file, Array.from({ length: 50000 }, (_, index) => JSON.stringify({ key: 'key-' + index, scope: 'global', value: 'x'.repeat(256) })).join('\n') + '\n')
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 5)
  await memory.rememberAsync('new', 'first')
  clearTimeout(timer)
  assert.equal(heartbeat, true)
  assert.equal((await memory.recallAsync('new')).value, 'first')
  await Promise.all(Array.from({ length: 8 }, (_, index) => memory.rememberAsync('queued-' + index, 'value')))
  assert.equal((await memory.statusAsync()).kvEntries, 50009)
  assert.equal((await memory.forgetAsync('new')).deleted, 1)
  assert.equal((await memory.forgetAsync('new')).deleted, 0)
  await assert.rejects(memory.rememberAsync('secret', 'sk-' + 'a'.repeat(32)))
  console.log('PASS KV process service: responsive 50k-row write, ordered queue, precise forget, read-after-write and secret screening')
} finally { memory.close(); rmSync(directory, { recursive: true, force: true }) }
