/**
 * P0-1（DSH R2）—— 从 ETW 的 CLR 事件（Microsoft-Windows-DotNETRuntime，GUID e13c0d23）
 * 汇总 **GC 停顿 / 各代 GC 次数 / 托管堆 / 锁争用**。回答 perf_probe（只测 UI 消息泵）与
 * perf_dump（冻结抓一瞬间）之间那条缝：「**GC 暂停导致行情页卡顿**」——实时行情 WPF 客户端最典型的卡顿成因。
 *
 * ⚠ 采集前提（spike 已证伪「数据已在手上」）：现有 perf-evidence 里的 etl 走 xperf 纯内核 flag 采的，
 * **不含** CLR provider。要用本模块，先单独起一条 CLR 用户会话采集（不依赖本机已坏的 WPR）：
 *   logman start clrgc -p Microsoft-Windows-DotNETRuntime 0x4001 0x5 -o clr.etl -ets  （0x1 GC + 0x4000 Contention）
 *   …复现卡顿…  logman stop clrgc -ets
 * 再把 clr.etl 交给 tracerpt 解码（本模块吃解码后的 XML 文本）。provider 独占 → etl 小 → XML 可控
 * （tracerpt XML 相对 etl ~6× 膨胀，别对全量系统 trace 全事件 dump）。
 *
 * 设计：纯解析、无 I/O、可对 fixture 单测（perf-evidence/clr-events-spike-20260916/gc-fixture.xml 是**真**采样）。
 * 事件规范键 = RenderingInfo 的 `Task/Opcode`（如 GC/SuspendEEStart、GC/RestartEEStop、GC/Start、GC/HeapStats）——
 * SuspendEE→RestartEE 是 GCNoUserData 无独立 payload，只能靠 opcode；GC/Start 等另带 payload data。
 */

const CLR_GUID = 'e13c0d23-ccbc-4e12-931b-d9cc2eee27e4'

/**
 * CLR **rundown** provider（GUID a669021c）。它和上面那个不是同一个 provider，
 * 用途是「给**已经在跑**的进程补发方法/模块加载事件」（参见 lib/clr-rundown.wprp 里的 F-043）。
 * ⚠ `parseClrEvents` 只认 `CLR_GUID`，会把 rundown 事件**整批滤掉** —— 见 `parseClrEvents(…, {guids})`。
 */
export const CLR_GUID_RUNDOWN = 'a669021c-c450-4609-a035-5af59af4df18'
export const CLR_GUID_RUNTIME = CLR_GUID

/**
 * 解析 tracerpt 的 SystemTime（形如 2026-09-16T15:33:14.878251200+07:59）为浮点毫秒。
 * 只用于**差值**（停顿时长），绝对基准无所谓。用字符串切分而非正则（避开时间型正则）。
 * 取到毫秒用 Date.parse，毫秒以下的余数作为小数加回，保留 μs 精度。
 */
export function parseSystemTimeMs(s) {
  const str = String(s == null ? '' : s).trim()
  const dot = str.indexOf('.')
  if (dot < 0) { const t = Date.parse(str); return Number.isFinite(t) ? t : NaN }
  const head = str.slice(0, dot)                         // 到秒：2026-09-16T15:33:14
  let rest = str.slice(dot + 1)                          // 878251200+07:59  或  878251200Z  或  878251200
  let tz = ''
  const plus = rest.indexOf('+'); const minus = rest.indexOf('-'); const z = rest.indexOf('Z')
  let cut = rest.length
  if (plus >= 0) cut = Math.min(cut, plus)
  if (minus >= 0) cut = Math.min(cut, minus)
  if (z >= 0) cut = Math.min(cut, z)
  if (cut < rest.length) { tz = rest.slice(cut); rest = rest.slice(0, cut) }
  const frac = rest.replace(/[^0-9]/g, '')               // 纯数字的亚秒部分（此处只剩数字，安全）
  const ms3 = frac.slice(0, 3).padEnd(3, '0')            // 毫秒整数
  const base = Date.parse(`${head}.${ms3}${tz || 'Z'}`)  // 到毫秒
  if (!Number.isFinite(base)) return NaN
  const subMs = frac.length > 3 ? Number('0.' + frac.slice(3)) : 0
  return base + subMs
}

