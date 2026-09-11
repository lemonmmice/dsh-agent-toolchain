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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
export const DEFAULT_WPR = process.env.DSH_PERF_WPR || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wpr.exe')
export const DEFAULT_XPERF = process.env.DSH_PERF_XPERF || join(PROGRAM_FILES_X86, 'Windows Kits', '10', 'Windows Performance Toolkit', 'xperf.exe')

/** wpr 预设名映射（wpr -profiles 里的大小写就是这些）。 */
export const PROFILES = { cpu: 'CPU', dotnet: 'DotNet', general: 'GeneralProfile' }

/**
 * 采集时要同时启用的预设。
 * `cpu` 档也带上 `DotNet` —— 实测：只开 CPU 时托管帧的**函数名解不出来**（只有模块名），
 * 因为缺 CLR 的 rundown 事件；而对 .NET 应用来说那些函数名才是真正要看的调用链。
 */
export const CAPTURE_SETS = { cpu: ['CPU', 'DotNet'], dotnet: ['DotNet', 'CPU'], general: ['GeneralProfile'] }

export function makeTrace(cfg = {}) {
  const c = Object.assign({
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
    wpr: DEFAULT_WPR,
    xperf: DEFAULT_XPERF,
    procName: process.env.DSH_UI_PROC_NAME || '',
    symbolPath: process.env.DSH_PERF_SYMBOL_PATH || process.env._NT_SYMBOL_PATH || '',
  }, cfg)
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'perf-evidence')

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runDir = (tag) => join(c.evidenceDir, 'trace-' + stamp() + (tag ? '-' + tag : ''))

  /** 跑一个可执行文件并收全输出；超时杀进程树。 */
  function runExe(exe, args, { timeoutMs = 600000, env } = {}) {
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
    const ps = process.env.DSH_PERF_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const r = await runExe(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ELEVATED_PS], { timeoutMs: 20000 })
    return /True/i.test(r.stdout)
  }

  /**
   * 采集 ETW trace。
   * action=start → 起采样（等你复现）; stop → 停并产出 etl; run → 起→等 seconds 秒→停。
   * @returns {ok, etlPath?, seconds?, profile?, error?, hint?}
   */
  async function trace(args = {}) {
    const action = String(args.action || 'run').toLowerCase()
    const key = String(args.profile || 'cpu').toLowerCase()
    const profiles = CAPTURE_SETS[key]
    if (!profiles) return { ok: false, error: '未知 profile（可用 cpu | dotnet | general）' }
    if (!existsSync(c.wpr)) return { ok: false, error: 'wpr.exe 不存在：' + c.wpr + '（可用 DSH_PERF_WPR 指定）' }
    if (!(await isElevated())) {
      return { ok: false, error: 'ETW 内核会话需要管理员权限，当前进程未提权 —— 请以管理员身份运行 DSH', needsElevation: true }
    }

    const dir = runDir(args.tag)
    const etl = args.etlPath || join(dir, 'trace.etl')

    if (action === 'stop' || action === 'cancel') {
      const stopArgs = action === 'cancel' ? ['-cancel'] : ['-stop', etl]
      const r = await runExe(c.wpr, stopArgs, { timeoutMs: 300000 })
      if (action === 'cancel') return { ok: r.code === 0, cancelled: true, raw: (r.stdout + r.stderr).slice(0, 400) }
      if (!existsSync(etl)) return { ok: false, error: '停止后未生成 etl', raw: (r.stdout + r.stderr).slice(0, 400) }
      const size = statSync(etl).size
      return {
        ok: true, etlPath: etl, sizeBytes: size, profile: key, profiles,
        hint: '下一步用 perf_hotstacks(etlPath) 出调用链；可加 focus 只保留包含某模块/函数名的栈',
      }
    }

    // start / run
    mkdirSync(dir, { recursive: true })
    // 多个预设用多个 -start 串联（实测：只开 CPU 时托管帧**函数名解不出来**，必须带上 DotNet 才有 CLR rundown）
    const startArgs = []
    for (const p of profiles) startArgs.push('-start', p)
    startArgs.push('-filemode')
    const started = await runExe(c.wpr, startArgs, { timeoutMs: 180000 })
    if (started.code !== 0) {
      return { ok: false, error: 'wpr -start 失败', raw: (started.stdout + started.stderr).slice(0, 500), profiles }
    }
    if (action === 'start') {
      return { ok: true, started: true, profile: key, profiles, etlPath: etl, hint: '复现问题后调用 perf_trace(action="stop", etlPath=...)' }
    }
    const seconds = Math.min(Math.max(Number(args.seconds) || 20, 3), 600)
    await new Promise((r) => setTimeout(r, seconds * 1000))
    const stopped = await runExe(c.wpr, ['-stop', etl], { timeoutMs: 300000 })
    if (!existsSync(etl)) return { ok: false, error: 'wpr -stop 后未生成 etl', raw: (stopped.stdout + stopped.stderr).slice(0, 500) }
    return {
      ok: true, etlPath: etl, sizeBytes: statSync(etl).size, seconds, profile: key, profiles,
      hint: '下一步用 perf_hotstacks(etlPath) 出调用链；etl 可能数百 MB，出报告要几分钟（首次含符号下载）',
    }
  }

  /** 符号路径：显式配置 > 机器已有的 _NT_SYMBOL_PATH > 默认微软公网符号（带本地缓存）。 */
  function symbolEnv(offline) {
    const env = Object.assign({}, process.env)
    if (offline) { delete env._NT_SYMBOL_PATH; return env }
    if (c.symbolPath) { env._NT_SYMBOL_PATH = c.symbolPath }
    else if (process.env._NT_SYMBOL_PATH) { env._NT_SYMBOL_PATH = process.env._NT_SYMBOL_PATH }
    else {
      const cache = join(c.evidenceDir, 'symbols')
      try { mkdirSync(cache, { recursive: true }) } catch { /* ignore */ }
      env._NT_SYMBOL_PATH = 'srv*' + cache + '*https://msdl.microsoft.com/download/symbols'
    }
    // symcache：xperf 的符号缓存（第二次出报告会快很多）
    if (!env._NT_SYMCACHE_PATH) {
      const sc = join(c.evidenceDir, 'symcache')
      try { mkdirSync(sc, { recursive: true }) } catch { /* ignore */ }
      env._NT_SYMCACHE_PATH = sc
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
    if (!args.offline) cmd.push('-symbols')
    cmd.push('-i', etl, '-o', outHtml, '-a', 'stack', '-butterfly', String(minHits))
    if (args.process || c.procName) cmd.push('-process', String(args.process || c.procName))
    if (args.focus) cmd.push('-symbol', String(args.focus))
    const t0 = Date.now()
    const r = await runExe(c.xperf, cmd, { timeoutMs: Number(args.timeoutMs) || 900000, env: symbolEnv(!!args.offline) })
    // 端到端实测踩到的假成功：xperf 被超时杀掉后仍留了一个**空报告文件**，
    // 原实现只看"文件是否存在"就报 ok:true，返回一个空结果 —— 调用方会以为"没有热点"。
    if (r.timedOut) {
      return {
        ok: false, timedOut: true, etlPath: etl, reportPath: existsSync(outHtml) ? outHtml : null,
        error: 'xperf 出报告超时（' + (Date.now() - t0) + 'ms）。系统级 trace 很慢，建议：① 加 process 过滤（只分析目标进程）；' +
          '② 用 focus 缩小 -symbol 范围；③ 调大 timeoutMs；④ 该 etl 是否过大（可用更短采集时长重采）',
      }
    }
    if (!existsSync(outHtml)) {
      return { ok: false, error: 'xperf 未产出报告', raw: (r.stdout + r.stderr).slice(0, 600) }
    }
    const html = readFileSync(outHtml, 'utf8')
    const parsed = parseStackReport(html)
    parsed.__etl = etl
    const s = summarize(parsed, { topN, focus: args.focus })
    if (!s.hotCount && !s.chainCount) {
      // 空报告 = 失败，不是"没有热点"（没读到 ≠ 没有）
      return Object.assign({
        ok: false, etlPath: etl, reportPath: outHtml, reportBytes: statSync(outHtml).size,
        error: '报告里没有可解析的函数条目 —— 不要当成"没有热点"。可能原因：符号未解析（确认已装符号/网络可达）、' +
          'focus 过滤太严、xperf 输出为空。可先去掉 focus 重跑一次看有没有内容。',
        text: s.text,
      }, s)
    }
    return Object.assign({
      ok: true, etlPath: etl, reportPath: outHtml, reportBytes: statSync(outHtml).size,
      focus: args.focus || null, process: args.process || c.procName || null,
      symbols: !args.offline, elapsedMs: Date.now() - t0,
    }, s)
  }

  return { trace, hotstacks, isElevated, parseStackReport, symbolEnv, config: () => c }
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

  const allNames = hotFunctions.map((f) => f.name).concat(butterfly.map((b) => b.name))
  const unknown = allNames.filter((n) => /\*\*\*unknown\*\*\*/.test(n)).length
  const unknownRatio = allNames.length ? unknown / allNames.length : 0

  return { processes, modules, hotFunctions, butterfly, unknownRatio, totalSamples: hotFunctions.reduce((a, f) => Math.max(a, f.exclusive), 0) }
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
    lines.push('符号未解析比例: ' + (parsed.unknownRatio * 100).toFixed(0) + '%' +
      (parsed.unknownRatio > 0.5 ? '  ⚠️ 大量帧未解析 —— 先配好符号（DSH_PERF_SYMBOL_PATH）再看结论' : ''))
  }
  lines.push('')
  lines.push('## 最热函数（按包含命中 inclusive）')
  for (const f of hot) lines.push('  ' + String(f.percent).padStart(7) + '  ' + f.name + '   (excl ' + f.exclusive + ')')
  if (!hot.length) lines.push('  （没有解析出函数 —— 报告为空或过滤太严）')
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
    hotCount: hot.length,
    chainCount: chains.length,
    hotFunctions: hot,
    chains,
    processes: (parsed.processes || []).slice(0, 10),
  }
}
