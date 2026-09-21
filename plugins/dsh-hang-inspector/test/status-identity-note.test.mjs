import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHangInspector } from '../lib/hang.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-hang-identity-note-'))
const previousSpawn = childProcess.spawnSync
const previousGate = process.env.DSH_NO_ENV_FALLBACK
process.env.DSH_NO_ENV_FALLBACK = '1'
const startedAt = Date.now() - 1000
let knownCreation = true
childProcess.spawnSync = (file, args) => {
  assert.equal(file, 'powershell.exe')
  assert.ok(args.at(-1).includes('Get-CimInstance Win32_Process'))
  return { status: 0, stdout: 'pwsh -File fixture/hang-loop.ps1\n__CREATED__' + (knownCreation ? new Date(startedAt).toISOString() : 'unknown'), stderr: '' }
}
syncBuiltinESMExports()
try {
  writeFileSync(join(work, 'hang-loop.ps1'), '')
  writeFileSync(join(work, 'run.json'), JSON.stringify({ pid: process.pid, startedAt, status: 'running', note: 'stale identity warning' }))
  const inspector = makeHangInspector({ runDir: work, uiDrive: work, packs: work, hangLoop: join(work, 'hang-loop.ps1'), srcRoot: '' })
  const matched = inspector.runStatus()
  assert.equal(matched.pidIdentity, 'match')
  assert.equal(matched.status, 'running')
  assert.equal(matched.note, undefined)
  knownCreation = false
  const unknown = inspector.runStatus()
  assert.equal(unknown.pidIdentity, 'unknown')
  assert.match(unknown.note, /无法.*正面确认/)
  knownCreation = true
  const matchedAgain = inspector.runStatus()
  assert.equal(matchedAgain.pidIdentity, 'match')
  assert.equal(matchedAgain.note, undefined)
  console.log('PASS monitor identity status keeps match and unknown notes consistent without starting or stopping processes')
} finally {
  childProcess.spawnSync = previousSpawn
  syncBuiltinESMExports()
  if (previousGate === undefined) delete process.env.DSH_NO_ENV_FALLBACK
  else process.env.DSH_NO_ENV_FALLBACK = previousGate
  rmSync(work, { recursive: true, force: true })
}
