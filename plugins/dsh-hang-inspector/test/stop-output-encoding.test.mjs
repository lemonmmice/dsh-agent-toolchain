import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHangInspector } from '../lib/hang.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-hang-stop-encoding-'))
const previousSpawn = childProcess.spawnSync
const previousKill = process.kill
const previousGate = process.env.DSH_NO_ENV_FALLBACK
process.env.DSH_NO_ENV_FALLBACK = '1'
const fixturePid = 2000000000
const startedAt = Date.now() - 1000
const message = Buffer.from([0xb3, 0xc9, 0xb9, 0xa6, 0x3a, 0x20, 0xd2, 0xd1, 0xd6, 0xd5, 0xd6, 0xb9])
let alive = true
let killSucceeded = true
process.kill = (pid, signal) => {
  assert.equal(pid, fixturePid)
  assert.equal(signal, 0)
  if (!alive) throw Object.assign(new Error('not running'), { code: 'ESRCH' })
  return true
}
childProcess.spawnSync = (file, args, options) => {
  if (file === 'powershell.exe') return { status: 0, stdout: 'pwsh -File fixture/hang-loop.ps1\n__CREATED__' + new Date(startedAt).toISOString(), stderr: '' }
  assert.equal(file, 'taskkill')
  assert.deepEqual(args, ['/PID', String(fixturePid), '/T', '/F'])
  if (killSucceeded) alive = false
  return { status: killSucceeded ? 0 : 1, stdout: options.encoding ? message.toString(options.encoding) : message, stderr: Buffer.alloc(0) }
}
syncBuiltinESMExports()
try {
  writeFileSync(join(work, 'hang-loop.ps1'), '')
  const makeInspector = () => {
    writeFileSync(join(work, 'run.json'), JSON.stringify({ pid: fixturePid, startedAt, status: 'running' }))
    return makeHangInspector({ runDir: work, uiDrive: work, packs: work, hangLoop: join(work, 'hang-loop.ps1'), srcRoot: '' })
  }
  const stopped = makeInspector().stopRun()
  assert.equal(stopped.taskkillOut, '成功: 已终止')
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.killVerified, true)
  assert.equal(stopped.taskkillExit, 0)
  alive = true
  killSucceeded = false
  const failed = makeInspector().stopRun()
  assert.equal(failed.taskkillOut, '成功: 已终止')
  assert.equal(failed.stopped, false)
  assert.equal(failed.killVerified, false)
  assert.equal(failed.stopping, true)
  assert.equal(failed.taskkillExit, 1)
  console.log('PASS taskkill OEM output decodes without changing observed process-exit semantics')
} finally {
  childProcess.spawnSync = previousSpawn
  process.kill = previousKill
  syncBuiltinESMExports()
  if (previousGate === undefined) delete process.env.DSH_NO_ENV_FALLBACK
  else process.env.DSH_NO_ENV_FALLBACK = previousGate
  rmSync(work, { recursive: true, force: true })
}
