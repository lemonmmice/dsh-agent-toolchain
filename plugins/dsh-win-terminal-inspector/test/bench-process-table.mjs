// Read-only comparison including process launch + collection + JSON parsing.
import { performance } from 'node:perf_hooks'
import { defaultTableExec, parseTable } from '../lib/inspector.js'
import { powershellTable } from './powershell-table.mjs'

if (process.platform !== 'win32') throw new Error('Windows is required')
const count = Number(process.argv[2] || 7)
if (!Number.isInteger(count) || count < 3 || count > 30) throw new Error('Sample count must be between 3 and 30')
const native = [], powershell = []
let processes = 0
function measure(exec, samples) {
  const start = performance.now()
  const rows = parseTable(exec())
  samples.push(performance.now() - start)
  processes = rows.length
  if (!rows.some(row => row.pid === process.pid && row.started)) throw new Error('Current process missing from snapshot')
}
// Alternate order to avoid always giving one backend the first sample.
for (let i = 0; i < count; i++) {
  if (i % 2 === 0) { measure(defaultTableExec, native); measure(powershellTable, powershell) }
  else { measure(powershellTable, powershell); measure(defaultTableExec, native) }
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    minMs: +sorted[0].toFixed(2), maxMs: +sorted.at(-1).toFixed(2),
    samplesMs: samples.map(value => +value.toFixed(2)),
  }
}
const n = summary(native), p = summary(powershell)
console.log(JSON.stringify({ node: process.version, arch: process.arch, samples: count, processes,
  native: n, powershell: p, medianSpeedup: +(p.medianMs / n.medianMs).toFixed(1),
}, null, 2))
