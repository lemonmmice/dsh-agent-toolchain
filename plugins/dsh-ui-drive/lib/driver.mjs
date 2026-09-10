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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { decodeBuffer } from '../../../lib/decode.mjs'

const PS = process.env.DSH_UI_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 每类输出的截断上限（字符），防止超长结果挤爆上下文。 */
const LIMIT_READ = 20000
const LIMIT_TREE = 14000

/** 动作后的默认静默等待：UIA 动作本身是同步的，1200ms 纯属浪费。 */
export const DEFAULT_WAIT_MS = 250

/**
 * 进程级互斥锁：文件已存在则等待（最多 DSH_UI_LOCK_WAIT_MS，默认 5 分钟），
 * 超过 DSH_UI_LOCK_STALE_MS（默认 15 分钟）的锁视为陈旧并回收。
 * 用同步 API 实现（makeDriver 是同步构造函数），等待期间阻塞主线程——对测试脚本足够。
 */
const HELD_LOCKS = new Set()
/** 进程退出/信号处理器只注册一次：长跑脚本每轮新建 driver 会累积 listener
 *  （Node 默认上限 10，实测第 10 轮报 MaxListenersExceededWarning）。 */
let LOCK_EXIT_HOOKED = false
function acquireProcessLock(lockPath) {
  if (HELD_LOCKS.has(lockPath)) return
  const waitMs = Number(process.env.DSH_UI_LOCK_WAIT_MS || 300000)
  const staleMs = Number(process.env.DSH_UI_LOCK_STALE_MS || 900000)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      if (existsSync(lockPath)) {
        let stale = false
        try {
          const info = JSON.parse(readFileSync(lockPath, 'utf8'))
          stale = Date.now() - (info.ts || 0) > staleMs
        } catch { stale = true }
        if (stale) { try { rmSync(lockPath, { force: true }) } catch { /* ignore */ } }
      }
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
      HELD_LOCKS.add(lockPath)
      const release = () => {
        for (const p of [...HELD_LOCKS]) { try { rmSync(p, { force: true }) } catch { /* ignore */ } }
        HELD_LOCKS.clear()
      }
      if (!LOCK_EXIT_HOOKED) {
        LOCK_EXIT_HOOKED = true
        process.once('exit', release)
        for (const sig of ['SIGINT', 'SIGTERM']) {
          process.once(sig, () => { release(); process.exit(0) })
        }
      }
      return
    } catch {
      if (Date.now() >= deadline) throw new Error('dsh-ui-drive: 等待客户端互斥锁超时（' + lockPath + '）')
      const until = Date.now() + 1000
      while (Date.now() < until) { /* 同步等待 1s */ }
    }
  }
}

