import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskService } from './task-service.mjs'
import { withFileTransaction } from './file-transaction.mjs'

const directory = mkdtempSync(join(tmpdir(), 'task-service-'))
const service = createTaskService({ directory, concurrency: 2 })
const waitFor = async (id, predicate) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = await service.status(id)
    if (predicate(status)) return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Task did not reach expected state')
}
try {
  let release
  const held = withFileTransaction(join(directory, 'test-lock'), () => new Promise(resolve => { release = resolve }))
  assert.throws(() => withFileTransaction(join(directory, 'test-lock'), () => {}), error => error.code === 'FILE_TRANSACTION_BUSY')
  release()
  await held
  let running = 0, peak = 0, calls = 0
  const execute = async () => { calls++; running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 60)); running--; return { ok: true } }
  const first = await service.submit({ tool: 'fixture', requestKey: 'once', argsIdentity: 'one', resources: ['shared'], execute })
  assert.equal(first.state, 'queued')
  assert.equal(first.completeness, 'pending')
  const duplicate = await service.submit({ tool: 'fixture', requestKey: 'once', argsIdentity: 'one', execute })
  assert.equal(duplicate.jobId, first.jobId)
  await assert.rejects(service.submit({ tool: 'fixture', requestKey: 'once', argsIdentity: 'two', execute }), error => error.code === 'TASK_KEY_CONFLICT')
  const second = await service.submit({ tool: 'fixture', resources: ['shared'], execute })
  await Promise.all([waitFor(first.jobId, status => status.state === 'done'), waitFor(second.jobId, status => status.state === 'done')])
  assert.equal(peak, 1)
  assert.equal(calls, 2)
  assert.equal((await service.result(first.jobId)).resultReady, true)
  const cancelled = await service.submit({ tool: 'read', execute: signal => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
  await waitFor(cancelled.jobId, status => status.state === 'running')
  await service.cancel(cancelled.jobId)
  assert.equal((await waitFor(cancelled.jobId, status => status.state === 'cancelled')).completeness, 'incomplete')
  writeFileSync(join(directory, 'previous.json'), JSON.stringify({ jobId: 'previous', state: 'running', observedAt: new Date().toISOString() }))
  assert.equal((await service.status('previous')).state, 'unknown')
  console.log('PASS task service: accepted versus completed, persistent identity, deduplication, resource serialization, cancellation and no crash replay')
} finally { await service.close(); rmSync(directory, { recursive: true, force: true }) }
