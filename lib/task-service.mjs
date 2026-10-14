import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileTransaction } from './file-transaction.mjs'
import { withTaskContext } from './task-context.mjs'
import { AsyncResource } from 'node:async_hooks'

const terminalStates = new Set(['done', 'failed', 'cancelled', 'unknown'])
const digest = value => createHash('sha256').update(value).digest('hex')
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/

export function createTaskService({ directory, concurrency = 2, maxQueue = 32 } = {}) {
  const jobs = new Map()
  const queue = []
  let active = 0, timer = null, disposed = false
  mkdirSync(directory, { recursive: true })
  const now = () => new Date().toISOString()
  const metadataPath = id => join(directory, id + '.json')
  const snapshot = job => ({ ...job.record, ageMs: Date.now() - Date.parse(job.record.observedAt) })
  function persist(job) {
    job.record.observedAt = now()
    const payload = JSON.stringify(job.record)
    job.persisted = (job.persisted || Promise.resolve()).then(async () => {
      const target = metadataPath(job.record.jobId)
      const temporary = target + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, payload)
      await rename(temporary, target)
    })
    return job.persisted
  }
  function locked(keys, execute, index = 0) {
    if (index >= keys.length) return execute()
    return withFileTransaction(join(directory, 'resource-' + digest(keys[index])), () => locked(keys, execute, index + 1))
  }
  function schedule() {
    if (timer || disposed) return
    timer = setTimeout(() => { timer = null; pump() }, 25)
  }
  function pump() {
    if (disposed) return
    const candidates = queue.splice(0)
    for (const job of candidates) {
      if (job.record.state !== 'queued') continue
      if (active >= concurrency) { queue.push(job); continue }
      active++
      run(job).catch(error => {
        job.record.state = 'unknown'
        job.record.error = 'Task state could not be persisted: ' + error.message
        job.record.completeness = 'incomplete'
      }).finally(() => { active--; if (queue.length) schedule() })
    }
    if (queue.length) schedule()
  }
  async function run(job) {
    try {
      await locked(job.resources, async () => {
        if (job.controller.signal.aborted) return
        job.record.state = 'running'
        job.record.startedAt = now()
        job.record.queueMs = Date.now() - Date.parse(job.record.queuedAt)
        await persist(job)
        try {
          if (job.controller.signal.aborted) throw job.controller.signal.reason
          const result = await job.execute(job.controller.signal)
          const resultPath = join(directory, job.record.jobId + '.result.json')
          await writeFile(resultPath, JSON.stringify(result))
          job.record.evidenceRefs = [resultPath]
          // C3（6988a0f 复核）：cancelled=true 却同时 ok=false / isError 是**自相矛盾**的收尾 —— 会话是否真停不确定，
          //   绝不能据此标成 cancelled/complete；按 unknown/incomplete 处理（防任何工具把"请求取消"谎报成"已干净取消"）。
          const contradictoryCancel = result?.cancelled === true && (result?.ok === false || result?.isError === true)
          job.record.state = result?.unknown === true || contradictoryCancel ? 'unknown' : result?.cancelled === true ? 'cancelled'
            : job.controller.signal.aborted && (result?.ok === false || result?.isError === true) ? (job.sideEffects ? 'unknown' : 'cancelled')
            : result?.ok === false || result?.isError === true ? 'failed' : 'done'
          job.record.completeness = result?.incomplete || job.record.state === 'unknown' ? 'incomplete' : 'complete'
          job.record.result = { path: resultPath }
        } catch (error) {
          job.record.state = error.unknown || (job.controller.signal.aborted && job.sideEffects) ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed'
          job.record.error = error.message
          job.record.errorCode = error.code
          job.record.completeness = 'incomplete'
        } finally {
          clearTimeout(job.deadline)
          job.record.completedAt = now()
          job.record.executionMs = Date.now() - Date.parse(job.record.startedAt)
          await persist(job)
        }
      })
    } catch (error) {
      if (error.code === 'FILE_TRANSACTION_BUSY') { if (job.record.state === 'queued') queue.push(job); return }
      clearTimeout(job.deadline)
      throw error
    }
  }
  async function readRecord(jobId) {
    if (!idPattern.test(String(jobId))) throw new Error('Invalid task id')
    const inMemory = jobs.get(jobId)
    if (inMemory) return snapshot(inMemory)
    const record = JSON.parse(await readFile(metadataPath(jobId), 'utf8'))
    if (!terminalStates.has(record.state)) return { ...record, lastPersistedState: record.state, state: 'unknown', completeness: 'incomplete', recoveryNote: 'Owned by another or previous service process; execution is not replayed automatically.' }
    return { ...record, ageMs: Date.now() - Date.parse(record.observedAt) }
  }
  return {
    async submit({ tool, runId = '', requestKey, argsIdentity = '', resources = [], sideEffects = false, timeoutMs = 300000, execute }) {
      if (disposed) throw new Error('Task service is closed')
      if (typeof execute !== 'function') throw new TypeError('Task executor is required')
      const binding = digest(JSON.stringify([tool, argsIdentity]))
      const keyFile = requestKey ? join(directory, 'request-' + digest(tool + '\0' + requestKey) + '.json') : null
      let existingId = null
      const record = { version: 1, jobId: randomUUID(), runId, attemptId: randomUUID(), tool, ownerPid: process.pid, state: 'queued', queuedAt: now(), observedAt: now(), startedAt: null, completedAt: null, completeness: 'pending', evidenceRefs: [], cancelRequested: false }
      const accept = () => {
        if (keyFile) {
          let saved
          try { saved = JSON.parse(readFileSync(keyFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (saved) {
            if (saved.binding !== binding) throw Object.assign(new Error('Request key is already bound to different arguments'), { code: 'TASK_KEY_CONFLICT', writesApplied: false })
            existingId = saved.jobId
            return
          }
        }
        if (queue.length >= maxQueue) throw Object.assign(new Error('Task queue is full'), { code: 'TASK_BUSY', retryable: true, writesApplied: false })
        writeFileSync(metadataPath(record.jobId), JSON.stringify(record))
        if (keyFile) {
          const temporary = keyFile + '.' + randomUUID() + '.tmp'
          writeFileSync(temporary, JSON.stringify({ jobId: record.jobId, binding }))
          renameSync(temporary, keyFile)
        }
      }
      if (keyFile) withFileTransaction(keyFile, accept)
      else accept()
      if (existingId) return { ok: true, accepted: false, deduplicated: true, ...(await readRecord(existingId)) }
      const boundExecute = AsyncResource.bind(signal => withTaskContext({ signal, jobId: record.jobId }, () => execute(signal)))
      const job = { record, execute: boundExecute, sideEffects, controller: new AbortController(), resources: [...new Set(resources)].sort(), persisted: Promise.resolve() }
      jobs.set(record.jobId, job)
      queue.push(job)
      job.deadline = setTimeout(() => {
        job.record.cancelRequested = true
        job.controller.abort(new Error('Task deadline exceeded'))
        job.record.state = job.record.state === 'queued' ? 'cancelled' : 'unknown'
        job.record.completeness = 'incomplete'
        job.record.errorCode = 'TASK_TIMEOUT'
        persist(job).catch(error => { job.record.persistenceError = error.message })
      }, Math.max(1, Math.min(86400000, timeoutMs)))
      setImmediate(pump)
      return { ok: true, accepted: true, ...snapshot(job) }
    },
    async status(jobId) { return { ok: true, ...(await readRecord(jobId)) } },
    async result(jobId) {
      const record = await readRecord(jobId)
      return { ok: true, ...record, resultReady: Boolean(record.result?.path) }
    },
    async cancel(jobId) {
      const job = jobs.get(jobId)
      if (!job) return { ok: false, ...(await readRecord(jobId)), error: 'Cancellation requires the owning service process' }
      if (terminalStates.has(job.record.state)) return { ok: true, cancellationApplied: false, ...snapshot(job) }
      job.record.cancelRequested = true
      const queued = job.record.state === 'queued'
      job.record.state = queued ? 'cancelled' : 'cancelling'
      job.record.completeness = 'incomplete'
      if (queued) { clearTimeout(job.deadline); job.record.completedAt = now() }
      job.controller.abort(new Error('Task cancelled'))
      await persist(job)
      return { ok: true, cancellationApplied: true, ...snapshot(job) }
    },
    async close() {
      disposed = true
      clearTimeout(timer)
      for (const job of jobs.values()) {
        clearTimeout(job.deadline)
        if (!terminalStates.has(job.record.state)) {
          job.record.state = job.record.state === 'queued' ? 'cancelled' : 'unknown'
          job.record.completeness = 'incomplete'
          job.controller.abort(new Error('Task service closed'))
          await persist(job)
        }
      }
    },
  }
}
