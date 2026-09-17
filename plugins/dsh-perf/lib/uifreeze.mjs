/**
 * dsh-perf UI 冻结的**等待时间分析** —— 复刻 PerfView 的 "UI Freeze / wall-clock" 视图。
 *
 * 为什么它是**独立**于 perf_flame（CPU 火焰图）和 perf_dump（瞬间快照）的第三种视图：
 *   · perf_flame 走 SampledProfile = **CPU 采样**：线程在 waiting 时**不产采样** ⇒ 一个 98.5% 时间
 *     卡在同步 HTTP 上的冻结，CPU 火焰图几乎是空的（截图里 CPU 0.2%）—— 它答不了"卡在等什么"。
 *   · perf_dump 是**一个瞬间**：分阶段的短冻结（XAML inflate 段 + HTTP 等待段交替）会 race，
 *     单张 dump 只逮到其中一段（实测：示例终端冷加载抓到的是 XAML 段，没抓到 HttpGet）。
 *   · 本模块走 **CSwitch（上下文切换）**：线程被切下去到切回来的时间差 = 它**阻塞了多久**，
 *     切换点的调用栈 = **卡在哪个调用**。把目标线程整段时间轴按栈归因，就得到
 *     "UI 冻结 N 秒，其中 M 秒卡在 X"——正是 PerfView UI Freeze 那张图的本质。
 *
 * ── 时长怎么算（不信 xperf 那个哨兵 WaitTime）：
 *   实测 CSwitch 的 `WaitTime` 列会出现 `4294966`(≈0xFFFFFF) 这种**哨兵/溢出值**，不能直接采信。
 *   所以本模块**自己按相邻时间戳差算**：对目标 tid 的每条 CSwitch，
 *     - 作为 **New**（被切回来跑）：记一个"运行段"起点；
 *     - 作为 **Old**（被切下去等）：上一条到这条的差 = 运行了多久；从这里进入"等待"，
 *       直到下一条 New 把它切回来 —— 那段差 = **阻塞时长**，归因到**切下去那一刻的栈**。
 *   时间戳单位是 **微秒**（xperf dumper 的 TimeStamp）；对外汇总成毫秒。
 *
 * ── 栈归因：CSwitch 的 Stack 事件按惯例挂在 **New（切入）线程**，即"线程醒来时的栈" = 它之前
 *   阻塞在的那个调用点（醒来就是从阻塞返回）。所以把"某次 New 切回"的栈，归给"它刚结束的那段等待"。
 *
 * 纯流式（大 CSV 是 etl 的 ~10×），只在内存里留目标 tid 的段与聚合，不整份读入。
 * 复用 flame.mjs 的 normalizeFrame / JIT 解析（客户端 JIT 帧解成真实方法名）。
 */
import { forEachLine, normalizeFrame } from './flame.mjs'
import { lookupMethod } from './jitmap.mjs'

function eventName(line) {
  const i = line.indexOf(',')
  return i < 0 ? '' : line.slice(0, i).trim()
}
function pidOf(procField) {
  const m = /\(\s*(\d+)\s*\)/.exec(procField || '')
  return m ? m[1] : null
}

/**
 * 流式分析目标线程的等待/运行时长，按栈归因。
 * @param {string} csvPath  xperf -a dumper 的 CSV（采集需带 CSWITCH + -stackwalk CSwitch）
 * @param {object} opts
 * @param {number|string} opts.tid   目标线程 os id（UI 线程）。**必填**（这是"哪条线程冻了"的主语）
 * @param {'module'|'symbols'} opts.frameMode
 * @param {Map} opts.jitMap          可选：pid→方法表，解客户端 JIT 帧
 * @param {string} opts.pid          目标进程 pid（校验 tid 归属，避免 tid 复用串号）
 * @returns {Promise<{spanMs,waitMs,runMs,switches,waitStacks(folded),runStacks(folded),topWaits,byReason}>}
 */
