import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { splitIntoChunks } from '../lib/chunker.mjs'
import { KvMemory } from '../lib/kv.mjs'
import { DshMemory } from '../lib/memory.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'

process.env.DSH_TEST = '1'
process.env.DSH_NO_ENV_FALLBACK = '1'
const root = fs.mkdtempSync(path.join(tmpdir(), 'memory-audit-'))
const kvModule = new URL('../lib/kv.mjs', import.meta.url).href
const lockModule = new URL('../../../lib/file-transaction.mjs', import.meta.url).href
const children = new Set()
const originalFetch = globalThis.fetch
function launch(script, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
async function complete(child) {
  let stderr = ''
  child.stderr.on('data', text => { stderr += text })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, stderr)
}
try {
  for (const text of ['short\n\n' + 'x'.repeat(20000), 'x'.repeat(20000), 'a\n\n' + 'z'.repeat(900) + '\n\nb']) {
    const chunks = splitIntoChunks(text)
    assert.ok(chunks.every(chunk => chunk.text.length <= 800))
    assert.ok(chunks.length > 1)
  }
  assert.throws(() => splitIntoChunks('x', { maxChars: 1, overlap: 1 }), RangeError)

  const kvDir = path.join(root, 'kv')
  const kv = new KvMemory(kvDir)
  for (let index = 0; index < 100; index++) kv.save('remove-' + index, 'before')
  const script = `import {KvMemory} from ${JSON.stringify(kvModule)}; import {setTimeout as delay} from 'node:timers/promises';
    const memory=new KvMemory(process.argv[1]); const worker=Number(process.argv[2]);
    async function apply(action){for(let attempt=0;;attempt++){try{return action()}catch(error){if(error.code!=='FILE_TRANSACTION_BUSY'||attempt>1000)throw error;if(error.writesApplied!==false)throw Error('unsafe retry');await delay(2+Math.random()*8)}}}
    for(let index=0;index<50;index++){await apply(()=>memory.save('worker-'+worker+'-'+index,'value'));if(index<25)await apply(()=>memory.forget('remove-'+(worker*25+index)));}`
  await Promise.all(Array.from({ length: 4 }, (_, worker) => complete(launch(script, [kvDir, String(worker)]))))
  assert.equal(kv.all().length, 200)
  assert.ok(kv.all().every(row => row.key.startsWith('worker-')))
  assert.deepEqual(kv.forget('missing'), { deleted: 0 })
  assert.deepEqual(kv.forget('worker-0-0'), { deleted: 1 })
  const snapshot = kv.get('worker-0-1')
  snapshot.value = 'caller mutation'
  assert.equal(kv.get('worker-0-1').value, 'value')

  const blocked = launch(`import {withFileTransaction} from ${JSON.stringify(lockModule)}; withFileTransaction(process.argv[1],()=>{process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)});`, [kv.file])
  await once(blocked.stdout, 'data')
  const before = Date.now()
  assert.throws(() => kv.save('blocked', 'no'), error => error.code === 'FILE_TRANSACTION_BUSY' && error.writesApplied === false)
  assert.ok(Date.now() - before < 1000)
  blocked.kill()
  await once(blocked, 'exit')
  kv.save('after-crash', 'yes')
  assert.equal(kv.get('blocked'), null)
  assert.equal(kv.get('after-crash').value, 'yes')

  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  const file = path.join(workspace, 'fixture.md')
  fs.writeFileSync(file, 'first document')
  const provider = { mode: 'fixture', model: 'one', dimensions: 2, embed: async () => [1, 0] }
  const memory = new DshMemory({ dataDir: path.join(root, 'data'), embedProvider: provider })
  assert.equal((await memory.indexWorkspace(workspace)).indexed, 1)
  assert.equal((await memory.indexWorkspace(workspace)).skipped, 1)
  provider.model = 'two'
  assert.equal((await memory.indexWorkspace(workspace)).indexed, 1)
  provider.dimensions = 3
  assert.equal((await memory.indexWorkspace(workspace)).indexed, 1)
  const prior = fs.statSync(file)
  fs.writeFileSync(file, 'other document')
  fs.utimesSync(file, prior.atime, prior.mtime)
  assert.equal((await memory.indexWorkspace(workspace)).indexed, 1)
  const rows = memory.store._read()
  const row = rows[0]
  row.id = row.id.replace(/~[^#]+/, '~old-chunker')
  row.meta.chunkerVersion = 'paragraph/1'
  memory.store.replacePrefix('file:' + file + ':', [row])
  assert.equal((await memory.indexWorkspace(workspace)).indexed, 1)
  const hit = (await memory.searchDetailed('document')).hits[0]
  assert.equal(hit.meta.root, workspace)
  assert.equal(hit.meta.truncated, false)
  assert.equal(hit.meta.contentHash.length, 64)

  let aborted = false
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true })
  })
  const remote = new EmbedProvider({ apiKey: 'fixture-key' })
  const deadlineStart = Date.now()
  await assert.rejects(remote.embed('fixture', { deadline: Date.now() + 60 }), /60ms|超时/)
  assert.ok(aborted && Date.now() - deadlineStart < 1000)
  const remoteMemory = new DshMemory({ dataDir: path.join(root, 'remote'), embedProvider: remote })
  const budgetStart = Date.now()
  const budgetResult = await remoteMemory.indexWorkspace(workspace, { budgetMs: 1000 })
  assert.equal(budgetResult.stoppedBy, 'budget')
  assert.equal(budgetResult.deferredFiles, 1)
  assert.equal(remoteMemory.store.count(), 0)
  assert.ok(Date.now() - budgetStart < 2000)
  console.log('PASS memory audit: chunk bounds, cross-process save/forget, busy/crash recovery, cache ownership, content/model/dimension/chunker invalidation, remote deadline and source metadata')
} finally {
  globalThis.fetch = originalFetch
  for (const child of children) { child.kill(); await once(child, 'exit') }
  fs.rmSync(root, { recursive: true, force: true })
}
