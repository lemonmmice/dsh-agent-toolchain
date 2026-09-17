// perf_clrevents —— 摘要闸门 + 三态渲染自测。
//
// 为什么这个文件必须存在（而不是只留一个 bench 脚本）：这个工具**唯一**的价值就是把三态说清楚，
// 而三态里最危险的一种错法恰恰是**安静**的 —— 把「这个 etl 里根本没采 CLR」渲染成「GC 共 0 次」，
// agent 就会拿它去回答"客户端有没有 GC 停顿"。所以这里逐条钉住：
//   ① 有 CLR 的真 fixture → hasClr=true 且能出数；
//   ② 无 CLR 的真 etl（79.5 MB r61-dumped 的 tracerpt 摘要，真采样，见 fixtures/）→ hasClr=false；
//   ③ 渲染层在 ①② 两种情况下**必须说不同的话**，且未解码路径一律写「未知，不是 0」。
//
// 离线、无依赖：node plugins/dsh-perf/test/clrevents-render.test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTraceSummary, summarizeClr, parseClrEvents } from '../lib/clr-events.mjs'
import { renderClrEvents, renderTrace } from '../lib/render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- ① 有 CLR provider 的摘要（真 fixture：clrgc-framework-fixture.etl，303 KB，tracerpt -summary）
{
  const s = parseTraceSummary(readFileSync(join(here, 'fixtures', 'clr-summary.txt'), 'utf8'))
  ok(s.hasClr === true, '真 CLR fixture：hasClr=true；实际=' + s.hasClr)
  ok(s.hasClrRuntime === true && s.hasClrRundown === false, '只认 runtime（该 fixture 无 rundown）；实际 rt=' + s.hasClrRuntime + ' rd=' + s.hasClrRundown)
  ok(s.clrEvents === 1548, 'CLR 事件合计 1548（**不是 3096** —— 摘要里有两张表，只许算含 Opcode 的那张）；实际=' + s.clrEvents)
  ok(s.totalEvents === 1550 && s.lostEvents === 0, '总事件 1550 / 丢 0；实际=' + s.totalEvents + '/' + s.lostEvents)
  // ★★ 这条不变量是"两张表被加了两遍"唯一抓得住的地方：含 Opcode 的那张表各 provider 行**恰好**加总为
  //    Total Events Processed。CLR fixture 有两张表（1550 + 1550），早先版本正是因此报出 3096。
  //    ⚠ 注意它**不是万能**的：只有一张表的 etl（比如下面那份 79.5 MB 的）即使加了两遍也照样自洽 ——
  //    所以两份 fixture 都要跑这条。
  const sumClr = s.providers.reduce((a, b) => a + b.events, 0)
  ok(sumClr === s.totalEvents, 'Σ provider 行 = Total Events Processed（=1550）；实际 Σ=' + sumClr)
  ok(s.providers.some((p) => p.name === 'Microsoft-Windows-DotNETRuntime'),
    'provider 名 = Microsoft-Windows-DotNETRuntime（取自摘要表的 Event Name 列）')
}

// ---- ② **无** CLR provider 的摘要（真采样：79.5 MB 的 r61-dumped.etl 经 tracerpt -summary）
//     这就是闸门要拦住的那一类 —— 它**不是**"没有 GC"，是"没采"。
{
  const s = parseTraceSummary(readFileSync(join(here, 'fixtures', 'noclr-summary.txt'), 'utf8'))
  ok(s.hasClr === false, '无 CLR 的真 etl：hasClr=false；实际=' + s.hasClr)
  ok(s.providerCount === 10, 'provider 数=10；实际=' + s.providerCount)
  ok(s.totalEvents === 868297, '总事件 868297；实际=' + s.totalEvents)
  ok(Object.keys(s.byGuid).length === s.providerCount, 'byGuid 与 providers 一一对应')
  // 实测等式（不是猜的）：摘要表里各 provider 行的事件数**恰好**加总为 Total Events Processed
  // ⇒ 这条断言真正的价值是"**解析没漏行**"，漏一行它就不等了。
  const sum = s.providers.reduce((a, b) => a + b.events, 0)
  ok(sum === s.totalEvents, 'Σ provider 行 = Total Events Processed（=868297，证明没漏行）；实际 Σ=' + sum + ' total=' + s.totalEvents)
}

