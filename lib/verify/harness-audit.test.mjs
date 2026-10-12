import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeVerificationReport, adjudicateClaim, sanitizeRunId } from './report.mjs'
import { checkCompileMembership } from '../compile-membership.mjs'
import { makeBuilder } from '../../plugins/dsh-build/lib/builder.mjs'
import { execFileSync } from 'node:child_process'
import { sourceIdentity, fileDigest } from '../build-evidence.mjs'
import { appendRecords, getCaptureStorage } from '../capture-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'verify-audit-'))
const logsDir = join(root, 'logs')
mkdirSync(logsDir)
process.env.DSH_VERIFY_DIR = join(root, 'reports')
process.env.DSH_BUILD_LOGS_DIR = logsDir
process.env.DSH_API_CAPTURE_STORE = join(root, 'captures')
process.env.DSH_FAILURE_CORPUS_DIR = join(root, 'failures')
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

test('manual acceptance does not count as independently verified', async () => {
  const result = await makeVerificationReport({ runId: 'manual', task: 'manual', recordFailures: false, claims: [{ kind: 'manual', status: 'pass' }] })
  assert.equal(result.verdict, 'incomplete')
  assert.equal(result.verifiedVerdict, 'incomplete')
  assert.equal(result.acceptance, 'pass')
})

test('historic build success without current source evidence cannot pass', async () => {
  writeFileSync(join(logsDir, 'run-stale.json'), JSON.stringify({ runId: 'stale', at: '2000-01-01T00:00:00Z', ok: true, repoRoot: root, logPath: 'missing.log' }))
  const result = await adjudicateClaim({ kind: 'build', runId: 'stale', repo: root })
  assert.equal(result.status, 'unverified')
})

for (const [name, xml, filename] of [
  ['comment', '<Project><!-- <Compile Include="A.cs" /> --></Project>', 'A.cs'],
  ['condition', '<Project><ItemGroup Condition="false"><Compile Include="A.cs" /></ItemGroup></Project>', 'A.cs'],
  ['sdk-text', '<Project Sdk="Microsoft.NET.Sdk" />', 'README.txt'],
]) {
  test(`compile heuristic does not falsely certify ${name}`, async () => {
    const directory = join(root, name)
    mkdirSync(directory)
    const projectPath = join(directory, 'Test.csproj')
    const sourcePath = join(directory, filename)
    writeFileSync(projectPath, xml)
    writeFileSync(sourcePath, '')
    const membership = checkCompileMembership(sourcePath, { projectPath, repoRoot: directory })
    assert.notEqual(membership.included, true)
    const claim = await adjudicateClaim({ kind: 'compiled', path: sourcePath, project: projectPath, repoRoot: directory })
    assert.notEqual(claim.status, 'pass')
  })
}

test('same-tick builds receive different run IDs', async () => {
  const builder = makeBuilder({ logsDir, repoRoot: join(root, 'missing') })
  const results = await Promise.all(Array.from({ length: 3 }, () => builder.build()))
  assert.equal(new Set(results.map((result) => result.runId)).size, 3)
})

test('builder and verifier share run ID normalization and status uses selected run', async () => {
  const builder = makeBuilder({ logsDir, repoRoot: join(root, 'missing') })
  const supplied = 'a'.repeat(65)
  const selected = await builder.build({ runId: supplied })
  await builder.build({ runId: 'later' })
  assert.equal(selected.runId, sanitizeRunId(supplied))
  assert.equal(builder.status({ runId: supplied }).runId, selected.runId)
  assert.equal(builder.status({ runId: 'does-not-exist' }).hasRun, false)
  assert.notEqual(sanitizeRunId('a'.repeat(90) + '1'), sanitizeRunId('a'.repeat(90) + '2'))
})

test('gate wait leaves event loop responsive', async () => {
  const started = Date.now()
  let heartbeatAt = null
  const heartbeat = setTimeout(() => { heartbeatAt = Date.now() - started }, 20)
  const gate = await adjudicateClaim({ kind: 'gate', cmd: 'node -e "setTimeout(() => process.exit(0), 350)"' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  clearTimeout(heartbeat)
  assert.equal(gate.status, 'pass')
  assert.ok(heartbeatAt < 200, `heartbeat blocked for ${heartbeatAt} ms`)
})

test('gate timeout does not certify success', async () => {
  const started = Date.now()
  const gate = await adjudicateClaim({ kind: 'gate', cmd: 'node -e "setTimeout(() => process.exit(0), 350)"', timeoutMs: 40 })
  assert.equal(gate.status, 'unverified')
  assert.equal(gate.timedOut, true)
  assert.ok(Date.now() - started < 1000)
})

test('gate observes pre-aborted cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  const gate = await adjudicateClaim({ kind: 'gate', cmd: 'node -e "process.exit(0)"' }, { signal: controller.signal })
  assert.equal(gate.status, 'unverified')
  assert.equal(gate.aborted, true)
})

test('gate stops on in-flight cancellation', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 40)
  const gate = await adjudicateClaim({ kind: 'gate', cmd: 'node -e "setTimeout(() => process.exit(0), 350)"' }, { signal: controller.signal })
  assert.equal(gate.status, 'unverified')
  assert.equal(gate.aborted, true)
})

