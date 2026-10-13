import assert from 'node:assert/strict'
import { createWorkerService } from './worker-service.mjs'

const worker = new URL('data:text/javascript,' + encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.on('message', ({id, delay, exit}) => { if (exit) process.exit(2); setTimeout(() => parentPort.postMessage({id, value: delay}), delay); });"))
const service = createWorkerService(worker, { maxQueue: 1, timeoutMs: 1000 })
const originalExecArgv = process.execArgv
process.execArgv = [...originalExecArgv, '--input-type=module']
try {
  const first = service.call({ delay: 30 })
  const second = service.call({ delay: 5 })
  await assert.rejects(service.call({ delay: 0 }), error => error.code === 'WORKER_BUSY' && error.retryable === true)
  assert.equal((await first).value, 30)
  assert.equal((await second).value, 5)
  await assert.rejects(service.call({ exit: true }), error => error.code === 'WORKER_EXITED')
  assert.equal((await service.call({ delay: 1 })).value, 1)
} finally { service.close(); process.execArgv = originalExecArgv }
const slow = createWorkerService(worker, { timeoutMs: 200 })
try {
  await assert.rejects(slow.call({ delay: 5000 }), error => error.code === 'WORKER_TIMEOUT' && error.incomplete)
  assert.equal((await slow.call({ delay: 1 })).value, 1)
} finally { slow.close() }
console.log('PASS: bounded worker queue, serialized dispatch, crash, timeout and recovery')
