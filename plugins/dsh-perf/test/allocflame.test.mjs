// #3 分配火焰图解析自测 —— 重点钉 allocTypeName（TypeName 含逗号的泛型名不能按逗号切）。
// 离线：node plugins/dsh-perf/test/allocflame.test.mjs
import { allocTypeName, normalizeFrame } from '../lib/flame.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// 真 AllocationTick 行尾（来自本机实测 csv）：…, 0xTypeID, "TypeName", HeapIndex, 0xAddr
{
  const simple = 'Microsoft-Windows-DotNETRuntime/GarbageCollection/GCAllocationTick,  379857, "Unknown" (19584), 29132, 5, , , , , 0x1a028, 0, 40, 0x1a028, 0x7ffbaac9eb20, "System.Threading.ExecutionContext", 0, 0x8e50de38'
  ok(allocTypeName(simple) === 'System.Threading.ExecutionContext', '普通类型名；实际=' + allocTypeName(simple))

  // ★ 泛型 TypeName **自带逗号** —— 按逗号 split 会截断，必须靠引号对提取
  const generic = 'GCAllocationTick, 1, "Unknown" (100), 2, 5, , , , , 0x1a040, 0, 40, 0x1a040, 0x7ffb, "System.Threading.Tasks.Task`1[System.Int32]", 0, 0x1'
  ok(allocTypeName(generic) === 'System.Threading.Tasks.Task`1[System.Int32]', '泛型（单逗号）；实际=' + allocTypeName(generic))

  const nested = 'GCAllocationTick, 1, "Unknown" (100), 2, 5, , , , , 0x1, 0, 40, 0x1, 0x7ffb, "System.Collections.Generic.Dictionary`2[System.String,System.Object]", 0, 0x2'
  ok(allocTypeName(nested) === 'System.Collections.Generic.Dictionary`2[System.String,System.Object]', '嵌套泛型（多逗号）；实际=' + allocTypeName(nested))

  // 不是 AllocationTick 行 / 无类型 → null（不硬造）
  ok(allocTypeName('Stack, 1, 2, 3, 0xabc, ntdll.dll!0x1') === null, '非 alloc 行 → null')
}

// 帧规整：分配栈里的 "Unknown"!0x 在模块模式塌成 [unknown]（与 CPU 火焰图同口径）
{
  ok(normalizeFrame('"Unknown"!0x1234', 'module') === '[unknown]', 'JIT 无模块帧 → [unknown]')
  ok(normalizeFrame('clr.dll!0x1234', 'module') === 'clr.dll', '原生帧 → 模块名')
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: allocflame（AllocationTick TypeName 引号提取：普通/泛型/嵌套泛型/非alloc；帧规整）')
