import { fork } from 'node:child_process'
import { taskSignal } from './task-context.mjs'

export function createProcessService(modulePath, { args = [], maxQueue = 32, timeoutMs = 60000 } = {}) {
  let child = null, active = null, sequence = 0, retiring = false, closed = false
  const queue = []
  const errorOf = (message, code, started) => Object.assign(new Error(message), { code, incomplete: true, retryable: !started, writesApplied: started ? null : false, unknown: started })
  function fail(error, kill = true) {
    const stopped = child
    child = null
    if (active) { active.cleanup(); active.reject(errorOf(error.message, error.code || 'PROCESS_FAILED', true)); active = null }
    for (const pending of queue.splice(0)) { pending.cleanup(); pending.reject(errorOf(error.message, error.code || 'PROCESS_FAILED', false)) }
    if (stopped && kill) {
      retiring = true
      stopped.once('exit', () => { retiring = false; dispatch() })
      stopped.kill()
    }
  }
  function dispatch() {
    if (closed || retiring || active || !queue.length) {
      if (!active) { child?.unref(); child?.channel?.unref() }
      return
    }
    active = queue.shift()
    active.queueMs = performance.now() - active.queuedAt
    active.startedAt = performance.now()
    if (!child) {
      try {
        child = fork(modulePath, args, { windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          execArgv: process.execArgv.filter((argument, index, values) => !argument.startsWith('--input-type=') && argument !== '--input-type' && values[index - 1] !== '--input-type') })
      } catch (error) { fail(error, false); return }
      const current = child
      current.on('message', message => {
        if (current !== child || message.id !== active?.id) return
        const request = active
        active = null
        request.cleanup()
        if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error))
        else request.resolve({ value: message.value, timing: { queueMs: +request.queueMs.toFixed(2), processMs: +(performance.now() - request.startedAt).toFixed(2) } })
        dispatch()
      })
      current.on('error', error => { if (current === child) fail(error) })
      current.on('exit', code => { if (current === child) fail(errorOf('Service process exited: ' + code, 'PROCESS_EXITED', true), false) })
    }
    child.ref()
    child.channel?.ref()
    const current = child
    const request = active
    try { child.send({ id: request.id, ...request.payload }, error => { if (error && current === child && active === request) fail(error) }) }
    catch (error) { if (current === child && active === request) fail(error) }
  }
  return {
    call(payload, { signal = taskSignal(), deadlineMs = timeoutMs } = {}) {
      if (signal?.aborted) return Promise.reject(errorOf('Process request cancelled before execution', 'PROCESS_CANCELLED', false))
      if (closed) return Promise.reject(errorOf('Process service is closed', 'PROCESS_CLOSED', false))
      if (queue.length >= maxQueue) return Promise.reject(errorOf('Process queue is full', 'PROCESS_BUSY', false))
      return new Promise((resolve, reject) => {
        const request = { id: ++sequence, payload, resolve, reject, queuedAt: performance.now() }
        const abort = () => {
          if (active === request) { fail(errorOf('Process request cancelled; completion is unknown', 'PROCESS_CANCELLED', true)); return }
          const index = queue.indexOf(request)
          if (index >= 0) queue.splice(index, 1)
          request.cleanup()
          reject(errorOf('Queued request cancelled before execution', 'PROCESS_CANCELLED', false))
        }
        request.cleanup = () => { clearTimeout(request.timer); signal?.removeEventListener('abort', abort) }
        request.timer = setTimeout(() => {
          if (active === request) { fail(errorOf('Process deadline exceeded; completion is unknown', 'PROCESS_TIMEOUT', true)); return }
          const index = queue.indexOf(request)
          if (index >= 0) queue.splice(index, 1)
          request.cleanup()
          reject(errorOf('Queue deadline exceeded before execution', 'PROCESS_QUEUE_TIMEOUT', false))
        }, deadlineMs)
        signal?.addEventListener('abort', abort, { once: true })
        queue.push(request)
        dispatch()
      })
    },
    close() { closed = true; fail(errorOf('Process service closed', 'PROCESS_CLOSED', Boolean(active))) },
  }
}
