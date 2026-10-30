import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { envOr } from '../env-fallback.mjs'

const DEFAULT_DIR = () => envOr('DSH_HARNESS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'harness')
const TRIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function harnessDir(value) {
  const dir = resolve(String(value || DEFAULT_DIR()))
  return dir
}

function safeTrialId(value) {
  const id = String(value || '')
  if (!TRIAL_ID.test(id)) throw Object.assign(new Error('trialId must contain 1..128 safe characters'), { code: 'HARNESS_INVALID_ID' })
  return id
}

function safeExperienceId(value) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id) || id === '.' || id === '..') throw Object.assign(new Error('experience id is invalid'), { code: 'HARNESS_INVALID_ID' })
  return id
}

function safeTrialPath(directory, trialId, file) {
  const root = resolve(directory)
  const trial = resolve(root, 'trials', safeTrialId(trialId))
  const target = resolve(trial, file)
  const prefix = root.endsWith('\u005c') || root.endsWith('/') ? root : root + '\u005c'
  if (!(target === root || target.startsWith(prefix) || target.startsWith(root + '/'))) throw Object.assign(new Error('harness path escapes configured directory'), { code: 'HARNESS_PATH_ESCAPE' })
  return target
}

function readJson(path, label) {
  if (!existsSync(path)) throw Object.assign(new Error(`${label} not found`), { code: 'HARNESS_NOT_FOUND' })
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Object.assign(new Error(`${label} is missing or exceeds 4 MiB`), { code: 'HARNESS_INVALID_FILE' })
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw Object.assign(new Error(`${label} is not valid JSON`), { code: 'HARNESS_INVALID_JSON' }) }
}

async function loadCore() {
  return import('./core.mjs')
}

async function loadExecutor(config) {
  const mod = await import('./executor.mjs')
  if (typeof mod.createExecutor !== 'function') throw new Error('Harness executor adapter is unavailable')
  return mod.createExecutor(config || {})
}

async function loadImprover(config) {
  const mod = await import('./executor.mjs')
  if (typeof mod.createImprover !== 'function') throw new Error('Harness improver adapter is unavailable')
  return mod.createImprover(config || {})
}

async function loadLibrary(directory, config = {}) {
  const mod = await import('./experience.mjs')
  if (typeof mod.createExperienceLibrary !== 'function') throw new Error('Harness experience library is unavailable')
  return mod.createExperienceLibrary({ directory, memoryDirectory: config.memoryDirectory })
}

function parseJsonParam(value, name, fallback) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { throw Object.assign(new Error(`${name} must be valid JSON`), { code: 'HARNESS_INVALID_JSON' }) }
}

