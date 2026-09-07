/**
 * lib/verify/report.mjs — verification report v0.
 *
 * The physical carrier of "evidence over claims": one runId ties a task's
 * claims to the evidence backing them, and produces one verdict
 * (pass / incomplete / fail). A claim whose evidence contradicts it
 * (status=fail) is an agent-misjudge and is auto-recorded in the failure
 * corpus — the system observes the mismatch, not the agent.
 *
 * Framework-free; data lives under ~/.dsh-agent-toolchain/verify-reports/
 * (override DSH_VERIFY_DIR).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeFailureCorpus } from '../failure-corpus.mjs'

export function defaultReportDir() {
  return process.env.DSH_VERIFY_DIR || join(homedir(), '.dsh-agent-toolchain', 'verify-reports')
}

/** runId is part of the filename — never allow path separators or traversal. */
export function sanitizeRunId(runId) {
  return String(runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80)
}

/**
 * @param {object} opts
 * @param {string} opts.runId  unique run id, e.g. "task-2-toolchain-1"
 * @param {string} opts.task   one-line task name
 * @param {Array<{statement:string, status:'pass'|'fail'|'unverified', evidence?:string}>} opts.claims
 * @param {object} [opts.context]  runtime context (repo / model / mode)
 * @param {boolean} [opts.recordFailures]  default true — auto-record failed claims as agent-misjudge
 */
export function makeVerificationReport({ runId, task, claims = [], context = {}, recordFailures = true } = {}) {
  if (!runId || !task) throw new Error('runId and task are required')
  if (!Array.isArray(claims)) throw new Error('claims must be an array')
  const safeRunId = sanitizeRunId(runId)
  const mismatches = claims.filter((c) => c.status === 'fail')
  const unverified = claims.filter((c) => !c.status || c.status === 'unverified')
  const verdict = mismatches.length > 0 ? 'fail' : unverified.length > 0 ? 'incomplete' : 'pass'
  const counts = {
    pass: claims.filter((c) => c.status === 'pass').length,
    fail: mismatches.length,
    unverified: unverified.length,
  }
  const report = {
    runId: safeRunId,
    task,
    verdict,
    generatedAt: new Date().toISOString(),
    context,
    claims: claims.map((c) => ({
      statement: String(c.statement ?? '').slice(0, 400),
      status: c.status,
      ...(c.evidence !== undefined ? { evidence: String(c.evidence).slice(0, 300) } : {}),
    })),
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
          'claim failed: ' + String(m.statement ?? '?').slice(0, 200) +
          (m.evidence ? ' — evidence: ' + String(m.evidence).slice(0, 120) : ''),
        tags: ['auto', 'verify'],
        context: { runtime: 'verify', runId: safeRunId },
      })
      recorded++
    }
  }
  return { runId: safeRunId, verdict, reportPath, mismatchCount: mismatches.length, recorded, counts }
}
