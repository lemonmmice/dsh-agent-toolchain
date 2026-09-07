/**
 * dsh-hang-inspector — host half.
 *
 * Serves the ui-drive hang-loop evidence packs for the 「卡死分析」 panel:
 * pack list, per-pack text evidence (summary / process-info / net-trace tail /
 * probe + procdump logs) and the frozen screenshot. Loopback-only; packs can
 * be deleted via DELETE routes.
 *
 * One-click workflow (「启动监测」 in the panel):
 *   POST /run            → spawn hang-loop.ps1 (main-window responsiveness monitor;
 *                          the user drives the client; hang detection collects evidence)
 *   GET  /run            → run status + log tail
 *   POST /run/stop       → taskkill the run tree
 *   POST /packs/{id}/analyze → run DumpStack (ClrMD) on frozen.dmp, map the
 *   GET  /packs/{id}/analysis → analysis.json (diagnosis + project source code)
 * hang thread's stack to source files under SRC_ROOT and write analysis.json.
 */
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, basename, relative } from 'node:path'
import { homedir } from 'node:os'

export const name = 'hang-inspector'

export const inject = ['webServer', 'systemPrompt']

/** Route family prefix. */
const API = '/api/dsh-hang-inspector'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 142

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-hang-inspector 插件（DSH Web GUI 的卡死分析面板）：侧边栏「卡死分析」入口，提供一键卡死诊断工作流——面板「启动监测」按钮拉起 hang-loop 主窗口响应监测（不自动点击，用户自行操作客户端），检测到客户端卡死后自动收集证据包（冻结截图 / 概要时间线 / 进程信息 / net-trace 尾部 / 探针与 procdump 日志 / 完整 dump），并可自动分析 dump 中的托管线程栈、定位卡死线程并映射到项目源码展示代码问题。证据目录默认 ~/.dsh-agent-toolchain/hang-evidence（环境变量 DSH_HANG_EVIDENCE_DIR 可覆盖）；项目源码根目录由 DSH_HANG_SRC_ROOT 指定。' +
  '面板可删除单个证据包或清空全部（本地删除，不可恢复）。' +
  '用户提到「卡死分析 / 压测证据 / 看 dump / 卡死证据 / 堆栈分析」时即指本插件，请据此协作。'

/** Evidence root (env override for portability). */
function evidenceDir() {
  return process.env.DSH_HANG_EVIDENCE_DIR || join(homedir(), '.dsh-agent-toolchain', 'hang-evidence')
}

// ---------------------------------------------------------------- stress run

/** ui-drive integration: stress script, dump stack tool, client source root. */
const UI_DRIVE = process.env.DSH_HANG_UI_DRIVE || join(homedir(), '.dsh-agent-toolchain')
const HANG_LOOP = process.env.DSH_HANG_LOOP_SCRIPT || join(UI_DRIVE, 'hang-loop.ps1')
// 客户端是 x86 进程：dump 必须用 x86 的 DumpStack 分析（x64 进程加载不了 32 位 DAC）
const DUMPSTACK = process.env.DSH_HANG_DUMPSTACK || join(UI_DRIVE, 'tools', 'dumpstack', 'publish-x86', 'DumpStack.exe')
// 与 dump 内 CLR 版本匹配的 mscordacwks.dll（从微软符号服务器下载后放这里）
const DAC_DIR = process.env.DSH_HANG_DAC_DIR || join(UI_DRIVE, 'tools', 'dac')
const SRC_ROOT = process.env.DSH_HANG_SRC_ROOT || ''
const RUN_DIR = join(UI_DRIVE, '.hang-run')
const RUN_STATE_FILE = join(RUN_DIR, 'run.json')
const RUN_LOG = join(RUN_DIR, 'run.log')

/**
 * 真实 pwsh.exe 路径。WindowsApps 别名在 detached 模式下会静默秒退（exit 0、
 * 无任何输出），必须解析到真实包路径并去掉 detached 才能正常执行。
 */
