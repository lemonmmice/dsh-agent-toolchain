import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeTrace } from '../lib/trace.mjs'
import { readClrEvents } from '../lib/clr-stream.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-clr-reuse-'))
const etlPath = join(directory, 'sample.etl')
const xmlPath = join(directory, 'sample.xml')
const summary = readFileSync(new URL('./fixtures/clr-summary.txt', import.meta.url), 'utf8')
const event = processId => '<Event><System><Provider Guid="{e13c0d23-ccbc-4e12-931b-d9cc2eee27e4}"/><TimeCreated SystemTime="2026-10-12T00:00:00Z"/><Execution ProcessID="' + processId + '"/></System><RenderingInfo><Task>GC</Task><Opcode>Start</Opcode></RenderingInfo></Event>'
const xml = '<Events>' + event(11) + event(22) + '</Events>'
writeFileSync(etlPath, 'ETL fixture')
let calls = 0
const driver = makeTrace({ evidenceDir: directory, tracerpt: process.execPath, runExe: async (exe, args) => {
  calls++
  const summaryIndex = args.indexOf('-summary')
  writeFileSync(args[summaryIndex >= 0 ? summaryIndex + 1 : args.indexOf('-o') + 1], summaryIndex >= 0 ? summary : xml)
  return { code: 0, stdout: '', stderr: '' }
} })

try {
  await test('CLR reuse skips both external decodes and reapplies PID filters', async () => {
    const first = await driver.clrEvents({ etlPath, xmlPath, pid: 11 })
    assert.equal(first.ok, true)
    assert.equal(first.reused, false)
    assert.equal(calls, 2)
    const second = await driver.clrEvents({ etlPath, xmlPath, reuse: true, pid: 22 })
    assert.equal(second.ok, true)
    assert.equal(second.reused, true)
    assert.equal(second.pid, 22)
    assert.equal(second.parsedEvents, 1)
    assert.equal(second.originalParsedEvents, 2)
    assert.equal(calls, 2)
    assert.equal((await driver.clrEvents({ etlPath, xmlPath })).state, 'output-exists')
  })

  await test('same-path changed ETL cannot reuse earlier XML', async () => {
    writeFileSync(etlPath, 'different ETL')
    const result = await driver.clrEvents({ etlPath, xmlPath, reuse: true })
    assert.equal(result.ok, false)
    assert.equal(result.state, 'cache-mismatch')
    assert.equal(calls, 2)
  })

  await test('actual decoded XML size is checked even when ETL estimate fits', async () => {
    writeFileSync(etlPath, 'x')
    const result = await driver.clrEvents({ etlPath, maxXmlMb: 0.0001 })
    assert.equal(result.state, 'xml-too-large')
    assert.ok(result.xmlBytes > result.maxXmlBytes)
  })

  await test('stream reader handles chunk boundaries and rejects bounded-memory violations', async () => {
    const path = join(directory, 'stream.xml')
    writeFileSync(path, '<Events>' + ' '.repeat(65531) + event(11) + event(22) + '</Events>')
    const result = await readClrEvents(path, { pid: 22, maxBytes: 100000 })
    assert.equal(result.events.length, 1)
    assert.equal(result.originalParsedEvents, 2)
    await assert.rejects(readClrEvents(path, { maxRetainedBytes: 20 }), /内存预算/)
    writeFileSync(path, '<Events><Event>' + 'x'.repeat(300))
    await assert.rejects(readClrEvents(path, { maxEventBytes: 30 }), /单条 XML/)
    writeFileSync(path, '<Events><Event><System>')
    await assert.rejects(readClrEvents(path), /不完整/)
  })
} finally { rmSync(directory, { recursive: true, force: true }) }