export async function analyzeThreadWaits(csvPath, opts = {}) {
  const tid = String(opts.tid || '').trim()
  if (!tid) throw new Error('analyzeThreadWaits 需要 tid（目标 UI 线程 os id）')
  // 等待分析默认**保留方法名**（symbols 模式）：用户要看的是"卡在 HttpGet"，不是"卡在 System.dll"。
  // 框架/系统帧的方法名 dumper 大多能解（托管栈自带）；客户端 JIT 帧仍靠 jitMap。
  const frameMode = opts.frameMode === 'module' ? 'module' : 'symbols'
  const jitMap = opts.jitMap || null
  const wantPid = opts.pid ? String(opts.pid) : null

  // Pass 1：收集目标 tid 的 CSwitch 事件（时间戳 + 它是 New 还是 Old + wait reason）。
  //   New 行：$4=New TID；Old 行：$10=Old TID。一条 CSwitch 同时有一个 New 和一个 Old。
  const events = [] // { ts, role:'in'|'out', reason }
  let firstTs = null, lastTs = null
  await forEachLine(csvPath, (line) => {
    if (eventName(line) !== 'CSwitch') return
    const p = line.split(',')
    const ts = parseInt(p[1], 10)
    if (!Number.isFinite(ts)) return // 表头
    if (firstTs === null) firstTs = ts
    lastTs = ts
    const newTid = (p[3] || '').trim()
    const oldTid = (p[9] || '').trim()
    if (newTid === tid) {
      if (wantPid && pidOf(p[2]) && pidOf(p[2]) !== wantPid) return
      events.push({ ts, role: 'in' })
    } else if (oldTid === tid) {
      if (wantPid && pidOf(p[8]) && pidOf(p[8]) !== wantPid) return
      const reason = (p[13] || '').trim() // Wait Reason 列
      events.push({ ts, role: 'out', reason })
    }
  })
  events.sort((a, b) => a.ts - b.ts)

  // 把时间轴切成段：out→(下一个)in = 等待段；in→(下一个)out = 运行段。
  // 每个"等待段"记 {startTs（切出时刻）, ms, reason}；栈在 Pass 2 用 in 时刻的 Stack 补。
  const waitSpans = []   // { outTs, inTs, ms, reason }
  const runSpans = []    // { inTs, outTs, ms }
  let waitMs = 0, runMs = 0
  for (let i = 0; i + 1 < events.length; i++) {
    const cur = events[i], nxt = events[i + 1]
    const dur = (nxt.ts - cur.ts) / 1000 // µs→ms
    if (dur < 0) continue
    if (cur.role === 'out' && nxt.role === 'in') { waitSpans.push({ outTs: cur.ts, inTs: nxt.ts, ms: dur, reason: cur.reason || 'Unknown' }); waitMs += dur }
    else if (cur.role === 'in' && nxt.role === 'out') { runSpans.push({ inTs: cur.ts, outTs: nxt.ts, ms: dur }); runMs += dur }
  }

  // Pass 2：给每个 in 时刻（醒来）取该 tid 的 Stack 簇 → 归给"它刚结束的那段等待"。
  //   索引：inTs → wait span（该 span 的 inTs 等于这次醒来时刻）。
  const inTsToWait = new Map()
  for (const w of waitSpans) inTsToWait.set(w.inTs, w)
  const wantStackTs = new Set(waitSpans.map((w) => w.inTs))
  const methods = jitMap && wantPid ? jitMap.get(wantPid) : null
  let jitAttempted = 0, jitResolved = 0
  const resolveFrame = (addrHex, label) => {
    if (methods && /^"?Unknown"?!0x[0-9A-Fa-f]+$/.test(label)) {
      jitAttempted++
      try { const m = lookupMethod(methods, BigInt(addrHex)); if (m) { jitResolved++; return m.name } } catch { /* fall through */ }
    }
    return normalizeFrame(label, frameMode)
  }

  // ★★ 关键：区分「消息泵空闲等待」与「真卡顿」。
  //   WPF UI 线程绝大多数时间卡在 GetMessageW/MsgWaitForMultipleObjectsEx **等用户输入** —— 这是**空闲**，
  //   不是卡顿。若把它算进"等待"，任何 GUI 程序都会显示 ~95% waiting（本轮就是这么被淹没的）。
  //   判据：该次醒来的栈里若含消息泵函数（GetMessage / MsgWaitForMultipleObjects / PeekMessage /
  //   NtUserGetMessage / DispatcherFrame 的等待），这段等待归为 IDLE，从"冻结"里剔除。
  //   PerfView 的 UI Freeze 同理——只统计"界面该响应却在等"的时间。
  // 覆盖三层的消息泵空闲特征：托管（Dispatcher.GetMessage）、Win32（GetMessageW/MsgWait…）、
  // 内核（NtUserGetMessage/NtUserMsgWaitForMultipleObjects/win32kfull!...GetMessage）。
  // 任一层出现即判为"等用户输入"的空闲。
  const IDLE_RE = /GetMessage|MsgWaitForMultipleObjects|PeekMessage|WaitMessage|NtUserGetMessage|NtUserMsgWait|NtUserWaitMessage|xxxRealSleep|SleepInputIdle/i
  const isIdleStack = (framesRootToLeaf) => framesRootToLeaf.some((f) => IDLE_RE.test(f))

  const waitFolded = new Map()   // 只含**真卡顿**等待，按微秒加权
  let idleWaitMs = 0, freezeWaitMs = 0, unknownStackWaitMs = 0

  // 流式重扫 Stack 事件，只留目标 tid、且时间戳命中 wantStackTs 的簇。
  let curTs = null, curTid = null, curNo = 0, curFrames = null
  const flush = () => {
    if (curTid === tid && curFrames && curFrames.length && wantStackTs.has(curTs)) {
      const w = inTsToWait.get(curTs)
      if (w) {
        const rootToLeaf = []
        for (let i = curFrames.length - 1; i >= 0; i--) {
          const f = resolveFrame(curFrames[i].addr, curFrames[i].label)
          if (rootToLeaf.length && rootToLeaf[rootToLeaf.length - 1] === f) continue
          rootToLeaf.push(f)
        }
        w.hasStack = true
        if (isIdleStack(rootToLeaf)) {
          idleWaitMs += w.ms            // 空闲等消息：剔除
        } else {
          freezeWaitMs += w.ms
          const stack = rootToLeaf.join(';')
          waitFolded.set(stack, (waitFolded.get(stack) || 0) + Math.max(1, Math.round(w.ms * 1000)))
        }
      }
    }
    curFrames = null
  }
  await forEachLine(csvPath, (line) => {
    if (eventName(line) !== 'Stack') return
    const p = line.split(',')
    const ts = parseInt(p[1], 10)
    const stid = (p[2] || '').trim()
    const no = parseInt(p[3], 10)
    if (!Number.isFinite(ts) || !Number.isFinite(no)) return
    if (stid !== tid) return
    if (ts !== curTs || stid !== curTid || no <= curNo) { flush(); curTs = ts; curTid = stid; curFrames = wantStackTs.has(ts) ? [] : null }
    curNo = no
    if (curFrames) curFrames.push({ addr: (p[4] || '').trim(), label: p.slice(5).join(',').trim() })
  })
  flush()

  // 没取到栈的等待段（CSwitch 有、Stack 没配上）：单列，不硬塞进任一类（诚实）。
  for (const w of waitSpans) if (!w.hasStack) unknownStackWaitMs += w.ms

  // top 阻塞点：只在**真卡顿**里，按叶子帧（醒来点=阻塞返回处）聚合。
  const leafWait = new Map()
  for (const [stack, us] of waitFolded) {
    const leaf = stack.slice(stack.lastIndexOf(';') + 1)
    leafWait.set(leaf, (leafWait.get(leaf) || 0) + us)
  }
  const topWaits = [...leafWait.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([frame, us]) => ({ frame, ms: Math.round(us / 1000) }))
  // 真卡顿里最长的几段（时刻+时长），对应 PerfView 那几条 UI Freeze 事件
  const freezeSpans = waitSpans.filter((w) => w.hasStack).sort((a, b) => b.ms - a.ms)

  return {
    tid,
    spanMs: firstTs !== null ? Math.round((lastTs - firstTs) / 1000) : 0,
    waitMs: Math.round(waitMs),                 // 全部等待（含空闲）——诊断价值低，仅供对账
    idleWaitMs: Math.round(idleWaitMs),         // 消息泵空闲（等用户输入）——已剔除
    freezeWaitMs: Math.round(freezeWaitMs),     // ★ 真卡顿等待（界面该响应却在等）——这才是 PerfView UI Freeze 那个数
    unknownStackWaitMs: Math.round(unknownStackWaitMs),
    runMs: Math.round(runMs),
    switches: events.length,
    waitSpanCount: waitSpans.length,
    longestFreezeMs: freezeSpans.length ? Math.round(freezeSpans[0].ms) : 0,
    waitFolded,            // Map<stack, µs>：**只含真卡顿** → buildTree/foldedToText 出等待火焰图
    topWaits,              // 真卡顿的醒来点（阻塞返回处）按等待 ms 排行
    jit: jitMap ? { attempted: jitAttempted, resolved: jitResolved } : null,
  }
}
