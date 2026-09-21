import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { envOr } from '../../../lib/env-fallback.mjs'

function canonicalExe(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return path.normalize(path.resolve(value)).replace(/[\\/]+/g, '\\').toLowerCase() } catch { return null }
}
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null }
function keyOf(identity = {}) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) identity = {}
  return {
    exe: canonicalExe(identity.exe || identity.exeCanonical),
    windowHandle: identity.windowHandle == null && identity.handle == null ? null : String(identity.windowHandle ?? identity.handle),
    aid: text(identity.aid),
    publisherName: text(identity.publisherName ?? identity.publisher),
    productName: text(identity.productName ?? identity.product),
    binaryName: text(identity.binaryName ?? identity.binary ?? ((identity.exe || identity.exeCanonical) ? path.win32.basename(String(identity.exe || identity.exeCanonical)) : null))?.toLowerCase() || null,
    aumid: text(identity.aumid ?? identity.appUserModelId),
  }
}
const IDENTITY_KEYS = ['exe', 'windowHandle', 'aid', 'publisherName', 'productName', 'binaryName', 'aumid']
const APPROVAL_SCOPES = new Set(['once', 'session', 'persistent', 'permanent'])
const persistentScope = scope => scope === 'persistent' || scope === 'permanent'
const appIdentity = identity => Boolean(identity.exe || identity.aumid || (identity.publisherName && identity.productName && identity.binaryName))
function matches(rule, identity) { return IDENTITY_KEYS.every(key => rule[key] == null || rule[key] === identity[key]) }
function actionAllowed(actions, action) { return actions.includes('*') || actions.includes(String(action || '').trim().toLowerCase()) }
function normSession(sessionId) { return sessionId == null ? '__default__' : String(sessionId) }
function defaultApprovalFile() { return envOr('DSH_UI_APPROVAL_FILE') || path.join(homedir(), '.dsh-agent-toolchain', 'ui-approvals.json') }
function copyApproval(row) { return { ...row, identity: { ...row.identity }, actions: [...row.actions] } }
function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : NaN
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
}

function parseRules(value) {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('policy must be an array')
  return value.map(rule => {
    if (!rule || !['allow', 'deny'].includes(rule.effect)) throw new Error('invalid policy rule')
    const identity = keyOf(rule)
    if (!IDENTITY_KEYS.some(key => identity[key] != null)) throw new Error('empty policy rule')
    return { ...identity, effect: rule.effect }
  })
}

