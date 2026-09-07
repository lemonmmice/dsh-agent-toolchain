// lib/verify/report.test.mjs — verification-report self-test:
// verdicts, report persistence, auto-record of agent-misjudge, runId sanitize.
// Runs on temp dirs via DSH_VERIFY_DIR / DSH_FAILURE_CORPUS_DIR; no network.
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeVerificationReport, sanitizeRunId } from './report.mjs'
import { makeFailureCorpus } from '../failure-corpus.mjs'

const reportsDir = mkdtempSync(join(tmpdir(), 'verify-'))
const corpusDir = mkdtempSync(join(tmpdir(), 'verify-corpus-'))
process.env.DSH_VERIFY_DIR = reportsDir
process.env.DSH_FAILURE_CORPUS_DIR = corpusDir

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

const r1 = makeVerificationReport({
  runId: 'task-2/toolchain..1',
  task: 'fix case-insensitive search',
  claims: [
    { statement: 'build passes', status: 'pass', evidence: 'build_run: 0 errors' },
    { statement: 'search is case-insensitive', status: 'fail', evidence: 'unit test Search_CaseInsensitive failed' },
  ],
})
ok(r1.verdict === 'fail' && r1.mismatchCount === 1 && r1.recorded === 1, 'failed claim -> fail verdict + auto-record')
ok(r1.runId === 'task-2_toolchain..1', 'runId sanitized for the filename')
ok(existsSync(join(reportsDir, 'task-2_toolchain..1.json')), 'report file written')

const corpus = makeFailureCorpus({})
const auto = corpus.query({ q: 'claim failed' })
ok(auto.total === 1 && auto.rows[0].failureClass === 'agent-misjudge', 'agent-misjudge landed in the failure corpus')
ok(auto.rows[0].tags.includes('auto') && auto.rows[0].tags.includes('verify'), 'auto record is tagged')

const r2 = makeVerificationReport({
  runId: 'task-3-x',
  task: 'add due-date column',
  claims: [{ statement: 'column renders', status: 'pass', evidence: 'ui_drive shot' }],
})
ok(r2.verdict === 'pass' && r2.recorded === 0, 'all-pass -> pass verdict, nothing recorded')

const r3 = makeVerificationReport({
  runId: 'task-4-x',
  task: 'export csv',
  claims: [{ statement: 'export works', status: 'unverified' }],
})
ok(r3.verdict === 'incomplete', 'unverified claim -> incomplete verdict')

const r4 = makeVerificationReport({
  runId: 'task-5-x',
  task: 't',
  claims: [{ statement: 'x', status: 'fail' }],
  recordFailures: false,
})
ok(r4.recorded === 0 && r4.mismatchCount === 1, 'recordFailures=false opt-out works')

throws(() => makeVerificationReport({}), 'missing runId/task rejected')
ok(sanitizeRunId('a\\b/c:d') === 'a_b_c_d', 'sanitizeRunId strips separators')

// report file content sanity
const saved = JSON.parse(readFileSync(join(reportsDir, 'task-2_toolchain..1.json'), 'utf8'))
ok(saved.verdict === 'fail' && saved.counts.fail === 1 && Array.isArray(saved.claims), 'report JSON shape')

rmSync(reportsDir, { recursive: true, force: true })
rmSync(corpusDir, { recursive: true, force: true })
delete process.env.DSH_VERIFY_DIR
delete process.env.DSH_FAILURE_CORPUS_DIR

if (failures > 0) {
  console.error(`\nVERIFY-REPORT TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nVERIFY-REPORT TEST PASSED')
