/**
 * dsh-ui-drive driver — Windows PowerShell(UIA) 进程封装层。
 * 把 ui-drive.ps1 / ui-drive-batch.ps1 / ui-probe.ps1 的进程调用、超时、输出解析
 * 收敛到这里，供 host 插件工具直接消费；不依赖 DSH API，可独立单测。
 *
 * 性能模型（2026-09 优化）：
 *  - 单步 ui_drive 走 ui-drive.ps1（一次进程 = 一个动作）；
 *  - ui_flow 走 ui-drive-batch.ps1：整个步骤序列交给一个 PowerShell 进程，
 *    程序集只加载一次、主窗口只解析一次，步间没有进程启动开销；
 *  - status 走 batch 脚本的 -Status 快路径（不加载 UIA）。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { decodeBuffer } from '../../../lib/decode.mjs'

const PS = process.env.DSH_UI_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 每类输出的截断上限（字符），防止超长结果挤爆上下文。 */
const LIMIT_READ = 20000
const LIMIT_TREE = 14000

/** 动作后的默认静默等待：UIA 动作本身是同步的，1200ms 纯属浪费。 */
export const DEFAULT_WAIT_MS = 250

export function makeDriver(cfg) {
  const c = {
    procName: process.env.DSH_UI_PROC_NAME || '',
    windowName: process.env.DSH_UI_WINDOW_NAME || '',
    clientExe: process.env.DSH_UI_CLIENT_EXE || '',
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'ui-evidence'),
    defaultTimeoutMs: 90000,
    defaultWaitMs: DEFAULT_WAIT_MS,
    ...cfg,
  }
  // 空字符串不是「配置」：MCP 侧习惯传 evidenceDir: process.env.X || ''，
  // 直接展开会让空值覆盖默认值，证据目录退化成 cwd 下的相对路径。
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'ui-evidence')
  if (!c.scriptsDir) c.scriptsDir = join(import.meta.dirname, '..', 'scripts')

  // ------------------------------------------------------------ 进程执行

  function runPs1(script, args, timeoutMs = c.defaultTimeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn 失败: ' + e, timedOut: false, spawnError: String(e) })
        return
      }
      const outChunks = []
      const errChunks = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: decodeBuffer(Buffer.concat(outChunks)).text, stderr: decodeBuffer(Buffer.concat(errChunks)).text + '\n[TIMEOUT ' + timeoutMs + 'ms，已强杀进程树]', timedOut: true })
      }, timeoutMs)
      // PowerShell 输出在中文系统上是 GBK：按字节累积，最后经 UTF-8→GBK
      // 双解码（lib/decode.mjs），不再逐片 toString('utf8')（产生乱码）。
      child.stdout.on('data', (d) => { outChunks.push(Buffer.from(d)) })
      child.stderr.on('data', (d) => { errChunks.push(Buffer.from(d)) })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: '', stderr: decodeBuffer(Buffer.concat(errChunks)).text + '\n' + e, timedOut: false, spawnError: String(e) })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: decodeBuffer(Buffer.concat(outChunks)).text, stderr: decodeBuffer(Buffer.concat(errChunks)).text, timedOut: false })
      })
    })
  }

  const driveScript = () => join(c.scriptsDir, 'ui-drive.ps1')
  const batchScript = () => join(c.scriptsDir, 'ui-drive-batch.ps1')
  const probeScript = () => join(c.scriptsDir, 'ui-probe.ps1')

  function commonArgs(procId) {
    const a = ['-ProcName', c.procName, '-WindowName', c.windowName]
    if (procId > 0) a.push('-ProcId', String(procId))
    return a
  }

  /** 时间戳目录名：YYYYMMDD-HHMMSS */
  function tsDir() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  }

  function safeLabel(s, fallback = 'shot') {
    const t = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    return t || fallback
  }

  // ------------------------------------------------------------ 状态 / 启动

  /** ui_status：进程 + 主窗口状态（batch 脚本 -Status 快路径，不加载 UIA）。 */
  async function status() {
    if (!c.procName && !c.clientExe) {
      // 未配置目标进程：明确区分「未配置」与「未运行」，避免三个状态塌缩成一个 running:false。
      return { running: false, unconfigured: true, error: '未配置目标进程（设置 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE）' }
    }
    const script = existsSync(batchScript()) ? batchScript() : driveScript()
    const args = existsSync(batchScript())
      ? ['-Status', '-ProcName', c.procName, '-WindowName', c.windowName]
      : commonArgs(0).concat(['-Action', 'status'])
    const r = await runPs1(script, args, 30000)
    const text = r.stdout
    if (r.timedOut) return { running: false, error: 'status 超时' }
    if (/NOT_RUNNING/.test(text)) return { running: false, pid: null, title: null, raw: text.slice(0, 300) }
    return parseStatusText(text)
  }

  /** ui_launch：启动客户端（detached），轮询等待主窗口。 */
  async function launch({ extraArgs = '', waitMs = 60000 } = {}) {
    const st0 = await status()
    if (st0.running && st0.title) {
      return { started: false, alreadyRunning: true, pid: st0.pid, title: st0.title, waitedMs: 0 }
    }
    if (!existsSync(c.clientExe)) {
      return { started: false, error: '客户端 exe 不存在：' + c.clientExe + '（可用 DSH_UI_CLIENT_EXE 覆盖）' }
    }
    const args = extraArgs ? String(extraArgs).split(/\s+/).filter(Boolean) : []
    let child
    try {
      child = spawn(c.clientExe, args, {
        cwd: join(c.clientExe, '..'),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (e) {
      return { started: false, error: '启动失败: ' + e }
    }
    child.unref()
    const deadline = Date.now() + waitMs
    let last = null
    while (Date.now() < deadline) {
      await sleep(1000)
      last = await status()
      if (last.running && last.title) {
        return { started: true, alreadyRunning: false, pid: last.pid, title: last.title, waitedMs: waitMs - (deadline - Date.now()) }
      }
    }
    const running = last ? last.running : false
    return { started: running, alreadyRunning: false, pid: last ? last.pid : null, title: last ? last.title : null, waitedMs: waitMs, warning: running ? '进程已起但主窗口超时未出现' : '启动超时' }
  }

  // ------------------------------------------------------------ 常驻进程（serve 模式）

  /**
   * 常驻 PowerShell 进程：启动成本（~400ms）只付一次，之后每个动作只付 UIA 调用
   * 本身（实测 30-150ms）。单步 ui_drive 走这里；进程空闲超时/异常自动重启。
   */
  const warm = {
    proc: null,
    pending: new Map(),
    seq: 0,
    buf: Buffer.alloc(0),
    lastUsed: 0,
    startedAt: 0,
    ready: null,
    disabled: false,
  }

  function warmEnabled() {
    if (warm.disabled) return false
    if (process.env.DSH_UI_SERVE === '0') return false
    return existsSync(batchScript())
  }

  function warmStop(reason) {
    const p = warm.proc
    warm.proc = null
    warm.ready = null
    for (const [, e] of warm.pending) e.reject(new Error('常驻进程已退出' + (reason ? '（' + reason + '）' : '')))
    warm.pending.clear()
    if (p) {
      try { p.kill() } catch { /* ignore */ }
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
    }
  }

  function warmStart() {
    if (warm.proc) return Promise.resolve(true)
    if (!warmEnabled()) return Promise.resolve(false)
    const idleMs = Number(process.env.DSH_UI_SERVE_IDLE_MS || 300000)
    const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', batchScript(), '-Serve', '-ProcName', c.procName, '-WindowName', c.windowName], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    warm.proc = child
    warm.buf = Buffer.alloc(0)
    warm.startedAt = Date.now()
    warm.lastUsed = Date.now()
    warm.ready = true

    const onLine = (line) => {
      const s = line.trim()
      if (!s) return
      if (!s.startsWith('RESP_JSON=')) return
      let obj
      try { obj = JSON.parse(s.slice('RESP_JSON='.length)) } catch { return }
      const e = warm.pending.get(obj.id)
      if (!e) return
      warm.pending.delete(obj.id)
      clearTimeout(e.timer)
      warm.lastUsed = Date.now()
      e.resolve(obj)
    }
    child.stdout.on('data', (d) => {
      warm.buf = Buffer.concat([warm.buf, Buffer.from(d)])
      let idx
      while ((idx = warm.buf.indexOf(0x0a)) >= 0) {
        const raw = warm.buf.subarray(0, idx)
        warm.buf = warm.buf.subarray(idx + 1)
        onLine(decodeBuffer(raw).text.replace(/\r$/, ''))
      }
    })
    child.on('error', () => { if (warm.proc === child) warmStop('spawn error') })
    child.on('exit', () => { if (warm.proc === child) warmStop('exit') })

    // 空闲回收：超时没人用就主动退出，避免长期占着一个 PowerShell
    const timer = setInterval(() => {
      if (warm.proc !== child) { clearInterval(timer); return }
      if (warm.pending.size === 0 && Date.now() - warm.lastUsed > idleMs) {
        clearInterval(timer)
        warmStop('idle timeout')
      }
    }, Math.min(60000, Math.max(5000, idleMs / 2)))
    if (timer.unref) timer.unref()
    return Promise.resolve(true)
  }

  /** 向常驻进程发一条请求；超时/异常降级为 false，由调用方回退到单进程路径。 */
  function warmSend(payload, timeoutMs = c.defaultTimeoutMs) {
    return new Promise((resolve) => {
      if (!warm.proc) { resolve(null); return }
      const id = ++warm.seq
      const timer = setTimeout(() => {
        if (warm.pending.has(id)) {
          warm.pending.delete(id)
          warmStop('request timeout')
          resolve(null)
        }
      }, timeoutMs)
      warm.pending.set(id, {
        timer,
        resolve: (obj) => resolve(obj),
        reject: () => { clearTimeout(timer); resolve(null) },
      })
      try {
        warm.proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n')
        warm.lastUsed = Date.now()
      } catch {
        clearTimeout(timer)
        warm.pending.delete(id)
        warmStop('stdin write failed')
        resolve(null)
      }
    })
  }

  /** 关闭常驻进程（插件卸载 / 测试收尾）。 */
  function warmShutdown() {
    warm.disabled = true
    warmStop('shutdown')
  }

  /** 常驻进程状态（诊断用）。 */
  function warmStatus() {
    return { alive: warm.proc !== null, pending: warm.pending.size, seq: warm.seq, startedAt: warm.startedAt || null, lastUsed: warm.lastUsed || null, disabled: warm.disabled }
  }

  // ------------------------------------------------------------ 单步驱动

  const READ_ONLY_ACTIONS = new Set(['find', 'read', 'shot', 'status'])

  /**
   * ui_drive：单步动作。
   * 默认走常驻进程（实时）；常驻进程不可用时自动回退到一次性脚本进程。
   * 副作用动作（click/setvalue/key）必须显式 allowSideEffects=true（安全护栏）。
   */
  async function drive(args) {
    const { action, name = '', aid = '', value = '', ascii = false, match = '', waitMs = c.defaultWaitMs, procId = 0, allowSideEffects = false, workspace = '', label = '', shotsDir = '' } = args
    if (!READ_ONLY_ACTIONS.has(action)) {
      if (!allowSideEffects) {
        return { ok: false, action, error: '动作 ' + action + ' 是真实副作用操作，必须显式传 allowSideEffects=true 才执行（安全护栏）' }
      }
    }

    let shotPlan = null
    if (action === 'shot') {
      shotPlan = prepareShotPath(shotsDir, label)
      mkdirSync(shotPlan.dir, { recursive: true })
    }

    // ---- 常驻进程快路径
    if (warmEnabled()) {
      await warmStart()
      if (warm.proc) {
        const payload = { action, name, aid, value, ascii, match, waitMs, procId }
        if (action === 'shot') payload.out = shotPlan.path
        const res = await warmSend(payload, action === 'shot' ? 60000 : c.defaultTimeoutMs)
        if (res) return shapeResult(action, res, shotPlan, workspace)
        // 常驻进程出问题：本次回退单进程路径
      }
    }

    // ---- 回退：一次性脚本进程
    const psArgs = commonArgs(procId).concat(['-Action', action])
    if (name) psArgs.push('-Name', name)
    if (aid) psArgs.push('-Aid', aid)
    if (value) psArgs.push('-Value', value)
    if (ascii) psArgs.push('-Ascii')
    if (match) psArgs.push('-Match', match)
    psArgs.push('-WaitMs', String(waitMs))
    if (action === 'shot') psArgs.push('-Out', shotPlan.path)

    const r = await runPs1(driveScript(), psArgs, action === 'shot' ? 60000 : c.defaultTimeoutMs)
    const text = r.stdout
    const notFound = /NOT_FOUND/.test(text)

    if (action === 'find') {
      const m = text.match(/FOUND (.+)/)
      if (m) return { ok: true, action, found: true, detail: m[1] }
      if (notFound) return { ok: true, action, found: false, detail: null }
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    if (action === 'click' || action === 'setvalue' || action === 'key') {
      if (notFound) return { ok: false, action, notFound: true, error: '未找到目标控件（' + (name || aid) + '）' }
      const m = text.match(/^(CLICKED|SET|KEYED)(.*)$/m)
      if (m) return { ok: true, action, output: (m[1] + m[2]).trim() }
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    if (action === 'read') {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\[(Button|Edit|Text|RadioButton|CheckBox|TabItem|ComboBox)\]/.test(l))
      return { ok: true, action, count: lines.length, lines: lines.slice(0, 200), truncated: text.length > LIMIT_READ }
    }
    if (action === 'shot') {
      const m = text.match(/SHOT (.+) (\d+)x(\d+)/)
      if (m) return shapeShot(action, { ok: true, path: m[1], w: Number(m[2]), h: Number(m[3]) }, shotPlan, workspace)
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    return { ok: false, action, error: '未知动作 ' + action }
  }

  /** 把常驻进程返回的原始结果整形成 ui_drive 的稳定返回结构。 */
  function shapeResult(action, res, shotPlan, workspace) {
    if (res.ok !== true) {
      const out = { ok: false, action }
      if (res.error) out.error = res.error
      if (res.notFound) out.notFound = true
      return out
    }
    if (action === 'find') return { ok: true, action, found: res.found === true, detail: res.detail !== undefined ? res.detail : null }
    if (action === 'read') return { ok: true, action, count: res.count || 0, lines: res.lines || [], truncated: false }
    if (action === 'click' || action === 'setvalue' || action === 'key') return { ok: true, action, output: res.output || '' }
    if (action === 'shot') return shapeShot(action, res, shotPlan, workspace)
    return { ok: true, action, output: res.output || '' }
  }

  /** shot 结果：补上 workspace 副本路径。 */
  function shapeShot(action, res, shotPlan, workspace) {
    let workspacePath = null
    const src = res.path
    if (workspace && src) {
      workspacePath = join(workspace, '.dsh-ui-evidence', basename(shotPlan.dir), basename(src))
      try {
        mkdirSync(join(workspacePath, '..'), { recursive: true })
        copyFileSync(src, workspacePath)
      } catch { workspacePath = null }
    }
    return { ok: true, action, path: src, w: res.w, h: res.h, workspacePath }
  }

  function parseStatusText(text) {
    const pidM = text.match(/RUNNING pid=(\d+)/)
    if (!pidM) return { running: false, pid: null, title: null, raw: text.slice(0, 300) }
    const winM = text.match(/window=([^\r\n]*)/)
    const rectM = text.match(/RECT (\d+)x(\d+) @(-?\d+),(-?\d+)/)
    const title = winM ? winM[1].trim() : null
    return {
      running: true,
      pid: Number(pidM[1]),
      title: title === 'NONE' ? null : title,
      rect: rectM ? { w: Number(rectM[1]), h: Number(rectM[2]), x: Number(rectM[3]), y: Number(rectM[4]) } : null,
      raw: text.slice(0, 300),
    }
  }

  function prepareShotPath(baseDir, label) {
    const dir = baseDir || join(c.evidenceDir, tsDir())
    return { dir, path: join(dir, safeLabel(label) + '.png') }
  }

  // ------------------------------------------------------------ 批量执行（ui_flow 的引擎）

  /**
   * batch：把一个步骤序列交给单个 PowerShell 进程执行。
   * 每步结果与单步 drive 的返回字段保持一致（find→found/detail，read→count/lines，
   * shot→path/w/h，click/setvalue/key→output，expect→found/detail/ok）。
   * @returns {Promise<{ok:boolean, steps:object[], elapsedMs:number, pid:number, window:string, error?:string}>}
   */
  async function batch({ steps = [], procId = 0, waitMs = c.defaultWaitMs, tmpDir = '' } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, steps: [], error: 'steps 不能为空' }
    if (!existsSync(batchScript())) {
      return { ok: false, steps: [], error: '批量脚本不存在：' + batchScript() }
    }
    const dir = tmpDir || join(c.evidenceDir, tsDir())
    mkdirSync(dir, { recursive: true })
    const stepsFile = join(dir, 'batch-steps.json')
    const outFile = join(dir, 'batch-result.json')
    const cleanSteps = steps.map((s) => {
      const o = { action: s.action }
      if (s.name !== undefined) o.name = s.name
      if (s.aid !== undefined) o.aid = s.aid
      if (s.value !== undefined) o.value = s.value
      if (s.ascii !== undefined) o.ascii = s.ascii
      if (s.match !== undefined) o.match = s.match
      if (s.out !== undefined) o.out = s.out
      if (s.waitMs !== undefined && s.waitMs !== null) o.waitMs = s.waitMs
      if (s.expectEnabled !== undefined) o.expectEnabled = s.expectEnabled
      if (s.expectMatch !== undefined) o.expectMatch = s.expectMatch
      return o
    })
    writeFileSync(stepsFile, JSON.stringify(cleanSteps), 'utf8')
    const args = commonArgs(procId).concat(['-StepsFile', stepsFile, '-Out', outFile, '-DefaultWaitMs', String(waitMs)])
    const r = await runPs1(batchScript(), args, c.batchTimeoutMs || 600000)
    let parsed = null
    try {
      if (existsSync(outFile)) parsed = JSON.parse(readFileSync(outFile, 'utf8'))
    } catch { parsed = null }
    if (!parsed) {
      const m = r.stdout.match(/RESULT_JSON=(.+)/)
      if (m) { try { parsed = JSON.parse(m[1]) } catch { parsed = null } }
    }
    try { rmSync(stepsFile, { force: true }) } catch { /* ignore */ }
    if (!parsed) {
      return {
        ok: false,
        steps: [],
        error: r.timedOut ? ('批量执行超时（' + (c.batchTimeoutMs || 600000) + 'ms）') : (cleanPsError(r.stderr) || r.stdout.slice(0, 500) || '批量脚本无输出'),
      }
    }
    return { ok: parsed.ok === true, steps: parsed.steps || [], elapsedMs: parsed.elapsedMs || 0, pid: parsed.pid || null, window: parsed.window || null }
  }

  // ------------------------------------------------------------ 视觉树

  /** ui_tree：进程内视觉树 dump（只读深查）。 */
  async function tree({ maxDepth = 8 } = {}) {
    const depth = Math.min(Math.max(Math.round(maxDepth || 8), 1), 20)
    const r = await runPs1(probeScript(), ['-Action', 'dump-tree', '-MaxDepth', String(depth)], 180000)
    if (r.timedOut) return { ok: false, error: 'dump-tree 超时' }
    const idx = r.stdout.lastIndexOf('--- RESULT ---')
    const text = idx >= 0 ? r.stdout.slice(idx + '--- RESULT ---'.length) : r.stdout
    if (/CSC_EXIT=[^0]/.test(r.stdout) || /INJECT_EXIT=[^0]/.test(r.stdout)) {
      return { ok: false, error: (r.stdout + '\n' + r.stderr).slice(-1500) }
    }
    return { ok: true, text: text.trim().slice(0, LIMIT_TREE), truncated: text.length > LIMIT_TREE }
  }

  // ------------------------------------------------------------ 流程自验

  const FLOW_ACTIONS = new Set(['find', 'click', 'setvalue', 'key', 'read', 'shot', 'wait', 'expect'])

  /**
   * ui_flow：步骤序列驱动 + 证据收集。
   * steps: [{action, name?, aid?, value?, ascii?, match?, waitMs?, label?,
   *          expectEnabled?, expectMatch?}]
   * expect 步 = find + 断言（expectMatch 匹配 detail 正则；expectEnabled 检查启用态）。
   * 默认只读（find/read/shot/wait/expect）；含 click/setvalue/key 必须 allowSideEffects=true。
   * 执行引擎：整个序列进一个 PowerShell 进程（batch），步间无进程启动开销。
   */
  async function flow({ steps = [], tag = 'flow', failFast = false, allowSideEffects = false, waitMs } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'steps 不能为空' }
    if (steps.length > 60) return { ok: false, error: 'steps 最多 60 步' }

    const dir = join(c.evidenceDir, tsDir() + '-' + safeLabel(tag, 'flow'))
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'flow.log')
    const transcript = []
    let passed = 0
    let failed = 0
    let finalShot = null
    const w = (line) => {
      try { writeFileSync(log, new Date().toISOString() + ' ' + line + '\n', { flag: 'a' }) } catch { /* ignore */ }
    }

    w('flow start tag=' + tag + ' steps=' + steps.length + ' allowSideEffects=' + allowSideEffects)

    // ---- 预校验：非法动作 / 副作用护栏（本地判定，不浪费进程）
    const runnable = []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {}
      const n = i + 1
      const action = s.action
      if (!FLOW_ACTIONS.has(action)) {
        failed++
        transcript.push({ step: n, action, ok: false, error: '非法动作 ' + action })
        w('step ' + n + ': 非法动作 ' + action)
        if (failFast) return finish()
        continue
      }
      if (!READ_ONLY_ACTIONS.has(action) && action !== 'wait' && action !== 'expect' && !allowSideEffects) {
        failed++
        transcript.push({ step: n, action, ok: false, error: '副作用动作需要 allowSideEffects=true' })
        w('step ' + n + ': 副作用动作被护栏拦截')
        if (failFast) return finish()
        continue
      }
      // wait 在 PowerShell 侧执行（不占进程启动开销）；read/find 无需动作后静默
      const stepWait = s.waitMs !== undefined && s.waitMs !== null
        ? s.waitMs
        : (action === 'read' || action === 'find' || action === 'expect' || action === 'shot' ? 0 : (waitMs !== undefined ? waitMs : c.defaultWaitMs))
      const label = s.label || action + '-' + n
      const batchStep = {
        action,
        name: s.name,
        aid: s.aid,
        value: s.value,
        ascii: s.ascii,
        match: s.match,
        waitMs: stepWait,
        expectEnabled: s.expectEnabled,
        expectMatch: s.expectMatch,
        out: action === 'shot' ? join(dir, safeLabel(label) + '.png') : undefined,
      }
      runnable.push({ index: i, step: n, label, src: s, batchStep })
    }

    if (runnable.length === 0) return finish()

    const b = await batch({ steps: runnable.map((r) => r.batchStep), procId: steps[0].procId || 0, waitMs: c.defaultWaitMs, tmpDir: dir })
    if (!b.ok && b.steps.length === 0) {
      failed += runnable.length
      for (const r of runnable) {
        transcript.push({ step: r.step, action: r.batchStep.action, ok: false, error: b.error || '批量执行失败' })
        w('step ' + r.step + ': 批量执行失败 ' + (b.error || ''))
      }
      return finish()
    }

    for (let k = 0; k < runnable.length; k++) {
      const r = runnable[k]
      const res = b.steps[k] || { ok: false, error: '批量结果缺失' }
      const action = r.batchStep.action
      let ok = res.ok === true
      const entry = { step: r.step, action, ok }

      if (action === 'expect') {
        entry.found = res.found === true
        if (res.detail !== undefined) entry.detail = res.detail
        if (res.reasons) entry.reasons = res.reasons
      } else if (action === 'find') {
        entry.found = res.found === true
        if (res.detail !== undefined) entry.detail = res.detail
      } else if (action === 'read') {
        entry.count = res.count || 0
        entry.lines = (res.lines || []).slice(0, 50)
      } else if (action === 'shot') {
        if (res.path) { entry.path = res.path; finalShot = res.path }
        entry.size = res.ok ? res.w + 'x' + res.h : null
      } else if (action === 'wait') {
        entry.waitedMs = res.waitedMs
      } else {
        if (res.output !== undefined) entry.output = res.output
        if (res.notFound) entry.notFound = true
      }
      if (res.error) entry.error = res.error

      if (action === 'expect') {
        ok ? passed++ : failed++
        entry.ok = ok
        w('step ' + r.step + ': expect ' + (ok ? 'PASS' : 'FAIL') + ' ' + (res.detail || '(未找到)') + (res.reasons ? ' [' + res.reasons + ']' : ''))
        transcript.push(entry)
        if (!ok && failFast) break
        continue
      }

      entry.ok = ok
      if (action === 'shot') w('step ' + r.step + ': shot ' + (ok ? (res.path + ' ' + res.w + 'x' + res.h) : 'FAIL ' + (res.error || '')))
      else if (action === 'read') w('step ' + r.step + ': read ' + (res.count || 0) + ' 行')
      else if (action === 'find') w('step ' + r.step + ': find ' + (res.found ? 'FOUND' : 'MISS') + ' ' + (res.detail || ''))
      else if (action === 'wait') w('step ' + r.step + ': wait ' + (res.waitedMs || 0) + 'ms')
      else w('step ' + r.step + ': ' + action + ' ' + (ok ? (res.output || 'OK') : 'FAIL ' + (res.error || '')))
      transcript.push(entry)
      if (!ok && failFast) {
        failed++
        break
      }
    }

    return finish(b)

    function finish(batchInfo) {
      // 深拷贝清洗：删掉 undefined 字段，保证工具输出是 lossless JSON
      const clean = (v) => JSON.parse(JSON.stringify(v))
      const stepsOut = {
        tag,
        startedAt: new Date().toISOString(),
        allowSideEffects,
        failFast,
        passed,
        failed,
        totalSteps: steps.length,
        engine: 'batch',
        batchElapsedMs: batchInfo ? batchInfo.elapsedMs : null,
        transcript: clean(transcript),
      }
      writeFileSync(join(dir, 'steps.json'), JSON.stringify(stepsOut, null, 2), 'utf8')
      w('flow end passed=' + passed + ' failed=' + failed + ' batchElapsedMs=' + (batchInfo ? batchInfo.elapsedMs : '-'))
      return {
        ok: failed === 0,
        passed,
        failed,
        totalSteps: steps.length,
        evidenceDir: dir,
        transcript: stepsOut.transcript,
        finalShot,
        stepsJson: join(dir, 'steps.json'),
        engine: 'batch',
        elapsedMs: batchInfo ? batchInfo.elapsedMs : null,
      }
    }
  }

  // ------------------------------------------------------------ 工具函数

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** PowerShell 错误流很长，只留关键行。 */
  function cleanPsError(stderr) {
    const lines = String(stderr || '').split(/\r?\n/)
    const first = lines.find((l) => /Exception|错误|error|失败|not|无法|找不到|拒绝/i.test(l) && !/CategoryInfo|FullyQualified|^\s*\+|^\s*~/.test(l))
    return first ? first.trim().slice(0, 400) : (lines[0] || '').slice(0, 400)
  }

  return {
    config: c,
    status,
    launch,
    drive,
    tree,
    flow,
    batch,
    runPs1,
    tsDir,
    warmShutdown,
    warmStatus,
    evidenceDir: () => c.evidenceDir,
    scriptsDir: () => c.scriptsDir,
    clientExe: () => c.clientExe,
  }
}
