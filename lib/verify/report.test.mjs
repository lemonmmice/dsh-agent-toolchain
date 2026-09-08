// lib/verify/report.test.mjs — verification-report self-test:
// evidence adjudication (build/api/file/manual), verdicts, auto-record of
// agent-misjudge, runId sanitize, opt-out. Temp dirs only, no network.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeVerificationReport, sanitizeRunId, adjudicateClaim } from './report.mjs'
import { makeFailureCorpus } from '../failure-corpus.mjs'
import { appendRecords } from '../capture-store.mjs'

const reportsDir = mkdtempSync(join(tmpdir(), 'verify-'))
const corpusDir = mkdtempSync(join(tmpdir(), 'verify-corpus-'))
const logsDir = mkdtempSync(join(tmpdir(), 'verify-logs-'))
const captureDir = mkdtempSync(join(tmpdir(), 'verify-cap-'))
process.env.DSH_VERIFY_DIR = reportsDir
process.env.DSH_FAILURE_CORPUS_DIR = corpusDir
process.env.DSH_BUILD_LOGS_DIR = logsDir
process.env.DSH_API_CAPTURE_STORE = captureDir

// seed evidence: build records + capture records
mkdirSync(logsDir, { recursive: true })
writeFileSync(join(logsDir, 'run-pass.json'), JSON.stringify({ ok: true, target: 'Build', logPath: 'build-pass.log' }))
writeFileSync(join(logsDir, 'run-fail.json'), JSON.stringify({ ok: false, target: 'Build', errorCount: 2, codeErrorCount: 2, logPath: 'build-fail.log' }))
const base = Date.now()
appendRecords([
  { id: 'c1', ts: base, method: 'GET', url: 'https://api.example.com/v1/ok', status: 200 },
  { id: 'c2', ts: base + 100, method: 'GET', url: 'https://api.example.com/v1/bad', status: 500 },
], { runId: 'api-run' })

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}
const throws = (fn, msg) => {
  try {
    fn()
    failures++
    console.error('  FAIL - ' + msg + ' (did not throw)')
  } catch {
    console.log('  ok - ' + msg + ' (rejected)')
  }
}

// ---- kind=build: adjudicated from the build record, not self-rated
const b1 = makeVerificationReport({
  runId: 'build-pass-case',
  task: 't1',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'pass' }],
})
ok(b1.verdict === 'pass' && b1.recorded === 0, 'build claim adjudicated pass from build record')

const b2 = makeVerificationReport({
  runId: 'build-fail-case',
  task: 't2',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'fail' }],
})
ok(b2.verdict === 'fail' && b2.mismatchCount === 1 && b2.recorded === 1, 'build claim adjudicated fail -> verdict fail + auto-record')

const b3 = makeVerificationReport({
  runId: 'build-missing-case',
  task: 't3',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'no-such-run' }],
})
ok(b3.verdict === 'incomplete', 'missing build record -> unverified -> incomplete')

// ---- kind=api: adjudicated from the capture store
const a1 = makeVerificationReport({
  runId: 'api-2xx-case',
  task: 't4',
  claims: [{ statement: 'the page fires the API', kind: 'api', runId: 'api-run', filter: { host: 'api.example.com' }, expect: { min: 1, all2xx: true } }],
})
ok(a1.verdict === 'fail' && a1.mismatchCount === 1 && a1.recorded === 1, 'api claim with a 500 in evidence -> fail + auto-record')

const a2 = makeVerificationReport({
  runId: 'api-min-case',
  task: 't5',
  claims: [{ statement: 'the page fires the API', kind: 'api', runId: 'api-run', filter: { host: 'api.example.com' }, expect: { min: 2 } }],
})
ok(a2.verdict === 'pass', 'api claim min=2 matches -> pass')

const a3 = makeVerificationReport({
  runId: 'api-no-match-case',
  task: 't6',
  claims: [{ statement: 'the page fires a ghost API', kind: 'api', runId: 'api-run', filter: { host: 'ghost.example.com' } }],
})
ok(a3.verdict === 'fail' && a3.recorded === 1, 'no match while store has records -> contradiction -> fail')

const emptyCap = mkdtempSync(join(tmpdir(), 'verify-cap-empty-'))
process.env.DSH_API_CAPTURE_STORE = emptyCap
const a4 = makeVerificationReport({
  runId: 'api-empty-case',
  task: 't7',
  claims: [{ statement: 'the page fires an API', kind: 'api', filter: { host: 'x.example.com' } }],
})
ok(a4.verdict === 'incomplete' && a4.mismatchCount === 0, 'empty capture store -> unverified, not a contradiction')
process.env.DSH_API_CAPTURE_STORE = captureDir

// ---- kind=file
const artifact = join(reportsDir, 'shot.png')
writeFileSync(artifact, 'fake')
const f1 = makeVerificationReport({
  runId: 'file-case',
  task: 't8',
  claims: [
    { statement: 'screenshot exists', kind: 'file', path: artifact },
    { statement: 'log exists', kind: 'file', path: join(reportsDir, 'nope.log') },
  ],
})
ok(f1.verdict === 'fail' && f1.counts.pass === 1 && f1.counts.fail === 1, 'file check: exists=pass, missing=fail')

// ---- kind=manual: explicit opt-out (backwards compatible with old shape)
const m1 = makeVerificationReport({
  runId: 'manual-case',
  task: 't9',
  claims: [{ statement: 'visual check', status: 'fail', evidence: 'human says no' }],
})
ok(m1.verdict === 'fail' && m1.recorded === 1, 'manual claim (legacy shape) still adjudicates + records')

