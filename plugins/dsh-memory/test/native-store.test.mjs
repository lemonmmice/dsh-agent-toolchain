import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { VectorStore } from '../lib/store.mjs'
import { EmbedProvider, similarity } from '../lib/embed-provider.mjs'
import { DshMemory } from '../lib/memory.mjs'

const dir = fs.mkdtempSync(path.join(tmpdir(), 'memory-native-'))
let child
function parity(store, queries) {
  const rows = JSON.parse('[' + fs.readFileSync(store.file, 'utf8').trim().split('\n').join(',') + ']')
  for (const query of queries) for (const k of [0, 1, 5, 20, 500, -1, 2.8, Infinity, NaN]) {
    const expected = rows.map(r => ({ ...r, score: similarity(query, r.vector) })).sort((a,b) => b.score-a.score).slice(0,k)
    const actual = store.search(query,k)
    assert.deepEqual(actual.map(r=>r.id),expected.map(r=>r.id), 'IDs/rank match JS reference')
    for (let i=0;i<actual.length;i++) {
      const a=actual[i].score,b=expected[i].score
      assert.ok(Object.is(a,b)||Math.abs(a-b)<1e-12, `score mismatch ${a} != ${b}`)
      assert.deepEqual(actual[i].meta,expected[i].meta)
    }
  }
}
try {
  let seed=1234567
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1}
  const dense = new VectorStore(dir,'dense')
  dense.beginBatch()
  for(let i=0;i<150;i++)dense.upsert('r'+i,Array.from({length:32},next),{i})
  dense.upsert('tie-first',Array(32).fill(1));dense.upsert('tie-second',Array(32).fill(1));dense.upsert('zero',Array(32).fill(0))
  dense.endBatch()
  parity(dense,[Array(32).fill(1),Array(32).fill(0),Array.from({length:32},next)])
  // Unequal dimensions/non-numeric legacy representations preserve JS NaN sorting.
  const malformed = new VectorStore(dir,'dimensions')
  fs.writeFileSync(malformed.file,[{id:'short',vector:[1],meta:{}},{id:'nulls',vector:[null,1],meta:{}},{id:'ok',vector:[0,1],meta:{}}].map(JSON.stringify).join('\n')+'\n')
  parity(malformed,[[1,2],[0,1,2],[]])
  const duplicate=new VectorStore(dir,'duplicates')
  fs.writeFileSync(duplicate.file,[{id:'same',vector:[1,0],meta:{first:true}},{id:'same',vector:[0,1],meta:{second:true}}].map(JSON.stringify).join('\n')+'\n')
  duplicate.upsert('same',[1,1],{updated:true})
  assert.equal(duplicate.count(),2,'legacy duplicate IDs retain first-match upsert semantics')
  parity(duplicate,[[1,0]])
  duplicate.remove('same');assert.equal(duplicate.count(),0)

  const embed = new EmbedProvider({apiKey:null}), sparse = new VectorStore(dir,'sparse')
  for(const [id,text] of [['a','中文😀 alpha'],['b','完全不同 beta'],['c','中文😀 alpha']])sparse.upsert(id,await embed.embed(text),{text})
  const q=await embed.embed('中文😀 alpha')
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(sparse.file,'utf8').split('\n')[0]).vector.sparse).length>0)
  const reopen=new VectorStore(dir,'sparse')
  parity(reopen,[q,await embed.embed('beta'),await embed.embed('')])
  assert.equal(reopen.search(q,1)[0].id,'a')
  assert.ok(reopen.search(q,1)[0].score>0.99)
  const unicode = new VectorStore(dir,'unicode')
  unicode.upsert('prefix:\ud800',[1],{text:'\ud800中文'});assert.equal(unicode.countPrefix('prefix:\ud800'),1)
  assert.equal(unicode.search([1])[0].meta.text,'\ud800中文')
  const old = fs.readFileSync(unicode.file,'utf8')
  fs.writeFileSync(unicode.file,old.replace('中文','文字'))
  assert.equal(unicode.search([1])[0].meta.text,'\ud800文字')
  fs.writeFileSync(unicode.file,'not-json\n')
  assert.throws(()=>unicode.search([1]),SyntaxError,'corruption is not an empty successful index')
  assert.equal(fs.readFileSync(unicode.file,'utf8'),'not-json\n')

  const a=new VectorStore(dir,'conflict'),b=new VectorStore(dir,'conflict')
  a.upsert('base',[1]);a.beginBatch();a.upsert('pending',[1]);b.upsert('other',[1])
  assert.throws(()=>a.endBatch(),/MEMORY_STORE_CHANGED/)
  a.abortBatch();assert.deepEqual(a.ids(),['base','other'])
  const good=fs.readFileSync(a.file,'utf8'),blocker=a.file+'.tmp-'+process.pid
  fs.mkdirSync(blocker)
  assert.throws(()=>a.upsert('failed',[1]))
  assert.equal(fs.readFileSync(a.file,'utf8'),good);assert.equal(a.count(),2)
  fs.rmdirSync(blocker)
  a.upsert('success',[1]);assert.equal(fs.readFileSync(a.file+'.bak','utf8'),good)
  assert.throws(()=>a.upsert('circular',[1],{toJSON(){throw Error('serialization-failed')}}),/serialization-failed/)
  assert.equal(a.count(),3)

  // Kill only this test's child after it acknowledged its unflushed batch.
  const childScript=`import{VectorStore}from ${JSON.stringify(new URL('../lib/store.mjs',import.meta.url).href)};const s=new VectorStore(process.argv[1],'crash');s.upsert('committed',[1]);s.beginBatch();s.upsert('pending',[1]);process.stdout.write('ready');setInterval(()=>{},1000)`
  child=spawn(process.execPath,['--input-type=module','-e',childScript,dir],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  await once(child.stdout,'data',{signal:AbortSignal.timeout(10000)})
  const exited=once(child,'exit');child.kill();await exited
  assert.deepEqual(new VectorStore(dir,'crash').ids(),['committed'])

  // A failed or budget-aborted reindex retains the previous complete file.
  const ws=path.join(dir,'workspace');fs.mkdirSync(ws)
  const file=path.join(ws,'document.md');fs.writeFileSync(file,'new document content')
  const mem=new DshMemory({dataDir:path.join(dir,'memory'),embedProvider:{embed:async()=>{throw Error('intentional embed failure')},label:'fake',mode:'local'}})
  const prefix='file:'+file+':'
  mem.store.upsert(prefix+'old#0',[1],{text:'previous complete snapshot'})
  const result=await mem.indexFile(file,'document.md',ws)
  assert.ok(result.failed);assert.equal(mem.store.countPrefix(prefix),1)
  mem.embed={embed:async()=>[1],label:'fake',mode:'local'}
  assert.ok((await mem.indexFile(file,'document.md',ws,{deadline:0})).deferred)
  assert.equal(mem.store.ids()[0],prefix+'old#0')
  await mem.indexFile(file,'document.md',ws)
  assert.ok(mem.store.ids().every(id=>!id.includes('old#')))
  // Even flushEvery=1 cannot publish the first chunk of an unfinished file.
  const previousRows=mem.store._read()
  fs.writeFileSync(file,'multi-chunk content '.repeat(900))
  let embedded=0
  mem.embed={embed:async()=>{
    assert.deepEqual(new VectorStore(path.dirname(mem.store.file))._read(),previousRows)
    if(++embedded===2)throw Error('second chunk failed')
    return [1]
  },label:'fake',mode:'local'}
  mem.store.beginBatch({flushEvery:1})
  const incomplete=await mem.indexFile(file,'document.md',ws,{concurrency:1})
  assert.ok(incomplete.failed);assert.equal(embedded,2)
  mem.store.endBatch()
  assert.deepEqual(mem.store._read(),previousRows)
  mem.embed={embed:async()=>{fs.appendFileSync(file,'edited-during-embedding');return [1]},label:'fake',mode:'local'}
  const changedSource=await mem.indexFile(file,'document.md',ws,{concurrency:1})
  assert.match(changedSource.failed,/source file changed/)
  assert.deepEqual(mem.store._read(),previousRows)
  mem.embed={embed:async()=>[1],label:'fake',mode:'local'}
  const finalBlock=mem.store.file+'.tmp-'+process.pid;fs.mkdirSync(finalBlock)
  fs.writeFileSync(file,'changed again with a different size')
  await assert.rejects(mem.indexWorkspace(ws),/./,'final flush failure must reach the caller')
  assert.ok(new VectorStore(path.dirname(mem.store.file))._read().every(r=>r.meta.text==='new document content'))
  fs.rmdirSync(finalBlock)
  // Deploy only a minimal memory plugin into a temporary profile. Missing
  // binaries stop before copying; a full deployment works with spaces in paths.
  const repo=fileURLToPath(new URL('../../../',import.meta.url))
  const source=path.join(dir,'deploy-source'),profile=path.join(dir,'profile with spaces')
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});fs.mkdirSync(path.join(source,'plugins','dsh-memory','lib'),{recursive:true});fs.mkdirSync(profile)
  fs.copyFileSync(path.join(repo,'scripts','deploy-plugins.mjs'),path.join(source,'scripts','deploy-plugins.mjs'))
  fs.copyFileSync(path.join(repo,'plugins','dsh-memory','lib','store.mjs'),path.join(source,'plugins','dsh-memory','lib','store.mjs'))
  const deploy=()=>spawnSync(process.execPath,[path.join(source,'scripts','deploy-plugins.mjs'),'--profile',profile,'--only','dsh-memory'],{encoding:'utf8',windowsHide:true,timeout:20000})
  assert.equal(deploy().status,2)
  assert.equal(fs.existsSync(path.join(profile,'plugins')),false)
  fs.cpSync(path.join(repo,'plugins','dsh-memory','bin'),path.join(source,'plugins','dsh-memory','bin'),{recursive:true})
  const deployed=deploy();assert.equal(deployed.status,0,deployed.stderr)
  const probe=`import{pathToFileURL}from'node:url';const{VectorStore}=await import(pathToFileURL(process.argv[1]));const s=new VectorStore(process.argv[2]);s.upsert('ok',[1]);if(s.search([1])[0].id!=='ok')process.exit(1)`
  const resultDeploy=spawnSync(process.execPath,['--input-type=module','-e',probe,path.join(profile,'plugins','dsh-memory','lib','store.mjs'),path.join(dir,'deployed-data')],{
    cwd:profile,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,DSH_MEMORY_STORE_NATIVE:''},
  })
  assert.equal(resultDeploy.status,0,resultDeploy.stderr)
  console.log('PASS memory native: dense/sparse parity, Unicode, reload/corruption, conflict, backups, crash durability, complete-file reindex, deployment')
} finally {
  if(child?.exitCode===null)child.kill()
  if(path.dirname(path.resolve(dir))!==path.resolve(tmpdir()))throw Error('Unexpected cleanup path')
  fs.rmSync(dir,{recursive:true,force:true})
}
