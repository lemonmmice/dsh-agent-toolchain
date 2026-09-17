/**
 * dsh-perf JIT 符号映射 —— 把 CLR 的方法加载/rundown 事件建成「运行时地址 → 托管方法名」的区间表，
 * 用来解析 ETW 采样里那些 **dbghelp 认不出的 JIT 帧**（PerfView 解托管代码的核心手法）。
 *
 * 这是 docs/perfview-parity.md §3/§4 那条「客户端自己的方法名解不出来」的正解，且 §4 的 join
 * 已在本机**实测通过**（2026-09-17，devenv：`"Unknown"!0x7ffb4e152e8b` →
 * `Microsoft.VisualStudio.Platform.VsHostExecutionContextManager.Revert`，"Unknown" 帧命中 63.9%）。
 *
 * ── 为什么客户端方法在 CPU 采样里是 `"Unknown"!0xADDR`：
 *    客户端程序集是**运行时 JIT** 的，代码不在任何 PE 镜像的静态地址上 ⇒ xperf/dbghelp 拿到采样
 *    地址找不到对应模块，只能印 `"Unknown"!0x地址`。而 CLR 自己知道每个 JIT 方法编到了哪个地址、
 *    多大、叫什么 —— 它把这些通过 `Microsoft-Windows-DotNETRuntime(Rundown)` 事件发出来：
 *      MethodStartAddress（运行时绝对地址）+ MethodSize + MethodNamespace + MethodName。
 *    地址 ∈ [MethodStartAddress, MethodStartAddress+MethodSize) ⇒ 就是这个方法。这就是 join。
 *
 * ── 为什么用 **Rundown（0x118）**、且低污染：
 *    Rundown 的 DCEnd 在**会话停止那一刻**触发，一次性枚举**当前所有已 JIT 的方法**（含采样窗口内
 *    新 JIT 的，只要停止时还活着）。它在采样窗口内基本不产生事件 ⇒ 不像自定义采样档那样把被观测
 *    进程搞热（§4.4 的污染担忧对"停止时才触发"这条结构上不成立）。
 *
 * ── 地址是**进程私有**的：不同进程各有地址空间，JIT 地址会重叠。所以映射表**必须按 pid 分桶**，
 *    查的时候用采样帧所属线程的 pid 去查自己那张表，绝不跨进程混用。
 *
 * 解析是纯函数（对 test/fixtures/jit-rundown.xml 单测）；解码 etl→xml 的编排在 trace.mjs（复用 tracerpt）。
 */

/** XML 实体还原（方法名里常见 &lt;&gt;c__DisplayClass、&amp;）。 */
function unent(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

const RE_PID = /ProcessID="(\d+)"/
const RE_START = /<MethodStartAddress>0x([0-9A-Fa-f]+)<\/MethodStartAddress>/
const RE_SIZE = /<MethodSize>0x([0-9A-Fa-f]+)<\/MethodSize>/
const RE_NS = /<MethodNamespace>([^<]*)<\/MethodNamespace>/
const RE_NAME = /<MethodName>([^<]*)<\/MethodName>/

/** 从一段含 MethodStartAddress 的文本里取一个方法记录（返回 null 表示这段不是方法事件）。 */
export function parseMethodEntry(block) {
  const a = RE_START.exec(block); if (!a) return null
  const s = RE_SIZE.exec(block); if (!s) return null
  const start = BigInt('0x' + a[1])
  const size = BigInt('0x' + s[1])
  if (size <= 0n) return null
  const ns = RE_NS.exec(block); const nm = RE_NAME.exec(block)
  const nsv = ns ? ns[1].trim() : ''
  const nmv = nm ? nm[1].trim() : ''
  // dynamicClass 命名空间 = 动态方法（lambda / IL stub），只留方法名更可读。
  const name = unent((nsv && nsv !== 'dynamicClass' ? nsv + '.' : '') + (nmv || '?'))
  return { start, end: start + size, name }
}

/**
 * 纯解析：tracerpt XML 文本 → Map<pid(string), 方法数组>（未排序）。供 fixture 单测。
 * 每个 <Event> 里 <Execution ProcessID> 在前、方法 payload 在后，按事件块切开逐块取。
 */
export function parseJitMethodsText(xmlText) {
  const text = String(xmlText || '')
  const blocks = text.split(/(?=<Event\b)/).filter((b) => /<Event\b/.test(b))
  const byPid = new Map()
  for (const b of blocks) {
    if (!b.includes('MethodStartAddress')) continue
    const pm = RE_PID.exec(b); if (!pm) continue
    const entry = parseMethodEntry(b); if (!entry) continue
    const pid = pm[1]
    if (!byPid.has(pid)) byPid.set(pid, [])
    byPid.get(pid).push(entry)
  }
  return byPid
}

/** 排序 + 去重（同 start 保留 end 最大的，覆盖 tiered/rejit 的旧短记录）。就地返回排序后的数组。 */
export function sortMethods(arr) {
  arr.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : (x.end < y.end ? 1 : -1)))
  return arr
}

/** 把 parseJit... 的 Map 每桶排序，返回同一个 Map（就地）。 */
export function finalizeJitMap(byPid) {
  for (const [, arr] of byPid) sortMethods(arr)
  return byPid
}

/** 二分：地址落在哪个方法区间。sorted = sortMethods 后的数组；addr = BigInt。命中返回 {start,end,name}，否则 null。 */
export function lookupMethod(sorted, addr) {
  if (!sorted || !sorted.length) return null
  let lo = 0, hi = sorted.length - 1, ans = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = sorted[mid]
    if (m.start <= addr) {
      if (addr < m.end) { ans = m; break }
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * 流式建表：逐行读 tracerpt XML 文件 → finalize 过的 Map<pid, 排序方法数组>。
 * 大 rundown（几十万方法）也只在内存里存方法记录本身，不把整份 XML 读进字符串。
 * 逐行前提：tracerpt 把每个 MethodLoadUnload(Rundown)Verbose 元素**整个打在一行**（本机实测如此），
 * 而 <Execution ProcessID> 在该方法行**之前**的独立行 —— 所以顺序扫描、跟踪"当前 pid"即可。
 * @param {string} xmlPath
 * @param {(pid:string)=>boolean} [pidFilter] 只保留通过的 pid（省内存；默认全收）
 */
export async function buildJitMapStreaming(xmlPath, pidFilter) {
  const { createReadStream } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const byPid = new Map()
  let curPid = null
  const rl = createInterface({ input: createReadStream(xmlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const pm = RE_PID.exec(line)
      if (pm) { curPid = pm[1]; continue }
      if (curPid && line.indexOf('<MethodStartAddress>') >= 0) {
        if (pidFilter && !pidFilter(curPid)) continue
        const entry = parseMethodEntry(line)
        if (entry) {
          if (!byPid.has(curPid)) byPid.set(curPid, [])
          byPid.get(curPid).push(entry)
        }
      }
    }
  } finally {
    rl.close()
  }
  return finalizeJitMap(byPid)
}
