import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFailureCorpus } from './failure-corpus.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-corpus-incremental-'))
const record = index => ({ id: 'row-' + index, ts: new Date(Date.now() - index * 10).toISOString(), task: 'fixture', description: 'description ' + index, failureClass: 'flaky' })
try {
  const active = join(directory, 'records.jsonl')
  const archive = join(directory, 'records-old.jsonl')
  writeFileSync(archive, JSON.stringify(record(1)) + '\n')
  writeFileSync(active, JSON.stringify(record(2)) + '\n')
  const corpus = makeFailureCorpus({ dir: directory })
  assert.equal(corpus.query().readMetrics.linesParsed, 2)
  assert.equal(corpus.query().readMetrics.bytesRead, 0)
  const added = corpus.record({ task: 'fixture', description: 'appended', failureClass: 'flaky' })
  const append = corpus.query()
  assert.equal(append.total, 3)
  assert.equal(append.readMetrics.linesParsed, 1)
  assert.equal(append.readMetrics.shardsReused, 1)
  assert.equal(corpus.retract({ id: added.id, reason: 'fixture' }).ok, true)
  assert.equal(corpus.query().total, 2)
  const asyncQuery = await corpus.queryAsync()
  assert.equal(asyncQuery.total, 2)
  for (const filter of [{ q: 'description 1' }, { failureClass: 'flaky' }, { tag: 'absent' }, { fromTs: Date.now() + 1000 }, { toTs: 0 }, { limit: 1, offset: 1 }, { includeRetracted: true }]) {
    const sync = corpus.query(filter)
    const asyncResult = await corpus.queryAsync(filter)
    assert.deepEqual(asyncResult.rows, sync.rows)
    assert.equal(asyncResult.total, sync.total)
    assert.equal(asyncResult.retractedExcluded, sync.retractedExcluded)
  }
  writeFileSync(active, JSON.stringify(record(9)) + '\n')
  assert.equal((await corpus.queryAsync()).rows.some(row => row.id === 'row-9'), true)
  renameSync(active, join(directory, 'records-rotated.jsonl'))
  writeFileSync(active, JSON.stringify(record(10)))
  assert.equal(corpus.query().total, 3)
  appendFileSync(active, '\n' + JSON.stringify(record(11)) + '\ninvalid\n')
  const broken = corpus.query()
  assert.equal(broken.total, 4)
  assert.equal(broken.incomplete, true)
  assert.equal(broken.corruptLines, 1)
  assert.equal(broken.readMetrics.linesParsed, 3)
  const stats = await corpus.statsAsync()
  assert.equal(stats.totalAllShards, 4)
  assert.equal(stats.incomplete, true)
  writeFileSync(active, Array.from({ length: 50000 }, (_, index) => JSON.stringify(record(index + 100))).join('\n') + '\n')
  let beats = 0
  const timer = setInterval(() => beats++, 5)
  const large = await corpus.statsAsync()
  clearInterval(timer)
  assert.equal(large.totalAllShards, 50002)
  assert.ok(beats > 2, 'failure statistics must not block parent event loop')
  console.log('PASS: failure incremental parsing, prefix verification, external writes, rotation, corruption and worker responsiveness')
} finally { rmSync(directory, { recursive: true, force: true }) }