export function makeHarnessTools({ directory = DEFAULT_DIR(), runTrial, executorFactory = loadExecutor, improverFactory = loadImprover, libraryFactory = loadLibrary } = {}) {
  const store = harnessDir(directory)
  const run = runTrial || (async (config, deps) => {
    const core = await loadCore()
    if (typeof core.runHarnessTrial !== 'function') throw new Error('Harness orchestration core is unavailable')
    return core.runHarnessTrial(config, deps)
  })

  async function trial(args = {}, extra = {}) {
    const action = args.action || 'run'
    if (action === 'status' || action === 'result') {
      const trialId = safeTrialId(args.trialId)
      const manifestPath = safeTrialPath(store, trialId, 'manifest.json')
      const resultPath = safeTrialPath(store, trialId, 'result.json')
      const manifest = existsSync(manifestPath) ? readJson(manifestPath, 'Harness trial manifest') : null
      if (!manifest) throw Object.assign(new Error('Harness trial not found: ' + trialId), { code: 'HARNESS_NOT_FOUND' })
      if (action === 'status') return { ok: true, trialId, state: manifest.state || manifest.status || 'unknown', phase: manifest.phase || null, updatedAt: manifest.updatedAt || manifest.finishedAt || manifest.createdAt || null, resultPath: existsSync(resultPath) ? resultPath : null }
      return { trialId, manifest, result: existsSync(resultPath) ? readJson(resultPath, 'Harness trial result') : null }
    }
    if (action !== 'run') throw Object.assign(new Error('harness_trial action must be run, status, or result'), { code: 'HARNESS_INVALID_ACTION' })
    if (typeof args.configPath !== 'string' || !args.configPath) throw Object.assign(new Error('configPath is required for harness_trial run'), { code: 'HARNESS_CONFIG_REQUIRED' })
    const configPath = resolve(args.configPath)
    if (!isAbsolute(args.configPath)) throw Object.assign(new Error('configPath must be an absolute path'), { code: 'HARNESS_CONFIG_PATH' })
    if (!existsSync(configPath) || !statSync(configPath).isFile()) throw Object.assign(new Error('configPath does not point to a file'), { code: 'HARNESS_CONFIG_PATH' })
    const bytes = readFileSync(configPath)
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    const expectedFingerprint = args.configFingerprint || extra.harnessConfigFingerprint
    if (expectedFingerprint && expectedFingerprint !== fingerprint) throw Object.assign(new Error('harness_trial config changed after submission; refusing to rerun'), { code: 'HARNESS_CONFIG_CHANGED', incomplete: true })
    const config = JSON.parse(bytes.toString('utf8'))
    const configuredId = config.trialId || args.trialId
    const trialId = configuredId ? safeTrialId(configuredId) : undefined
    const normalized = { ...config, ...(trialId ? { trialId } : {}), directory: store }
    if (normalized.executor && typeof normalized.executor === 'object' && Object.hasOwn(normalized.executor, '__hostShell')) {
      normalized.executor = { ...normalized.executor }
      delete normalized.executor.__hostShell
      normalized.warnings = [...(Array.isArray(normalized.warnings) ? normalized.warnings : []), 'executor.__hostShell is host-only and was ignored from JSON config']
    }
    const executor = await executorFactory(normalized.executor || {})
    const improver = await improverFactory(normalized.improver || {})
    const experience = normalized.experience === false ? null : await libraryFactory(store, normalized.experience || {})
    if (experience && typeof experience.query === 'function' && normalized.scope) {
      const versions = {
        executor: String(normalized.versions?.executor || normalized.executor?.version || normalized.executor?.kind || 'unknown'),
        model: String(normalized.versions?.model || normalized.executor?.model || 'unknown'),
        tools: String(normalized.versions?.tools || 'dsh-agent-toolchain'),
        evaluator: String(normalized.versions?.evaluator || 'verify-report-v1'),
      }
      const queried = experience.query({ scope: normalized.scope, versions, states: normalized.includeProposed === true ? ['proposed', 'validated'] : ['validated'], limit: 20 })
      normalized.experiences = (queried.items || [])
        .filter(item => normalized.includeProposed === true || item.status !== 'proposed')
        .map(item => normalized.includeProposed === true && item.status === 'proposed' ? { ...item, unvalidated: true } : item)
    }
    return run(normalized, { executor, improver, experience, signal: extra.signal })
  }

  async function experience(args = {}) {
    const action = args.action || 'query'
    const library = await libraryFactory(store, args)
    if (action === 'query') {
      const states = parseJsonParam(args.statesJson, 'statesJson', args.states)
      if (Array.isArray(states) && states.includes('proposed') && args.includeProposed !== true) throw Object.assign(new Error('proposed experiences require includeProposed=true'), { code: 'HARNESS_PROPOSED_NOT_ALLOWED' })
      return library.query({ scope: parseJsonParam(args.scopeJson, 'scopeJson', args.scope), versions: parseJsonParam(args.versionsJson, 'versionsJson', args.versions), states, limit: args.limit })
    }
    if (action === 'get') {
      const value = library.get(safeExperienceId(args.id))
      if (!value) throw Object.assign(new Error('Harness experience not found: ' + args.id), { code: 'HARNESS_NOT_FOUND' })
      return value
    }
    if (action === 'validate' || action === 'retire') {
      const id = String(args.id || '')
      safeExperienceId(id)
      const supportTrialIds = parseJsonParam(args.supportTrialIdsJson, 'supportTrialIdsJson', args.supportTrialIds)
      const result = library.transition({ id, action, supportTrialIds, reason: args.reason })
      // Close the loop: a freshly VALIDATED lesson auto-applies to the project skill set (opt-in via
      // applyDir / DSH_HARNESS_APPLY_DIR). Machine validation (≥2 independent trials) is what earns
      // applying without a human. Fail-closed inside apply.mjs; default off → zero behavior change.
      if (action === 'validate' && result?.status === 'validated') {
        const applyDir = args.applyDir || envOr('DSH_HARNESS_APPLY_DIR')
        if (applyDir) {
          try {
            const { applyValidatedExperience } = await import('./apply.mjs')
            const { makeVerificationReport } = await import('../verify/report.mjs')
            const runGate = async (claim, ctx = {}) => {
              // apply.mjs rebuilds the reproduction and passes its path as ctx.cwd; run the frozen gate
              // there instead of the trial's long-gone workspace. Without a rebuilt cwd, treat it as
              // not re-runnable rather than running the gate against whatever the original cwd was.
              const cwd = ctx.cwd || claim.cwd
              if (!cwd || !existsSync(cwd)) return { runnable: false }
              try {
                const report = await makeVerificationReport({ runId: `apply-regress-${id}-${Date.now()}`, task: 'apply-regression', claims: [{ ...claim, cwd }], recordFailures: false })
                return { runnable: true, pass: report.verifiedVerdict === 'pass' }
              } catch { return { runnable: false } }
            }
            result.apply = await applyValidatedExperience({ harnessRoot: store, library, projectSkillsDir: resolve(applyDir), experienceId: id, runGate })
          } catch (error) {
            result.apply = { applied: false, error: String(error.message || error).slice(0, 300) }
          }
        }
      }
      return result
    }
    if (action === 'export') return library.exportFiles({ id: safeExperienceId(args.id), targetDirectory: args.exportPath })
    throw Object.assign(new Error('harness_experience action must be query, get, export, validate, or retire'), { code: 'HARNESS_INVALID_ACTION' })
  }

  return { directory: store, trial, experience }
}

export { DEFAULT_DIR }
