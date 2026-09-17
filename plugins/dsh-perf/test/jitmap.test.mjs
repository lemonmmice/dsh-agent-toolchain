// #4 JIT 符号映射解析自测。对着**真采样** fixture（test/fixtures/jit-rundown.xml，由 logman 起
// Microsoft-Windows-DotNETRuntimeRundown 0x118 会话、tracerpt 解码而来）跑，零猜。
// 离线、无依赖：node plugins/dsh-perf/test/jitmap.test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJitMethodsText, parseMethodEntry, sortMethods, finalizeJitMap, lookupMethod } from '../lib/jitmap.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- parseMethodEntry：单块 → {start,end,name}，含 dynamicClass 去命名空间 + 实体还原
{
  const block = '<Execution ProcessID="99"/><MethodStartAddress>0x1000</MethodStartAddress><MethodSize>0x20</MethodSize>' +
    '<MethodNamespace>dynamicClass</MethodNamespace><MethodName>GetSource</MethodName>'
  const e = parseMethodEntry(block)
  ok(e && e.start === 0x1000n && e.end === 0x1020n, 'start/end = [0x1000,0x1020)；实际=' + (e && (e.start + '..' + e.end)))
  ok(e && e.name === 'GetSource', 'dynamicClass 命名空间被丢弃，只留方法名；实际=' + (e && e.name))

  const b2 = '<MethodStartAddress>0x2000</MethodStartAddress><MethodSize>0x10</MethodSize>' +
    '<MethodNamespace>Ns.Sub</MethodNamespace><MethodName>&lt;&gt;c__DisplayClass1_0</MethodName>'
  const e2 = parseMethodEntry(b2)
  ok(e2 && e2.name === 'Ns.Sub.<>c__DisplayClass1_0', 'XML 实体还原 + 命名空间拼接；实际=' + (e2 && e2.name))

  ok(parseMethodEntry('<MethodStartAddress>0x1</MethodStartAddress><MethodSize>0x0</MethodSize>') === null, 'size=0 → null（不是方法）')
  ok(parseMethodEntry('<Data>whatever</Data>') === null, '无 MethodStartAddress → null')
}

// ---- lookupMethod：二分命中/边界/未命中
{
  const methods = sortMethods([
    { start: 0x2000n, end: 0x2010n, name: 'B' },
    { start: 0x1000n, end: 0x1020n, name: 'A' },
    { start: 0x3000n, end: 0x3100n, name: 'C' },
  ])
  ok(methods[0].name === 'A' && methods[2].name === 'C', 'sortMethods 按 start 升序')
  ok(lookupMethod(methods, 0x1000n).name === 'A', '命中区间起点')
  ok(lookupMethod(methods, 0x101fn).name === 'A', '命中区间末字节（end 前一位）')
  ok(lookupMethod(methods, 0x1020n) === null, 'end 是开区间：== end 不命中')
  ok(lookupMethod(methods, 0x2008n).name === 'B', '命中中间区间')
  ok(lookupMethod(methods, 0x2fffn) === null, '落在两区间之间 → null')
  ok(lookupMethod(methods, 0x9999n) === null, '远超所有区间 → null')
  ok(lookupMethod([], 0x1000n) === null, '空表 → null')
}

// ---- 对真 fixture 端到端
{
  const xml = readFileSync(join(here, 'fixtures', 'jit-rundown.xml'), 'utf8')
  const byPid = finalizeJitMap(parseJitMethodsText(xml))
  let total = 0
  for (const [, arr] of byPid) total += arr.length
  ok(total === 12, '共解析 12 条方法记录；实际=' + total)
  ok(byPid.has('16132') && byPid.get('16132').length === 3, 'pid 16132 有 3 个方法；实际=' + (byPid.get('16132') || []).length)

  // 真记录：pid 16132 的 GetSource@0x7FFB4EBE0080 size 0x58 ⇒ 该地址应查回 GetSource
  const m = lookupMethod(byPid.get('16132'), 0x7FFB4EBE0080n)
  ok(m && m.name === 'GetSource', '真地址 0x7FFB4EBE0080 → GetSource；实际=' + (m && m.name))
  ok(m && m.end === 0x7FFB4EBE0080n + 0x58n, 'end = start + 0x58；实际=' + (m && m.end))

  // 每桶按 start 升序（供二分）
  let sorted = true
  for (const [, arr] of byPid) for (let i = 1; i < arr.length; i++) if (arr[i - 1].start > arr[i].start) sorted = false
  ok(sorted, '每个 pid 的方法表按 start 升序')

  // 地址是进程私有：不同 pid 各自成表（不混）
  ok(byPid.size === 7, '7 个进程各自成桶；实际=' + byPid.size)
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: jitmap（#4 地址→方法 映射：解析 / 二分 / 真 fixture）')
