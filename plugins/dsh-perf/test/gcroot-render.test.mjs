// #2 perf_gcroot 渲染层契约（离线、喂合成对象）。渲染文本是 agent 唯一看得见的东西，必须单测。
// node plugins/dsh-perf/test/gcroot-render.test.mjs
import { renderGcRoot } from '../lib/render.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- 失败要出声（不能静默空）
{
  ok(renderGcRoot(null).includes('未产出'), 'null → 明确"未产出"，不是空串')
  const f = renderGcRoot({ ok: false, error: 'HeapRoots 不可用：X' })
  ok(f.includes('失败') && f.includes('HeapRoots 不可用'), '失败带原因')
}

// ---- 只有 Top 类型（无 type）
{
  const v = { ok: true, bitness: 'x86', clr: '4.8', managedTotalObjects: 100, managedTotalBytes: 2 * 1024 * 1024,
    topTypes: [{ type: 'System.Byte[]', count: 10, bytes: 1048576 }], queriedType: null,
    scopeNote: '仅托管堆…' }
  const s = renderGcRoot(v)
  ok(s.includes('x86') && s.includes('CLR 4.8'), '打印位数 + CLR 版本')
  ok(s.includes('System.Byte[]') && s.includes('1.0MB'), 'Top 类型 + 字节数（MB）')
  ok(s.includes('perf_gcroot(dumpPath, type='), '无 type 时提示怎么查保留链')
  ok(s.includes('仅托管堆'), '口径提示恒打印')
}

// ---- 有 type + 保留链
{
  const v = { ok: true, bitness: 'x64', clr: '10.0', managedTotalObjects: 5, managedTotalBytes: 100,
    topTypes: [], queriedType: 'LeakBait', typeMatchedObjects: 2000,
    rootPaths: [
      { rootKind: 'StrongHandle', depth: 3, chain: [{ type: 'System.Object[]' }, { type: 'System.Collections.Generic.List<LeakBait>' }, { type: 'LeakBait' }] },
    ],
    scopeNote: '单次快照…' }
  const s = renderGcRoot(v)
  ok(s.includes('「LeakBait」匹配 2000'), '报匹配对象数')
  ok(s.includes('[root:StrongHandle]'), '标注 root 种类')
  ok(s.includes('System.Object[]  →  System.Collections.Generic.List<LeakBait>  →  LeakBait'), '保留链按 root→对象 顺序 + 箭头')
  ok(s.includes('把这条链上的持有者断开'), '给出"读法/怎么修"的可操作解释')
}

// ---- 有 type 但没找到路径：要出声，不能读成"没被引用"
{
  const v = { ok: true, bitness: 'x86', clr: '4.8', managedTotalObjects: 5, managedTotalBytes: 100, topTypes: [],
    queriedType: 'Foo', typeMatchedObjects: 3, rootPaths: [] }
  const s = renderGcRoot(v)
  ok(s.includes('没找到到 root 的路径') && s.includes('不代表它没被引用'), '空路径要说清"没触达 ≠ 没被引用"')
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: perf_gcroot 渲染层（失败出声 / Top 类型 / 保留链顺序 / 空路径诚实 / 口径恒打印）')
