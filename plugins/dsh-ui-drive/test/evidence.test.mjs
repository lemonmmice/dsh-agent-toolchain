// dsh-ui-drive W3 单测：审查证据包（版本化 / 定长 / 可哈希 / 绝不静默截断）
import {
  EVIDENCE_VERSION, DEFAULT_LIMITS, EvidenceLimitExceeded,
  createEnvelope, validateEnvelope, digestObservation, envelopeSummary,
  stableStringify, boundText, requireFit,
} from '../lib/evidence.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function throws(name, fn, cls) {
  try { fn(); check(name, false, '没有抛错') }
  catch (e) { check(name, cls ? e instanceof cls : true, e && e.name) }
}

const AT = '2026-09-11T00:00:00.000Z'
const base = {
  at: AT,   // 固定时间戳：哈希确定性是针对**内容**的，时间戳本身是内容的一部分
  surface: 'ui_drive', action: 'click',
  params: { name: '确定', aid: 'okBtn' },
  target: { name: '确定', aid: 'okBtn', controlType: 'Button', exeCanonical: 'c:\\app\\client.exe', windowHandle: '777' },
  gates: { allowSideEffects: true, snapshot: { id: 's7.g2.wNzc3', verdict: 'ok' }, policy: { enabled: true, decision: 'allow', code: null } },
  result: { ok: true, executed: true, output: 'CLICKED "确定"' },
  observation: { before: { snapshotId: 's7.g2.wNzc3', digest: 'sha256:aaa', count: 12 }, after: { snapshotId: 's8.g2.wNzc3', digest: 'sha256:bbb', count: 11 } },
  trust: { source: 'agent', untrustedContent: false },
}

// ------------------------------------------------- 1. 定长结构：所有键恒存在
{
  const e = createEnvelope({})
  const need = ['v', 'id', 'at', 'kind', 'surface', 'action', 'params', 'target', 'gates', 'result', 'observation', 'trust', 'limits', 'omissions']
  check('定长：所有顶层键恒存在（缺省为 null，不因为"这次没有"而消失）', need.every((k) => k in e), JSON.stringify(Object.keys(e)))
  check('空输入的嵌套键也在（params/target/gates/result/observation）',
    ['name', 'aid', 'value', 'keys', 'index', 'extra'].every((k) => k in e.params) &&
    ['name', 'aid', 'controlType', 'exeCanonical', 'windowHandle'].every((k) => k in e.target) &&
    ['allowSideEffects', 'snapshot', 'policy', 'estop'].every((k) => k in e.gates) &&
    ['ok', 'executed', 'error', 'output'].every((k) => k in e.result) &&
    ['before', 'after'].every((k) => k in e.observation))
  check('版本号存在且为当前版本', e.v === EVIDENCE_VERSION)
  check('可选字段缺省为 null（不是空串）', e.params.value === null && e.result.error === null)
  check('omissions 缺省为空数组（不是 null）', Array.isArray(e.omissions) && e.omissions.length === 0)
}

// ------------------------------------------------- 2. 哈希：确定性、与键序无关、可检测篡改
{
  const a = createEnvelope(base)
  const b = createEnvelope(base)
  check('同输入 → 同 id（确定性）', a.id === b.id, a.id + ' vs ' + b.id)
  check('id 形如 e<24hex>', /^e[0-9a-f]{24}$/.test(a.id), a.id)

  // 键序无关：把输入对象的键顺序打乱，id 必须不变
  const shuffled = { observation: base.observation, at: base.at, trust: base.trust, result: base.result, gates: base.gates, target: base.target, params: base.params, action: base.action, surface: base.surface }
  check('哈希与键的插入顺序无关', createEnvelope(shuffled).id === a.id)

  // 内容变了 → 哈希必须变
  const tampered = createEnvelope(Object.assign({}, base, { params: { name: '取消', aid: 'okBtn' } }))
  check('内容变化 → id 变化', tampered.id !== a.id)

  check('validateEnvelope 对完好证据返回 ok', validateEnvelope(a).ok === true, JSON.stringify(validateEnvelope(a).problems))
  const forged = Object.assign({}, a, { result: Object.assign({}, a.result, { executed: true, ok: true, output: 'FABRICATED' }) })
  const v = validateEnvelope(forged)
  check('validateEnvelope 检测出被改动的证据（哈希失配）', v.ok === false && v.problems.some((p) => /哈希失配/.test(p)), JSON.stringify(v.problems))
  check('validateEnvelope 检测出版本不符', validateEnvelope(Object.assign({}, a, { v: 999 })).problems.some((p) => /版本不符/.test(p)))
}

