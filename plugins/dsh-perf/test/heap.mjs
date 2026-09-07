import { makePerf } from '../lib/perf.mjs'
import { join } from 'node:path'
// 用法: node heap.mjs <dump.abs.path> [topN]
const p = makePerf({ scriptsDir: join(import.meta.dirname, '..', 'scripts') })
const dump = process.argv[2] || process.env.DSH_PERF_DUMP || ''
if (!dump || !dump.includes('.dmp')) { console.error('usage: node heap.mjs <dump.abs.path> [topN]'); process.exit(1) }
const topN = Number(process.argv[3] || 15)
const r = await p.heapStats(dump, topN)
console.log(JSON.stringify(r, null, 1).slice(0, 2500))
