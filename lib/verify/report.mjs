/**
 * lib/verify/report.mjs — verification report with evidence adjudication.
 *
 * The physical carrier of "evidence over claims": one runId ties a task's
 * claims to the evidence backing them, and the REPORT adjudicates each claim
 * from that evidence — it does not record the agent's self-rating:
 *
 *   kind=build   reads the per-run build record (run-<runId>.json in the
 *                build-logs dir) and derives pass/fail from it
 *   kind=api     queries the shared capture store (filter + expect.min /
 *                expect.all2xx) and derives pass/fail from matching records
 *   kind=file    checks that an evidence artifact exists
 *   kind=git     machine-checks git facts against the authoritative source
 *                (clean working tree / pushed via ls-remote — never the
 *                stale local tracking refs)
 *   kind=gate    runs a verification command; exit 0 = pass
 *   kind=manual  explicit opt-out: agent-supplied status (for what the system
 *                cannot check, e.g. visual judgment / human handoff)
 *
 * Verdict: pass / incomplete / fail. A claim the evidence contradicts
 * (adjudicated fail) is an agent-misjudge and is auto-recorded in the failure
 * corpus — the system observes the mismatch, not the agent.
 *
 * Framework-free; data lives under ~/.dsh-agent-toolchain/verify-reports/
 * (override DSH_VERIFY_DIR).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeFailureCorpus } from '../failure-corpus.mjs'
import { queryRecords, readAll } from '../capture-store.mjs'

export function defaultReportDir() {
  return process.env.DSH_VERIFY_DIR || join(homedir(), '.dsh-agent-toolchain', 'verify-reports')
}

export function defaultBuildLogsDir() {
  return process.env.DSH_BUILD_LOGS_DIR || join(homedir(), '.dsh-agent-toolchain', 'build-logs')
}

/** runId is part of the filename — never allow path separators or traversal. */
export function sanitizeRunId(runId) {
  return String(runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80)
}

// ---------------------------------------------------------------- evidence readers

