import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeBuilder } from '../lib/builder.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'))
try {
  const logPath = join(directory, 'build.log')
  const diagnostic = '文件.cs(2,3): error CS1002: 缺少分号\r\n'
  const text = ('ordinary ' + 'x'.repeat(180) + '\n').repeat(340000) + diagnostic + diagnostic
  writeFileSync(logPath, text)
  writeFileSync(join(directory, 'last.json'), JSON.stringify({ logPath }))
  const builder = makeBuilder({ logsDir: directory })
  const expected = builder.parseErrors(text)
  let heartbeats = 0
  const timer = setInterval(() => heartbeats++, 5)
  const [first, second] = await Promise.all([builder.errorsOfLast(), builder.errorsOfLast()])
  clearInterval(timer)
  assert.deepEqual(first.errors, expected.errors)
  assert.equal(first.incomplete, false)
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(second.bytesRead, 0)
  assert.ok(heartbeats >= 2, 'log parsing must leave the parent event loop responsive')
  first.errors[0].message = 'mutated'
  assert.notEqual((await builder.errorsOfLast()).errors[0].message, 'mutated')
  appendFileSync(logPath, 'B.cs(4,5): warning CS0168: unused\n')
  const appended = await builder.errorsOfLast()
  assert.equal(appended.cacheHit, false)
  assert.equal(appended.warnings.length, 1)
  writeFileSync(logPath, diagnostic.replace('CS1002', 'CS1003'))
  assert.equal((await builder.errorsOfLast()).errors[0].code, 'CS1003')
  renameSync(logPath, logPath + '.old')
  writeFileSync(logPath, diagnostic)
  assert.equal((await builder.errorsOfLast()).errors[0].code, 'CS1002')
  const carriage = 'progress\rA.cs(1,2): error CS1002: expected\n最后.cs(3,4): warning CS0168: 保留'
  writeFileSync(logPath, carriage)
  const carriageResult = await builder.errorsOfLast()
  assert.deepEqual(carriageResult.errors, builder.parseErrors(carriage).errors)
  assert.deepEqual(carriageResult.warnings, builder.parseErrors(carriage).warnings)
  rmSync(logPath)
  const missing = await builder.errorsOfLast()
  assert.equal(missing.incomplete, true)
  assert.equal(missing.errorCode, 'ENOENT')
  console.log('PASS: diagnostics parity, heartbeat, cache invalidation, rotation and unreadable log')
} finally { rmSync(directory, { recursive: true, force: true }) }
