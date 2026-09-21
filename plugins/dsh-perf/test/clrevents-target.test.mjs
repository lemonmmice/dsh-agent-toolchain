import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseClrEvents, summarizeClr } from '../lib/clr-events.mjs'
import { makeTrace } from '../lib/trace.mjs'
import { renderClrEvents } from '../lib/render.mjs'

function event(processId, milliseconds, opcode, payload = '', runtime = 1, task = 'GC') {
  return `<Event><System><Provider Guid="{e13c0d23-ccbc-4e12-931b-d9cc2eee27e4}"/><TimeCreated SystemTime="${new Date(Date.UTC(2026, 8, 21) + milliseconds).toISOString()}"/><Execution ProcessID="${processId}" ThreadID="100"/></System><UserData><Payload><ClrInstanceID>${runtime}</ClrInstanceID>${payload}</Payload></UserData><RenderingInfo><Task>${task}</Task><Opcode>${opcode}</Opcode></RenderingInfo></Event>`
}
const xml = '<Events>' + [
  event(11, 0, 'SuspendEEStart'),
  event(22, 2, 'SuspendEEStart'),
  event(11, 3, 'Start', '<Depth>0</Depth><Reason>0</Reason>'),
  event(22, 4, 'Start', '<Depth>2</Depth><Reason>1</Reason>'),
  event(11, 5, 'RestartEEStop'),
  event(22, 8, 'RestartEEStop'),
  event(11, 9, 'HeapStats', '<GenerationSize0>111</GenerationSize0>'),
  event(22, 10, 'HeapStats', '<GenerationSize0>999</GenerationSize0>'),
  event(22, 11, 'Start', '', 1, 'Contention'),
  event(11, 12, 'Start', '', 1, 'Contention'),
].join('') + '</Events>'
const parsed = parseClrEvents(xml)
assert.equal(parsed.length, 10)
assert.deepEqual([...new Set(parsed.map(row => row.processId))], [11, 22])
assert.ok(parsed.every(row => row.clrInstanceId === 1))
const all = summarizeClr(parsed)
assert.equal(all.gcCount, 2)
assert.equal(all.pauseMs.count, 2)
assert.equal(all.pauseMs.totalMs, 11)
assert.equal(all.pauseMs.maxMs, 6)
assert.deepEqual(all.topPauses.map(pause => [pause.processId, pause.ms]), [[22, 6], [11, 5]])
assert.equal(all.heapProcessId, 22)
assert.equal(all.heap.gen0, 999)

const sameProcess = parseClrEvents('<Events>' + [
  event(11, 0, 'SuspendEEStart', '', 1), event(11, 2, 'SuspendEEStart', '', 2),
  event(11, 5, 'RestartEEStop', '', 1), event(11, 8, 'RestartEEStop', '', 2),
].join('') + '</Events>')
assert.equal(summarizeClr(sameProcess).pauseMs.totalMs, 11)
assert.equal(summarizeClr(sameProcess).pauseMs.count, 2)
const unmatched = parseClrEvents('<Events>' + event(11, 0, 'SuspendEEStart') + event(22, 5, 'RestartEEStop') + '</Events>')
assert.equal(summarizeClr(unmatched).pauseMs.count, 0)

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clr-target-'))
const etlPath = path.join(directory, 'sample.etl')
const tracerpt = path.join(directory, 'tracerpt-fixture.exe')
fs.writeFileSync(etlPath, 'ETL fixture')
fs.writeFileSync(tracerpt, '')
let calls = 0
const trace = makeTrace({
  tracerpt, evidenceDir: directory,
  runExe: async (_executable, argumentsList) => {
    calls++
    if (argumentsList.includes('-summary')) {
      const summaryPath = argumentsList[argumentsList.indexOf('-summary') + 1]
      const fixture = fileURLToPath(new URL('./fixtures/clr-summary.txt', import.meta.url))
      fs.copyFileSync(fixture, summaryPath)
    } else fs.writeFileSync(argumentsList[argumentsList.indexOf('-o') + 1], xml)
    return { code: 0, stdout: '', stderr: '' }
  },
})
try {
  const machine = await trace.clrEvents({ etlPath })
  assert.equal(machine.ok, true, JSON.stringify(machine))
  assert.equal(machine.scope, 'machine-wide')
  assert.equal(machine.pid, null)
  assert.equal(machine.originalParsedEvents, 10)
  assert.equal(machine.parsedEvents, 10)
  assert.equal(machine.filteredEvents, 10)
  assert.equal(machine.excludedEvents, 0)
  assert.deepEqual(machine.availableProcessIds, [11, 22])
  assert.equal(machine.pauseMs.totalMs, 11)
  assert.match(renderClrEvents(machine), /machine-wide/)
  assert.match(renderClrEvents(machine), /不是整机共同冻结时长/)

  const target = await trace.clrEvents({ etlPath, pid: '11' })
  assert.equal(target.ok, true, JSON.stringify(target))
  assert.equal(target.scope, 'process')
  assert.equal(target.pid, 11)
  assert.equal(target.originalParsedEvents, 10)
  assert.equal(target.filteredEvents, 5)
  assert.equal(target.parsedEvents, 5)
  assert.equal(target.excludedEvents, 5)
  assert.equal(target.gcCount, 1)
  assert.equal(target.pauseMs.count, 1)
  assert.equal(target.pauseMs.totalMs, 5)
  assert.equal(target.heap.gen0, 111)
  assert.equal(target.heapProcessId, 11)
  assert.equal(target.contentionCount, 1)
  assert.ok(target.topPauses.every(pause => pause.processId === 11))
  assert.match(renderClrEvents(target), /仅 PID 11/)
  assert.match(renderClrEvents(target), /过滤前 10 \/ 过滤后 5/)
  assert.match(renderClrEvents(target), /尾值，PID 11/)

  const absent = await trace.clrEvents({ etlPath, pid: '33' })
  assert.equal(absent.ok, false)
  assert.equal(absent.state, 'not-captured-for-target')
  assert.equal(absent.scope, 'process')
  assert.equal(absent.pid, 33)
  assert.equal(absent.originalParsedEvents, 10)
  assert.equal(absent.filteredEvents, 0)
  assert.equal(Object.hasOwn(absent, 'gcCount'), false)
  assert.equal(Object.hasOwn(absent, 'pauseMs'), false)
  assert.equal(Object.hasOwn(absent, 'noGcInWindow'), false)
  assert.match(renderClrEvents(absent), /未知，不是 0/)
  assert.doesNotMatch(renderClrEvents(absent), /GC：共 0 次/)

  const beforeInvalid = calls
  for (const pid of ['11,22', 'all', '0', '-1', '4294967296', '1.5', ' ']) {
    assert.equal((await trace.clrEvents({ etlPath, pid })).state, 'invalid-pid', pid)
  }
  assert.equal(calls, beforeInvalid)
  console.log('PASS CLR target scope: PID/runtime pause pairing, filtered metrics, missing target and rendered scope')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
