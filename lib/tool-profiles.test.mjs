import assert from 'node:assert/strict'
import { toolGroup, parseProfile, toolAllowed } from './tool-profiles.mjs'

// 分组：按前缀
assert.equal(toolGroup('ui_launch'), 'ui')
assert.equal(toolGroup('ui_jev'), 'ui')
assert.equal(toolGroup('build_run'), 'build')
assert.equal(toolGroup('dev_csharp'), 'dev')
assert.equal(toolGroup('perf_dump'), 'perf')
assert.equal(toolGroup('hang_run'), 'hang')
assert.equal(toolGroup('memory_save'), 'memory')
assert.equal(toolGroup('capture_query'), 'capture')
assert.equal(toolGroup('failure_stats'), 'failure')
// core：基础设施
assert.equal(toolGroup('http_request'), 'core')
assert.equal(toolGroup('jev_decide'), 'core')
assert.equal(toolGroup('verify_report'), 'core')
assert.equal(toolGroup('toolchain_status'), 'core')
assert.equal(toolGroup('toolchain_job'), 'core')

// 默认全开（未设 / 空 / 全空白 → null）
assert.equal(parseProfile(''), null)
assert.equal(parseProfile(undefined), null)
assert.equal(parseProfile('   '), null)
assert.equal(toolAllowed('ui_launch', null), true)
assert.equal(toolAllowed('perf_dump', null), true)

// 设 profile=ui,build：只放行 ui/build + core，其余域剔除
const p = parseProfile('ui, build')
assert.equal(toolAllowed('ui_launch', p), true)
assert.equal(toolAllowed('ui_jev', p), true)
assert.equal(toolAllowed('build_run', p), true)
assert.equal(toolAllowed('dev_csharp', p), false)
assert.equal(toolAllowed('dev_read', parseProfile('dev')), true)
assert.equal(toolAllowed('perf_dump', p), false)
assert.equal(toolAllowed('memory_save', p), false)
assert.equal(toolAllowed('capture_query', p), false)
// core 恒在（任何 profile 都保留基础设施）
assert.equal(toolAllowed('toolchain_status', p), true)
assert.equal(toolAllowed('verify_report', p), true)
assert.equal(toolAllowed('toolchain_job', p), true)
assert.equal(toolAllowed('http_request', p), true)
assert.equal(toolAllowed('jev_decide', p), true)

// 大小写 / 分隔符宽松
assert.equal(toolAllowed('perf_dump', parseProfile('PERF')), true)
assert.equal(toolAllowed('hang_run', parseProfile('ui perf hang')), true)

console.log('PASS: tool profiles grouping and filtering')
