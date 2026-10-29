import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { findSensitive } from '../../plugins/dsh-memory/lib/sensitive.mjs'
import { withFileTransaction } from '../file-transaction.mjs'

const ATTRIBUTIONS = new Set(['helped', 'hurt', 'no observed effect', 'confounded'])
const VERSION_KEYS = ['executor', 'model', 'tools', 'evaluator']
const MAX_TEXT = 4000
const MAX_LIMIT = 100

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function text(value, name, { required = true, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value
}

function safeId(value, name) {
  const id = text(value, name, { max: 160 })
  if (id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${name} contains unsupported path characters`)
  return id
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function ensureSafe(value, label) {
  const serialized = JSON.stringify(value)
  if (serialized.length > 20000) throw new Error(`${label} exceeds the experience size limit`)
  const hits = findSensitive(serialized)
  if (hits.length) throw new Error(`${label} contains sensitive content (${hits.map(hit => hit.name).join(', ')})`)
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') throw new Error('scope is required')
  return { project: text(scope.project, 'scope.project', { max: 160 }), taskType: text(scope.taskType, 'scope.taskType', { max: 160 }) }
}

function normalizeVersions(versions) {
  if (!versions || typeof versions !== 'object') throw new Error('versions are required')
  const result = {}
  for (const key of VERSION_KEYS) result[key] = text(versions[key], `versions.${key}`, { max: 200 })
  return result
}

function normalizeEvidenceRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 32) throw new Error('evidenceRefs must contain 1..32 run IDs')
  const result = [...new Set(refs.map((ref, index) => safeId(ref, `evidenceRefs[${index}]`)))]
  if (result.length !== refs.length) throw new Error('evidenceRefs must not contain duplicates')
  return result
}

function normalizeReflection(reflection) {
  if (!reflection || typeof reflection !== 'object') throw new Error('reflection is required')
  const attribution = text(reflection.attribution, 'reflection.attribution', { max: 32 })
  if (!ATTRIBUTIONS.has(attribution)) throw new Error('reflection.attribution is unsupported')
  if (reflection.confidence !== undefined && (typeof reflection.confidence !== 'number' || !Number.isFinite(reflection.confidence) || reflection.confidence < 0 || reflection.confidence > 1)) throw new Error('reflection.confidence must be a number between 0 and 1')
  const result = {
    cue: text(reflection.cue, 'reflection.cue'),
    lesson: text(reflection.lesson, 'reflection.lesson'),
    component: text(reflection.component, 'reflection.component', { max: 240 }),
    attribution,
    evidenceRefs: normalizeEvidenceRefs(reflection.evidenceRefs),
    confidence: reflection.confidence === undefined ? null : reflection.confidence,
  }
  ensureSafe(result, 'reflection')
  return result
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`Cannot read ${file}: ${error.message}`)
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(temporary, file)
}

function candidateSnapshot(trial) {
  if (trial?.decision?.action !== 'adopt') throw new Error('experience requires an adopted candidate')
  const candidateId = trial?.decision?.candidateId
  const candidate = (trial?.candidates || []).find(item => item?.candidateId === candidateId)
  if (!candidate || !candidate.files || typeof candidate.files !== 'object') throw new Error('adopted candidate files are missing')
  let bytes = 0
  for (const [file, content] of Object.entries(candidate.files)) {
    if (typeof content !== 'string' || file.length > 400 || /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(file)) throw new Error('candidate file path is unsafe')
    bytes += Buffer.byteLength(content, 'utf8')
    if (bytes > 4 * 1024 * 1024) throw new Error('candidate files exceed 4 MiB')
    if (findSensitive(content).length) throw new Error('candidate files contain sensitive content')
  }
  return { files: candidate.files, fingerprint: candidate.fingerprint || digest(candidate.files) }
}

function scopeId(scope) { return digest(scope).slice(0, 32) }

function trialRecord(directory, trialId) {
  const id = safeId(trialId, 'trialId')
  const root = path.join(directory, 'trials', id)
  const manifest = readJson(path.join(root, 'manifest.json'))
  const result = readJson(path.join(root, 'result.json')) || readJson(path.join(root, 'trial.json'))
  if (!manifest && !result) return null
  const merged = { ...(manifest || {}), ...(result || {}) }
  if (merged.trialId && merged.trialId !== id) return null
  return merged
}

function matchingScope(trial, scope, versions) {
  return canonical(trial?.scope) === canonical(scope) && canonical(trial?.versions) === canonical(versions)
}

function machineRun(trial, runId) {
  const run = (trial?.runs || []).find(item => item?.runId === runId)
  if (!run || run.state !== 'completed' || run.completeness !== 'complete') return null
  const verification = run.verification
  if (verification?.verifiedVerdict !== 'pass' || !Array.isArray(verification.claims) || verification.claims.length === 0) return null
  const machineKinds = new Set(['build', 'api', 'compiled', 'gate', 'git'])
  if (verification.claims.some(claim => claim?.status !== 'pass' || claim.evidenceLevel !== 'observed' || !machineKinds.has(claim.check || claim.kind))) return null
  const required = trial?.frozenContract?.claims || trial?.task?.claims
  if (Array.isArray(required) && required.length) {
    const passed = new Set(verification.claims.map(claim => claim?.id).filter(Boolean))
    if (required.some(claim => !passed.has(claim?.id))) return null
  }
  return run
}

function adoptedTrial(trial) {
  if (trial?.decision?.action !== 'adopt') return null
  const runId = trial.decision.runId
  return machineRun(trial, runId)
}

function candidateComponent(trial) {
  const candidateId = trial?.decision?.candidateId
  const candidate = (trial?.candidates || []).find(item => item?.candidateId === candidateId)
  if (!candidate) return null
  if (Array.isArray(candidate.components) && candidate.components.length !== 1) return null
  if (candidate.component && candidate.component !== trial.reflection?.component) return null
  if (!candidate.component && Array.isArray(candidate.components) && candidate.components[0] !== trial.reflection?.component) return null
  if (candidate.files && typeof candidate.files === 'object' && !Array.isArray(candidate.files) && Object.keys(candidate.files).length !== 1) return null
  return candidate
}

function validateSupport({ experience, supportTrialIds, directory }) {
  const ids = [...new Set(supportTrialIds)]
  if (ids.length < 2) throw new Error('validation requires the original trial and at least one independent support trial')
  if (!ids.includes(experience.trialId)) throw new Error('supportTrialIds must include the original trial')
  const original = trialRecord(directory, experience.trialId)
  if (!original) throw new Error('original trial is missing')
  if (experience.reflection.attribution !== 'helped') throw new Error('only helped experiences can be validated')
  if (original.reflection?.attribution !== 'helped') throw new Error('original trial reflection is not helped')
  if (!matchingScope(original, experience.scope, experience.versions)) throw new Error('original trial scope or versions do not match')
  const originalRun = adoptedTrial(original)
  if (!originalRun || !candidateComponent({ ...original, reflection: experience.reflection })) throw new Error('original trial lacks complete adopted machine evidence')
  if (original.taskFingerprint === undefined || original.contractFingerprint === undefined) throw new Error('original trial identity is incomplete')
  for (const supportId of ids) {
    if (supportId === experience.trialId) continue
    const trial = trialRecord(directory, supportId)
    if (!trial) throw new Error('support trial is missing')
    if (!matchingScope(trial, experience.scope, experience.versions)) throw new Error('support trial scope or versions do not match')
    if (!trial.taskFingerprint || trial.taskFingerprint === original.taskFingerprint) throw new Error('support trial must be an independent task')
    if (trial.contractFingerprint !== original.contractFingerprint) throw new Error('support trial verification contract does not match')
    const run = adoptedTrial(trial)
    if (!run) throw new Error('support trial lacks complete adopted machine evidence')
    if (trial.reflection?.attribution !== 'helped' || trial.reflection?.component !== experience.reflection.component) throw new Error('support trial attribution or component does not match')
    if (Array.isArray(trial.reflection?.evidenceRefs) && trial.reflection.evidenceRefs.some(ref => !machineRun(trial, ref))) throw new Error('support trial has incomplete evidence references')
    if (!candidateComponent(trial)) throw new Error('support trial has confounded or multi-component changes')
  }
  return ids
}

export function createExperienceLibrary({ directory, memoryDirectory } = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('directory is required')
  const root = path.resolve(directory)
  const indexRoot = path.join(root, 'library')
  const memoryRoot = memoryDirectory ? path.resolve(memoryDirectory, 'harness-experience') : null
  fs.mkdirSync(indexRoot, { recursive: true })

  function indexFile(scope) { return path.join(indexRoot, scopeId(scope), 'index.json') }
  function loadIndex(scope) { return readJson(indexFile(scope)) || { version: 1, scope, entries: [] } }
  function saveIndex(scope, index) {
    const file = indexFile(scope)
    withFileTransaction(file, () => {
      const current = readJson(file) || { version: 1, scope, entries: [] }
      const merged = { version: 1, scope, entries: Array.isArray(current.entries) ? current.entries : [] }
      for (const desired of Array.isArray(index.entries) ? index.entries : []) {
        const position = merged.entries.findIndex(entry => entry.id === desired.id)
        if (position >= 0) merged.entries[position] = desired
        else if (desired.id) merged.entries.push(desired)
      }
      writeJson(file, merged)
    })
    if (memoryRoot) {
      const mirror = path.join(memoryRoot, scopeId(scope) + '.json')
      withFileTransaction(mirror, () => writeJson(mirror, { version: 1, scope, entries: index.entries }))
    }
  }

  function propose({ trialId, scope, versions, reflection, runs } = {}) {
    const id = safeId(trialId, 'trialId')
    const normalizedScope = normalizeScope(scope)
    const normalizedVersions = normalizeVersions(versions)
    const normalizedReflection = normalizeReflection(reflection)
    const trial = trialRecord(root, id)
    if (!trial) throw new Error('trial result is required before proposing experience')
    const snapshot = candidateSnapshot(trial)
    const knownRuns = new Set((trial.runs || []).map(run => run?.runId).filter(Boolean))
    if (normalizedReflection.evidenceRefs.some(ref => !knownRuns.has(ref))) throw new Error('reflection evidenceRefs must reference runs from this trial')
    const record = {
      id: 'experience-' + digest({ trialId: id, scope: normalizedScope, versions: normalizedVersions, reflection: normalizedReflection }).slice(0, 32),
      trialId: id, scope: normalizedScope, versions: normalizedVersions, reflection: normalizedReflection,
      status: 'proposed', supportTrialIds: [], transitions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      fingerprint: snapshot.fingerprint, filesRef: path.join('experiences', 'pending', 'files'),
    }
    ensureSafe(record, 'experience')
    const file = path.join(root, 'experiences', record.id + '.json')
    const existing = readJson(file)
    if (existing) return clone(existing)
    const filesRoot = path.join(root, 'experiences', record.id, 'files')
    fs.mkdirSync(filesRoot, { recursive: true })
    for (const [relativePath, content] of Object.entries(snapshot.files)) {
      const safePath = path.resolve(filesRoot, relativePath)
      if (!(safePath === filesRoot || safePath.startsWith(filesRoot + path.sep))) throw new Error('experience file escapes storage')
      fs.mkdirSync(path.dirname(safePath), { recursive: true })
      fs.writeFileSync(safePath, content, 'utf8')
    }
    record.filesRef = path.relative(root, filesRoot).replaceAll('\\', '/')
    withFileTransaction(file, () => writeJson(file, record))
    const index = loadIndex(normalizedScope)
    index.entries = index.entries.filter(entry => entry.id !== record.id)
    index.entries.push({ id: record.id, trialId: record.trialId, status: record.status, component: record.reflection.component, attribution: record.reflection.attribution, versions: record.versions, updatedAt: record.updatedAt })
    saveIndex(normalizedScope, index)
    return clone(record)
  }

  function get(id) {
    return clone(readJson(path.join(root, 'experiences', safeId(id, 'id') + '.json')))
  }

  function exportFiles({ id, targetDirectory } = {}) {
    const record = get(id)
    if (!record) throw Object.assign(new Error('Harness experience not found: ' + id), { code: 'HARNESS_NOT_FOUND' })
    if (typeof targetDirectory !== 'string' || !targetDirectory) throw new Error('targetDirectory is required')
    const target = path.resolve(targetDirectory)
    fs.mkdirSync(target, { recursive: true })
    if (fs.readdirSync(target).length) throw new Error('targetDirectory must be empty')
    const filesRoot = path.resolve(root, record.filesRef || '')
    let totalBytes = 0
    const copy = (source, destination) => {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name), destinationPath = path.join(destination, entry.name)
        if (entry.isDirectory()) { fs.mkdirSync(destinationPath, { recursive: true }); copy(sourcePath, destinationPath) }
        else if (entry.isFile()) {
          const content = fs.readFileSync(sourcePath, 'utf8')
          totalBytes += Buffer.byteLength(content, 'utf8')
          if (totalBytes > 4 * 1024 * 1024) throw new Error('experience export exceeds 4 MiB')
          ensureSafe(content, 'experience file')
          fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
          fs.writeFileSync(destinationPath, content, 'utf8')
        } else throw new Error('experience export rejects links and special files')
      }
    }
    if (!fs.existsSync(filesRoot)) throw new Error('experience files are missing')
    copy(filesRoot, target)
    return { ok: true, id: record.id, targetDirectory: target, filesRef: record.filesRef, fingerprint: record.fingerprint }
  }

  function transition({ id, action, supportTrialIds, reason } = {}) {
    const current = get(id)
    if (!current) throw new Error('experience not found')
    if (!['validate', 'retire'].includes(action)) throw new Error('action must be validate or retire')
    if (action === 'validate') {
      if (current.status !== 'proposed') throw new Error('only proposed experiences can be validated')
      const ids = validateSupport({ experience: current, supportTrialIds: Array.isArray(supportTrialIds) ? supportTrialIds : [], directory: root })
      current.status = 'validated'
      current.supportTrialIds = ids
    } else {
      if (current.status === 'retired') throw new Error('experience is already retired')
      current.status = 'retired'
      current.retiredReason = text(reason || 'retired by operator', 'reason', { max: 400 })
      ensureSafe(current.retiredReason, 'reason')
    }
    current.transitions.push({ action, at: new Date().toISOString(), supportTrialIds: current.supportTrialIds, reason: action === 'retire' ? current.retiredReason : null })
    current.updatedAt = new Date().toISOString()
    ensureSafe(current, 'experience')
    const file = path.join(root, 'experiences', safeId(current.id, 'id') + '.json')
    withFileTransaction(file, () => writeJson(file, current))
    const index = loadIndex(current.scope)
    const entry = index.entries.find(item => item.id === current.id)
    if (entry) { entry.status = current.status; entry.updatedAt = current.updatedAt }
    saveIndex(current.scope, index)
    return clone(current)
  }

  function query({ scope, versions, states = ['validated'], limit = 20 } = {}) {
    const normalizedScope = normalizeScope(scope)
    const normalizedVersions = normalizeVersions(versions)
    if (!Array.isArray(states) || states.length === 0 || states.some(state => !['proposed', 'validated', 'retired'].includes(state))) throw new Error('states contains an unsupported value')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`)
    const index = loadIndex(normalizedScope)
    const items = []
    for (const entry of index.entries) {
      if (items.length >= limit) break
      if (!states.includes(entry.status) || canonical(entry.versions) !== canonical(normalizedVersions)) continue
      const record = get(entry.id)
      if (record && record.status === entry.status && canonical(record.scope) === canonical(normalizedScope) && canonical(record.versions) === canonical(normalizedVersions)) items.push(record)
    }
    return { items: clone(items), total: items.length, scope: normalizedScope, versions: normalizedVersions }
  }

  return { propose, query, transition, get, exportFiles }
}

export const _experienceInternals = { canonical, machineRun, trialRecord }
