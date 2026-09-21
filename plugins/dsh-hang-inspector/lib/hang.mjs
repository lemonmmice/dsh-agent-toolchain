/**
 * dsh-hang-inspector — reusable core (host plugin + MCP server share it).
 *
 * One hang-diagnosis workflow, three consumers:
 *   - the 「卡死分析」 web panel (plugins/dsh-hang-inspector/lib/index.js routes)
 *   - the MCP server (mcp/server.mjs hang_* tools)
 *   - unit tests (test/hang.test.mjs, temp evidence dir + injected runner)
 *
 * The core is deliberately transport-free: every method returns plain JSON and
 * never touches req/res. Evidence packs live under `packs` (default
 * ~/.dsh-agent-toolchain/hang-evidence, DSH_HANG_EVIDENCE_DIR overrides).
 *
 * Destructive methods (`removePack` / `removeAllPacks` / `analyze`) are exposed
 * as-is — callers own the confirmation policy (the MCP tools require an
 * explicit confirm flag for deletion).
 */
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, basename, relative, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
// F-007：宿主不热加载插件代码 —— 卡死取证自己说出"我跑的是不是磁盘上那份"。
import { staleCodeInfo, moduleRoots } from '../../../lib/code-freshness.mjs'
import { resolveDumpTools } from '../../../lib/dump-tools.mjs'
// 配置读法要和工具链其余部分一致（进程环境 → 用户级注册表 → 机器级）—— 见 makeHangInspector 里的说明。
import { envOr } from '../../../lib/env-fallback.mjs'
import { decodeBuffer } from '../../../lib/decode.mjs'

/** 本插件目录（仓库与 profile 两种布局下都成立）。 */
const HANG_PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** Frames from these namespaces count as framework/3rd-party, not project code. */
const USER_FRAME_RE =
  /^(System\.|Microsoft\.|MS\.|Windows|mscorlib|Presentation|WindowsBase|ControlzEx|HandyControl|Hardcodet|LiveCharts|SciChart|Caliburn|Prism|DryIoc|Accessibility|UIAutomation|GalaSoft|NLog|log4net|Newtonsoft|ICSharpCode|Xceed|Syncfusion|DevExpress|Animat|DynamicClass)/i

const SKIP_DIRS = new Set(['bin', 'obj', '.git', '.vs', 'packages', 'node_modules', '.codex'])

/** Per-file cap for text evidence returned to a caller. */
const MAX_TEXT = 512 * 1024

/** How long a 'running' analysis marker stays authoritative. */
const ANALYSIS_RUNNING_TTL = 15 * 60 * 1000

/** Text evidence file keys served in pack detail. */
const TEXT_KEYS = [
  ['summary', 'summary.txt'],
  ['processInfo', 'process-info.txt'],
  ['traceTail', 'net-trace-tail.txt'],
  ['echo', 'ui-probe-echo.txt'],
  ['echoErr', 'ui-probe-echo.err.txt'],
  ['procdumpOut', 'procdump.out.txt'],
  ['procdumpErr', 'procdump.err.txt'],
]

/**
 * 帧名是否"有真名字"。占位符（`?` / 空 / `***unknown***`）**不是**用户代码 ——
 * 它们是"没解析出来"，把它当成业务帧会导致下面的错误结论：
 *   诊断写成"停留在 ?.?() —— **该方法疑似死循环或长时间阻塞**"，
 * 即**把一帧没解析出来的东西断言成"你的某个方法有问题"**。
 * （2026-09-12 我自己构造中段未解析样例时抓到；真机那份 WPF dump 里未解析帧的 type 是**空串**，
 *   所以真机上恰好没触发 —— 属"潜伏"型缺陷，换个 DumpStack 版本/指针就能触发。）
 */
function isPlaceholderName(s) {
  const v = String(s ?? '').trim()
  return v === '' || v === '?' || v === '??' || /^\*+unknown\*+$/i.test(v) || /\*\*\*unknown\*\*\*/i.test(v)
}

function isUserFrame(frame) {
  if (isPlaceholderName(frame.type) || isPlaceholderName(frame.method)) return false
  return typeof frame.type === 'string' && frame.type !== '' && !USER_FRAME_RE.test(frame.type)
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function skipSegment(rel) {
  return rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg.toLowerCase()))
}

