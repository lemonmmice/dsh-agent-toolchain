// Frozen pre-Rust CPU/allocation fold oracle (Git 6887521). Test-only.
/**
 * dsh-perf 火焰图 —— 把 ETW CPU 采样折叠成火焰图（folded stacks + 自包含可交互 HTML）。
 *
 * 这是「与 PerfView 对照」里 §1 那条 ❌「交互式 GUI（故意）」的补齐：PerfView 的招牌就是可点开、
 * 可缩放、可搜索的火焰图 / CallTree。我们此前只有 `perf_hotstacks` 的**文本**蝶形视图（调用者/被
 * 调用者对），给不了「从根到叶的一整棵 CPU 时间树」。本模块补上这棵树。
 *
 * ── 为什么用 `xperf -a dumper` 而不是 `-a stack -butterfly`（hotstacks 那条）：
 *    · `-a stack -butterfly` 产出的是**扁平**的 caller/callee 对（HTML 表），拼不回完整的根→叶栈；
 *    · `-a dumper` 会把 trace 里的原始事件逐条打出来，其中 `Stack` 事件**每行一帧**，
 *      同一 `(TimeStamp, ThreadID)` 的多行连成一次完整栈 —— 这正是火焰图要的输入
 *      （Bruce Dawson / Brendan Gregg 的 xperf→folded 转换脚本走的也是这条）。
 *    · 代价（doc §4.3 实测）：dumper 的 CSV 是 etl 的 ~7×（79.5MB etl → 585MB CSV / 15s）。
 *      所以本模块**全程流式**（readline，不把 CSV 读进内存）、**按进程名过滤**，
 *      折叠结果的规模只跟"目标进程的采样数"走，与 CSV 大小无关。
 *
 * ── 折叠口径（每一条都是会被误读的点，写清楚）：
 *  1. **CPU 栈 ≠ 所有 Stack 事件**。采集带了 `-stackwalk PROFILE+CSWITCH`，所以 `Stack` 事件里
 *     既有 CPU 采样（SampledProfile）的栈，也有上下文切换（CSwitch，= 线程被**阻塞/等待**时）的栈。
 *     火焰图要的是 CPU 时间 ⇒ 只折叠那些 `(ts,tid)` 命中了 `SampledProfile` 的 Stack 簇。
 *     （CSwitch 的"等待栈"是另一种有用视图 —— wall-clock/thread-time —— 但**不是** CPU 火焰图，别混。）
 *  2. **帧序**：`Stack` 事件 `No.=1` 是**叶子**（采样落点，= SampledProfile 的 Image!Function），
 *     No. 越大越靠根。folded 要 root→leaf ⇒ 收集后**反转**。（本机 2026-09-17 实测确认。）
 *  3. **未解析帧必须塌缩到模块级**，否则火焰图会退化：离线（不连符号服务器）时每帧是
 *     `module!0x地址`，地址各不相同 ⇒ 每条栈都唯一 ⇒ 根本聚不起来、火焰图变成一根根竹签。
 *     所以 `module!0x...` 一律塌成 `module`（连成一片可读的"模块火焰图"：SciChart / WPF / clr /
 *     客户端各占多少 CPU 一眼可见）。symbols=true 时能解析的原生/框架帧保留 `module!Function`。
 *  4. **客户端自己的方法名解不出来**是已知的（doc §3：客户端程序集是 JIT 的，dbghelp 认地址认不出方法）
 *     —— 那些帧会以 `ClientApp.exe`（模块级）出现，等 §4 的 JIT 地址→方法映射接线后才会有方法名。
 *     本工具**不假装**能解客户端方法：它诚实地按模块聚。
 *
 * 纯逻辑（fold / 建树 / 生成 HTML）都放这里、不碰 xperf，可离线对着 fixture 跑；
 * 起 xperf 出 dumper CSV 的编排在 trace.mjs 的 `flame()` 里（复用 c.xperf / runExe / symbolEnv）。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { lookupMethod } from '../lib/jitmap.mjs'

/** 逐行流式读一个（可能上 GB 的）文本文件；回调返回 false 可提前停止。 */
export async function forEachLine(path, onLine) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (onLine(line) === false) break
    }
  } finally {
    rl.close()
  }
}

