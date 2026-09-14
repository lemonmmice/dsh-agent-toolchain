// 过滤语义的**漂移哨兵**（F-046 / F-047，2026-09-12）。
//
// 背景（真缺陷，不是洁癖）：
//   · `lib/capture-store.mjs` 有一套过滤管线（MCP 面 + queryPage 用）；
//   · `plugins/dsh-api-visualizer/lib/index.js` **另有一套**（面板路由 + DSH 工具用）。
//   两套已经漂移过：插件的少了 `runId` 过滤，而 `api_capture_append` 的描述却写着"与查询过滤 runId 配套使用"；
//   两套又**同时**犯同一个错 —— `maxBytes` 把"字节数未知"当成 0 字节，于是未知大小的记录**通过**"≤N 字节"。
//
// 为什么是源码级断言而不是行为断言：插件那份 `lib/index.js` 顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
//   普通 node 进程里**import 不进来**（本仓第 26 类教训：危险/关键路径"零测试"的原因常常是"模块根本进不来"）。
//   所以这里只钉住**两处必须一致的关键写法**，并在注释里明说这是哨兵、不是证明：
//   真正的修法是让插件**改用共享实现**（同一件事不许有第二份实现），已记入下一轮待办。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const shared = readFileSync(join(repo, 'lib', 'capture-store.mjs'), 'utf8')
const plugin = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

for (const [label, src] of [['shared(capture-store)', shared], ['plugin(lib/index.js)', plugin]]) {
  check(`${label}: min/max 字节过滤**不**把缺失字段当成 0 字节`,
    /Number\.isFinite\(Number\(r\.bytesRes\)\) && Number\(r\.bytesRes\) <= filter\.maxBytes/.test(src) ||
    /Number\.isFinite\(Number\(r\.bytesRes\)\) && Number\(r\.bytesRes\) <= maxBytes/.test(src),
    '（旧写法是 (Number(r.bytesRes) || 0) <= …）')
  check(`${label}: durationMs 过滤要求字段真的存在`,
    /Number\.isFinite\(r\.durationMs\) && r\.durationMs >=/.test(src))
  check(`${label}: 带"字段缺失"计数桶 excludedNoField`, /excludedNoField/.test(src))
  check(`${label}: 支持 runId 过滤`, /r\.runId === runId/.test(src) || /r\.runId === runIdFilter/.test(src))
  check(`${label}: errors 过滤同样计数"没有 status"的记录`, /noField\.status \+=/.test(src))
}

// 反向断言：旧写法必须**彻底消失**（否则等于两条路各走一半）。
// 注意要**先去掉注释行**再断言 —— 我第一版直接扫全文，结果被自己解释这个 bug 的注释判红
// （"注释里提到旧写法"和"代码里还在用旧写法"是两回事）。
const codeOnly = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('shared 里已无 "(Number(r.bytesRes) || 0)" 旧写法（排除注释）', !/Number\(r\.bytesRes\) \|\| 0/.test(codeOnly(shared)))
check('plugin 里已无 "(Number(r.bytesRes) || 0)" 旧写法（排除注释）', !/Number\(r\.bytesRes\) \|\| 0/.test(codeOnly(plugin)))

// 求和场景（timeline / sessions）：可以按 0 求和，但**必须**带出"有几条是未知"
for (const [label, src] of [['shared(capture-store)', shared], ['plugin(lib/index.js)', plugin]]) {
  if (!/bytesUnknown/.test(src)) continue // 共享库不负责聚合，跳过
  check(`${label}: 聚合求和带出 bytesUnknown（否则"已知部分合计"会被读成"总流量"）`, /bytesUnknown \+= 1/.test(src))
}

// runId 这个参数必须**两面都有**（G1 黑盒：MCP 有、DSH 没有 —— 而 append 的描述说"配套使用"）
check('DSH 面 api_capture_query 暴露 runId 参数', /runId: \{ type: 'string', description: 'Evidence-pack run id filter/.test(plugin))

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 过滤语义漂移哨兵（shared vs plugin）')
