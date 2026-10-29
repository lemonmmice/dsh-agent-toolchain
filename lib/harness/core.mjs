import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { makeVerificationReport } from '../verify/report.mjs'
import { sourceIdentity } from '../build-evidence.mjs'
import { sanitizeRunId } from '../run-identity.mjs'
import { envOr } from '../env-fallback.mjs'

const MAX_STAGE_BYTES = 256 * 1024
const MAX_EVIDENCE_ITEMS = 40
const DECISIONS = new Set(['adopt', 'keep_base', 'no_acceptable_result', 'incomplete'])

function json(value) {
  if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + json(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex')
}

function safeId(value, label) {
  const id = sanitizeRunId(value || '')
  if (!id || id === '.' || id === '..' || id.includes('..')) throw new Error(label + ' must be a safe non-empty id')
  return id
}

function frozenTaskClaims(claims) {
  return claims.map((claim, index) => ({ ...claim, id: claim.id || `claim-${index + 1}` }))
}

function defaultDirectory() {
  return envOr('DSH_HARNESS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'harness')
}

function checkSignal(signal) {
  if (signal?.aborted) {
    const error = new Error('Harness trial cancelled; completion may be unknown')
    error.code = 'HARNESS_CANCELLED'
    error.unknown = true
    throw error
  }
}

function pathInside(root, candidate) {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + sep)
}

function safeRelative(value, label = 'path') {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error(label + ' must be a relative path')
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '..' || part === '')) throw new Error(label + ' contains an unsafe path')
  return normalized
}

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

function matchesSurface(path, globs) {
  return globs.some(glob => globToRegExp(glob).test(path))
}

function normalizeSurfaceGlobs(value) {
  if (!Array.isArray(value)) return null
  const globs = value.filter(glob => typeof glob === 'string' && glob.trim()).map(glob => glob.replaceAll('\\', '/').replace(/^\.\//, ''))
  return globs.length ? globs : null
}

// The paths a candidate overlay must never write: declared deliverables and the targets of
// file/compiled claims. Writing one would let a candidate satisfy a frozen claim without the
// agent doing the work, making the machine verdict — the whole basis for adoption — dishonest.
// harness² prevents this structurally with its editable-surface allowlist (core/tree.py is_allowed).
function protectedOverlayPaths(task, claims) {
  const set = new Set()
  const add = value => { if (typeof value === 'string' && value && !isAbsolute(value)) { try { set.add(safeRelative(value, 'protected path')) } catch { /* unsafe declared path is rejected elsewhere */ } } }
  for (const output of Array.isArray(task?.outputs) ? task.outputs : []) add(output)
  for (const claim of Array.isArray(claims) ? claims : []) if ((claim?.kind === 'file' || claim?.kind === 'compiled') && typeof claim.path === 'string') add(claim.path)
  return set
}

function copyFiles(files = {}, { editableSurface = null, protectedPaths = null } = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('harness files must be an object')
  const result = {}
  let bytes = 0
  for (const [rawPath, value] of Object.entries(files)) {
    const path = safeRelative(rawPath, 'candidate file')
    if (path.startsWith('.dsh/') || path === 'claims.json' || path === 'verification.json') throw new Error('candidate cannot modify control files')
    if (protectedPaths && protectedPaths.has(path)) throw new Error(`candidate cannot write '${path}': it is a declared deliverable or verification target, not part of the editable harness`)
    if (editableSurface && !matchesSurface(path, editableSurface)) throw new Error(`candidate path '${path}' is outside the editable harness surface (${editableSurface.join(', ')})`)
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STAGE_BYTES) throw new Error('candidate file is missing or too large')
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_STAGE_BYTES) throw new Error('candidate overlay is too large')
    result[path] = value
  }
  return result
}

async function writeOverlay(workspace, files) {
  for (const [path, value] of Object.entries(files || {})) {
    const target = resolve(workspace, path)
    if (!pathInside(workspace, target)) throw new Error('candidate path escapes workspace')
    const current = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (current?.isSymbolicLink()) throw new Error('candidate cannot replace a symbolic link')
    await mkdir(dirname(target), { recursive: true })
    const parent = await realpath(dirname(target))
    if (!pathInside(workspace, parent)) throw new Error('candidate parent escapes workspace')
    await writeFile(target, value, 'utf8')
  }
}