/** 取一行 dumper CSV 的事件名（第 1 字段，带前导空白）——便宜地先筛掉不关心的行。 */
function eventName(line) {
  const i = line.indexOf(',')
  if (i < 0) return ''
  return line.slice(0, i).trim()
}

/**
 * 帧规整：`module.dll!0xADDR` / `module.dll!Func` / `"Unknown"!0xADDR` → 火焰图里的一个帧名。
 *  - mode='module'：一律取模块名（塌掉地址/函数）；
 *  - mode='symbols'：能解析的保留 `module!Func`，未解析（函数是 0x 地址或空）塌回模块名。
 */
export function normalizeFrame(raw, mode) {
  const frame = String(raw).trim()
  const bang = frame.indexOf('!')
  let mod = bang >= 0 ? frame.slice(0, bang) : frame
  const fn = bang >= 0 ? frame.slice(bang + 1) : ''
  // `"Unknown"` = 连模块名都没有（JIT stub / 无镜像）。去掉引号，标成可读的占位。
  if (mod === '"Unknown"' || mod === 'Unknown' || mod === '') mod = '[unknown]'
  if (mode !== 'symbols') return mod
  if (fn === '' || /^0x[0-9a-fA-F]+$/.test(fn)) return mod // 未解析 ⇒ 模块级
  return mod + '!' + fn
}

/** 一帧是不是「JIT 无模块」帧（`"Unknown"!0xADDR`）—— 这是唯一能靠 JIT 映射救回来的那种。 */
function isJitUnknownFrame(label) {
  return /^"?Unknown"?!0x[0-9A-Fa-f]+$/.test(label)
}

/**
 * 流式折叠 dumper CSV → folded stacks。
 * @param {string} csvPath  `xperf -a dumper` 的 CSV
 * @param {object} opts
 * @param {RegExp} opts.processRe   只折叠该进程名（对 `Process Name ( PID)` 整串匹配）
 * @param {'module'|'symbols'} opts.frameMode  帧规整口径（默认 module）
 * @param {boolean} opts.foldRecursion  折叠**连续同名**帧（默认 true：既折递归，也把"同模块的一串未解析帧"收成一格）
 * @param {Map<string, Array>} opts.jitMap  可选：pid → 排序方法数组（jitmap.mjs）。传了就把 `"Unknown"!0xADDR`
 *        JIT 帧按**该帧所属线程的 pid** 查回托管方法名（客户端自己的代码从 `[unknown]` 变成真实方法名）。
 * @returns {Promise<{ folded, samplesAll, samplesTarget, stacksFolded, uniqueStacks, topLeaves, topModules, jit }>}
 */
