import fs from 'node:fs'
import path from 'node:path'
// 安全配置（急停哨兵 / 策略表）必须经 env-fallback（Codex r15 复核把它拓了出来）：
// 这些是**运维会去配**的东西，而且配不上时的语义是"**以为有护栏、其实没有**"——
// 例：运维把 DSH_UI_ESTOP_FILE 配在用户级环境变量里，长活宿主没继承 → 急停哨兵文件永远不被检查 →
// 出事时按"急停"没有任何效果；这比一般配置漏读严重得多。
import { envOr } from '../../../lib/env-fallback.mjs'

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

export function createPolicy({ rules, policyFile = envOr('DSH_UI_APP_POLICY'), safetyPolicyFile = envOr('DSH_UI_SAFETY_POLICY_FILE'), estopFile = envOr('DSH_UI_ESTOP_FILE') } = {}) {
  let parsed
  const policyConfigured = rules !== undefined || Boolean(policyFile)
  let safetyPolicyText = null
  try {
    if (safetyPolicyFile && fs.existsSync(safetyPolicyFile)) safetyPolicyText = fs.readFileSync(safetyPolicyFile, 'utf8')
    parsed = rules !== undefined ? parseRules(rules) : (policyFile && fs.existsSync(policyFile) ? parseRules(JSON.parse(fs.readFileSync(policyFile, 'utf8'))) : null)
  } catch { parsed = undefined }
  let stoppedSession = null
  // 无 session 一律归一到 '__default__'：stop/reset/check 三处语义必须对称
  // （原实现里 `stop()` 不带参会把 stoppedSession 置 null = 解除急停，而 check() 把无 session 当
  //   '__default__'，语义不对称 —— 谁把 stop() 当"停所有"用就恰好停了个寂寞。）
  const normSession = (sessionId) => (sessionId == null ? '__default__' : String(sessionId))
  const stop = sessionId => { stoppedSession = normSession(sessionId) }
  const reset = sessionId => { if (stoppedSession !== null && normSession(sessionId) === stoppedSession) stoppedSession = null }
  return {
    // ⚠ 诚实标注（Claude r15 复核发现）：这份文本**只被读进来放着**，`check()` 从不看它 ——
    //   也就是说"配了 DSH_UI_SAFETY_POLICY_FILE"**本身不拦任何动作**。原先它只静静躺在 diagnostics 里，
    //   谁也没消费 ⇒ 运维以为配了一条安全策略、实际零效果（典型的"配置在说谎"）。
    //   现在：① 状态查询会把"有没有加载、多长"报出来；② 描述里写清它**不参与判定**；
    //   ③ 真要用它拦动作，请写进 DSH_UI_APP_POLICY（deny-first 规则表）或 DSH_UI_ESTOP_FILE（总闸）。
    diagnostics: {
      safetyPolicyText,
      safetyPolicyFile: safetyPolicyFile || '',
      safetyPolicyLoaded: !!safetyPolicyText,
      safetyPolicyGatesActions: false,
    },
    // 门是否需要跑：配了规则表，或急停哨兵存在（急停是外部总闸，与是否配策略无关）。
    // 两者都没有 → 调用方直接跳过，零开销（保持既有行为；这是显式的集成取舍，不是隐式默认）。
    needsCheck: () => policyConfigured || Boolean(estopFile && fs.existsSync(estopFile)),
    // 只有规则表判定才需要进程身份；纯急停不需要（身份解析要走一次 status，能省则省）。
    requiresIdentity: Boolean(policyConfigured),
    isConfigured: () => Boolean(policyConfigured),
    stop,
    reset,
    /** 当前锁存的 session（null = 未锁）。用于把"为什么一直拒"解释清楚（Claude r15）。 */
    latchedSession: () => stoppedSession,
    // **本策略真正在用的路径**。状态查询必须问它、而不是重新去读环境变量 ——
    // 否则注入的 policy（测试、或未来的多策略）与状态输出会各说各话（我第一版就踩了这个）。
    estopFilePath: () => estopFile || '',
    policyFilePath: () => policyFile || '',
    // 注：动作分类（只读 vs 副作用）由驱动层的 classifyAction 统一负责，写侧门只在**副作用动作**上调用本函数；
    // policy 不再自行判「只读放行」（原 readOnly() 判的 READ_ONLY Symbol 全代码无人返回，恒 false = 死契约，已删）。
    check({ action, identity = {}, allowSideEffects = false, sessionId, onExecute } = {}) {
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
      // 新鲜度（快照 seq/gen/窗口）由 W1 的 validateSnapshot（driver 写侧单点）负责，policy **不**管新鲜度：
      // 集成路径下 driver 从不给 policy.check 传 snapshot，原先这里的 expiredSnapshot/staleSnapshot 判据
      // 恒不可达，只会造成「policy 在管新鲜度」的假象（2026-09 P2 复核）——故删除，杜绝第二处新鲜度判定漂移。
      if (typeof onExecute === 'function') onExecute()
      return { ok: true }
    }
  }
}

export { canonicalExe }








