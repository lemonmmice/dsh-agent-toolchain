// 「预期内拒绝」vs「证据账本的 denied」两个判定的离线自测：node plugins/dsh-ui-drive/test/refusal.test.mjs
import { isExpectedRefusal, isGateDenied } from '../lib/refusal.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// 失败库不该记的：闸门按设计拒绝 + 目标未配置
for (const flag of ['policyCode', 'requiresAllowSideEffects', 'unconfigured', 'staleSnapshot', 'expiredSnapshot', 'unknownSnapshot']) {
  ok(isExpectedRefusal({ ok: false, [flag]: flag === 'policyCode' ? 'deny-rule' : true }) === true, `${flag} → 预期内拒绝（不记 tool-error）`)
}
// 失败库该记的：工具真的没做成
ok(isExpectedRefusal({ ok: false, error: '未找到主窗口' }) === false, '普通失败 → 要记')
ok(isExpectedRefusal({ ok: false, timedOut: true }) === false, '超时 → 要记')
ok(isExpectedRefusal({ ok: false, notExecuted: true, queueTimeout: true }) === false, '排队超时 → 要记（拥堵信号）')
ok(isExpectedRefusal(null) === false && isExpectedRefusal(undefined) === false, '空结果 → false')

// 证据账本：在预期内拒绝之外，notExecuted 也算 denied（动作从未发出）
ok(isGateDenied({ notExecuted: true }) === true, '账本：notExecuted → denied')
ok(isGateDenied({ unknownSnapshot: true }) === true, '账本：快照拒绝 → denied')
ok(isGateDenied({ ok: false, error: 'x' }) === false, '账本：执行器跑了但失败 → 不是 denied')

// 与重构前 driver.mjs 里的内联表达式逐组合对照（重构必须不改语义）
const legacy = (res) => !!(res && (res.policyCode || res.requiresAllowSideEffects || res.notExecuted || res.unconfigured || res.staleSnapshot || res.expiredSnapshot || res.unknownSnapshot))
const flags = ['policyCode', 'requiresAllowSideEffects', 'notExecuted', 'unconfigured', 'staleSnapshot', 'expiredSnapshot', 'unknownSnapshot', 'timedOut']
let mismatches = 0
for (let mask = 0; mask < 1 << flags.length; mask++) {
  const res = { ok: false }
  flags.forEach((f, i) => { if (mask & (1 << i)) res[f] = true })
  if (isGateDenied(res) !== legacy(res)) mismatches++
}
ok(mismatches === 0, `isGateDenied 与重构前内联判据在全部 ${1 << flags.length} 种组合下一致`)

console.log(failures === 0 ? '\nPASS: refusal predicates' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
