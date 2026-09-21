/**
 * dsh-perf trace — ETW 采样剖析（超时调用链定位）。
 *
 * 为什么需要它（与 perf_probe / perf_dump 的分工）：
 *   · perf_probe  只回答"什么时候卡"；
 *   · perf_dump   是**一个瞬间**的快照，回答"此刻谁在栈上"，抓不到就白抓，
 *                 且回答不了"过去 N 秒里**谁反复调用了它**"；
 *   · 本模块用 ETW 连续采样，回答"**谁在调用它、它又调用了谁**" —— 即完整调用链。
 *
 * 实测得到的 xperf 用法（Windows Performance Toolkit）：
 *   采集：wpr -start CPU -start DotNet -filemode   →  复现  →  wpr -stop out.etl
 *   报告：xperf -symbols -i out.etl -o report.html -a stack -butterfly <minHits> [-process <re>] [-symbol <re>]
 *   → HTML 里含「Functions by UniInclusive Hits」（谁最热）
 *        与「Functions by Multi-Inclusive Hits with Callers and Callees」（蝶形：--> callee / <-- caller）
 *
 * **两个实测踩出来的硬性细节（漏了就拿不到托管调用链）**：
 *   1. 报告必须显式带 `-symbols`。xperf 帮助原文：
 *      "If action symbols is not specified on the command line, symbol decoding is disabled."
 *      不加：2 秒出报告、函数名全是 `***unknown***`；加了：解出 `ntdll.dll!RtlUserThreadStart` 这类真实名字。
 *   2. 采集必须**同时**启用 CPU **与** DotNet 预设。只用 CPU 时托管帧的模块能解、**函数名解不出**
 *      （`mscorlib.dll!***unknown***`），因为没有 CLR 的 rundown 事件；两个一起开之后才拿到
 *      `SMA!System.Management.Automation.Interpreter.EnterTryCatchFinallyInstruction.Run(...)` 这种
 *      **带参数签名的托管方法名**。代价是 etl 更大（实测 411MB）、首次出报告更慢（214s，含符号下载）。
 *
 * 两条硬纪律（沿用本仓 B-1 的"没读到 ≠ 没有"）：
 *   1. **符号未解析必须如实上报**：报告里 `***unknown***` 的占比要显式返回，
 *      否则调用方会把"没解析出来"当成"没有这段代码"。
 *   2. **绝不把原始 HTML 丢回去**：几 MB 的 HTML 对模型毫无价值，必须压缩成可读的调用链文本。
 */
import { envOr } from '../../../lib/env-fallback.mjs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { parseClrEvents, parseTraceSummary, summarizeClr } from './clr-events.mjs'
import { foldDumperCsv, foldAllocCsv, foldedToText, buildTree, renderFlameHtml } from './flame.mjs'
import { buildJitMapStreaming } from './jitmap.mjs'
import { analyzeThreadWaits } from './uifreeze.mjs'

const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
export const DEFAULT_WPR = process.env.DSH_PERF_WPR || join(SYSTEM32, 'wpr.exe')
export const DEFAULT_XPERF = process.env.DSH_PERF_XPERF || join(PROGRAM_FILES_X86, 'Windows Kits', '10', 'Windows Performance Toolkit', 'xperf.exe')
/** tracerpt.exe：把 .etl 解码成可解析的 XML（CLR 事件那条线全靠它）。 */
export const DEFAULT_TRACERPT = process.env.DSH_PERF_TRACERPT || join(SYSTEM32, 'tracerpt.exe')
/** logman.exe：起一条**独立**的 CLR 用户态会话（不依赖 WPR —— 本机 WPR 收不了尾）。 */
export const DEFAULT_LOGMAN = process.env.DSH_PERF_LOGMAN || join(SYSTEM32, 'logman.exe')

/**
 * CLR 采集会话（`perf_trace(clr=true)`）挂的 provider —— **只挂一个**。
 *
 * ⚠ 为什么不是三个：`logman start` **不接受第二个 `-p`**。实测（2026-09-17）：
 *     `logman start x -p A 0x18 0x5 -p B 0x18 0x5 -o f.etl -ets`
 *     → `Argument 'p' has been defined too many times.`，退出码 `0x80070057`。
 *   要挂多个 provider 就得起**多条会话**（spike v2 就是这么做的：两条会话各一个 provider，各自成 etl）。
 *
 * ⚠ 为什么现在只挂 GC 这条：`0x18`（Loader|JIT）与 `...Rundown` 的产出是给**尚末接线的**
 *   「地址→方法」join 用的（见 docs/perfview-parity.md §4）。接线之前先挂上它们 = 白付磁盘开销，
 *   而且会**多背一份尚未测量的观测者开销**（clr-rundown.wprp 那次已经证明采集能把被观测进程搞热：
 *   46% 的包含命中落在 ETW 投递帧上）。等 join 真做、污染也量过，再按需加会话。
 *
 * keyword `0x4001` = GC(0x1) | Contention(0x4000)；level `0x5` = Verbose。三者都是 spike 验过的。
 */
export const CLR_PROVIDERS = [
  { provider: 'Microsoft-Windows-DotNETRuntime', keywords: '0x4001', level: '0x5' },
]


/** wpr 预设名映射（wpr -profiles 里的大小写就是这些）。 */
export const PROFILES = { cpu: 'CPU', dotnet: 'DotNet', general: 'GeneralProfile' }

/**
 * 采样会话标记文件的**唯一**位置：证据目录根下的 `trace-session.json`。
 *
 * ⚠⚠ 这个函数存在的理由是一次真机缺陷（2026-09-14 夜 R1-04，**完整复现**）：
 *   原实现把标记写在 `runDir()` 里，而 `runDir()` **每次调用都取一次 `new Date()`** ——
 *   于是 `start` 把标记写进 `trace-<T1>/`，`status` 却去 `trace-<T2>/` 里找（T2 = 调用时刻）。
 *   三个连环后果（同一根因）：
 *     ① `perf_trace(action="status")` **永远报 running:false**（实测：`start` 返回成功后立刻查
 *        status，它说"没有进行中的采样（按标记），也没有找到 etl"——而 WPR 的内核会话正开着、
 *        etl 正在写。agent 照着这句提示会**再 start 一次**）；
 *     ② `stop`/`cancel` 删的也是 `trace-<T2>/` 里的标记 ⇒ 真正的标记**永远删不掉**，
 *        每跑一次留一个孤儿标记；
 *     ③ `evidence-clean.mjs`（`perf_clean`）按**证据目录根**读这个标记（`join(dir,'trace-session.json')`）
 *        ⇒ 它"采样进行中不删 etl"的保护**从来没生效过** —— 两个组件对同一个契约各写各的。
 *   修法：把位置收敛成一个**导出的纯函数**，读写两端都从这里取（写者对齐读者，而不是反过来）。
 */
export function traceSessionFile(evidenceDir) { return join(evidenceDir, 'trace-session.json') }

/**
 * 采集时要同时启用的预设。
 * `cpu` 档也带上 `DotNet` —— 实测：只开 CPU 时托管帧的**函数名解不出来**（只有模块名），
 * 因为缺 CLR 的 rundown 事件；而对 .NET 应用来说那些函数名才是真正要看的调用链。
 */