export function makeDriver(cfg) {  const c = {
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

  // ------------------------------------------------------------ 进程级互斥
  //
  // 同一客户端同一时刻只能被一个驱动进程操作：两个脚本并行驱动会让元素句柄失效
  // （"目标元素的对应 UI 不再可用"）、把页面切到别的模块（实测踩过：一个脚本在详情页
  // 验证十字光标，另一个脚本同时点了「指数」，截图全是分时图）。
  // 锁文件路径由 DSH_UI_LOCK 指定；同进程内重复 makeDriver 复用同一把锁。
  const lockPath = c.lockPath !== undefined ? c.lockPath : (process.env.DSH_UI_LOCK || '')
  if (lockPath) acquireProcessLock(lockPath)

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

  /**
   * ui_status：进程 + 主窗口状态（batch 脚本 -Status 快路径，不加载 UIA）。
   * opts.timeoutMs：上限由调用方给（launch 的轮询会把「剩余预算」传进来）——
   * 否则一次卡住的 status 就能把「客户端重启调用」拖到远超 waitMs（B-2）。
   */
  async function status({ timeoutMs = 30000 } = {}) {
    const procName = c.procName || (c.clientExe ? basename(c.clientExe).replace(/\.exe$/i, '') : '')
    if (!procName && !c.clientExe) {
      // 未配置目标进程：明确区分「未配置」与「未运行」，避免三个状态塌缩成一个 running:false。
      return { running: false, unconfigured: true, error: '未配置目标进程（设置 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE）' }
    }
    const script = existsSync(batchScript()) ? batchScript() : driveScript()
    const args = existsSync(batchScript())
      ? ['-Status', '-ProcName', procName, '-WindowName', c.windowName]
      : ['-ProcName', procName, '-WindowName', c.windowName, '-Action', 'status']
    const r = await runPs1(script, args, timeoutMs)
    const text = r.stdout
    // 超时 = 「不知道」，不是「未运行」：混为一谈会让上层把「卡住」当成「没起来」
    // 而反复重启客户端（踩过的归因错误）。
    if (r.timedOut) return { running: false, unknown: true, error: 'status 超时（' + timeoutMs + 'ms 未返回）' }
    if (/NOT_RUNNING/.test(text)) return { running: false, pid: null, title: null, raw: text.slice(0, 300) }
    return parseStatusText(text)
  }

  /**
   * ui_launch：启动客户端（detached），轮询等待主窗口。
   * B-2：整段调用有**硬上限**（waitMs，最小 3s）——每次轮询都把「剩余预算」传给 status()，
   * 任何一次卡住的 status 都不可能把重启调用拖成无限等待（昨夜整夜挂死 2.5h 的形态）。
   * 结果里带 polls/statusTimeouts 心跳，便于区分「客户端真没起来」与「轮询自身被拖慢」。
   */
  async function launch({ extraArgs = '', waitMs = 60000 } = {}) {
    const startedAt = Date.now()
    const budget = Math.max(3000, Number(waitMs) || 60000)
    const st0 = await status({ timeoutMs: Math.min(30000, budget) })
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
    const deadline = startedAt + budget
    let last = st0
    let polls = 0
    let statusTimeouts = 0
    while (Date.now() < deadline) {
      const remain = deadline - Date.now()
      if (remain <= 0) break
      await sleep(Math.min(1000, Math.max(50, remain)))
      const budgetLeft = deadline - Date.now()
      if (budgetLeft <= 0) break
      last = await status({ timeoutMs: Math.max(1000, Math.min(30000, budgetLeft)) })
      polls++
      if (last.unknown) statusTimeouts++
      if (last.running && last.title) {
        return { started: true, alreadyRunning: false, pid: last.pid, title: last.title, waitedMs: Date.now() - startedAt, polls }
      }
    }
    const running = last ? last.running : false
    return {
      started: running,
      alreadyRunning: false,
      pid: last ? last.pid : null,
      title: last ? last.title : null,
      waitedMs: Date.now() - startedAt,
      polls,
      statusTimeouts,
      warning: running ? '进程已起但主窗口超时未出现' : (statusTimeouts > 0 ? '启动超时（其中 ' + statusTimeouts + ' 次状态查询自身超时，进程状态未知）' : '启动超时'),
    }
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
    idleTimer: null,
    lastProtocolError: null,
    // B-2：看门狗的判据是「最近一次**成功动作**的时间」，不是进程退出码。
    // 卡死的 serve 既不会退出、也不会报错，只会吞掉请求 —— 只看退出码就等于没看门狗。
    lastOkAt: 0,
    stalls: 0,
    lastStallAt: null,
    lastStallReason: null,
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
    if (warm.idleTimer) { clearInterval(warm.idleTimer); warm.idleTimer = null }
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
    // ScriptStamp：把脚本 mtime 传给常驻进程，脚本被改过时它自己退出，
    // Node 侧重启进程——否则开发期热改脚本后常驻进程会一直跑旧代码（踩过）。
    let stamp = ''
    // 必须取整且用 floor：mtimeMs 带小数（1788872266973.614），PowerShell 侧
    // Ticks/10000 是向下取整，round 会进位导致每次请求都误判 STALE_SCRIPT。
    try { stamp = String(Math.floor(statSync(batchScript()).mtimeMs)) } catch { stamp = '' }
    const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', batchScript(), '-Serve', '-ProcName', c.procName, '-WindowName', c.windowName, '-ScriptStamp', stamp], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    warm.proc = child
    warm.buf = Buffer.alloc(0)
    warm.startedAt = Date.now()
    warm.lastUsed = Date.now()
    warm.lastOkAt = Date.now()
    warm.lastProtocolError = null

    const onLine = (line) => {
      const s = line.trim()
      if (!s) return
      if (!s.startsWith('RESP_JSON=')) {
        // 非协议输出（PowerShell warning/异常文本）不能静默吞掉，否则只能表现为
        // 「超时」，诊断无从下手。留最近一条，超时结果里带出去。
        warm.lastProtocolError = s.slice(0, 300)
        return
      }
      let obj
      try { obj = JSON.parse(s.slice('RESP_JSON='.length)) } catch (e) {
        warm.lastProtocolError = 'RESP_JSON 解析失败: ' + String(e).slice(0, 160) + ' | ' + s.slice(0, 160)
        return
      }
      const e = warm.pending.get(obj.id)
      if (!e) return
      warm.pending.delete(obj.id)
      clearTimeout(e.timer)
      warm.lastUsed = Date.now()
      warm.lastOkAt = Date.now() // 成功响应 = 心跳：看门狗据此判「还活着」
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
    child.stderr.on('data', (d) => {
      const t = decodeBuffer(Buffer.from(d)).text.trim()
      if (t) warm.lastProtocolError = ('stderr: ' + t).slice(0, 300)
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
    warm.idleTimer = timer
    if (timer.unref) timer.unref()

    // 僵死看门狗（B-2）：判据是「最近一次成功动作的时间」，不是退出码——
    // 卡住的 serve 进程既不会退出也不会报错，只会把请求吞掉（昨夜整晚挂死就是这么来的）。
    // 只要「还有请求在排队」且「超过 stallMs 没有任何成功响应」，就判僵死：杀进程 + 计数，
    // 下一次请求会重新 spawn（并重新解析 PID/主窗口）。只读动作另有一次性重试兜底。
    const stallMs = Number(process.env.DSH_UI_STALL_MS || 90000)
    const wd = setInterval(() => {
      if (warm.proc !== child) { clearInterval(wd); return }
      if (warm.pending.size === 0) return // 空闲不算僵死，看门狗继续待命
      let oldest = Number.MAX_SAFE_INTEGER
      for (const [, e] of warm.pending) { if (e.since && e.since < oldest) oldest = e.since }
      const now = Date.now()
      const idleOk = now - (warm.lastOkAt || warm.startedAt || now)
      const idleOldest = oldest === Number.MAX_SAFE_INTEGER ? 0 : now - oldest
      if (idleOk > stallMs && idleOldest > stallMs) {
        warm.stalls++
        warm.lastStallAt = now
        warm.lastStallReason = 'watchdog: 排队 ' + warm.pending.size + ' 个请求、' + Math.round(idleOk / 1000) + 's 无成功响应 → 判僵死并重启常驻进程'
        warm.lastProtocolError = warm.lastStallReason
        warmStop('stall watchdog')
      }
    }, Math.min(15000, Math.max(500, Math.floor(stallMs / 3))))
    if (wd.unref) wd.unref()
    // ready 握手：确认 serve 脚本已经起来并在监听 stdin，避免「进程刚 spawn
    // 就发请求」时首个动作白等一个超时（Codex 复核提出的 should-fix）。
    return warmSend({ cmd: 'ping' }, 15000).then((r) => {
      if (r && r.ok === true && r.pong === true) { warm.ready = true; return true }
      warm.ready = false
      warmStop('ready handshake failed')
      return false
    })
  }

  /**
   * 向常驻进程发一条请求；超时/异常降级为 null（只读动作可安全回退）。
   * opts.killOnTimeout=false（live 后台循环用）：超时只放弃这次请求、绝不
   * warmStop 杀常驻进程——live tick 超时若杀进程，会把正在排队的 agent 副作用
   * 动作一起清掉（可能已执行、结果未知，评审定为最关键事故源）。
   * 反例：agent 正常动作超时仍杀进程（卡住的 serve 没救），保持原语义。
   */
  function warmSend(payload, timeoutMs = c.defaultTimeoutMs, opts = {}) {
    return new Promise((resolve) => {
      if (!warm.proc) { resolve(null); return }
      const id = ++warm.seq
      const timer = setTimeout(() => {
        if (warm.pending.has(id)) {
          warm.pending.delete(id)
          const why = warm.lastProtocolError ? ('；最近协议输出：' + warm.lastProtocolError) : ''
          if (opts.killOnTimeout !== false) {
            warmStop('request timeout')
          }
          // 明确区分「超时」：调用方据此禁止副作用重放
          resolve({ ok: false, timeout: true, error: '常驻进程请求超时 ' + timeoutMs + 'ms' + why })
        }
      }, timeoutMs)
      warm.pending.set(id, {
        timer,
        since: Date.now(), // 看门狗用：这条请求已经等了多久
        resolve: (obj) => {
          // 脚本热改：常驻进程自报 STALE_SCRIPT 后退出，这里静默重试一次（换新进程）
          if (obj && obj.error === 'STALE_SCRIPT') {
            clearTimeout(timer)
            warm.pending.delete(id)
            warmStop('stale script')
            warmStart().then(() => {
              warmSend(payload, timeoutMs).then(resolve)
            })
            return
          }
          resolve(obj)
        },
        // 常驻进程在排队期间被看门狗判僵死 / 退出：必须给出「已执行但结果未知」的语义，
        // 绝不能解成 null 让调用方当「没执行」而重放副作用（点两次）。
        reject: (err) => {
          clearTimeout(timer)
          resolve({ ok: false, timeout: true, killed: true, error: '常驻进程在请求排队期间被重启：' + (err && err.message ? err.message : '未知原因') })
        },
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

  /**
   * 重启常驻进程（客户端重启后调用）：杀掉当前进程，下次请求重新 spawn 并重新解析 PID/主窗口。
   * 与 warmShutdown 的区别：不会把 disabled 置 true（那是永久禁用，会退化到一次性脚本路径）。
   */
  function warmRestart() {
    warm.disabled = false
    warmStop('manual restart')
  }

  /** 常驻进程状态（诊断用）。lastOkAt/stalls 是 B-2 的看门狗心跳与判僵死计数。 */
  function warmStatus() {
    return {
      alive: warm.proc !== null,
      pending: warm.pending.size,
      seq: warm.seq,
      startedAt: warm.startedAt || null,
      lastUsed: warm.lastUsed || null,
      lastOkAt: warm.lastOkAt || null,
      stalls: warm.stalls,
      lastStallAt: warm.lastStallAt,
      lastStallReason: warm.lastStallReason,
      disabled: warm.disabled,
    }
  }

  // ------------------------------------------------------------ 单步驱动

  // 纯输入型动作（移动鼠标/滚轮/拖拽/坐标点击）：不会提交或改数据，可逆，
  // 因此不受 allowSideEffects 护栏限制（K线滑动、十字光标、列表滚动要用）。
  const INPUT_ACTIONS = new Set(['move', 'wheel', 'drag', 'clickat', 'doubleclick'])
  const READ_ONLY_ACTIONS = new Set(['find', 'read', 'shot', 'status', 'windows', 'waitfor', 'state', 'state-live', 'expectwindow', 'expecttext', 'waitany', 'move', 'wheel', 'capture'])

  /**
   * 新动作（type/drag/windows/waitfor/state/expectwindow/expecttext/waitany）与带条件的
   * 等待（waitFor）只有批量引擎实现；一次性脚本路径不支持时走批量引擎单步执行——
   * 语义一致，代价是每步多付一次 PowerShell 启动（约 0.4s），可接受。
   */
  const BATCH_ONLY_ACTIONS = new Set(['type', 'drag', 'move', 'wheel', 'clickat', 'doubleclick', 'windows', 'waitfor', 'state', 'state-live', 'expectwindow', 'expecttext', 'waitany', 'capture'])

  /** 动作名归一化：waitFor / WaitFor / WAITFOR 都是 waitfor（模型大小写写法不一致）。 */
  function normAction(a) {
    return typeof a === 'string' ? a.trim().toLowerCase() : a
  }

  /** 动作参数 → 批量步骤字段（两处共用，避免字段漏传）。 */
  function stepFields(args) {
    const s = {
      action: normAction(args.action),
      name: args.name,
      aid: args.aid,
      value: args.value,
      ascii: args.ascii,
      match: args.match,
      waitMs: args.waitMs,
      index: args.index,
      inAid: args.inAid,
      inName: args.inName,
      waitFor: args.waitFor,
      state: args.state,
      keys: args.keys,
      fromX: args.fromX,
      fromY: args.fromY,
      toX: args.toX,
      toY: args.toY,
      steps: args.steps,
      holdMs: args.holdMs,
      x: args.x,
      y: args.y,
      double: args.double,
      button: args.button,
      focus: args.focus,
      delta: args.delta,
      count: args.count,
      mods: args.mods,
      max: args.max,
      // 跨窗口 + 凭据 + 竞速等待
      winTitle: args.winTitle,
      winHandle: args.winHandle,
      secret: args.secret,
      expectValue: args.expectValue,
      titleRe: args.titleRe,
      textRe: args.textRe,
      gone: args.gone,
      ms: args.ms,
      interval: args.interval,
      conds: args.conds,
      stableCount: args.stableCount,
      out: args.out,
    }
    for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k]
    return s
  }

  /**
   * ui_drive：单步动作。
   * 默认走常驻进程（实时）；常驻进程不可用时自动回退到一次性脚本进程。
   * 副作用动作（click/setvalue/key）必须显式 allowSideEffects=true（安全护栏）。
   */
  // 瞬时失败特征：元素在解析与操作之间被销毁（客户端页面切换/虚拟化重建）。
  const TRANSIENT_ERR_RE = /不再可用|父窗口已关闭|元素.*不可用|ElementNotAvailable/i

  async function drive(args) {
    const firstAction = normAction(args && args.action)
    const retryable = READ_ONLY_ACTIONS.has(firstAction)
    const maxTries = retryable ? 2 : 1
    let last = null
    for (let i = 0; i < maxTries; i++) {
      last = await driveOnce(args)
      if (!last || last.ok !== false) return last
      if (!TRANSIENT_ERR_RE.test(String(last.error || ""))) return last
      if (i + 1 >= maxTries) break
      // 重试前：重启常驻进程（重新解析 PID/主窗口），给客户端一点恢复时间
      try { warmRestart() } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400))
    }
    return last
  }

  async function driveOnce(args) {
    const { action: rawAction, name = '', aid = '', value = '', ascii = false, match = '', waitMs = c.defaultWaitMs, procId = 0, allowSideEffects = false, workspace = '', label = '', shotsDir = '', index, inAid = '', inName = '', waitFor = null, state = '', keys = '', fromX, fromY, toX, toY, steps = 12, holdMs = 120, max, winTitle = '', winHandle, secret = false, expectValue, titleRe = '', textRe = '', gone = false, ms, interval, conds, stableCount, observe = false, observeMatch = '', observeMax = 15, x, y, delta, count, mods = '', double = false, button = '', focus = false } = args
    const action = normAction(rawAction)
    if (!READ_ONLY_ACTIONS.has(action) && !INPUT_ACTIONS.has(action)) {
      if (!allowSideEffects) {
        return { ok: false, action, error: '动作 ' + action + ' 是真实副作用操作，必须显式传 allowSideEffects=true 才执行（安全护栏）' }
      }
    }

    let shotPlan = null
    if (action === 'shot' || action === 'capture') {
      shotPlan = prepareShotPath(shotsDir, label)
      mkdirSync(shotPlan.dir, { recursive: true })
    }

    // ---- 动作后快照（observe:true）：一次调用拿到「点了之后界面变成什么样」，
    //      省掉 agent 的二次 state 往返（外部复核建议的 opt-in 轻量观察）。
    const wantObserve = args.observe === true && !READ_ONLY_ACTIONS.has(action)
    const attachObserve = async (out) => {
      if (!wantObserve) return out
      let snapshot = null
      try {
        const st = await drive({ action: 'state', match: args.observeMatch || '', max: args.observeMax || 15, procId })
        snapshot = st.ok ? { window: st.window, focused: st.focused, count: st.count, lines: st.lines } : { error: st.error }
      } catch (e) {
        snapshot = { error: String(e).slice(0, 160) }
      }
      return { ...out, observe: snapshot }
    }

    // ---- 常驻进程快路径
    if (warmEnabled()) {
      await warmStart()
      if (warm.proc && warm.ready === true) {
        const payload = {
          action, name, aid, value, ascii, match, waitMs, procId,
          index, inAid, inName, waitFor, state, keys,
          fromX, fromY, toX, toY, steps, holdMs, max,
          // 跨窗口 + 凭据 + 竞速等待（漏传过一次：warm 路径下这些参数全部失效）
          winTitle, winHandle, secret, expectValue,
          titleRe, textRe, gone, ms, interval, conds, stableCount,
          // 图表交互（同样漏传过：warm 路径下 move/wheel/clickat 收到 x=0,y=0）
          x, y, delta, count, mods, double, button, focus,
        }
        if (action === 'shot' || action === 'capture') payload.out = shotPlan.path
        // 超时口径：调用方显式给的 timeoutMs 优先，但 capture/shot 上限 60s
        // （Claude 评审 1.3：原来 direct 硬选 60000，live 传的 timeoutMs:8000 被吞，
        //  一次卡帧顶死 single-flight 最长 60s/10min——现在 min(caller,60s) 生效）。
        const callerMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : c.defaultTimeoutMs
        const effMs = (action === 'shot' || action === 'capture') ? Math.min(callerMs, 60000) : callerMs
        let res = await warmSend(payload, effMs, { killOnTimeout: action === 'capture' ? false : true })
        if (res && res.ok === false && res.timeout === true) {
          // 超时 ≠ 没执行：请求可能已经到达并被处理，只是响应没回来。
          // 副作用动作绝不能走回退路径重放（会点两次 / 输两次），必须如实
          // 报告「执行状态未知」，让调用方先查控件状态再决定。
          // （Codex/Astra 跨模型复核提出的 blocker。）
          if (!READ_ONLY_ACTIONS.has(action)) {
            return {
              ok: false,
              action,
              unknown: true,
              error: '常驻进程超时：' + action + ' 可能已执行但未收到结果，未做任何重试（避免重复副作用）。请用 read/find 复核控件状态后再决定。',
            }
          }
          // 只读动作：超时后常驻进程已被判僵死杀掉，**重试一次**（B-2 的「失败重试」）——
          // 换新进程 + ready 握手 + 重新解析 PID/主窗口，且总时长受 20s 上限约束，
          // 绝不无限等。只读重放没有副作用，重试是安全的。
          const up = await warmStart()
          if (up) {
            const r2 = await warmSend(payload, Math.min(effMs, 20000), { killOnTimeout: true })
            if (r2 && r2.ok === true) res = r2
            else if (!res.killed && r2 && r2.error) res = r2
          }
        }
        if (res) return await attachObserve(shapeResult(action, res, shotPlan, workspace))
        // 只读动作：常驻进程不可用时回退一次性脚本路径是安全的
      }
    }

    // ---- 回退：批量引擎单步（type/drag/windows/waitfor 只有批量引擎实现；
    //      其余动作在传了 index/inAid/waitFor 时也必须走批量，一次性脚本不认识）
    const needsBatch =
      BATCH_ONLY_ACTIONS.has(action) || wantObserve || /\$\{cred:/.test(String(value) + String(keys)) ||
      index !== undefined || inAid !== '' || inName !== '' || waitFor !== null || keys !== ''
    if (needsBatch) {
      const b = await batch({
        steps: [stepFields({
          action, name, aid, value, ascii, match, waitMs, index, inAid, inName, waitFor, state, keys,
          fromX, fromY, toX, toY, steps, holdMs, max, x, y, delta, count, mods,
          winTitle, winHandle, secret, expectValue, titleRe, textRe, gone, ms, interval, conds,
          out: shotPlan ? shotPlan.path : undefined,
        })],
        procId,
        waitMs,
      })
      if (!b.ok || b.steps.length === 0) {
        return { ok: false, action, error: b.error || '批量单步执行失败' }
      }
      return await attachObserve(shapeResult(action, b.steps[0], shotPlan, workspace))
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

    // 单步超时：默认 90s，可用 timeoutMs 收紧（右键菜单/read 这类容易挂住的动作用）
    const stepTimeout = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : c.defaultTimeoutMs
    const r = await runPs1(driveScript(), psArgs, action === 'shot' ? 60000 : stepTimeout)
    const text = r.stdout
    const notFound = /NOT_FOUND/.test(text)

    if (action === 'find') {
      const m = text.match(/FOUND (.+)/)
      if (m) return await attachObserve({ ok: true, action, found: true, detail: m[1] })
      if (notFound) return await attachObserve({ ok: true, action, found: false, detail: null })
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    if (action === 'click' || action === 'setvalue' || action === 'key') {
      if (notFound) return { ok: false, action, notFound: true, error: '未找到目标控件（' + (name || aid) + '）' }
      const m = text.match(/^(CLICKED|SET|KEYED)(.*)$/m)
      if (m) return await attachObserve({ ok: true, action, output: (m[1] + m[2]).trim() })
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    if (action === 'read') {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\[(Button|Edit|Text|RadioButton|CheckBox|TabItem|ComboBox|ListItem|MenuItem|TreeItem|Hyperlink)\]/.test(l))
      // 回退脚本（ui-drive.ps1）的 read 同样逐元素容错并回报 SKIPPED（B-1）；
      // 老版本脚本没有这一行 → skipped=null（未知），不谎报 0
      const sk = text.match(/^SKIPPED\s+(\d+)\s*$/m)
      const reason = text.match(/^SKIPREASON\s+(.+)$/m)
      const raw = { skipped: sk ? Number(sk[1]) : null }
      if (reason) raw.skippedReasons = [reason[1].trim()]
      return { ok: true, action, count: lines.length, lines: lines.slice(0, 200), truncated: text.length > LIMIT_READ, ...skipInfo(raw) }
    }
    if (action === 'shot') {
      const m = text.match(/SHOT (.+) (\d+)x(\d+)/)
      if (m) return shapeShot(action, { ok: true, path: m[1], w: Number(m[2]), h: Number(m[3]) }, shotPlan, workspace)
      return { ok: false, action, error: cleanPsError(r.stderr) || text.slice(0, 500) }
    }
    return { ok: false, action, error: '未知动作 ' + action }
  }

  /**
   * PS 5.1 的 ConvertTo-Json 会把单元素集合塌缩成标量（只有一个顶层窗口 /
   * 只有一行控件时 lines 是字符串），而宿主渲染契约要求 lines 恒为 string[]。
   * 统一归一化，避免 "output.render failed: (v.lines || []).join is not a
   * function" 这类渲染崩溃（ui_windows/read/state 单元素时必现）。
   */
  const normLines = (v) => {
    if (v === undefined || v === null) return []
    if (Array.isArray(v)) return v
    return [String(v)]
  }

  /**
   * B-1：跳过计数归一化。
   * 逐元素 try/catch 修好了「整次枚举崩成 0 行」的假空，但静默 continue 会制造**新一轮假空**：
   * 调用方拿到一份「变少了的清单」，却不知道少了几行、为什么少 —— 于是「观测不完整」
   * 和「界面真的没有」分不开（Codex 评审：不能吞错伪装成功）。
   * res.skipped 缺失 = 该引擎没回报 → null（未知），绝不谎报 0。
   */
  const skipInfo = (res) => {
    const n = typeof res.skipped === 'number' ? res.skipped : null
    const reasons = res.skippedReasons ? normLines(res.skippedReasons) : []
    const out = { skipped: n }
    if (reasons.length) out.skippedReasons = reasons
    if (n > 0) {
      out.warn = '⚠ 跳过 ' + n + ' 个读不到状态的元素，本次清单不完整（' +
        (reasons.length ? reasons.join('；') : '原因未回报') +
        '）——不要把「没读到」当成「界面上没有」'
    }
    return out
  }

  /** 把常驻进程返回的原始结果整形成 ui_drive 的稳定返回结构。 */
  function shapeResult(action, res, shotPlan, workspace) {
    if (res.ok !== true) {
      const out = { ok: false, action }
      if (res.error) out.error = res.error
      if (res.notFound) out.notFound = true
      if (res.found !== undefined) out.found = res.found === true
      if (res.waitedMs !== undefined) out.waitedMs = res.waitedMs
      if (res.count !== undefined) out.count = res.count
      return out
    }
    if (action === 'find') {
      const out = { ok: true, action, found: res.found === true, detail: res.detail !== undefined ? res.detail : null }
      if (res.count !== undefined) out.count = res.count
      if (res.waitedMs) out.waitedMs = res.waitedMs
      return out
    }
    if (action === 'read') {
      return { ok: true, action, count: res.count || 0, lines: normLines(res.lines), truncated: false, ...skipInfo(res) }
    }
    if (action === 'windows') return { ok: true, action, count: res.count || 0, lines: normLines(res.lines) }
    if (action === 'state') {
      return {
        ok: true,
        action,
        window: res.window ?? null,
        focusedWindow: res.focusedWindow ?? null,
        focused: res.focused ?? null,
        count: res.count || 0,
        lines: normLines(res.lines),
        ...skipInfo(res),
      }
    }
    if (action === 'state-live') {
      // live 循环专用免前台快照：结构与 state 相同，额外带 secretFocused
      // （敏感帧防线：焦点=密码/验证码 → Node 侧跳过抓帧）
      return {
        ok: true,
        action,
        window: res.window ?? null,
        focusedWindow: res.focusedWindow ?? null,
        focused: res.focused ?? null,
        count: res.count || 0,
        lines: normLines(res.lines),
        secretFocused: res.secretFocused === true,
        ...skipInfo(res),
      }
    }
    if (action === 'waitfor') return { ok: true, action, found: res.found === true, detail: res.detail ?? null, waitedMs: res.waitedMs ?? 0 }
    if (action === 'expectwindow' || action === 'expecttext') {
      const out = { ok: true, action, found: res.found === true, waitedMs: res.waitedMs ?? 0 }
      if (res.detail !== undefined) out.detail = res.detail
      if (res.count !== undefined) out.count = res.count
      if (res.lines !== undefined) out.lines = normLines(res.lines)
      return out
    }
    if (action === 'waitany') {
      const out = { ok: true, action, hitIndex: res.hitIndex ?? -1, waitedMs: res.waitedMs ?? 0 }
      if (res.hitKind !== undefined) out.hitKind = res.hitKind
      if (res.hitLabel !== undefined) out.hitLabel = res.hitLabel
      if (res.detail !== undefined) out.detail = res.detail
      return out
    }
    if (action === 'click' || action === 'setvalue' || action === 'key' || action === 'type' || action === 'drag') {
      return { ok: true, action, output: res.output || '' }
    }
    if (action === 'shot') return shapeShot(action, res, shotPlan, workspace)
    if (action === 'capture') {
      const out = {
        ok: res.ok === true,
        action,
        state: res.state || null,
        captureMethod: res.captureMethod || null,
        pid: res.pid ?? null,
        window: res.window ?? null,
      }
      if (res.path) { out.path = res.path; out.w = res.w; out.h = res.h }
      if (res.error) out.error = res.error
      return out
    }
    return { ok: true, action, output: res.output || '' }
  }

  /**
   * shot 结果：截图只写证据目录（DSH_UI_EVIDENCE_DIR，默认 ~/.dsh-agent-toolchain/
   * ui-evidence，可指向 E 盘），不再复制进 workspace/仓库——用户约定：UI 截图一律
   * 丢 E 盘，仓库只放代码证据。旧版本会把副本写进 <workspace>/.dsh-ui-evidence，
   * 该目录曾误入 git status；现在显式拒绝（workspace 参数保留兼容，忽略）。
   */
  function shapeShot(action, res, shotPlan, workspace) {
    const src = res.path
    return { ok: true, action, path: src, w: res.w, h: res.h, workspacePath: null }
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
      const o = { action: normAction(s.action) }
      if (s.name !== undefined) o.name = s.name
      if (s.aid !== undefined) o.aid = s.aid
      if (s.value !== undefined) o.value = s.value
      if (s.ascii !== undefined) o.ascii = s.ascii
      if (s.match !== undefined) o.match = s.match
      if (s.out !== undefined) o.out = s.out
      if (s.waitMs !== undefined && s.waitMs !== null) o.waitMs = s.waitMs
      if (s.expectEnabled !== undefined) o.expectEnabled = s.expectEnabled
      if (s.expectMatch !== undefined) o.expectMatch = s.expectMatch
      if (s.index !== undefined && s.index !== null) o.index = s.index
      if (s.inAid !== undefined && s.inAid !== '') o.inAid = s.inAid
      if (s.inName !== undefined && s.inName !== '') o.inName = s.inName
      if (s.waitFor !== undefined && s.waitFor !== null) o.waitFor = s.waitFor
      if (s.state !== undefined && s.state !== '') o.state = s.state
      if (s.keys !== undefined && s.keys !== '') o.keys = s.keys
      if (s.fromX !== undefined && s.fromX !== null) o.fromX = s.fromX
      if (s.fromY !== undefined && s.fromY !== null) o.fromY = s.fromY
      if (s.toX !== undefined && s.toX !== null) o.toX = s.toX
      if (s.toY !== undefined && s.toY !== null) o.toY = s.toY
      if (s.steps !== undefined && s.steps !== null) o.steps = s.steps
      if (s.holdMs !== undefined && s.holdMs !== null) o.holdMs = s.holdMs
      if (s.x !== undefined && s.x !== null) o.x = s.x
      if (s.y !== undefined && s.y !== null) o.y = s.y
      if (s.double !== undefined) o.double = s.double
      if (s.button !== undefined && s.button !== '') o.button = s.button
      if (s.focus !== undefined) o.focus = s.focus
      if (s.delta !== undefined && s.delta !== null) o.delta = s.delta
      if (s.count !== undefined && s.count !== null) o.count = s.count
      if (s.mods !== undefined && s.mods !== '') o.mods = s.mods
      if (s.max !== undefined && s.max !== null) o.max = s.max
      if (s.winTitle !== undefined && s.winTitle !== '') o.winTitle = s.winTitle
      if (s.winHandle !== undefined && s.winHandle !== null) o.winHandle = s.winHandle
      if (s.secret === true) o.secret = true
      if (s.expectValue !== undefined && s.expectValue !== null) o.expectValue = s.expectValue
      if (s.titleRe !== undefined && s.titleRe !== '') o.titleRe = s.titleRe
      if (s.textRe !== undefined && s.textRe !== '') o.textRe = s.textRe
      if (s.gone !== undefined) o.gone = s.gone
      if (s.ms !== undefined && s.ms !== null) o.ms = s.ms
      if (s.interval !== undefined && s.interval !== null) o.interval = s.interval
      if (s.conds !== undefined && s.conds !== null) o.conds = s.conds
      if (s.stableCount !== undefined && s.stableCount !== null) o.stableCount = s.stableCount
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

  const FLOW_ACTIONS = new Set(['find', 'click', 'setvalue', 'key', 'type', 'drag', 'read', 'state', 'shot', 'wait', 'waitfor', 'expect', 'windows', 'expectwindow', 'expecttext', 'waitany'])

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
      const action = normAction(s.action)
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
        : (action === 'read' || action === 'find' || action === 'expect' || action === 'shot' || action === 'windows' || action === 'state' ? 0 : (waitMs !== undefined ? waitMs : c.defaultWaitMs))
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
        index: s.index,
        inAid: s.inAid,
        inName: s.inName,
        waitFor: s.waitFor,
        state: s.state,
        keys: s.keys,
        fromX: s.fromX,
        fromY: s.fromY,
        toX: s.toX,
        toY: s.toY,
        steps: s.steps,
        holdMs: s.holdMs,
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
        entry.lines = normLines(res.lines).slice(0, 50)
        Object.assign(entry, skipInfo(res)) // B-1：跳过数随每一步一起回报
      } else if (action === 'windows') {
        entry.count = res.count || 0
        entry.lines = normLines(res.lines)
      } else if (action === 'state') {
        entry.window = res.window ?? null
        entry.focusedWindow = res.focusedWindow ?? null
        entry.focused = res.focused ?? null
        entry.count = res.count || 0
        entry.lines = normLines(res.lines)
        Object.assign(entry, skipInfo(res))
      } else if (action === 'waitfor' || action === 'expectwindow' || action === 'expecttext' || action === 'waitany') {
        entry.found = res.found === true
        if (res.detail !== undefined) entry.detail = res.detail
        if (res.waitedMs !== undefined) entry.waitedMs = res.waitedMs
        if (res.count !== undefined) entry.count = res.count
        if (res.lines !== undefined) entry.lines = normLines(res.lines)
        if (res.hitIndex !== undefined) { entry.hitIndex = res.hitIndex; entry.hitKind = res.hitKind; entry.hitLabel = res.hitLabel }
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

      if (action === 'expect' || action === 'waitfor' || action === 'expectwindow' || action === 'expecttext' || action === 'waitany') {
        ok ? passed++ : failed++
        entry.ok = ok
        w('step ' + r.step + ': ' + action + ' ' + (ok ? 'PASS' : 'FAIL') + ' ' + (res.detail || '(未找到)') + (res.reasons ? ' [' + res.reasons + ']' : '') + (res.waitedMs ? ' (' + res.waitedMs + 'ms)' : ''))
        transcript.push(entry)
        if (!ok && failFast) break
        continue
      }

      entry.ok = ok
      if (action === 'shot') w('step ' + r.step + ': shot ' + (ok ? (res.path + ' ' + res.w + 'x' + res.h) : 'FAIL ' + (res.error || '')))
      else if (action === 'read') w('step ' + r.step + ': read ' + (res.count || 0) + ' 行' + (res.skipped > 0 ? '（跳过 ' + res.skipped + ' 个读不到状态的元素）' : ''))
      else if (action === 'windows') w('step ' + r.step + ': windows ' + (res.count || 0) + ' 个窗口')
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
    warmRestart,
    // 显式释放客户端互斥锁（长跑脚本轮间让锁用；进程退出时会自动释放）
    releaseLock: () => {
      if (!lockPath) return
      try { rmSync(lockPath, { force: true }) } catch { /* ignore */ }
      HELD_LOCKS.delete(lockPath)
    },
    warmStatus,
    evidenceDir: () => c.evidenceDir,
    scriptsDir: () => c.scriptsDir,
    clientExe: () => c.clientExe,
  }
}
