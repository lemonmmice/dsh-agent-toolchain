/**
 * dsh-perf perf — 卡顿监测 + dump 抓取/分析封装（不依赖 DSH API，可独立单测）。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const PS = process.env.DSH_PERF_POWERSHELL || process.env.DSH_UI_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TOOLCHAIN_ROOT = join(homedir(), '.dsh-agent-toolchain')
const PROCDUMP = process.env.DSH_PERF_PROCDUMP || join(TOOLCHAIN_ROOT, 'tools', 'procdump.exe')
const DUMPSTACK = process.env.DSH_PERF_DUMPSTACK || join(TOOLCHAIN_ROOT, 'tools', 'dumpstack', 'publish-x86', 'DumpStack.exe')
const DAC_DIR = process.env.DSH_PERF_DAC_DIR || join(TOOLCHAIN_ROOT, 'tools', 'dac')

export function makePerf(cfg) {
  const c = {
    procName: process.env.DSH_UI_PROC_NAME || '',
    windowName: process.env.DSH_UI_WINDOW_NAME || '',
    scriptsDir: '',
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
    srcRoot: process.env.DSH_PERF_SRC_ROOT || '',
    procdump: PROCDUMP,
    dumpstack: DUMPSTACK,
    dacDir: DAC_DIR,
    ...cfg,
  }
  // 空字符串不是「配置」：调用方习惯写 evidenceDir: process.env.X || ''，
  // 展开后默认目录被清空，证据就落到 cwd 下的相对路径。
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'perf-evidence')
  if (!c.procdump) c.procdump = PROCDUMP
  if (!c.dumpstack) c.dumpstack = DUMPSTACK
  if (!c.dacDir) c.dacDir = DAC_DIR
  if (!c.srcRoot) c.srcRoot = process.env.DSH_PERF_SRC_ROOT || ''

  function runPs1(script, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e, timedOut: false })
        return
      }
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: out, stderr: err + '\n' + e, timedOut: false })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: out, stderr: err, timedOut: false })
      })
    })
  }

  function tsDir() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  }

  /** 直接跑原生 exe（DumpStack/procdump），stdout 按 UTF-8/GBK 双解码。 */
  function runExe(exe, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(exe, args.map(String), { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e, timedOut: false })
        return
      }
      const chunks = []
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: '', stderr: err + '\n[TIMEOUT]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: '', stderr: err + '\n' + e, timedOut: false })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const buf = Buffer.concat(chunks)
        let text
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
        } catch {
          try { text = new TextDecoder('gbk').decode(buf) } catch { text = buf.toString('utf8') }
        }
        resolve({ code, stdout: text, stderr: err, timedOut: false })
      })
    })
  }

  // ------------------------------------------------------------ 卡顿监测

  async function probe({ seconds = 60, thresholdMs = 500, capture = 'log', intervalMs = 300 } = {}) {
    if (!existsSync(join(c.scriptsDir, 'perf-probe.ps1'))) return { ok: false, error: 'perf-probe.ps1 缺失：' + c.scriptsDir }
    const sec = Math.min(Math.max(Math.round(seconds || 60), 5), 3600)
    const th = Math.min(Math.max(Math.round(thresholdMs || 500), 50), 10000)
    const cap = ['log', 'shot', 'dump'].includes(capture) ? capture : 'log'
    // 必须把目标进程/窗口传下去：不传时脚本收到空 ProcName，Get-Process -Name ''
    // 直接抛参数验证错误，probe 永远拿不到报告（历史 bug）。
    const psArgs = ['-Seconds', String(sec), '-ThresholdMs', String(th), '-Capture', cap, '-IntervalMs', String(intervalMs || 300), '-OutDir', c.evidenceDir, '-ProcName', c.procName, '-WindowName', c.windowName]
    const r = await runPs1(join(c.scriptsDir, 'perf-probe.ps1'), psArgs, (sec + 90) * 1000)
    if (r.timedOut) return { ok: false, error: 'probe 超时', stdout: r.stdout.slice(-1000) }
    const dirM = r.stdout.match(/EVIDENCE_DIR=([^\r\n]+)/)
    const dir = dirM ? dirM[1].trim() : null
    const reportPath = dir ? join(dir, 'report.json') : null
    if (reportPath && existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''))
        persistLast(reportPath)
        return { ok: true, ...report }
      } catch (e) {
        return { ok: false, error: 'report.json 解析失败: ' + e, stdout: r.stdout.slice(-800) }
      }
    }
    if (/CLIENT_NOT_RUNNING/.test(r.stdout)) return { ok: false, clientNotRunning: true, error: '客户端未运行（先 ui_launch 启动）' }
    if (/WINDOW_NOT_FOUND/.test(r.stdout)) return { ok: false, error: '未找到主窗口' }
    return { ok: false, error: 'probe 未产出报告', stdout: r.stdout.slice(-800), stderr: r.stderr.slice(-500) }
  }

  function lastProbePath() { return join(c.evidenceDir, 'last-probe.json') }

  function persistLast(reportPath) {
    try { writeFileSync(lastProbePath(), JSON.stringify({ at: new Date().toISOString(), reportPath }, null, 2), 'utf8') } catch { /* ignore */ }
  }

  function report() {
    try {
      const meta = JSON.parse(readFileSync(lastProbePath(), 'utf8').replace(/^\uFEFF/, ''))
      const r = JSON.parse(readFileSync(meta.reportPath, 'utf8').replace(/^\uFEFF/, ''))
      return { hasRun: true, ...r }
    } catch {
      return { hasRun: false }
    }
  }

  // ------------------------------------------------------------ dump 抓取

  function clientPid() {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + c.procName + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const m = out.match(/"[^"]*\.exe","(\d+)"/)
      if (m) return Number(m[1])
    } catch { /* ignore */ }
    return null
  }

  async function dump({ note = '' } = {}) {
    const pid = clientPid()
    if (!pid) return { ok: false, error: '客户端未运行，无法抓 dump（进程名由 DSH_UI_PROC_NAME 指定）' }
    if (!existsSync(c.procdump)) return { ok: false, error: 'procdump 缺失：' + c.procdump }
    const dir = join(c.evidenceDir, tsDir() + '-dump')
    mkdirSync(dir, { recursive: true })
    const dumpPath = join(dir, 'client.dmp')
    const label = String(note || '').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30)
    if (label) {
      try { writeFileSync(join(dir, 'note.txt'), note + '\n', 'utf8') } catch { /* ignore */ }
    }
    const startedAt = Date.now()
    const r = await new Promise((resolve) => {
      let child
      try {
        child = spawn(c.procdump, ['-ma', '-accepteula', String(pid), dumpPath], { windowsHide: true })
      } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e) }); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT 180s]' })
      }, 180000)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }) })
    })
    const durationMs = Date.now() - startedAt
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 未生成', procdumpOut: (r.stdout + '\n' + r.stderr).slice(-800) }
    const size = statSync(dumpPath).size
    const analysis = await analyzeDump(dumpPath)
    return { ok: true, dumpPath, sizeBytes: size, durationMs, dir, analysis }
  }

  // ------------------------------------------------------------ dump 分析

  function findDac(dumpPath) {
    try {
      const info = execFileSync(c.dumpstack, ['dacinfo', dumpPath], { encoding: 'utf8', windowsHide: true }).trim()
      const key = info.split(/\r?\n/)[0]
      if (!key) return null
      const dac = join(c.dacDir, key.replace('|', '_') + '.dll')
      return existsSync(dac) ? dac : null
    } catch {
      return null
    }
  }

  async function analyzeDump(dumpPath) {
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 不存在：' + dumpPath }
    if (!existsSync(c.dumpstack)) return { ok: false, error: 'DumpStack 缺失：' + c.dumpstack }
    const outPath = dumpPath.replace(/\.dmp$/i, '.analysis.json')
    const args = [dumpPath, outPath]
    const dac = findDac(dumpPath)
    if (dac) args.push(dac)
    const r = await runExe(c.dumpstack, args, 180000)
    if (r.timedOut) return { ok: false, error: 'DumpStack 超时' }
    let data
    try {
      data = JSON.parse(readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      // 输出直接打 stdout 的情况
      try { data = JSON.parse(r.stdout) } catch {
        return { ok: false, error: 'DumpStack 输出解析失败', tail: (r.stdout + r.stderr).slice(-600) }
      }
    }
    return { ok: true, outPath, ...summarize(data) }
  }

  function summarize(data) {
    const threads = data.threads || []
    const ui = threads.filter((t) => t.uiLikely)
    const busy = [...threads].sort((a, b) => (b.lockCount || 0) - (a.lockCount || 0)).slice(0, 5)
    const frameLine = (f) => (f.module ? basename(f.module) + '!' : '') + (f.type ? f.type + '.' : '') + f.method
    return {
      dump: data.dump,
      threadCount: threads.length,
      uiThread: ui.length > 0 ? { managedId: ui[0].managedId, osId: ui[0].osId, stack: (ui[0].frames || []).slice(0, 20).map(frameLine) } : null,
      topLockThreads: busy.map((t) => ({ managedId: t.managedId, osId: t.osId, lockCount: t.lockCount || 0, uiLikely: !!t.uiLikely, stack: (t.frames || []).slice(0, 12).map(frameLine) })),
    }
  }

  async function heapStats(dumpPath, topN = 30) {
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 不存在：' + dumpPath }
    if (!existsSync(c.dumpstack)) return { ok: false, error: 'DumpStack 缺失：' + c.dumpstack }
    const args = ['heapstats', dumpPath, String(Math.min(Math.max(topN || 30, 5), 100))]
    const dac = findDac(dumpPath)
    if (dac) args.push(dac)
    const r = await runExe(c.dumpstack, args, 300000)
    if (r.timedOut) return { ok: false, error: 'heapstats 超时' }
    try {
      const data = JSON.parse(r.stdout)
      return { ok: true, ...data }
    } catch {
      return { ok: false, error: 'heapstats 输出解析失败', tail: (r.stdout + r.stderr).slice(-600) }
    }
  }

  // ------------------------------------------------------------ 源码映射（best effort）

  const typeFileCache = new Map()
  function locateType(typeName) {
    if (typeFileCache.has(typeName)) return typeFileCache.get(typeName)
    const simple = (typeName || '').split('.').pop()
    let found = null
    if (simple && existsSync(c.srcRoot)) {
      try {
        const out = execFileSync('git', ['-C', c.srcRoot, 'grep', '-n', '-l', '--', 'class ' + simple], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
        const line = out.trim().split(/\r?\n/)[0]
        if (line) found = line.replace(/\\/g, '/')
      } catch { /* ignore */ }
    }
    typeFileCache.set(typeName, found)
    return found
  }

  function listEvidence(limit = 20) {
    try {
      return readdirSync(c.evidenceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const p = join(c.evidenceDir, d.name)
          const files = readdirSync(p).filter((f) => /\.(json|png|dmp|log|txt)$/.test(f)).slice(0, 30)
          return { id: d.name, ts: statSync(p).mtimeMs, files }
        })
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
    } catch {
      return []
    }
  }

  return { config: c, probe, report, dump, analyzeDump, heapStats, locateType, listEvidence, evidenceDir: () => c.evidenceDir }
}