// ---- 空/坏输入不编造
{
  const e = parseTraceSummary('')
  ok(e.hasClr === false && e.totalEvents === null && e.providerCount === 0 && e.lostEvents === null,
    '空摘要 → hasClr=false / 计数为 null / provider 0（不编造）')
  ok(parseTraceSummary(null).providerCount === 0, 'null 摘要不抛且为 0')
}

// ---- provider 名必须来自 **etl 自己的摘要表**（Event Name 列），不是外部查表
//      早先版本走 `logman query providers` 反查，真机发现**内核那几个 GUID 在注册表里查不到**
//      （167 MB 的 xperf trace，10 个 provider 全落成"(未收录)"）⇒ 整块换成从摘要表取。
{
  const s = parseTraceSummary(readFileSync(join(here, 'fixtures', 'noclr-summary.txt'), 'utf8'))
  const byGuid = s.byGuid
  ok(byGuid['3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c'] && byGuid['3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c'].name === 'Thread',
    '内核 provider 反查得到名字（Thread）；实际=' + JSON.stringify(byGuid['3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c'] && byGuid['3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c'].name))
  ok(byGuid['def2fe46-7bd6-4b80-bd94-f57fe20d0ce3'] && byGuid['def2fe46-7bd6-4b80-bd94-f57fe20d0ce3'].name === 'StackWalk',
    'StackWalk provider 有名字；实际=' + JSON.stringify(byGuid['def2fe46-7bd6-4b80-bd94-f57fe20d0ce3'] && byGuid['def2fe46-7bd6-4b80-bd94-f57fe20d0ce3'].name))
  // ⚠ 不能断言"每个 provider 都有名字"：真机实测有几行第二列是 `0`（未知/经典事件），
  //   那不是名字 —— 解析器把它判成 null，渲染时列成"(未收录)"。**不许给它编一个名字。**
  const named = s.providers.filter((p) => p.name).map((p) => p.name).sort()
  ok(named.includes('Thread') && named.includes('StackWalk') && named.includes('PerfInfo') && named.includes('Image'),
    '已知的内核 provider 反查得到名字；实际=' + JSON.stringify(named))
  ok(s.providers.some((p) => p.name === null), '第二列是数字的那几行判为 null（没人给它编名字）')
  ok(s.providers.every((p) => p.name === null || /^[A-Za-z]/.test(p.name)), '名字要么是 null、要么以字母开头（不是 "0" 这种）')
  const clr = parseTraceSummary(readFileSync(join(here, 'fixtures', 'clr-summary.txt'), 'utf8'))
  ok(clr.providers.some((p) => p.name === 'Microsoft-Windows-DotNETRuntime'),
    'CLR 那份里 provider 名 = Microsoft-Windows-DotNETRuntime')
}

// ---- summarizeClr 的新增字段（topPauses / window）不许改动旧字段语义
{
  const s = summarizeClr(parseClrEvents(''))
  ok(s.gcCount === 0 && s.heap === null && s.topPauses.length === 0 && s.window === null,
    '空事件 → 零值 + heap/window 为 null（不编造）')
}

// ---- ③ 渲染：无 CLR provider 的那条路
{
  const txt = renderClrEvents({
    ok: false, state: 'no-clr-provider',
    etlPath: 'D:/ev/r61-dumped.etl', etlBytes: 83361792,
    error: '这个 etl 里**没有 CLR provider**（e13c0d23 / a669021c 都没出现）—— 这是「**没采**」，**不是「没有 GC 停顿」**。',
    providers: [
      { guid: '3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c', events: 291938, name: 'Microsoft-Windows-Kernel-Thread' },
      { guid: 'def2fe46-7bd6-4b80-bd94-f57fe20d0ce3', events: 337116, name: null },
    ],
    hint: '要拿 GC 数据，用 perf_trace(action="run", seconds=N, clr=true) 采一份带 CLR 会话的。',
  })
  ok(/没采/.test(txt), '无 provider：出现「没采」')
  ok(/不是「没有 GC 停顿」/.test(txt), '无 provider：明确否定「没有 GC 停顿」')
  ok(/291938/.test(txt) && /\(未收录\)/.test(txt), '无 provider：列出实际 provider（含查不到名字的按 GUID 列）')
  ok(!/GC：共 0 次/.test(txt), '★ 无 provider：**绝不许**出现「GC：共 0 次」（那是把"没采"写成"没有"）')
}