async function makeWorkspace(trialDir, runId, task, harness, overlay = {}) {
  const workspace = join(trialDir, 'workspaces', safeId(runId, 'runId'))
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  if (task.sourceDir) {
    const source = await realpath(task.sourceDir)
    await cp(source, workspace, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true })
  }
  await writeOverlay(workspace, harness.files || {})
  await writeOverlay(workspace, overlay)
  return workspace
}

function publicTask(task) {
  return { id: task.id, type: task.type || task.taskType || 'default', prompt: task.prompt || '', inputs: task.inputs || [], outputs: task.outputs || [] }
}

function claimForWorkspace(claim, workspace) {
  const copy = { ...claim }
  for (const key of ['path', 'cwd', 'repo', 'repoRoot', 'project']) {
    if (typeof copy[key] === 'string' && !isAbsolute(copy[key])) copy[key] = resolve(workspace, copy[key])
  }
  if (copy.kind === 'gate' && !copy.cwd) copy.cwd = workspace
  if (copy.kind === 'gate' && typeof copy.cmd !== 'string') throw new Error('gate claim requires cmd')
  return copy
}

function attachClaimIds(report, claims) {
  if (!report || !Array.isArray(report.claims)) return report
  return { ...report, claims: report.claims.map((claim, index) => ({ ...claim, id: claims[index]?.id || `claim-${index + 1}` })) }
}

async function verifyRun({ run, task, workspace, trialId, signal }) {
  checkSignal(signal)
  const claims = Array.isArray(task.claims) ? task.claims.map(claim => claimForWorkspace(claim, workspace)) : []
  if (!claims.length) return { verdict: 'incomplete', verifiedVerdict: 'incomplete', claims: [], counts: { pass: 0, fail: 0, unverified: 0 }, reason: 'frozen task has no required claims' }
  const report = await makeVerificationReport({
    runId: run.runId,
    task: task.id,
    claims,
    context: { trialId, workspace, harnessFingerprint: run.harnessFingerprint },
    recordFailures: false,
    signal,
  })
  return attachClaimIds(report, claims)
}

function boundedRunEvidence(run) {
  return {
    runId: run.runId,
    candidateId: run.candidateId,
    state: run.state,
    completeness: run.completeness,
    verifiedVerdict: run.verification?.verifiedVerdict || 'incomplete',
    claims: (run.verification?.claims || []).slice(0, MAX_EVIDENCE_ITEMS).map(claim => ({ check: claim.check, status: claim.status, evidenceLevel: claim.evidenceLevel })),
    artifacts: (run.artifacts || []).slice(0, MAX_EVIDENCE_ITEMS).map(artifact => ({ path: artifact.path, sha256: artifact.sha256 })),
    usage: run.usage || { inputTokens: null, outputTokens: null, cost: null },
  }
}

function majority(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] ?? null
}

