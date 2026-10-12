import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBuilder } from '../lib/builder.mjs'
import { renderBuild, renderStatus } from '../lib/render.mjs'

const directory = mkdtempSync(join(tmpdir(), 'build-startup-'))
const originalSpawn = childProcess.spawn
try {
  const child = new EventEmitter()
  child.unref = () => {}
  childProcess.spawn = () => child
  syncBuiltinESMExports()
  const builder = makeBuilder({ logsDir: directory, repoRoot: join(directory, 'missing') })
  const submission = builder.startBackground({ runId: 'failed-spawn' })
  assert.equal(submission.state, 'starting')
  assert.equal(submission.accepted, true)
  assert.equal(submission.ok, undefined)
  assert.match(renderBuild(submission), /等待执行器确认/)
  assert.doesNotMatch(renderBuild(submission), /PASSED|FAILED/)
  assert.match(renderStatus(builder.status({ jobId: submission.jobId })), /等待执行器确认/)
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('fixture spawn failed'), { code: 'ENOENT' })))
  const failed = builder.status({ jobId: submission.jobId })
  assert.equal(failed.hasRun, false)
  assert.equal(failed.backgroundJob.state, 'crashed')
  assert.equal(failed.backgroundJob.runId, submission.runId)
  assert.match(failed.backgroundJob.error, /fixture spawn failed/)

  const second = builder.startBackground({ runId: 'runner-exit' })
  child.emit('exit', 2, null)
  assert.equal(builder.status({ jobId: second.jobId }).backgroundJob.state, 'crashed')
  console.log('PASS background startup: spawn error and early runner exit produce identified crashed jobs')
} finally {
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  rmSync(directory, { recursive: true, force: true })
}
