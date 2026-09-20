import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as native from '../lib/flame.mjs'
import * as reference from './reference-flame.mjs'
import { openTrace, forEachEvent, foldStacks } from '../lib/native-fold.mjs'
import { allocation, writeTrace } from './trace-fixture.mjs'

const dir = fs.mkdtempSync(path.join(tmpdir(), 'trace-native-'))
const snapshot = r => ({ ...r, folded: [...r.folded] })
const jitMap = new Map([
  ['42', [{ start: 0x10000000000000001n, end: 0x10000000000000005n, name: 'App.Method<A,B>' },
    { start: 0x10000000000000005n, end: 0x10000000000000009n, name: 'App.Next' }]],
  ['99', [{ start: 0x10000000000000001n, end: 0x10000000000000009n, name: 'Other.Method' }]],
])
const stack = (ts, tid, no, addr, name) => `Stack, ${ts}, ${tid}, ${no}, ${addr}, ${name}`
const options = () => [
  {}, { processRe: /Client/, jitMap }, { processRe: /(?<=Client)\.exe/, frameMode: 'symbols', jitMap },
  { processRe: /Client/g, frameMode: 'symbols', foldRecursion: false, jitMap },
  { processRe: /^Client/y, jitMap }, { processRe: /missing/ }, { pidSet: new Set(), jitMap },
  { pidSet: new Set(['42']), processRe: /never/, frameMode: 'symbols', jitMap },
]
async function compare(file) {
  for (const fn of ['foldDumperCsv', 'foldAllocCsv']) for (const option of options()) {
    const clone = () => ({ ...option, ...(option.processRe ? { processRe: new RegExp(option.processRe.source, option.processRe.flags) } : {}) })
    const leftOpts = clone(), rightOpts = clone()
    const expected = await reference[fn](file, leftOpts)
    const actual = await native[fn](file, rightOpts)
    assert.deepEqual(snapshot(actual), snapshot(expected), fn + ' result matches reference')
    if (leftOpts.processRe) assert.equal(rightOpts.processRe.lastIndex, leftOpts.processRe.lastIndex)
    assert.equal(native.foldedToText(actual.folded), native.foldedToText(expected.folded))
    assert.deepEqual(native.buildTree(actual.folded), native.buildTree(expected.folded))
  }
}
try {
  const file = path.join(dir, 'edge cases.csv')
  const lines = [
    '\ufeffSampledProfile, TimeStamp, Process, ThreadID',
    'SampledProfile, 10, Client.exe (42), 7', 'SampledProfile, 10, Client.exe (42), 7',
    allocation(10, 'Client.exe (42)', 7, '0x20000000000001', 'Generic`2[A,B]'),
    allocation(10, 'Client.exe (42)', 7, '0x20', 'Other.Type'),
    stack(10,7,1,'0x10000000000000001','"Unknown"!0x10000000000000001'),
    stack(10,7,2,'0x0','module.dll!Function<A,B>'), stack(10,7,3,'0x0','module.dll!Function<A,B>'),
    stack(10,7,1,'0x0','duplicate-wait.dll!Wait'),
    'SampledProfileNmi, 11, Client.exe (42), 7', stack(11,7,1,'0x0','nmi.dll!Ignore'),
    'CSwitch, 12, Client.exe (42), 7', stack(12,7,1,'0x0','wait.dll!Ignore'),
    'SampledProfile, 20, Other.exe (99), 8', allocation(20, '"Unknown" (99)',8,'invalid','中文😀'),
    stack(20,8,1,'0x10000000000000005','Unknown!0x10000000000000005'),
    stack(20,8,2,'0x0','base.dll!0xabcd'),
    'SampledProfile, 30, Client.exe (42), 9', allocation(30,'Client.exe (42)',9,'0x0','Zero'),
    stack(30,9,1,'bad-address','"Unknown"!0x111'),stack(30,9,2,'0x0','!'),
    'SampledProfile, 40, Client.exe (42), 9', allocation(40,'Client.exe (42)',9,'0x40','EndBoundary'),
    stack(40,9,1,'0x10000000000000009','Unknown!0x10000000000000009'),
    'SampledProfile, +50.9suffix, Client.exe (42), 10tail', allocation(50,'Client.exe (42)',10,'0x20'),
    stack('50.7',10,1,'0x0','中文😀!函数,参数'),
    'SampledProfile, 9007199254740993, Client.exe (42), -0',
    stack('9007199254740993','+0',1,'0x0','bigtime.dll!ExactJsNumber'),
    'SampledProfile, NaN, Client.exe (42), 7', stack('bad',7,1,'0','bad'),
    'Stack, 60, 7, 1', 'SampledProfile, 60, Client.exe (42), 7',
    'SampledProfile, 70, Client.exe (42), 7',
    stack(70,7,1,'0x1_0000000000000001','Unknown!0x10000000000000001'),
    'SampledProfile, 80, Client.exe (42), 7',
    stack(80,7,1,'0x+10000000000000001','Unknown!0x10000000000000001'),
  ]
  for (const newline of ['\n','\r\n','\r']) {
    fs.writeFileSync(file, lines.join(newline))
    await compare(file)
  }
  // Deterministic mixed stream with duplicate samples, non-target threads and
  // ties. Many stack keys intentionally have no corresponding CPU sample.
  let seed=1234;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
  const random=[]
  for(let i=0;i<300;i++) {
    const ts=i*10,tid=next()%6+1,proc=next()%3?'Client.exe (42)':'Other.exe (99)'
    if(next()%4)random.push(`SampledProfile, ${ts}, ${proc}, ${tid}`)
    if(next()%3)random.push(allocation(ts,proc,tid,'0x'+(next()%1000).toString(16),'T'+next()%7))
    for(let f=1,n=next()%7+1;f<=n;f++)random.push(stack(ts,tid,f,'0x0',`m${next()%4}.dll!f${next()%3}`))
    if(next()%3===0)random.push(stack(ts,tid,1,'0x0','duplicate!wait'))
  }
  fs.writeFileSync(file,random.join('\n'));await compare(file)
  fs.writeFileSync(file,'');await compare(file)
  await assert.rejects(native.foldDumperCsv(path.join(dir,'missing.csv')))
  await assert.rejects(native.foldDumperCsv(dir), /not a regular file|denied|拒绝访问/i)

  // One reader holds the same file across both passes and rejects mutations.
  fs.writeFileSync(file,lines.join('\n'))
  const reader=openTrace(file)
  await forEachEvent(reader,'SampledProfile',()=>{})
  fs.appendFileSync(file,'\nSampledProfile, 100, Client.exe (42), 7\n')
  await assert.rejects(foldStacks(reader,new Map(),new Map(),null,'module',true),/TRACE_CHANGED/)
  reader.close()
  const closed=openTrace(file);closed.close()
  await assert.rejects(closed.nextEvents('SampledProfile'),/closed/)

  // Rust work runs off the JS thread; input files are never modified by analysis.
  const large=path.join(dir,'large.csv');writeTrace(large,8000)
  const before=fs.statSync(large);let ticks=0
  const timer=setInterval(()=>ticks++,5)
  let result
  try { result=await native.foldDumperCsv(large,{processRe:/Client/}) } finally { clearInterval(timer) }
  assert.equal(result.stacksFolded,6400);assert.ok(ticks>0,'JS timers run during analysis')
  assert.equal(fs.statSync(large).mtimeMs,before.mtimeMs)
  assert.equal(fs.statSync(large).size,before.size)
  const workerReader=openTrace(large),weights=new Map()
  await forEachEvent(workerReader,'SampledProfile',line=>{
    const p=line.split(',');if(p[2].includes('Client'))weights.set(Number(p[1])+'\t'+Number(p[3]),1)
  })
  ticks=0
  const foldingTimer=setInterval(()=>ticks++,5)
  try {
    assert.equal((await foldStacks(workerReader,weights,new Map(),null,'symbols',true)).stacksFolded,6400)
    assert.ok(ticks>0,'timers also run during native stack folding alone')
  } finally { clearInterval(foldingTimer);workerReader.close() }

  const repo=fileURLToPath(new URL('../../../',import.meta.url))
  const source=path.join(dir,'source'),profile=path.join(dir,'profile with spaces')
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});fs.mkdirSync(path.join(source,'plugins','dsh-perf','lib'),{recursive:true});fs.mkdirSync(profile)
  fs.copyFileSync(path.join(repo,'scripts','deploy-plugins.mjs'),path.join(source,'scripts','deploy-plugins.mjs'))
  for(const name of ['flame.mjs','native-fold.mjs'])fs.copyFileSync(path.join(repo,'plugins','dsh-perf','lib',name),path.join(source,'plugins','dsh-perf','lib',name))
  const deploy=()=>spawnSync(process.execPath,[path.join(source,'scripts','deploy-plugins.mjs'),'--profile',profile,'--only','dsh-perf'],{encoding:'utf8',windowsHide:true,timeout:20000})
  assert.equal(deploy().status,2)
  assert.equal(fs.existsSync(path.join(profile,'plugins')),false)
  fs.cpSync(path.join(repo,'plugins','dsh-perf','bin'),path.join(source,'plugins','dsh-perf','bin'),{recursive:true})
  const deployed=deploy();assert.equal(deployed.status,0,deployed.stderr)
  const probe=`import{pathToFileURL}from'node:url';const m=await import(pathToFileURL(process.argv[1]));const r=await m.foldDumperCsv(process.argv[2],{processRe:/Client/});if(r.stacksFolded!==6400)process.exit(1)`
  const run=spawnSync(process.execPath,['--input-type=module','-e',probe,path.join(profile,'plugins','dsh-perf','lib','flame.mjs'),large],{
    cwd:profile,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,DSH_TRACE_FOLD_NATIVE:''},
  });assert.equal(run.status,0,run.stderr)
  console.log('PASS trace native: CPU/allocation parity, filters, JIT, order, newline/empty/error handling, mutation detection, async work, deployment')
} finally {
  if(path.dirname(path.resolve(dir))!==path.resolve(tmpdir()))throw Error('Unexpected cleanup path')
  fs.rmSync(dir,{recursive:true,force:true})
}