export async function foldDumperCsv(csvPath, opts = {}) {
  const processRe = opts.processRe || /./
  const frameMode = opts.frameMode === 'symbols' ? 'symbols' : 'module'
  const foldRecursion = opts.foldRecursion !== false
  const jitMap = opts.jitMap || null

  // ── Pass 1：目标进程的 CPU 采样 (ts,tid) 键集合 + tid→pid（JIT 映射按 pid 分桶，查表要用采样帧线程的 pid）。
  const sampleKeys = new Set()
  const tidToPid = new Map()
  let samplesAll = 0
  let samplesTarget = 0
  await forEachLine(csvPath, (line) => {
    if (eventName(line) !== 'SampledProfile') return // SampledProfileNmi 也被排除（那是 NMI 采样，另一回事）
    const p = line.split(',')
    const ts = parseInt(p[1], 10)
    const tid = parseInt(p[3], 10)
    if (!Number.isFinite(ts) || !Number.isFinite(tid)) return // 表头行（TimeStamp/ThreadID 非数字）跳过
    samplesAll++
    const proc = (p[2] || '').trim()
    if (processRe.test(proc)) {
      samplesTarget++
      sampleKeys.add(ts + '\t' + tid)
      // `Process Name ( PID)` → 取 pid（JIT 映射的 key）。同一 tid 归属稳定，记一次即可。
      if (jitMap && !tidToPid.has(tid)) {
        const pm = /\(\s*(\d+)\s*\)/.exec(proc)
        if (pm) tidToPid.set(tid, pm[1])
      }
    }
  })

  // JIT 命中统计（诚实上报解析率，别让"没接上映射"看起来像"没有客户端代码"）。
  let jitAttempted = 0
  let jitResolved = 0

  // ── Pass 2：只折叠命中 sampleKeys 的 `Stack` 簇。O(1) 内存（只暂存当前一簇的 {addrHex,label}）。
  const folded = new Map()
  const usedKeys = new Set() // 每个采样键只折一簇：防同 (ts,tid) 的 CSwitch 栈把该样本重复计数（µs 级碰撞，极罕见）
  let stacksFolded = 0
  let curKey = null
  let curTid = null
  let curFrames = null
  let curNo = 0

  const resolveFrame = (addrHex, label, methods) => {
    // JIT 无模块帧 + 有该 pid 的映射 ⇒ 试着解出托管方法名。
    if (methods && isJitUnknownFrame(label)) {
      jitAttempted++
      try {
        const m = lookupMethod(methods, BigInt(addrHex))
        if (m) { jitResolved++; return m.name }
      } catch { /* 地址解析失败就走回退 */ }
    }
    return normalizeFrame(label, frameMode)
  }

  const flush = () => {
    if (curKey && curFrames && curFrames.length && sampleKeys.has(curKey) && !usedKeys.has(curKey)) {
      usedKeys.add(curKey)
      const methods = jitMap ? jitMap.get(tidToPid.get(curTid)) : null
      // No.1..N = 叶..根 ⇒ 反转成 根..叶
      const rootToLeaf = []
      for (let i = curFrames.length - 1; i >= 0; i--) {
        const f = resolveFrame(curFrames[i].addr, curFrames[i].label, methods)
        if (foldRecursion && rootToLeaf.length && rootToLeaf[rootToLeaf.length - 1] === f) continue
        rootToLeaf.push(f)
      }
      const stack = rootToLeaf.join(';')
      folded.set(stack, (folded.get(stack) || 0) + 1)
      stacksFolded++
    }
    curFrames = null
  }

  await forEachLine(csvPath, (line) => {
    if (eventName(line) !== 'Stack') return
    const p = line.split(',')
    const ts = parseInt(p[1], 10)
    const tid = parseInt(p[2], 10)
    const no = parseInt(p[3], 10)
    if (!Number.isFinite(ts) || !Number.isFinite(tid) || !Number.isFinite(no)) return // 表头
    const key = ts + '\t' + tid
    // 新的一簇：键变了，或 No. 回到 1（同键第二次 walk，多半是 CSwitch 那次）
    if (key !== curKey || no <= curNo) {
      flush()
      curKey = key
      curTid = tid
      curFrames = sampleKeys.has(key) ? [] : null // 不是目标采样键就不攒，省内存
    }
    curNo = no
    // p[4] = 原始地址（0x…，JIT join 的键）；p.slice(5) = Image!Function（可能含逗号 ⇒ 拼回）
    if (curFrames) curFrames.push({ addr: (p[4] || '').trim(), label: p.slice(5).join(',').trim() })
  })
  flush()

  // ── 顺带算文本摘要要用的：最热叶子 + 各模块包含命中（inclusive）。
  const leafHits = new Map()
  const moduleIncl = new Map()
  for (const [stack, n] of folded) {
    const frames = stack.split(';')
    const leaf = frames[frames.length - 1]
    leafHits.set(leaf, (leafHits.get(leaf) || 0) + n)
    const mods = new Set(frames.map((f) => f.split('!')[0]))
    for (const m of mods) moduleIncl.set(m, (moduleIncl.get(m) || 0) + n)
  }
  const topN = (map, k) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([name, hits]) => ({ name, hits }))

  return {
    folded,
    samplesAll,
    samplesTarget,
    stacksFolded,
    uniqueStacks: folded.size,
    topLeaves: topN(leafHits, 15),
    topModules: topN(moduleIncl, 15),
    jit: jitMap ? { attempted: jitAttempted, resolved: jitResolved, pids: [...new Set(tidToPid.values())] } : null,
  }
}

