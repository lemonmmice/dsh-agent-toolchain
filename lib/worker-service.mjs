import { Worker } from 'node:worker_threads'

export function createWorkerService(url, { workerData, maxQueue = 32, timeoutMs = 60000 } = {}) {
  let worker = null
  let active = null
  let retiring = false
  let sequence = 0
  const queue = []
  const errorOf = (message, code) => Object.assign(new Error(message), { code, incomplete: true })
  const dispatch = () => {
    if (retiring || active || !queue.length) { if (!active) worker?.unref(); return }
    active = queue.shift()
    active.queueMs = performance.now() - active.queuedAt
    active.startedAt = performance.now()
    if (!worker) {
      try { worker = new Worker(url, { workerData, execArgv: process.execArgv.filter((argument, index, argumentsList) =>
        !argument.startsWith('--input-type=') && argument !== '--input-type' && argumentsList[index - 1] !== '--input-type') }) }
      catch (error) { fail(error); return }
      const current = worker
      current.on('message', message => {
        if (current !== worker || message.id !== active?.id) return
        const request = active
        active = null
        clearTimeout(request.timer)
        if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error))
        else request.resolve({ value: message.value, timing: { queueMs: +request.queueMs.toFixed(2), workerMs: +(performance.now() - request.startedAt).toFixed(2) } })
        dispatch()
      })
      current.on('error', error => { if (current === worker) fail(error) })
      current.on('exit', code => { if (current === worker) fail(errorOf('Worker exited before completion: ' + code, 'WORKER_EXITED')) })
    }
    worker.ref()
    try { worker.postMessage({ id: active.id, ...active.payload }) }
    catch (error) { fail(error) }
  }
  const fail = error => {
    error = Object.assign(error, { code: error.code ?? 'WORKER_FAILED', incomplete: true })
    const stopped = worker
    worker = null
    if (active) { clearTimeout(active.timer); active.reject(error); active = null }
    for (const request of queue.splice(0)) { clearTimeout(request.timer); request.reject(error) }
    if (stopped) {
      retiring = true
      stopped.terminate().catch(terminationError => process.emitWarning(terminationError.message)).finally(() => { retiring = false; dispatch() })
    }
  }
  return {
    call(payload) {
      if (queue.length >= maxQueue) return Promise.reject(Object.assign(errorOf('Worker queue is full', 'WORKER_BUSY'), { retryable: true, writesApplied: false }))
      return new Promise((resolve, reject) => {
        const request = { id: ++sequence, payload, resolve, reject, queuedAt: performance.now() }
        request.timer = setTimeout(() => {
          if (active === request) { fail(errorOf('Worker deadline exceeded; completion is unknown', 'WORKER_TIMEOUT')); return }
          const index = queue.indexOf(request)
          if (index >= 0) queue.splice(index, 1)
          reject(Object.assign(errorOf('Worker queue deadline exceeded before execution', 'WORKER_QUEUE_TIMEOUT'), { retryable: true, writesApplied: false }))
        }, timeoutMs)
        queue.push(request)
        dispatch()
      })
    },
    close() { fail(errorOf('Worker service closed', 'WORKER_CLOSED')) },
  }
}
