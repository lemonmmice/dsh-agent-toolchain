/**
 * lib/failure-corpus.mjs — local failure corpus: the data flywheel.
 *
 * Every human handoff, verification failure, agent misjudgment, or tool
 * malfunction appends one JSONL record. Failure classes are a FIXED taxonomy
 * on purpose: a small, stable vocabulary is what makes the data minable later.
 *
 * Framework-free (no DSH/MCP imports). Data stays local — never uploaded.
 *
 *   const c = makeFailureCorpus({})                 // ~/.dsh-agent-toolchain/failure-corpus
 *   c.record({ task, failureClass, description })   // -> full record with id/ts
 *   c.query({ q, failureClass, tag, fromTs, toTs }) // -> newest-first rows
 *   c.stats()                                       // -> totals + per-class counts
 *
 * Env: DSH_FAILURE_CORPUS_DIR overrides the data dir.
 * The active file rotates to records-<timestamp>.jsonl at 20 MB.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/**
 * Fixed failure taxonomy. Do not add classes casually: every new class
 * splits future statistics. Propose + document a new class before using it.
 */
export const FAILURE_CLASSES = [
  'verification-failure', // build / test / CI / UI check actually failed
  'agent-misjudge', // agent claimed success, evidence disagreed
  'human-handoff', // work stopped to ask a human
  'tool-error', // a toolchain component malfunctioned
  'flaky', // nondeterministic failure (passes on retry)
  'doc-gap', // docs / API mismatch caused the failure
  'design-flaw', // an architecture decision required rework
]

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

export function defaultCorpusDir() {
  return process.env.DSH_FAILURE_CORPUS_DIR || join(homedir(), '.dsh-agent-toolchain', 'failure-corpus')
}

export function makeFailureCorpus(opts = {}) {
  const dir = opts.dir || defaultCorpusDir()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES
  const activeFile = () => join(dir, 'records.jsonl')

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function validate(rec) {
    if (!rec || typeof rec !== 'object') throw new Error('record must be an object')
    if (typeof rec.task !== 'string' || !rec.task.trim()) throw new Error('task (string) is required')
    if (!FAILURE_CLASSES.includes(rec.failureClass)) {
      throw new Error(`failureClass must be one of: ${FAILURE_CLASSES.join(', ')}`)
    }
    if (typeof rec.description !== 'string' || !rec.description.trim()) {
      throw new Error('description (string) is required')
    }
    if (rec.resolution !== undefined && typeof rec.resolution !== 'string') {
      throw new Error('resolution must be a string')
    }
    if (rec.tags !== undefined && (!Array.isArray(rec.tags) || rec.tags.some((t) => typeof t !== 'string'))) {
      throw new Error('tags must be an array of strings')
    }
    if (rec.context !== undefined && (typeof rec.context !== 'object' || rec.context === null || Array.isArray(rec.context))) {
      throw new Error('context must be an object')
    }
    if (rec.costMs !== undefined && (typeof rec.costMs !== 'number' || rec.costMs < 0)) {
      throw new Error('costMs must be a non-negative number')
    }
  }

  function record(rec) {
    validate(rec)
    ensureDir()
    const now = new Date()
    const full = {
      id: `fc-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`,
      ts: now.toISOString(),
      task: rec.task.trim(),
      failureClass: rec.failureClass,
      description: rec.description.trim(),
      ...(rec.resolution !== undefined ? { resolution: rec.resolution } : {}),
      ...(rec.context !== undefined ? { context: rec.context } : {}),
      ...(rec.costMs !== undefined ? { costMs: rec.costMs } : {}),
      ...(rec.tags !== undefined ? { tags: rec.tags } : {}),
    }
    const f = activeFile()
    if (existsSync(f) && statSync(f).size > maxBytes) {
      const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
      renameSync(f, join(dir, `records-${stamp}.jsonl`))
    }
    appendFileSync(f, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  function readActive() {
    const f = activeFile()
    if (!existsSync(f)) return []
    const rows = []
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // skip a corrupt line; the rest of the corpus stays usable
      }
    }
    return rows
  }

  function query(q = {}) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const needle = (q.q ?? '').toLowerCase()
    let rows = readActive()
    if (needle) {
      rows = rows.filter((r) =>
        [r.task, r.description, r.resolution ?? ''].some((s) => String(s).toLowerCase().includes(needle))
      )
    }
    if (q.failureClass) rows = rows.filter((r) => r.failureClass === q.failureClass)
    if (q.tag) rows = rows.filter((r) => (r.tags ?? []).includes(q.tag))
    if (q.fromTs !== undefined) rows = rows.filter((r) => Date.parse(r.ts) >= q.fromTs)
    if (q.toTs !== undefined) rows = rows.filter((r) => Date.parse(r.ts) <= q.toTs)
    rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    return { total: rows.length, count: Math.min(Math.max(rows.length - offset, 0), limit), rows: rows.slice(offset, offset + limit) }
  }

  function stats() {
    const rows = readActive()
    const byClass = {}
    for (const cls of FAILURE_CLASSES) byClass[cls] = 0
    for (const r of rows) byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1
    const now = Date.now()
    const last7d = rows.filter((r) => now - Date.parse(r.ts) <= 7 * 86400000).length
    const last30d = rows.filter((r) => now - Date.parse(r.ts) <= 30 * 86400000).length
    return { total: rows.length, last7d, last30d, byClass, dir }
  }

  return { record, query, stats, dir }
}