function averageMetric(runs, field) {
  const values = runs.map(run => Number(run.metrics?.[field])).filter(Number.isFinite)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function eventCounts(runs) {
  const counts = new Map()
  for (const run of runs) for (const item of run.trajectory || []) {
    const event = String(item.event || item.stage || 'event')
    counts.set(event, (counts.get(event) || 0) + 1)
  }
  return [...counts.entries()].map(([event, count]) => ({ event, count }))
}

function contrastFor(baseRuns, candidateRuns, comparison) {
  const baseState = majority(baseRuns.map(run => run.state))
  const candidateState = majority(candidateRuns.map(run => run.state))
  const baseVerdict = majority(baseRuns.map(run => run.verification?.verifiedVerdict || 'incomplete'))
  const candidateVerdict = majority(candidateRuns.map(run => run.verification?.verifiedVerdict || 'incomplete'))
  const basePass = baseState === 'completed' && baseVerdict === 'pass' && majority(baseRuns.map(run => run.completeness)) === 'complete'
  const candidatePass = candidateState === 'completed' && candidateVerdict === 'pass' && majority(candidateRuns.map(run => run.completeness)) === 'complete'
  const field = comparison?.field
  const baseMetric = field ? averageMetric(baseRuns, field) : null
  const candidateMetric = field ? averageMetric(candidateRuns, field) : null
  const direction = comparison?.direction === 'higher' ? 'higher' : 'lower'
  const metricChanged = baseMetric !== null && candidateMetric !== null && candidateMetric !== baseMetric
  const metricImproved = metricChanged && (direction === 'higher' ? candidateMetric > baseMetric : candidateMetric < baseMetric)
  const verdictImproved = candidatePass && !basePass
  const verdictStable = baseRuns.every(run => (run.verification?.verifiedVerdict || 'incomplete') === baseVerdict) && candidateRuns.every(run => (run.verification?.verifiedVerdict || 'incomplete') === candidateVerdict)
  let consistency = 'consistent'
  if (!verdictStable || (metricImproved && !verdictImproved && basePass && candidatePass) || (verdictImproved && metricChanged && !metricImproved)) consistency = metricImproved && !verdictImproved ? 'metric-only' : 'conflicting'
  const baseArtifacts = new Map((baseRuns[0]?.artifacts || []).map(item => [item.path, item]))
  const candidateArtifacts = new Map((candidateRuns[0]?.artifacts || []).map(item => [item.path, item]))
  const paths = [...new Set([...baseArtifacts.keys(), ...candidateArtifacts.keys()])].sort()
  const artifactDiff = paths.map(path => {
    const base = baseArtifacts.get(path), candidate = candidateArtifacts.get(path)
    return { path, sha256Base: base?.sha256 || null, sha256Candidate: candidate?.sha256 || null, changed: (base?.sha256 || null) !== (candidate?.sha256 || null) }
  })
  return {
    baseRunId: baseRuns[0]?.runId || null, candidateRunId: candidateRuns[0]?.runId || null, repeats: Math.min(baseRuns.length, candidateRuns.length),
    state: { base: baseState, candidate: candidateState }, verdict: { base: baseVerdict, candidate: candidateVerdict },
    metric: field ? { field, base: baseMetric, candidate: candidateMetric, delta: baseMetric === null || candidateMetric === null ? null : candidateMetric - baseMetric, direction } : null,
    deltaObserved: {
      failedClaims: baseRuns.reduce((sum, run) => sum + (run.verification?.counts?.fail || 0), 0) - candidateRuns.reduce((sum, run) => sum + (run.verification?.counts?.fail || 0), 0),
      toolErrors: baseRuns.reduce((sum, run) => sum + (Number(run.metrics?.toolErrors) || 0), 0) - candidateRuns.reduce((sum, run) => sum + (Number(run.metrics?.toolErrors) || 0), 0),
      steps: candidateRuns.reduce((sum, run) => sum + (run.trajectory?.length || 0), 0) - baseRuns.reduce((sum, run) => sum + (run.trajectory?.length || 0), 0),
      durationMs: candidateRuns.reduce((sum, run) => sum + (Number(run.durationMs) || 0), 0) - baseRuns.reduce((sum, run) => sum + (Number(run.durationMs) || 0), 0),
    },
    artifactDiff,
    trajectoryDiff: eventCounts(candidateRuns).map(candidate => ({ event: candidate.event, baseCount: eventCounts(baseRuns).find(base => base.event === candidate.event)?.count || 0, candidateCount: candidate.count })),
    consistency,
  }
}

function evidenceDigest(run, contrast = null) {
  const value = {
    runId: run.runId, candidateId: run.candidateId, state: run.state, completeness: run.completeness,
    verdict: run.verification?.verifiedVerdict || 'incomplete',
    claims: (run.verification?.claims || []).slice(0, 20).map(claim => ({ id: claim.id, check: claim.check, status: claim.status, evidenceLevel: claim.evidenceLevel })),
    contrast,
    trajectory: (run.trajectory || []).slice(0, 12).map(item => ({ event: item.event || item.stage || 'event', summary: String(item.summary || '').slice(0, 160) })),
    artifacts: (run.artifacts || []).slice(0, 20).map(item => ({ path: item.path, bytes: item.bytes ?? null, sha256: item.sha256, summary: String(item.summary || '').slice(0, 400) })),
  }
  const serialized = JSON.stringify(value)
  if (serialized.length <= 6144) return value
  return { ...value, trajectory: value.trajectory.slice(0, 4), artifacts: value.artifacts.slice(0, 8), truncated: true }
}

function boundedEvidenceList(items, limit = 24 * 1024) {
  const result = []
  let bytes = 2
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
    if (bytes + size > limit) break
    result.push(item)
    bytes += size
  }
  return result
}

function normalizeRun(result, { runId, attemptId, candidateId, identity }) {
  const value = result && typeof result === 'object' ? result : {}
  const state = ['completed', 'failed', 'unknown', 'unavailable'].includes(value.state) ? value.state : 'unknown'
  const completeness = value.completeness === 'complete' && state === 'completed' ? 'complete' : 'incomplete'
  return {
    runId, attemptId, candidateId, identity, harnessFingerprint: identity.harnessFingerprint, state, completeness,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.slice(0, MAX_EVIDENCE_ITEMS) : [],
    trajectory: Array.isArray(value.trajectory) ? value.trajectory.slice(0, MAX_EVIDENCE_ITEMS).map(item => ({ event: item.event || item.stage || 'event', summary: String(item.summary || '').slice(0, 300) })) : [],
    model: value.model || { id: null },
    usage: value.usage || { inputTokens: null, outputTokens: null, cost: null },
    metrics: value.metrics && typeof value.metrics === 'object' ? value.metrics : {},
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : null,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
  }
}

