import { makePerf } from '../lib/perf.mjs'
import { join } from 'node:path'
// 用法: node analyze.mjs <dump.abs.path>
const p = makePerf({ scriptsDir: join(import.meta.dirname, '..', 'scripts') })
const dump = process.argv[2] || process.env.DSH_PERF_DUMP || ''
if (!dump || !dump.includes('.dmp')) { console.error('usage: node analyze.mjs <dump.abs.path>'); process.exit(1) }
const r = await p.analyzeDump(dump)
console.log(JSON.stringify(r, null, 1).slice(0, 2000))
