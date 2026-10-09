// MCP 审批提示（readOnlyHint / destructiveHint / openWorldHint）的单一真源自测。
// 离线、无依赖：node lib/tool-annotations.test.mjs
//
// 守住三件事：
//   ① 注册表里**每个**工具恰好被分类一次（只读集 XOR 写侧效果表）—— 新工具没分类就红，
//      否则它在客户端里会静默落到"最保守"那一档，没人知道；
//   ② 已知危险的工具（删证据 / 杀进程 / 真实点击 / 任意命令 / 任意 HTTP）在 Codex 的审批规则下**必须**要审批；
//   ③ Codex 规则下"免审批"的写工具集合与预期逐一相同 —— 防止有人顺手把危险工具标成无害。
//
// ②③ 用的是 openai/codex `codex-rs/core/src/mcp_tool_call.rs` 里 `requires_mcp_tool_approval`
// （Auto 模式，自定义 server 的默认）的逐行移植；它是我们写这些注解的**理由**，所以要以可执行的形式留下来。
import { REGISTRY, isReadOnly, mcpAnnotations, toolEffects, effectToolNames } from './tool-registry.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

/** openai/codex requires_mcp_tool_approval（Auto 模式）的移植：缺省值都按"要审批"那边取。 */
function codexRequiresApproval(ann) {
  const destructive = ann?.destructiveHint
  if (destructive === true) return true
  if (ann?.readOnlyHint === true) return false
  return (destructive ?? true) || (ann?.openWorldHint ?? true)
}

const names = Object.keys(REGISTRY)

// ---- ① 每个工具恰好分类一次
const unclassified = names.filter((n) => !isReadOnly(n) && toolEffects(n) === null)
const doubly = names.filter((n) => isReadOnly(n) && toolEffects(n) !== null)
const ghosts = effectToolNames().filter((n) => !Object.hasOwn(REGISTRY, n))
ok(unclassified.length === 0, '注册表里每个写工具都有效果分类' + (unclassified.length ? '，缺：' + unclassified.join(', ') : ''))
ok(doubly.length === 0, '没有工具同时出现在只读集与效果表' + (doubly.length ? '：' + doubly.join(', ') : ''))
ok(ghosts.length === 0, '效果表里没有注册表不存在的名字' + (ghosts.length ? '：' + ghosts.join(', ') : ''))

// ---- 注解形状
for (const n of names) {
  const a = mcpAnnotations(n)
  if (isReadOnly(n)) {
    if (!(a && a.readOnlyHint === true && a.destructiveHint === undefined)) ok(false, `${n}：只读工具只带 readOnlyHint:true`)
  } else if (!(a && a.readOnlyHint === false && typeof a.destructiveHint === 'boolean' && typeof a.openWorldHint === 'boolean')) {
    ok(false, `${n}：写工具必须三项齐全（readOnlyHint:false + 两个布尔）`)
  }
}
ok(true, '全部 ' + names.length + ' 个工具的注解形状符合约定')
ok(mcpAnnotations('不存在的工具') === undefined, '未知工具不注解（客户端按最保守处理）')

// ---- ② 危险工具在 Codex 规则下必须审批
const MUST_REQUIRE_APPROVAL = [
  'perf_clean', 'hang_delete', 'memory_forget', // 不可恢复的删除
  'build_run', 'ui_launch', // 可能结束客户端进程
  'ui_act', 'ui_drive', 'ui_flow', 'ui_replay', 'ui_jev', // 真实点击/输入
  'http_request', // 任意方法打到远端
  'verify_report', // kind=gate 执行任意命令
  'memory_index', 'jev_decide', // 数据可能离开本机
]
for (const n of MUST_REQUIRE_APPROVAL) ok(codexRequiresApproval(mcpAnnotations(n)), `Codex 规则下 ${n} 必须审批`)

// ---- ③ 免审批的写工具集合逐一锁定
const EXPECTED_AUTO_APPROVED = [
  'ui_live', 'perf_probe', 'perf_dump', 'perf_trace', 'perf_hotstacks', 'perf_flame', 'perf_allocflame',
  'perf_clrevents', 'perf_uifreeze', 'hang_run', 'hang_stop', 'hang_analyze',
  'capture_start', 'capture_stop', 'capture_append', 'failure_record', 'failure_retract', 'memory_save',
].sort()
const autoApprovedWrites = names.filter((n) => !isReadOnly(n) && !codexRequiresApproval(mcpAnnotations(n))).sort()
ok(JSON.stringify(autoApprovedWrites) === JSON.stringify(EXPECTED_AUTO_APPROVED),
  '免审批写工具集合与预期一致' + (JSON.stringify(autoApprovedWrites) === JSON.stringify(EXPECTED_AUTO_APPROVED) ? '' : '：实际 ' + autoApprovedWrites.join(', ')))
// 只读工具在 Codex 规则下一律免审批
ok(names.filter((n) => isReadOnly(n)).every((n) => !codexRequiresApproval(mcpAnnotations(n))), '只读工具在 Codex 规则下全部免审批')
// 回归基线：改之前写工具一律不标 ⇒ 全部要审批
ok(codexRequiresApproval(undefined) === true, '不注解 = 要审批（这正是改之前 32 个写工具的处境）')

console.log(failures === 0 ? '\nPASS: 审批提示覆盖全部工具，危险工具一律要审批' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