/** AllocationTick 行取 TypeName（第 15 列，被引号包住且**泛型名含逗号**，所以不能按逗号切——用引号对提取）。 */
export function allocTypeName(line) {
  // 行尾形如 `…, 0xTypeID, "Type.Name", HeapIndex, 0xAddr`。取**最后一个**带引号字段即 TypeName
  // （第一个带引号字段是 `Process Name ( PID)` 里的 "Unknown"）。
  const m = line.match(/"([^"]*)"\s*,\s*\d+\s*,\s*0x[0-9A-Fa-f]+\s*$/)
  return m ? m[1] : null
}

/**
 * 流式折叠 AllocationTick 的分配栈 → **按字节加权**的 folded（PerfView 的 "GC Heap Alloc Stacks"）。
 * 与 foldDumperCsv 同构，但：种子是 `GCAllocationTick` 事件（不是 SampledProfile），
 * 每条栈的权重是该 tick 的 `AllocationAmount64` 字节（不是 1），并额外按 TypeName 汇总"分配大头类型"。
 *
 * 口径（会被误读的点）：AllocationTick **每分配约 100KB 采一次**（不是每次分配）——所以这是**采样**，
 * 权重用字节近似"这条调用路径分配了多少内存"，不是精确到每个对象。分配 ≠ 存活（多数很快被 GC 回收）；
 * 它回答的是"**谁在制造 GC 压力/churn**"，不是"谁泄漏"（泄漏看 perf_gcroot）。
 *
 * @returns {{ folded, ticksAll, ticksTarget, totalBytes, byType, jit }}
 */
