/**
 * dsh-ui-drive driver — Windows PowerShell(UIA) 进程封装层。
 * 把 ui-drive.ps1 / ui-probe.ps1 的进程调用、超时、输出解析收敛到这里，
 * 供 host 插件工具直接消费；不依赖 DSH API，可独立单测。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const PS = process.env.DSH_UI_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 每类输出的截断上限（字符），防止超长结果挤爆上下文。 */
const LIMIT_READ = 20000
const LIMIT_TREE = 14000

export function makeDriver(cfg) {
  const c = {
    procName: process.env.DSH_UI_PROC_NAME || '',
    windowName: process.env.DSH_UI_WINDOW_NAME || '',
    clientExe: process.env.DSH_UI_CLIENT_EXE || '',
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'ui-evidence'),
    defaultTimeoutMs: 90000,
    ...cfg,
  }

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
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT ' + timeoutMs + 'ms，已强杀进程树]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: '', stderr: err + '\n' + e, timedOut: false, spawnError: String(e) })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: out, stderr: err, timedOut: false })
      })
    })
  }

  const driveScript = () => join(c.scriptsDir, 'ui-drive.ps1')
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

  /** ui_status：进程 + 主窗口状态（ps1 status 动作）。 */
  async function status() {
    const r = await runPs1(driveScript(), ['-Action', 'status'], 30000)
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
      await sleep(1500)
      last = await status()
      if (last.running && last.title) {
        return { started: true, alreadyRunning: false, pid: last.pid, title: last.title, waitedMs: waitMs - (deadline - Date.now()) }
      }
    }
    const running = last ? last.running : false
    return { started: running, alreadyRunning: false, pid: last ? last.pid : null, title: last ? last.title : null, waitedMs: waitMs, warning: running ? '进程已起但主窗口超时未出现' : '启动超时' }
  }

  // ------------------------------------------------------------ 单步驱动

  const READ_ONLY_ACTIONS = new Set(['find', 'read', 'shot', 'status'])

  /**
   * ui_drive：单步动作。
   * 副作用动作（click/setvalue/key）必须显式 allowSideEffects=true（安全护栏）。
   */
  async function drive(args) {
    const { action, name = '', aid = '', value = '', ascii = false, match = '', waitMs = 1200, procId = 0, allowSideEffects = false, workspace = '', label = '', shotsDir = '' } = args
    if (!READ_ONLY_ACTIONS.has(action) && !allowSideEffects) {
      return { ok: false, action, error: '动作 ' + action + ' 是真实副作用操作，必须显式传 allowSideEffects=true 才执行（安全护栏）' }
    }
    const psArgs = commonArgs(procId).concat(['-Action', action])
    if (name) psArgs.push('-Name', name)
    if (aid) psArgs.push('-Aid', aid)
    if (value) psArgs.push('-Value', value)
    if (ascii) psArgs.push('-Ascii')
    if (match) psArgs.push('-Match', match)
    psArgs.push('-WaitMs', String(waitMs))

    let shotPlan = null
    if (action === 'shot') {
      shotPlan = prepareShotPath(shotsDir, label)
      mkdirSync(shotPlan.dir, { recursive: true })
      psArgs.push('-Out', shotPlan.path)
    }

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
      if (m) {
        let workspacePath = null
        if (workspace) {
          workspacePath = join(workspace, '.dsh-ui-evidence', basename(shotPlan.dir), basename(m[1]))
          try {
            mkdirSync(join(workspacePath, '..'), { recursive: true })
            copyFileSync(m[1], workspacePath)
          } catch { workspacePath = null }
        }
        return { ok: true, action, path: m[1], w: Number(m[2]), h: Number(m[3]), workspacePath }
      }
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    return { ok: false, action, error: '未知动作 ' + action }
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
   */
  async function flow({ steps = [], tag = 'flow', failFast = false, allowSideEffects = false } = {}) {
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

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {}
      const n = i + 1
      const action = s.action
      if (!FLOW_ACTIONS.has(action)) {
        failed++
        transcript.push({ step: n, action, ok: false, error: '非法动作 ' + action })
        w('step ' + n + ': 非法动作 ' + action)
        if (failFast) break
        continue
      }
      if (!READ_ONLY_ACTIONS.has(action) && action !== 'wait' && action !== 'expect' && !allowSideEffects) {
        failed++
        transcript.push({ step: n, action, ok: false, error: '副作用动作需要 allowSideEffects=true' })
        w('step ' + n + ': 副作用动作被护栏拦截')
        if (failFast) break
        continue
      }
      const label = s.label || action + '-' + n

      if (action === 'wait') {
        const ms = Math.min(Math.max(Number(s.waitMs) || 800, 100), 30000)
        await sleep(ms)
        transcript.push({ step: n, action, ok: true, waitedMs: ms })
        w('step ' + n + ': wait ' + ms + 'ms')
        continue
      }

      if (action === 'expect') {
        const res = await drive({ action: 'find', name: s.name, aid: s.aid, procId: s.procId || 0 })
        const enM = res.detail ? res.detail.match(/enabled=(True|False)/) : null
        const enabled = enM ? enM[1] === 'True' : null
        let ok = res.found === true
        const reasons = []
        if (ok && s.expectEnabled !== undefined && enabled !== s.expectEnabled) { ok = false; reasons.push('enabled=' + enabled + ' 期望 ' + s.expectEnabled) }
        if (ok && s.expectMatch && !new RegExp(s.expectMatch).test(res.detail || '')) { ok = false; reasons.push('name 不匹配 /' + s.expectMatch + '/') }
        ok ? passed++ : failed++
        transcript.push({ step: n, action, ok, found: res.found, detail: res.detail, reasons: reasons.join('; ') })
        w('step ' + n + ': expect ' + (ok ? 'PASS' : 'FAIL') + ' ' + (res.detail || '(未找到)') + (reasons.length ? ' [' + reasons.join('; ') + ']' : ''))
        if (!ok && failFast) break
        continue
      }

      // find / click / setvalue / key / read / shot —— 统一走 drive（shot 进本 flow 证据目录）
      const res = await drive({ action, name: s.name, aid: s.aid, value: s.value, ascii: s.ascii, match: s.match, waitMs: s.waitMs, procId: s.procId || 0, allowSideEffects, label, shotsDir: dir })
      if (action === 'shot') {
        if (res.ok) finalShot = res.path
        transcript.push({ step: n, action, ok: res.ok, path: res.path, size: res.ok ? res.w + 'x' + res.h : null, error: res.error })
        w('step ' + n + ': shot ' + (res.ok ? res.path + ' ' + res.w + 'x' + res.h : 'FAIL ' + res.error))
      } else if (action === 'read') {
        transcript.push({ step: n, action, ok: res.ok, count: res.count, lines: (res.lines || []).slice(0, 50), error: res.error })
        w('step ' + n + ': read ' + (res.count || 0) + ' 行')
      } else if (action === 'find') {
        transcript.push({ step: n, action, ok: res.ok, found: res.found, detail: res.detail, error: res.error })
        w('step ' + n + ': find ' + (res.found ? 'FOUND' : 'MISS') + ' ' + (res.detail || ''))
      } else {
        transcript.push({ step: n, action, ok: res.ok, output: res.output, notFound: res.notFound, error: res.error })
        w('step ' + n + ': ' + action + ' ' + (res.ok ? (res.output || 'OK') : 'FAIL ' + (res.error || '')))
      }
      if (!res.ok && failFast) {
        failed++
        break
      }
    }

    // 深拷贝清洗：删掉 undefined 字段，保证工具输出是 lossless JSON
    const clean = (v) => JSON.parse(JSON.stringify(v))
    const stepsOut = { tag, startedAt: new Date().toISOString(), allowSideEffects, failFast, passed, failed, totalSteps: steps.length, transcript: clean(transcript) }
    writeFileSync(join(dir, 'steps.json'), JSON.stringify(stepsOut, null, 2), 'utf8')
    w('flow end passed=' + passed + ' failed=' + failed)
    return { ok: failed === 0, passed, failed, totalSteps: steps.length, evidenceDir: dir, transcript: stepsOut.transcript, finalShot, stepsJson: join(dir, 'steps.json') }
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
    runPs1,
    tsDir,
    evidenceDir: () => c.evidenceDir,
    scriptsDir: () => c.scriptsDir,
    clientExe: () => c.clientExe,
  }
}
