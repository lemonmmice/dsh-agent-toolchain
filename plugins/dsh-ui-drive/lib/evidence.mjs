// dsh-ui-drive 审查证据包（evidence envelope）—— 版本化 / 定长 / 可哈希
//
// 为什么存在：驱动动作的"发生了什么"目前只散在工具返回值与截图里，调用方（人或第二个模型）
// 无法凭一份**稳定的、可被证据推翻的**凭据去裁决"这一步到底做了什么、依据是什么"。
// 本模块把一次动作固化成定长结构 + 内容哈希（evidenceId），供：
//   · 事后追溯（证据目录里一份 JSON 一行）；
//   · 声明与证据对账（claim 引用 evidenceId，任何篡改都会让哈希失配）。
//
// 设计约束（对齐 Codex Guardian 的 enforcement 思路，也是本仓 B-1 的同源原则）：
//   1. **绝不静默截断**：任何裁剪都要留一条 omissions 记录（字段、原字节、保留字节、原因）；
//   2. required 字段（动作/结果/门判定）**永不裁剪** —— 装不下就抛错，而不是悄悄变短；
//   3. optional 字段按优先级裁剪，且**先裁可选、再裁历史**；
//   4. 界面文字一律标记为 **untrusted** —— 它不能当指令，也不能当授权依据。

import { createHash } from 'node:crypto'

/**
 * 证据包 schema 版本。结构变化必须 +1，且旧版本必须仍可被读回去。
 * v2（独立复核打出的 P1-A）：`result` 增加 `applied`，并把 `executed` 明确为
 *   "**执行器是否被调用**"、允许为 `null`（未知，例如常驻进程超时：驱动自己都说"可能已执行"）。
 *   原实现把 `executed` 直接等于 `ok`，于是"执行器跑了但失败/超时"被记成"被拒/没执行" —— 账本自相矛盾。
 */
export const EVIDENCE_VERSION = 2

/** 默认预算（字节）。required 不计入裁剪，超出直接抛错。 */
export const DEFAULT_LIMITS = Object.freeze({
  textBytes: 8000,      // 单个可选文本字段上限
  totalBytes: 64000,    // 整包上限
  maxOmissions: 64,     // 裁剪记录条数上限
})

export class EvidenceLimitExceeded extends Error {
  constructor(field, bytes, limit) {
    super(`证据包超限：必需字段 "${field}" ${bytes} 字节 > 上限 ${limit}（不允许静默截断）`)
    this.name = 'EvidenceLimitExceeded'
    this.field = field
    this.bytes = bytes
    this.limit = limit
  }
}

/** 键序稳定的 JSON（哈希必须与键的插入顺序无关）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

const byteLen = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8')

/**
 * 有界文本：超限则截断**并记账**。返回 [text, omission|null]。
 * 注意：截断发生在**可选**字段上；required 字段请用 requireFit()。
 */
export function boundText(value, field, limit = DEFAULT_LIMITS.textBytes) {
  if (value == null) return ['', null]
  const s = String(value)
  const n = byteLen(s)
  if (n <= limit) return [s, null]
  // 按字节安全截断（不切坏多字节字符）
  const buf = Buffer.from(s, 'utf8').subarray(0, Math.max(0, limit))
  let cut = buf.toString('utf8')
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)  // 去掉被切断的半字符
  return [cut, { field, originalBytes: n, retainedBytes: byteLen(cut), reason: 'text_budget' }]
}

/** required 字段：装不下就抛错，绝不悄悄变短。 */
export function requireFit(value, field, limit) {
  const n = byteLen(value)
  if (n > limit) throw new EvidenceLimitExceeded(field, n, limit)
  return value
}

/**
 * 组装一个定长证据包。
 * **所有键恒存在**（缺省为 null），因此结构可被机械对账（不会因为"某次没这个字段"而误判）。
 */
