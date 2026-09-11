import fs from 'node:fs'
import path from 'node:path'

export const READ_ONLY = Symbol('read-only')

function canonicalExe(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return path.normalize(path.resolve(value)).replace(/[\\/]+/g, '\\').toLowerCase() } catch { return null }
}

function keyOf(identity = {}) {
  const exe = canonicalExe(identity.exe)
  const windowHandle = identity.windowHandle == null ? null : String(identity.windowHandle)
  const aid = identity.aid == null ? null : String(identity.aid)
  return { exe, windowHandle, aid }
}

function matches(rule, identity) {
  return ['exe', 'windowHandle', 'aid'].every(k => rule[k] == null || rule[k] === identity[k])
}

function parseRules(value) {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('policy must be an array')
  return value.map(rule => {
    if (!rule || !['allow', 'deny'].includes(rule.effect)) throw new Error('invalid policy rule')
    const identity = keyOf(rule)
    if (!identity.exe && identity.windowHandle == null && identity.aid == null) throw new Error('empty policy rule')
    return { ...identity, effect: rule.effect }
  })
}

export function createPolicy({ rules, policyFile = process.env.DSH_UI_APP_POLICY, safetyPolicyFile = process.env.DSH_UI_SAFETY_POLICY_FILE, estopFile = process.env.DSH_UI_ESTOP_FILE, classifyAction } = {}) {
  let parsed
  let safetyPolicyText = null
  try {
    if (safetyPolicyFile && fs.existsSync(safetyPolicyFile)) safetyPolicyText = fs.readFileSync(safetyPolicyFile, 'utf8')
    parsed = rules !== undefined ? parseRules(rules) : (policyFile && fs.existsSync(policyFile) ? parseRules(JSON.parse(fs.readFileSync(policyFile, 'utf8'))) : null)
  } catch { parsed = undefined }
  let stoppedSession = null
  const readOnly = action => typeof classifyAction === 'function' && classifyAction(action) === READ_ONLY
  const stop = sessionId => { stoppedSession = sessionId == null ? null : String(sessionId) }
  const reset = sessionId => { if (stoppedSession !== null && String(sessionId) === stoppedSession) stoppedSession = null }
  return {
    diagnostics: { safetyPolicyText },
    stop,
    reset,
    check({ action, identity = {}, snapshot, targetWindowHandle, allowSideEffects = false, sessionId, onExecute } = {}) {
      if (readOnly(action)) return { ok: true, readOnly: true }
      if (stoppedSession === null && estopFile && fs.existsSync(estopFile)) stoppedSession = sessionId == null ? '__default__' : String(sessionId)
      if (stoppedSession !== null && String(sessionId == null ? '__default__' : sessionId) === stoppedSession) return { ok: false, code: 'stopped_by_user', error: '急停已生效' }
      if (parsed === undefined || !parsed) return { ok: false, code: 'policy_unavailable', error: '策略不可用' }
      const current = keyOf(identity)
      if (!current.exe) return { ok: false, code: 'policy_unavailable', error: '身份不可解析' }
      const hits = parsed.filter(rule => matches(rule, current))
      if (!hits.length || new Set(hits.map(r => r.effect)).size > 1) return { ok: false, code: hits.length ? 'policy_conflict' : 'policy_unavailable', error: '策略拒绝' }
      if (hits[0].effect !== 'allow' || allowSideEffects !== true) return { ok: false, code: 'policy_unavailable', error: '副作用未获授权' }
      if (snapshot && (snapshot.gen !== identity.gen || snapshot.seq !== identity.latestSeq || String(snapshot.windowHandle) !== String(targetWindowHandle ?? identity.windowHandle))) return { ok: false, code: snapshot.gen !== identity.gen ? 'expiredSnapshot' : 'staleSnapshot', error: '快照无效' }
      if (typeof onExecute === 'function') onExecute()
      return { ok: true }
    }
  }
}

export { canonicalExe }