export async function foldAllocCsv(csvPath, opts = {}) {
  const processRe = opts.processRe || /./
  // ★ 分配采样是 xperf **用户会话**：AllocationTick 行的进程名多为 `"Unknown" (PID)`（用户会话没有进程名 rundown）——
  //   所以**优先按 PID 集**过滤（pidSet），进程名正则只作回退（进程恰好有内核 rundown 补名时才有用）。
  const pidSet = opts.pidSet instanceof Set ? opts.pidSet : null
  const frameMode = opts.frameMode === 'symbols' ? 'symbols' : 'module'
  const foldRecursion = opts.foldRecursion !== false
  const jitMap = opts.jitMap || null
  const ALLOC = 'Microsoft-Windows-DotNETRuntime/GarbageCollection/GCAllocationTick'
  const pidOf = (proc) => { const m = /\(\s*(\d+)\s*\)/.exec(proc); return m ? m[1] : null }
  const matchProc = (proc) => {
    const pid = pidOf(proc)
    if (pidSet) return pid !== null && pidSet.has(pid) // 有 pidSet 就**只**认 pid（名字不可靠）
    return processRe.test(proc)
  }

  // ── Pass 1：目标进程的 AllocationTick → (ts,tid)→bytes；tid→pid；按 TypeName 汇总字节/次数。
  const tickBytes = new Map()      // "ts\ttid" -> bytes（该 tick 的分配量）
  const tidToPid = new Map()
  const byType = new Map()         // TypeName -> [bytes, count]
  let ticksAll = 0, ticksTarget = 0, totalBytes = 0
  await forEachLine(csvPath, (line) => {
    if (line.indexOf('GCAllocationTick') < 0) return
    const p = line.split(',')
    if (p[0].trim() !== ALLOC) return
    const ts = parseInt(p[1], 10)
    const tid = parseInt(p[3], 10)
    if (!Number.isFinite(ts) || !Number.isFinite(tid)) return // 表头
    ticksAll++
    const proc = (p[2] || '').trim()
    if (!matchProc(proc)) return
    ticksTarget++
    // AllocationAmount64 = 第 12 列（0x…）；早于含逗号的 TypeName，按列取安全。
    let bytes = 0
    const a64 = (p[12] || '').trim()
    if (/^0x[0-9A-Fa-f]+$/.test(a64)) bytes = Number(BigInt(a64))
    else { const a = (p[9] || '').trim(); if (/^0x[0-9A-Fa-f]+$/.test(a)) bytes = Number(BigInt(a)) }
    if (!(bytes > 0)) bytes = 1
    totalBytes += bytes
    tickBytes.set(ts + '\t' + tid, bytes)
    if (jitMap && !tidToPid.has(tid)) { const pm = /\(\s*(\d+)\s*\)/.exec(proc); if (pm) tidToPid.set(tid, pm[1]) }
    const tn = allocTypeName(line) || '<unknown-type>'
    const e = byType.get(tn); if (e) { e[0] += bytes; e[1]++ } else byType.set(tn, [bytes, 1])
  })

  // ── Pass 2：折叠命中 tickBytes 的 Stack 簇，权重 = 该 tick 字节。
  let jitAttempted = 0, jitResolved = 0
  const folded = new Map()
  const usedKeys = new Set()
  let curKey = null, curTid = null, curFrames = null, curNo = 0
  const resolveFrame = (addrHex, label, methods) => {
    if (methods && /^"?Unknown"?!0x[0-9A-Fa-f]+$/.test(label)) {
      jitAttempted++
      try { const m = lookupMethod(methods, BigInt(addrHex)); if (m) { jitResolved++; return m.name } } catch { /* fall through */ }
    }
    return normalizeFrame(label, frameMode)
  }
  const flush = () => {
    if (curKey && curFrames && curFrames.length && tickBytes.has(curKey) && !usedKeys.has(curKey)) {
      usedKeys.add(curKey)
      const methods = jitMap ? jitMap.get(tidToPid.get(curTid)) : null
      const rootToLeaf = []
      for (let i = curFrames.length - 1; i >= 0; i--) {
        const f = resolveFrame(curFrames[i].addr, curFrames[i].label, methods)
        if (foldRecursion && rootToLeaf.length && rootToLeaf[rootToLeaf.length - 1] === f) continue
        rootToLeaf.push(f)
      }
      const stack = rootToLeaf.join(';')
      folded.set(stack, (folded.get(stack) || 0) + tickBytes.get(curKey)) // ★ 权重 = 字节
    }
    curFrames = null
  }
  await forEachLine(csvPath, (line) => {
    if (eventName(line) !== 'Stack') return
    const p = line.split(',')
    const ts = parseInt(p[1], 10), tid = parseInt(p[2], 10), no = parseInt(p[3], 10)
    if (!Number.isFinite(ts) || !Number.isFinite(tid) || !Number.isFinite(no)) return
    const key = ts + '\t' + tid
    if (key !== curKey || no <= curNo) { flush(); curKey = key; curTid = tid; curFrames = tickBytes.has(key) ? [] : null }
    curNo = no
    if (curFrames) curFrames.push({ addr: (p[4] || '').trim(), label: p.slice(5).join(',').trim() })
  })
  flush()

  const topTypes = [...byType.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20)
    .map(([type, v]) => ({ type, bytes: v[0], ticks: v[1] }))
  return {
    folded, ticksAll, ticksTarget, totalBytes, topTypes,
    jit: jitMap ? { attempted: jitAttempted, resolved: jitResolved } : null,
  }
}