/** Per-run build record (run-<runId>.json), or the latest build when no runId. */
function readBuildRecord(runId) {
  const dir = defaultBuildLogsDir()
  if (runId) {
    const p = join(dir, 'run-' + sanitizeRunId(runId) + '.json')
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  const last = join(dir, 'last.json')
  if (!existsSync(last)) return null
  try {
    return JSON.parse(readFileSync(last, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- adjudicators

function checkBuild(claim) {
  const rec = readBuildRecord(claim.runId)
  if (!rec || rec.hasRun === false) {
    return { status: 'unverified', detail: 'no build record' + (claim.runId ? ' for runId ' + sanitizeRunId(claim.runId) : ''), evidence: null }
  }
  const detail = `${rec.target ?? 'build'} ${rec.ok ? 'passed' : 'failed'} — ${rec.logPath ?? 'no log'}`
  if (rec.ok) return { status: 'pass', detail, evidence: rec.logPath ?? null }
  return { status: 'fail', detail, evidence: rec.logPath ?? null }
}

function checkApi(claim) {
  const filter = { ...(claim.filter ?? {}), ...(claim.runId ? { runId: claim.runId } : {}) }
  const matches = queryRecords(filter)
  const expect = claim.expect ?? {}
  const min = Number(expect.min ?? 1)
  const all2xx = expect.all2xx === true
  if (matches.length >= min && (!all2xx || matches.every((r) => Number.isInteger(r.status) && r.status >= 200 && r.status < 300))) {
    return { status: 'pass', detail: `${matches.length} matching capture record(s)`, evidence: 'capture-store' }
  }
  if (matches.length === 0) {
    // No match is a contradiction only when capture was actually active
    // (the store has records but none match the claim).
    const storeTotal = readAll().length
    return storeTotal > 0
      ? { status: 'fail', detail: `no matching capture record(s) while the store holds ${storeTotal}`, evidence: 'capture-store' }
      : { status: 'unverified', detail: 'capture store empty — capture was not active', evidence: 'capture-store' }
  }
  return { status: 'fail', detail: `${matches.length} record(s) but not meeting expect ${JSON.stringify(expect)}`, evidence: 'capture-store' }
}

function checkFile(claim) {
  const p = claim.path
  if (!p) return { status: 'unverified', detail: 'no path given', evidence: null }
  return existsSync(p) ? { status: 'pass', detail: 'exists: ' + p, evidence: p } : { status: 'fail', detail: 'missing: ' + p, evidence: p }
}

/** Explicit opt-out: agent-supplied status for what the system cannot check. */
function checkManual(claim) {
  const status = claim.status === 'pass' || claim.status === 'fail' ? claim.status : 'unverified'
  return { status, detail: claim.evidence ?? 'agent-supplied', evidence: claim.evidence ?? null }
}

/**
 * kind=git: machine-check git facts against the AUTHORITATIVE source, not the
 * local tracking refs (URL-token pushes do not update origin/*, so git status
 * can show a phantom "ahead"). check=clean -> working tree via status
 * --porcelain; check=pushed -> local ref vs `git ls-remote` (the remote itself).
 */
function runGit(repo, args, gitConfig) {
  try {
    return execFileSync('git', [...gitConfig, '-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

function checkGit(claim) {
  const repo = claim.repo || process.cwd()
  const check = claim.check ?? 'clean'
  const gitConfig = Array.isArray(claim.gitConfig) ? claim.gitConfig : []
  if (check === 'clean') {
    const out = runGit(repo, ['status', '--porcelain'], gitConfig)
    if (out === null) return { status: 'unverified', detail: 'git status failed', evidence: null }
    return out.trim() === ''
      ? { status: 'pass', detail: 'working tree clean', evidence: 'git status' }
      : { status: 'fail', detail: 'working tree dirty: ' + out.trim().split('\n').slice(0, 3).join(' | '), evidence: 'git status' }
  }
  if (check === 'pushed') {
    const ref = claim.ref ?? 'HEAD'
    const head = runGit(repo, ['rev-parse', ref], gitConfig)
    if (head === null || !head.trim()) return { status: 'unverified', detail: 'cannot resolve local ' + ref, evidence: null }
    const remote = runGit(repo, ['ls-remote', 'origin', ref], gitConfig)
    if (remote === null || !remote.trim()) return { status: 'unverified', detail: 'cannot reach the remote (no network / no upstream)', evidence: null }
    const localSha = head.trim()
    const remoteSha = remote.trim().split(/\s+/)[0]
    return localSha === remoteSha
      ? { status: 'pass', detail: localSha.slice(0, 10) + ' is on the remote', evidence: 'git ls-remote' }
      : { status: 'fail', detail: 'local ' + localSha.slice(0, 10) + ' != remote ' + remoteSha.slice(0, 10) + ' (unpushed commits)', evidence: 'git ls-remote' }
  }
  return { status: 'unverified', detail: 'unknown git check: ' + check, evidence: null }
}

/** kind=gate: run a verification command; exit 0 = pass, anything else = fail. */
function checkGate(claim) {
  const cmd = claim.cmd
  if (!cmd) return { status: 'unverified', detail: 'no cmd given', evidence: null }
  try {
    const r = spawnSync(cmd, { shell: true, cwd: claim.cwd || process.cwd(), encoding: 'utf8', windowsHide: true })
    const full = String((r.stdout || '') + '\n' + (r.stderr || ''))
    const tail = full.trim().split(/\r?\n/).slice(-2).join(' | ')
    if (r.status === 0) {
      // Exit 0 alone can be vacuous: a test filter matching nothing exits 0.
      // A gate that certified "0 tests ran" as pass would be green-washing.
      if (VACUOUS_TEST_OUTPUT.test(full)) {
        return { status: 'fail', detail: 'exit 0 but no tests executed' + (tail ? ' — ' + tail.slice(0, 120) : ''), evidence: cmd }
      }
      return { status: 'pass', detail: 'exit 0' + (tail ? ' — ' + tail.slice(0, 120) : ''), evidence: cmd }
    }
    return { status: 'fail', detail: 'exit ' + (r.status ?? '?') + (tail ? ' — ' + tail.slice(0, 120) : ''), evidence: cmd }
  } catch (e) {
    return { status: 'unverified', detail: 'gate could not run: ' + String(e.message ?? e).slice(0, 120), evidence: cmd }
  }
}

/** Output patterns of test runners that ran zero tests (exit code 0). */
const VACUOUS_TEST_OUTPUT =
  /(没有测试匹配|没有测试与筛选器|no test (matches|matched|were selected|to run|was selected)|0 of 0 tests|已通过! - 失败:\s*0，通过:\s*0|passed:\s*0\s*[\s\S]{0,160}total:\s*0)/i

const CHECKS = { build: checkBuild, api: checkApi, file: checkFile, manual: checkManual, git: checkGit, gate: checkGate }

/** Adjudicate one claim from its evidence reference. Never throws. */
export function adjudicateClaim(claim = {}) {
  const kind = claim.kind ?? 'manual'
  const fn = CHECKS[kind]
  if (!fn) return { status: 'unverified', detail: 'unknown check kind: ' + kind, evidence: null }
  try {
    return fn(claim)
  } catch (e) {
    return { status: 'unverified', detail: 'adjudication error: ' + String(e.message ?? e).slice(0, 120), evidence: null }
  }
}

// ---------------------------------------------------------------- report

/**
 * @param {object} opts
 * @param {string} opts.runId  unique run id, e.g. "task-2-toolchain-1"
 * @param {string} opts.task   one-line task name
 * @param {Array<object>} opts.claims  each claim: {statement, kind?, runId?, path?, filter?, expect?, status?, evidence?}
 * @param {object} [opts.context]  runtime context (repo / model / mode)
 * @param {boolean} [opts.recordFailures]  default true — auto-record adjudicated-fail claims as agent-misjudge
 */
export function makeVerificationReport({ runId, task, claims = [], context = {}, recordFailures = true } = {}) {
  if (!runId || !task) throw new Error('runId and task are required')
  if (!Array.isArray(claims)) throw new Error('claims must be an array')
  const safeRunId = sanitizeRunId(runId)
  const adjudicated = claims.map((c) => {
    const r = adjudicateClaim(c)
    return {
      statement: String(c.statement ?? '').slice(0, 400),
      check: c.kind ?? 'manual',
      status: r.status,
      detail: r.detail,
      ...(r.evidence ? { evidence: r.evidence } : {}),
    }
  })
  const mismatches = adjudicated.filter((c) => c.status === 'fail')
  const unverified = adjudicated.filter((c) => c.status === 'unverified')
  const verdict = mismatches.length > 0 ? 'fail' : unverified.length > 0 ? 'incomplete' : 'pass'
  const counts = {
    pass: adjudicated.filter((c) => c.status === 'pass').length,
    fail: mismatches.length,
    unverified: unverified.length,
  }
  const report = {
    runId: safeRunId,
    task,
    verdict,
    generatedAt: new Date().toISOString(),
    context,
    claims: adjudicated,
    counts,
  }
  const dir = defaultReportDir()
  mkdirSync(dir, { recursive: true })
  const reportPath = join(dir, safeRunId + '.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  let recorded = 0
  if (recordFailures && mismatches.length > 0) {
    const corpus = makeFailureCorpus({})
    for (const m of mismatches) {
      corpus.record({
        task: task + ' [' + safeRunId + ']',
        failureClass: 'agent-misjudge',
        description:
          'claim contradicted by evidence: ' + String(m.statement ?? '?').slice(0, 200) +
          ' — adjudicated ' + m.check + ': ' + String(m.detail ?? '').slice(0, 120),
        tags: ['auto', 'verify'],
        context: { runtime: 'verify', runId: safeRunId },
      })
      recorded++
    }
  }
  return { runId: safeRunId, verdict, reportPath, mismatchCount: mismatches.length, recorded, counts }
}
