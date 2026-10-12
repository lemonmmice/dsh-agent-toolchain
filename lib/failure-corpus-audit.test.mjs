import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { makeFailureCorpus } from './failure-corpus.mjs'

process.env.DSH_TEST = '1'
process.env.DSH_NO_ENV_FALLBACK = '1'
const root = fs.mkdtempSync(path.join(tmpdir(), 'failure-audit-'))
const corpusModule = new URL('./failure-corpus.mjs', import.meta.url).href
const children = new Set()
async function runChild(script, args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', text => { stderr += text })
  const [code] = await once(child, 'exit')
  children.delete(child)
  assert.equal(code, 0, stderr)
}
try {
  const unreadable = path.join(root, 'unreadable')
  const corpus = makeFailureCorpus({ dir: unreadable })
  const saved = corpus.record({ task: 'fixture', failureClass: 'tool-error', description: 'controlled event' })
  assert.equal(corpus.retract({ id: saved.id, ts: 'wrong-timestamp', reason: 'fixture' }).ok, false)
  fs.mkdirSync(path.join(unreadable, 'records-unreadable.jsonl'))
  for (const result of [corpus.query(), corpus.stats()]) {
    assert.equal(result.incomplete, true)
    assert.deepEqual(result.skippedShards.map(shard => shard.file), ['records-unreadable.jsonl'])
    assert.ok(!result.filesScanned.includes('records-unreadable.jsonl'))
  }
  assert.equal(corpus.retract({ id: saved.id, reason: 'fixture' }).incomplete, true)
  fs.rmdirSync(path.join(unreadable, 'records-unreadable.jsonl'))
  fs.mkdirSync(path.join(unreadable, 'recurrences.jsonl'))
  assert.equal(corpus.query().incomplete, true)
  assert.equal(corpus.stats().incomplete, true)
  fs.rmdirSync(path.join(unreadable, 'recurrences.jsonl'))
  const before = corpus.query().dataVersion
  const cached = corpus.query()
  cached.rows[0].description = 'caller mutation'
  assert.equal(corpus.query().rows[0].description, 'controlled event')
  const statsSnapshot = corpus.stats()
  statsSnapshot.byClass['tool-error'] = 999
  assert.equal(corpus.stats().byClass['tool-error'], 1)
  fs.appendFileSync(path.join(unreadable, 'records.jsonl'), '{malformed\n')
  assert.equal(corpus.query().incomplete, true)
  assert.notEqual(corpus.query().dataVersion, before)

  const shared = path.join(root, 'concurrent')
  const script = `import {makeFailureCorpus} from ${JSON.stringify(corpusModule)}; import {setTimeout as delay} from 'node:timers/promises';
    const corpus=makeFailureCorpus({dir:process.argv[1],maxBytes:700}); const worker=Number(process.argv[2]);
    async function apply(action){for(let attempt=0;;attempt++){try{return action()}catch(error){if(error.code!=='FILE_TRANSACTION_BUSY'||attempt>1000)throw error;await delay(2+Math.random()*8)}}}
    for(let index=0;index<40;index++){const row=await apply(()=>corpus.record({task:'worker-'+worker+'-'+index,failureClass:'tool-error',description:'fixture row'}));if(index%2===0)await apply(()=>corpus.retract({id:row.id,ts:row.ts,reason:'fixture retraction'}));}`
  await Promise.all(Array.from({ length: 4 }, (_, worker) => runChild(script, [shared, String(worker)])))
  const combined = makeFailureCorpus({ dir: shared })
  assert.equal(combined.query({ includeRetracted: true, limit: 500 }).total, 160)
  assert.equal(combined.query({ limit: 500 }).total, 80)
  assert.equal(combined.stats().retracted, 80)
  assert.equal(combined.query().incomplete, false)
  assert.ok(combined.query().filesScanned.length > 2)

  const dedupeDir = path.join(root, 'dedupe')
  const dedupeScript = `import {makeFailureCorpus} from ${JSON.stringify(corpusModule)}; import {setTimeout as delay} from 'node:timers/promises';
    const corpus=makeFailureCorpus({dir:process.argv[1]});for(let index=0;index<25;index++){for(let attempt=0;;attempt++){try{corpus.record({task:'shared',failureClass:'tool-error',description:'same fixture',dedupe:true});break}catch(error){if(error.code!=='FILE_TRANSACTION_BUSY'||attempt>1000)throw error;await delay(2+Math.random()*8)}}}`
  await Promise.all(Array.from({ length: 4 }, () => runChild(dedupeScript, [dedupeDir])))
  const deduped = makeFailureCorpus({ dir: dedupeDir }).stats()
  assert.equal(deduped.totalAllShards, 1)
  assert.equal(deduped.recurrences, 99)
  const timeDir = path.join(root, 'time-window')
  fs.mkdirSync(timeDir)
  fs.writeFileSync(path.join(timeDir, 'records.jsonl'), JSON.stringify({ id: 'old', ts: new Date(1000).toISOString(), task: 'fixture', failureClass: 'tool-error', description: 'fixture' }) + '\n')
  const timed = makeFailureCorpus({ dir: timeDir })
  const realNow = Date.now
  try {
    Date.now = () => 1000 + 7 * 86400000
    assert.equal(timed.stats().last7d, 1)
    Date.now = () => 1001 + 7 * 86400000
    assert.equal(timed.stats().last7d, 0)
    Date.now = () => 1001 + 30 * 86400000
    assert.equal(timed.stats().last30d, 0)
    Date.now = () => 1000
    assert.equal(timed.stats().last7d, 1)
  } finally { Date.now = realNow }
  console.log('PASS failure audit: unreadable/corrupt completeness, retract refusal, cache invalidation/ownership, concurrent rotation/retract/dedupe')
} finally {
  for (const child of children) { child.kill(); await once(child, 'exit') }
  fs.rmSync(root, { recursive: true, force: true })
}
