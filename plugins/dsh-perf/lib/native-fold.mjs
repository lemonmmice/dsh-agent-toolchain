import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let Reader
export function openTrace(path) {
  if (!Reader) {
    const file = process.env.DSH_TRACE_FOLD_NATIVE || fileURLToPath(new URL(
      `../bin/${process.platform}-${process.arch}/trace-fold.node`, import.meta.url))
    try { Reader = require(file).TraceReader }
    catch (cause) { throw new Error('Trace native module unavailable. Run npm run build:trace-fold and deploy the dsh-perf bin directory.', { cause }) }
  }
  return new Reader(path)
}

// Only matching event rows cross Node-API. A batch is bounded by 4096 matched
// rows or 8 MiB scanned (plus the last line), so unrelated trace data stays native.
export async function forEachEvent(reader, event, onLine) {
  for (;;) {
    const batch = await reader.nextEvents(event)
    for (const line of batch.lines) onLine(line)
    if (batch.done) return
  }
}

export async function foldStacks(reader, weights, tidToPid, jitMap, frameMode, recursion) {
  const values = new Float64Array(weights.size * 3)
  let i = 0
  for (const [key, weight] of weights) {
    const [ts, tid] = key.split('\t').map(Number)
    values[i++] = ts; values[i++] = tid; values[i++] = weight
  }
  const buckets = []
  for (const pid of new Set(tidToPid.values())) {
    const methods = jitMap?.get(pid)
    if (methods) buckets.push({ pid, methods: methods.map(m => ({ start: String(m.start), end: String(m.end), name: m.name })) })
  }
  const result = await reader.fold(values, [...tidToPid].map(([tid, pid]) => ({ tid, pid })), buckets,
    frameMode === 'symbols', recursion)
  return { folded: new Map(result.entries.map(e => [e.stack, e.weight])), stacksFolded: result.stacks,
    jitAttempted: result.attempted, jitResolved: result.resolved }
}