const tag = (block, name) => {
  const m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>').exec(block)
  return m ? m[1].trim() : null
}
const dataField = (block, name) => {
  // 兼容 <Data Name="X">v</Data>（EventData）与 <X>v</X>（UserData payload）
  let m = new RegExp('<Data Name=[\'"]' + name + '[\'"]\\s*>([^<]*)</Data>').exec(block)
  if (m) return m[1].trim()
  m = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(block)
  return m ? m[1].trim() : null
}
const hexOrNum = (v) => {
  if (v == null) return null
  const s = String(v).trim()
  const n = /^0x/i.test(s) ? parseInt(s, 16) : Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 tracerpt 的 XML 文本 → CLR 事件数组：{ timeMs, kind:'Task/Opcode', task, opcode, block }。
 * 只保留 provider e13c0d23 的事件；其余（内核/其他 provider）跳过。
 */
export function parseClrEvents(xmlText) {
  const text = String(xmlText || '')
  const blocks = text.split(/(?=<Event\b)/).filter((b) => /<Event\b/.test(b))
  const out = []
  for (const b of blocks) {
    if (!b.includes(CLR_GUID)) continue
    const tm = /SystemTime="([^"]+)"/.exec(b)
    const time = parseSystemTimeMs(tm ? tm[1] : '')
    // RenderingInfo 的 Task/Opcode 作规范键（英文、去尾空白）；取 RenderingInfo 段内的，避免撞 System 的数字 Opcode
    const ri = (/<RenderingInfo[\s\S]*?<\/RenderingInfo>/.exec(b) || [''])[0]
    const task = tag(ri, 'Task') || 'Unknown'
    const opcode = tag(ri, 'Opcode') || 'Unknown'
    out.push({ timeMs: time, kind: `${task}/${opcode}`, task, opcode, block: b })
  }
  return out
}

/**
 * 汇总一组 CLR 事件：
 *   gcCount / byGen{gen0,gen1,gen2} / inducedCount / pauseMs{count,totalMs,maxMs,p99Ms} / heap{...} / contentionCount。
 * pauseMs：把每个 GC/SuspendEEStart 与其后**第一个** GC/RestartEEStop 配对（= 托管线程被冻结→恢复的真实停顿）。
 */
export function summarizeClr(events) {
  const evs = (events || []).filter((e) => Number.isFinite(e.timeMs)).sort((a, b) => a.timeMs - b.timeMs)
  const isOp = (e, re) => re.test(e.opcode)
  const gcStarts = evs.filter((e) => e.task === 'GC' && /^Start$/i.test(e.opcode))
  const byGen = { gen0: 0, gen1: 0, gen2: 0 }
  let inducedCount = 0
  for (const e of gcStarts) {
    const depth = hexOrNum(dataField(e.block, 'Depth'))
    if (depth === 0) byGen.gen0++
    else if (depth === 1) byGen.gen1++
    else if (depth != null && depth >= 2) byGen.gen2++
    // Reason: Induced=1 / InducedNotForced=7（GC.Collect 显式触发，值得单列——通常是代码在瞎调）
    const reason = hexOrNum(dataField(e.block, 'Reason'))
    if (reason === 1 || reason === 7) inducedCount++
  }
  // GC 停顿：SuspendEEStart → 其后第一个 RestartEEStop
  const pauses = []
  const pauseSpans = []
  let pendingSuspend = null
  for (const e of evs) {
    if (e.task === 'GC' && isOp(e, /^SuspendEEStart$/i)) pendingSuspend = e.timeMs
    else if (e.task === 'GC' && isOp(e, /^RestartEEStop$/i) && pendingSuspend != null) {
      const d = e.timeMs - pendingSuspend
      if (d >= 0) { pauses.push(d); pauseSpans.push({ atMs: pendingSuspend, ms: d }) }
      pendingSuspend = null
    }
  }
  pauses.sort((a, b) => a - b)
  const p99 = pauses.length ? pauses[Math.min(pauses.length - 1, Math.ceil(pauses.length * 0.99) - 1)] : 0
  const pauseMs = {
    count: pauses.length,
    totalMs: round2(pauses.reduce((s, x) => s + x, 0)),
    maxMs: round2(pauses.length ? pauses[pauses.length - 1] : 0),
    p99Ms: round2(p99),
  }
  // 托管堆：最后一条 GC/HeapStats 的各代尾值 + GC 句柄数
  const lastHeap = [...evs].reverse().find((e) => e.task === 'GC' && /^HeapStats$/i.test(e.opcode))
  const heap = lastHeap ? {
    gen0: hexOrNum(dataField(lastHeap.block, 'GenerationSize0')),
    gen1: hexOrNum(dataField(lastHeap.block, 'GenerationSize1')),
    gen2: hexOrNum(dataField(lastHeap.block, 'GenerationSize2')),
    lohGen3: hexOrNum(dataField(lastHeap.block, 'GenerationSize3')),
    gcHandleCount: hexOrNum(dataField(lastHeap.block, 'GCHandleCount')),
  } : null
  // 锁争用：Contention/Start（托管锁竞争的开始）
  const contentionCount = evs.filter((e) => e.task === 'Contention' && /^Start$/i.test(e.opcode)).length
  // 最长几段停顿的**时刻**：光有"最长 120ms"没法跟别处的现象对上号 ——
  // 要回答「你刚看到的那一下卡，是不是 GC」，需要它在时间轴上的位置。
  const topPauses = pauseSpans.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
  const window = evs.length ? { startMs: evs[0].timeMs, endMs: evs[evs.length - 1].timeMs } : null
  return { gcCount: gcStarts.length, byGen, inducedCount, pauseMs, heap, contentionCount, topPauses, window }
}

