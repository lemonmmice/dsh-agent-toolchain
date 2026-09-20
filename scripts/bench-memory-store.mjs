// Synthetic benchmark: no credentials, embeddings API, or live memory store.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)), ref = process.argv[2]
if (!ref) throw new Error('Usage: node scripts/bench-memory-store.mjs <pre-migration-git-ref>')
const baseline = spawnSync('git', ['show', `${ref}:plugins/dsh-memory/lib/store.mjs`], { cwd: root, encoding: 'utf8', windowsHide: true })
if (baseline.status !== 0 || baseline.stdout.includes('memory-store.node')) throw new Error('Choose a valid pre-migration revision')
const directory = mkdtempSync(join(tmpdir(), 'memory-bench-'))
try {
  const baselineFile = join(directory, 'baseline.mjs')
  const moduleUrl = new URL('../plugins/dsh-memory/lib/store.mjs', import.meta.url)
  writeFileSync(baselineFile, baseline.stdout.replace(/from ["'](\.\.?\/[^"']+)["']/g, (_, specifier) =>
    'from ' + JSON.stringify(new URL(specifier, moduleUrl).href)), 'utf8')
  const runner = join(directory, 'runner.mjs')
  writeFileSync(runner, `
import fs from 'node:fs';import path from 'node:path';import{performance}from'node:perf_hooks';
const{VectorStore}=await import(process.argv[2]);const dir=process.argv[3];fs.mkdirSync(dir);
const file=path.join(dir,'dense.jsonl');let seed=123456789;
const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const fd=fs.openSync(file,'w');
for(let i=0;i<3000;i++)fs.writeSync(fd,JSON.stringify({id:'r'+i,vector:Array.from({length:1024},next),meta:{text:'synthetic vector',file:'synthetic.md'},updatedAt:1})+'\\n');
fs.closeSync(fd);const query=Array.from({length:1024},next);const store=new VectorStore(dir,'dense');
const time=fn=>{const start=performance.now();const result=fn();return{ms:+(performance.now()-start).toFixed(3),result}};
const cold=time(()=>store.search(query,5));
const warm=Array.from({length:9},()=>time(()=>store.search(query,5)).ms);
const noOp=time(()=>{store.beginBatch();store.endBatch()}).ms;
const batch=time(()=>{store.beginBatch({flushEvery:200});for(let i=0;i<200;i++)store.upsert('added'+i,query,{text:'synthetic'});store.endBatch()}).ms;
const sorted=[...warm].sort((a,b)=>a-b);
console.log(JSON.stringify({rows:3000,dimensions:1024,coldSearchMs:cold.ms,warmSearchMs:warm,medianWarmMs:sorted[4],noOpBatchMs:noOp,batch200Ms:batch,topIds:cold.result.map(r=>r.id),topScores:cold.result.map(r=>r.score)}));
`, 'utf8')
  const results = { baselineRef: ref, node: process.version, platform: process.platform, arch: process.arch }
  for (const [name, url] of [['baseline',pathToFileURL(baselineFile).href],['rust',moduleUrl.href]]) {
    const run=spawnSync(process.execPath,[runner,url,join(directory,name)],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024})
    if(run.status!==0)throw Error(name+': '+run.stderr)
    results[name]=JSON.parse(run.stdout)
  }
  if(JSON.stringify(results.baseline.topIds)!==JSON.stringify(results.rust.topIds))throw Error('Benchmark rankings differ')
  results.warmSearchSpeedup=+(results.baseline.medianWarmMs/results.rust.medianWarmMs).toFixed(1)
  console.log(JSON.stringify(results,null,2))
} finally {
  if(dirname(resolve(directory))!==resolve(tmpdir()))throw Error('Unexpected benchmark cleanup path')
  rmSync(directory,{recursive:true,force:true})
}
