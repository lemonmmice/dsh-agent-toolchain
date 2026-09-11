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
  const policyConfigured = rules !== undefined || Boolean(policyFile)
  let safetyPolicyText = null
  try {
    if (safetyPolicyFile && fs.existsSync(safetyPolicyFile)) safetyPolicyText = fs.readFileSync(safetyPolicyFile, 'utf8')
    parsed = rules !== undefined ? parseRules(rules) : (policyFile && fs.existsSync(policyFile) ? parseRules(JSON.parse(fs.readFileSync(policyFile, 'utf8'))) : null)
  } catch { parsed = undefined }
  let stoppedSession = null
  const readOnly = action => typeof classifyAction === 'function' && classifyAction(action) === READ_ONLY
  // 无 session 一律归一到 '__default__'：stop/reset/check 三处语义必须对称
  // （原实现里 `stop()` 不带参会把 stoppedSession 置 null = 解除急停，而 check() 把无 session 当
  //   '__default__'，语义不对称 —— 谁把 stop() 当"停所有"用就恰好停了个寂寞。）
  const normSession = (sessionId) => (sessionId == null ? '__default__' : String(sessionId))
  const stop = sessionId => { stoppedSession = normSession(sessionId) }
  const reset = sessionId => { if (stoppedSession !== null && normSession(sessionId) === stoppedSession) stoppedSession = null }
  return {
    diagnostics: { safetyPolicyText },
    // 门是否需要跑：配了规则表，或急停哨兵存在（急停是外部总闸，与是否配策略无关）。
    // 两者都没有 → 调用方直接跳过，零开销（保持既有行为；这是显式的集成取舍，不是隐式默认）。
    needsCheck: () => policyConfigured || Boolean(estopFile && fs.existsSync(estopFile)),
    // 只有规则表判定才需要进程身份；纯急停不需要（身份解析要走一次 status，能省则省）。
    requiresIdentity: Boolean(policyConfigured),
    isConfigured: () => Boolean(policyConfigured),
    stop,
    reset,
    check({ action, identity = {}, snapshot, targetWindowHandle, allowSideEffects = false, sessionId, onExecute } = {}) {
      if (readOnly(action)) return { ok: true, readOnly: true }
      // 急停是**全局总闸**：只要哨兵文件在盘上，任何 session 一律拒 —— 与 per-session 锁存解耦。
      // （原实现把文件存在性检查门在 `stoppedSession === null` 后面，于是"第一个锁存的 session"之后
      //   文件是否还在再也不复查，换个 session 直接放行 —— 独立复核 repro 1 复现，与"总闸"语义冲突。）
      if (estopFile && fs.existsSync(estopFile)) {
        if (stoppedSession === null) stoppedSession = normSession(sessionId)
        return { ok: false, code: 'stopped_by_user', error: '急停已生效（哨兵文件在盘上）' }
      }
      // 文件被删掉后仍保持**粘性**：已锁存的 session 继续拒（删文件 ≠ 复位，复位走显式 reset）。
      if (stoppedSession !== null && normSession(sessionId) === stoppedSession) {
        return { ok: false, code: 'stopped_by_user', error: '急停已生效（需显式复位，删除哨兵文件不构成复位）' }
      }
      // 未配置规则表时保持既有行为；配置后严格 deny-first。
      if (!policyConfigured) return { ok: true, policyDisabled: true }
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








