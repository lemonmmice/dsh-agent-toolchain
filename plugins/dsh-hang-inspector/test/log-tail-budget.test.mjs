import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHangInspector } from '../lib/hang.mjs'

process.env.DSH_NO_ENV_FALLBACK = '1'
const directory = fs.mkdtempSync(join(tmpdir(), 'dsh-hang-tail-'))
const logPath = join(directory, 'run.log')
const originalRead = fs.readFileSync
try {
  fs.writeFileSync(logPath, '普通诊断信息\n'.repeat(3000000) + '最后一行\n')
  const inspector = makeHangInspector({ uiDrive: directory, packs: directory, runDir: directory, srcRoot: '' })
  let wholeReads = 0
  fs.readFileSync = function (path, ...args) {
    if (path === logPath) wholeReads++
    return originalRead.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  const result = await inspector.runStatus()
  assert.match(result.logTail, /最后一行/)
  assert.equal(wholeReads, 0, 'status must not read the entire monitor log')
  assert.ok(result.logRead.bytesRead <= 256 * 1024)
  assert.equal(result.logRead.truncated, true)
  assert.equal(result.logRead.incomplete, false)
  fs.writeFileSync(logPath, 'small\r\n\r\n日志\n')
  const small = await inspector.runStatus()
  assert.equal(small.logTail, 'small\n日志')
  assert.equal(small.logRead.truncated, false)
  fs.rmSync(logPath)
  assert.equal((await inspector.runStatus()).logRead.available, false)
  console.log('PASS: hang status reads bounded UTF-8 tail, reports truncation and missing logs')
} finally {
  fs.readFileSync = originalRead
  syncBuiltinESMExports()
  fs.rmSync(directory, { recursive: true, force: true })
}