function round2(n) { return Math.round(n * 100) / 100 }

// ---------------------------------------------------------------------------
// tracerpt 摘要（provider 闸门）
// ---------------------------------------------------------------------------

/**
 * 解析 `tracerpt <etl> -summary <txt> -y` 的摘要文本。
 *
 * 为什么单独要它：解码 XML 相对 etl 约 **4~6×**（本机实测 303 KB→1.80 MB、2.9 MB→12.7 MB、
 * 13.4 MB→53.7 MB），对几百 MB 的系统 trace 就是 GB 级 —— 不能无脑解。
 * 而摘要**不生成 XML**（`-summary` 且**不带** `-o`），实测 79.5 MB 的 etl 14 秒出结果，
 * 足够回答那个真正的前置问题：**这个 etl 里到底有没有 CLR provider**。
 *
 * 这个区分是本工具最重要的一条诚实口径：
 *   · 没有 `e13c0d23` ⇒ 「**没采**」，不是「没有 GC」；
 *   · provider 在、窗口内 0 条 GC ⇒ 那才叫「这段窗口没发生 GC」。
 * 把两者混起来，agent 会把「没采到」读成「客户端没有 GC 停顿」。
 *
 * 表格行形如 `|        305   Microsoft-Windows-DotNETRuntime 1   FinalizeObject  0   {e13c0d23-…}|`。
 * 列宽是空格填充、表头与数据行**并不严格对齐**（实测差 1 列），所以这里**只取可靠的
 * 「计数 + GUID」两列**，事件名/任务名一律不猜；provider 的**人类可读名**改由
 * `parseProviderTable(logman query providers 的输出)` 从本机 provider 注册表反查。
 */