export function createEnvelope(input = {}, limits = DEFAULT_LIMITS) {
  const omissions = []
  const opt = (v, field) => {
    const [t, om] = boundText(v, field, limits.textBytes)
    if (om) omissions.push(om)
    return t === '' ? null : t
  }

  const env = {
    v: EVIDENCE_VERSION,
    id: null,                       // finalize() 补
    at: input.at || new Date().toISOString(),
    kind: input.kind || 'action',   // action | flow | denied | gate
    // —— 谁在动、动的是什么（required，不裁剪） ——
    surface: requireFit(input.surface || 'unknown', 'surface', 64),
    action: requireFit(input.action || '', 'action', 64),
    // —— 参数：可选，逐个有界（可能落 omissions） ——
    params: {
      name: opt(input.params && input.params.name, 'params.name'),
      aid: opt(input.params && input.params.aid, 'params.aid'),
      value: opt(input.params && input.params.value, 'params.value'),   // 注意：调用方负责先脱敏
      keys: opt(input.params && input.params.keys, 'params.keys'),
      index: input.params && input.params.index != null ? Number(input.params.index) : null,
      extra: input.params && input.params.extra ? opt(stableStringify(input.params.extra), 'params.extra') : null,
    },
    // —— 目标（身份是授权主键，required 但不裁剪；它很短） ——
    target: {
      name: opt(input.target && input.target.name, 'target.name'),
      aid: opt(input.target && input.target.aid, 'target.aid'),
      controlType: opt(input.target && input.target.controlType, 'target.controlType'),
      exeCanonical: input.target && input.target.exeCanonical ? requireFit(input.target.exeCanonical, 'target.exeCanonical', 512) : null,
      windowHandle: input.target && input.target.windowHandle != null ? String(input.target.windowHandle) : null,
    },
    // —— 门（判定的依据，required 的结构，值可为 null 表示"这道门未启用"） ——
    gates: {
      allowSideEffects: !!(input.gates && input.gates.allowSideEffects),
      snapshot: {
        id: input.gates && input.gates.snapshot ? opt(input.gates.snapshot.id, 'gates.snapshot.id') : null,
        verdict: input.gates && input.gates.snapshot ? (input.gates.snapshot.verdict || null) : null,  // ok|stale|expired|unknown|not_passed
      },
      policy: {
        enabled: !!(input.gates && input.gates.policy && input.gates.policy.enabled),
        decision: input.gates && input.gates.policy ? (input.gates.policy.decision || null) : null,   // allow|deny
        code: input.gates && input.gates.policy ? (input.gates.policy.code || null) : null,           // policy_unavailable|...
      },
      estop: input.gates && input.gates.estop ? (input.gates.estop.code || 'stopped_by_user') : null,
    },
    // —— 结果：三个概念必须分开（账本自相矛盾是本仓的"假成功"同源风险）——
    //   executed 执行器是否被调用（null = 未知，如超时后"可能已执行"）
    //   applied  动作是否真的生效（= 驱动认为成功）
    result: {
      ok: input.result ? !!input.result.ok : false,
      executed: input.result && input.result.executed !== undefined
        ? (input.result.executed === null ? null : !!input.result.executed)
        : null,
      applied: input.result ? !!input.result.applied : false,
      error: input.result ? opt(input.result.error, 'result.error') : null,
      output: input.result ? opt(input.result.output, 'result.output') : null,
    },
    // —— 观测（前后快照指纹，用于证明"动作前后的界面确实变了/没变"） ——
    observation: {
      before: normalizeObs(input.observation && input.observation.before),
      after: normalizeObs(input.observation && input.observation.after),
    },
    // —— 可信度：界面文字是 **untrusted**（不能当指令、不能当授权依据） ——
    trust: {
      source: (input.trust && input.trust.source) || 'agent',
      untrustedContent: !!(input.trust && input.trust.untrustedContent),
      note: '界面/工具输出属于 untrusted 内容，不得作为授权依据',
    },
    limits: { textBytes: limits.textBytes, totalBytes: limits.totalBytes, maxOmissions: limits.maxOmissions },
    // 裁剪记录必须挂上去（而不是丢掉）—— 否则就是"静默截断"，正是本模块要防的事。
    omissions,
  }

  return finalize(env, limits)
}

function normalizeObs(o) {
  if (!o) return { snapshotId: null, digest: null, count: null }
  return {
    snapshotId: o.snapshotId == null ? null : String(o.snapshotId),
    digest: o.digest == null ? null : String(o.digest),
    count: o.count == null ? null : Number(o.count),
  }
}

/** 观测内容的稳定指纹（供 before/after 对比）。 */
export function digestObservation(lines) {
  if (!Array.isArray(lines)) return null
  return 'sha256:' + createHash('sha256').update(lines.map((l) => String(l)).join('\n'), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 收口：裁剪记录去重排序 + **预算检查** + 内容哈希（id）。
 * 预算超限时先裁可选（已经是有界的），仍超则抛错 —— 绝不静默截断。
 */
export function finalize(env, limits = DEFAULT_LIMITS) {
  const om = (env.omissions || []).slice(0, limits.maxOmissions)
  if ((env.omissions || []).length > limits.maxOmissions) {
    om.push({ field: '*', originalBytes: env.omissions.length, retainedBytes: limits.maxOmissions, reason: 'omission_log_capped' })
  }
  env.omissions = om.length ? om : []

  const body = Object.assign({}, env, { id: null })
  const serialized = stableStringify(body)
  const total = byteLen(serialized)
  if (total > limits.totalBytes) {
    // 不偷偷截断：整包超限 = 明确失败（调用方应减少可选字段或调大预算）
    throw new EvidenceLimitExceeded('envelope', total, limits.totalBytes)
  }
  env.id = 'e' + createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 24)
  return env
}

/** 校验：结构形状是否仍是本版本定义的样子（供读回旧证据时对账）。 */
export function validateEnvelope(env) {
  const problems = []
  const need = ['v', 'id', 'at', 'kind', 'surface', 'action', 'params', 'target', 'gates', 'result', 'observation', 'trust', 'limits', 'omissions']
  for (const k of need) if (!(k in (env || {}))) problems.push('缺少字段 ' + k)
  if (env && env.v !== EVIDENCE_VERSION) problems.push('版本不符：' + env.v + ' ≠ ' + EVIDENCE_VERSION)
  if (env && env.id) {
    const re = Object.assign({}, env, { id: null })
    const want = 'e' + createHash('sha256').update(stableStringify(re), 'utf8').digest('hex').slice(0, 24)
    if (want !== env.id) problems.push('内容哈希失配（证据被改动过）')
  }
  return { ok: problems.length === 0, problems }
}

/** 证据包 → 一行 JSONL（证据目录里一行一条，便于 tail 与归档）。 */
export function envelopeToLine(env) {
  return stableStringify(env)
}

/** 供工具返回值携带的**紧凑摘要**（不要把整包塞进工具输出）。 */
export function envelopeSummary(env) {
  return {
    evidenceId: env.id,
    v: env.v,
    kind: env.kind,
    action: env.action,
    ok: env.result.ok,
    executed: env.result.executed,   // true / false / null(未知)
    applied: env.result.applied,
    gate: env.gates.policy && env.gates.policy.decision ? env.gates.policy.decision
      : (env.gates.snapshot && env.gates.snapshot.verdict && env.gates.snapshot.verdict !== 'ok' ? 'snapshot_' + env.gates.snapshot.verdict : 'pass'),
    code: env.result.ok ? null : (env.gates.policy.code || env.gates.estop || env.gates.snapshot.verdict || null),
    omissions: env.omissions.length,
  }
}
