import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHangInspector } from '../lib/hang.mjs'
import { EventEmitter } from 'node:events'

const directory = mkdtempSync(join(tmpdir(), 'hang-responsive-'))
const originalSync = childProcess.spawnSync
const originalAsync = childProcess.execFile
const originalSpawn = childProcess.spawn
const children = []
childProcess.spawn = () => {
  const child = new EventEmitter()
  child.pid = process.pid
  child.unref = () => {}
  children.push(child)
  return child
}
const startedAt = Date.now()
const stdout = 'pwsh -File fixture/hang-loop.ps1\n__CREATED__' + new Date(startedAt).toISOString()
childProcess.spawnSync = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); return { stdout, status: 0 } }
childProcess.execFile = (_file, _args, _options, callback) => { setTimeout(() => callback(null, Buffer.from(stdout), Buffer.alloc(0)), 80); return { pid: 1 } }
syncBuiltinESMExports()
try {
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ pid: process.pid, startedAt, status: 'running' }))
  const inspector = makeHangInspector({ uiDrive: directory, packs: directory, runDir: directory, srcRoot: '' })
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 5)
  const status = await inspector.runStatus()
  clearTimeout(timer)
  assert.equal(heartbeat, true, 'monitor identity query must not block the event loop')
  assert.equal(status.pidIdentity, 'match')
  assert.equal(status.status, 'running')
  const checkingStart = inspector.startRun()
  const competingStop = await inspector.stopRun()
  assert.equal(competingStop.errorCode, 'MONITOR_BUSY')
  assert.equal((await checkingStart).ok, false)

  const lifecycle = makeHangInspector({ uiDrive: directory, packs: directory, runDir: join(directory, 'lifecycle'), srcRoot: '' })
  const firstStart = lifecycle.startRun({ maxSeconds: 10 })
  assert.equal((await lifecycle.startRun()).errorCode, 'MONITOR_BUSY')
  assert.equal((await firstStart).started, true)
  const oldStatus = lifecycle.runStatus()
  children[0].emit('exit', 0)
  assert.equal((await lifecycle.startRun({ maxSeconds: 20 })).started, true)
  children[0].emit('error', new Error('late error from prior monitor'))
  const current = await oldStatus
  assert.equal(current.status, 'running')
  assert.equal(current.maxSeconds, 20)
  assert.equal(current.error, undefined)
  children[1].emit('exit', 0)
  console.log('PASS: monitor process identity query leaves the main thread responsive')
} finally {
  childProcess.spawnSync = originalSync
  childProcess.execFile = originalAsync
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  rmSync(directory, { recursive: true, force: true })
}
