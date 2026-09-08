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
import { spawn } from 'node:child_process'
import { join, basename, relative } from 'node:path'
import { homedir } from 'node:os'

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

function isUserFrame(frame) {
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
  const re = new RegExp('\\b' + escapeRe(methodName) + '\\s*\\(')
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
  if (topUser !== null) {
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）停留在 ${topUser.type}.${topUser.method}() —— 该方法疑似死循环或长时间阻塞。`
  } else if (frames.length > 0) {
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）停留在 ${frames[0].type || '?'}.${frames[0].method || '?'}() —— 长时间阻塞（系统/框架代码，可能是同步等待或人为注入）。`
  } else {
    report.diagnosis = `UI 线程（托管 ID ${t.managedId}，OS 线程 ${t.osId}）没有托管栈帧。`
  }
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
  const uiDrive = config.uiDrive ?? (env.DSH_HANG_UI_DRIVE || join(homedir(), '.dsh-agent-toolchain'))
  const packs = config.packs ?? (env.DSH_HANG_EVIDENCE_DIR || join(uiDrive, 'hang-evidence'))
  const hangLoop = config.hangLoop ?? (env.DSH_HANG_LOOP_SCRIPT || join(uiDrive, 'hang-loop.ps1'))
  // 客户端是 x86 进程：dump 必须用 x86 的 DumpStack 分析（x64 进程加载不了 32 位 DAC）
  const dumpStack = config.dumpStack ?? (env.DSH_HANG_DUMPSTACK || join(uiDrive, 'tools', 'dumpstack', 'publish-x86', 'DumpStack.exe'))
  // 与 dump 内 CLR 版本匹配的 mscordacwks.dll（从微软符号服务器下载后放这里）
  const dacDir = config.dacDir ?? (env.DSH_HANG_DAC_DIR || join(uiDrive, 'tools', 'dac'))
  const srcRoot = config.srcRoot ?? (env.DSH_HANG_SRC_ROOT || '')
  const runDir = config.runDir ?? (env.DSH_HANG_RUN_DIR || join(uiDrive, '.hang-run'))
  const capture = config.capture ?? runCapture
  const RUN_STATE_FILE = join(runDir, 'run.json')
  const RUN_LOG = join(runDir, 'run.log')

  /**
   * 真实 pwsh.exe 路径。WindowsApps 别名在 detached 模式下会静默秒退（exit 0、
   * 无任何输出），必须解析到真实包路径并去掉 detached 才能正常执行。
   */
  function pwshPath() {
    if (config.pwsh !== undefined) return config.pwsh
    const override = env.DSH_HANG_PWSH
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

  function runIsActive() {
    return runState !== null && runState.status === 'running' && pidAlive(runState.pid)
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
    }
    return { ...st, logTail: logTail(runState?.logPath, 150) }
  }

  /** Start the hang monitor (no auto-clicking; the user drives the client). */
  function startRun({ maxSeconds = 0 } = {}) {
    if (runIsActive()) return { ok: false, error: '监测已在运行', run: runState }
    const max = clampInt(maxSeconds, 0, 86400, 0)
    if (!existsSync(hangLoop)) return { ok: false, error: `未找到监测脚本：${hangLoop}` }
    mkdirSync(runDir, { recursive: true })
    const logPath = join(runDir, 'run.log')
    const fd = openSync(logPath, 'w')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', hangLoop, '-MaxSeconds', String(max), '-OutDir', packs]
    let child
    try {
      child = spawn(pwshPath(), args, { windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (e) {
      return { ok: false, error: `启动失败: ${e}` }
    }
    runState = { pid: child.pid, startedAt: Date.now(), status: 'running', exitCode: null, logPath }
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
    return { ok: true, started: true, run: { ...runState } }
  }

  /** Kill the run tree. */
  function stopRun() {
    if (!runIsActive()) return { stopped: false, reason: 'not-running' }
    spawn('taskkill', ['/PID', String(runState.pid), '/T', '/F'], { windowsHide: true })
    runState.status = 'stopping'
    persistRun()
    return { stopping: true }
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
      writeState(report)
    } catch (e) {
      writeState({
        status: 'error',
        error: String(e && e.message !== undefined ? e.message : e).slice(0, 2000),
        finishedAt: Date.now(),
      })
    }
  }

  /**
   * (Re)run the stack analysis for one pack and, when `wait` is true, resolve
   * with the finished analysis. Without `wait` it returns as soon as the run
   * starts (the panel polls readAnalysis).
   */
  async function analyze(id, { wait = false, waitMs = 300000, pollMs = 1000 } = {}) {
    const dir = packDir(id)
    if (dir === null) return { ok: false, error: 'pack not found' }
    const cur = readJsonFile(join(dir, 'analysis.json'))
    const running =
      cur !== null && cur.status === 'running' && Date.now() - (cur.startedAt ?? 0) < ANALYSIS_RUNNING_TTL
    if (!running) {
      // fire-and-forget unless the caller asked to wait; never unhandled-reject
      const done = analyzePack(dir).catch(() => {})
      if (!wait) return { ok: true, status: 'running', startedAt: Date.now() }
      const timer = new Promise((resolve) => setTimeout(resolve, waitMs))
      await Promise.race([done, timer])
    } else if (!wait) {
      return { ok: true, ...cur }
    }
    const out = readAnalysis(id) ?? { status: 'none' }
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