/** 采样器进程在不在（wpr/xperf）—— **只作旁证**：查不到返回 null（≠ 没在跑），调用方必须按三态读。 */
function samplerRunning() {
  try {
    const r = spawnSync('tasklist', ['/fi', 'IMAGENAME eq wpr.exe'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (/wpr\.exe/i.test(String(r.stdout || ''))) return true
    const r2 = spawnSync('tasklist', ['/fi', 'IMAGENAME eq xperf.exe'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return /xperf\.exe/i.test(String(r2.stdout || ''))
  } catch {
    return null   // 查不到就是「不知道」，不许说成 false
  }
}

export const CAPTURE_SETS = { cpu: ['CPU', 'DotNet'], dotnet: ['DotNet', 'CPU'], general: ['GeneralProfile'] }

/**
 * xperf 失败时的**定向诊断**（F-027，2026-09-12 r29 真机端到端时查出）。
 *
 * 实测：xperf 因 **ETW 丢事件**失败时打印
 *   `6728 Events were lost in this trace. … insufficient disk bandwidth for ETW logging.`
 *   并以 `0x80070030`（ERROR_BUFFER_OVERFLOW）退出，**报告文件是 0 字节**。
 * 而旧实现只按"报告里没有可解析的函数条目"给通用提示（"可能：符号未解析 / focus 太严 / xperf 输出为空"）
 * —— **把用户引向符号**，而真正的原因是缓冲区/磁盘带宽。
 * **错误信息把人引向错误的位置，比不给信息更糟。**
 * 现在把 xperf 的退出码与**原文尾部**带出去，能识别时给出对症的下一步。
 */
export function diagnoseXperfFailure(code, rawOutput, reportBytes) {
  const out = String(rawOutput ?? '')
  const tail = out.trim().replace(/\s+/g, ' ').slice(-500)
  const m = /(\d+)\s+Events were lost/i.exec(out)
  const eventsLost = m !== null ? Number(m[1]) : null
  let diagnosis = null
  if (eventsLost !== null) {
    diagnosis = `ETW **丢事件**（xperf 原文：${eventsLost} events were lost；官方解释是 ETW 日志的磁盘带宽不足）。`
      + '这**不是**符号问题，也不是"没有热点"。下一步：① 缩短采集时长；② 采集期间减少磁盘写入'
      + '（本机同时在做 dump / 写大文件时尤其明显）；③ 加大 ETW 缓冲区或降低采样负载；④ 重采一次再出报告。'
  } else if (code !== null && code !== undefined && code !== 0) {
    diagnosis = `xperf 退出码 ${code}（非 0）` + (reportBytes === 0 ? '，报告为 0 字节' : '')
      + '。原文尾部见 raw 字段 —— 请以 xperf 的原话为准，不要默认是符号问题。'
  } else if (reportBytes === 0) {
    diagnosis = 'xperf 产出了 **0 字节报告**（通常意味着它没能解析这份 etl）—— 原文尾部见 raw 字段。'
  }
  return { exitCode: code ?? null, tail, eventsLost, diagnosis }
}

/**
 * `_NT_SYMBOL_PATH` 是**整串替换**，不是追加 —— 这是个会被静默踩中的坑：
 * 想把客户端自己的 pdb 加进来的人，很自然就写 `DSH_PERF_SYMBOL_PATH=<客户端 bin>`，
 * 结果**系统 DLL 的符号全部丢失**，报告里从栈顶开始一路 `***unknown***`，
 * 而人只会以为"这台机器符号没配好/网络不通"。
 * 实测现场（F-045）：把客户端 bin（16 个 pdb）单独写进去后，报告里 `ntdll/clr/mscorlib` 全变 unknown。
 *
 * 所以规则改成「**加**符号服务器，而不是**换掉**它」：
 *   - 配的值里有符号服务器指令（`srv*`）→ 原样使用（调用方明确知道自己在干什么）；
 *   - 配的值只是目录（可能带 `;` 分隔的多个目录）→ **接在**默认公网链后面，并且**如实上报**（composed=true）。
 * 返回 `{ value, composed }`：composed 不是"内部细节"，是调用方必须转达给用户的事实。
 */
export function composeSymbolPath(configured, dflt) {
  const c = String(configured == null ? '' : configured).trim()
  if (!c) return { value: String(dflt), composed: false }
  if (/(^|;)\s*srv\*/i.test(c)) return { value: c, composed: false }
  return { value: c.replace(/[;\s]+$/, '') + ';' + String(dflt), composed: true }
}

/**
 * 成功路径也要能看见 xperf 的原话。
 *
 * 为什么必须补：`perf_hotstacks` 的工具描述写着 "debugSymbols: true = 让 xperf 打印符号查找细节
 * （结果 raw 里回带）"，但 `hotstacks()` 只在**失败路径**塞 `raw` ——
 * 于是"报告成功、却全是不认识的函数名"这种**最需要符号日志**的情形，恰恰拿不到日志。
 * 实测现场（F-044）：探针脚本里那条"看 xperf 符号日志里提到了哪个客户端模块"的检查，
 * 输出恒为 `raw 长度 = 0` —— 一个**永远不可能成立**的空洞检查。
 */
export function trimXperfRaw(out, { maxChars = 4000, symbolOnly = false } = {}) {
  const all = String(out == null ? '' : out)
  const lines = all.split(/\r?\n/)
  let kept = lines
  if (symbolOnly) {
    // ⚠️ 第一版只留"含关键词的行"，结果把**失败原因**丢掉了。
    //    反例（Codex r37）：`DBGHELP: loading Client.pdb` / `  Access is denied.` / `  HTTP status: 403`
    //    只留下第一行 —— 而真正说明问题的恰恰是后两行（它们不含 symbol/pdb 这类词）。
    //    同理 `6728 Events were lost in this trace.` 也会在有关键词命中时被一起过滤掉。
    //    现在：关键词行 **+ 紧随其后的上下文行（缩进行/错误行）** 一起留，并如实标注"过滤过"。
    const CONTEXT_RE = /^\s|denied|lost|error|fail|failed|cannot|unable|timeout|timed out|refus|not found|HTTP\s*[45]\d\d|0x[0-9a-f]{4,}/i
    const KEY_RE = /symbol|\.pdb|srv\*|dbghelp|symcache|_NT_|downloading|SYMCHK/i
    const hit = lines.some((l) => KEY_RE.test(l))
    if (hit) {
      const picked = []
      for (let i = 0; i < lines.length; i++) {
        if (KEY_RE.test(lines[i])) { picked.push(lines[i]); continue }
        // 上一行是关键词行，且这一行像"它的续行/失败原因" ⇒ 保留
        if (picked.length > 0 && CONTEXT_RE.test(lines[i]) && lines[i].trim() !== '') picked.push(lines[i])
      }
      kept = picked
    }
  }
  const text = kept.join('\n').trim()
  return {
    raw: text.length > maxChars ? text.slice(0, maxChars) : text,
    // 是**字节**，不是"字符数"：Codex r37 指出 `'符号'.length === 2` 而 UTF-8 是 6 字节，
    // 渲染成"共 2 字节"就是假数字；同时它标的是**原始日志的总大小**，不是留出来的那一小段。
    rawBytes: Buffer.byteLength(all, 'utf8'),
    rawChars: all.length,
    rawTruncated: text.length > maxChars,
    rawFiltered: kept.length !== lines.length,
  }
}

export function makeTrace(cfg = {}) {
  const c = Object.assign({
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
    wpr: DEFAULT_WPR,
    xperf: DEFAULT_XPERF,
    tracerpt: DEFAULT_TRACERPT,
    logman: DEFAULT_LOGMAN,
    procName: envOr('DSH_UI_PROC_NAME'),
    symbolPath: envOr('DSH_PERF_SYMBOL_PATH') || process.env._NT_SYMBOL_PATH || '',
    // 符号缓存根（跨运行共享）。空 = evidenceDir/symbol-cache。
    symbolCacheDir: envOr('DSH_PERF_SYMBOL_CACHE'),
  }, cfg)
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'perf-evidence')

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runDir = (tag) => join(c.evidenceDir, 'trace-' + stamp() + (tag ? '-' + tag : ''))

  /** 跑一个可执行文件并收全输出；超时杀进程树。 */
  function runExe(exe, args, opts = {}) {
    // 测试接缝（理由同 env-fallback 的 env/exec 注入）：采集前自检的行为必须能被**离线**验住 ——
    // 否则"这台机器的 WPR 能不能收尾"只能靠真机碰运气，而它恰恰是"白跑一轮复现"的分水岭。
    if (typeof c.runExe === 'function') return c.runExe(exe, args, opts)
    const { timeoutMs = 600000, env } = opts
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(exe, args, { windowsHide: true, env: env || process.env })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e, timedOut: false })
        return
      }
      let out = '', err = '', settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e), timedOut: false }) } })
      child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut: false }) } })
    })
  }

  /** ETW 内核会话需要管理员：先说清楚，别让用户对着 "Access is denied" 猜。 */
  const ELEVATED_PS = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  async function isElevated() {
    const ps = envOr('DSH_PERF_POWERSHELL') || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const r = await runExe(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ELEVATED_PS], { timeoutMs: 20000 })
    return /True/i.test(r.stdout)
  }

  /**
   * **采集前自检**：这台机器的 `wpr` 能不能**收尾**（start 之后 stop 得出 etl）？
   *
   * ⚠ 为什么必须有（2026-09-15 真机 R1-12）：本机 WPR 的 `-stop` 坏了 ——
   *   `wpr -start CPU -filemode` 正常，`wpr -stop <file>` 报
   *   `Cannot change thread mode after it is set. Profile Id: RunningProfile. Error code: 0x80010106`
   *   且**不产出 etl**。而 `perf_trace` 的采集**单点依赖 WPR** ⇒
   *   失败发生在**用户把问题复现完之后**才发现 ⇒ **白跑一轮**（复现一次可能要好几分钟到几十分钟）。
   *   所以：start 之前先用 1~2 秒的极小探针把"能不能收尾"问清楚，**当场告诉调用方**。
   *
   * ⚠ 退出码口径（R1-14 更正，2026-09-15 实测）：**不能写"退出码恒为 0"**。
   *   本机实测那一发是**响亮失败**：`$LASTEXITCODE = -2147417850`（= 0x80010106）。
   *   早先"退出码 0"的说法来自一次未复现的观察 —— **判据始终是"有没有 etl 文件"**，不是退出码；
   *   所以下面的诊断文案一律**回带实测退出码**，而不是替 wpr 断言它退了几。
   *
   * 设计取舍：探针**发现坏也照样允许 start**（可能别的 profile 能收尾），但会把
   * `preflight.ok=false` + 警告放进返回值 —— **不静默、也不擅自替调用方做决定**。
   * 结果按进程缓存（探针代价只付一次）；`skipPreflight: true` 可跳过。
   */
  let wprStopProbeCache = null
  async function probeWprStop() {
    if (wprStopProbeCache) return wprStopProbeCache
    const probeEtl = join(c.evidenceDir, '_wpr-preflight.etl')
    try { rmSync(probeEtl, { force: true }) } catch { /* 删不掉不影响结论 */ }
    const t0 = Date.now()
    const st = await runExe(c.wpr, ['-start', 'CPU', '-filemode'], { timeoutMs: 60000 })
    let stopCode = null, raw = ''
    let ok = false
    if (st.code === 0) {
      const sp = await runExe(c.wpr, ['-stop', probeEtl], { timeoutMs: 120000 })
      stopCode = sp.code
      raw = (sp.stdout + sp.stderr).trim()
      ok = existsSync(probeEtl)
      try { if (ok) rmSync(probeEtl, { force: true }) } catch { /* 探针产物，删不掉也无害 */ }
    } else {
      raw = (st.stdout + st.stderr).trim()
    }
    // 探针万一留下会话，收掉它 —— 否则真正的 start 会撞"已有会话"
    try { await runExe(c.wpr, ['-cancel'], { timeoutMs: 60000 }) } catch { /* ignore */ }
    wprStopProbeCache = {
      ok, startCode: st.code, stopCode, elapsedMs: Date.now() - t0,
      signature: /0x80010106|Cannot change thread mode/i.test(raw) ? 'RPC_E_CHANGED_MODE(0x80010106)' : null,
      raw: raw.slice(0, 300),
    }
    return wprStopProbeCache
  }

  /**
   * 采集 ETW trace。
   * action=start → 起采样（等你复现）; stop → 停并产出 etl; run → 起→等 seconds 秒→停。
   * @returns {ok, etlPath?, seconds?, profile?, error?, hint?}
   */
  // ---------------------------------------------------------------- CLR 用户态会话（perf_trace(clr=true)）
  //
  // 为什么是**独立会话**、而不是给 WPR 加一份自定义档：
  //   · 本机 WPR 收不了尾（engine=auto 会路由到 xperf），而 xperf 那条通道的参数
  //     `PROC_THREAD+LOADER+PROFILE+CSWITCH` 是**纯内核 flag** —— 实测 276 MB 的 trace.etl 经
  //     tracerpt 汇总**连 e13c0d23 都没有**（CLR provider 从没被打开过）。
  //   · logman 起一条只挂 CLR provider 的用户态会话：不依赖 WPR、etl 小、tracerpt 可控，
  //     与内核会话**并行互不干扰** ⇒ 对既有 xperf/WPR 路径**零改动**（这是刻意的：那条路很脆）。
  //   · 这正是 clr-events-spike FINDINGS.md 给出的形状（"已验证机制，未接入 trace.mjs"）。

  /** logman 会话名（机器全局唯一；同一时刻不支持两次并行 CLR 采集，第二次会先停掉第一次）。 */
  const CLR_SESSION = 'dshperfclr'

  async function clrSessionStop() {
    const r = await runExe(c.logman, ['stop', CLR_SESSION, '-ets'], { timeoutMs: 120000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 300)
    return { ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw }
  }

  async function clrSessionStart(etlPath) {
    // 上一次崩掉会留下同名会话，直接 start 会因"已存在"失败 ⇒ 先无条件停一次（停不掉也无所谓）。
    await clrSessionStop()
    const args = ['start', CLR_SESSION]
    for (const p of CLR_PROVIDERS) args.push('-p', p.provider, p.keywords, p.level)
    args.push('-o', etlPath, '-ets')
    const r = await runExe(c.logman, args, { timeoutMs: 60000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 500)
    return {
      ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw,
      session: CLR_SESSION, etlPath, command: 'logman ' + args.join(' '),
    }
  }

  // ---------------------------------------------------------------- CLR 方法/rundown 会话（perf_trace(jit=true)）
  //
  // 用途：给 §4 的「地址→方法」映射供数据。Rundown provider `Microsoft-Windows-DotNETRuntimeRundown`
  // keyword `0x118`（EndRundown 0x100 | Jit 0x10 | Loader 0x8）—— DCEnd 在**会话停止那一刻**触发，
  // 一次性枚举当前所有已 JIT 方法（含采样窗口内新 JIT 的，只要停止时还活着）。
  // ★ 为什么低污染（回应 docs §4.4）：keyword **不含** StartRundown(0x40) ⇒ 采样窗口内它基本不产事件，
  //   只在 stop 那一刻集中吐 —— 不会像自定义采样档那样把被观测进程搞热。实测（2026-09-17）15s 窗口内
  //   rundown 会话产出的采样期事件≈0，方法记录全部集中在 stop（devenv 单进程 46619 方法）。
  const JIT_SESSION = 'dshperfjit'

  async function jitSessionStop() {
    const r = await runExe(c.logman, ['stop', JIT_SESSION, '-ets'], { timeoutMs: 120000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 300)
    return { ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw }
  }

  async function jitSessionStart(etlPath) {
    await jitSessionStop()
    const args = ['start', JIT_SESSION, '-p', 'Microsoft-Windows-DotNETRuntimeRundown', '0x118', '0x5', '-o', etlPath, '-ets']
    const r = await runExe(c.logman, args, { timeoutMs: 60000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 500)
    return {
      ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw,
      session: JIT_SESSION, etlPath, command: 'logman ' + args.join(' '),
    }
  }

  // ---------------------------------------------------------------- CLR 分配采样会话（perf_trace(alloc=true)）
  //
  // AllocationTick（GC keyword 0x1, Verbose）每分配约 100KB 采一次，带 TypeName + 字节；配 `:'stack'`
  // 让 xperf 给**每个 AllocationTick 附一条调用栈** —— 就能折出「谁在分配/制造 GC 压力」的分配火焰图
  // （PerfView 的 GC Heap Alloc Stacks）。用 **xperf 命名用户会话**（logman 不便给用户态事件附栈）。
  // ★ 关键语法（实测）：栈限定符是**字面量 `'stack'`（带单引号）**，是 provider 串的第 4 段：
  //   `Provider:Keywords:Level:'stack'`。spawn 不过 shell ⇒ 这里的单引号原样传给 xperf（对）。
  //   ⚠ 只对**能解出 manifest 的 CLR**有效：本机 .NET Framework 客户端（ClientApp/OtherApp，manifest 已注册）
  //   会正常解成 GCAllocationTick；.NET Core/5+ 进程会落成 UnknownEvent/Crimson（manifest 未注册）——
  //   我们的目标客户端是 .NET Framework 4.5.2，正是能解的那类。
  const ALLOC_SESSION = 'dshperfalloc'
  const ALLOC_PROVIDER = 'Microsoft-Windows-DotNETRuntime:0x1:0x5:\'stack\''

  async function allocSessionStop(mergedEtl) {
    // -d 合并：把原始 etl 合成带模块归属的最终 etl（原生帧才有模块名）。给了 mergedEtl 才合并。
    const args = mergedEtl ? ['-stop', ALLOC_SESSION, '-d', mergedEtl] : ['-stop', ALLOC_SESSION]
    const r = await runExe(c.xperf, args, { timeoutMs: 300000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 300)
    return { ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw }
  }

  async function allocSessionStart(rawEtl) {
    await allocSessionStop() // 清掉可能残留的同名会话
    const args = ['-start', ALLOC_SESSION, '-on', ALLOC_PROVIDER, '-f', rawEtl]
    const r = await runExe(c.xperf, args, { timeoutMs: 120000 })
    const raw = (((r && r.stdout) || '') + ((r && r.stderr) || '')).trim().slice(0, 500)
    return {
      ok: Boolean(r) && r.code === 0, exitCode: r ? r.code : null, raw,
      session: ALLOC_SESSION, etlPath: rawEtl, command: 'xperf ' + args.join(' '),
    }
  }

  /**
   * `perf_clrevents` —— 从 .etl 汇总 CLR 运行期事件（GC 停顿 / 各代次数 / 托管堆 / 锁争用）。
   *
   * 补的是 perf_probe（只测 UI 消息泵）与 perf_dump（冻结抓一瞬间）之间那条缝：
   * **「GC 暂停导致的卡顿」** —— 实时行情 WPF 客户端最典型的卡顿成因之一。
   *
   * ★ 本工具最重要的一条是**三态**，不是数字：
   *     ① etl 里根本没有 CLR provider（e13c0d23 / a669021c 都没出现）⇒ **"没采"**，
   *        不是"没有 GC"。这是最容易把 agent 带沟里的一种：他会据此断言"客户端没有 GC 停顿"。
   *     ② provider 在、窗口内 GC/Start = 0 ⇒ 那**才**叫"这段窗口确实没发生 GC"。
   *     ③ 解码失败/超时 ⇒ "未知"，不许回落成 0。
   *   所以 `state` 字段是结果的主语，数字只在 ①/② 分清楚之后才有意义。
   */
  async function clrEvents(args = {}) {
    const pidText = args.pid == null || args.pid === '' ? '' : String(args.pid).trim()
    if ((args.pid != null && args.pid !== '' && !/^\d+$/.test(pidText)) || (pidText && (Number(pidText) < 1 || Number(pidText) > 4294967295))) return { ok: false, state: 'invalid-pid', error: 'pid 必须是一个有效的 Windows 进程 ID（正整数）' }
    const pid = pidText ? Number(pidText) : null
    const scope = pid == null ? 'machine-wide' : 'process'
    const etl = args.etlPath ? String(args.etlPath) : ''
    if (!etl) return { ok: false, state: 'etl-missing', error: '需要 etlPath（perf_trace 产出的 .etl）' }
    if (!existsSync(etl)) return { ok: false, state: 'etl-missing', etlPath: etl, error: 'etlPath 不存在：' + etl }
    if (!existsSync(c.tracerpt)) {
      return { ok: false, state: 'tracerpt-missing', etlPath: etl, error: 'tracerpt.exe 不存在：' + c.tracerpt + '（可用 DSH_PERF_TRACERPT 指定）' }
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 900000, 10000), 3600000)
    const dir = dirname(etl)
    const stem = basename(etl).replace(/\.etl$/i, '')
    const summaryPath = args.summaryPath ? String(args.summaryPath) : join(dir, stem + '.clr-summary.txt')
    const etlBytes = statSync(etl).size

    // ① 便宜的先跑：`-summary` 且**不带 `-o`** ⇒ 不生成 XML。实测 79.5 MB 的 etl 14 秒出结果，
    //    足够回答"这个 etl 里到底有没有 CLR provider"这个真正的前置问题。
    const g = await runExe(c.tracerpt, [etl, '-summary', summaryPath, '-y'], { timeoutMs })
    const gateRaw = (((g && g.stdout) || '') + ((g && g.stderr) || '')).trim().slice(-500)
    if (!g || g.timedOut) {
      return { ok: false, state: 'tracerpt-timeout', etlPath: etl, etlBytes, summaryPath, raw: gateRaw, error: 'tracerpt 读摘要超时' }
    }
    if (g.code !== 0 || !existsSync(summaryPath)) {
      return {
        ok: false, state: 'tracerpt-failed', etlPath: etl, etlBytes, summaryPath,
        exitCode: g.code, raw: gateRaw,
        error: 'tracerpt 读摘要失败（exit ' + g.code + '）—— **未解码，所以"有没有 GC"是未知，不是 0**。',
      }
    }
    let summary = null
    try { summary = parseTraceSummary(readFileSync(summaryPath, 'utf8')) } catch (e) {
      return { ok: false, state: 'summary-unreadable', etlPath: etl, summaryPath, error: '摘要读不出来：' + e }
    }

    // ② 闸门：provider 不在就**到此为止**，不再花几分钟解 XML（几百 MB 的 etl 能解出 GB 级）
    if (!summary.hasClr) {
      // 名字直接用 tracerpt 摘要表里 Event Name 列的原值 —— 那是 etl 自己带的信息。
      // （早先版本走 `logman query providers` 反查，真机发现内核 GUID 全查不到、全成"(未收录)"。）
      const known = summary.providers
        .map((p) => ({ guid: p.guid, events: p.events, name: p.name || null }))
        .sort((a, b) => b.events - a.events)
      return {
        ok: false, state: 'no-clr-provider', etlPath: etl, etlBytes, summaryPath, summary,
        providers: known,
        error: '这个 etl 里**没有 CLR provider**（e13c0d23 / a669021c 都没出现）—— ' +
          '这是「**没采**」，**不是「没有 GC 停顿」**。当前 etl 只含 ' + summary.providerCount + ' 个 provider（共 ' +
          (summary.totalEvents === null ? '未读到' : summary.totalEvents) + ' 条事件）。',
        hint: '要拿 GC 数据，用 perf_trace(action="run", seconds=N, clr=true) 采一份带 CLR 会话的；' +
          '或直接把已有的 CLR etl 喂给本工具。',
      }
    }

    // ③ 解码 XML。解码体积实测是 etl 的 4~6×（303 KB→1.80 MB、2.9 MB→12.7 MB、13.4 MB→53.7 MB），
    //    几百 MB 的系统 trace 会变成 GB 级 —— 所以默认设闸，并把估算值如实报出来。
    const estXmlBytes = Math.round(etlBytes * 6)
    const maxXmlBytes = (Number(args.maxXmlMb) > 0 ? Number(args.maxXmlMb) : 2048) * 1024 * 1024
    if (estXmlBytes > maxXmlBytes) {
      return {
        ok: false, state: 'xml-too-large', etlPath: etl, etlBytes, summaryPath, summary,
        estimatedXmlBytes: estXmlBytes, maxXmlBytes,
        error: '预计解码出 ' + Math.round(estXmlBytes / 1048576) + ' MB XML，超过上限 ' +
          Math.round(maxXmlBytes / 1048576) + ' MB（实测解码体积 ≈ etl × 4~6）⇒ 未解码。' +
          '**"有没有 GC"因此是未知，不是 0。**',
        hint: '三种走法：① 用 perf_trace(clr=true) 采一份**provider 独占**的小 etl（CLR 事件只占总量的极小部分）；' +
          '② 传更大的 maxXmlMb；③ 传 xmlPath 直接复用已解好的 XML。',
      }
    }
    const xmlPath = args.xmlPath ? String(args.xmlPath) : join(dir, stem + '.clr.xml')
    const d = await runExe(c.tracerpt, [etl, '-o', xmlPath, '-of', 'XML', '-y'], { timeoutMs })
    const decRaw = (((d && d.stdout) || '') + ((d && d.stderr) || '')).trim().slice(-500)
    if (!d || d.timedOut) {
      return { ok: false, state: 'decode-timeout', etlPath: etl, summaryPath, summary, xmlPath, estimatedXmlBytes: estXmlBytes, raw: decRaw, error: '解码 XML 超时（**未解码 ⇒ 未知，不是 0**）' }
    }
    if (d.code !== 0 || !existsSync(xmlPath)) {
      return { ok: false, state: 'decode-failed', etlPath: etl, summaryPath, summary, xmlPath, exitCode: d.code, raw: decRaw, error: '解码 XML 失败（exit ' + d.code + '）—— **未解码 ⇒ 未知，不是 0**' }
    }
    const xmlBytes = statSync(xmlPath).size
    let events = []
    try { events = parseClrEvents(readFileSync(xmlPath, 'utf8')) } catch (e) {
      return { ok: false, state: 'xml-unreadable', etlPath: etl, xmlPath, error: '解码后的 XML 读不出来：' + e }
    }
    const originalParsedEvents = events.length
    const availableProcessIds = [...new Set(events.map(event => event.processId).filter(processId => processId != null))].sort((left, right) => left - right)
    if (pid != null) events = events.filter(event => event.processId === pid)
    const eventScope = { scope, pid, originalParsedEvents, parsedEvents: events.length, filteredEvents: events.length, excludedEvents: originalParsedEvents - events.length, availableProcessIds }
    if (pid != null && events.length === 0) return {
      ok: false, state: 'not-captured-for-target', etlPath: etl, etlBytes, xmlPath, xmlBytes, summaryPath,
      ...eventScope,
      error: '该 ETL 没有 PID ' + pid + ' 的 CLR runtime 事件；目标进程的 GC/停顿未知，不能解释为 0。',
    }
    const s = summarizeClr(events)
    const counts = new Map()
    for (const e of events) counts.set(e.kind, (counts.get(e.kind) || 0) + 1)
    const eventsByKind = [...counts.entries()]
      .map(([kind, n]) => ({ kind, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15)
    // ③ 与 ② 的分界：provider 在、但窗口内一条 GC/Start 都没有 —— 这是**真的没有 GC**，要说清楚。
    const noGcInWindow = s.gcCount === 0
    return {
      ok: true, state: 'clr-present', etlPath: etl, etlBytes, xmlPath, xmlBytes, summaryPath,
      clrRuntimeEvents: summary.clrRuntimeEvents, clrRundownEvents: summary.clrRundownEvents,
      ...eventScope, eventsByKind,
      noGcInWindow,
      ...s,
      note: (pid == null ? '统计范围：整份 ETL 中全部进程（machine-wide），未归因于目标客户端；停顿合计为各进程停顿之和，不是整机共同冻结时长。' : '统计范围：仅 PID ' + pid + '。')
        + '停顿按同一 PID 与 CLR 实例的 GC/SuspendEEStart → GC/RestartEEStop 配对；堆值来自该范围内最后一条 HeapStats，归属见 heapProcessId。'
        + (noGcInWindow
          ? '⚠ 本 etl **有 CLR provider 但窗口内 0 条 GC/Start** ⇒ 这是"这段窗口确实没发生 GC"（**与"没采"是两回事**）。'
          : ''),
    }
  }

  // ⚠ 曾经有过一个 `providerNameMap()`（`logman query providers` 反查 GUID→名字），**已删除**：
  //   真机实测内核那几个 GUID 在注册表里查不到，10 个 provider 全落成「(未收录)」——
  //   名字改从 tracerpt 摘要表的 Event Name 列取（etl 自己带的信息，更准也更省一次子进程）。
  //   留这段是因为"反查注册表"是个很自然会想再犯一次的念头。

  async function trace(args = {}) {
    const action = String(args.action || 'run').toLowerCase()
    const key = String(args.profile || 'cpu').toLowerCase()
    const profiles = CAPTURE_SETS[key]
    if (!profiles) return { ok: false, error: '未知 profile（可用 cpu | dotnet | general）' }
    // r48：`status` 只是读一个标记文件 —— 它**不该**被 wpr 存在性/管理员权限挡住
    //   （G1 的场景正是「没提权时想知道采样在不在跑」，那恰恰是最需要它的时候）。
    if (action !== 'status' && !existsSync(c.wpr)) return { ok: false, error: 'wpr.exe 不存在：' + c.wpr + '（可用 DSH_PERF_WPR 指定）' }
    if (action !== 'status' && !(await isElevated())) {
      return { ok: false, error: 'ETW 内核会话需要管理员权限，当前进程未提权 —— 请以管理员身份运行 DSH', needsElevation: true }
    }

    const dir = runDir(args.tag)
    const etl = args.etlPath || join(dir, 'trace.etl')
    // ⚠ 标记**固定在证据目录根**，不跟着 runDir 的时间戳漂移（否则 R1-04 的三个连环后果复现，见 traceSessionFile 注释）
    const sessionFile = traceSessionFile(c.evidenceDir)

    // r48：`status` —— G1 黑盒点名"start 之后无从确认采样在不在跑"（同族的 hang_*/api_capture_* 都有 status）。
    if (action === 'status') {
      let session = null
      try { session = JSON.parse(readFileSync(sessionFile, 'utf8')) } catch { session = null }
      const target = (session && session.etlPath) || etl
      let sizeBytes = null
      try { if (existsSync(target)) sizeBytes = statSync(target).size } catch { sizeBytes = null }
      // CLR 那条独立会话也一并报出来：它和内核会话是**两条**，一条在跑不代表另一条也在。
      const clrEtl = session && session.clrEtl ? String(session.clrEtl) : null
      let clrSizeBytes = null
      try { if (clrEtl && existsSync(clrEtl)) clrSizeBytes = statSync(clrEtl).size } catch { clrSizeBytes = null }
      return {
        ok: true, action: 'status',
        running: session !== null,            // ⚠ 这是**我们自己记的标记**，不是查 xperf 得到的（见下）
        runningBasis: 'start 时写的会话标记文件（<evidence>/trace-session.json），stop/cancel 时删除',
        elapsedMs: session && session.startedAt ? (Date.now() - Number(session.startedAt)) : null,
        etlPath: target, sizeBytes,
        profile: (session && session.profile) || null,
        clr: session && session.clrSession
          ? { session: session.clrSession, etlPath: clrEtl, sizeBytes: clrSizeBytes, basis: '会话标记' }
          : null,
        samplerProcessFound: samplerRunning(),  // true/false/**null=查不到**（null 不等于没在跑）
        hint: session
          ? '采样进行中（按标记）——复现完成后调 perf_trace(action="stop", etlPath="' + target + '") 停并产出 etl。'
          : (sizeBytes !== null
            ? '没有进行中的采样（按标记）。最近这份 etl 已存在（' + sizeBytes + ' 字节）——要重采就 action="start" 或 "run"。'
            : '没有进行中的采样（按标记），也没有找到 etl。'),
      }
    }

    if (action === 'stop' || action === 'cancel') {
      // ★ R1-14：**先读标记、再决定拿谁收尾**（xperf 起的采样不能拿 wpr 去停）。
      //   老标记没有 engine 字段 ⇒ 按 'wpr' 读 —— 与 R1-14 之前的行为逐字一致（零回归）。
      let session0 = null
      try { session0 = JSON.parse(readFileSync(sessionFile, 'utf8')) } catch { session0 = null }
      const engine = (session0 && session0.engine === 'xperf') ? 'xperf' : 'wpr'
      const rawEtlPath = session0 && session0.rawPath ? String(session0.rawPath) : null
      const cancelOnly = action === 'cancel'
      // ★ CLR 会话**必须在这里就停**：stop 分支后面有 6 条早返回（合并失败 / 收尾坏 / 没产出 etl …），
      //   任何一条漏停都会留下一个**一直在写 etl 的 logman 孤儿会话** —— 而 ETW 会话在运行中
      //   不会自己收尾（同族的 F-056/R1-02：跟踪日志运行中不自动轮转），孤儿会话会一直吃盘。
      //   CLR etl 路径是**确定的**（dirname(etl)/clr-events.etl），所以即使标记丢了也找得回来。
      const clrFixed = join(dirname(etl), 'clr-events.etl')
      const clrEtlPath = session0 && session0.clrEtl
        ? String(session0.clrEtl)
        : (existsSync(clrFixed) ? clrFixed : null)
      const clrStop = (session0 && session0.clrSession) ? await clrSessionStop() : null
      const clrFields = clrEtlPath ? { clrEtlPath, ...(clrStop ? { clrStop } : {}) } : {}
      // start 时若 CLR 会话没起来，警告在这里**补回来**（`action="run"` 只看得到最终结果）。
      if (session0 && session0.clrWarning && !clrFields.clrWarning) clrFields.clrWarning = session0.clrWarning
      // ★ JIT/rundown 会话同理**必须在这里就停**（否则同样留孤儿会话）；DCEnd 就在这一停里吐出方法记录。
      //   路径确定为 dirname(etl)/jit-methods.etl ⇒ 标记丢了也找得回。
      const jitFixed = join(dirname(etl), 'jit-methods.etl')
      const jitEtlPath = session0 && session0.jitEtl
        ? String(session0.jitEtl)
        : (existsSync(jitFixed) ? jitFixed : null)
      const jitStop = (session0 && session0.jitSession) ? await jitSessionStop() : null
      const jitFields = jitEtlPath ? { jitEtlPath, ...(jitStop ? { jitStop } : {}) } : {}
      if (session0 && session0.jitWarning && !jitFields.jitWarning) jitFields.jitWarning = session0.jitWarning
      // ★ 分配会话（xperf 用户会话）同样必须在这里停；-d 合并成带模块归属的 alloc-events.etl（否则孤儿会话吃盘）。
      const allocMerged = join(dirname(etl), 'alloc-events.etl')
      const allocStop = (session0 && session0.allocSession) ? await allocSessionStop(allocMerged) : null
      const allocEtlPath = existsSync(allocMerged) ? allocMerged : null
      const allocFields = allocEtlPath ? { allocEtlPath, ...(allocStop ? { allocStop } : {}) } : {}
      if (session0 && session0.allocWarning && !allocFields.allocWarning) allocFields.allocWarning = session0.allocWarning
      let r = null
      let mergeRun = null
      if (engine === 'xperf') {
        r = await runExe(c.xperf, ['-stop'], { timeoutMs: 300000 })
        // ★ R1-14（2026-09-15 实测）：**合并这一步不能省**。`xperf -help symbols` 原文：
        //   "For symbol decoding, the trace must be ... stopped and merged with -d or merged with -merge
        //    ... [xperf performs a special image identification process during its custom trace merge.]"
        //   实测对比（同机、同符号路径）：未合并 ⇒ 报告 155 KB / 1 个热点函数（全 ***unknown***、**0 个模块名**）；
        //   合并后 ⇒ 13.4 MB / 8249 个热点函数 / 193 个模块 / 真名（`ntkrnlmp.exe!SwapContext` 这种）。
        if (!cancelOnly && rawEtlPath && existsSync(rawEtlPath) && !existsSync(etl)) {
          mergeRun = await runExe(c.xperf, ['-merge', rawEtlPath, etl], { timeoutMs: 900000 })
        }
      } else {
        r = await runExe(c.wpr, cancelOnly ? ['-cancel'] : ['-stop', etl], { timeoutMs: 300000 })
      }
      try { rmSync(sessionFile, { force: true }) } catch { /* 标记删不掉不影响停止结果 */ }
      // 兼容 R1-04 修复前写下的**孤儿标记**（在 trace-<stamp>/ 里）：只删属于本次这份 etl 的那个，
      // 免得误删另一次会话（虽然按新契约不该再有第二个位置，但盘上确实可能还留着旧的）。
      try {
        const legacy = join(dirname(etl), 'trace-session.json')
        const s = JSON.parse(readFileSync(legacy, 'utf8'))
        if (s && String(s.etlPath || '').toLowerCase() === String(etl).toLowerCase()) rmSync(legacy, { force: true })
      } catch { /* 没有孤儿标记 / 不属于本次：都不动 */ }
      if (cancelOnly) {
        return { ok: Boolean(r) && r.code === 0, cancelled: true, engine, ...clrFields, raw: (r ? (r.stdout + r.stderr) : '').slice(0, 400) }
      }
      if (!existsSync(etl)) {
        const rTxt = r ? (r.stdout + r.stderr) : ''
        // ── xperf 通道：**采到了、但合并没成** —— 这是"可救"的一类，必须与"整个没采到"分开说，
        //    否则调用方会把"没合并 ⇒ 报告没有模块归属"读成"客户端没有热点"。
        if (engine === 'xperf' && rawEtlPath && existsSync(rawEtlPath)) {
          return {
            ok: false, engine, ...clrFields,
            error: '**已采到原始 etl，但 `xperf -merge` 没产出合并文件**' +
              '⇒ 直接拿原始 etl 出报告会**一个模块名都没有**（不是"没有热点"）。',
            rawPath: rawEtlPath,
            raw: ((mergeRun ? (mergeRun.stdout + mergeRun.stderr) : '') + rTxt).slice(0, 500),
            hint: '原始 etl 保留着：可手工 `xperf -merge "' + rawEtlPath + '" "' + etl + '"` 合并后再出报告。',
          }
        }
        // ★ R1-12 / R1-14：`wpr -stop` 失败时把"能认出来的签名"翻成人话，并**回带实测退出码**：
        //   R1-12 那版文案硬写着"退出码 0"，而 2026-09-15 实测是 `-2147417850`(=0x80010106) —— 工具不该替 wpr 断言它退了几。
        const sig = /0x80010106|Cannot change thread mode/i.test(rTxt) ? 'RPC_E_CHANGED_MODE(0x80010106)' : null
        const exitCode = r ? r.code : null
        let cleanup = null
        try { const cr = await runExe(c.wpr, ['-cancel'], { timeoutMs: 60000 }); cleanup = (cr.stdout + cr.stderr).trim().slice(0, 200) } catch { /* ignore */ }
        return {
          ok: false, engine, ...clrFields,
          error: '停止后未生成 etl' + (sig
            ? '（**这台机器的 WPR 收尾坏了**：' + sig + '，wpr -stop 实测退出码 ' + exitCode + '，不产出文件）'
            : (exitCode === null ? '' : '（wpr -stop 退出码 ' + exitCode + '）')),
          raw: rTxt.slice(0, 500),
          ...(sig ? {
            diagnosis: '**采集通道失败，不是"这次没问题"**：`wpr -start` 正常、`wpr -stop` 收不了尾 ⇒ 本次采样没有 etl。' +
              '已确认这不是"工具开两个预设"造成的（单预设 `wpr -start CPU -filemode` 也复现同一错误）。',
            nextSteps: [
              '① **换 xperf 通道重采**：perf_trace(action="start", engine="xperf") —— 它不依赖 WPR 收尾（R1-14 已实现，收尾时会自动 `-merge`）；',
              '② 重启机器（通常能恢复 WPR 的收尾能力），再 action="start" 前会自检 —— 自检不过就别开始采样；',
              '③ 别把这次失败读成"这段时间客户端没有热点"。',
            ],
          } : {}),
          cleanedUp: cleanup,
        }
      }
      const size = statSync(etl).size
      let clrEtlBytes = null
      if (clrEtlPath && existsSync(clrEtlPath)) { try { clrEtlBytes = statSync(clrEtlPath).size } catch { clrEtlBytes = null } }
      let jitEtlBytes = null
      if (jitEtlPath && existsSync(jitEtlPath)) { try { jitEtlBytes = statSync(jitEtlPath).size } catch { jitEtlBytes = null } }
      return {
        ok: true, etlPath: etl, sizeBytes: size, profile: key, profiles, engine,
        ...(engine === 'xperf' && rawEtlPath ? { rawPath: rawEtlPath } : {}),
        ...clrFields,
        ...(clrEtlPath ? { clrEtlBytes } : {}),
        ...jitFields,
        ...(jitEtlPath ? { jitEtlBytes } : {}),
        ...allocFields,
        hint: '下一步用 perf_hotstacks(etlPath) 出调用链；可加 focus 只保留包含某模块/函数名的栈' +
          (allocEtlPath ? '\n本次带了分配采样会话 ⇒ `perf_allocflame(etlPath="' + allocEtlPath + '")` 出「谁在分配」的分配火焰图（按字节加权）。' : '') +
          (engine === 'xperf' ? '（本次走 xperf 通道，收尾已做 `-merge`：**模块归属只在合并时产生**，省了这步报告会全是 ***unknown***）' : '') +
          (jitEtlPath
            ? '\n本次带了 JIT 会话 ⇒ `perf_flame(etlPath="' + etl + '")` 会**自动**用同目录的 jit-methods.etl 把客户端方法名解出来（§4）' +
              (jitEtlBytes === 0 ? '（⚠ 该 etl **是 0 字节**：JIT 会话没写进东西 —— 客户端方法名会解不出，别读成"没有客户端代码"）' : '')
            : '') +
          (clrEtlPath
            ? '\n本次带了 CLR 会话 ⇒ 另有 `perf_clrevents(etlPath="' + clrEtlPath + '")` 可出 GC 停顿/各代/堆/争用；' +
              (clrEtlBytes === null ? '（该 etl 现在读不到大小，注意它可能没产出）'
                : clrEtlBytes === 0 ? '（⚠ 该 etl **是 0 字节**：CLR 会话没写进东西 —— 别把"没有 GC 数据"读成"没有 GC"）'
                : '（' + clrEtlBytes + ' 字节）')
            : ''),
      }
    }

    // start / run
    mkdirSync(dir, { recursive: true })
    // ★ R1-14：**通道选择**。engine=auto（默认）时，采集前自检（R1-12）的结论**同时**用来路由：
    //   自检说"WPR 收不了尾"（本机就是这样）⇒ 直接走 xperf，不再让调用方白跑一轮复现。
    //   自检本身仍是"只报告、不拦人"，只是 auto 会拿它的结论做路由。
    const engineArg = String(args.engine || 'auto').toLowerCase()
    if (!['auto', 'wpr', 'xperf'].includes(engineArg)) {
      return { ok: false, error: '未知 engine（可用 auto | wpr | xperf）' }
    }
    const preflight = args.skipPreflight === true ? null : await probeWprStop()
    const engine = engineArg === 'auto'
      ? ((preflight && preflight.ok === false) ? 'xperf' : 'wpr')
      : engineArg
    if (engine === 'xperf' && !existsSync(c.xperf)) {
      return {
        ok: false, engine,
        error: 'xperf.exe 不存在：' + c.xperf + '（可用 DSH_PERF_XPERF 指定；engine=auto 时"WPR 收尾坏了"会路由到这里）',
        ...(preflight ? { preflight } : {}),
      }
    }
    // xperf 通道的中间产物：`-f` 写的是**未合并**的原始 etl，合并要在 stop 时另做一步（模块归属全靠那一步）。
    const rawEtl = join(dir, 'trace-raw.etl')
    let preflightWarning = null
    if (preflight && !preflight.ok) {
      preflightWarning = engine === 'xperf'
        ? '⚠ **采集前自检不通过**：这台机器的 `wpr -stop` **收不了尾**' +
          (preflight.signature ? '（' + preflight.signature + '）' : '') +
          // ⚠ 别一律写"已自动改用"：显式传 engine="xperf" 时**没人自动改**，是调用方自己指定的
          //   （r61 真机 E2E 抓到这句：我显式传了 xperf，输出却说"（engine=auto）已自动改用"）。
          (engineArg === 'auto'
            ? ' ⇒ **本次已自动改用 xperf 通道**（engine=auto 路由的结果）。'
            : ' ⇒ 本次是**调用方显式指定** engine="xperf"（自检结论只作旁证，不是它改的通道）。') +
          '收尾时会自动 `xperf -merge` —— **模块归属只在合并那一步产生**（不合并的报告连模块名都没有）。' +
          '（自检只花 ' + preflight.elapsedMs + 'ms；要强制走 WPR 就传 engine="wpr"）'
        : '⚠ **采集前自检不通过**：这台机器的 `wpr -stop` **收不了尾**' +
          (preflight.signature ? '（' + preflight.signature + '）' : '') +
          '，会**不产出 etl** ⇒ **这次采样很可能白跑一轮复现**。' +
          '建议：① 换通道（`engine="xperf"`，本机实测可用）或先修 WPR（重启机器通常能恢复）；' +
          '② 复现后 `action="stop"` 会如实报结果（含实测退出码）。' +
          '（自检本身只花 ' + preflight.elapsedMs + 'ms；`skipPreflight: true` 可跳过）'
    }
    let started
    if (engine === 'xperf') {
      // PROC_THREAD+LOADER 是"镜像事件"的来源（LOADER 原文：Kernel and user mode Image Load/Unload events），
      //   PROFILE 是采样，CSWITCH 让调用链能连起来；-stackwalk 必须显式给，否则只有采样点、没有栈。
      started = await runExe(c.xperf, [
        '-on', 'PROC_THREAD+LOADER+PROFILE+CSWITCH',
        '-stackwalk', 'PROFILE+CSWITCH',
        '-f', rawEtl,
      ], { timeoutMs: 180000 })
    } else {
      // 多个预设用多个 -start 串联（实测：只开 CPU 时托管帧**函数名解不出来**，必须带上 DotNet 才有 CLR rundown）
      const startArgs = []
      for (const p of profiles) startArgs.push('-start', p)
      startArgs.push('-filemode')
      started = await runExe(c.wpr, startArgs, { timeoutMs: 180000 })
    }
    if (started.code !== 0) {
      return { ok: false, engine, error: engine + ' -start 失败', raw: (started.stdout + started.stderr).slice(0, 500), profiles, ...(preflight ? { preflight } : {}) }
    }
    // CLR 会话（`clr=true`，默认关）。
    // ★ 它**失败不推翻**主采集：内核那条已经采上了，为了一个附加会话把整次采样判失败，
    //   只会让调用方白跑一轮复现。失败如实带 clrWarning，并明确写出「没有 GC 数据 ≠ 没有 GC 停顿」。
    let clr = null
    let clrWarning = null
    if (args.clr === true) {
      const clrEtl = join(dir, 'clr-events.etl')
      clr = await clrSessionStart(clrEtl)
      if (!clr.ok) {
        clrWarning = '⚠ **CLR 会话没起来**（' + (clr.exitCode === null ? '未拿到退出码' : 'logman 退出码 ' + clr.exitCode) + '）：' +
          (clr.raw || '(logman 无输出)') +
          '\n⇒ 本次**没有 GC 数据** —— 那是「没采」，**不是「客户端没有 GC 停顿」**。' +
          '内核会话不受影响，perf_hotstacks 照常可用。'
      }
    }
    // JIT/rundown 会话（`jit=true`，默认关）—— 给 perf_flame 的 §4 地址→方法映射供数据。
    // ★ 同 CLR：失败不推翻主采集；DCEnd 在 stop 才吐 ⇒ 采样窗口内低污染（见 jitSessionStart 注释）。
    let jit = null
    let jitWarning = null
    if (args.jit === true) {
      const jitEtl = join(dir, 'jit-methods.etl')
      jit = await jitSessionStart(jitEtl)
      if (!jit.ok) {
        jitWarning = '⚠ **JIT/rundown 会话没起来**（' + (jit.exitCode === null ? '未拿到退出码' : 'logman 退出码 ' + jit.exitCode) + '）：' +
          (jit.raw || '(logman 无输出)') +
          '\n⇒ 本次**没有方法映射** —— perf_flame 里客户端自己的方法会解不出（聚成 [unknown]），' +
          '那是「没采映射」，**不是「没有客户端代码在跑」**。内核采样不受影响。'
      }
    }
    // 分配采样会话（`alloc=true`，默认关）—— 给 perf_allocflame 供数据（AllocationTick + 栈）。
    // ★ 同 CLR/JIT：失败不推翻主采集。它是 xperf **命名用户会话**，与内核会话并存。
    let alloc = null
    let allocWarning = null
    if (args.alloc === true) {
      const allocRaw = join(dir, 'alloc-events-raw.etl')
      alloc = await allocSessionStart(allocRaw)
      if (!alloc.ok) {
        allocWarning = '⚠ **分配采样会话没起来**（xperf 退出码 ' + (alloc.exitCode === null ? '未知' : alloc.exitCode) + '）：' +
          (alloc.raw || '(xperf 无输出)') +
          '\n⇒ 本次**没有分配栈** —— perf_allocflame 无数据。那是「没采」，**不是「没有分配」**。内核采样不受影响。'
      }
    }
    // start 成功后落一个会话标记（status 靠它；stop/cancel 清掉）。
    // 写**证据目录根**下的固定路径 —— 与 evidence-clean.mjs 的读者端对齐（R1-04）。
    // ★ R1-14：标记里**必须记 engine**（stop 靠它决定找谁收尾）+ xperf 的原始 etl 路径（合并要用）。
    // ★ CLR 同理：标记里记下会话名与 etl，stop 才能把它停掉（否则留下一直在写盘的孤儿会话）。
    try {
      writeFileSync(sessionFile, JSON.stringify({
        etlPath: etl, startedAt: Date.now(), profile: key, tag: args.tag || null, dir, engine,
        ...(engine === 'xperf' ? { rawPath: rawEtl } : {}),
        ...(clr && clr.ok ? { clrSession: clr.session, clrEtl: clr.etlPath } : {}),
        // ★ clrWarning 也要进标记：`action="run"` 是**一次性**调用，用户只读得到最后一个结果 ——
        //   警告只挂在 start 的返回值上，那种调用就看 **不到** CLR 会话起不来这件事（真机 e2e 抓到）。
        ...(clrWarning ? { clrWarning } : {}),
        ...(jit && jit.ok ? { jitSession: jit.session, jitEtl: jit.etlPath } : {}),
        ...(jitWarning ? { jitWarning } : {}),
        ...(alloc && alloc.ok ? { allocSession: alloc.session, allocRaw: alloc.etlPath } : {}),
        ...(allocWarning ? { allocWarning } : {}),
      }), 'utf8')
    } catch { /* 标记写不进去要在 status 里如实体现 */ }
    if (action === 'start') {
      return {
        ok: true, started: true, profile: key, profiles, etlPath: etl, engine,
        ...(engine === 'xperf' ? { rawPath: rawEtl, captureArgs: 'xperf -on PROC_THREAD+LOADER+PROFILE+CSWITCH -stackwalk PROFILE+CSWITCH' } : {}),
        ...(preflight ? { preflight } : {}),
        ...(clr ? { clr: { ok: clr.ok, session: clr.session, etlPath: clr.etlPath, exitCode: clr.exitCode, command: clr.command }, clrEtlPath: clr.etlPath } : {}),
        ...(jit ? { jit: { ok: jit.ok, session: jit.session, etlPath: jit.etlPath, exitCode: jit.exitCode, command: jit.command }, jitEtlPath: jit.etlPath } : {}),
        ...(alloc ? { alloc: { ok: alloc.ok, session: alloc.session, etlPath: alloc.etlPath, exitCode: alloc.exitCode, command: alloc.command } } : {}),
        ...(preflightWarning ? { warning: preflightWarning } : {}),
        ...(clrWarning ? { clrWarning } : {}),
        ...(jitWarning ? { jitWarning } : {}),
        ...(allocWarning ? { allocWarning } : {}),
        hint: '复现问题后调用 perf_trace(action="stop", etlPath="' + etl + '")；期间可用 perf_trace(action="status") 确认采样还在跑（按标记文件判断）。' +
          (clr && clr.ok ? '\nCLR 会话已并行起来（' + clr.etlPath + '）⇒ 停完用 perf_clrevents 出 GC 停顿/各代/堆/争用。' : '') +
          (jit && jit.ok ? '\nJIT/rundown 会话已并行起来（' + jit.etlPath + '）⇒ 停完 perf_flame 会自动用它解客户端方法名（§4）。' : '') +
          (alloc && alloc.ok ? '\n分配采样会话已并行起来 ⇒ 停完用 perf_allocflame 出「谁在分配」的分配火焰图。' : '') +
          (preflightWarning ? '\n' + preflightWarning : '') +
          (clrWarning ? '\n' + clrWarning : '') +
          (jitWarning ? '\n' + jitWarning : '') +
          (allocWarning ? '\n' + allocWarning : ''),
      }
    }
    const seconds = Math.min(Math.max(Number(args.seconds) || 20, 3), 600)
    await new Promise((r) => setTimeout(r, seconds * 1000))
    // ★ R1-14：`run` **复用 stop 分支**（含 xperf 的 `-merge`）—— 免得两条路各写一份、日后漂移。
    return { ...(await trace({ action: 'stop', etlPath: etl, tag: args.tag })), seconds, engine }
  }

  /**
   * 符号缓存的**共享**位置。
   *
   * ⚠️ 端到端实测踩到的第四个坑（2026-09-11）：符号缓存原先挂在 `runDir()` 下，
   * 而 `runDir()` 每次运行都带新的时间戳 —— 于是**第二次、第三次分析同一台机器上
   * 同一批系统 DLL 时，符号全部从头再下一遍**。实测现场：第一次运行已在
   * `.../e2e/symbols` 里存了 **1.15 GB** 的 pdb+symcache，第二次运行却开在
   * `.../e2e2/symbols` 里从零下载，xperf 长时间 0% CPU 卡在公网符号服务器上。
   *
   * 缓存必须**跨运行共享**才有意义，所以放在 evidenceDir 根下的固定目录
   * （而不是每次新建的 trace-<时间戳> 目录里；也和 perf-evidence 的
   * "按秒建目录、无轮转" 脱钩，避免被证据清理顺手删掉）。
   * 可用 DSH_PERF_SYMBOL_CACHE 覆盖。
   */
  function symbolCacheDir(sub) {
    const root = c.symbolCacheDir || join(c.evidenceDir, 'symbol-cache')
    const p = join(root, sub)
    try { mkdirSync(p, { recursive: true }) } catch { /* ignore */ }
    return p
  }

  /** 默认公网符号链（带**共享**本地缓存）。 */
  function defaultSymbolPath() {
    return 'srv*' + symbolCacheDir('symbols') + '*https://msdl.microsoft.com/download/symbols'
  }

  /** 生效的符号路径 + 是否"被我们接过"（供结果如实上报，见 composeSymbolPath）。 */
  function symbolPathInfo(offline) {
    if (offline) return { offline: true, configured: c.symbolPath || '', effective: null, composed: false, configuredFrom: configuredFrom() }
    const composed = composeSymbolPath(c.symbolPath, defaultSymbolPath())
    return { offline: false, configured: c.symbolPath || '', effective: composed.value, composed: composed.composed, configuredFrom: configuredFrom() }
  }

  /**
   * 这个符号路径**是从哪儿来的**：显式配的 `DSH_PERF_SYMBOL_PATH`，还是机器既有的 `_NT_SYMBOL_PATH`。
   * 为什么必须区分（Codex r37 第 4 条）：提示语里点名 `DSH_PERF_SYMBOL_PATH` 会让人去找一个**他没设过**的变量。
   */
  function configuredFrom() {
    if (!c.symbolPath) return null
    if (String(envOr('DSH_PERF_SYMBOL_PATH') || '') === String(c.symbolPath)) return 'DSH_PERF_SYMBOL_PATH'
    if (String(process.env._NT_SYMBOL_PATH || '') === String(c.symbolPath)) return '_NT_SYMBOL_PATH'
    return 'argument' // makeTrace 的注入（测试/探针脚本）
  }

  /** 符号路径：显式配置 > 机器已有的 _NT_SYMBOL_PATH > 默认微软公网符号（带**共享**本地缓存）。 */
  function symbolEnv(offline) {
    const env = Object.assign({}, process.env)
    if (offline) { delete env._NT_SYMBOL_PATH; return env }
    env._NT_SYMBOL_PATH = symbolPathInfo(false).effective
    // symcache：xperf 的符号缓存（第二次出报告会快很多）—— 同样必须跨运行共享，
    // 否则"第二次快"这句话只在同一条 trace 目录里成立，换个 tag 就失效。
    if (!env._NT_SYMCACHE_PATH) {
      env._NT_SYMCACHE_PATH = symbolCacheDir('symcache')
    }
    return env
  }

  /**
   * 从 etl 出调用链。
   * @param args.etlPath   perf_trace 产出的 .etl
   * @param args.focus     只看名字匹配该正则的函数（映射到 xperf -symbol）
   * @param args.process   只看该进程名（正则，映射到 xperf -process）
   * @param args.topN      排行取前 N（默认 15）
   * @param args.minHits   蝶形视图最小命中数（默认 5）
   * @param args.offline   true = 不配符号服务器（快，但原生帧多为 unknown）
   * @param args.debugSymbols true = 让 xperf 打印符号查找细节（卡在符号服务器时用来定位）
   */
  async function hotstacks(args = {}) {
    const etl = args.etlPath
    if (!etl || !existsSync(etl)) return { ok: false, error: 'etlPath 不存在：' + String(etl) }
    if (!existsSync(c.xperf)) return { ok: false, error: 'xperf.exe 不存在：' + c.xperf + '（可用 DSH_PERF_XPERF 指定）' }
    const topN = Math.min(Math.max(Number(args.topN) || 15, 1), 200)
    const minHits = Math.min(Math.max(Number(args.minHits) || 5, 1), 10000)
    const outHtml = args.outPath || join(join(etl, '..'), 'hotstacks.html')

    // ⚠️ 关键：**必须显式带 `-symbols`**。xperf 的帮助原文是
    //   "If action symbols is not specified on the command line, symbol decoding is disabled."
    // 漏了它，报告里全是 ***unknown***（我们实测踩过：不加时 2 秒出报告且全 unknown，
    // 加了之后 35 秒（含下载符号）并解出 ntdll.dll!RtlUserThreadStart 这类真实函数名）。
    const cmd = []
    if (!args.offline) {
      cmd.push('-symbols')
      // ⚠️ 端到端实测踩到的第五个坑：xperf 会**静默卡在公网符号服务器**上
      // （实测 0% CPU、无 stdout、报告 0 字节，一卡十几分钟，看不出它在等网络）。
      // -symbols verbose 会把符号配置/查找过程打到 stdout，卡住时至少知道卡在哪。
      // 注意：必须在 push('-symbols') 之后单独 push，别改成 push('-symbols','verbose')，
      // 否则既有的源码级护栏断言（/cmd\.push\('-symbols'\)/）就失配了。
      if (args.debugSymbols) cmd.push('verbose')
    }
    const eventScope = 'Sampled Profile'
    cmd.push('-i', etl, '-o', outHtml, '-a', 'stack', '-butterfly', String(minHits), '-event', eventScope)
    if (args.process || c.procName) cmd.push('-process', String(args.process || c.procName))
    if (args.focus) cmd.push('-symbol', String(args.focus))
    const t0 = Date.now()
    const r = await runExe(c.xperf, cmd, { timeoutMs: Number(args.timeoutMs) || 900000, env: symbolEnv(!!args.offline) })
    // ★ xperf 的原始输出在**这里就**算好，后面**每一条**返回（超时 / 无报告 / 空报告 / 成功）都带上它。
    //   第一版只在最终成功返回上带 —— 而那三条失败路径恰恰是最需要看 xperf 原话的（F-044 的完整修法）。
    const rawInfo = trimXperfRaw(r.stdout + '\n' + r.stderr, { symbolOnly: !!args.debugSymbols })
    const rawFields = {
      xperfRaw: rawInfo.raw, xperfRawBytes: rawInfo.rawBytes, xperfRawChars: rawInfo.rawChars,
      xperfRawTruncated: rawInfo.xperfRawTruncated === undefined ? rawInfo.rawTruncated : rawInfo.rawTruncated,
      xperfRawFiltered: rawInfo.rawFiltered,
      xperfRawNote: 'xperfRaw 是 xperf 的原始输出（可能按符号相关行过滤过，见 xperfRawFiltered）；' +
        'xperfRawBytes 是**原始输出的总字节数**（不是这段留出来的长度）。',
    }
    // 端到端实测踩到的假成功：xperf 被超时杀掉后仍留了一个**空报告文件**，
    // 原实现只看"文件是否存在"就报 ok:true，返回一个空结果 —— 调用方会以为"没有热点"。
    if (r.timedOut) {
      // xperf 被超时杀掉后会在 outHtml 留下一个 **0 字节报告**。留着它是个陷阱：
      // 下一次有人（或另一个 agent）看到"报告文件在"就以为有结果。既然它是空的，就删掉。
      let leftoverBytes = null
      try {
        if (existsSync(outHtml)) {
          leftoverBytes = statSync(outHtml).size
          if (leftoverBytes === 0) rmSync(outHtml, { force: true })
        }
      } catch { /* ignore */ }
      return Object.assign({
        ok: false, timedOut: true, etlPath: etl, reportPath: leftoverBytes ? outHtml : null,
        symbolCacheDir: !args.offline ? join(c.symbolCacheDir || join(c.evidenceDir, 'symbol-cache'), 'symbols') : null,
        raw: (r.stdout + '\n' + r.stderr).trim().slice(0, 400),
        error: 'xperf 出报告超时（' + (Date.now() - t0) + 'ms）。系统级 trace 很慢，建议：① 加 process 过滤（只分析目标进程）；' +
          '② 用 focus 缩小 -symbol 范围；③ 调大 timeoutMs；④ 该 etl 是否过大（可用更短采集时长重采）',
        hint: '若超时发生在符号解码阶段（症状：xperf 长时间 ~0% CPU、报告一直 0 字节），多半是公网符号服务器慢或被挡 —— ' +
          '符号缓存会跨运行共享（见 symbolCacheDir），同一个 etl 重跑一次通常就快很多；也可用 offline:true 先只拿原生帧。',
      }, rawFields)
    }
    if (!existsSync(outHtml)) {
      const rawTxt = (r.stdout + '\n' + r.stderr).trim()
      const diag = diagnoseXperfFailure(r.code, rawTxt, 0)
      return Object.assign({
        ok: false,
        etlPath: etl,
        error: 'xperf 未产出报告' + (diag.diagnosis ? '：' + diag.diagnosis : ''),
        xperfExit: diag.exitCode,
        eventsLost: diag.eventsLost,
        raw: rawTxt.slice(0, 800),
      }, rawFields)
    }
    const html = readFileSync(outHtml, 'utf8')
    const parsed = parseStackReport(html)
    parsed.__etl = etl
    const s = summarize(parsed, { topN, focus: args.focus })
    const symInfo = symbolPathInfo(!!args.offline)
    const symFields = {
      symbolPath: symInfo.effective,
      // composed=true 不是内部细节：它意味着"你配的那个路径**被我们接上了**公网符号链"，
      // 必须转达给用户，否则他会以为 `_NT_SYMBOL_PATH` 就是自己写的那一串。
      symbolPathComposed: symInfo.composed,
      symbolPathNote: symInfo.composed
        ? '你把符号路径配成了一个**没有符号服务器指令**的值（没有 `srv*`），已**替你接上**默认公网链 —— ' +
          '因为 `_NT_SYMBOL_PATH` 是**整串替换**语义：只写目录的话，系统 DLL 的符号会全部解析不出来（实测如此）。' +
          '生效值见 symbolPath。想"只用本地符号"就把 `srv*` 自己写进去（写了就原样使用，我们不再动它）。' +
          (symInfo.configuredFrom === '_NT_SYMBOL_PATH'
            ? '（注：这个值来自机器既有的 `_NT_SYMBOL_PATH`，不是你显式配的 `DSH_PERF_SYMBOL_PATH`。）'
            : '')
        : null,
    }
    if (!s.hotCount && !s.chainCount) {
      // 空报告 = 失败，不是"没有热点"（没读到 ≠ 没有）
      const reportBytes = statSync(outHtml).size
      const rawTxt = (r.stdout + '\n' + r.stderr).trim()
      const diag = diagnoseXperfFailure(r.code, rawTxt, reportBytes)
      return Object.assign({
        ok: false, etlPath: etl, reportPath: outHtml, reportBytes,
        xperfExit: diag.exitCode, eventsLost: diag.eventsLost,
        error: '报告里没有可解析的函数条目 —— 不要当成"没有热点"。'
          + (diag.diagnosis
            ? diag.diagnosis
            : '可能原因：符号未解析（确认已装符号/网络可达）、focus 过滤太严、xperf 输出为空。可先去掉 focus 重跑一次看有没有内容。')
          + '（xperf 原文尾部：' + diag.tail.slice(-260) + '）',
        raw: rawTxt.slice(0, 800),
        text: s.text,
      }, s)
    }
    return Object.assign({
      ok: true, etlPath: etl, reportPath: outHtml, reportBytes: statSync(outHtml).size,
      focus: args.focus || null, process: args.process || c.procName || null,
      eventScope, metric: 'stack-sample-count',
      symbols: !args.offline, elapsedMs: Date.now() - t0,
      symbolCacheDir: !args.offline ? join(c.symbolCacheDir || join(c.evidenceDir, 'symbol-cache'), 'symbols') : null,
      xperfRaw: rawInfo.raw, xperfRawBytes: rawInfo.rawBytes,
      xperfRawTruncated: rawInfo.rawTruncated, xperfRawFiltered: rawInfo.rawFiltered,
    }, symFields, s)
  }

  /**
   * 从 etl 出**火焰图**（folded stacks + 自包含可交互 HTML）。
   *
   * 与 hotstacks 的分工：hotstacks 给「谁最热 + 蝶形（调用者/被调用者对）」的**文本**；
   * flame 给「从根到叶的一整棵 CPU 时间树」的**可点开图**（补 PerfView §1 那条"交互式 GUI"）。
   * 走的是 `xperf -a dumper`（逐样本 + Stack 事件含完整帧），流式折叠、按进程过滤（见 flame.mjs 顶部）。
   *
   * @param args.etlPath   perf_trace 产出的 .etl（必填）
   * @param args.process   只折叠该进程名（正则，默认 DSH_UI_PROC_NAME）
   * @param args.symbols   true = dumper 带 -symbols 解析原生/框架帧（慢、走符号服务器）；默认 false = 模块级（快）
   * @param args.csvPath   复用一份已生成的 dumper CSV（跳过重新解码，省几分钟 + 省 GB 级重复落盘）
   * @param args.keepCsv   true = 折叠后保留那份 GB 级 dumper CSV（默认删掉，folded/html 已落好）
   * @param args.jitEtl    CLR 方法/rundown 会话产出的 etl（perf_trace(jit=true) 的 jit-methods.etl）。
   *                       传了（或自动发现 kernel etl 旁的同名文件）就把客户端 JIT 帧解成**真实托管方法名**（§4）。
   * @param args.noJit     true = 即便旁边有 jit-methods.etl 也不用（只要模块级火焰图）
   * @param args.timeoutMs dumper 解码超时（默认 900000）
   */
  async function flame(args = {}) {
    const etl = args.etlPath
    if (!etl || !existsSync(etl)) return { ok: false, error: 'etlPath 不存在：' + String(etl) }
    if (!existsSync(c.xperf)) return { ok: false, error: 'xperf.exe 不存在：' + c.xperf + '（可用 DSH_PERF_XPERF 指定）' }
    const proc = String(args.process || c.procName || '').trim()
    if (!proc) {
      return { ok: false, error: '没有目标进程名：请传 process，或配 DSH_UI_PROC_NAME。' +
        '火焰图**必须按进程折叠** —— 不然会把整机所有进程的栈混成一锅（dumper 是系统级的）。' }
    }
    let processRe
    try { processRe = new RegExp(proc, 'i') } catch { return { ok: false, error: 'process 不是合法正则：' + proc } }
    const symbols = args.symbols === true
    const frameMode = symbols ? 'symbols' : 'module'
    const dir = dirname(etl)
    const csv = args.csvPath || join(dir, 'flame-dumper.csv')
    const reusing = Boolean(args.csvPath) && existsSync(csv)

    // ── JIT 映射（§4）：把客户端自己的 `"Unknown"!0xADDR` JIT 帧解成真实托管方法名。
    //    默认自动发现 kernel etl 旁的 jit-methods.etl（perf_trace(jit=true) 的产出）；noJit 可关。
    let jitMap = null
    let jitInfo = null
    const jitEtl = args.noJit === true ? null : (args.jitEtl || (existsSync(join(dir, 'jit-methods.etl')) ? join(dir, 'jit-methods.etl') : null))
    if (jitEtl) {
      const decoded = await jitMapFromEtl(jitEtl, { timeoutMs: Number(args.timeoutMs) || 900000, processRe })
      jitInfo = decoded.info
      if (decoded.ok) jitMap = decoded.map
    }

    const t0 = Date.now()
    let dumperMs = null
    if (!reusing) {
      // dumper 会把 etl 里的原始事件逐条打出来（含每帧一行的 Stack 事件）。symbols=true 才连符号服务器。
      const cmd = []
      if (symbols) cmd.push('-symbols')
      cmd.push('-i', etl, '-o', csv, '-a', 'dumper')
      const r = await runExe(c.xperf, cmd, { timeoutMs: Number(args.timeoutMs) || 900000, env: symbolEnv(!symbols) })
      dumperMs = Date.now() - t0
      if (r.timedOut) {
        // 超时会留一份**残缺** CSV（可能几 GB）：删掉，别让下一次看到"CSV 在"就以为好了。
        try { if (existsSync(csv)) rmSync(csv, { force: true }) } catch { /* ignore */ }
        return { ok: false, timedOut: true, etlPath: etl,
          error: 'xperf -a dumper 解码超时（' + dumperMs + 'ms）。dumper 的 CSV 是 etl 的 ~7×，大 etl 很慢 —— ' +
            '建议用更短的采集时长重采，或加大 timeoutMs。', raw: (r.stdout + '\n' + r.stderr).slice(-500) }
      }
      if (!existsSync(csv)) {
        return { ok: false, etlPath: etl, error: 'xperf -a dumper 未产出 CSV', raw: (r.stdout + '\n' + r.stderr).slice(-600) }
      }
    }
    const csvBytes = existsSync(csv) ? statSync(csv).size : null

    const fold = await foldDumperCsv(csv, { processRe, frameMode, jitMap })
    const cleanupCsv = () => { if (!reusing && args.keepCsv !== true) { try { rmSync(csv, { force: true }) } catch { /* ignore */ } } }

    if (fold.samplesTarget === 0) {
      cleanupCsv()
      return { ok: false, etlPath: etl, process: proc, samplesAll: fold.samplesAll,
        error: '目标进程「' + proc + '」在这段采样里 **0 个 CPU 采样点** —— 可能：① 采样期间它没在跑 / 没吃 CPU；' +
          '② 进程名/正则不对（本次全机共 ' + fold.samplesAll + ' 个 CPU 采样）。**别读成「它不占 CPU」**。' }
    }

    // 解析率（只有 symbols 模式有意义）：叶子帧带 `!`（= 有函数名）的采样占比。
    let resolvedLeafSamples = 0
    for (const [stack, n] of fold.folded) {
      const leaf = stack.slice(stack.lastIndexOf(';') + 1)
      if (leaf.includes('!')) resolvedLeafSamples += n
    }
    const resolvedLeafRatio = fold.stacksFolded ? resolvedLeafSamples / fold.stacksFolded : 0

    const tree = buildTree(fold.folded, proc + ' (CPU)')
    const foldedPath = join(dir, 'flame.folded')
    const htmlPath = join(dir, 'flame.html')
    const jitSub = fold.jit && fold.jit.attempted
      ? ' · JIT 解析 ' + fold.jit.resolved + '/' + fold.jit.attempted + ' 帧'
      : ''
    writeFileSync(foldedPath, foldedToText(fold.folded), 'utf8')
    writeFileSync(htmlPath, renderFlameHtml(tree, {
      title: proc + ' CPU 火焰图',
      subtitle: fold.stacksFolded + ' 采样 · ' + fold.uniqueStacks + ' 唯一栈 · ' + (symbols ? '符号模式' : '模块模式') + jitSub + ' · ' + basename(etl),
    }), 'utf8')

    cleanupCsv()
    return {
      ok: true, etlPath: etl, process: proc, symbols, frameMode,
      foldedPath, htmlPath,
      samplesAll: fold.samplesAll, samplesTarget: fold.samplesTarget,
      stacksFolded: fold.stacksFolded, uniqueStacks: fold.uniqueStacks,
      topLeaves: fold.topLeaves, topModules: fold.topModules,
      resolvedLeafRatio,
      jit: fold.jit, jitEtl: jitEtl || null, jitInfo,
      csvBytes, csvKept: Boolean(reusing || args.keepCsv === true), csvPath: (reusing || args.keepCsv === true) ? csv : null,
      dumperMs, elapsedMs: Date.now() - t0,
      hint: '产物：flame.html（浏览器打开，可点击缩放 / 悬停 / 搜索）；flame.folded（可直接拖进 https://speedscope.app，或喂 flamegraph.pl）。' +
        (jitMap ? '\n已接 JIT 映射：客户端 `"Unknown"` 帧尽量解成了真实托管方法名（' + (fold.jit ? fold.jit.resolved + '/' + fold.jit.attempted : '0/0') + '）。'
          : (jitEtl ? '\n⚠ 找到 jit-methods.etl 但映射没建起来（见 jitInfo）——客户端 JIT 帧仍是 [unknown]。'
            : '\n未接 JIT 映射：客户端自己的方法名会聚成 [unknown]（JIT，见 §3）。要真实方法名，采集时带 perf_trace(jit=true)。')) +
        (symbols ? '' : '\n本次是**模块模式**（快）：原生/框架帧想要函数名可加 symbols=true 重跑。'),
    }
  }

  /**
   * 从**分配采样** etl（perf_trace(alloc=true) 的 alloc-events.etl）出**分配火焰图**（#3）。
   * AllocationTick + 栈 → 按字节加权折叠 → 自包含可交互 alloc-flame.html + .folded + Top 分配类型。
   * 复用 §4 的 JIT 映射（默认自动发现同目录 jit-methods.etl）把客户端分配路径解成真实方法名。
   * @param args.etlPath  alloc-events.etl（perf_trace(alloc=true) 产出）
   * @param args.process  只折该进程名（正则，默认 DSH_UI_PROC_NAME）
   * @param args.symbols  true = dumper 带 -symbols 解原生/框架帧名（慢）
   * @param args.jitEtl / args.noJit  同 flame()：JIT 方法名映射
   */
  async function allocFlame(args = {}) {
    const etl = args.etlPath
    if (!etl || !existsSync(etl)) return { ok: false, error: 'etlPath 不存在：' + String(etl) + '（需要 perf_trace(alloc=true) 产出的 alloc-events.etl）' }
    if (!existsSync(c.xperf)) return { ok: false, error: 'xperf.exe 不存在：' + c.xperf }
    const proc = String(args.process || c.procName || '').trim()
    if (!proc) return { ok: false, error: '没有目标进程名：请传 process，或配 DSH_UI_PROC_NAME（分配火焰图必须按进程折叠）。' }
    let processRe
    try { processRe = new RegExp(proc, 'i') } catch { return { ok: false, error: 'process 不是合法正则：' + proc } }
    const symbols = args.symbols === true
    const frameMode = symbols ? 'symbols' : 'module'
    const dir = dirname(etl)
    const csv = args.csvPath || join(dir, 'alloc-dumper.csv')
    const reusing = Boolean(args.csvPath) && existsSync(csv)

    // ★ 分配采样是 xperf 用户会话 ⇒ AllocationTick 行进程名多为 `"Unknown" (PID)`：必须按 **PID** 过滤。
    //   优先用显式传入的 pid；否则按进程名 live 查 tasklist（采集刚停、进程通常还在）。查不到就回退按名。
    let pidSet = null
    if (args.pid) pidSet = new Set(String(args.pid).split(/[,\s]+/).filter(Boolean))
    else {
      try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + proc + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
        const pids = [...out.matchAll(/"[^"]*","(\d+)"/g)].map((m) => m[1])
        if (pids.length) pidSet = new Set(pids)
      } catch { /* 进程已退 / tasklist 不可用 ⇒ pidSet 留空，回退按名 */ }
    }

    let jitMap = null, jitInfo = null
    const jitEtl = args.noJit === true ? null : (args.jitEtl || (existsSync(join(dir, 'jit-methods.etl')) ? join(dir, 'jit-methods.etl') : null))
    if (jitEtl) { const d = await jitMapFromEtl(jitEtl, { timeoutMs: Number(args.timeoutMs) || 900000 }); jitInfo = d.info; if (d.ok) jitMap = d.map }

    const t0 = Date.now()
    let dumperMs = null
    if (!reusing) {
      const cmd = []
      if (symbols) cmd.push('-symbols')
      cmd.push('-i', etl, '-o', csv, '-a', 'dumper')
      const r = await runExe(c.xperf, cmd, { timeoutMs: Number(args.timeoutMs) || 900000, env: symbolEnv(!symbols) })
      dumperMs = Date.now() - t0
      if (r.timedOut) { try { if (existsSync(csv)) rmSync(csv, { force: true }) } catch { /* ignore */ } ; return { ok: false, timedOut: true, etlPath: etl, error: 'xperf -a dumper 解码超时（' + dumperMs + 'ms）' } }
      if (!existsSync(csv)) return { ok: false, etlPath: etl, error: 'xperf -a dumper 未产出 CSV', raw: (r.stdout + '\n' + r.stderr).slice(-600) }
    }
    const csvBytes = existsSync(csv) ? statSync(csv).size : null

    const fold = await foldAllocCsv(csv, { processRe, pidSet, frameMode, jitMap })
    const cleanupCsv = () => { if (!reusing && args.keepCsv !== true) { try { rmSync(csv, { force: true }) } catch { /* ignore */ } } }
    if (fold.ticksTarget === 0) {
      cleanupCsv()
      return { ok: false, etlPath: etl, process: proc, ticksAll: fold.ticksAll,
        error: '目标进程「' + proc + '」在这段采样里 **0 个 AllocationTick**（全机共 ' + fold.ticksAll + ' 个）—— ' +
          '可能：① 采样期间它没怎么分配；② 进程名/正则不对；③ 它是 .NET Core/5+，其 GCAllocationTick 在本机解不出 manifest（落成 UnknownEvent）。**别读成"它不分配内存"**。' }
    }
    const tree = buildTree(fold.folded, proc + ' (alloc bytes)')
    const foldedPath = join(dir, 'alloc-flame.folded')
    const htmlPath = join(dir, 'alloc-flame.html')
    const jitSub = fold.jit && fold.jit.attempted ? ' · JIT 解析 ' + fold.jit.resolved + '/' + fold.jit.attempted + ' 帧' : ''
    writeFileSync(foldedPath, foldedToText(fold.folded), 'utf8')
    writeFileSync(htmlPath, renderFlameHtml(tree, {
      title: proc + ' 分配火焰图（按字节）',
      subtitle: fold.ticksTarget + ' 个 AllocationTick · ~' + Math.round(fold.totalBytes / 1048576) + 'MB 采样分配 · ' + (symbols ? '符号模式' : '模块模式') + jitSub + ' · ' + basename(etl),
    }), 'utf8')
    cleanupCsv()
    return {
      ok: true, etlPath: etl, process: proc, symbols, frameMode,
      foldedPath, htmlPath,
      ticksAll: fold.ticksAll, ticksTarget: fold.ticksTarget, totalBytes: fold.totalBytes,
      topTypes: fold.topTypes, jit: fold.jit, jitEtl: jitEtl || null, jitInfo,
      csvBytes, dumperMs, elapsedMs: Date.now() - t0,
      hint: '产物：alloc-flame.html（浏览器打开，按**分配字节**加权，可点击缩放/搜索）；alloc-flame.folded（可拖进 speedscope）。' +
        '\n口径：AllocationTick 每 ~100KB 采一次 ⇒ 这是**采样**、权重是字节近似；**分配多 ≠ 泄漏**（泄漏看 perf_gcroot），它答的是"谁在制造 GC 压力/churn"。' +
        (jitMap ? '' : '\n未接 JIT 映射：客户端分配路径的自有方法会聚成 [unknown]（采集时带 perf_trace(jit=true) 可解名）。'),
    }
  }

  /**
   * 把 CLR 方法/rundown 会话的 etl 解成「pid → 排序方法数组」的 JIT 映射（§4）。
   * 复用 tracerpt（与 clrEvents 同一把解码器）。带体积闸门：rundown 的 etl 体量由**方法数**决定、
   * 与采样时长无关，通常不大；但仍设上限，超了如实报而不是默默解出个 GB 级 XML。
   */
  async function jitMapFromEtl(jitEtl, opts = {}) {
    if (!existsSync(jitEtl)) return { ok: false, info: { state: 'etl-missing', jitEtl } }
    if (!existsSync(c.tracerpt)) return { ok: false, info: { state: 'tracerpt-missing', tracerpt: c.tracerpt } }
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 900000, 10000), 3600000)
    const etlBytes = statSync(jitEtl).size
    const estXmlBytes = Math.round(etlBytes * 6)
    const maxXmlBytes = 4096 * 1024 * 1024
    if (estXmlBytes > maxXmlBytes) {
      return { ok: false, info: { state: 'xml-too-large', jitEtl, etlBytes, estXmlBytes } }
    }
    const xmlPath = join(dirname(jitEtl), basename(jitEtl).replace(/\.etl$/i, '') + '.jit.xml')
    const d = await runExe(c.tracerpt, [jitEtl, '-o', xmlPath, '-of', 'XML', '-y'], { timeoutMs })
    if (!d || d.timedOut) return { ok: false, info: { state: 'decode-timeout', jitEtl, xmlPath } }
    if (d.code !== 0 || !existsSync(xmlPath)) {
      return { ok: false, info: { state: 'decode-failed', jitEtl, xmlPath, exitCode: d ? d.code : null, raw: (((d && d.stdout) || '') + ((d && d.stderr) || '')).slice(-400) } }
    }
    const xmlBytes = statSync(xmlPath).size
    let map
    try {
      // 只留有采样的目标进程那几张表也行，但 rundown 通常不大 ⇒ 全收，按 pid 分桶后由折叠端按需取。
      map = await buildJitMapStreaming(xmlPath)
    } catch (e) {
      return { ok: false, info: { state: 'parse-failed', jitEtl, xmlPath, error: String(e) } }
    }
    let totalMethods = 0
    for (const [, arr] of map) totalMethods += arr.length
    // 解完就删 XML（可能几百 MB，映射已在内存）。
    try { rmSync(xmlPath, { force: true }) } catch { /* ignore */ }
    return {
      ok: true, map,
      info: { state: 'ok', jitEtl, etlBytes, xmlBytes, pids: map.size, methods: totalMethods },
    }
  }

  /**
   * UI 冻结的**等待时间分析**（perf_uifreeze）—— 复刻 PerfView 的 UI Freeze 视图。
   * 两段式（贴合"手动复现冻结"的现场）：
   *   action=start：起带 **CSwitch** 的内核会话（这是等待分析的数据源，与 CPU trace 不同）；你去复现冻结；
   *   action=stop ：停+合并 → dumper → analyzeThreadWaits(目标 UI 线程) → 输出「冻结 N 秒，其中 M 秒卡在 X」。
   * UI 线程 tid：优先用传入的 tid；否则 stop 时**抓一张瞬时 dump 自动认 UI 线程**（perf_dump 的 uiThread.osId）。
   */
  const UIFREEZE_KERNEL = 'PROC_THREAD+LOADER+CSWITCH+DISPATCHER'
  const UIFREEZE_STACK = 'CSwitch+ReadyThread'

  async function uiFreeze(args = {}) {
    const action = String(args.action || 'run').toLowerCase()
    if (!existsSync(c.xperf)) return { ok: false, error: 'xperf.exe 不存在：' + c.xperf }
    if (action !== 'start' && !(await isElevated())) {
      // start 也需要提权，但 stop 前若没提权更要早说
    }
    const dir = args.dir || runDir(args.tag || 'uifreeze')
    const rawEtl = join(dir, 'uifreeze-raw.etl')
    const etl = join(dir, 'uifreeze.etl')
    const sessionFile = join(c.evidenceDir, 'uifreeze-session.json')

    if (action === 'start') {
      if (!(await isElevated())) return { ok: false, needsElevation: true, error: 'ETW 内核会话需要管理员权限' }
      mkdirSync(dir, { recursive: true })
      // 先无条件停掉可能残留的内核会话
      await runExe(c.xperf, ['-stop'], { timeoutMs: 60000 })
      const r = await runExe(c.xperf, ['-on', UIFREEZE_KERNEL, '-stackwalk', UIFREEZE_STACK, '-f', rawEtl], { timeoutMs: 120000 })
      if (r.code !== 0) return { ok: false, error: 'xperf -start（CSwitch）失败', raw: (r.stdout + r.stderr).slice(0, 500) }
      try { writeFileSync(sessionFile, JSON.stringify({ dir, rawEtl, etl, startedAt: Date.now(), tid: args.tid || null, process: args.process || c.procName || null }), 'utf8') } catch { /* ignore */ }
      return { ok: true, started: true, dir, rawEtl, etl,
        hint: '现在去**复现那个卡顿**（例如冷加载点进 ETF量化）；结束后调 perf_uifreeze(action="stop")。' +
          '\n⚠ CSwitch 采集数据量大（每秒 ~15MB etl，dumper CSV 更大），别开太久——复现完尽快 stop。' }
    }

    // stop（或一体化 run）
    let session = null
    try { session = JSON.parse(readFileSync(sessionFile, 'utf8')) } catch { session = null }
    const useDir = (session && session.dir) || dir
    const useRaw = (session && session.rawEtl) || rawEtl
    const useEtl = (session && session.etl) || etl
    const proc = String(args.process || (session && session.process) || c.procName || '').trim()

    // 停 + 合并（模块归属只在 merge 产生）
    await runExe(c.xperf, ['-stop'], { timeoutMs: 300000 })
    if (existsSync(useRaw) && !existsSync(useEtl)) {
      await runExe(c.xperf, ['-merge', useRaw, useEtl], { timeoutMs: 900000 })
    }
    try { rmSync(sessionFile, { force: true }) } catch { /* ignore */ }
    if (!existsSync(useEtl)) return { ok: false, error: '停止后没有合并出 etl（是否没先 action="start"？）', rawExists: existsSync(useRaw) }

    // 认 UI 线程 tid：显式 > 会话记录 > detectUiThread 回调（由 index.js 注入 perf.dump 能力）
    let tid = args.tid || (session && session.tid) || null
    let tidSource = tid ? 'given' : null
    let uiDumpPath = null
    if (!tid && typeof args.detectUiThread === 'function') {
      try {
        const det = await args.detectUiThread(useDir)
        if (det && det.osId) { tid = String(det.osId); tidSource = 'auto-dump'; uiDumpPath = det.dumpPath || null }
      } catch { /* 识别失败下面统一报 */ }
    }
    if (!tid) return { ok: false, error: '无法确定 UI 线程 tid：请传 tid（目标 UI 线程 os id），或让调用方提供 detectUiThread 回调（自动抓 dump 识别）', etlPath: useEtl }

    // dumper 解码
    const csv = join(useDir, 'uifreeze-dumper.csv')
    const t0 = Date.now()
    const dr = await runExe(c.xperf, ['-i', useEtl, '-o', csv, '-a', 'dumper'], { timeoutMs: Number(args.timeoutMs) || 1200000, env: symbolEnv(true) })
    if (dr.timedOut || !existsSync(csv)) { try { if (existsSync(csv)) rmSync(csv, { force: true }) } catch { /* ignore */ } ; return { ok: false, error: 'dumper 解码失败/超时', etlPath: useEtl } }

    // JIT 映射（可选，解客户端方法名）
    let jitMap = null
    const jitEtl = args.jitEtl || (existsSync(join(useDir, 'jit-methods.etl')) ? join(useDir, 'jit-methods.etl') : null)
    if (jitEtl && args.noJit !== true) { const d = await jitMapFromEtl(jitEtl, {}); if (d.ok) jitMap = d.map }

    let pid = args.pid || null
    if (!pid && proc) { try { const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + proc + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }); const m = /"[^"]*","(\d+)"/.exec(out); if (m) pid = m[1] } catch { /* ignore */ } }

    const wa = await analyzeThreadWaits(csv, { tid, pid, frameMode: args.moduleOnly === true ? 'module' : 'symbols', jitMap })
    if (args.keepCsv !== true) { try { rmSync(csv, { force: true }) } catch { /* ignore */ } }

    // 出等待火焰图（按等待时长加权）
    let htmlPath = null, foldedPath = null
    if (wa.waitFolded && wa.waitFolded.size) {
      const tree = buildTree(wa.waitFolded, 'UI thread ' + tid + ' (wait)')
      htmlPath = join(useDir, 'uifreeze-flame.html')
      foldedPath = join(useDir, 'uifreeze.folded')
      writeFileSync(foldedPath, foldedToText(wa.waitFolded), 'utf8')
      writeFileSync(htmlPath, renderFlameHtml(tree, { title: 'UI 冻结等待火焰图（线程 ' + tid + '）', subtitle: '按阻塞时长加权 · 冻结 ' + wa.waitMs + 'ms / 运行 ' + wa.runMs + 'ms · ' + basename(useEtl) }), 'utf8')
    }
    return {
      ok: true, etlPath: useEtl, tid, tidSource, uiDumpPath, process: proc || null,
      spanMs: wa.spanMs, waitMs: wa.waitMs, runMs: wa.runMs, switches: wa.switches,
      waitSpanCount: wa.waitSpanCount, longestWaitMs: wa.longestWaitMs,
      topWaits: wa.topWaits, byReason: wa.byReason, jit: wa.jit,
      htmlPath, foldedPath,
      dumperMs: Date.now() - t0,
      hint: '等待火焰图（按阻塞时长加权）：' + (htmlPath || '(无等待栈)') + '；topWaits = UI 线程醒来点（阻塞返回处）按等待 ms 排行。',
    }
  }

  return { trace, hotstacks, clrEvents, flame, allocFlame, uiFreeze, isElevated, parseStackReport, symbolEnv, symbolPathInfo, config: () => c }
}

// ---------------------------------------------------------------- 报告解析

/** 去掉标签与实体，取纯文本（HTML 是**单行**的，不能按行解析）。 */
function textOf(htmlCell) {
  return String(htmlCell)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function cellsOf(rowHtml) {
  const out = []
  const re = /<td[^>]*>([\s\S]*?)<\/td>/g
  let m
  while ((m = re.exec(rowHtml))) out.push(textOf(m[1]))
  return out
}

function rowsOf(sectionHtml) {
  const out = []
  const re = /<tr([^>]*)>([\s\S]*?)<\/tr>/g
  let m
  while ((m = re.exec(sectionHtml))) out.push({ attrs: m[1], html: m[2], cells: cellsOf(m[2]) })
  return out
}

/**
 * 取某个**小节标题**到其后第一个 `</table>` 之间的片段。
 * ⚠️ 必须按 `>标题</h2>` 定位：同一串标题在文首的**目录（TOC）**里也会出现一次
 * （`<a href='#TblME'>Modules by Exclusive Hits</a>`），按普通子串首次命中会取到**上一张表**，
 * 解析出来的"函数排行"其实来自进程表 —— 一开始就是这么错的。
 */
function sectionOf(html, heading) {
  const marker = '>' + heading + '</h2>'
  let i = html.indexOf(marker)
  if (i < 0) i = html.indexOf(heading)          // 兼容没有 <h2> 包裹的变体
  if (i < 0) return ''
  const end = html.indexOf('</table>', i)
  return html.slice(i, end < 0 ? html.length : end)
}

/**
 * 解析 xperf `-a stack -butterfly` 的 HTML 报告。
 * @returns {{ processes, modules, hotFunctions, butterfly, unknownRatio }}
 */
export function parseStackReport(html) {
  const s = String(html || '')
  const processes = []
  const psec = sectionOf(s, 'Processes and Root functions')
  if (psec) {
    for (const r of rowsOf(psec)) {
      if (/class='pp'/.test(r.attrs) && r.cells.length >= 4) {
        processes.push({ name: r.cells[0], pid: Number(r.cells[1]) || null, exclusiveHits: Number(r.cells[2]) || 0, percent: r.cells[3] })
      }
    }
  }

  const modules = []
  const msec = sectionOf(s, 'Modules by Exclusive Hits')
  if (msec) {
    for (const r of rowsOf(msec)) {
      if (r.cells.length >= 5 && /^\S/.test(r.cells[0]) && !/^module name/i.test(r.cells[0])) {
        modules.push({ module: r.cells[0], hits: Number(r.cells[1]) || 0, percent: r.cells[2] })
      }
    }
  }

  // 谁最热（按包含命中）
  const hotFunctions = []
  const hsec = sectionOf(s, 'Functions by UniInclusive Hits')
  if (hsec) {
    for (const r of rowsOf(hsec)) {
      if (r.cells.length >= 4 && /!/.test(r.cells[0])) {
        hotFunctions.push({ name: r.cells[0], inclusive: Number(r.cells[1]) || 0, percent: r.cells[2], exclusive: Number(r.cells[3]) || 0 })
      }
    }
  }

  // 蝶形视图：函数 → 调用者(<--) / 被调用者(-->)
  const butterfly = []
  const bsec = sectionOf(s, 'Functions by Multi-Inclusive Hits with Callers and Callees')
  if (bsec) {
    let cur = null
    for (const r of rowsOf(bsec)) {
      const isRoot = /id='#?SN/.test(r.html) || /id="#?SN/.test(r.html)
      if (isRoot && r.cells.length >= 2 && /!/.test(r.cells[0])) {
        cur = { name: r.cells[0], inclusive: Number(r.cells[1]) || 0, percent: r.cells[2], itself: 0, callers: [], callees: [] }
        butterfly.push(cur)
        continue
      }
      if (!cur) continue
      const c0 = r.cells[0] || ''
      const hits = Number(r.cells[1]) || 0
      if (/\*\*\*itself\*\*\*/.test(c0)) { cur.itself = hits; continue }
      const callee = /-->/.test(c0)
      const caller = /<--/.test(c0)
      const name = c0.replace(/^\s*(-->|<--)\s*/, '').trim()
      if (callee) cur.callees.push({ name, hits })
      else if (caller) cur.callers.push({ name, hits })
    }
  }

  // 符号未解析比例：**口径必须覆盖"所有被打出来的名字"**。
  //
  // 修（2026-09-11，Claude r12 提的方向 + 我用真报告实测确认）：原口径只有
  // `hotFunctions + butterfly 的 root 名`，**不含蝴蝶视图里的调用者/被调用者**——
  // 而那份列表正是输出里最显眼的部分。真机（374KB 真 xperf 报告，test/fixtures/stack-report-managed.html）实测：
  //   上报 0.2%（1472 项），而实际显示出来的名字有 1578 个、其中 6 个未解析（0.4%）；
  //   链里明明白白写着 `***unknown***!***unknown***`，却一个都没进分母。
  // 未解析帧恰恰**偏爱深层**（冷门模块没有 pdb 的概率最高），所以这个低估在符号没配好的报告里会成大问题：
  // 报"0% 未解析"，而下面的调用链满是 unknown —— 又一条"工具不说谎"的失守。
  const chainNames = butterfly.flatMap((b) => b.callers.map((c) => c.name).concat(b.callees.map((c) => c.name)))
  const allNames = hotFunctions.map((f) => f.name).concat(butterfly.map((b) => b.name)).concat(chainNames)
  const unknown = allNames.filter((n) => /\*\*\*unknown\*\*\*/.test(n)).length
  const unknownRatio = allNames.length ? unknown / allNames.length : 0
  // 分桶明细：让"未解析集中在链里"这种事能被看见，而不是被一个总数抹平。
  //
  // F-043 追加的第三桶（**这是"未解析"里唯一还能提取信息的一层**）：
  // 未解析的名字有两种形态，价值完全不同：
  //   `***unknown***!***unknown***`  —— 连**模块名**都没有 ⇒ 任何工具都无法归因，
  //                                    只能靠补映射（换采集方式/补符号）才有救；
  //   `mscorlib.dll!***unknown***`   —— **模块知道、函数名不知道** ⇒ 至少能说"这堆未知属于它"。
  //
  // ⚠️ 我在这里先写错过一次：动手实现时我凭上一轮的印象写下"实测 871 个未解析帧**全部**属于前者"，
  //    而那个拆分**当时根本没测过**（unknown 总数是测过的，拆分不是）。真跑一次之后数字是
  //    666 = 615（带模块名）+ 51（连模块名都没有）—— **与我的印象相反**。
  //    教训还是同一条：**凭印象写下的"实测"就是伪证**，写进注释也一样有害（下一个人会信它）。
  // 所以这里额外算一个 **byModule**：既回答"未知集中在谁身上"，也让上面那句话随时可被数据推翻。
  const unknownNames = allNames.filter((n) => /\*\*\*unknown\*\*\*/.test(n))
  // 「有没有模块前缀」必须**和 byModule 用同一把尺子**：第一版只看"是不是恰好等于 `***unknown***!`"，
  // 于是 `!***unknown***`（前缀为空）被算成了"已知模块"，而 byModule 又把它归到 `(模块未知)`
  // —— 同一份数据里两个字段互相矛盾（Codex r37 第 11 条）。
  const nameModuleOf = (n) => {
    const head = String(n).split('!')[0].trim()
    if (head === '' || isUnknownBucket(head)) return '(模块未知)'
    return head
  }
  const unknownWithModule = unknownNames.filter((n) => nameModuleOf(n) !== '(模块未知)').length
  const unkByModule = new Map()
  for (const n of unknownNames) {
    const key = nameModuleOf(n)
    unkByModule.set(key, (unkByModule.get(key) || 0) + 1)
  }
  const unknownDetail = {
    unknown,
    total: allNames.length,
    inHot: hotFunctions.filter((f) => /\*\*\*unknown\*\*\*/.test(f.name)).length,
    inRoots: butterfly.filter((b) => /\*\*\*unknown\*\*\*/.test(b.name)).length,
    inChains: chainNames.filter((n) => /\*\*\*unknown\*\*\*/.test(n)).length,
    withModule: unknownWithModule,
    withoutModule: unknown - unknownWithModule,
    byModule: [...unkByModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([module, count]) => ({ module, count })),
  }

  // ---- F-043：**有独占命中、却一条函数名都没解出来**的模块 ----
  //
  // 为什么值得单独算：`***unknown***!***unknown***` 连**模块名**都没有，
  // 看上去是"零信息"。但 xperf 的**模块表**（Modules by Exclusive Hits）是带模块名的，
  // 于是"未知"里其实还剩一层可用信息：**这段时间花在哪个模块里，只是没走到方法名**。
  // 实测现场（2026-09-11）：把客户端自己的 16 个 pdb 目录加进符号路径后，报告里
  //   `mscorlib!…` / `WindowsBase!…` / `PresentationFramework.ni.dll!System.Windows.Window.ShowDialog`
  // 都能出名字，**客户端自己的托管帧却仍然一条都没有**（unknownRatio 0.14、客户端函数名 0 条）。
  // 不说出来，agent 会把那 14% 的 unknown 当成"没有证据" —— 而它其实指向"热点在客户端自己的模块里"。
  const resolvedMods = new Set()
  for (const n of allNames) {
    if (/\*\*\*unknown\*\*\*/.test(n)) continue
    const mod = moduleKey(String(n).split('!')[0])
    if (mod) resolvedMods.add(mod)
  }
  const silentModules = modules
    .filter((m) => Number(m.hits) >= SILENT_MODULE_MIN_HITS && parseFloat(String(m.percent)) >= SILENT_MODULE_MIN_PERCENT)
    .filter((m) => !resolvedMods.has(moduleKey(m.module)))
    // ⚠️ `***unknown***` 自己也会作为**一行模块**出现在模块表里（真夹具 stack-report-managed.html 就有）。
    //    它不是"一个模块"，而是"没归到任何模块的桶"（可能混着好几个）—— 把它写进
    //    "有命中却没函数名的模块"会变成**编出来的身份**（Codex r37 第 6 条）。单列成 bucket 字段。
    .filter((m) => !isUnknownBucket(m.module))
    .map((m) => ({ module: m.module, hits: Number(m.hits) || 0, percent: m.percent }))
  // 未归因桶单独带出来（信息不丢，但**不冒充模块身份**）
  const unassigned = modules.find((m) => isUnknownBucket(m.module))

  return {
    processes, modules, silentModules,
    unassignedModuleBucket: unassigned ? { module: unassigned.module, hits: Number(unassigned.hits) || 0, percent: unassigned.percent } : null,
    hotFunctions, butterfly, unknownRatio, unknownDetail,
    totalSamples: hotFunctions.reduce((a, f) => Math.max(a, f.exclusive), 0),
  }
}

/** `***unknown***` 这类"桶"不是模块身份（见 silentModules 处的说明）。 */
export function isUnknownBucket(name) {
  return /\*\*\*unknown\*\*\*/.test(String(name == null ? '' : name))
}

/**
 * 模块名的比较键：xperf 的**模块表**写 `mscorlib.dll`，而**帧**写 `mscorlib!方法` ——
 * 不去掉扩展名就永远匹配不上，于是"有命中却解不出名字的模块"会**全部**漏报。
 * （这类"同一实体两种写法"是静默失配的高发区，单列一个函数出来就是为了能被测试钉住。）
 */
export function moduleKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase()
    .replace(/\.(dll|exe)$/i, '')
    .replace(/\.ni$/i, '')
}

/** "有命中却没有函数名"的模块的入表门槛：低于它多半是噪声/表项截断，不值得升级成告警。 */
export const SILENT_MODULE_MIN_HITS = 10
export const SILENT_MODULE_MIN_PERCENT = 1

/**
 * 这段窗口是"**在等**"还是"**在烧**" —— 必须由工具说出来。
 *
 * 怎么逼出来的（F-043 现场，真机）：我拿着一段 6 秒采样去解释"客户端到底慢在哪"，
 * 而那段窗口里 UI 线程**就是在消息泵里等消息**：独占采样 91% 落在 `ntkrnlmp.exe`（内核），
 * 链条是 `Application.Run → Dispatcher.PushFrame → IL_STUB_PInvoke(MSG) → DispatchMessageWorker`。
 * 对空闲的 UI 线程这**完全正常**；我差一点把它写成"91% 在内核 ⇒ 内核有瓶颈"。
 * 而**第一版判定没触发**（我只认名字里带 `GetMessage` 且包含命中 ≥30% 的帧，
 * 而那个帧在真报告里只作为链上深层节点出现、根本没有百分比）——
 * 于是"工具不说"就等于"agent 只能靠猜"，正是要修的病。
 *
 * 判定分两条，**各自说清自己的含义**（不同信号的含义不同，不许合并成一句模糊的告警）：
 *   ① 消息泵帧的包含命中 ≥ minPercent ⇒ 明确是**空闲等待**形态；
 *   ② 独占命中的**第一名是内核镜像**（ntkrnlmp/ntoskrnl）且 ≥ minKernelPercent
 *      ⇒ 说明"时间主要花在内核/系统调用路径上"，**但分辨不了"空闲等待"与"被阻塞"** ——
 *      所以文案必须把这两种可能都摆出来，不许替读者选一个。
 */
export function waitingWindowHint(parsed, { minTopPercent = 50, minKernelPercent = 60 } = {}) {
  // 只认"这看起来**真的**是个消息泵 API"（Codex r37 反例：`Client.dll!GetMessageDigest`
  // 被 `/GetMessage/` 命中 ⇒ "30% 摘要 + 70% 忙活" 被报成"空闲、一切正常"，结论直接反过来）。
  // 规则：取 `!` 之后的函数名，**整体**必须是已知消息泵 API（允许 Win32 A/W 后缀、允许 xxx/Nt/Zw 前缀），
  // 不做任意子串匹配。
  const isPumpApi = (full) => {
    const s = String(full)
    const fn = s.includes('!') ? s.slice(s.indexOf('!') + 1) : s
    const base = fn.replace(/\((.*)$/, '').trim()
    const tail = base.split(/[.:]/).pop() ?? base
    return /^(xxx\w*)?(NtUser|Nt|Zw)?(Get|Peek|Wait)Message(W|A)?$/i.test(tail) ||
      /^MsgWaitForMultipleObjects(Ex)?$/i.test(tail)
  }
  const pump = (parsed.hotFunctions || []).find((f) => isPumpApi(f.name) && parsePct(f.percent) >= minTopPercent)
    || (parsed.butterfly || []).find((b) => isPumpApi(b.name) && parsePct(b.percent) >= minTopPercent)
  if (pump) {
    return {
      kind: 'idle-message-pump',
      frame: pump.name,
      percent: String(pump.percent),
      note: '这段窗口里**包含命中最大的一条链条就是消息泵等待**（`' + pump.name + '`，包含命中 ' + pump.percent + '）' +
        '—— 也就是说，这个进程**大部分时间在等消息**。' +
        '⚠ 仅凭这一条**不能**断定"所以一切正常"：它只否掉"这段时间整体在烧 CPU"，' +
        '不排除"等到消息之后有一小段很慢的处理"（占比小、会被平均掉）。' +
        '要查卡顿：先用 perf_probe 标定出**卡顿确实发生**的那段时间，再**在窗口内**重新 perf_trace 采集；' +
        '或者用 perf_dump 看卡顿那一刻的线程栈。',
    }
  }
  // 模块表**按命中排序**再取第一名：报告的行序是 xperf 给的，不能假设它一定从大到小
  // （Codex r37 反例：10 个各 1 命中的模块排在前面时，"最热模块"会整个错位）。
  const top = sortModulesByHits(parsed.modules)[0]
  if (top && isKernelSideModule(top.module) && parsePct(top.percent) >= minKernelPercent) {
    return {
      kind: 'kernel-dominant',
      frame: top.module,
      percent: String(top.percent),
      note: '这段窗口里**独占采样（采样点真的落在那里）最多的是 `' + top.module + '`（' + top.percent + '）** —— ' +
        '即"时间花在内核/系统调用路径上"，**不是**在客户端自己的托管代码里烧 CPU。' +
        '⚠ 但这一条**分辨不了三件不同的事**：① **空闲等待**（在消息泵里等消息，正常）；' +
        '② **被阻塞**（等锁/等 IO/等别的线程，这才是问题）；③ **内核自己在忙**（驱动/中断，可能是显卡或网络侧）。' +
        '本报告给不出这个区别，**别替它下结论**。' +
        '要区分：先用 perf_probe 确认"卡顿确实发生在这段时间"，再用 perf_dump 看那一刻的线程栈。',
    }
  }
  return null
}

/** 模块表按**独占命中**排序（不假设报告行序是从大到小 —— Codex r37 反例：行序可能错位）。 */
export function sortModulesByHits(modules) {
  return (Array.isArray(modules) ? modules.slice() : [])
    .filter((m) => Number(m.hits) > 0)
    .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
}

/**
 * 这是不是"内核侧"模块（内核镜像或驱动）。
 *
 * Codex r37 指出第一版的两处毛病：① 只认 `ntkrnlmp/ntoskrnl/ntdll.exe` 这几个名字 ⇒
 * **漏掉真正吃时间的驱动**（反例：`nvlddmkm.sys` 91% 却什么都不报）；② 用 `^ntkrnlmp` 前缀匹配 ⇒
 * `ntkrnlmp-helper.dll` 也会被叫做"内核镜像"（**没有身份证据**）。现在：已知内核镜像**精确匹配**，
 * 或**按扩展名**认 `.sys`（驱动）—— 只按扩展名，不做前缀猜测。
 */
export function isKernelSideModule(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase()
  if (s === '') return false
  if (/\.sys$/.test(s)) return true
  return s === 'ntkrnlmp.exe' || s === 'ntoskrnl.exe' || s === 'ntdll.dll' || s === 'win32k.sys' ||
    s === 'win32kfull.sys' || s === 'win32kbase.sys'
}

/** 旧名保留（历史调用点/文档用过），行为已扩展为 waitingWindowHint。 */
export const idleMessagePumpHint = waitingWindowHint

/** 解析 "12.34%" / 12.34 / "12.34" 三种写法（报告里两种都出现过）。 */
function parsePct(v) {
  if (v == null) return NaN
  const n = parseFloat(String(v).replace('%', ''))
  return Number.isFinite(n) ? n : NaN
}

/**
 * 把解析结果压成**给模型读得懂**的调用链文本（绝不放原始 HTML 回去）。
 * 未解析符号的比例**必须显式告知** —— 否则"没解析出来"会被当成"没有这段代码"。
 */
export function summarize(parsed, { topN = 15, focus = '' } = {}) {
  const hot = (parsed.hotFunctions || []).slice(0, topN)
  const chains = (parsed.butterfly || [])
    .filter((b) => !focus || new RegExp(focus, 'i').test(b.name))
    .slice(0, topN)
    .map((b) => ({
      fn: b.name,
      inclusive: b.inclusive,
      percent: b.percent,
      itself: b.itself,
      callers: b.callers.slice(0, 8),
      callees: b.callees.slice(0, 8),
    }))
  const fmt = (c) => (c.callees.length ? c.callees.map((x) => '      └─> ' + x.name + '  [' + x.hits + ']').join('\n') : '')
  const fmtUp = (c) => (c.callers.length ? c.callers.map((x) => '      ' + x.name + '  [' + x.hits + ']\n        └─> (它调用了本函数)').join('\n') : '')

  const lines = []
  lines.push('Etl: ' + (parsed.__etl || ''))
  // 空报告必须显式说清 —— 否则 "0% 未解析" 会被读成"符号全解析了"，实际是一个函数都没解析出来
  if (!hot.length && !chains.length) {
    lines.push('符号/条目: 报告里没有任何可解析的函数条目（**不等于"没有热点"**）')
  } else {
    // 比例必须**连口径一起说**：只给一个百分数，读者会以为它覆盖了整份报告；
    // 而真实口径是"本次打印出来的函数名"（最热函数 + 蝶形根 + 链上调用者/被调用者）。
    const d = parsed.unknownDetail
    // 口径必须**说准**（Codex r37 第 10 条）：分母是"报告里解析到的名字"（解析全表），
    // **不是**下面打印出来的那一小段（topN / focus / 链上各截 8 条都会让实际打印少于一整个分母）。
    // 说成"本次打印的 N 个函数名"会让读者以为 50% 指的是他眼前看到的东西 —— 那就错了。
    lines.push('符号未解析比例: ' + (parsed.unknownRatio * 100).toFixed(0) + '%' +
      (d ? '（口径：**报告里解析到的** ' + d.total + ' 个名字（不限于下面打印的这部分），其中 ' + d.unknown + ' 个是 ***unknown***；' +
        '其中最热表 ' + d.inHot + ' 个、链上 ' + d.inChains + ' 个）' : '') +
      (parsed.unknownRatio > 0.5 ? '  ⚠️ 大量帧未解析 —— 先配好符号（DSH_PERF_SYMBOL_PATH）再看结论' : ''))
    // 未解析帧**偏爱深层**：总数很低但链上就有未知帧时也要点出来（否则"0%"会被当成"整条链都可信"）。
    // 这里刻意用 ℹ️ 而不是 ⚠️：解析良好的报告里出现个别链上 unknown 是常态，用最高级告警就成了"狼来了"，
    // ⚠️ 只留给"大量未解析"（>50%）那种真的不能下结论的情形。
    if (d && d.inChains > 0 && parsed.unknownRatio <= 0.5) {
      lines.push('  ℹ️ 注意：调用链里有 ' + d.inChains + ' 个未解析帧 —— 链上出现的 ***unknown*** 通常在**深层**，' +
        '这部分代码在本次报告里是**看不见的**，不要据此判断"那段逻辑没被调用"。')
    }
    // F-043：未解析的帧"还剩多少信息可用"必须说清楚 —— 这决定了下一步该做什么。
    if (d && d.unknown > 0) {
      lines.push('  · 未解析的 ' + d.unknown + ' 个名字里：**' + d.withoutModule + ' 个连模块名都没有**' +
        '（形如 `***unknown***!***unknown***`），**' + d.withModule + ' 个至少知道模块**。' +
        (d.withModule > 0
          ? '后者是**可归因的**：这堆未知属于哪些模块，见下一行 —— 定位到模块往往已经够用，别再往下猜函数。'
          : '前者**无法被任何后处理归因**（模块名都不在报告里）。'))
      const byMod = Array.isArray(d.byModule) ? d.byModule : []
      if (byMod.length) {
        lines.push('    未解析最多的模块：' + byMod.slice(0, 6).map((m) => m.module + ' ×' + m.count).join('，'))
      }
      // 为什么这条要专门写：ETW 的托管方法名依赖**采集期间**的运行时映射事件，
      // 对一个**早就跑起来**的 .NET 进程，它自己的方法很可能点不出名字。
      // 实测（本机客户端，6 秒采样）：采样 100% 落在该进程、20 个模块有名字、客户端自己的 pdb 也在符号路径上，
      // 报告里客户端自己的模块/方法**一个都没有**。不说清楚，agent 会把这读成"客户端代码没参与"。
      lines.push('    ⚠ 若目标是个**早就启动**的 .NET 应用：它自己的托管方法名在 ETW 里可能**整批**点不出来' +
        '（运行时映射事件只在采集窗口内产生）—— 此时**能拿到的上限就是"在哪个系统/框架函数里、被谁调用"**，' +
        '而不是"客户端哪个方法"。这不是"没有热点"，也不等于"客户端自己的代码没参与"。')
    }
    // F-043：`***unknown***!***unknown***` 连模块名都没有，最容易被读成"零信息"。
    // 但报告里的**模块表**带模块名 —— 所以"未知"里还剩一层能用：**热点在哪个模块里**。
    const silent = Array.isArray(parsed.silentModules) ? parsed.silentModules : []
    if (silent.length) {
      lines.push('')
      lines.push('⚠ 有 ' + silent.length + ' 个模块**有独占命中、却一条函数名都没解出来**' +
        '（门槛：hits≥' + SILENT_MODULE_MIN_HITS + ' 且 ≥' + SILENT_MODULE_MIN_PERCENT + '%）——' +
        '热点**就在它里面**，但这份报告只给到模块级，给不出方法名：')
      for (const m of silent.slice(0, 8)) lines.push('    ' + m.module + '   hits=' + m.hits + '  ' + m.percent)
      lines.push('  · 想把方法名解出来：① 确认这些 pdb 与**正在运行的那个 dll** 是同一次构建产物（版本不匹配会静默失效）；' +
        '② 把 pdb 所在目录加进 DSH_PERF_SYMBOL_PATH —— 它是**整串替换**不是追加，' +
        '要写成 `srv*<缓存>*https://msdl.microsoft.com/download/symbols;<你的目录>`，只写目录会把系统符号全部丢掉；' +
        '③ 即便如此，**已在运行的进程**其托管方法名仍可能给不出来（实测：客户端 pdb 已就位、系统 DLL 全解析，客户端自己的托管帧依然全是 unknown）。' +
        '那时**模块级线索就是上限** —— 别把它当成"没有热点"。')
    }
  }
  lines.push('')
  lines.push('## 最热函数（按包含命中 inclusive）')
  for (const f of hot) lines.push('  ' + String(f.percent).padStart(7) + '  ' + f.name + '   (excl ' + f.exclusive + ')')
  if (!hot.length) lines.push('  （没有解析出函数 —— 报告为空或过滤太严）')
  // 模块表：**谁真的在烧 CPU**（独占命中 = 采样点落在该模块里）。
  // 加它的理由很实际：未解析帧大多**带模块名**（实测 611 个里 552 个），
  // 于是"哪个模块吃掉了时间"往往比"哪个函数"更早给出方向；而这份表一直躺在报告里没人看
  // （parseStackReport 解析了它，summarize 却把它丢了 —— F-043）。
  const modRows = sortModulesByHits(parsed.modules).slice(0, 10)
  if (modRows.length) {
    lines.push('')
    lines.push('## 最热模块（按**独占**命中 —— 采样点就落在这个模块里）')
    for (const m of modRows) lines.push('  ' + String(m.percent).padStart(7) + '  ' + m.module + '   (hits ' + m.hits + ')')
    const unassigned = parsed.unassignedModuleBucket
    if (unassigned) {
      lines.push('  · 其中 `***unknown***`（' + unassigned.hits + ' 次 / ' + unassigned.percent + '）是**未归因的桶**：' +
        '它可能混着好几个模块，**不是**"某个模块"的名字。')
    }
    lines.push('  （独占 ≠ 包含：模块名字在**调用链**里出现的次数远多于它真正吃掉的采样点，别按名字多少下结论）')
  }
  // 「这段窗口是在等还是在烧」必须由工具说出来 —— 否则读者会把"内核占比高"直接读成瓶颈（见 waitingWindowHint）
  const idle = waitingWindowHint(parsed)
  if (idle) {
    lines.push('')
    lines.push('⚠ ' + idle.note)
  }
  lines.push('')
  lines.push('## 调用链（调用者 <-- 本函数 --> 被调用者）')
  for (const c of chains) {
    lines.push('')
    lines.push('  ' + c.fn + '   [' + c.percent + ', 自身 ' + c.itself + ']')
    if (c.callers.length) { lines.push('    调用者:'); lines.push(fmtUp(c)) }
    if (c.callees.length) { lines.push('    调用了:'); lines.push(fmt(c)) }
  }
  if (!chains.length) lines.push('  （没有匹配的调用链；可放宽 focus 或增大 minHits）')

  return {
    text: lines.join('\n'),
    unknownRatio: parsed.unknownRatio,
    unknownDetail: parsed.unknownDetail,
    hotCount: hot.length,
    chainCount: chains.length,
    hotFunctions: hot,
    chains,
    processes: (parsed.processes || []).slice(0, 10),
    // 模块表必须**透出去**：parseStackReport 一直在解析它，但 summarize 把它丢了 ⇒
    // 结构化结果里根本没有 modules 字段（实测：`hs.modules` 恒为 undefined，探针里那条
    // "客户端的模块在不在 trace 里"的检查因此**永远拿不到答案**）。
    // silentModules 更要透出去 —— 它是"热点在哪个模块里"的唯一线索（F-043）。
    // ⚠️ 上限 30 必须**说明**（Codex r37 第 9 条）：调用方问"我的模块在不在里面"时，
    //    看到"没出现"不能当成"不在"—— 所以同时给出总数与是否被截断。
    modules: sortModulesByHits(parsed.modules).slice(0, 30),
    modulesTotal: sortModulesByHits(parsed.modules).length,
    modulesTruncated: sortModulesByHits(parsed.modules).length > 30,
    silentModules: parsed.silentModules || [],
    unassignedModuleBucket: parsed.unassignedModuleBucket || null,
    waitingWindow: waitingWindowHint(parsed),
  }
}