function candidateFromStage(stage, candidateId, parentFingerprint, surfaceOpts = {}) {
  if (!stage || stage.keepBase === true || stage.noEntry === true) return { candidateId, parentFingerprint, files: {}, fingerprint: parentFingerprint, components: [], keepBase: true, rationale: stage?.rationale || '' }
  const files = copyFiles(stage.files || {}, surfaceOpts)
  if (Object.keys(files).length === 0) return { candidateId, parentFingerprint, files, fingerprint: parentFingerprint, components: [], keepBase: true, rationale: String(stage.rationale || '').slice(0, 1200), evidenceRefs: Array.isArray(stage.evidenceRefs) ? stage.evidenceRefs.slice(0, MAX_EVIDENCE_ITEMS) : [] }
  const fingerprint = digest({ parentFingerprint, files })
  const components = Array.isArray(stage.components) ? stage.components.map(String) : Object.keys(files)
  if (components.length !== Object.keys(files).length || components.some(component => !Object.hasOwn(files, component))) throw new Error('candidate components must exactly cover changed files')
  return { candidateId, parentFingerprint, files, fingerprint, components, component: components.length === 1 ? components[0] : null, keepBase: false, rationale: String(stage.rationale || '').slice(0, 1200), evidenceRefs: Array.isArray(stage.evidenceRefs) ? stage.evidenceRefs.slice(0, MAX_EVIDENCE_ITEMS) : [] }
}

function compareRuns(baseRuns, composedRuns, comparison, composerDecision, contrast, composedCandidate, baseHarness) {
  if (composerDecision === 'no_acceptable_result') return { action: 'no_acceptable_result', reason: 'composer returned no acceptable result' }
  if (composerDecision === 'keep_base') return { action: 'keep_base', reason: 'composer retained the base harness', contrast }
  if (composerDecision !== 'adopt') return { action: 'incomplete', reason: 'composer decision was not accepted', contrast }
  if (contrast.consistency !== 'consistent') return { action: 'keep_base', reason: `composer adoption vetoed by ${contrast.consistency} contrast`, contrast }
  if (!comparison?.field && contrast.state.base === 'completed' && contrast.verdict.base === 'pass' && contrast.state.candidate === 'completed' && contrast.verdict.candidate === 'pass') return { action: 'keep_base', reason: 'both base and candidate passed without a defined improvement metric', contrast }
  const candidatePass = contrast.state.candidate === 'completed' && contrast.verdict.candidate === 'pass'
  if (!candidatePass) return { action: 'keep_base', reason: 'composer adoption vetoed because candidate evidence did not pass', contrast }
  if (!composedCandidate || composedCandidate.fingerprint === baseHarness.fingerprint) return { action: 'keep_base', reason: 'composer adoption vetoed because the candidate did not change the harness', contrast }
  return { action: 'adopt', reason: 'composer decision is supported by a consistent verified contrast', contrast }
}

async function callStage(improver, input, signal, stageWorkspace) {
  if (!improver || typeof improver.runStage !== 'function') {
    const observationRefs = (input.evidence || []).map(item => item.runId).filter(Boolean).slice(0, 1)
    const ref = observationRefs[0] || 'base'
    return input.stage === 'compose' ? { decision: 'keep_base', rationale: `No improver configured; retaining base observation ${ref}`, observationRefs } : { keepBase: true, rationale: 'no improver configured' }
  }
  checkSignal(signal)
  await rm(stageWorkspace, { recursive: true, force: true })
  await mkdir(stageWorkspace, { recursive: true })
  const result = await improver.runStage({ ...input, workspace: stageWorkspace, signal })
  if (['unavailable', 'unknown', 'failed'].includes(result?.state)) {
    const error = new Error(`improver stage ${result.state}`)
    error.code = result.state === 'unknown' ? 'HARNESS_STAGE_UNKNOWN' : 'HARNESS_STAGE_UNAVAILABLE'
    error.unknown = result.state === 'unknown'
    throw error
  }
  return result && typeof result === 'object' ? result : { keepBase: true, rationale: 'improver returned no candidate' }
}