function readApprovals(file) {
  if (!file) return new Map()
  let content
  try { content = fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
  const value = JSON.parse(content)
  const rows = Array.isArray(value) ? value : value?.approvals
  if (!Array.isArray(rows)) throw new Error('invalid approval store')
  const approvals = new Map()
  for (const row of rows) {
    if (row?.scope === 'once' || row?.scope === 'session') continue
    if (!row || !persistentScope(row.scope) || !text(row.id) || approvals.has(row.id) || !row.identity || !appIdentity(keyOf(row.identity)) ||
      !Array.isArray(row.actions) || !row.actions.length || row.actions.some(action => typeof action !== 'string' || !/^(\*|[a-z][a-z0-9_-]*)$/.test(action)) ||
      !Number.isFinite(timestamp(row.createdAt)) || (row.scope !== 'permanent' && row.expiresAt == null) ||
      (row.expiresAt != null && !Number.isFinite(timestamp(row.expiresAt))) || (row.revokedAt != null && !Number.isFinite(timestamp(row.revokedAt)))) {
      throw new Error('invalid approval store')
    }
    approvals.set(row.id, { ...row, identity: keyOf(row.identity), actions: [...row.actions] })
  }
  return approvals
}

export function createPolicy({
  rules, policyFile = envOr('DSH_UI_APP_POLICY'), safetyPolicyFile = envOr('DSH_UI_SAFETY_POLICY_FILE'),
  estopFile = envOr('DSH_UI_ESTOP_FILE'), approvalFile = defaultApprovalFile(),
  approvalTtlMs = Number(envOr('DSH_UI_APPROVAL_TTL_MS') || 900000),
  allowLockedDesktop = /^(1|true)$/i.test(String(envOr('DSH_UI_ALLOW_LOCKED') || '')),
} = {}) {
  let parsed
  const policyConfigured = rules !== undefined || Boolean(policyFile)
  let safetyPolicyText = null
  try {
    if (safetyPolicyFile && fs.existsSync(safetyPolicyFile)) safetyPolicyText = fs.readFileSync(safetyPolicyFile, 'utf8')
    parsed = rules !== undefined ? parseRules(rules) : (policyFile ? parseRules(JSON.parse(fs.readFileSync(policyFile, 'utf8'))) : null)
  } catch { parsed = undefined }
  let stoppedSession = null
  const localApprovals = new Map()
  const diagnostics = { safetyPolicyText, safetyPolicyFile: safetyPolicyFile || '', safetyPolicyLoaded: !!safetyPolicyText, safetyPolicyGatesActions: false, approvalStoreError: null }
  const storeFailure = error => {
    diagnostics.approvalStoreError = { code: 'approval_store_unavailable', error: '授权存储不可用' + (error?.code ? '（' + error.code + '）' : '') }
    return { ok: false, ...diagnostics.approvalStoreError }
  }
  function refreshApprovals() {
    try {
      const approvals = readApprovals(approvalFile)
      diagnostics.approvalStoreError = null
      return { ok: true, approvals }
    } catch (error) { return storeFailure(error) }
  }
  function updateStoredApprovals(update) {
    if (!approvalFile) return storeFailure(new Error('approval file required'))
    const lockFile = approvalFile + '.lock'
    const tempFile = approvalFile + '.tmp-' + randomUUID()
    let descriptor = null
    let outcome
    try {
      fs.mkdirSync(path.dirname(approvalFile), { recursive: true })
      descriptor = fs.openSync(lockFile, 'wx', 0o600)
      const approvals = readApprovals(approvalFile)
      outcome = update(approvals)
      if (outcome.ok) {
        fs.writeFileSync(tempFile, JSON.stringify([...approvals.values()].filter(row => persistentScope(row.scope)), null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        fs.renameSync(tempFile, approvalFile)
      }
      diagnostics.approvalStoreError = null
    } catch (error) { outcome = storeFailure(error) }
    finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); fs.rmSync(lockFile) } catch (error) { outcome = storeFailure(error) }
      }
      try { fs.rmSync(tempFile, { force: true }) } catch (error) { outcome = storeFailure(error) }
    }
    return outcome
  }
  function grantApproval({ identity = {}, sessionId, scope = 'session', actions = ['*'], expiresAt, ttlMs } = {}) {
    const invalid = error => ({ ok: false, code: 'approval_invalid', error })
    if (!APPROVAL_SCOPES.has(scope)) return invalid('授权 scope 必须是 once/session/persistent/permanent')
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return invalid('授权需要明确的应用身份')
    const normalizedIdentity = keyOf(identity)
    if (!appIdentity(normalizedIdentity)) return invalid('授权必须绑定 exe、AUMID，或 publisherName/productName/binaryName 完整组合')
    if (!Array.isArray(actions) || !actions.length || actions.some(action => typeof action !== 'string' || !/^(\*|[a-z][a-z0-9_-]*)$/i.test(action.trim()))) return invalid('actions 必须是非空动作名数组')
    const now = Date.now()
    const ttl = ttlMs === undefined ? approvalTtlMs : ttlMs
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) return invalid('ttlMs 必须是正数')
    let expiry = null
    if (expiresAt !== undefined) {
      expiry = timestamp(expiresAt)
      if (!Number.isFinite(expiry) || expiry <= now) return invalid('expiresAt 必须是未来的有效时间')
    } else if (scope !== 'permanent' || ttlMs !== undefined) {
      if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(new Date(now + ttl).getTime())) return invalid('授权默认有效期无效')
      expiry = now + ttl
    }
    const row = {
      id: 'apv_' + randomUUID(), scope, sessionId: persistentScope(scope) ? null : normSession(sessionId),
      identity: normalizedIdentity, actions: [...new Set(actions.map(action => action.trim().toLowerCase()))],
      createdAt: new Date(now).toISOString(), expiresAt: expiry == null ? null : new Date(expiry).toISOString(), revokedAt: null,
    }
    const result = { ok: true, approval: { ...copyApproval(row), persistent: persistentScope(scope) } }
    if (persistentScope(scope)) return updateStoredApprovals(approvals => { approvals.set(row.id, row); return result })
    localApprovals.set(row.id, row)
    return result
  }
  function revokeApproval(id) {
    const approvalId = String(id || '')
    if (localApprovals.has(approvalId)) {
      localApprovals.get(approvalId).revokedAt = new Date().toISOString()
      return { ok: true, revoked: true, id: approvalId }
    }
    return updateStoredApprovals(approvals => {
      const row = approvals.get(approvalId)
      if (!row) return { ok: false, code: 'approval_not_found', error: '授权不存在' }
      row.revokedAt = new Date().toISOString()
      return { ok: true, revoked: true, id: row.id }
    })
  }
  function approvalStatus() {
    const loaded = refreshApprovals()
    if (!loaded.ok) return loaded
    const now = Date.now()
    return [...localApprovals.values(), ...loaded.approvals.values()].map(row => ({
      ...copyApproval(row), persistent: persistentScope(row.scope),
      expired: row.expiresAt != null && timestamp(row.expiresAt) <= now,
      active: !row.revokedAt && (row.expiresAt == null || timestamp(row.expiresAt) > now),
    }))
  }
  function checkApproval(approvalId, { action, identity, sessionId }) {
    let row = localApprovals.get(approvalId)
    if (!row) {
      const loaded = refreshApprovals()
      if (!loaded.ok) return loaded
      row = loaded.approvals.get(approvalId)
    }
    if (!row) return { ok: false, code: 'approval_invalid', error: '授权不存在' }
    if (row.revokedAt) return { ok: false, code: 'approval_revoked', error: '授权已撤销' }
    if (row.expiresAt != null && timestamp(row.expiresAt) <= Date.now()) return { ok: false, code: 'approval_expired', error: '授权已过期' }
    if (!persistentScope(row.scope) && row.sessionId !== normSession(sessionId)) return { ok: false, code: 'approval_session_mismatch', error: '授权不属于当前会话' }
    if (!matches(row.identity, identity)) return { ok: false, code: 'approval_identity_mismatch', error: '授权与当前应用身份不匹配' }
    if (!actionAllowed(row.actions, action)) return { ok: false, code: 'approval_action_mismatch', error: '授权未覆盖该动作' }
    return { ok: true, approval: row }
  }
  const stop = sessionId => { stoppedSession = normSession(sessionId) }
  const reset = sessionId => { if (stoppedSession !== null && normSession(sessionId) === stoppedSession) stoppedSession = null }
  return {
    diagnostics, needsCheck: (args = {}) => policyConfigured || stoppedSession !== null || Boolean(typeof args === 'string' ? args : args?.approvalId) || Boolean(estopFile && fs.existsSync(estopFile)) || localApprovals.size > 0 || Boolean(approvalFile && fs.existsSync(approvalFile)),
    requiresIdentity: Boolean(policyConfigured), isConfigured: () => Boolean(policyConfigured), stop, reset, latchedSession: () => stoppedSession,
    estopFilePath: () => estopFile || '', policyFilePath: () => policyFile || '', approvalFilePath: () => approvalFile || '', approvalStatus, grantApproval, revokeApproval,
    allowLockedDesktop,
    check({ action, identity = {}, allowSideEffects = false, sessionId, approvalId, desktopState = null, consume = true, onExecute } = {}) {
      if (estopFile && fs.existsSync(estopFile)) { if (stoppedSession === null) stoppedSession = normSession(sessionId); return { ok: false, code: 'stopped_by_user', error: '急停已生效（哨兵文件在盘上）' } }
      if (stoppedSession !== null && normSession(sessionId) === stoppedSession) return { ok: false, code: 'stopped_by_user', error: '急停已生效（需显式复位，删除哨兵文件不构成复位）' }
      if (desktopState === 'locked' && !allowLockedDesktop) return { ok: false, code: 'desktop_locked', error: '当前桌面处于锁屏，策略拒绝副作用动作' }
      if (desktopState === 'secure') return { ok: false, code: 'desktop_secure', error: '当前处于安全桌面，策略拒绝副作用动作' }
      if (desktopState != null && !['unlocked', 'locked', 'secure'].includes(desktopState)) return { ok: false, code: 'desktop_unknown', error: '无法确认当前桌面状态，策略拒绝副作用动作' }
      if (allowSideEffects !== true) return { ok: false, code: 'policy_unavailable', error: '副作用未获授权' }
      const current = keyOf(identity)
      if (identity?.publisherVerified !== true) current.publisherName = null
      if (policyConfigured) {
        if (parsed === undefined || !parsed) return { ok: false, code: 'policy_unavailable', error: '策略不可用' }
        if (!appIdentity(current)) return { ok: false, code: 'policy_unavailable', error: '身份不可解析' }
        const hits = parsed.filter(rule => matches(rule, current))
        if (!hits.length || new Set(hits.map(rule => rule.effect)).size > 1) return { ok: false, code: hits.length ? 'policy_conflict' : 'policy_unavailable', error: '策略拒绝' }
        if (hits[0].effect !== 'allow') return { ok: false, code: 'policy_unavailable', error: '策略拒绝' }
      }
      let approval = null
      if (approvalId != null && String(approvalId) !== '') {
        const checked = checkApproval(String(approvalId), { action, identity: current, sessionId })
        if (!checked.ok) return checked
        approval = checked.approval
      }
      if (consume !== false) {
        if (approval?.scope === 'once') localApprovals.delete(approval.id)
        if (typeof onExecute === 'function') onExecute()
      }
      if (approval) return { ok: true, approvalId: approval.id, approvalScope: approval.scope }
      return policyConfigured ? { ok: true } : { ok: true, policyDisabled: true }
    },
  }
}

export { canonicalExe, keyOf, matches }
