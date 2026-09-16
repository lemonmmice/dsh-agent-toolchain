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
  let pendingSuspend = null
  for (const e of evs) {
    if (e.task === 'GC' && isOp(e, /^SuspendEEStart$/i)) pendingSuspend = e.timeMs
    else if (e.task === 'GC' && isOp(e, /^RestartEEStop$/i) && pendingSuspend != null) {
      const d = e.timeMs - pendingSuspend
      if (d >= 0) pauses.push(d)
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
  return { gcCount: gcStarts.length, byGen, inducedCount, pauseMs, heap, contentionCount }
}

function round2(n) { return Math.round(n * 100) / 100 }
