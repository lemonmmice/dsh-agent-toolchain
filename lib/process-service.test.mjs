import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProcessService } from './process-service.mjs'

const directory = mkdtempSync(join(tmpdir(), 'process-service-'))
const worker = join(directory, 'writer.mjs')
const evidence = join(directory, 'writes.txt')
writeFileSync(worker, `import { appendFileSync } from 'node:fs'; process.on('disconnect', () => process.exit(0)); process.on('message', message => { if(message.crash) process.exit(3); if(message.write) appendFileSync(process.argv[2], message.write); setTimeout(() => process.send({id:message.id,value:message.write || 'done'}), message.delay || 0); });`)
const service = createProcessService(worker, { args: [evidence], timeoutMs: 1000, maxQueue: 1 })
try {
  assert.equal((await service.call({ write: 'first\n' })).value, 'first\n')
  const timedOut = service.call({ write: 'uncertain\n', delay: 10000 })
  const queued = service.call({ write: 'never\n' })
  const rejectedTimeout = assert.rejects(timedOut, error => error.code === 'PROCESS_TIMEOUT' && error.unknown && error.retryable === false && error.writesApplied === null)
  const rejectedQueued = assert.rejects(queued, error => error.writesApplied === false && error.retryable)
  await assert.rejects(service.call({ write: 'busy\n' }), error => error.code === 'PROCESS_BUSY' && error.writesApplied === false)
  await Promise.all([rejectedTimeout, rejectedQueued])
  assert.ok(existsSync(evidence))
  assert.equal(readFileSync(evidence, 'utf8'), 'first\nuncertain\n')
  assert.equal((await service.call({ write: 'recovered\n' })).value, 'recovered\n')
  await assert.rejects(service.call({ crash: true }), error => error.code === 'PROCESS_EXITED' && error.unknown)
  assert.equal((await service.call({})).value, 'done')
  console.log('PASS process service: bounded queue, completed writes, active unknown versus unexecuted queued requests, crash recovery, no replay')
} finally { service.close(); rmSync(directory, { recursive: true, force: true }) }