// ---- ③ 渲染：所有"没解出来"的路径都要写「未知，不是 0」
{
  for (const state of ['xml-too-large', 'decode-failed', 'decode-timeout', 'tracerpt-failed', 'tracerpt-timeout', 'summary-unreadable', 'xml-unreadable']) {
    const txt = renderClrEvents({ ok: false, state, etlPath: 'D:/ev/a.etl', error: '（原因）' })
    ok(/未知，不是 0/.test(txt), state + '：写明「未知，不是 0」')
  }
  const miss = renderClrEvents({ ok: false, state: 'etl-missing', error: 'etlPath 不存在：D:/nope.etl' })
  ok(/读不了/.test(miss), 'etl-missing：说的是「读不了」，不是「没有 GC」')
}

// ---- ③ 渲染：**有** provider 但窗口内 0 次 GC —— 与上面必须分得开，且这里才允许写 0
{
  const txt = renderClrEvents({
    ok: true, state: 'clr-present', etlPath: 'D:/ev/clr-events.etl', etlBytes: 4718592, xmlBytes: 20971520,
    clrRuntimeEvents: 91234, clrRundownEvents: 27262, parsedEvents: 91234,
    gcCount: 0, byGen: { gen0: 0, gen1: 0, gen2: 0 }, inducedCount: 0,
    pauseMs: { count: 0, totalMs: 0, maxMs: 0, p99Ms: 0 }, heap: null, contentionCount: 0,
    topPauses: [], eventsByKind: [{ kind: 'Method/LoadVerbose', n: 2865 }], noGcInWindow: true,
    note: '⚠ 本 etl **有 CLR provider 但窗口内 0 条 GC/Start** ⇒ 这是"这段窗口确实没发生 GC"（**与"没采"是两回事**）。',
  })
  ok(/GC：共 0 次/.test(txt), '有 provider + 0 次 GC：这里**可以**写「GC：共 0 次」')
  ok(/与"没采"是两回事/.test(txt), '有 provider + 0 次 GC：明确与"没采"区分')
  ok(/这一项未知，不是 0/.test(txt), 'heap=null 时：明说这项未知，不写 0')
  ok(/绝对时刻可能有约 1 分钟误差/.test(renderClrEvents({
    ok: true, state: 'clr-present', etlPath: 'x', etlBytes: 1, xmlBytes: 1,
    clrRuntimeEvents: 1, clrRundownEvents: 0, parsedEvents: 1,
    gcCount: 1, byGen: { gen0: 1, gen1: 0, gen2: 0 }, inducedCount: 0,
    pauseMs: { count: 1, totalMs: 9, maxMs: 9, p99Ms: 9 }, heap: null, contentionCount: 0,
    topPauses: [{ atMs: Date.parse('2026-09-17T00:00:00Z'), ms: 9 }], eventsByKind: [],
  })), '停顿时刻：如实标注 tracerpt 的绝对时刻系统性偏差（时长不受影响）')
}

// ---- renderTrace：CLR 会话是**第二条独立会话**，它的成败必须单独出现
{
  const started = renderTrace({ ok: true, started: true, etlPath: 'D:/ev/trace.etl', profiles: ['CPU', 'DotNet'], engine: 'xperf', clrEtlPath: 'D:/ev/clr-events.etl', clr: { ok: true } })
  ok(/CLR 会话：已并行启动/.test(started), 'start 渲染：报出 CLR 会话')
  const failed = renderTrace({ ok: true, started: true, etlPath: 'D:/ev/trace.etl', profiles: ['CPU'], engine: 'xperf', clrEtlPath: 'D:/ev/clr-events.etl', clr: { ok: false }, clrWarning: '⚠ **CLR 会话没起来**' })
  ok(/没起来/.test(failed), 'start 渲染：CLR 起不来要出声')
  // ★ 主采集失败时，CLR etl 里那份**好数据**不许跟着被读成"这次什么都没有"
  const mainFail = renderTrace({ ok: false, error: '停止后未生成 etl', engine: 'wpr', clrEtlPath: 'D:/ev/clr-events.etl' })
  ok(/不受这次失败影响/.test(mainFail), '主采集失败时：点明 CLR etl 仍有数据')
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: perf_clrevents (summary gate + three-state render)')