/** Read a JSON file (null when missing/broken). */
function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** Clamp an integer parameter to a safe range. */
export function clampInt(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Spawn a program and capture stdout/stderr (capped). */
export function runCapture(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, stdout, stderr: String(e) })
      return
    }
    child.stdout.on('data', (d) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += d
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 2 * 1024 * 1024) stderr += d
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Find the .cs file declaring a type (filename match first, content scan fallback). */
export function findSourceFile(srcRoot, simpleType) {
  if (!existsSync(srcRoot)) return null
  const want = simpleType.toLowerCase() + '.cs'
  let entries
  try {
    entries = readdirSync(srcRoot, { recursive: true })
  } catch {
    return null
  }
  for (const rel of entries) {
    if (skipSegment(rel)) continue
    if (rel.toLowerCase().endsWith(want)) return join(srcRoot, rel)
  }
  const re = new RegExp('\\b(?:class|struct)\\s+' + escapeRe(simpleType) + '\\b')
  let scanned = 0
  let bytes = 0
  for (const rel of entries) {
    if (skipSegment(rel) || !rel.toLowerCase().endsWith('.cs')) continue
    const p = join(srcRoot, rel)
    let text
    try {
      if (statSync(p).size > 200 * 1024) continue
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    bytes += text.length
    scanned += 1
    if (re.test(text)) return p
    if (scanned > 40000 || bytes > 96 * 1024 * 1024) break
  }
  return null
}

/** Locate a method DECLARATION in file text and extract its body (line-numbered). */
export function extractMethod(text, methodName) {
  const re = new RegExp('\\b' + escapeRe(methodName) + '\\s*\\(', 'g')
  let idx = -1
  for (;;) {
    const m = re.exec(text)
    if (m === null) return null
    // 判断声明还是调用：看方法名前的非空白字符与前一 token
    let k = m.index - 1
    while (k >= 0 && /\s/.test(text[k])) k--
    const beforeCh = k >= 0 ? text[k] : ''
    let tEnd = k + 1
    let tStart = k
    while (tStart > 0 && /[A-Za-z0-9_>]/.test(text[tStart - 1])) tStart--
    const prevToken = text.slice(tStart, tEnd)
    const callMarkers = new Set([';', '{', '}', '(', ')', '=', ',', '!', '.'])
    const callKeywords = new Set(['new', 'return', 'if', 'while', 'switch', 'throw', 'using', 'case', 'await', 'typeof', 'nameof'])
    if (callMarkers.has(beforeCh) || callKeywords.has(prevToken)) {
      re.lastIndex = m.index + 1
      continue
    }
    idx = m.index
    break
  }
  // 签名右括号（跳过泛型尖括号）
  let i = idx + methodName.length
  let depth = 0
  let started = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') {
      depth += 1
      started = true
    } else if (ch === ')') {
      depth -= 1
      if (started && depth === 0) break
    }
  }
  if (i >= text.length) return null
  // 跳过泛型约束 where ...
  let j = i + 1
  while (j < text.length && /\s/.test(text[j])) j++
  while (j < text.length && text.startsWith('where', j)) {
    j += 5
    while (j < text.length && text[j] !== '{' && text[j] !== ';') j++
    while (j < text.length && /\s/.test(text[j])) j++
  }
  let bodyStart = -1
  let bodyEnd = -1
  if (text[j] === '{') {
    bodyStart = j
    let depthB = 0
    let inStr = null
    for (let k2 = j; k2 < text.length; k2++) {
      const ch = text[k2]
      const next = text[k2 + 1]
      if (inStr !== null) {
        if (ch === '\\') {
          k2++
          continue
        }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'") {
        inStr = ch
        continue
      }
      if (ch === '/' && next === '/') {
        while (k2 < text.length && text[k2] !== '\n') k2++
        continue
      }
      if (ch === '/' && next === '*') {
        k2 += 2
        while (k2 < text.length && !(text[k2] === '*' && text[k2 + 1] === '/')) k2++
        k2++
        continue
      }
      if (ch === '{') depthB++
      else if (ch === '}') {
        depthB--
        if (depthB === 0) {
          bodyEnd = k2
          break
        }
      }
    }
  } else if (text.slice(j, j + 2) === '=>') {
    bodyStart = j
    const semi = text.indexOf(';', j)
    bodyEnd = semi === -1 ? j + 80 : semi
  }
  if (bodyStart === -1 || bodyEnd === -1) return null
  const lines = text.split('\n')
  const startLine = text.slice(0, idx).split('\n').length
  const endLine = text.slice(0, bodyEnd).split('\n').length
  const from = Math.max(1, startLine - 4)
  const to = Math.min(lines.length, endLine + 2)
  const picked = lines.slice(from - 1, to)
  if (picked.length > 140) {
    picked.splice(120)
    picked.push('…（方法过长，已截断）')
  }
  return {
    startLine: from,
    endLine: to,
    suspectLine: startLine,
    code: picked.map((l, n) => `${from + n}: ${l}`).join('\n'),
  }
}

/** Map a stack frame to project source code (null when not locatable). */
export function locateSource(srcRoot, frame) {
  const type = String(frame.type ?? '')
  const method = String(frame.method ?? '').split('`')[0]
  if (type === '' || method === '') return null
  const simpleType = type.split('.').pop().split('+').pop().split('<')[0].split('`')[0]
  const file = findSourceFile(srcRoot, simpleType)
  if (file === null) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const m = extractMethod(text, method)
  if (m === null) return null
  let rel = file
  try {
    rel = relative(srcRoot, file)
  } catch {
    // keep absolute path
  }
  return { file, rel, ...m }
}

