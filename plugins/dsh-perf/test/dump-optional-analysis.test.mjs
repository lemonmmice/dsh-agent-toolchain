import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePerf } from '../lib/perf.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dump-optional-'))
const originalSpawn = childProcess.spawn
const originalSync = childProcess.execFileSync
const processTable = '"Fixture.exe","12345","Console","1","100 K"'
childProcess.execFileSync = () => processTable
childProcess.spawn = (_exe, args) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  setImmediate(() => { writeFileSync(args.at(-1), 'fixture dump'); child.emit('exit', 0); child.emit('close', 0) })
  return child
}
syncBuiltinESMExports()
let analyses = 0
let dumpExit = 0
let dumpOutput = ''
let timedOut = false
let validDump = true
const dumpBytes = Buffer.alloc(64)
dumpBytes.write('MDMP')
dumpBytes.writeUInt32LE(0xa793, 4)
dumpBytes.writeUInt32LE(1, 8)
dumpBytes.writeUInt32LE(32, 12)
const driver = makePerf({ procName: 'Fixture', evidenceDir: directory, procdump: process.execPath, dumpstack: process.execPath, runExe: async (exe, args) => {
  if (exe === 'tasklist') return { code: 0, stdout: processTable, stderr: '' }
  if (args.includes('-ma')) { writeFileSync(args.at(-1), validDump ? dumpBytes : 'partial dump'); return { code: dumpExit, stdout: dumpOutput, stderr: '', timedOut } }
  analyses++
  if (args[0] === 'dacinfo') return { code: 1, stdout: '', stderr: '' }
  writeFileSync(args[1], JSON.stringify({ dump: args[0], threads: [{ osId: 1, isUIThread: true, frames: [] }] }))
  return { code: 0, stdout: '', stderr: '' }
} })
try {
  const captured = await driver.dump({ analyze: false })
  assert.equal(captured.ok, true)
  assert.equal(analyses, 0, 'capture-only must not launch dump analysis')
  assert.equal(captured.analysisState, 'not-requested')
  const combined = await driver.dump()
  assert.ok(analyses > 0)
  assert.equal(combined.analysisState, 'done')
  assert.notEqual(combined.dumpPath, captured.dumpPath)
  dumpExit = 1
  const failed = await driver.dump({ analyze: false })
  assert.equal(failed.ok, false)
  assert.equal(failed.exitCode, 1)
  dumpOutput = 'Dump 1 complete: 698 MB written in 2.1 seconds\nDump count reached.'
  const completed = await driver.dump({ analyze: false })
  assert.equal(completed.ok, true)
  assert.equal(completed.nonZeroExitWithCompleteOutput, true)
  timedOut = true
  assert.equal((await driver.dump({ analyze: false })).ok, false)
  timedOut = false
  validDump = false
  assert.equal((await driver.dump({ analyze: false })).ok, false)
  validDump = true
  dumpExit = 2
  assert.equal((await driver.dump({ analyze: false })).ok, false)
  console.log('PASS: dump capture-only, default analysis, unique attempts and failed partial artifact')
} finally {
  childProcess.spawn = originalSpawn
  childProcess.execFileSync = originalSync
  syncBuiltinESMExports()
  rmSync(directory, { recursive: true, force: true })
}
