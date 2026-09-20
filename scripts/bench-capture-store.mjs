// Compare this checkout with a pre-migration capture-store.mjs from Git.
// Only synthetic records under a fresh temporary directory are read/written.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ref = process.argv[2]
if (!ref) throw new Error('Usage: node scripts/bench-capture-store.mjs <pre-migration-git-ref>')
const baseline = spawnSync('git', ['show', `${ref}:lib/capture-store.mjs`], {
  cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
})
if (baseline.status !== 0) throw new Error('Cannot read baseline: ' + baseline.stderr)
if (baseline.stdout.includes('capture-storage.mjs')) throw new Error('Choose a Git revision before the Rust capture-store migration')
const directory = mkdtempSync(join(tmpdir(), 'capture-bench-'))
try {
  const baselineFile = join(directory, 'baseline.mjs')
  const source = baseline.stdout.replace(/from '(\.\.?\/[^']+)'/g, (_, specifier) =>
    'from ' + JSON.stringify(new URL(specifier, new URL('../lib/capture-store.mjs', import.meta.url)).href))
  writeFileSync(baselineFile, source, 'utf8')
  const runner = join(directory, 'run.mjs')
  writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const dir=process.argv[3];fs.mkdirSync(dir);
process.env.DSH_API_CAPTURE_STORE=dir;
process.env.DSH_NO_ENV_FALLBACK='1';
process.env.DSH_API_CAPTURE_MAX_BYTES=String(128*1024*1024);
const now=Date.now(),d=new Date(now),pad=n=>String(n).padStart(2,'0');
const file=path.join(dir,'records-'+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'.jsonl');
const fd=fs.openSync(file,'w');
for(let i=0;i<10000;i++)fs.writeSync(fd,JSON.stringify({id:'r'+i,ts:now-i,method:'GET',url:'https://example.invalid/'+i,status:200,runId:'run-'+i%50,resBody:'x'.repeat(4096)})+'\\n');
fs.closeSync(fd);
const store=await import(process.argv[2]);
const time=fn=>{const start=performance.now();fn();return +(performance.now()-start).toFixed(3)};
const query={runId:'run-0',limit:50};
const coldQueryMs=time(()=>store.queryPage(query));
const cachedQueryMs=Array.from({length:9},()=>time(()=>store.queryPage(query)));
const appendMs=Array.from({length:9},(_,i)=>time(()=>store.appendRecords([{id:'added-'+i,ts:now+i+1,method:'GET',url:'https://example.invalid/added',resBody:'x'.repeat(4096)}])));
if(store.readAll().length!==10009)throw Error('unexpected total');
console.log(JSON.stringify({seedRecords:10000,storeMiB:+(fs.statSync(file).size/1048576).toFixed(2),coldQueryMs,cachedQueryMs,appendMs}));
`, 'utf8')
  const results = { baselineRef: ref, node: process.version, platform: process.platform, arch: process.arch }
  for (const [name, url] of [['baseline', pathToFileURL(baselineFile).href], ['rust', new URL('../lib/capture-store.mjs', import.meta.url).href]]) {
    const run = spawnSync(process.execPath, [runner, url, join(directory, name)], {
      encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    })
    if (run.status !== 0) throw new Error(name + ': ' + (run.stderr || String(run.error)))
    const data = JSON.parse(run.stdout)
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    results[name] = { ...data, medianAppendMs: median(data.appendMs), medianCachedQueryMs: median(data.cachedQueryMs) }
  }
  results.appendSpeedup = +(results.baseline.medianAppendMs / results.rust.medianAppendMs).toFixed(1)
  console.log(JSON.stringify(results, null, 2))
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected benchmark cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
