import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_UI_LOCK_WAIT_MS = '30'
const { makeDriver } = await import('../lib/driver.mjs')
const root = mkdtempSync(join(tmpdir(), 'ui-lock-responsive-'))
const lockPath = join(root, 'driver.lock')
const make = () => makeDriver({ lockPath, procName: '', clientExe: '', evidenceDir: root })
try {
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'other-owner' }))
  const started = performance.now()
  const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 10))
  let failure
  let driver
  try { driver = make() } catch (error) { failure = error }
  const elapsedMs = performance.now() - started
  const heartbeatMs = await heartbeat
  console.log(JSON.stringify({ elapsedMs, heartbeatMs, code: failure?.code }))
  assert.equal(failure?.code, 'UI_LOCK_BUSY')
  assert.ok(elapsedMs < 200)
  assert.ok(heartbeatMs < 200)
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'other-owner')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: 1, token: 'old-live-owner' }))
  assert.throws(make, { code: 'UI_LOCK_BUSY' })
  driver?.releaseLock()
  rmSync(lockPath)
  const first = make()
  const second = make()
  first.releaseLock()
  assert.equal(existsSync(lockPath), true)
  second.releaseLock()
  assert.equal(existsSync(lockPath), false)
  const replaced = make()
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement' }))
  replaced.releaseLock()
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'replacement')
  console.log('PASS UI lock busy is bounded, live owners survive age, releases respect ownership')
} finally {
  rmSync(root, { recursive: true, force: true })
}
