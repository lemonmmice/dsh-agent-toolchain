// P1-1c —— 只读工具集 + 并发标记单一真源自测。离线、无依赖：node lib/tool-registry-readonly.test.mjs
// 验证：① isReadOnly/mcpAnnotations 契约；② 只读集**不含**任何已知副作用工具（deny-first 不破防）；
// ③ 只读集里的名字都真实存在于 REGISTRY（防手滑拼错一个永不生效的名字）。
import { REGISTRY, isReadOnly, mcpAnnotations } from './tool-registry.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- ① 契约
ok(isReadOnly('perf_report') === true, 'perf_report 只读')
ok(isReadOnly('ui_observe') === true, 'ui_observe 只读（驱动器只读入口，写动作另由 allowSideEffects 门控）')
ok(isReadOnly('build_run') === false, 'build_run 非只读')
ok(isReadOnly('不存在的工具') === false, '未知工具 fail-closed → 非只读')
ok(JSON.stringify(mcpAnnotations('perf_report')) === JSON.stringify({ readOnlyHint: true }), '只读工具 → {readOnlyHint:true}')
ok(mcpAnnotations('build_run') === undefined, '非只读工具 → 不注解(undefined)')
ok(mcpAnnotations('ui_act') === undefined, 'ui_act(真副作用) → 不注解')

// ---- ② 只读集必须与"已知副作用工具"不相交（这些**绝不能**被误标只读并行）
const MUST_NOT_BE_READONLY = [
  'build_run', 'ui_act', 'ui_drive', 'ui_flow', 'ui_launch', 'ui_live',
  'perf_probe', 'perf_dump', 'perf_trace', 'perf_hotstacks', 'perf_clean',
  'hang_run', 'hang_stop', 'hang_analyze', 'hang_delete',
  'memory_index', 'memory_save', 'memory_forget',
  'failure_record', 'failure_retract',
  'capture_start', 'capture_stop', 'capture_append',
  'http_request', 'verify_report',
]
for (const t of MUST_NOT_BE_READONLY) {
  ok(isReadOnly(t) === false, `副作用工具不得被标只读：${t}`)
}

// ---- ③ 只读集里每个名字都在 REGISTRY 里（拼错的名字会静默永不生效）
const READ_ONLY_EXPECTED = [
  'build_status', 'build_errors', 'build_compile_check',
  'ui_status', 'ui_state', 'ui_windows', 'ui_tree', 'ui_observe',
  'perf_report', 'perf_heap', 'perf_analyze',
  'hang_status', 'hang_packs', 'hang_pack',
  'memory_search', 'memory_recall', 'memory_status',
  'failure_query', 'failure_stats',
  'capture_query', 'capture_status',
  'toolchain_status',
]
for (const t of READ_ONLY_EXPECTED) {
  ok(isReadOnly(t) === true, `期望只读：${t}`)
  ok(Boolean(REGISTRY[t]), `只读名字存在于 REGISTRY：${t}`)
}
ok(READ_ONLY_EXPECTED.length === 22, '只读集共 22 个（改动数量需显式对齐本断言）；实际期望列表=' + READ_ONLY_EXPECTED.length)

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: tool-registry read-only set (all checks)')
