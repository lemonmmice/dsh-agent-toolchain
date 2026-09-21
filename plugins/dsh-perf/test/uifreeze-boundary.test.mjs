import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePerf, perfViewEnvironment, runPerfExecutable } from '../lib/perf.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-uifreeze-boundary-'))
const successful = () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
const analysis = () => ({ sessionMs: 1000, freezeCount: 0, freezes: [], threads: [{ tid: 12, pid: 123 }], target: { tid: 12, pid: 123, process: 'Fixture' } })
const argument = (args, name) => args.find(value => value.startsWith('/' + name + ':'))?.slice(name.length + 2)

function fixture(name, behavior = {}) {
  const calls = []
  const evidenceDir = join(directory, name)
  const sessionFile = join(evidenceDir, 'uifreeze-pv-session.json')
  let analyzeCalls = 0
  const driver = makePerf({
    procName: 'Fixture', evidenceDir, perfView: process.execPath, uiFreezeStacks: process.execPath,
    runExe: async (executable, args, timeoutMs, options) => {
      calls.push({ executable, args, timeoutMs, options })
      if (['start', 'stop', 'abort'].includes(args[0])) {
        assert.match(argument(args, 'SessionName'), /^DSHUiFreeze-[0-9a-f-]{36}$/)
        assert.ok(options.env.PROCESSOR_ARCHITECTURE || options.env.processor_architecture)
      }
      if (args[0] === 'start') {
        if (behavior.startLog) writeFileSync(argument(args, 'LogFile'), behavior.startLog)
        return behavior.startResult || successful()
      }
      if (args[0] === 'abort') return behavior.abortResult || successful()
      if (args[0] === 'stop') {
        const etl = argument(args, 'DataFile')
        if (!behavior.noZip) {
          writeFileSync(etl + '.zip', 'fixture captured trace')
          if (behavior.oldZip) utimesSync(etl + '.zip', new Date(1), new Date(1))
        }
        if (behavior.oldAnalysis) writeFileSync(join(argument(args, 'DataFile'), '..', 'uifreeze.json'), JSON.stringify(analysis()))
        return behavior.stopResult || successful()
      }
      analyzeCalls++
      const output = argument(args, 'json')
      assert.equal(existsSync(output), false, 'old analysis must be removed before execution')
      if (!behavior.noAnalysis) writeFileSync(output, JSON.stringify(behavior.analysis ?? analysis()))
      return behavior.analyzeResult || successful()
    },
  })
  return { driver, calls, sessionFile, analyzeCalls: () => analyzeCalls }
}

