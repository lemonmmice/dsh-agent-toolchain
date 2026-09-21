import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { makeHangInspector } from '../lib/hang.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-analysis-wait-'))
const packs = join(work, 'packs')
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const pendingTimers = new Set()
const failures = []
const oldGate = process.env.DSH_NO_ENV_FALLBACK
process.env.DSH_NO_ENV_FALLBACK = '1'
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  const timer = originalSetTimeout(() => { pendingTimers.delete(timer); callback(...args) }, milliseconds)
  pendingTimers.add(timer)
  return timer
}
globalThis.clearTimeout = (timer) => { pendingTimers.delete(timer); return originalClearTimeout(timer) }

function check(name, verify) {
  try { verify(); console.log('PASS ' + name) } catch (error) { failures.push(name + ': ' + error.message) }
}
function clearPending() { for (const timer of pendingTimers) globalThis.clearTimeout(timer) }
function pack(id) {
  const dir = join(packs, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'frozen.dmp'), 'fake dump')
  return dir
}

try {
  const dumpStack = join(work, 'DumpStack.exe')
  writeFileSync(dumpStack, '')
  let captures = 0
  const inspector = makeHangInspector({
    packs, uiDrive: work, runDir: join(work, 'run'), dumpStack, dacDir: work, srcRoot: '',
    capture: async () => { captures++; return { code: 0, stdout: '{"threads":[]}', stderr: '' } },
  })
  const quickDir = pack('quick')
  const quick = await inspector.analyze('quick', { wait: true })
  check('fresh analysis completes without retaining a five minute timer', () => {
    assert.equal(quick.status, 'done')
    assert.equal(pendingTimers.size, 0)
  })
  clearPending()
  writeFileSync(join(quickDir, 'frozen.dmp'), 'changed fake dump with different length')
  const changed = await inspector.analyze('quick', { wait: true })
  check('changed dump analysis also clears its wait timer', () => {
    assert.equal(changed.status, 'done')
    assert.equal(changed.dumpChanged, true)
    assert.equal(pendingTimers.size, 0)
  })
  clearPending()

  const runningDir = pack('running')
  writeFileSync(join(runningDir, 'analysis.json'), JSON.stringify({ status: 'running', startedAt: Date.now() }))
  const externallyFinished = delay(50).then(() => writeFileSync(join(runningDir, 'analysis.json'), JSON.stringify({ status: 'done', external: true })))
  const waiting = await inspector.analyze('running', { wait: true, waitMs: 500, pollMs: 10 })
  check('wait=true waits for an already running analysis without rerunning it', () => {
    assert.equal(waiting.status, 'done')
    assert.equal(waiting.external, true)
    assert.equal(captures, 2)
  })
  await externallyFinished

  const partialDir = pack('partial')
  writeFileSync(join(partialDir, 'analysis.json'), JSON.stringify({ status: 'running', startedAt: Date.now() }))
  const partialWriter = delay(15).then(async () => {
    writeFileSync(join(partialDir, 'analysis.json'), '{')
    await delay(65)
    writeFileSync(join(partialDir, 'analysis.json'), JSON.stringify({ status: 'done', completedAfterPartialWrite: true }))
  })
  const afterPartial = await inspector.analyze('partial', { wait: true, waitMs: 300, pollMs: 5 })
  check('a partially written analysis file is not treated as completion', () => {
    assert.equal(afterPartial.status, 'done')
    assert.equal(afterPartial.completedAfterPartialWrite, true)
  })
  await partialWriter

  writeFileSync(join(partialDir, 'analysis.json'), JSON.stringify({ status: 'running', startedAt: Date.now() }))
  const incompleteWriter = delay(10).then(() => writeFileSync(join(partialDir, 'analysis.json'), '{'))
  const incomplete = await inspector.analyze('partial', { wait: true, waitMs: 60, pollMs: 5 })
  check('an incomplete file at the deadline retains the last running state', () => assert.equal(incomplete.status, 'running'))
  await incompleteWriter

  const removedDir = pack('removed')
  writeFileSync(join(removedDir, 'analysis.json'), JSON.stringify({ status: 'running', startedAt: Date.now() }))
  const removal = delay(15).then(() => rmSync(removedDir, { recursive: true, force: true }))
  const removed = await inspector.analyze('removed', { wait: true, waitMs: 300, pollMs: 5 })
  check('deleting the pack while waiting returns an explicit missing error', () => {
    assert.equal(removed.ok, false)
    assert.equal(removed.error, 'pack not found')
  })
  await removal

  writeFileSync(join(runningDir, 'analysis.json'), JSON.stringify({ status: 'running', startedAt: Date.now() }))
  const noWait = await inspector.analyze('running', { wait: false })
  check('wait=false returns running immediately', () => assert.equal(noWait.status, 'running'))
  const started = Date.now()
  const timedOut = await inspector.analyze('running', { wait: true, waitMs: 60, pollMs: 10 })
  check('a running analysis respects the wait budget without leaking timers', () => {
    assert.equal(timedOut.status, 'running')
    assert.ok(Date.now() - started >= 40)
    assert.ok(Date.now() - started < 1000)
    assert.equal(pendingTimers.size, 0)
  })
  const errorDir = pack('failed')
  rmSync(join(errorDir, 'frozen.dmp'))
  const failed = await inspector.analyze('failed', { wait: true })
  check('analysis failures also release the wait timer', () => {
    assert.equal(failed.ok, false)
    assert.equal(failed.status, 'error')
    assert.equal(pendingTimers.size, 0)
  })
} finally {
  clearPending()
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  if (oldGate === undefined) delete process.env.DSH_NO_ENV_FALLBACK
  else process.env.DSH_NO_ENV_FALLBACK = oldGate
  rmSync(work, { recursive: true, force: true })
}
assert.deepEqual(failures, [])
