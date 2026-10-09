import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { envOr } from '../env-fallback.mjs'
import { buildProducer } from '../failure-provenance.mjs'
import { storeDir } from '../capture-store.mjs'

const FILE_LIMIT = 10 * 1024 * 1024
const TOTAL_LIMIT = 50 * 1024 * 1024
const MANIFEST_RESERVE = 1024 * 1024

export function createEvidenceBundle({ report, reportPath, claims, buildLogsDir }) {
  const bundlePath = join(dirname(reportPath), report.runId + '.bundle')
  mkdirSync(bundlePath)
  mkdirSync(join(bundlePath, 'payloads'))
  const artifacts = []
  const omitted = []
  const trace = []
  const copied = new Map()
  let totalBytes = 0
  let traceBytes = 0
  const omit = (source, reason, bytes) => omitted.push({ source, reason, ...(bytes === undefined ? {} : { bytes }) })
  const writeArtifact = (path, kind, data, source) => {
    const bytes = data.length
    if (bytes > FILE_LIMIT) { omit(source, 'file_limit', bytes); return null }
    if (totalBytes + traceBytes + bytes > TOTAL_LIMIT - MANIFEST_RESERVE) { omit(source, 'total_limit', bytes); return null }
    writeFileSync(join(bundlePath, path), data)
    totalBytes += bytes
    artifacts.push({ path: path.replace(/\\/g, '/'), kind, sha256: createHash('sha256').update(data).digest('hex'), bytes, source })
    return path
  }
  const copyArtifact = (source, kind, base = process.cwd()) => {
    if (typeof source !== 'string' || !source) return null
    const absolute = isAbsolute(source) ? source : resolve(base, source)
    if (copied.has(absolute)) return copied.get(absolute)
    copied.set(absolute, null)
    if (/\.(?:dmp|dump|mdmp)$/i.test(absolute)) { omit(absolute, 'dump_excluded'); return null }
    try {
      const size = statSync(absolute).size
      if (size > FILE_LIMIT) { omit(absolute, 'file_limit', size); return null }
      if (totalBytes + traceBytes + size > TOTAL_LIMIT - MANIFEST_RESERVE) { omit(absolute, 'total_limit', size); return null }
      if (!statSync(absolute).isFile()) { omit(absolute, 'not_regular_file'); return null }
      const name = String(artifacts.length).padStart(4, '0') + '-' + basename(absolute).slice(-120)
      const path = writeArtifact(join('payloads', name), kind, readFileSync(absolute), absolute)
      copied.set(absolute, path)
      return path
    } catch (error) { omit(absolute, error.code || error.message); return null }
  }
  const event = (kind, data, source, at = report.generatedAt) => {
    const row = { at, kind, source, data }
    const bytes = Buffer.byteLength(JSON.stringify(row) + '\n')
    if (traceBytes + bytes > FILE_LIMIT || totalBytes + traceBytes + bytes > TOTAL_LIMIT - MANIFEST_RESERVE) { omit(source, 'trace_limit', bytes); return }
    trace.push(row)
    traceBytes += bytes
  }
  const readJson = (file) => {
    try {
      const bytes = statSync(file).size
      if (bytes > FILE_LIMIT) { omit(file, 'metadata_file_limit', bytes); return null }
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) { omit(file, error.code || error.message); return null }
  }
  const scanJsonl = (file, consume) => {
    let descriptor
    try {
      descriptor = openSync(file, 'r')
      const buffer = Buffer.alloc(64 * 1024)
      let pending = Buffer.alloc(0)
      let skipping = false
      let skippedBytes = 0
      let lineNumber = 0
      for (let count; (count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
        const chunk = Buffer.concat([pending, buffer.subarray(0, count)])
        let offset = 0
        for (let end; (end = chunk.indexOf(10, offset)) >= 0; offset = end + 1) {
          lineNumber++
          const line = chunk.subarray(offset, end)
          if (skipping || line.length > FILE_LIMIT) omit(file + ':' + lineNumber, 'event_limit', skippedBytes + line.length)
          else if (line.length) {
            try { consume(JSON.parse(line.toString('utf8')), file + ':' + lineNumber) }
            catch (error) { omit(file + ':' + lineNumber, 'invalid_event: ' + error.message) }
          }
          skipping = false
          skippedBytes = 0
        }
        pending = Buffer.from(chunk.subarray(offset))
        if (pending.length > FILE_LIMIT || skipping) { skipping = true; skippedBytes += pending.length; pending = Buffer.alloc(0) }
      }
      if (pending.length || skipping) {
        if (skipping) omit(file + ':' + (lineNumber + 1), 'event_limit', skippedBytes)
        else { try { consume(JSON.parse(pending.toString('utf8')), file + ':' + (lineNumber + 1)) } catch (error) { omit(file, 'invalid_event: ' + error.message) } }
      }
    } catch (error) { omit(file, error.code || error.message) }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  const scanDirectory = (directory, pattern, consume, recursive = false) => {
    if (!existsSync(directory)) return
    const pending = [directory]
    let visited = 0
    while (pending.length) {
      const current = pending.pop()
      try {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (++visited > 10000) { omit(directory, 'scan_limit'); return }
          const file = join(current, entry.name)
          if (recursive && entry.isDirectory()) pending.push(file)
          else if (entry.isFile() && pattern.test(entry.name)) consume(file)
        }
      } catch (error) { omit(current, error.code || error.message) }
    }
  }
  copyArtifact(reportPath, 'report')
  for (const [index, claim] of claims.entries()) {
    event('claim', { claim, adjudication: report.claims[index] }, 'claims[' + index + ']')
    if (claim.kind === 'file') copyArtifact(report.claims[index].evidence || claim.path, 'evidence', claim.repo || report.context.repoRoot || process.cwd())
  }
  const buildFile = join(buildLogsDir, 'run-' + report.runId + '.json')
  if (existsSync(buildFile)) {
    const build = readJson(buildFile)
    if (build) {
      event('build', build, buildFile, build.at || build.startedAt || report.generatedAt)
      copyArtifact(buildFile, 'build')
      if (build.logPath) copyArtifact(build.logPath, 'build-log', build.repoRoot || buildLogsDir)
    }
  }
  const corpusDir = envOr('DSH_FAILURE_CORPUS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'failure-corpus')
  scanDirectory(corpusDir, /^records.*\.jsonl$/, (file) => scanJsonl(file, (row, source) => {
    if (row.context?.runId === report.runId) event('failure', row, source, row.ts)
  }))
  scanDirectory(storeDir(), /^records.*\.jsonl$/, (file) => scanJsonl(file, (row, source) => {
    if (row.runId !== report.runId) return
    const { reqBody, resBody, ...metadata } = row
    event('capture', { ...metadata, bodyReferences: { ...(reqBody !== undefined ? { request: source + '#reqBody' } : {}), ...(resBody !== undefined ? { response: source + '#resBody' } : {}) } }, source, row.ts)
  }))
  const uiDirectory = envOr('DSH_UI_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'ui-evidence')
  scanDirectory(uiDirectory, /^(?:evidence\.jsonl|steps\.json)$/, (file) => {
    const consume = (row, source) => {
      if (row.runId !== report.runId && row.context?.runId !== report.runId) return
      event('ui', row, source, row.at || row.generatedAt || report.generatedAt)
      if (file.endsWith('.json')) copyArtifact(file, 'ui')
      for (const screenshot of [row.screenshot, row.shotPath, row.path, ...(Array.isArray(row.screenshots) ? row.screenshots : [])]) {
        if (typeof screenshot === 'string') copyArtifact(screenshot, 'screenshot', dirname(file))
      }
    }
    if (file.endsWith('.jsonl')) scanJsonl(file, consume)
    else { const row = readJson(file); if (row) consume(row, file) }
  }, true)
  let head
  if (report.context.repoRoot) {
    try {
      const options = { cwd: report.context.repoRoot, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: FILE_LIMIT, stdio: ['ignore', 'pipe', 'pipe'] }
      head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim()
      const diff = execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], options)
      writeArtifact('payloads/git-diff.patch', 'git-diff', Buffer.from(diff), report.context.repoRoot)
    } catch (error) { omit(report.context.repoRoot, 'git: ' + (error.code || error.message)) }
  }
  const timeOf = (row) => typeof row.at === 'number' ? row.at : Date.parse(row.at) || 0
  trace.sort((left, right) => timeOf(left) - timeOf(right))
  const traceData = Buffer.from(trace.map((row) => JSON.stringify(row)).join('\n') + (trace.length ? '\n' : ''))
  traceBytes = 0
  writeArtifact('trace.jsonl', 'trace', traceData, report.runId)
  const manifest = { schema: 'dsh-evidence-bundle/1', runId: report.runId, task: report.task, verdict: report.verdict, createdAt: new Date().toISOString(), producer: report.producer || buildProducer({ runtime: 'verify' }), report: reportPath, ...(head ? { head } : {}), artifacts, omitted }
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2))
  if (manifestData.length > FILE_LIMIT || totalBytes + manifestData.length > TOTAL_LIMIT) throw new Error('bundle manifest exceeds size budget')
  writeFileSync(join(bundlePath, 'manifest.json'), manifestData)
  return bundlePath
}