test('successful build evidence is bound to source and log content', async () => {
  const repo = join(root, 'source-repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo], { windowsHide: true })
  const sourcePath = join(repo, 'File.cs')
  writeFileSync(sourcePath, 'class Before {}')
  const source = await sourceIdentity(repo)
  const logPath = join(logsDir, 'identified.log')
  writeFileSync(logPath, 'Build succeeded.')
  const record = { runId: 'identified', repoRoot: repo, logPath, at: new Date().toISOString(), ok: true, exitCode: 0, evidenceManifest: { version: 1, source, sourceAfter: source, logSha256: await fileDigest(logPath) } }
  writeFileSync(join(logsDir, 'run-identified.json'), JSON.stringify(record))
  const before = await adjudicateClaim({ kind: 'build', runId: 'identified', repo })
  assert.equal(before.status, 'pass')
  writeFileSync(sourcePath, 'class After {}')
  assert.equal((await adjudicateClaim({ kind: 'build', runId: 'identified', repo })).status, 'unverified')
  writeFileSync(sourcePath, 'class Before {}')
  writeFileSync(logPath, 'replaced log')
  assert.equal((await adjudicateClaim({ kind: 'build', runId: 'identified', repo })).status, 'unverified')
})

test('job lookup preserves the selected attempt after the run alias changes', () => {
  const builder = makeBuilder({ logsDir })
  writeFileSync(join(logsDir, 'run-shared.json'), JSON.stringify({ runId: 'shared', attemptId: 'second', ok: true }))
  writeFileSync(join(logsDir, 'bg-first-job.json'), JSON.stringify({ jobId: 'first-job', runId: 'shared', state: 'failed', result: { runId: 'shared', attemptId: 'first', ok: false } }))
  assert.equal(builder.status({ jobId: 'first-job' }).attemptId, 'first')
  assert.equal(builder.status({ jobId: 'missing-job' }).hasRun, false)
})

test('API verification separates imported and observed evidence', async () => {
  appendRecords([{ id: 'imported', method: 'GET', url: 'https://example.com/api', status: 200, evidenceLevel: 'observed', runId: 'api-import' }])
  const imported = await adjudicateClaim({ kind: 'api', runId: 'api-import' })
  assert.equal(imported.status, 'unverified')
  assert.equal(imported.evidenceLevel, 'imported')
  getCaptureStorage().append([{ id: 'observed', ts: Date.now(), method: 'GET', url: 'https://example.com/api', status: 200, evidenceLevel: 'observed', runId: 'api-observed' }])
  assert.equal((await adjudicateClaim({ kind: 'api', runId: 'api-observed' })).status, 'pass')
  assert.equal((await adjudicateClaim({ kind: 'api', runId: 'api-missing' })).status, 'unverified')
})

test('background jobs with the same run label retain distinct terminal results', async () => {
  const builder = makeBuilder({ logsDir, repoRoot: join(root, 'missing-background') })
  const first = builder.startBackground({ runId: 'same-label' })
  const second = builder.startBackground({ runId: 'same-label' })
  assert.notEqual(first.jobId, second.jobId)
  const deadline = Date.now() + 5000
  let firstState
  let secondState
  do {
    await new Promise((resolve) => setTimeout(resolve, 30))
    firstState = builder.status({ jobId: first.jobId })
    secondState = builder.status({ jobId: second.jobId })
  } while ((!firstState.hasRun || !secondState.hasRun) && Date.now() < deadline)
  assert.equal(firstState.hasRun, true, JSON.stringify(firstState))
  assert.equal(secondState.hasRun, true, JSON.stringify(secondState))
  assert.notEqual(firstState.attemptId, secondState.attemptId)
  assert.equal(firstState.didNotRun, true)
  assert.equal(secondState.didNotRun, true)
  assert.equal((await adjudicateClaim({ kind: 'build', runId: first.runId, attemptId: firstState.attemptId })).status, 'fail')
})