const m2 = makeVerificationReport({
  runId: 'manual-optout-case',
  task: 't10',
  claims: [{ statement: 'x', status: 'fail' }],
  recordFailures: false,
})
ok(m2.recorded === 0 && m2.mismatchCount === 1, 'recordFailures=false opt-out works')

// ---- kind=git / kind=gate (offline cases)
const gitRepo = mkdtempSync(join(tmpdir(), 'verify-git-'))
execFileSync('git', ['init', '-q', gitRepo])
writeFileSync(join(gitRepo, 'a.txt'), 'x')
execFileSync('git', ['-C', gitRepo, 'add', '-A'])
execFileSync('git', ['-C', gitRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

const g1 = makeVerificationReport({
  runId: 'git-clean-case',
  task: 't11',
  claims: [{ statement: 'working tree clean', kind: 'git', repo: gitRepo, check: 'clean' }],
})
ok(g1.verdict === 'pass', 'git clean check -> pass')

writeFileSync(join(gitRepo, 'b.txt'), 'dirty')
const g2 = makeVerificationReport({
  runId: 'git-dirty-case',
  task: 't12',
  claims: [{ statement: 'working tree clean', kind: 'git', repo: gitRepo, check: 'clean' }],
})
ok(g2.verdict === 'fail' && g2.recorded === 1, 'dirty tree -> fail + auto-record')

const g3 = makeVerificationReport({
  runId: 'git-pushed-no-remote-case',
  task: 't13',
  claims: [{ statement: 'pushed', kind: 'git', repo: gitRepo, check: 'pushed' }],
})
ok(g3.verdict === 'incomplete' && g3.mismatchCount === 0, 'pushed check without remote -> unverified, not a contradiction')

const ga1 = makeVerificationReport({
  runId: 'gate-pass-case',
  task: 't14',
  claims: [{ statement: 'sanity gate green', kind: 'gate', cmd: 'node -e "process.exit(0)"' }],
})
ok(ga1.verdict === 'pass', 'gate exit 0 -> pass')

const ga2 = makeVerificationReport({
  runId: 'gate-fail-case',
  task: 't15',
  claims: [{ statement: 'sanity gate green', kind: 'gate', cmd: 'node -e "process.exit(1)"' }],
})
ok(ga2.verdict === 'fail' && ga2.recorded === 1, 'gate exit 1 -> fail + auto-record')

// vacuous gates: exit 0 with zero tests executed must NOT pass
const ga3 = makeVerificationReport({
  runId: 'gate-vacuous-en',
  task: 'gate vacuous en',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('No test matches the given testcase filter.')\"" }],
  recordFailures: false,
})
ok(ga3.verdict === 'fail' && ga3.counts.fail === 1, 'gate exit 0 + no-test-match -> fail')
const ga4 = makeVerificationReport({
  runId: 'gate-vacuous-cn',
  task: 'gate vacuous cn',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('已通过! - 失败: 0，通过: 0，总计: 0')\"" }],
  recordFailures: false,
})
ok(ga4.verdict === 'fail', 'gate exit 0 + 0/0 CN summary -> fail')
const ga5 = makeVerificationReport({
  runId: 'gate-real-pass',
  task: 'gate real pass',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('Passed! - Failed: 0, Passed: 4, Skipped: 0, Total: 4')\"" }],
  recordFailures: false,
})
ok(ga5.verdict === 'pass' && ga5.counts.pass === 1, 'gate exit 0 + real test counts -> still pass')

// vacuous detail: names the matched pattern + keeps the full failure tail
const vacDetail = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('Running tests...\\nNo test matches the given testcase filter: Foo.Bar\\nDone.')\"" })
ok(vacDetail.status === 'fail' && vacDetail.detail.includes('no-test-matches (EN)') && vacDetail.detail.includes('Foo.Bar'), 'vacuous gate detail names the pattern and keeps the tail')
// real failure detail: the 6-line tail shows the failing assertion
const failDetail = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('L1\\nL2\\nL3\\nL4\\nL5\\nAssertion failed: expected 2 got 3'); process.exit(1)\"" })
ok(failDetail.status === 'fail' && failDetail.detail.includes('Assertion failed'), 'real gate failure keeps the failing line in the tail')

// ---- misc
ok(sanitizeRunId('a\\b/c:d') === 'a_b_c_d', 'sanitizeRunId strips separators')
throws(() => makeVerificationReport({}), 'missing runId/task rejected')

const corpus = makeFailureCorpus({})
const auto = corpus.query({ q: 'claim contradicted by evidence' })
ok(auto.total >= 3, 'adjudicated mismatches auto-recorded as agent-misjudge')
ok(auto.rows.every((r) => r.failureClass === 'agent-misjudge' && r.tags.includes('auto')), 'auto records carry class + tag')

const saved = JSON.parse(readFileSync(join(reportsDir, 'build-fail-case.json'), 'utf8'))
ok(saved.verdict === 'fail' && saved.claims[0].status === 'fail' && saved.claims[0].check === 'build' && typeof saved.claims[0].detail === 'string', 'report JSON carries adjudication detail')

rmSync(reportsDir, { recursive: true, force: true })
rmSync(corpusDir, { recursive: true, force: true })
rmSync(logsDir, { recursive: true, force: true })
rmSync(captureDir, { recursive: true, force: true })
rmSync(emptyCap, { recursive: true, force: true })
rmSync(gitRepo, { recursive: true, force: true })
delete process.env.DSH_VERIFY_DIR
delete process.env.DSH_FAILURE_CORPUS_DIR
delete process.env.DSH_BUILD_LOGS_DIR
delete process.env.DSH_API_CAPTURE_STORE

if (failures > 0) {
  console.error(`\nVERIFY-REPORT TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nVERIFY-REPORT TEST PASSED')
