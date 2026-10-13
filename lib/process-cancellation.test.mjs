import assert from 'node:assert/strict'
import { withTaskContext } from './task-context.mjs'
import { runPerfExecutable } from '../plugins/dsh-perf/lib/perf.mjs'

const controller = new AbortController()
const started = performance.now()
const pending = withTaskContext({ signal: controller.signal }, () => runPerfExecutable(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 30000))
setTimeout(() => controller.abort(new Error('test cancellation')), 200)
const result = await pending
assert.notEqual(result.code, 0)
assert.ok(performance.now() - started < 10000)
assert.throws(() => withTaskContext({ signal: controller.signal }, () => runPerfExecutable(process.execPath, ['-e', 'process.exit(0)'], 30000)))
console.log('PASS cancellation: running native process exits, pre-cancelled task never spawns')