function validateComposerDecision(stage, runIds) {
  const decision = stage?.decision
  if (!['adopt', 'keep_base', 'no_acceptable_result'].includes(decision)) throw new Error('composer decision must be adopt, keep_base, or no_acceptable_result')
  const rationale = String(stage.rationale || '').trim()
  if (!rationale) throw new Error('composer rationale is required')
  const refs = Array.isArray(stage.observationRefs) ? [...new Set(stage.observationRefs.filter(ref => typeof ref === 'string'))] : []
  if (!refs.length || refs.some(ref => !runIds.has(ref)) || !refs.some(ref => rationale.includes(ref))) throw new Error('composer observationRefs must reference this trial and appear in rationale')
  return { decision, rationale, observationRefs: refs }
}

async function executeRun({ executor, task, harness, candidateId, trialDir, trialId, runIndex, overlay, identity, signal }) {
  const runId = safeId(`${trialId}-${candidateId}-${runIndex}-${randomUUID()}`, 'runId')
  const attemptId = safeId(`${runId}-attempt`, 'attemptId')
  const workspace = await makeWorkspace(trialDir, runId, task, harness, overlay)
  const raw = executor && typeof executor.runTask === 'function'
    ? await executor.runTask({ task, harness, workspace, runId, attemptId, budget: task.budget || {}, signal })
    : { state: 'unavailable', completeness: 'incomplete', model: { id: null }, usage: { inputTokens: null, outputTokens: null, cost: null } }
  const run = normalizeRun(raw, { runId, attemptId, candidateId, identity: { ...identity, harnessFingerprint: harness.fingerprint } })
  run.workspace = workspace
  run.verification = await verifyRun({ run, task, workspace, trialId, signal })
  return run
}

async function executeGroup({ executor, task, harness, candidateId, trialDir, trialId, runIndex, overlay, identity, repeats, signal }) {
  const runs = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    checkSignal(signal)
    runs.push(await executeRun({ executor, task, harness, candidateId, trialDir, trialId, runIndex: runIndex * repeats + repeat, overlay, identity, signal }))
  }
  return runs
}

// Pairwise line-Jaccard over candidate overlays, mirroring harness² core/tree.py diversity():
// makes "the two candidates collapsed to the same edit" visible — that is signal (the evidence
// supports only one change) and wasted probe budget. Observation only; it never changes a verdict.
function harnessDiversity(candidates) {
  const edited = candidates.filter(candidate => candidate && !candidate.keepBase)
  const nDistinct = new Set(edited.map(candidate => candidate.fingerprint)).size
  if (edited.length < 2) return { n: candidates.length, nEdited: edited.length, nDistinct, meanLineJaccard: edited.length ? 1 : 0, collapsed: false }
  const lineSets = edited.map(candidate => new Set(Object.entries(candidate.files || {}).flatMap(([rel, body]) => String(body).split(/\r?\n/).filter(line => line.trim()).map(line => rel + ':' + line))))
  const sims = []
  for (let i = 0; i < lineSets.length; i++) for (let j = i + 1; j < lineSets.length; j++) {
    const [a, b] = [lineSets[i], lineSets[j]]
    const union = new Set([...a, ...b])
    let intersection = 0
    for (const line of a) if (b.has(line)) intersection++
    sims.push(union.size ? intersection / union.size : 1)
  }
  const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length
  return { n: candidates.length, nEdited: edited.length, nDistinct, meanLineJaccard: Math.round(mean * 10000) / 10000, collapsed: nDistinct < edited.length }
}

// A rejected proposal is given its reason verbatim and ONE retry to fix it in place, then falls
// back to inheriting the base harness — rather than a single malformed structured output killing
// the whole (expensive) trial. Mirrors harness² core/recursion.py _run_stage (STAGE_ATTEMPTS=2).
// callStage errors (unknown/unavailable improver) still propagate; only a rejected CANDIDATE retries.
async function proposeCandidate({ improver, stageInput, stage, candidateId, parentFingerprint, surfaceOpts, dir, signal }) {
  let rejection = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callStage(improver, { ...stageInput, stage, ...(rejection ? { rejection } : {}) }, signal, dir)
    try {
      return candidateFromStage(result, candidateId, parentFingerprint, surfaceOpts)
    } catch (error) {
      rejection = String(error.message || error).slice(0, 400)
      if (attempt === 2) return { candidateId, parentFingerprint, files: {}, fingerprint: parentFingerprint, components: [], keepBase: true, fellBack: true, rationale: `proposal rejected, kept base: ${rejection}` }
    }
  }
}

