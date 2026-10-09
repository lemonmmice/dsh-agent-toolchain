import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshMemory } from '../lib/memory.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const dir = mkdtempSync(join(tmpdir(), 'memory-metadata-'))
try {
  mkdirSync(join(dir, 'kv'))
  writeFileSync(join(dir, 'kv', 'kv.jsonl'), JSON.stringify({ key: 'legacy', value: 'old', scope: 'fixture', updatedAt: 1 }) + '\n')
  const mem = new DshMemory({ dataDir: dir, embedProvider: new EmbedProvider({ apiKey: null }) })
  assert.equal(mem.recall('legacy', 'fixture').value, 'old')
  assert.equal(mem.recall('legacy', 'fixture').expired, false)
  const fact = mem.remember('fact', 'fixture', 'fixture')
  assert.equal(fact.kind, 'fact')
  assert.equal(fact.expiresAt, null)
  assert.ok(fact.source.toolchain.version)
  const debug = mem.remember('debug', 'fixture', 'fixture', { kind: 'debug', reason: 'reproducible finding' })
  assert.ok(Math.abs(Date.parse(debug.expiresAt) - Date.now() - 14 * 86400000) < 1000)
  assert.equal(mem.remember('permanent', 'fixture', 'fixture', { kind: 'debug', ttlDays: 0 }).expiresAt, null)
  mem.kv.save('expired', 'fixture', 'fixture', { kind: 'debug', expiresAt: '2000-01-01T00:00:00.000Z' })
  const before = readFileSync(mem.kv.file, 'utf8')
  assert.equal(mem.recall('expired', 'fixture').expired, true)
  assert.equal(readFileSync(mem.kv.file, 'utf8'), before)
  assert.deepEqual(mem.status().byKind, { fact: 2, convention: 0, debug: 3 })
  assert.equal(mem.status().expired, 1)
  assert.throws(() => mem.remember('bad', 'fixture', 'fixture', { kind: 'unknown' }), /kind/)
  assert.throws(() => mem.remember('bad', 'fixture', 'fixture', { reason: 'x'.repeat(201) }), /reason/)
  for (const ttlDays of [-1, NaN, Infinity, '2']) assert.throws(() => mem.remember('bad', 'fixture', 'fixture', { ttlDays }), /ttlDays/)
  const file = join(dir, 'fixture.md')
  writeFileSync(file, 'fixture searchable memory')
  await mem.indexFile(file, 'fixture.md', dir)
  const hits = await mem.search('searchable')
  assert.ok(hits[0].meta.indexedAt)
  assert.deepEqual(hits[0].meta.embed, { source: 'bigram', version: 'bigram/1' })
  mem.forget('expired', 'fixture')
  assert.equal(mem.recall('expired', 'fixture'), null)
  console.log('PASS memory metadata: defaults, provenance, expiry, read-only recall, validation and legacy rows')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