export function parseTraceSummary(text) {
  const src = String(text == null ? '' : text)
  const lines = src.split(/\r?\n/)
  const files = []
  let totalEvents = null
  let lostEvents = null
  let buffers = null
  let inFiles = false
  const providers = []
  const byGuid = new Map()
  // ★★ tracerpt 的摘要里可能有**两张**表：第一张按 (Event Name, Task, Opcode, Version, Guid)，
  //    第二张按 (Event Name, Event ID, Version, Guid) —— **同一个事件在两张表里各出现一次**。
  //    全加会得到**恰好 2 倍**的数字（真机实测：CLR fixture 第一张表 CLR 行合计 1548，
  //    两张表一起加就是 3096）。这种错法特别毒：数字看起来完全合理，而 "Σ == Total Events" 的
  //    自洽检查在"只有一张表"的 etl 上照样通过（79.5 MB 的 r61-dumped 就只印了一张表）。
    //    只统计**含 Opcode 列**的那张（= 规范表）；第二张是它的换轴视图，不是新事件。
  let inCountTable = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed) { inFiles = false; continue }
    if (/^Files Processed:?$/i.test(trimmed)) { inFiles = true; continue }
    if (inFiles) {
      // 文件名单独成行（前缀制表符/空格），遇到其它键值行即结束
      if (/^(Total|Start Time|End Time|Elapsed Time|\+|\|)/i.test(trimmed)) inFiles = false
      else { files.push(trimmed); continue }
    }
    let m = /^Total Buffers Processed\s+(\d+)/i.exec(trimmed)
    if (m) { buffers = Number(m[1]); continue }
    m = /^Total Events\s+Processed\s+(\d+)/i.exec(trimmed)
    if (m) { totalEvents = Number(m[1]); continue }
    m = /^Total Events\s+Lost\s+(\d+)/i.exec(trimmed)
    if (m) { lostEvents = Number(m[1]); continue }
    if (!trimmed.startsWith('|')) continue
    // 表头：只认含 Opcode 的那张（见上面 inCountTable 的理由）
    if (/^\|\s*Event Count/i.test(trimmed)) { inCountTable = /Opcode/i.test(trimmed); continue }
    if (!inCountTable) continue
    // 数据行：| <count> <Event Name> <Task> <Opcode> <Version> {guid}|
    // 列宽是空格填充、表头与数据行实测**差 1 列**，所以只取两样可靠的东西：
    // 前导计数，和紧跟其后的**第一个 token** —— 那是 Event Name 列，而 ETW 的事件名/提供程序名
    // 都是标识符、**不含空格**（`Microsoft-Windows-DotNETRuntime` / `Thread` / `EventTrace` / `PerfInfo`）。
    // 有了它就不用再去查表认 GUID 了 —— 而这恰恰是 logman 做不到的：内核那几个 GUID
    // 在 `logman query providers` 里**查不到**（真机实测：10 个 provider 全落成"(未收录)"）。
    m = /^\|\s*(\d+)\s+(\S+)(?:\s.*?)?\{([0-9a-fA-F-]{36})\}\s*\|?$/.exec(trimmed)
    if (!m) continue
    const count = Number(m[1])
    // 名字可能是数字（"未知/经典"事件那几行第二列就是 `0`）—— 那是"没有名字"，不是"名字叫 0"。
    const rowName = /^\d+$/.test(m[2]) ? null : m[2]
    const guid = m[3].toLowerCase()
    let p = byGuid.get(guid)
    if (!p) { p = { guid, name: rowName, events: 0, rows: 0, names: {} }; byGuid.set(guid, p); providers.push(p) }
    p.events += count
    p.rows++
    if (rowName) p.names[rowName] = (p.names[rowName] || 0) + 1
  }
  // 同一个 GUID 的多行取**出现最多**的那个名字（同一 provider 的行名应当一致；不一致时也别编）
  for (const p of providers) {
    let best = null
    for (const [n, c] of Object.entries(p.names)) if (!best || c > best.c) best = { n, c }
    p.name = best ? best.n : null
    delete p.names
  }
  const rt = byGuid.get(CLR_GUID)
  const rd = byGuid.get(CLR_GUID_RUNDOWN)
  const clrRuntimeEvents = rt ? rt.events : 0
  const clrRundownEvents = rd ? rd.events : 0
  return {
    files,
    buffers,
    totalEvents,
    lostEvents,
    providers,
    byGuid: Object.fromEntries(byGuid),
    providerCount: providers.length,
    clrRuntimeEvents,
    clrRundownEvents,
    clrEvents: clrRuntimeEvents + clrRundownEvents,
    // 闸门：总事件数为 0 也能说明问题（空 etl），所以这里只看「有没有出现过」
    hasClrRuntime: Boolean(rt),
    hasClrRundown: Boolean(rd),
    hasClr: Boolean(rt || rd),
  }
}