// ------------------------------------------------- 3. 绝不静默截断：裁剪必须记账
{
  const long = 'x'.repeat(DEFAULT_LIMITS.textBytes + 500)
  const e = createEnvelope(Object.assign({}, base, { params: { value: long } }))
  check('超长可选文本被裁剪', e.params.value.length < long.length, String(e.params.value.length))
  check('裁剪**留下** omissions 记录（绝不静默）', e.omissions.length >= 1, JSON.stringify(e.omissions))
  const om = e.omissions.find((o) => o.field === 'params.value')
  check('omission 记录了字段/原字节/保留字节/原因',
    !!om && om.originalBytes > om.retainedBytes && om.reason === 'text_budget', JSON.stringify(om))
  check('boundText 不切坏多字节字符', !boundText('中'.repeat(100), 'f', 7)[0].endsWith('\uFFFD'))
}

// ------------------------------------------------- 4. required 字段装不下 → 抛错（不是悄悄变短）
{
  throws('surface 超长 → EvidenceLimitExceeded', () => createEnvelope(Object.assign({}, base, { surface: 'x'.repeat(65) })), EvidenceLimitExceeded)
  throws('action 超长 → EvidenceLimitExceeded', () => createEnvelope(Object.assign({}, base, { action: 'x'.repeat(65) })), EvidenceLimitExceeded)
  throws('exeCanonical 超长 → EvidenceLimitExceeded', () => createEnvelope(Object.assign({}, base, { target: Object.assign({}, base.target, { exeCanonical: 'x'.repeat(513) }) })), EvidenceLimitExceeded)
  check('requireFit 对刚好等长放行', requireFit('x'.repeat(10), 'f', 10).length === 10)
  throws('整包超预算 → EvidenceLimitExceeded（不偷偷截断）',
    () => createEnvelope(Object.assign({}, base, { params: { extra: 'y'.repeat(70000) } }), { textBytes: 70000, totalBytes: 1000, maxOmissions: 8 }),
    EvidenceLimitExceeded)
}

// ------------------------------------------------- 5. trust：界面内容一律 untrusted
{
  const e = createEnvelope(Object.assign({}, base, { trust: { source: 'client-ui', untrustedContent: true } }))
  check('untrusted 标记被保留', e.trust.untrustedContent === true && e.trust.source === 'client-ui')
  check('证据包自带"不可作为授权依据"的说明', /不得作为授权依据/.test(e.trust.note))
}

// ------------------------------------------------- 6. 门判定被固化进证据
{
  const denied = createEnvelope(Object.assign({}, base, {
    kind: 'denied',
    gates: { allowSideEffects: true, snapshot: { id: 's7.g2.wNzc3', verdict: 'stale' }, policy: { enabled: true, decision: 'deny', code: 'policy_unavailable' }, estop: null },
    result: { ok: false, executed: false, error: '策略拒绝' },
  }))
  check('被拒时 executed=false（与 ok=false 区分：没执行 ≠ 执行失败）', denied.result.ok === false && denied.result.executed === false)
  check('快照判定与 policy 码都留在证据里', denied.gates.snapshot.verdict === 'stale' && denied.gates.policy.code === 'policy_unavailable')
  const sum = envelopeSummary(denied)
  check('摘要紧凑且带 evidenceId / 门结论', sum.evidenceId === denied.id && sum.gate === 'deny' && sum.code === 'policy_unavailable', JSON.stringify(sum))
  const allowed = envelopeSummary(createEnvelope(base))
  check('允许时摘要 gate=allow 且 code=null', allowed.gate === 'allow' && allowed.code === null, JSON.stringify(allowed))
}

// ------------------------------------------------- 7. 观测指纹
{
  check('digestObservation 稳定', digestObservation(['#0 A', '#1 B']) === digestObservation(['#0 A', '#1 B']))
  check('digestObservation 顺序敏感', digestObservation(['#0 A', '#1 B']) !== digestObservation(['#1 B', '#0 A']))
  check('digestObservation 非数组返回 null', digestObservation(null) === null)
  check('stableStringify 键序稳定', stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }))
}

// ------------------------------------------------- 8. omissions 上限也会记账（不是默默丢）
{
  // 让**多个**可选字段都超限，才能越过 maxOmissions 上限（只裁一个字段是够不到的）
  const big = 'z'.repeat(200)
  const e = createEnvelope(
    Object.assign({}, base, { params: { name: big, aid: big, value: big, keys: big, extra: big } }),
    { textBytes: 64, totalBytes: 100000, maxOmissions: 1 },
  )
  check('omissions 达上限时补一条汇总记录', e.omissions.some((o) => o.reason === 'omission_log_capped'), JSON.stringify(e.omissions))
  check('汇总记录之外仍保留了被裁剪的事实（不是静默）', e.omissions.length > 0)
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive W3 evidence envelope test')