try {
  const original = { unrelated: 'preserved' }
  assert.deepEqual(perfViewEnvironment(original, 'x86_64'), { unrelated: 'preserved', PROCESSOR_ARCHITECTURE: 'AMD64' })
  assert.deepEqual(original, { unrelated: 'preserved' })
  assert.equal(perfViewEnvironment({}, 'arm64').PROCESSOR_ARCHITECTURE, 'ARM64')
  assert.equal(perfViewEnvironment({}, 'i686').PROCESSOR_ARCHITECTURE, 'x86')
  assert.equal(perfViewEnvironment({}, 'unknown').PROCESSOR_ARCHITECTURE, undefined)
  const existing = { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'custom' }
  assert.deepEqual(perfViewEnvironment(existing, 'x86_64'), existing)
  assert.deepEqual(perfViewEnvironment({ processor_architecture: 'x86' }, 'x86_64'), { processor_architecture: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' })
  assert.equal(perfViewEnvironment({ PROCESSOR_ARCHITECTURE: 'ARM64' }, 'x86_64').PROCESSOR_ARCHITECTURE, 'ARM64')

  const eof = await runPerfExecutable(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("x".repeat(131072),()=>process.exit(7)))'], 5000)
  assert.equal(eof.timedOut, false)
  assert.equal(eof.code, 7)
  assert.equal(eof.stdout.length, 131072)
  const timeout = await runPerfExecutable(process.execPath, ['-e', 'console.log("progress-before-timeout");console.error("diagnostic-before-timeout");setInterval(()=>{},1000)'], 300)
  assert.equal(timeout.timedOut, true)
  assert.equal(timeout.code, null)
  assert.match(timeout.stdout, /progress-before-timeout/)
  assert.match(timeout.stderr, /diagnostic-before-timeout/)
  assert.match(timeout.stderr, /TIMEOUT/)

  const good = fixture('success')
  const started = await good.driver.uiFreeze({ action: 'start', process: 'Fixture' })
  assert.equal(started.ok, true)
  assert.equal(good.calls[0].args[0], 'start')
  assert.equal(good.calls.some(call => call.args[0] === 'abort'), false)
  const marker = JSON.parse(readFileSync(good.sessionFile, 'utf8'))
  assert.equal(marker.sessionName, started.sessionName)
  assert.equal(marker.state, 'running')
  const duplicate = await good.driver.uiFreeze({ action: 'start' })
  assert.equal(duplicate.alreadyRunning, true)
  assert.equal(good.calls.length, 1)
  const stopped = await good.driver.uiFreeze({ action: 'stop', pid: 123 })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.freezeCount, 0)
  assert.equal(stopped.target.pid, 123)
  assert.equal(good.analyzeCalls(), 1)
  assert.equal(existsSync(good.sessionFile), false)
  assert.equal(argument(good.calls[1].args, 'SessionName'), started.sessionName)
  const repeatStop = await good.driver.uiFreeze({ action: 'stop', pid: 123 })
  assert.equal(repeatStop.ok, false)
  assert.equal(good.calls.length, 3)

  const startup = fixture('start-failure', { startResult: { code: 1, stdout: 'start failed output', stderr: 'start stderr', timedOut: false }, startLog: 'ArgumentNullException path2 architecture failure' })
  const startFailure = await startup.driver.uiFreeze({ action: 'start' })
  assert.equal(startFailure.ok, false)
  assert.equal(startFailure.exitCode, 1)
  assert.match(startFailure.tail, /path2/)
  assert.match(startFailure.tail, /start stderr/)
  assert.equal(existsSync(startup.sessionFile), false)
  assert.equal(startup.calls[1].args[0], 'abort')
  assert.equal(argument(startup.calls[0].args, 'SessionName'), argument(startup.calls[1].args, 'SessionName'))

  const abortFailure = fixture('cleanup-failure', { startResult: { code: null, stdout: 'partial progress', stderr: '', timedOut: true }, abortResult: { code: 2, stdout: '', stderr: 'cleanup failed', timedOut: false } })
  const cleanupFailure = await abortFailure.driver.uiFreeze({ action: 'start' })
  assert.equal(cleanupFailure.ok, false)
  assert.equal(cleanupFailure.timedOut, true)
  assert.match(cleanupFailure.tail, /partial progress/)
  assert.equal(cleanupFailure.cleanup.ok, false)
  assert.equal(JSON.parse(readFileSync(abortFailure.sessionFile, 'utf8')).state, 'cleanup-required')

  for (const [name, behavior] of [
    ['stop-failed-with-zip', { stopResult: { code: 2, stdout: 'stop failure', stderr: '', timedOut: false } }],
    ['stop-timeout-with-zip', { stopResult: { code: null, stdout: 'stop partial', stderr: '', timedOut: true } }],
    ['stale-zip', { oldZip: true }],
    ['missing-zip', { noZip: true }],
  ]) {
    const current = fixture(name, behavior)
    assert.equal((await current.driver.uiFreeze({ action: 'start' })).ok, true)
    assert.equal((await current.driver.uiFreeze({ action: 'stop', pid: 123 })).ok, false)
    assert.equal(current.analyzeCalls(), 0)
  }
  for (const [name, behavior] of [
    ['analyzer-failed-with-json', { analyzeResult: { code: 3, stdout: '', stderr: 'analyzer failed', timedOut: false } }],
    ['analyzer-timeout-with-json', { analyzeResult: { code: null, stdout: 'partial analyzer', stderr: '', timedOut: true } }],
    ['old-analysis', { oldAnalysis: true, noAnalysis: true }],
    ['empty-analysis', { analysis: {} }],
    ['false-analysis', { analysis: { ...analysis(), ok: false } }],
  ]) {
    const current = fixture(name, behavior)
    assert.equal((await current.driver.uiFreeze({ action: 'start' })).ok, true)
    const result = await current.driver.uiFreeze({ action: 'stop', pid: 123 })
    assert.equal(result.ok, false, name)
    assert.equal(current.analyzeCalls(), 1)
  }
  console.log('PASS uiFreeze boundaries: EOF-safe native runner, retained timeout output, architecture environment, owned sessions, duplicate start, failed/stale collection and analysis rejection')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
