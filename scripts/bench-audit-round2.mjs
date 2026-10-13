import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sourceIdentity } from '../lib/build-evidence.mjs'
import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { makeFailureCorpus } from '../lib/failure-corpus.mjs'
import { KvMemory } from '../plugins/dsh-memory/lib/kv.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-audit-round2-'))
const result = { node: process.version, platform: process.platform, measuredAt: new Date().toISOString(), samples: {} }
async function measure(name, operation, count = 3) {
  const samples = []
  for (let iteration = 0; iteration < count; iteration++) {
    const started = performance.now()
    let heartbeatMs
    const heartbeat = new Promise(resolve => setTimeout(() => { heartbeatMs = performance.now() - started; resolve() }, 5))
    await operation()
    const elapsedMs = performance.now() - started
    await heartbeat
    samples.push({ elapsedMs: +elapsedMs.toFixed(2), heartbeatMs: +heartbeatMs.toFixed(2) })
  }
  result.samples[name] = samples
}
try {
  const source = join(directory, 'source')
  mkdirSync(source)
  execFileSync('git', ['init', '-q', source], { windowsHide: true })
  for (let index = 0; index < 10000; index++) writeFileSync(join(source, `File${index}.cs`), 'class Fixture {}\n'.repeat(32))
  await measure('source10000', async () => {
    const identity = await sourceIdentity(source)
    assert.equal(identity.available, true, JSON.stringify(identity))
    result.sourceDigest = identity.digest
    result.sourceMetrics = identity
  })
  const logPath = join(directory, 'build.log')
  const line = 'ordinary build output ' + 'x'.repeat(160) + '\n'
  writeFileSync(logPath, line.repeat(Math.ceil(64 * 1024 * 1024 / line.length)) + 'A.cs(1,2): error CS1002: ; expected\n')
  writeFileSync(join(directory, 'last.json'), JSON.stringify({ logPath, ok: false }))
  const builder = makeBuilder({ logsDir: directory, repoRoot: '', clientRoot: '' })
  await measure('log64MiB', async () => assert.equal((await builder.errorsOfLast()).errors.length, 1))
  const corpusDir = join(directory, 'corpus')
  mkdirSync(corpusDir)
  const timestamp = new Date().toISOString()
  const records = Array.from({ length: 50000 }, (_, index) => ({ id: `record-${index}`, ts: timestamp, task: 'fixture', description: `failure ${index}`, failureClass: 'flaky' }))
  writeFileSync(join(corpusDir, 'records.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const corpus = makeFailureCorpus({ dir: corpusDir })
  await measure('failureCold', () => assert.equal(corpus.query({ limit: 20 }).total, 50000), 1)
  await measure('failureWriteStats', () => { corpus.record({ task: 'fixture', description: 'another', failureClass: 'flaky' }); assert.ok(corpus.stats().totalAllShards > 50000) })
  if (corpus.statsAsync) {
    await measure('failureWorkerCold', async () => assert.ok((await corpus.statsAsync()).totalAllShards > 50000), 1)
    await measure('failureWorkerWriteStats', async () => { corpus.record({ task: 'fixture', description: 'worker addition', failureClass: 'flaky' }); assert.ok((await corpus.statsAsync()).totalAllShards > 50000) })
  }
  const kvDir = join(directory, 'kv')
  mkdirSync(kvDir)
  writeFileSync(join(kvDir, 'kv.jsonl'), records.map((record, index) => JSON.stringify({ key: `key-${index}`, value: record.description, scope: 'global' })).join('\n') + '\n')
  const kv = new KvMemory(kvDir)
  kv.get('key-1')
  await measure('kvWriteRecall', () => { kv.save('key-1', 'updated'); assert.equal(kv.get('key-1').value, 'updated') })
  const output = process.argv[2]
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