async function proposeComposition({ improver, stageInput, runIds, parentFingerprint, surfaceOpts, dir, signal }) {
  let rejection = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const compose = await callStage(improver, { ...stageInput, stage: 'compose', ...(rejection ? { rejection } : {}) }, signal, dir)
    try {
      const decision = validateComposerDecision(compose, runIds)
      const candidate = candidateFromStage(compose, 'composed', parentFingerprint, surfaceOpts)
      return { decision, candidate }
    } catch (error) {
      rejection = String(error.message || error).slice(0, 400)
      if (attempt === 2) return {
        decision: { decision: 'keep_base', rationale: `composer proposal rejected, kept base: ${rejection}`, observationRefs: [] },
        candidate: { candidateId: 'composed', parentFingerprint, files: {}, fingerprint: parentFingerprint, components: [], keepBase: true, fellBack: true, rationale: `composer proposal rejected: ${rejection}` },
      }
    }
  }
}

async function runSingleTrial(config = {}, { executor, improver, experience, signal } = {}) {
  const directory = resolve(config.directory || defaultDirectory())
  const task = config.task
  if (!task || typeof task !== 'object' || !task.id || !task.prompt) throw new Error('task.id and task.prompt are required')
  if (!Array.isArray(task.claims) || task.claims.length === 0) throw new Error('task.claims must contain at least one frozen required check')
  const trialId = safeId(config.trialId || `${task.id}-${Date.now()}`, 'trialId')
  const trialDir = join(directory, 'trials', trialId)
  await mkdir(trialDir, { recursive: true })
  const baseFiles = copyFiles(config.baseHarness?.files || {})
  const baseHarness = { files: baseFiles, fingerprint: digest(baseFiles) }
  let sourceFingerprint = config.sourceFingerprint || 'none'
  if (!config.sourceFingerprint && task.sourceDir) {
    const source = await sourceIdentity(resolve(task.sourceDir), { signal, timeoutMs: task.budget?.timeoutMs || 30000, forceFull: true })
    sourceFingerprint = source.available ? `${source.algorithm}:${source.digest}` : `unavailable:${source.reason || 'source-identity'}`
  }
  const claims = frozenTaskClaims(task.claims)
  const frozenContract = { claims, comparison: config.comparison || null }
  const manifest = {
    version: 1, trialId, scope: config.scope || { project: 'default', taskType: task.type || task.taskType || 'default' },
    task: publicTask(task), taskFingerprint: digest({ ...publicTask(task), sourceDir: task.sourceDir || null }),
    inputFingerprint: digest(task.inputs || []), sourceFingerprint, contractFingerprint: digest(frozenContract), frozenContract,
    baseHarness, budget: task.budget || {}, status: 'running', createdAt: new Date().toISOString(),
    executor: config.executor?.kind || 'unknown', improver: config.improver?.kind || 'unknown',
    warnings: Array.isArray(config.warnings) ? config.warnings.slice(0, 20) : [],
    versions: {
      executor: String(config.versions?.executor || config.executor?.version || config.executor?.kind || 'unknown'),
      model: String(config.versions?.model || config.executor?.model || 'unknown'),
      tools: String(config.versions?.tools || 'dsh-agent-toolchain'),
      evaluator: String(config.versions?.evaluator || 'verify-report-v1'),
    },
  }
  await writeFile(join(trialDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const repeats = Math.max(1, Math.min(3, Number.isSafeInteger(config.probeRepeats) ? config.probeRepeats : 2))
  const runs = []
  const candidates = []
  const contrasts = []
  try {
    const identity = { trialId, taskFingerprint: manifest.taskFingerprint, inputFingerprint: manifest.inputFingerprint, sourceFingerprint: manifest.sourceFingerprint, contractFingerprint: manifest.contractFingerprint }
    const frozenTask = { ...task, claims }
    const surfaceOpts = { editableSurface: normalizeSurfaceGlobs(config.editableSurface ?? config.baseHarness?.editableSurface ?? task.editableSurface), protectedPaths: protectedOverlayPaths(task, claims) }
    const baseRuns = await executeGroup({ executor, task: frozenTask, harness: baseHarness, candidateId: 'base', trialDir, trialId, runIndex: 0, overlay: {}, identity, repeats, signal })
    runs.push(...baseRuns)
    const baseEvidence = baseRuns.map(run => evidenceDigest(run))
    const stageInput = { task: publicTask(task), evidence: baseEvidence, evidenceDigest: baseEvidence, baseHarness, candidates: [], experiences: config.experiences || [], workspace: trialDir, budget: task.budget || {} }
    const generalCandidate = await proposeCandidate({ improver, stageInput, stage: 'general', candidateId: 'general', parentFingerprint: baseHarness.fingerprint, surfaceOpts, dir: join(trialDir, 'stages', 'general'), signal })
    const domainCandidate = await proposeCandidate({ improver, stageInput, stage: 'domain', candidateId: 'domain', parentFingerprint: baseHarness.fingerprint, surfaceOpts, dir: join(trialDir, 'stages', 'domain'), signal })
    candidates.push(generalCandidate, domainCandidate)
    const diversity = harnessDiversity([generalCandidate, domainCandidate])
    const candidateGroups = []
    for (const [index, candidate] of [generalCandidate, domainCandidate].entries()) {
      const group = await executeGroup({ executor, task: frozenTask, harness: { ...baseHarness, fingerprint: candidate.fingerprint }, candidateId: candidate.candidateId, trialDir, trialId, runIndex: index + 1, overlay: candidate.files, identity, repeats, signal })
      group.forEach(run => { run.candidateFingerprint = candidate.fingerprint })
      group.forEach(run => { run.effectiveHarness = { fingerprint: candidate.fingerprint, overlayPaths: Object.keys(candidate.files).slice(0, 40) } })
      candidateGroups.push(group)
      runs.push(...group)
      const contrast = contrastFor(baseRuns, group, config.comparison)
      candidate.contrast = contrast
      contrasts.push(contrast)
    }
    const composeEvidence = runs.map(run => evidenceDigest(run, contrasts.find(contrast => contrast.baseRunId === run.runId || contrast.candidateRunId === run.runId) || null))
    const composeEvidenceBounded = boundedEvidenceList(composeEvidence)
    const { decision: composerDecision, candidate: composedCandidate } = await proposeComposition({ improver, stageInput: { ...stageInput, evidence: composeEvidenceBounded, evidenceDigest: composeEvidenceBounded, candidates, experiences: config.experiences || [] }, runIds: new Set(runs.map(run => run.runId)), parentFingerprint: baseHarness.fingerprint, surfaceOpts, dir: join(trialDir, 'stages', 'compose'), signal })
    composedCandidate.decision = composerDecision.decision
    composedCandidate.observationRefs = composerDecision.observationRefs
    composedCandidate.rationale = composerDecision.rationale
    candidates.push(composedCandidate)
    const composedRuns = await executeGroup({ executor, task: frozenTask, harness: { ...baseHarness, fingerprint: composedCandidate.fingerprint }, candidateId: 'composed', trialDir, trialId, runIndex: 3, overlay: composedCandidate.files, identity, repeats, signal })
    composedRuns.forEach(run => { run.candidateFingerprint = composedCandidate.fingerprint; run.effectiveHarness = { fingerprint: composedCandidate.fingerprint, overlayPaths: Object.keys(composedCandidate.files).slice(0, 40) } })
    runs.push(...composedRuns)
    const composedContrast = contrastFor(baseRuns, composedRuns, config.comparison)
    contrasts.push(composedContrast)
    const decision = compareRuns(baseRuns, composedRuns, config.comparison, composerDecision.decision, composedContrast, composedCandidate, baseHarness)
    decision.runId = decision.action === 'adopt' ? composedRuns[0].runId : baseRuns[0].runId
    decision.candidateId = decision.action === 'adopt' ? composedRuns[0].candidateId : baseRuns[0].candidateId
    const reflectionEvidence = boundedEvidenceList(runs.map(run => evidenceDigest(run, contrasts.find(contrast => contrast.baseRunId === run.runId || contrast.candidateRunId === run.runId) || null)))
    const reflection = await callStage(improver, { ...stageInput, stage: 'reflect', evidence: reflectionEvidence, evidenceDigest: reflectionEvidence, candidates, experiences: config.experiences || [] }, signal, join(trialDir, 'stages', 'reflect'))
    const result = {
      version: 1, trialId, status: 'completed', probeRepeats: repeats, warnings: manifest.warnings, runs: runs.map(({ workspace, ...run }) => ({ ...run, effectiveHarness: run.effectiveHarness || { fingerprint: run.harnessFingerprint, overlayPaths: [] }, trajectory: run.trajectory.slice(0, MAX_EVIDENCE_ITEMS) })),
      contrasts, diversity,
      candidates, decision, reflection: reflection.reflection || (reflection.noEntry ? { noEntry: true } : reflection), finishedAt: new Date().toISOString(),
    }
    if (!DECISIONS.has(decision.action)) throw new Error('invalid decision')
    await writeFile(join(trialDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
    await writeFile(join(trialDir, 'decision.json'), JSON.stringify(decision, null, 2), 'utf8')
    if (experience && typeof experience.propose === 'function' && result.reflection && !result.reflection.noEntry) {
      try { await experience.propose({ trialId, scope: manifest.scope, versions: manifest.versions, reflection: result.reflection, runs: result.runs }) }
      catch (error) { result.experienceError = String(error.message || error).slice(0, 300); await writeFile(join(trialDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8') }
    }
    manifest.status = 'completed'
    await writeFile(join(trialDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { ...result, directory: trialDir }
  } catch (error) {
    const unknown = error?.unknown === true || error?.code === 'HARNESS_CANCELLED'
    manifest.status = unknown ? 'unknown' : 'incomplete'
    manifest.error = String(error.message || error).slice(0, 400)
    await writeFile(join(trialDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { version: 1, trialId, status: manifest.status, runs, candidates, decision: { action: 'incomplete', reason: manifest.error }, directory: trialDir }
  }
}

function selectorView(result, label) {
  return {
    label,
    decision: result.decision?.action || 'incomplete',
    consistency: result.decision?.contrast?.consistency || 'conflicting',
    verdict: result.decision?.contrast?.verdict || null,
    metric: result.decision?.contrast?.metric || null,
    artifacts: (result.runs || []).filter(run => run.candidateId === 'composed').slice(0, 1).flatMap(run => (run.artifacts || []).map(item => ({ path: item.path, bytes: item.bytes ?? null, sha256: item.sha256 }))),
  }
}

export async function runHarnessTrial(config = {}, deps = {}) {
  const k = Math.max(1, Math.min(4, Number.isSafeInteger(config.k) ? config.k : 1))
  const mode = config.mode || 'parallel'
  if (!['parallel', 'sequential'].includes(mode)) throw new Error('mode must be parallel or sequential')
  if (k === 1) return runSingleTrial(config, deps)
  const repeats = Math.max(1, Math.min(3, Number.isSafeInteger(config.probeRepeats) ? config.probeRepeats : 2))
  const maxExecutions = config.maxExecutions === undefined ? Infinity : Number(config.maxExecutions)
  const plannedExecutions = k * 4 * repeats
  if (!Number.isFinite(maxExecutions) || maxExecutions < plannedExecutions) throw new Error(`Harness trial needs ${plannedExecutions} executions but maxExecutions is ${config.maxExecutions}`)
  const rounds = []
  let previousHarness = config.baseHarness
  for (let index = 0; index < k; index++) {
    checkSignal(deps.signal)
    const roundConfig = { ...config, k: 1, mode: undefined, trialId: `${config.trialId || config.task?.id || 'trial'}-round-${index + 1}`, baseHarness: previousHarness, directory: config.directory }
    const result = await runSingleTrial(roundConfig, deps)
    rounds.push(result)
    if (mode === 'sequential' && result.decision?.action === 'adopt') {
      const candidate = (result.candidates || []).find(item => item.candidateId === result.decision.candidateId)
      if (candidate) previousHarness = { files: candidate.files, fingerprint: candidate.fingerprint }
    }
  }
  const views = rounds.map((result, index) => selectorView(result, String.fromCharCode(65 + index)))
  let selectedLabel = views.find(view => view.decision === 'adopt' && view.consistency === 'consistent')?.label || views[0].label
  if (typeof deps.selector?.select === 'function') {
    const selection = await deps.selector.select({ candidates: views.map(view => ({ label: view.label, decision: view.decision, consistency: view.consistency, verdict: view.verdict, metric: view.metric, artifacts: view.artifacts })) })
    if (selection?.label && views.some(view => view.label === selection.label)) selectedLabel = selection.label
  }
  const selectedIndex = views.findIndex(view => view.label === selectedLabel)
  return {
    version: 1, trialId: config.trialId || config.task?.id || null, status: rounds.every(result => result.status === 'completed') ? 'completed' : 'incomplete',
    k, mode, plannedExecutions, decisions: rounds.map(result => result.decision), rounds, selector: { selected: selectedLabel, candidates: views.map(view => ({ label: view.label, decision: view.decision, consistency: view.consistency })) },
    adoption: selectedIndex >= 0 ? { label: selectedLabel, result: rounds[selectedIndex] } : null,
  }
}

export { defaultDirectory as harnessDirectory, digest as harnessDigest, boundedRunEvidence }