/** Build the analysis report from DumpStack output. */
export function buildAnalysis(data, srcRoot = '') {
  const threads = Array.isArray(data.threads) ? data.threads : []
  const report = { tool: 'dumpstack', threadCount: threads.length }
  // **分析器自己的元数据必须带出来**（2026-09-12 真机 WPF 实测，第 15 处同型问题）：
  // DumpStack 的产物里本来就有 `engine / clrVersion / hostArchitecture / dumpArchitecture /
  // clrArchitecture / confidence / warnings / elapsedMs / dacPath`，而这里**只读了 threads**，
  // 其余全丢 —— 后果是"低置信度"或"分析器告警"的分析，和一次干净高置信度的分析，**在 agent 眼里一模一样**。
  // （DAC 不匹配、符号缺失这类事，DumpStack 会在 warnings 里说；丢了它就只能靠下游猜。）
  report.engine = data.engine ?? null
  report.clrVersion = data.clrVersion ?? null
  report.arch = {
    host: data.hostArchitecture ?? null,
    dump: data.dumpArchitecture ?? null,
    clr: data.clrArchitecture ?? null,
  }
  report.confidence = data.confidence ?? null
  report.analyzerWarnings = Array.isArray(data.warnings) ? data.warnings : []
  report.analyzerElapsedMs = Number.isFinite(data.elapsedMs) ? data.elapsedMs : null
  if (data.dacPath) report.dacPath = data.dacPath
  const uiThread = threads.find(
    (t) => Array.isArray(t.frames) && t.frames.some((f) => f.type === 'System.Windows.Threading.Dispatcher'),
  )
  let suspect = null
  let bestScore = -1
  for (const t of uiThread !== undefined ? [uiThread] : threads) {
    const userFrames = (t.frames ?? []).filter(isUserFrame)
    if (userFrames.length > bestScore) {
      bestScore = userFrames.length
      suspect = { thread: t, userFrames }
    }
  }
  if (suspect === null && threads.length > 0) {
    const t = threads[0]
    suspect = { thread: t, userFrames: (t.frames ?? []).filter(isUserFrame) }
  }
  if (suspect === null) {
    report.diagnosis = '未能从 dump 中解析出托管线程栈。'
    report.threadsSummary = []
    report.source = null
    return report
  }
  const t = suspect.thread
  const frames = Array.isArray(t.frames) ? t.frames : []
  const topUser = suspect.userFrames.length > 0 ? suspect.userFrames[0] : null
  // **"未解析帧"必须与"框架代码"区分开**（2026-09-12 真机 WPF 卡死实测）：
  //   真 WPF 受害者（Dispatcher 卡死）的栈顶是 `at ?.?()`、`at ?.IL_STUB_CLRtoCOM()` ——
  //   即**模块与符号都拿不到**，压根不是"我们看见了框架代码"。
  //   旧措辞直接说"停留在 系统/框架代码（可能是同步等待）"，把"看不到"说成了"看到了"：
  //   用户问"卡在哪一行"，这句会让人以为结论是"框架层的问题、你的代码没事" —— 而真相是
  //   我们**在最关键的那几帧上是瞎的**（根因往往就在其中）。所以这里分桶统计并如实回报。
  const isUnresolved = (f) => !f || isPlaceholderName(f.type) || isPlaceholderName(f.method)
  const unresolvedCount = frames.filter(isUnresolved).length
  const topUserIndex = topUser !== null ? frames.indexOf(topUser) : -1
  const unresolvedAbove = topUserIndex > 0 ? frames.slice(0, topUserIndex).filter(isUnresolved).length : 0
  const unresolvedTop5 = frames.slice(0, 5).filter(isUnresolved).length
  if (topUser !== null && unresolvedAbove === 0) {
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）停留在 ${topUser.type}.${topUser.method}() —— 该方法疑似死循环或长时间阻塞。`
  } else if (topUser !== null) {
    // 业务帧上方还有未解析帧：**不能**直接断言"该方法就是问题所在"（上方那几帧才是嫌疑更大的位置）
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）最上面的业务帧是 ${topUser.type}.${topUser.method}()，` +
      `但**它上方还有 ${unresolvedAbove} 个未解析帧**（缺模块/符号信息）—— 阻塞点可能在其上，不要直接据此下结论。`
  } else if (frames.length > 0) {
    // 栈顶就是未解析帧时，措辞必须改成"看不到"，不能写成"在框架代码里"
    report.diagnosis = unresolvedTop5 > 0
      ? `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）**栈顶 ${unresolvedTop5} 帧未能解析**（缺模块/符号信息）—— ` +
        `真正的阻塞点很可能就在这几帧里，**不要据此认为"卡在框架里、与业务代码无关"**。`
      : `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）停留在 ${frames[0].type || '?'}.${frames[0].method || '?'}() —— 长时间阻塞（系统/框架代码，可能是同步等待或人为注入）。`
  } else {
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）没有托管栈帧。`
  }
  report.unresolved = { count: unresolvedCount, total: frames.length, top5: unresolvedTop5, aboveUser: unresolvedAbove }
  report.suspectThread = { managedId: t.managedId, osId: t.osId }
  report.stackText = frames
    .slice(0, 25)
    .map((f) => `at ${f.type || '?'}.${f.method || '?'}()`)
    .join('\n')
  report.threadsSummary = threads.slice(0, 15).map((th) => {
    const fs = Array.isArray(th.frames) ? th.frames : []
    const uf = fs.find(isUserFrame)
    return {
      managedId: th.managedId,
      osId: th.osId,
      top: fs.length > 0 ? `${fs[0].type || '?'}.${fs[0].method || '?'}()` : '(空)',
      user: uf !== undefined ? `${uf.type}.${uf.method}()` : null,
    }
  })
  report.source = topUser !== null ? locateSource(srcRoot, topUser) : null
  return report
}

/** `frozen.dmp` 的指纹（体积 + 修改时间）—— 用来判断"这份分析是不是对着当前这个 dump 做的"。 */
export function dumpFingerprint(dumpPath) {
  try {
    const st = statSync(dumpPath)
    return { bytes: st.size, mtimeMs: Math.round(st.mtimeMs), at: new Date(st.mtimeMs).toISOString() }
  } catch {
    return null
  }
}

/** 两个指纹是否指向同一个 dump（缺任一指纹 = 无法判断，返回 null 交给调用方按"未知"处理）。 */
export function sameDump(a, b) {
  if (!a || !b) return null
  return a.bytes === b.bytes && Math.abs(Number(a.mtimeMs) - Number(b.mtimeMs)) < 2000
}

/** DAC 目录里的第一个 mscordacwks*.dll（与 dump 内 CLR 版本匹配时用）。 */
export function findDac(dir) {
  if (!existsSync(dir)) return null
  try {
    const names = readdirSync(dir).filter((n) => /^mscordacwks.*\.dll$/i.test(n))
    if (names.length > 0) return join(dir, names[0])
  } catch {
    // fall through
  }
  return null
}

/**
 * Build the hang-inspector core.
 *
 * @param {object} [config]
 * @param {string} [config.packs]     evidence root (default DSH_HANG_EVIDENCE_DIR)
 * @param {string} [config.uiDrive]   dir holding hang-loop.ps1 + DumpStack (default DSH_HANG_UI_DRIVE)
 * @param {string} [config.hangLoop]  monitor script (default DSH_HANG_LOOP_SCRIPT)
 * @param {string} [config.dumpStack] DumpStack.exe (default DSH_HANG_DUMPSTACK)
 * @param {string} [config.dacDir]    mscordacwks dir (default DSH_HANG_DAC_DIR)
 * @param {string} [config.srcRoot]   project source root (default DSH_HANG_SRC_ROOT)
 * @param {string} [config.runDir]    run state/log dir (default DSH_HANG_RUN_DIR)
 * @param {string} [config.pwsh]      powershell path (default DSH_HANG_PWSH)
 * @param {(exe: string, args: string[], timeoutMs: number) => Promise<{code:number,stdout:string,stderr:string}>} [config.capture]
 *        process runner (tests inject a fake so analysis is exercised without a real dump)
 */
export function makeHangInspector(config = {}) {
  const env = process.env
  // **全部配置统一走 env-fallback**（进程环境 → 用户级注册表 → 机器级），与 dsh-ui-drive / dsh-perf 一致。
  //
  // 修复（2026-09-11 真机实测；本仓第 14 处、也是最严重的一处"同型半修"）：
  //   本文件此前**所有**配置都直接读 `process.env`。而 DSH 宿主是**长活进程**，它的环境块里没有
  //   用户后来设置的用户级变量 —— 真机实测（用户已把目标进程名配在用户级环境变量里）：
  //     · procName 读成空 → `hang_run` 启动监测时**不带 -ProcName** → 监测脚本立刻
  //       `HANG_MONITOR_ERROR 未指定客户端进程名` 退出（状态里能看到这条日志）
  //       → **「用户报卡死」这条主线在现网根本起不来**（不是"检测不到"，是进程压根没开始工作）；
  //     · DSH_HANG_SRC_ROOT 读不到 → analyze 只能给「模块!类型.方法」，**拿不到代码级证据**（G3 不兑现）；
  //     · 证据目录/运行目录回落到默认位置 → 用户以为配置生效了，实际写去了别处。
  //   对照组：同一个仓库里 ui-drive 与 perf 的关键项早就走 envOr 了 —— 同一个工具链两种读法，
  //   于是"有的插件在现网能用、有的不能"，症状还都长得像"功能没做"。
  const cfgo = (name, fallback = '') => envOr(name, fallback)
  const uiDrive = config.uiDrive ?? (cfgo('DSH_HANG_UI_DRIVE') || join(homedir(), '.dsh-agent-toolchain'))
  const packs = config.packs ?? (cfgo('DSH_HANG_EVIDENCE_DIR') || join(uiDrive, 'hang-evidence'))
  // 监测脚本的解析顺序（2026-09-11 修：原先只看 uiDrive 一处，而本机那份脚本根本不在那儿 →
  // `hang_run` 直接失败「未找到监测脚本」，**"用户报卡死"这条主线开箱即坏**）：
  //   ① 显式配置/环境变量 → ② **插件自带的仓库副本**（now versioned: scripts/hang-loop.ps1）
  //   → ③ 本地工具目录 → ④ home 下的老位置。失败时把**试过哪些路径**全部列出来。
  const loopCandidates = (() => {
    if (config.hangLoop) return [config.hangLoop]
    const out = []
    if (cfgo('DSH_HANG_LOOP_SCRIPT')) out.push(cfgo('DSH_HANG_LOOP_SCRIPT'))
    // 插件自带副本：仓库布局 <repo>/plugins/dsh-hang-inspector/{lib,scripts} 与
    // profile 布局 <profile>/plugins/dsh-hang-inspector/{lib,scripts} 都成立
    out.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hang-loop.ps1'))
    out.push(join(uiDrive, 'hang-loop.ps1'))
    out.push(join(homedir(), '.dsh-agent-toolchain', 'hang-loop.ps1'))
    // 去重（uiDrive 默认就等于 homedir 那一路，否则"试过哪些路径"里会有重复项，看着像查了两次）
    return [...new Set(out)]
  })()
  const hangLoop = loopCandidates.find((p) => p && existsSync(p)) || loopCandidates[loopCandidates.length - 1]
  // 客户端是 x86 进程：dump 必须用 x86 的 DumpStack 分析（x64 进程加载不了 32 位 DAC）。
  // 三件套统一解析（与 dsh-perf 共用 lib/dump-tools.mjs）：给一个 procdump 路径就能推导出
  // DumpStack 与 dac —— 原先 hang 侧连 DSH_HANG_DUMPSTACK 都没在配置里出现过，
  // 结果是"证据包抓到了却分析不了"，而且报错只说"缺失"看不出是没配还是文件不在。
  const TOOLS = resolveDumpTools({
    procdumpEnv: ['DSH_HANG_PROCDUMP', 'DSH_PERF_PROCDUMP'],
    dumpstackEnv: ['DSH_HANG_DUMPSTACK', 'DSH_PERF_DUMPSTACK'],
    dacEnv: ['DSH_HANG_DAC_DIR', 'DSH_PERF_DAC_DIR'],
    toolsRoot: join(uiDrive, 'tools'),
  })
  const dumpStack = config.dumpStack ?? TOOLS.dumpstack
  const dacDir = config.dacDir ?? TOOLS.dacDir
  const srcRoot = config.srcRoot ?? cfgo('DSH_HANG_SRC_ROOT')
  const runDir = config.runDir ?? (cfgo('DSH_HANG_RUN_DIR') || join(uiDrive, '.hang-run'))
  const capture = config.capture ?? runCapture
  const RUN_STATE_FILE = join(runDir, 'run.json')
  const RUN_LOG = join(runDir, 'run.log')

  /**
   * 真实 pwsh.exe 路径。WindowsApps 别名在 detached 模式下会静默秒退（exit 0、
   * 无任何输出），必须解析到真实包路径并去掉 detached 才能正常执行。
   */
  function pwshPath() {
    if (config.pwsh !== undefined) return config.pwsh
    const override = cfgo('DSH_HANG_PWSH')
    if (override !== undefined && override !== '') return override
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      join(env.USERPROFILE ?? '', 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    ]
    for (const c of candidates) {
      if (!existsSync(c)) continue
      try {
        return realpathSync(c)
      } catch {
        return c
      }
    }
    return 'pwsh'
  }

  /** Persisted run state (survives host restarts). */
  let runState = readJsonFile(RUN_STATE_FILE)

  function persistRun() {
    try {
      mkdirSync(runDir, { recursive: true })
      writeFileSync(RUN_STATE_FILE, JSON.stringify(runState))
    } catch {
      // state persistence is best-effort
    }
  }

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * F-024（2026-09-12，r28 自查）：**pid 复用**。
   *
   * `pidAlive()` 只证明"**这个 pid 号**存在"，**不证明它还是我起的那次监测**。
   * Windows 会积极复用 pid，所以一份隔了很久的 `run.json` 里的 pid 完全可能已经被
   * **无关进程**占用（理论上甚至是用户的客户端）。两条后果，第二条是**安全性**问题：
   *   ① `runIsActive()` 误报"监测中" ⇒ `hang_run` 拒绝启动，agent 以为有监测在跑；
   *   ② `stopRun()` 会 `taskkill /PID <pid> /T /F` —— **杀掉那个无关进程以及它的整棵进程树**。
   *
   * 现在：pid 存活之后再核对**命令行**（必须包含 hang-loop 脚本路径）。
   * 查不到命令行时返回 `ours: null`（未知）——**宁可少杀，不可错杀**，并把判定如实回报。
   *
   * @returns {{ours: boolean|null, commandLine: string|null, error: string|null}}
   */
  function pidIdentity(pid) {
    try {
      // ★ Codex r29 证伪：**命令行里的字符串可以伪造** —— 它起了一个普通 node 进程、只在参数里带上
      //   `hang-loop.ps1`，就被判成 `match` 并被 `taskkill /T /F` 干掉了。
      //   所以再加一条**不易伪造**的判据：进程**创建时间**必须与 run.json 记录的 startedAt 相符。
      //   一个"被 pid 复用"或"故意伪造命令行"的进程，创建时间几乎不可能落在我们起监测的那个窗口里。
      const psCmd = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '"; '
        + 'if ($p -ne $null) { Write-Output ([string]$p.CommandLine); '
        + 'try { Write-Output ("__CREATED__" + ([datetime]$p.CreationDate).ToString("o")) } catch { Write-Output "__CREATED__unknown" } }'
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 })
      const out = String(r.stdout ?? '').trim()
      if (out === '') return { ours: null, commandLine: null, error: r.error ? String(r.error.message ?? r.error) : null }
      const lines = out.split(/\r?\n/)
      const commandLine = String(lines[0] ?? '').trim()
      const createdRaw = String(lines[1] ?? '').replace('__CREATED__', '').trim()
      const createdMs = (createdRaw === '' || createdRaw === 'unknown') ? NaN : Date.parse(createdRaw)
      const scriptName = basename(hangLoop)
      const cmdMatch = commandLine.includes(scriptName) || commandLine.includes(hangLoop)
      const ref = runState !== null && Number.isFinite(runState.startedAt) ? runState.startedAt : NaN
      // 容忍 120s：进程创建时刻与"我们写完 run.json"之间可能有解析/调度延迟，但绝不可能是小时级。
      const startMatch = (Number.isFinite(createdMs) && Number.isFinite(ref))
        ? (Math.abs(createdMs - ref) <= 120000)
        : null
      // ★★ Codex r30 把这套判据**证伪**了，结论我照收，并按它的结论改了这里的语义：
      //   ① 能**改写 run.json**（或控制自己启动参数）的同机进程**仍能伪造** —— 所以这是
      //      「命令行 + 创建时间的启发式**误杀防护**」，**不是身份认证**；
      //   ② 更糟的是我上一版的默认值：`ours = cmdMatch && startMatch !== false` ——
      //      **创建时间取不到（null）时也算"是我们"** ⇒ 一个**无法确认**的身份会被**杀掉**。
      //      对**破坏性**动作用这种默认值是错的。
      //   现在把两件事分开：
      //     · `confirmed` = **正面确认是我们**（两条判据都为真）—— 只有它才允许杀；
      //     · `excluded`  = **正面确认不是我们**（任一条判据为假）—— 用于把状态如实改成 exited。
      //   两者都为假 = **无法确认** ⇒ 不杀（并明说无法确认）。
      const confirmed = cmdMatch === true && startMatch === true
      const excluded = cmdMatch === false || startMatch === false
      return { ours: confirmed, confirmed, excluded, commandLine, createdMs, cmdMatch, startMatch, error: null }
    } catch (e) {
      return { ours: null, commandLine: null, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 只在"状态自称 running 且 pid 活着"时才去核对身份（避免给常态调用加开销）。 */
  function liveIdentity() {
    if (runState === null || runState.status !== 'running') return null
    if (!pidAlive(runState.pid)) return null
    const id = pidIdentity(runState.pid)
    runState.pidIdentity = id.ours === true ? 'match' : (id.ours === false ? 'reused' : 'unknown')
    if (id.commandLine !== null) runState.pidCommandLine = id.commandLine.slice(0, 400)
    // 身份判据的**依据**也要落盘：否则事后无法解释"为什么这次判它不是我们的"
    runState.pidIdentityBasis = {
      commandLineMatch: id.cmdMatch ?? null,
      creationTimeMatch: id.startMatch ?? null,
      processCreatedAt: Number.isFinite(id.createdMs) ? new Date(id.createdMs).toISOString() : null,
      recordedStartedAt: Number.isFinite(runState.startedAt) ? new Date(runState.startedAt).toISOString() : null,
    }
    persistRun()
    return id
  }

  /**
   * 把"为什么判它不是我们的"说**准**。
   *
   * 自查（写完上面那条创建时间判据之后）：拒杀时的文案还停留在第一版 —— 一律说
   * "命令行不含 hang-loop.ps1"。可**伪造命令行**那个用例里，命令行**恰恰含**这个字符串，
   * 真正的理由是**创建时间对不上**。于是工具用一句**可被当场证伪的解释**去说明自己的行为
   * —— 比不给理由更糟（会把人引向错误的判断）。
   */
  function identityWhy(id) {
    if (id === null) return '命令行查询失败'
    const bits = []
    if (id.cmdMatch === false) bits.push('命令行不含 hang-loop 脚本')
    if (id.startMatch === false) {
      const c = Number.isFinite(id.createdMs) ? new Date(id.createdMs).toISOString() : '未知'
      const r = runState !== null && Number.isFinite(runState.startedAt) ? new Date(runState.startedAt).toISOString() : '未知'
      bits.push(`进程创建时间与本次监测的开始时间对不上（进程创建于 ${c}，本次监测记录的开始时间是 ${r}）`)
    }
    if (id.startMatch === null && id.cmdMatch === true) {
      bits.push('命令行像监测，但**拿不到进程创建时间**（无法与本次监测的开始时间比对）—— 无法正面确认')
    }
    if (id.cmdMatch === null || id.cmdMatch === undefined) bits.push('拿不到命令行')
    return bits.length > 0 ? bits.join('；') : '身份判据未命中'
  }

  function runIsActive() {
    if (runState === null || runState.status !== 'running') return false
    if (!pidAlive(runState.pid)) return false
    const id = liveIdentity()
    // 这里保守：**只有"正面确认不是我们"** 才不当作在跑（宁可拒绝再起一个，也不要起两个监测）。
    // 杀不杀是另一回事 —— 见 stopRun：那里要求**正面确认**。
    if (id === null) return true
    return id.excluded !== true
  }

  /** Last N lines of the run log (empty string when absent). */
  function logTail(logPath, maxLines) {
    try {
      const p = logPath ?? RUN_LOG
      if (!existsSync(p)) return ''
      const text = readFileSync(p, 'utf8')
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
      return lines.slice(-maxLines).join('\n')
    } catch {
      return ''
    }
  }

  /** Read a text evidence file (null when missing, empty string when empty). */
  function readText(dir, file) {
    try {
      const p = join(dir, file)
      if (!existsSync(p)) return null
      if (statSync(p).size === 0) return ''
      const raw = readFileSync(p, 'utf8')
      return raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + '\n…(截断)' : raw
    } catch {
      return null
    }
  }

  /** Validate a pack id and resolve its directory (null when not a real pack). */
  function packDir(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) return null
    const dir = join(packs, id)
    return existsSync(dir) ? dir : null
  }

  /** Enumerate evidence packs, newest first. */
  function listPacks() {
    if (!existsSync(packs)) return []
    const out = []
    for (const name of readdirSync(packs)) {
      const dir = join(packs, name)
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const files = []
      for (const f of readdirSync(dir)) {
        try {
          files.push({ name: f, bytes: statSync(join(dir, f)).size })
        } catch {
          files.push({ name: f, bytes: 0 })
        }
      }
      const dump = files.find((f) => f.name === 'frozen.dmp')
      const summary = readText(dir, 'summary.txt') ?? ''
      const procInfo = readText(dir, 'process-info.txt') ?? ''
      const analysis = readJsonFile(join(dir, 'analysis.json'))
      out.push({
        id: name,
        ts: st.mtimeMs,
        files,
        dumpBytes: dump !== undefined ? dump.bytes : 0,
        hasScreenshot: files.some((f) => f.name === 'frozen-screen.png'),
        analysisStatus: analysis === null ? null : analysis.status ?? null,
        summaryFirst: (summary.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 200),
        procInfo: (procInfo.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 200),
      })
    }
    out.sort((a, b) => b.ts - a.ts)
    return out
  }

  /** Run status + log tail. */
  function runStatus() {
    const st = runState === null ? { status: 'idle' } : { ...runState }
    if (st.status === 'running' && !pidAlive(st.pid)) {
      st.status = 'exited'
      st.note = '进程已不在（宿主重启后无法取回退出码）'
    } else if (st.status === 'running') {
      // F-024：pid 活着**不等于**它还是我们的监测。这里把"身份判定"如实带出去 ——
      // 否则一个被复用的 pid 会让整份状态看起来"正在监测"（而真相是那次监测早就结束了）。
      const id = liveIdentity()
      st.pidIdentity = id === null ? 'unknown' : (id.confirmed === true ? 'match' : (id.excluded === true ? 'reused' : 'unknown'))
      if (id !== null && id.excluded === true) {
        st.status = 'exited'
        st.note = `★ 记录的 pid ${st.pid} **不是本次监测**（${identityWhy(id)}）。`
          + `为避免误杀，hang_stop 不会去动它。该 pid 现在的命令行：${String(id.commandLine).slice(0, 160)}`
      } else if (id === null || id.confirmed !== true) {
        st.note = `无法**正面确认** pid ${st.pid} 仍是本次监测（${identityWhy(id)}）。`
          + '按"可能仍在运行"处理，但出于安全，hang_stop **不会**在没有确认的情况下杀它'
          + '（监测脚本带 -MaxSeconds，会自行退出；也可先人工核对后再手工结束）。'
      } else {
        delete st.note
      }
    }
    // 卡死取证对"配置是否可用"最敏感：状态里必须能看到**脚本在哪、存在不存在、证据写哪、找过哪些路径**
    // —— 否则一次「未找到监测脚本」的失败只能靠猜（这正是本机实测踩到的）。
    const monitor = {
      scriptPath: hangLoop,
      scriptExists: existsSync(hangLoop),
      triedPaths: loopCandidates,
      evidenceDir: packs,
      evidenceDirExists: existsSync(packs),
      dumpStack: dumpStack,
      dumpStackExists: existsSync(dumpStack),
      dumpStackOrigin: TOOLS.origins.dumpstack,
      dacDir: dacDir,
      dacDirExists: existsSync(dacDir),
      procdump: TOOLS.procdump,
      procdumpExists: TOOLS.procdumpExists,
      toolWarnings: TOOLS.warnings,
      // ⚠ `toolWarnings: []` 本身**不能**区分"已检查且无告警"与"压根没检查"（Codex r17 指出的歧义）。
      //   真机上曾出现：`toolWarnings=[]` 看起来一切正常，而同一份状态里 status=exited、
      //   evidenceDirExists=false、logTail 报"未指定客户端进程名" —— 读者要从三处间接线索去猜。
      //   现在把"这三件套到底检查过没有"显式说出来。
      toolsChecked: true,
      toolsNote: TOOLS.warnings.length === 0
        ? '已检查 procdump/DumpStack/dac 三件套，均命中（无告警）'
        : '已检查三件套，有 ' + TOOLS.warnings.length + ' 条告警（见 toolWarnings）',
      // 目标进程名：**必须走 env-fallback** —— 这一项为空 = 监测脚本没有监视对象、启动即报错退出，
      // 是整个卡死主线的开关（真机实测：用户明明配了，宿主环境块里没有 → 读成空 → 主线起不来）。
      procName: cfgo('DSH_UI_PROC_NAME'),
      procNameConfigured: !!cfgo('DSH_UI_PROC_NAME'),
      // 源码根也必须能被**只读**看到（Claude 第十二轮）：否则 agent 只能先花时间跑一次 analyze
      // 才发现"没配源码根 → 拿不到代码级证据"。这条配置直接决定 G3 能不能兑现，属于预检项。
      srcRoot: srcRoot || '',
      srcRootConfigured: !!srcRoot,
      srcRootExists: !!srcRoot && existsSync(srcRoot),
    }
    // F-007：卡死取证对"代码版本"最敏感（修复旧代码时，工具行为与磁盘不一致会直接误导排查方向）
    return { ...st, monitor, logTail: logTail(runState?.logPath, 150), ...(staleCodeInfo(moduleRoots(HANG_PLUGIN_DIR)) || {}) }
  }

  /** Start the hang monitor (no auto-clicking; the user drives the client). */
  function startRun({ maxSeconds = 0 } = {}) {
    if (runIsActive()) return { ok: false, error: '监测已在运行', run: runState }
    const max = clampInt(maxSeconds, 0, 86400, 0)
    if (!existsSync(hangLoop)) {
      return {
        ok: false,
        error: `未找到监测脚本。按顺序试过：\n  ` + loopCandidates.join('\n  ') +
          '\n修复：用 DSH_HANG_LOOP_SCRIPT 指向你的脚本，或把脚本放到上面任一位置（插件自带一份在 plugins/dsh-hang-inspector/scripts/hang-loop.ps1）。',
        triedPaths: loopCandidates,
      }
    }
    mkdirSync(runDir, { recursive: true })
    const logPath = join(runDir, 'run.log')
    const fd = openSync(logPath, 'w')
    // 进程名可显式指定（默认取 DSH_UI_PROC_NAME）：没有它，脚本只能靠环境变量找客户端，
    // 也无法把监测指向一个**受控受害者**做验证（第一版就只能去挂真客户端）。
    const procName = config.procName ?? cfgo('DSH_UI_PROC_NAME')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', hangLoop,
      '-MaxSeconds', String(max), '-OutDir', packs]
    if (procName) args.push('-ProcName', String(procName))
    if (config.probeTimeoutMs) args.push('-ProbeTimeoutMs', String(config.probeTimeoutMs))
    if (config.intervalMs) args.push('-IntervalMs', String(config.intervalMs))
    if (config.consecutive) args.push('-Consecutive', String(config.consecutive))
    if (config.procdump) args.push('-Procdump', String(config.procdump))
    if (config.uiProbe) args.push('-UiProbe', String(config.uiProbe))
    if (config.traceLog) args.push('-TraceLog', String(config.traceLog))
    if (config.windowName) args.push('-WindowName', String(config.windowName))
    if (config.clientExe) args.push('-ClientExe', String(config.clientExe))
    if (config.noDump) args.push('-NoDump')
    let child
    try {
      child = spawn(pwshPath(), args, { windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (e) {
      return { ok: false, error: `启动失败: ${e}` }
    }
    // ⚠ `maxSeconds` 必须**存进 runState**（不只是参数）：渲染层要印「将在 N 秒后自动停止」，
    //   而 runStatus() 是把 runState 摊开返回的 —— 参数不落地，那句话就永远是空的（第 11 处形状漂移）。
    runState = { pid: child.pid, startedAt: Date.now(), status: 'running', exitCode: null, logPath, maxSeconds: max }
    child.on('exit', (code) => {
      runState.status = 'exited'
      runState.exitCode = code
      persistRun()
    })
    child.on('error', (e) => {
      runState.status = 'error'
      runState.error = String(e)
      persistRun()
    })
    child.unref()
    persistRun()
    // 顶层同时带上 `pid` / `maxSeconds` / `status`：DSH 面的 hang_run 渲染层直接吃这个对象
    // （它读的是 v.pid —— 只放在 v.run.pid 里就等于"启动了监测但 agent 看不到 pid"，
    //  而 pid 是随后跟 hang_status 核对「跑的是不是我刚起的那一个」的唯一凭据）。
    return { ok: true, started: true, pid: child.pid, status: 'running', maxSeconds: max, run: { ...runState } }
  }

  /** Kill the run tree. */
  function stopRun() {
    // 「本来就没在跑」必须**如实回报**（`stopped:false` + 原因）：渲染层过去只认 `killed`，
    // 于是这种情形会打出「已停止监测」——把"无事可做"说成了"我停了它"（第 12 处形状漂移）。
    if (runState === null || runState.status !== 'running') {
      return { ok: true, stopped: false, reason: 'not-running', pidIdentity: runState?.pidIdentity ?? null }
    }
    if (!pidAlive(runState.pid)) return { ok: true, stopped: false, reason: 'not-running', pidIdentity: null }
    // F-024 / Codex r30：**杀之前必须先"正面确认"它真的是我们的监测脚本**。
    // pid 复用 + `taskkill /T /F` 会连带杀掉一棵无关的进程树（最坏情况：用户的客户端）。
    // 判据不够强（能改 run.json 的同机进程仍能伪造）⇒ 定位是**误杀防护**，不是身份认证；
    // 而"无法确认"时**一律不杀**（宁可少杀，不可错杀）。
    const id = liveIdentity()
    if (id === null || id.confirmed !== true) {
      const unknown = id === null || id.excluded !== true
      return {
        ok: true,
        stopped: false,
        pid: runState.pid,
        pidIdentity: unknown ? 'unknown' : 'reused',
        reason: unknown ? 'pid-identity-unknown' : 'pid-reused',
        note: unknown
          ? `无法**正面确认** pid ${runState.pid} 就是本次监测`
            + `（${id === null ? '命令行查询失败' : identityWhy(id)}）—— 出于安全没有执行 taskkill。`
            + ' 若要强制结束：先人工核对进程，再手工 taskkill；监测脚本带 -MaxSeconds 也会自行退出。'
          : `pid ${runState.pid} 不是本次监测（${identityWhy(id)}）—— 为避免误杀，没有执行 taskkill。`,
      }
    }
    const pid = runState.pid
    // 第二处（同一轮自查）：**"下发了停止指令" ≠ "它真的停了"**。
    // 旧写法 `spawn('taskkill', ...)` 是 fire-and-forget，随即就返回 `stopped:true, killed:pid`，
    // 渲染层于是打出「已停止监测（结束进程树 X）」—— 如果 taskkill 因权限/pid 变化失败，
    // 这句话就是**把没做成的事说成了做成了**（本仓"说做了≠真做了"那一类）。
    // 现在：同步等 taskkill 结束，再**核对进程是否真的没了**，把结果如实带出去。
    const tk = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 15000 })
    const died = !pidAlive(pid)
    runState.status = died ? 'stopped' : 'stopping'
    runState.killVerified = died
    persistRun()
    // ⚠ Codex r29 抓到的**我自己造的**形状漂移：上一版这里把 `killVerified` **硬编码成 true**，
    //   于是"taskkill 回来了但进程还活着"时，机器可读字段说"已确认退出"，而同一对象的 note 却说
    //   "pid 仍然存活" —— **同一个返回里自相矛盾**，而下游只看字段。
    //   现在：`stopped` / `killed` / `killVerified` **三者都等于真实核对结果 died**，不许有第二个真值来源。
    return {
      ok: true,
      stopping: !died,
      stopped: died,
      pid,
      killed: died,
      killVerified: died,
      pidIdentity: 'match',
      taskkillExit: tk.status ?? null,
      taskkillOut: decodeBuffer(tk.stdout).text.trim().slice(0, 200) || null,
      ...(died ? {} : {
        note: `已下发 taskkill，但 **pid ${pid} 仍然存活**（taskkill 退出码 ${tk.status ?? 'n/a'}）`
          + ' —— 监测**可能还在跑**，请不要当作已停止；可再试一次或人工核对进程。',
      }),
    }
  }

  /** Full text evidence + file list for one pack (null when missing). */
  function packDetail(id) {
    const dir = packDir(id)
    if (dir === null) return null
    const files = []
    for (const f of readdirSync(dir)) {
      try {
        files.push({ name: f, bytes: statSync(join(dir, f)).size })
      } catch {
        files.push({ name: f, bytes: 0 })
      }
    }
    const texts = {}
    for (const [key, file] of TEXT_KEYS) texts[key] = readText(dir, file)
    const dump = files.find((f) => f.name === 'frozen.dmp')
    return {
      id: basename(dir),
      dir,
      files,
      texts,
      analysis: readJsonFile(join(dir, 'analysis.json')) ?? null,
      dumpBytes: dump !== undefined ? dump.bytes : 0,
      hasScreenshot: files.some((f) => f.name === 'frozen-screen.png'),
    }
  }

  /** Cached analysis.json for one pack (or {status:'none'}). */
  function readAnalysis(id) {
    const dir = packDir(id)
    if (dir === null) return null
    return readJsonFile(join(dir, 'analysis.json')) ?? { status: 'none' }
  }

  /** Delete one pack (true when it existed). */
  function removePack(id) {
    const dir = packDir(id)
    if (dir === null) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  }

  /** Delete every pack (count removed). */
  function removeAllPacks() {
    let deleted = 0
    if (existsSync(packs)) {
      for (const name of readdirSync(packs)) {
        try {
          rmSync(join(packs, name), { recursive: true, force: true })
          deleted += 1
        } catch {
          // locked file (e.g. dump still open) — skip and report
        }
      }
    }
    return deleted
  }

  /** Run DumpStack on frozen.dmp and write analysis.json into the pack dir. */
  async function analyzePack(dir) {
    const file = join(dir, 'analysis.json')
    const writeState = (obj) => {
      try {
        writeFileSync(file, JSON.stringify(obj, null, 2))
      } catch {
        // pack may have been deleted meanwhile
      }
    }
    writeState({ status: 'running', startedAt: Date.now() })
    const dump = join(dir, 'frozen.dmp')
    if (!existsSync(dump)) {
      writeState({ status: 'error', error: '证据包内没有 frozen.dmp', finishedAt: Date.now() })
      return
    }
    if (!existsSync(dumpStack)) {
      writeState({ status: 'error', error: `未找到 DumpStack.exe：${dumpStack}`, finishedAt: Date.now() })
      return
    }
    const dac = findDac(dacDir)
    const dumpstackOut = join(dir, 'dumpstack.json')
    const args = [dump, dumpstackOut]
    if (dac !== null) args.push(dac)
    try {
      const { code, stdout, stderr } = await capture(dumpStack, args, 300000)
      if (code !== 0) {
        const msg = (stderr || stdout || 'DumpStack 失败').slice(0, 1000)
        const hint =
          msg.includes('DAC') || msg.includes('no CLR runtime')
            ? '\n提示：dump 内 CLR 与本机 DAC 不匹配时，需从微软符号服务器下载对应版本的 mscordacwks.dll 放到 ' + dacDir
            : ''
        throw new Error(msg + hint)
      }
      const data = JSON.parse(stdout)
      const report = buildAnalysis(data, srcRoot)
      report.status = 'done'
      report.analyzedAt = new Date().toISOString()
      report.finishedAt = Date.now()
      // 记下**这次分析用的是哪个源码根**（2026-09-12 实测教训）：分析会**重跑并覆盖** analysis.json，
      // 而 srcRoot 是每次调用时的当前配置。若不记下来，之后就没人能解释"为什么这次没有源码定位"。
      report.srcRoot = srcRoot || ''
      report.srcRootConfigured = !!srcRoot
      // 记下这份分析是**对着哪个 dump** 做的（体积+修改时间）。
      // 为什么必须记（自查发现的缺口，2026-09-12）：改成"缓存优先"之后，如果 `frozen.dmp` 被**换成了新的**
      // 而 `analysis.json` 还在，缓存就变成了"steadily wrong" —— 永远拿旧 dump 的结论回答新 dump 的问题，
      // 而且看起来一切正常。有了指纹，`analyze()` 就能发现"dump 变了 → 缓存作废"。
      report.dumpFingerprint = dumpFingerprint(dump)
      writeState(report)
    } catch (e) {
      writeState({
        status: 'error',
        error: String(e && e.message !== undefined ? e.message : e).slice(0, 2000),
        finishedAt: Date.now(),
      })
    }
  }

  async function waitForAnalysis(done, waitMs) {
    let timer
    try {
      await Promise.race([done, new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * (Re)run the stack analysis for one pack and, when `wait` is true, resolve
   * with the finished analysis. Without `wait` it returns as soon as the run
   * starts (the panel polls readAnalysis).
   */
  async function analyze(id, { wait = false, waitMs = 300000, pollMs = 1000, refresh = false } = {}) {
    waitMs = clampInt(waitMs, 0, 2147483647, 300000)
    pollMs = clampInt(pollMs, 1, 2147483647, 1000)
    const dir = packDir(id)
    if (dir === null) return { ok: false, error: 'pack not found' }
    const cur = readJsonFile(join(dir, 'analysis.json'))
    const running =
      cur !== null && cur.status === 'running' && Date.now() - (cur.startedAt ?? 0) < ANALYSIS_RUNNING_TTL
    // **已完成的分析默认直接复用，不重跑**（2026-09-12 真机实测教训）：
    //   原先只要不是 running 就**无条件重跑并覆盖** analysis.json，而重跑用的是**当前**的 srcRoot。
    //   真机后果：先前在配好源码根时得到的那次分析（`源码定位：…:3`，也是用户要的那个答案）
    //   被我后一次"没配源码根"的调用**静默覆盖**掉了 —— 好证据反而被坏结果顶掉，
    //   而且同一份 dump 的结论会随调用者的环境变来变去（不可复现）。
    // 现在的语义：**缓存优先**；要按新配置重算，显式传 refresh=true（或删掉 analysis.json）。
    if (!running && !refresh && cur !== null && cur.status === 'done') {
      const nowFp = dumpFingerprint(join(dir, 'frozen.dmp'))
      const same = sameDump(cur.dumpFingerprint, nowFp)
      if (same === false) {
        const done0 = analyzePack(dir).catch(() => {})
        if (!wait) return { ok: true, status: 'running', startedAt: Date.now(), dumpChanged: true }
        await waitForAnalysis(done0, waitMs)
        const fresh = readAnalysis(id) ?? { status: 'none' }
        return { ok: fresh.status !== 'error', ...fresh, dumpChanged: true }
      }
      const out = { ok: true, ...cur, cached: true }
      if (same === null) out.fingerprintUnknown = true   // 老分析没记指纹 → 无法判断，如实说
      // 缓存是"没配源码根"时做的，而**现在**配了 ⇒ 重算能拿到源码定位。
      // 但**不自动重算**（自动重算就是当初那个"静默改变结论"的毛病），只在返回里提示，由调用方决定。
      if (cur.srcRootConfigured === false && srcRoot) out.srcRootUpgradeAvailable = true
      return out
    }
    if (!running) {
      // **refresh 也不该悄悄把好结果换成差结果**（Claude r16 的招牌发现让我复现到：我自己的验证脚本
      // 用 `refresh:true` + 空 srcRoot 重算了那个已带 `HangVictim.cs:3` 的包，把它又变成 source=null）。
      // 设计上 refresh 是"调用方的显式意图"，所以**不阻止**；但必须**如实标出这是一次退步**，
      // 否则使用者只会看到"我的源码定位怎么没了"。
      const losingSrcRoot = !!refresh && cur !== null && cur.srcRootConfigured === true && !srcRoot &&
        !!(cur.source && (cur.source.rel || cur.source.file))
      // fire-and-forget unless the caller asked to wait; never unhandled-reject
      const done = analyzePack(dir).catch(() => {})
      if (!wait) return { ok: true, status: 'running', startedAt: Date.now(), ...(losingSrcRoot ? { srcRootRegression: true } : {}) }
      await waitForAnalysis(done, waitMs)
      const after = readAnalysis(id) ?? { status: 'none' }
      return { ok: after.status !== 'error', ...after, ...(losingSrcRoot ? { srcRootRegression: true } : {}) }
    } else if (!wait) {
      return { ok: true, ...cur }
    }
    const deadline = Date.now() + waitMs
    let out = cur
    while (out.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
      const next = readAnalysis(id)
      if (next === null) return { ok: false, error: 'pack not found' }
      if (['running', 'done', 'error'].includes(next.status)) out = next
    }
    return { ok: out.status !== 'error', ...out }
  }

  return {
    packsDir: () => packs,
    runStatus,
    startRun,
    stopRun,
    listPacks,
    packDetail,
    readAnalysis,
    analyze,
    removePack,
    removeAllPacks,
    // exported for tests / reuse
    buildAnalysis,
    locateSource,
  }
}
