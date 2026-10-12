import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePerf } from '../lib/perf.mjs'
import { makeTrace } from '../lib/trace.mjs'
import { cleanEvidence } from '../lib/evidence-clean.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-perf-harness-'))
const success = () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
const failure = () => ({ code: 1, stdout: '', stderr: 'injected failure', timedOut: false })
const dumpData = label => ({ dump: label, threads: [{ managedId: 42, osId: 42, uiLikely: true, frames: [] }] })

function traceFixture(name, behavior = {}) {
  const evidenceDir = join(directory, name)
  const calls = []
  const driver = makeTrace({
    evidenceDir, kernelLeaseFile: join(directory, name + '-kernel.json'),
    wpr: process.execPath, xperf: process.execPath, logman: process.execPath,
    runExe: async (exe, args) => {
      calls.push(args)
      if (args.includes('-Command')) return { ...success(), stdout: 'True' }
      if (behavior.runExe) return behavior.runExe(exe, args)
      if (args[0] === '-stop' && args[1]?.endsWith('.etl')) writeFileSync(args[1], 'captured fixture')
      return success()
    },
  })
  return { driver, calls, evidenceDir }
}

try {
  await test('failed analyzers cannot return old JSON or valid-looking stdout as success', async () => {
    const dumpPath = join(directory, 'stale.dmp')
    writeFileSync(dumpPath, 'dump')
    const oldPath = join(directory, 'stale.analysis.json')
    writeFileSync(oldPath, JSON.stringify(dumpData('OLD')))
    const driver = makePerf({
      evidenceDir: directory, dumpstack: process.execPath, heapRoots: process.execPath,
      runExe: async () => ({ ...failure(), stdout: JSON.stringify({ ...dumpData('OLD'), ok: true, top: [] }) }),
    })
    for (const result of [await driver.analyzeDump(dumpPath), await driver.heapStats(dumpPath), await driver.gcRoots(dumpPath)]) {
      assert.equal(result.ok, false)
      assert.equal(result.exitCode, 1)
    }
    assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).dump, 'OLD')
  })

  await test('concurrent dump analysis keeps separate artifacts and preserves non-dmp inputs', async () => {
    const dumpPath = join(directory, 'snapshot.bin')
    writeFileSync(dumpPath, 'untouched input')
    let analyses = 0
    const driver = makePerf({ evidenceDir: directory, dumpstack: process.execPath, runExe: async (exe, args) => {
      if (args[0] === 'dacinfo') return failure()
      analyses++
      const label = String(analyses)
      await new Promise(resolve => setTimeout(resolve, analyses === 1 ? 20 : 1))
      writeFileSync(args[1], JSON.stringify(dumpData(label)))
      return success()
    } })
    const results = await Promise.all([driver.analyzeDump(dumpPath), driver.analyzeDump(dumpPath)])
    assert.ok(results.every(result => result.ok))
    assert.notEqual(results[0].outPath, results[1].outPath)
    assert.deepEqual(results.map(result => result.dump), ['1', '2'])
    assert.equal(readFileSync(dumpPath, 'utf8'), 'untouched input')
  })

  await test('Windows junctions are excluded before evidence enumeration and deletion', () => {
    const evidence = join(directory, 'evidence')
    const outside = join(directory, 'outside')
    mkdirSync(evidence)
    mkdirSync(outside)
    const retained = join(outside, 'outside.dmp')
    writeFileSync(retained, 'retain')
    const junction = join(evidence, 'trace-junction')
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const dryRun = cleanEvidence({ dir: evidence })
      assert.equal(dryRun.candidates.length, 0)
      assert.ok(dryRun.skipped.some(item => item.path === junction))
      assert.equal(cleanEvidence({ dir: evidence, confirm: true, planId: dryRun.planId }).deleted.length, 0)
      assert.equal(readFileSync(retained, 'utf8'), 'retain')
    } finally { rmSync(junction) }
  })

  await test('cleanup confirmation is bound to the inspected file identities', () => {
    const evidence = join(directory, 'planned-clean')
    mkdirSync(evidence)
    const dumpPath = join(evidence, 'sample.dmp')
    writeFileSync(dumpPath, 'original')
    const plan = cleanEvidence({ dir: evidence })
    assert.equal(cleanEvidence({ dir: evidence, confirm: true }).ok, false)
    writeFileSync(dumpPath, 'replacement after review')
    const changed = cleanEvidence({ dir: evidence, confirm: true, planId: plan.planId })
    assert.equal(changed.ok, false)
    assert.equal(existsSync(dumpPath), true)
    assert.equal(cleanEvidence({ dir: evidence, confirm: true, planId: changed.planId }).deleted.length, 1)
  })

  await test('explicit evidence-root junction is allowed while nested junctions stay excluded', () => {
    const target = join(directory, 'configured-root-target')
    const evidence = join(directory, 'configured-root-link')
    mkdirSync(target)
    const dumpPath = join(target, 'sample.dmp')
    writeFileSync(dumpPath, 'owned evidence')
    symlinkSync(target, evidence, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const plan = cleanEvidence({ dir: evidence })
      assert.equal(plan.ok, true)
      assert.equal(plan.candidates.length, 1)
      assert.equal(cleanEvidence({ dir: evidence, confirm: true, planId: plan.planId }).deleted.length, 1)
    } finally { rmSync(evidence) }
  })

  await test('unreadable or active trace and UI-freeze markers preserve ETL evidence', () => {
    const evidence = join(directory, 'marker-boundaries')
    mkdirSync(evidence)
    const etlPath = join(evidence, 'sample.etl')
    writeFileSync(etlPath, 'capture in progress')
    for (const name of ['trace-session.json', 'uifreeze-pv-session.json', 'uifreeze-session.json']) {
      const marker = join(evidence, name)
      for (const content of ['{broken', JSON.stringify({ state: 'starting' })]) {
        writeFileSync(marker, content)
        const plan = cleanEvidence({ dir: evidence })
        assert.equal(plan.candidates.length, 0, name + ': ' + content)
        const confirmed = cleanEvidence({ dir: evidence, confirm: true, planId: plan.planId })
        assert.equal(confirmed.deleted.length, 0)
        assert.equal(existsSync(etlPath), true)
      }
      rmSync(marker)
    }
  })

  await test('failed WPR preflight never cancels another session or starts fallback capture', async () => {
    const fixture = traceFixture('busy-preflight', { runExe: async () => failure() })
    const result = await fixture.driver.trace({ action: 'start' })
    assert.equal(result.ok, false)
    assert.equal(result.busy, true)
    assert.ok(!fixture.calls.some(args => args[0] === '-cancel' || args[0] === '-on'))
  })

  await test('unowned stop does not issue ETW commands', async () => {
    const fixture = traceFixture('unowned')
    const result = await fixture.driver.trace({ action: 'stop' })
    assert.equal(result.ok, false)
    assert.ok(!fixture.calls.some(args => ['-stop', '-cancel', 'stop'].includes(args[0])))
  })

  await test('capture uses exclusive leases and unique owned auxiliary sessions', async () => {
    const fixture = traceFixture('owned')
    const started = await fixture.driver.trace({ action: 'start', skipPreflight: true, clr: true, jit: true, alloc: true })
    assert.equal(started.ok, true)
    const names = [started.clr.session, started.jit.session, started.alloc.session]
    assert.ok(names.every(name => /^dshperf(clr|jit|alloc)-[0-9a-f-]{36}$/.test(name)))
    assert.ok(!fixture.calls.some(args => ['stop', '-stop', '-cancel'].includes(args[0])))
    const competing = await fixture.driver.trace({ action: 'start', skipPreflight: true })
    assert.equal(competing.ok, false)
    assert.equal(competing.busy, true)
    const stopped = await fixture.driver.trace({ action: 'stop' })
    assert.equal(stopped.ok, true)
    assert.ok(names.every(name => fixture.calls.some(args => ['stop', '-stop'].includes(args[0]) && args[1] === name)))
    assert.equal(existsSync(join(fixture.evidenceDir, 'trace-session.json')), false)
  })
} finally { rmSync(directory, { recursive: true, force: true }) }
