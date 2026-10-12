import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { makeFailureCorpus } from './failure-corpus.mjs'

process.env.DSH_TEST = '1'
process.env.DSH_NO_ENV_FALLBACK = '1'
const root = fs.mkdtempSync(path.join(tmpdir(), 'failure-snapshot-'))
const readFile = fs.readFileSync
try {
  for (const operation of ['query', 'stats']) {
    const dir = path.join(root, operation)
    const corpus = makeFailureCorpus({ dir })
    const saved = corpus.record({ task: 'fixture', failureClass: 'tool-error', description: 'fixture' })
    const active = path.join(dir, 'records.jsonl')
    let reads = 0
    fs.readFileSync = (file, ...args) => {
      if (file === active && ++reads === 1) {
        fs.renameSync(active, path.join(dir, 'records-rotated.jsonl'))
        fs.writeFileSync(active, JSON.stringify({ ...saved, id: 'new-record' }) + '\n')
      }
      return readFile(file, ...args)
    }
    syncBuiltinESMExports()
    const result = corpus[operation]()
    assert.equal(result.incomplete, true, operation + ' must disclose mid-read rotation')
    assert.ok(result.skippedShards.some(shard => shard.errorCode === 'SHARDS_CHANGED_DURING_READ'))
    assert.equal(reads, 1, 'must not automatically repeat data reads')
    fs.readFileSync = readFile
    syncBuiltinESMExports()
    const stable = corpus[operation]()
    assert.equal(stable.incomplete, false)
    assert.equal(operation === 'query' ? stable.total : stable.totalAllShards, 2)
    assert.notEqual(stable.dataVersion, result.dataVersion)
  }
  const recurrenceDir = path.join(root, 'recurrences')
  const recurrenceCorpus = makeFailureCorpus({ dir: recurrenceDir })
  const repeated = { task: 'repeated fixture', failureClass: 'tool-error', description: 'fixture', dedupe: true }
  recurrenceCorpus.record(repeated)
  recurrenceCorpus.record(repeated)
  const recurrenceFile = path.join(recurrenceDir, 'recurrences.jsonl')
  let recurrenceReads = 0
  fs.readFileSync = (file, ...args) => {
    const text = readFile(file, ...args)
    if (file === recurrenceFile && ++recurrenceReads === 1) fs.appendFileSync(file, text)
    return text
  }
  syncBuiltinESMExports()
  const recurrenceResult = recurrenceCorpus.query()
  assert.equal(recurrenceResult.incomplete, true)
  assert.ok(recurrenceResult.skippedShards.some(shard => shard.file === 'recurrences.jsonl' && shard.errorCode === 'SHARDS_CHANGED_DURING_READ'))
  assert.equal(recurrenceReads, 1)
  fs.readFileSync = readFile
  syncBuiltinESMExports()
  assert.equal(recurrenceCorpus.query().rows[0].recurrences, 2)
  fs.readFileSync = (file, ...args) => {
    const text = readFile(file, ...args)
    if (file === recurrenceFile) fs.appendFileSync(path.join(recurrenceDir, 'records.jsonl'), JSON.stringify({ id: 'during-recurrences', ts: new Date().toISOString(), task: 'fixture', failureClass: 'tool-error', description: 'fixture' }) + '\n')
    return text
  }
  syncBuiltinESMExports()
  const crossFile = makeFailureCorpus({ dir: recurrenceDir }).query()
  assert.equal(crossFile.incomplete, true)
  assert.ok(crossFile.skippedShards.some(shard => shard.file === '.' && shard.errorCode === 'SHARDS_CHANGED_DURING_READ'))
  console.log('PASS failure snapshot: injected rotation/recurrence changes report incomplete without rereading; next read obtains stable version')
} finally {
  fs.readFileSync = readFile
  syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
