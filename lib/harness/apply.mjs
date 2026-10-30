// The final step that closes the loop without a human: auto-apply a MACHINE-VALIDATED experience to
// a project-local, on-demand skill set. Machine evidence is the entry ticket — only `validated`
// experiences (≥2 independent machine trials, per experience.mjs) qualify; that verdict is what
// EARNS applying without a human confirming. A no-regression gate re-runs the frozen reproducing
// gate(s) of the new lesson AND every active sibling in the same scope; it is FAIL-CLOSED — if any
// gate regresses, or any gate cannot be re-run (its reproduction is gone — the reproduction ceiling),
// nothing is written. Project-scoped, versioned, retireable: bounded blast radius, reversible.
import fs from 'node:fs'
import path from 'node:path'

const APPLY_MANIFEST = '.dsh-applied.json'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(temporary, file)
}

function scopeKey(scope) { return `${scope?.project || 'default'}::${scope?.taskType || 'default'}` }

function safeSeg(value, fallback) {
  const segment = String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '-')
  return !segment || segment === '.' || segment === '..' ? fallback : segment
}

function loadManifest(dir) { return readJson(path.join(dir, APPLY_MANIFEST)) || { version: 1, entries: [] } }
function saveManifest(dir, manifest) { writeJson(path.join(dir, APPLY_MANIFEST), manifest) }

// The frozen reproducing gate(s) a lesson was validated against. Only self-contained gate-kind
// claims (a cmd) are re-runnable here; non-gate evidence (build/api needing the live project) is
// treated as "cannot re-run" by the caller's runGate, so the apply fails closed.
function trialGateClaims(harnessRoot, trialId) {
  if (!trialId) return []
  const manifest = readJson(path.join(harnessRoot, 'trials', String(trialId), 'manifest.json'))
  const claims = manifest?.frozenContract?.claims
  return Array.isArray(claims) ? claims.filter(claim => (claim?.kind || 'manual') === 'gate' && typeof claim.cmd === 'string') : []
}

// runGate(claim) -> { runnable: boolean, pass: boolean }. Injected so the regression runner is
// testable and so "cannot re-run" (reproduction gone) is explicit rather than a silent pass.
export async function applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId, runGate, now = () => new Date().toISOString() }) {
  if (!projectSkillsDir) throw new Error('projectSkillsDir is required')
  if (typeof runGate !== 'function') throw new Error('runGate is required')
  const record = library.get(experienceId)
  if (!record) throw new Error('experience not found: ' + experienceId)
  if (record.status !== 'validated') return { applied: false, blocked: 'not-validated', status: record.status }

  const manifest = loadManifest(projectSkillsDir)
  if (manifest.entries.some(entry => entry.id === record.id && !entry.retired)) {
    return { applied: false, blocked: 'already-applied' }
  }

  const key = scopeKey(record.scope)
  const siblings = manifest.entries.filter(entry => !entry.retired && entry.scopeKey === key && entry.trialId)
  // Regression set: the new lesson plus every active lesson already applied in this scope. Applying a
  // new guidance edit must not break a gate an earlier lesson still relies on.
  const toCheck = [{ id: record.id, trialId: record.trialId }, ...siblings.map(entry => ({ id: entry.id, trialId: entry.trialId }))]
  const regression = { ran: 0, passed: 0, failed: [] }
  for (const item of toCheck) {
    const gates = trialGateClaims(harnessRoot, item.trialId)
    if (!gates.length) return { applied: false, blocked: 'needs-reproduction', reason: `no self-contained gate for ${item.id}`, regression }
    for (const gate of gates) {
      const verdict = await runGate(gate, { experienceId: item.id })
      if (!verdict || verdict.runnable === false) return { applied: false, blocked: 'needs-reproduction', reason: `gate not re-runnable for ${item.id}`, regression }
      regression.ran++
      if (verdict.pass) regression.passed++
      else { regression.failed.push(item.id); return { applied: false, blocked: 'regression', regression } }
    }
  }

  // All gates pass → materialize the skill. library.exportFiles is the vetted, sensitive-scrubbed
  // copy path and requires a fresh empty target, so each lesson gets its own versioned directory.
  const skillDirAbs = path.join(projectSkillsDir, safeSeg(record.scope?.taskType, 'default'), safeSeg(record.id, 'experience'))
  if (fs.existsSync(skillDirAbs) && fs.readdirSync(skillDirAbs).length) throw new Error('target skill dir is not empty: ' + skillDirAbs)
  library.exportFiles({ id: record.id, targetDirectory: skillDirAbs })
  manifest.entries.push({
    id: record.id, scopeKey: key, scope: record.scope, taskType: record.scope?.taskType || 'default',
    component: record.reflection?.component || null, fingerprint: record.fingerprint, trialId: record.trialId,
    skillDir: path.relative(projectSkillsDir, skillDirAbs).replaceAll('\\', '/'), appliedAt: now(), retired: false,
  })
  saveManifest(projectSkillsDir, manifest)
  return { applied: true, skillDir: skillDirAbs, regression }
}

// Reversibility: remove the applied skill files and mark the manifest entry retired (audit kept).
export function retireApplied({ projectSkillsDir, id, reason, now = () => new Date().toISOString() }) {
  const manifest = loadManifest(projectSkillsDir)
  const entry = manifest.entries.find(item => item.id === id && !item.retired)
  if (!entry) return { retired: false, reason: 'not found or already retired' }
  const root = path.resolve(projectSkillsDir)
  const target = path.resolve(projectSkillsDir, entry.skillDir)
  if (target === root || target.startsWith(root + path.sep)) fs.rmSync(target, { recursive: true, force: true })
  entry.retired = true
  entry.retiredAt = now()
  entry.retiredReason = String(reason || 'retired').slice(0, 400)
  saveManifest(projectSkillsDir, manifest)
  return { retired: true, id, skillDir: entry.skillDir }
}

export function listApplied({ projectSkillsDir }) {
  return loadManifest(projectSkillsDir).entries.filter(entry => !entry.retired)
}
