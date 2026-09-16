// P0-1 —— CLR 事件解析/汇总自测。对着**真采样** fixture（test/fixtures/clr-gc-events.xml，
// 由 logman 起 Microsoft-Windows-DotNETRuntime 会话 + PowerShell 强制 GC 采得，tracerpt 解码）跑，零猜。
// 离线、无依赖：node plugins/dsh-perf/test/clr-events.test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSystemTimeMs, parseClrEvents, summarizeClr } from '../lib/clr-events.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- parseSystemTimeMs：只关心差值，保留亚毫秒
{
  const a = parseSystemTimeMs('2026-09-16T15:33:14.878234700+07:59')
  const b = parseSystemTimeMs('2026-09-16T15:33:14.887300200+07:59')
  ok(Number.isFinite(a) && Number.isFinite(b), 'SystemTime 可解析为有限毫秒')
  ok(Math.abs((b - a) - 9.0655) < 0.01, 'SystemTime 差值保留亚毫秒精度（≈9.07ms）；实际=' + (b - a).toFixed(4))
  ok(Number.isNaN(parseSystemTimeMs('')) , '空串 → NaN')
  ok(Number.isNaN(parseSystemTimeMs('not-a-time')), '垃圾串 → NaN')
}

// ---- 对真 fixture 端到端
{
  const xml = readFileSync(join(here, 'fixtures', 'clr-gc-events.xml'), 'utf8')
  const evs = parseClrEvents(xml)
  ok(evs.length === 6, '解析出 6 条 CLR 事件；实际=' + evs.length)
  ok(evs.every((e) => Number.isFinite(e.timeMs)), '每条都有有限时间戳')
  const kinds = new Set(evs.map((e) => e.kind))
  ok(kinds.has('GC/SuspendEEStart') && kinds.has('GC/RestartEEStop'), '含 Suspend/Restart 停顿对')
  ok(kinds.has('GC/Start') && kinds.has('GC/HeapStats'), '含 GC/Start 与 GC/HeapStats')

  const s = summarizeClr(evs)
  ok(s.gcCount === 1, 'gcCount=1；实际=' + s.gcCount)
  ok(s.byGen.gen0 === 1 && s.byGen.gen1 === 0 && s.byGen.gen2 === 0, 'GC 是 gen0（Depth=0）；实际=' + JSON.stringify(s.byGen))
  ok(s.pauseMs.count === 1, '识别出 1 段 GC 停顿；实际=' + s.pauseMs.count)
  ok(Math.abs(s.pauseMs.maxMs - 9.07) < 0.05, '★ GC 停顿时长≈9.07ms（SuspendEE→RestartEEStop，就是卡 UI 线程的那段）；实际=' + s.pauseMs.maxMs)
  ok(s.pauseMs.totalMs === s.pauseMs.maxMs, '单段时 total=max')
  ok(s.heap && s.heap.gcHandleCount === 462, 'GC 句柄数=462（来自 HeapStats 尾值）；实际=' + (s.heap && s.heap.gcHandleCount))
  ok(s.heap && s.heap.gen1 === 3289216, 'gen1 尾值=3289216；实际=' + (s.heap && s.heap.gen1))
  ok(s.contentionCount === 0, '本 fixture 无争用事件；实际=' + s.contentionCount)
}

// ---- 空输入不抛
{
  ok(parseClrEvents('').length === 0, '空 XML → 0 事件')
  ok(parseClrEvents(null).length === 0, 'null → 0 事件')
  const s = summarizeClr([])
  ok(s.gcCount === 0 && s.pauseMs.count === 0 && s.heap === null, '空事件汇总为零值、heap=null（不编造）')
}

// ---- 非 CLR provider 的事件必须被过滤掉（只认 e13c0d23）
{
  const kernel = '<Event><System><Provider Guid="{3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c}" /><TimeCreated SystemTime="2026-09-16T15:33:14.100000000+07:59" /></System><RenderingInfo><Task>Thread </Task><Opcode>CSwitch </Opcode></RenderingInfo></Event>'
  ok(parseClrEvents(kernel).length === 0, '内核 provider 事件被过滤（只保留 CLR e13c0d23）')
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: clr-events (all checks)')