function pwshPath() {
  const override = process.env.DSH_HANG_PWSH
  if (override !== undefined && override !== '') return override
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
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

/** Read a JSON file (null when missing/broken). */
function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** Persisted run state (survives host restarts). */
let runState = readJsonFile(RUN_STATE_FILE)

function persistRun() {
  try {
    mkdirSync(RUN_DIR, { recursive: true })
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

// --------------------------------------------------------------- dump analysis

/** Frames from these namespaces count as framework/3rd-party, not project code. */
const USER_FRAME_RE =
  /^(System\.|Microsoft\.|MS\.|Windows|mscorlib|Presentation|WindowsBase|ControlzEx|HandyControl|Hardcodet|LiveCharts|SciChart|Caliburn|Prism|DryIoc|Accessibility|UIAutomation|GalaSoft|NLog|log4net|Newtonsoft|ICSharpCode|Xceed|Syncfusion|DevExpress|Animat|DynamicClass)/i

function isUserFrame(frame) {
  return typeof frame.type === 'string' && frame.type !== '' && !USER_FRAME_RE.test(frame.type)
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SKIP_DIRS = new Set(['bin', 'obj', '.git', '.vs', 'packages', 'node_modules', '.codex'])

function skipSegment(rel) {
  return rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg.toLowerCase()))
}

/** Find the .cs file declaring a type (filename match first, content scan fallback). */
function findSourceFile(srcRoot, simpleType) {
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
function extractMethod(text, methodName) {
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
function locateSource(srcRoot, frame) {
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
function buildAnalysis(data) {
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
  report.source = topUser !== null ? locateSource(SRC_ROOT, topUser) : null
  return report
}

/** Spawn a program and capture stdout/stderr (capped). */
function runCapture(exe, args, timeoutMs) {
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

const ANALYSIS_RUNNING_TTL = 15 * 60 * 1000

/** DAC 目录里的第一个 mscordacwks*.dll（与 dump 内 CLR 版本匹配时用）。 */
function findDac(dir) {
  if (!existsSync(dir)) return null
  try {
    const names = readdirSync(dir).filter((n) => /^mscordacwks.*\.dll$/i.test(n))
    if (names.length > 0) return join(dir, names[0])
  } catch {
    // fall through
  }
  return null
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
  if (!existsSync(DUMPSTACK)) {
    writeState({ status: 'error', error: `未找到 DumpStack.exe：${DUMPSTACK}`, finishedAt: Date.now() })
    return
  }
  const dac = findDac(DAC_DIR)
  const dumpstackOut = join(dir, 'dumpstack.json')
  const args = [dump, dumpstackOut]
  if (dac !== null) args.push(dac)
  try {
    const { code, stdout, stderr } = await runCapture(DUMPSTACK, args, 300000)
    if (code !== 0) {
      const msg = (stderr || stdout || 'DumpStack 失败').slice(0, 1000)
      const hint =
        msg.includes('DAC') || msg.includes('no CLR runtime')
          ? '\n提示：dump 内 CLR 与本机 DAC 不匹配时，需从微软符号服务器下载对应版本的 mscordacwks.dll 放到 ' + DAC_DIR
          : ''
      throw new Error(msg + hint)
    }
    const data = JSON.parse(stdout)
    const report = buildAnalysis(data)
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

/** Read one request body as JSON (bounded). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/** Clamp an integer parameter to a safe range. */
function clampInt(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

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

/** Per-file cap for text evidence returned to the browser. */
const MAX_TEXT = 512 * 1024

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
  const dir = join(evidenceDir(), id)
  return existsSync(dir) ? dir : null
}

/** Enumerate evidence packs, newest first. */
function listPacks() {
  const root = evidenceDir()
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
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

/** Loopback literal check plus browser same-origin markers (mirrors dsh-api-visualizer's fence). */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Build the route family. */
function makeRoutes() {
  return [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname
        const rest = pathname.startsWith(API) ? pathname.slice(API.length) : pathname

        // GET / — probe
        if (method === 'GET' && (rest === '' || rest === '/')) {
          writeJson(res, 200, { name: 'dsh-hang-inspector', api: API, ok: true, evidenceDir: evidenceDir() })
          return
        }

        // GET /packs — pack list (no text bodies, keep it light)
        if (method === 'GET' && rest === '/packs') {
          const items = listPacks()
          writeJson(res, 200, { total: items.length, items })
          return
        }

        // GET /packs/{id}/screenshot — frozen screen PNG
        const shotMatch = rest.match(/^\/packs\/([^/]+)\/screenshot$/)
        if (method === 'GET' && shotMatch !== null) {
          const dir = packDir(decodeURIComponent(shotMatch[1]))
          const file = dir === null ? null : join(dir, 'frozen-screen.png')
          if (file === null || !existsSync(file)) {
            writeJson(res, 404, { error: 'screenshot not found' })
            return
          }
          const buf = readFileSync(file)
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': buf.length,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end(buf)
          return
        }

        // GET /packs/{id} — full text evidence + file list
        const packMatch = rest.match(/^\/packs\/([^/]+)$/)
        if (method === 'GET' && packMatch !== null) {
          const dir = packDir(decodeURIComponent(packMatch[1]))
          if (dir === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
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
          writeJson(res, 200, {
            id: basename(dir),
            dir,
            files,
            texts,
            analysis: readJsonFile(join(dir, 'analysis.json')) ?? null,
            dumpBytes: dump !== undefined ? dump.bytes : 0,
            hasScreenshot: files.some((f) => f.name === 'frozen-screen.png'),
          })
          return
        }

        // DELETE /packs — clear every evidence pack
        if (method === 'DELETE' && rest === '/packs') {
          const root = evidenceDir()
          let deleted = 0
          if (existsSync(root)) {
            for (const name of readdirSync(root)) {
              try {
                rmSync(join(root, name), { recursive: true, force: true })
                deleted += 1
              } catch {
                // locked file (e.g. dump still open) — skip and report
              }
            }
          }
          writeJson(res, 200, { deleted })
          return
        }

        // DELETE /packs/{id} — delete one evidence pack
        const delMatch = rest.match(/^\/packs\/([^/]+)$/)
        if (method === 'DELETE' && delMatch !== null) {
          const dir = packDir(decodeURIComponent(delMatch[1]))
          if (dir === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          rmSync(dir, { recursive: true, force: true })
          writeJson(res, 200, { deleted: basename(dir) })
          return
        }

        // ---- hang monitor run (「启动监测」) ----

        // GET /run — run status + log tail
        if (method === 'GET' && rest === '/run') {
          const st = runState === null ? { status: 'idle' } : { ...runState }
          if (st.status === 'running' && !pidAlive(st.pid)) {
            st.status = 'exited'
            st.note = '进程已不在（宿主重启后无法取回退出码）'
          }
          writeJson(res, 200, { ...st, logTail: logTail(runState?.logPath, 150) })
          return
        }

        // POST /run — start the hang monitor (no auto-clicking; user drives the client)
        if (method === 'POST' && rest === '/run') {
          if (runIsActive()) {
            writeJson(res, 409, { error: '监测已在运行', run: runState })
            return
          }
          let body = {}
          try {
            body = await readBody(req, 64 * 1024)
          } catch {
            // treat unparsable body as {}
          }
          const maxSeconds = clampInt(body.maxSeconds, 0, 86400, 0)
          if (!existsSync(HANG_LOOP)) {
            writeJson(res, 500, { error: `未找到监测脚本：${HANG_LOOP}` })
            return
          }
          mkdirSync(RUN_DIR, { recursive: true })
          const logPath = join(RUN_DIR, 'run.log')
          const fd = openSync(logPath, 'w')
          const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', HANG_LOOP, '-MaxSeconds', String(maxSeconds), '-OutDir', evidenceDir()]
          let child
          try {
            child = spawn(pwshPath(), args, { windowsHide: true, stdio: ['ignore', fd, fd] })
          } catch (e) {
            writeJson(res, 500, { error: `启动失败: ${e}` })
            return
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
          writeJson(res, 202, { started: true, run: runState })
          return
        }

        // POST /run/stop — kill the run tree
        if (method === 'POST' && rest === '/run/stop') {
          if (!runIsActive()) {
            writeJson(res, 200, { stopped: false, reason: 'not-running' })
            return
          }
          spawn('taskkill', ['/PID', String(runState.pid), '/T', '/F'], { windowsHide: true })
          runState.status = 'stopping'
          persistRun()
          writeJson(res, 202, { stopping: true })
          return
        }

        // ---- dump analysis ----

        // GET /packs/{id}/analysis — cached analysis.json (or none)
        const analysisMatch = rest.match(/^\/packs\/([^/]+)\/analysis$/)
        if (method === 'GET' && analysisMatch !== null) {
          const dir = packDir(decodeURIComponent(analysisMatch[1]))
          if (dir === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          writeJson(res, 200, readJsonFile(join(dir, 'analysis.json')) ?? { status: 'none' })
          return
        }

        // POST /packs/{id}/analyze — (re)run the stack analysis
        const analyzeMatch = rest.match(/^\/packs\/([^/]+)\/analyze$/)
        if (method === 'POST' && analyzeMatch !== null) {
          const dir = packDir(decodeURIComponent(analyzeMatch[1]))
          if (dir === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          const cur = readJsonFile(join(dir, 'analysis.json'))
          if (cur !== null && cur.status === 'running' && Date.now() - (cur.startedAt ?? 0) < ANALYSIS_RUNNING_TTL) {
            writeJson(res, 200, cur)
            return
          }
          analyzePack(dir) // fire-and-forget; client polls the analysis route
          writeJson(res, 202, { status: 'running', startedAt: Date.now() })
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

/**
 * Mount the routes and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 */
export function apply(ctx) {
  const routes = makeRoutes()
  const disposeRoutes = ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-hang-inspector: routes',
  )
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:hang-inspector',
    order: SECTION_ORDER,
    text: GUIDANCE,
  })
  ctx.effect(
    () => () => {
      disposeRoutes()
      disposeSection()
    },
    'dsh-hang-inspector: teardown',
  )
}
