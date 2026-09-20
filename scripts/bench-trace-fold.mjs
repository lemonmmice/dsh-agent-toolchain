// Compares offline synthetic CPU/allocation CSVs with the frozen JS oracle.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { writeTrace } from '../plugins/dsh-perf/test/trace-fixture.mjs'
import * as baseline from '../plugins/dsh-perf/test/reference-flame.mjs'
import * as rust from '../plugins/dsh-perf/lib/flame.mjs'

const samples=Number(process.argv[2]||30000),runs=Number(process.argv[3]||5)
if(!Number.isInteger(samples)||samples<1000||samples>1000000||!Number.isInteger(runs)||runs<1||runs>15)throw Error('Usage: bench-trace-fold.mjs [samples 1000..1000000] [runs 1..15]')
const dir=fs.mkdtempSync(path.join(tmpdir(),'trace-bench-')),file=path.join(dir,'synthetic.csv')
const summary=times=>({medianMs:[...times].sort((a,b)=>a-b)[Math.floor(times.length/2)],samplesMs:times})
try {
  writeTrace(file,samples)
  const results={node:process.version,platform:process.platform,arch:process.arch,MiB:+(fs.statSync(file).size/1048576).toFixed(2),samples,runs}
  for(const fn of ['foldDumperCsv','foldAllocCsv']) {
    const timings={baseline:[],rust:[]}
    let reference
    for(let i=0;i<runs;i++)for(const name of (i%2?['rust','baseline']:['baseline','rust'])) {
      const start=performance.now()
      const result=await (name==='rust'?rust:baseline)[fn](file,{processRe:/Client/,pidSet:new Set(['42']),frameMode:'symbols'})
      timings[name].push(+(performance.now()-start).toFixed(2))
      const shaped={...result,folded:[...result.folded]}
      if(reference)assert.deepEqual(shaped,reference,'Every timed run must match the original JS result')
      else reference=shaped
    }
    results[fn]={baseline:summary(timings.baseline),rust:summary(timings.rust)}
    results[fn].speedup=+(results[fn].baseline.medianMs/results[fn].rust.medianMs).toFixed(2)
  }
  console.log(JSON.stringify(results,null,2))
} finally {
  if(path.dirname(path.resolve(dir))!==path.resolve(tmpdir()))throw Error('Unexpected benchmark cleanup path')
  fs.rmSync(dir,{recursive:true,force:true})
}
