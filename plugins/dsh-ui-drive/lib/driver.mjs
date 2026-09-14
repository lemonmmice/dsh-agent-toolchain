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
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { decodeBuffer } from '../../../lib/decode.mjs'
import { envOr, unconfiguredHint, envWithPrefix } from '../../../lib/env-fallback.mjs'
import { createPolicy } from './policy.mjs'
import { createEnvelope, envelopeSummary, envelopeToLine } from './evidence.mjs'

// 解释器路径用户可配：经 env-fallback（长活宿主的进程环境里可能没有用户后来设的值）。
const PS = envOr('DSH_UI_POWERSHELL') || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 每类输出的截断上限（字符），防止超长结果挤爆上下文。 */
const LIMIT_READ = 20000
const LIMIT_TREE = 14000
/**
 * `ui_flow` transcript 里单步 read 保留的行数（Claude 第七轮 Q2）。
 * 这个数字**必须显式回报**（`linesCappedAt` + `note`）—— 真机实测过没有回报时的后果：
 * read 步 count=320、lines 50 条、无 truncated/returned，看 transcript 的人会把 50 条
 * 当成"这个容器的全部控件"，而真实容器（个股表）能到 70+ 条。
 */
const TRANSCRIPT_READ_LINES = 50

/** 动作后的默认静默等待：UIA 动作本身是同步的，1200ms 纯属浪费。 */
export const DEFAULT_WAIT_MS = 250

/**
 * `ui_launch(force=true)` 在杀进程之后的**重启判决**（F-039，**纯函数**，便于单测）。
 *
 * 抽出来的理由与 F-038 同源：这段判决原本埋在 `launch()` 里、要靠真起/真杀进程才能触发，
 * 于是"杀进程核对窗口刚好差一点"这种时序窗口**没法单测**，只能靠全量并发跑碰运气。
 *
 * 三种情况：
 *   · `killed === true`                     ⇒ 正常重启（`lateExit:false`）
 *   · `killed === false` 且复核后**已没了**  ⇒ **仍然重启**，并标注 `lateExit` ——
 *     这就是 F-039：原行为是在这里放弃重启并谎称"仍在运行"，而进程其实已经退出。
 *   · `killed === false` 且复核后**还在**    ⇒ **拒绝重启**（红线：绝不起第二个实例）
 *
 * **不变量**：`stillHere === true` 时**永远不** proceed。
 */
export function forceRestartDecision({ killed, stillHere }) {
  if (killed === true) return { proceed: true, lateExit: false, reason: 'killed' }
  if (stillHere !== true) return { proceed: true, lateExit: true, reason: 'late-exit' }
  return { proceed: false, lateExit: false, reason: 'still-running' }
}

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
    // 配置来源：进程环境优先，进程里没有时回退到用户级/机器级注册表（见 lib/env-fallback.mjs）——
    // 真机实测：用户在宿主启动**之后**才 setx，宿主的 process.env 里没有这些变量，
    // 工具却报「未配置目标进程」，等于告诉用户去做他已经做过的事。
    procName: envOr('DSH_UI_PROC_NAME'),
    windowName: envOr('DSH_UI_WINDOW_NAME'),
    clientExe: envOr('DSH_UI_CLIENT_EXE'),
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'ui-evidence'),
    defaultTimeoutMs: 90000,
    defaultWaitMs: DEFAULT_WAIT_MS,
    ...cfg,
  }
  // 空字符串不是「配置」：MCP 侧习惯传 evidenceDir: process.env.X || ''，
  // 直接展开会让空值覆盖默认值，证据目录退化成 cwd 下的相对路径。
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'ui-evidence')
  if (!c.scriptsDir) c.scriptsDir = join(import.meta.dirname, '..', 'scripts')
  // createPolicy 不再接收 classifyAction：动作分类统一由本层的 classifyAction 负责，写侧门只在
  // **副作用动作**上调用 policy.check（policy 内原按 Symbol 判只读的 readOnly() 是死契约，已随 P2 删除）。
  const policy = c.policy || createPolicy()

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
        // 把**解析好的**配置显式传给子进程（2026-09-11）。
        // 起因：`DSH_UI_PROC_NAME` 等变量在宿主启动后才写进用户级环境变量 → 宿主的 process.env 里没有 →
        // 它 spawn 的 PowerShell 自然也看不到，而**脚本内部**（`$env:DSH_SNOOP_DIR` / `$env:DSH_UI_PROC_NAME`）
        // 是直接读环境变量的，Node 侧的回退救不了它们。结果：ui_tree 因为"找不到 Snoop 目录"整个不可用，
        // 而错误只进 stderr、被上层当成"探针没返回内容"。
        // 这里注入的是**已经解析过**的值（进程环境优先，其次用户级/机器级注册表），进程环境原样保留。
        const env = { ...process.env }
        if (c.procName) env.DSH_UI_PROC_NAME = c.procName
        if (c.windowName) env.DSH_UI_WINDOW_NAME = c.windowName
        if (c.clientExe) env.DSH_UI_CLIENT_EXE = c.clientExe
        if (c.evidenceDir) env.DSH_UI_EVIDENCE_DIR = c.evidenceDir
        const snoop = envOr('DSH_SNOOP_DIR')
        if (snoop) env.DSH_SNOOP_DIR = snoop
        // 凭据同样是**子进程里读环境变量**的（`${cred:name}` → `DSH_CRED_name`），而它是**带前缀的动态名**：
        // 用户按 Windows 常规把凭据配在用户级环境变量里、长活宿主没继承 ⇒ 脚本读不到 ⇒
        // 报「凭据占位符未解析」；人为了继续，就会**把明文贴进参数** —— 正是这个机制要防的事。
        // 所以把注册表里所有 DSH_CRED_* 一并注入（进程环境已有的优先，值不被覆盖）。
        Object.assign(env, missingCredEnv(env))
        child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], { windowsHide: true, env })
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
  async function status({ timeoutMs = 30000, procId = 0 } = {}) {
    const procName = c.procName || (c.clientExe ? basename(c.clientExe).replace(/\.exe$/i, '') : '')
    if (!procName && !c.clientExe) {
      // 未配置目标进程：明确区分「未配置」与「未运行」，避免三个状态塌缩成一个 running:false。
      // 并且要说清**到底是没配过，还是配了但当前进程没继承**（后者只需重启宿主）——
      // 只说"去设置 X"会教用户做他已经做过的事（真机实测过这一条）。
      return {
        running: false,
        unconfigured: true,
        error: '未配置目标进程（设置 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE）',
        configHint: unconfiguredHint(['DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE']),
      }
    }
    const script = existsSync(batchScript()) ? batchScript() : driveScript()
    // G1 黑盒 #1：多实例（同名进程）时 status 无法消歧，而 ui_drive/ui_observe 都能传 procId —— 口径不一致。
    // 脚本本身早就支持 `-ProcId`（param 里就有，Get-MainWindow/Get-Windows 都按 pid 取），这里把它接上。
    const pidArgs = procId > 0 ? ['-ProcId', String(procId)] : []
    const args = existsSync(batchScript())
      ? ['-Status', '-ProcName', procName, '-WindowName', c.windowName, ...pidArgs]
      : ['-ProcName', procName, '-WindowName', c.windowName, '-Action', 'status', ...pidArgs]
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
  /**
   * 同名进程的 PID 列表（tasklist，不经 PowerShell —— 这条路径在 force 重启里是热路径）。
   * 与 dsh-build 的 listClientPids 同一实现口径：按**镜像名**枚举，再由 exePathOf 做实例判别。
   */
  /**
   * 编程错误识别 —— 让 "永不抛" 的兜底**不要吞掉自己的 bug**。
   *
   * 实测教训（2026-09-11）：force 重启第一版里 `listPidsByName` 用了 `execFileSync`，
   * 而本文件只 import 了 `spawn` → **ReferenceError** 被 `catch { return [] }` 吃掉 →
   * 枚举恒为空 → force 永远报 "nothingToKill" → 「卡死重启」这个功能**静默地什么都不做**，
   * 而所有断言（"没有误杀"）还都是绿的。
   * 归纳成规则：**环境失败可以降级，编程错误必须炸**。
   */
  function isProgrammingError(e) {
    const s = String((e && e.message) || e)
    return (e && (e.name === 'ReferenceError' || e.name === 'TypeError' || e.name === 'SyntaxError')) ||
      /is not defined|is not a function|Cannot read propert/.test(s)
  }

  function listPidsByName(proc) {
    const name = String(proc || '').trim()
    if (!name) return []
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + name + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const pids = []
      const re = new RegExp('"' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.exe","(\\d+)"', 'g')
      let m
      while ((m = re.exec(out)) !== null) pids.push(Number(m[1]))
      return pids
    } catch (e) {
      if (isProgrammingError(e)) throw e
      return []
    }
  }

  /** 单个 PID 是否还活着（按 PID 精确判定，不用"同名进程列表为空"当判据）。 */
  function isPidAlive(pid) {
    if (!pid) return false
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      return new RegExp('","' + pid + '",').test(out)
    } catch (e) {
      if (isProgrammingError(e)) throw e
      return false
    }
  }

  /** 某个 PID 的可执行文件全路径（拿不到返回空串，绝不抛）。只在真要动手/有歧义时调用。 */
  function exePathOf(pid) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").ExecutablePath'], { encoding: 'utf8', windowsHide: true })
      return String(out || '').trim().split(/\r?\n/)[0] || ''
    } catch (e) {
      if (isProgrammingError(e)) throw e
      return ''
    }
  }

  /**
   * 定位同名进程（force 重启用）。返回 [{pid, path}]；path 拿不到就给空串。
   * 只用于"要动谁"的判断，不改任何状态。
   */
  function clientInstances() {
    const name = (c.procName || '').trim()
    if (!name) return []
    const pids = listPidsByName(name)
    return pids.map((pid) => ({ pid, path: exePathOf(pid) }))
  }

  /**
   * 用**与 `killClientInstances()` 完全相同的规则**重新算出"我们会杀的那些实例"。
   *
   * 存在的唯一理由：force 重启在 `killed:false` 之后要**复核一次**再决定是否放弃（F-039）。
   * 复核**不能**用"按进程名的粗枚举" —— 那会把**别的会话的同名实例**也算成"还在"，
   * 于是"只杀 exe 路径匹配的那一个"的场景会被误判成"没杀掉"（第一版就是这么错的，被 D 段抓住）。
   */
  function targetInstancesNow() {
    const want = String(c.clientExe || '').trim().toLowerCase()
    const insts = clientInstances()
    if (insts.length === 0) return []
    // 与 killClientInstances 同源：配了 exe 路径 ⇒ 只认路径一致的；否则只有唯一实例才敢认。
    if (want) return insts.filter((i) => String(i.path || '').toLowerCase() === want)
    return insts.length === 1 ? insts : []
  }

  /**
   * 结束目标客户端并**等它真的退出**（force 重启用）。
   *
   * 实例定位规则与 dsh-build 的 killClientProcess 同源（红线优先，宁可拒绝也不误杀）：
   *   1) 配了 DSH_UI_CLIENT_EXE → 只杀**路径一致**的实例；
   *   2) 没配路径但只有 1 个实例 → 杀它（无歧义）；
   *   3) ≥2 个实例且没配路径 → **拒绝**，如实回报清单（绝不猜哪个是"我们的"客户端）。
   */
  async function killClientInstances() {
    const startedAt = Date.now()
    const want = String(c.clientExe || '').trim().toLowerCase()
    const insts = clientInstances()
    if (insts.length === 0) return { killed: false, nothingToKill: true, pids: [], waitedMs: 0 }
    let targets = insts
    let scope = 'single-instance'
    if (want) {
      targets = insts.filter((i) => String(i.path || '').toLowerCase() === want)
      scope = 'exe-path'
      if (targets.length === 0) {
        return {
          killed: false,
          refused: true,
          scope,
          pids: [],
          instances: insts,
          waitedMs: 0,
          error: '按 DSH_UI_CLIENT_EXE 找不到匹配的进程实例（同名进程的 exe 路径都对不上）：已拒绝强杀，避免误杀其它会话的客户端。实际实例：' +
            insts.map((i) => i.pid + '@' + (i.path || '?')).join('、'),
        }
      }
    } else if (insts.length > 1) {
      return {
        killed: false,
        refused: true,
        scope: 'ambiguous',
        pids: [],
        instances: insts,
        waitedMs: 0,
        error: '同名进程有 ' + insts.length + ' 个且未配置 DSH_UI_CLIENT_EXE，无法确定要动哪一个：已拒绝强杀（避免误杀其它会话）。' +
          '实例：' + insts.map((i) => i.pid + '@' + (i.path || '?')).join('、') + '。请配置 DSH_UI_CLIENT_EXE 或手工处理。',
      }
    }
    const pids = targets.map((t) => t.pid)
    // 强杀必须**同步拿到结果**（2026-09-11，压测下两次实测漏杀之后）：
    //   旧写法 `spawn('taskkill', …)` 是 fire-and-forget，结果与错误全丢 —— 于是"没杀掉"时
    //   调用方只看到 `killed:false`，**不知道为什么**（taskkill 压根没起来？被拒绝？进程还在退？）。
    //   现在用 execFileSync（有超时），把每次的 stderr 收下来如实回报（killErrors）。
    const killErrors = []
    const killOnce = () => {
      for (const pid of pids) {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          const msg = String((e && (e.stderr || e.message)) || e).replace(/\s+/g, ' ').trim().slice(0, 160)
          if (msg) killErrors.push(pid + ': ' + msg)
        }
      }
    }
    killOnce()
    // 等它真的退出：taskkill 是异步的，进程还在时"重启"会撞文件锁/单实例互斥。
    // 预算内**持续重试**（不是只重试一次）：高负载下 taskkill.exe 起进程本身就要几秒。
    const deadline = Date.now() + (Number(process.env.DSH_UI_KILL_WAIT_MS) || 15000)
    const remaining = []
    let retried = 0
    let lastKillAt = Date.now()
    while (Date.now() < deadline) {
      remaining.length = 0
      for (const pid of pids) if (isPidAlive(pid)) remaining.push(pid)
      if (remaining.length === 0) break
      if (Date.now() - lastKillAt >= 1500) { retried++; killOnce(); lastKillAt = Date.now() }
      await sleep(150)
    }
    return {
      killed: remaining.length === 0,
      scope,
      pids,
      // retries/killErrors 都是**显式字段**：重试过、以及 taskkill 报了什么，调用方有权知道。
      retries: retried,
      ...(killErrors.length ? { killErrors: killErrors.slice(-4) } : {}),
      remaining: [...remaining],
      waitedMs: Date.now() - startedAt,
      instances: insts,
    }
  }

  async function launch({ extraArgs = '', waitMs = 60000, force = false } = {}) {
    const startedAt = Date.now()
    // 复核（Codex 2026-09-11）指出：旧写法 `Math.max(3000, waitMs)` 会把调用方显式传的
    // `waitMs=1000` 偷偷抬到 3s，违背「调用方显式优先」的既有约定。现在只挡非法值（<=0/NaN）
    // 并给一个 500ms 下限，显式传入多少就是多少。
    const requested = Number(waitMs)
    const budget = requested > 0 ? Math.max(500, requested) : 60000
    const st0 = await status({ timeoutMs: Math.min(30000, budget) })
    if (st0.running && st0.title && force !== true) {
      return { ok: true, windowReady: true, started: false, alreadyRunning: true, pid: st0.pid, title: st0.title, waitedMs: 0 }
    }
    // ---- force：显式重启（Codex 第九轮指出的能力缺口）----
    // 上一版把"进程在跑但没窗口"一律拒绝 spawn（防重复实例），但那样**卡死后就无法重启**：
    // ui_launch 既不会杀也不给 force，用户只能手工去关。而"客户端卡死 → 重启 → 复现"正是本工具链
    // 存在的意义。所以开一条**显式**通道：只有 force=true 才动进程，且杀谁、等多久、还剩谁，全部如实回报。
    let forceKill = null
    if (force === true && st0.running) {
      forceKill = await killClientInstances()
      if (forceKill.refused) {
        return { ok: false, windowReady: false, partial: false, started: false, alreadyRunning: true, pid: st0.pid, title: st0.title || null, waitedMs: Date.now() - startedAt, forceKill, error: forceKill.error, hint: 'force 已被拒绝执行：没有唯一确定的目标实例。配置 DSH_UI_CLIENT_EXE 指向目标 exe，或手工关闭后再 ui_launch。' }
      }
      if (!forceKill.killed) {
        // ★ F-039（2026-09-12 r35，从一次**真机失败**里查出来的）：
        //   不要**立刻**放弃。`killClientInstances` 只是说"在它的时间窗口内没观察到退出"，
        //   那不等于"现在还活着"。实测（launch-force 在**全量测试并发跑**时）：
        //     它报 `killed:false, remaining:[6856], waitedMs:21145`，
        //     而**紧接着的下一行断言就证明该进程已经没了** —— 进程是在核对窗口**之后**才消失的。
        //   旧行为：直接 return `alreadyRunning:true`（而且 `pid` 指向一个**已经死掉**的进程）且**不重启** ——
        //   于是 `ui_launch(force=true)` 这条**卡死重启通道**静默地什么都没做。
        //   而"客户端卡死 → 重启 → 复现"正是本工具链存在的意义（见上面 398-400 行的设计说明），
        //   更糟的是：**负载越高越容易触发**，而负载高恰恰是客户端最容易卡死的时刻。
        //
        //   现在：**有界地再复核一次**（最多 ~2s）——
        //     · 复核后确实还有同名实例 ⇒ 保持原语义（拒绝重启，宁可不动也不起第二个实例）；
        //     · 复核后已经没了       ⇒ **继续重启**，并如实标注 `lateExit`（"晚了一步，不是没杀掉"）。
        //   注意这里刻意用**按进程名**的廉价复核，而不是 `clientInstances()`（后者每个 pid 要起一次
        //   PowerShell 拿 exe 路径，在就是"慢"的场景里再拖几秒是雪上加霜）。宁可保守：只要还有同名实例就先不动。
        // ⚠ 复核必须**按同一套目标规则**来 —— 这是第一版的 bug（被全量自检的 D 段当场抓住）：
        //   我用 `listPidsByName(procName)` 做复核，它会把**别的会话的同名实例**也算进来；
        //   而 D 段恰恰是"两个同名实例、只杀 exe 路径匹配的那一个"的场景 ⇒ 复核永远说"还在" ⇒
        //   拒绝重启 ⇒ `forceKill.killed` 仍是 false ⇒ D 段红。
        //   **"保守"不能保守到"把不归我管的实例也算成我的"** —— 那不是保守，那是判断错。
        //   正确做法：用与 `killClientInstances()` **完全相同**的目标选择规则重算一次"我会杀的那些"。
        const stillHere = targetInstancesNow()
        for (let i = 0; i < 10 && stillHere.length > 0; i++) {
          await new Promise((r) => setTimeout(r, 200))
          stillHere.length = 0
          stillHere.push(...targetInstancesNow())
        }
        const decision = forceRestartDecision({ killed: forceKill.killed, stillHere: stillHere.length > 0 })
        if (!decision.proceed) {
          return { ok: false, windowReady: false, partial: false, started: false, alreadyRunning: true, pid: st0.pid, title: st0.title || null, waitedMs: Date.now() - startedAt, forceKill, error: 'force=true 但目标进程仍未退出（PID ' + (forceKill.remaining || []).join(',') + '，等待 ' + forceKill.waitedMs + 'ms，重试 ' + (forceKill.retries || 0) + ' 次' + (forceKill.killErrors && forceKill.killErrors.length ? '；taskkill 报错：' + forceKill.killErrors.join(' | ') : '') + '）：没有重启，避免在旧进程还活着时再拉起一个。' }
        }
        forceKill = {
          ...forceKill,
          killed: true,
          lateExit: true,
          remaining: [],
          note: 'kill 核对窗口内未观察到退出，但**复核时已不存在**（晚了一步）—— 视为已结束，继续重启。'
            + '（原行为会在这里放弃重启并谎称"仍在运行"；F-039）',
        }
      }
    }
    if (st0.running && !st0.title && force !== true) {
      return {
        ok: false,
        windowReady: false,
        partial: true,
        started: false,
        alreadyRunning: true,
        pid: st0.pid,
        title: null,
        waitedMs: 0,
        hint: '进程已经在运行（pid=' + st0.pid + '）但主窗口还没出现：**不会重复拉起第二个实例**（两个实例会抢同一份配置/日志/文件锁）。' +
          '下一步：ui_status / ui_windows 看窗口列表与状态；如果它是**卡死**了要重启，请显式传 force=true（会先结束这个进程再启动，先跟用户确认）。',
      }
    }
    if (!existsSync(c.clientExe)) {
      return { ok: false, started: false, error: '客户端 exe 不存在：' + c.clientExe + '（可用 DSH_UI_CLIENT_EXE 覆盖）' }
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
      return { ok: false, started: false, error: '启动失败: ' + e }
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
        return { ok: true, windowReady: true, started: true, alreadyRunning: false, pid: last.pid, title: last.title, waitedMs: Date.now() - startedAt, polls, ...(forceKill ? { forceKill, restarted: true } : {}) }
      }
    }
    const running = last ? last.running : false
    // UD-06（原 P1 清单第 6 条，2026-09-11）：**半成功被当成成功**。
    // 旧结果里 `started: running` —— 进程起来了但没有主窗口时 `started:true`，
    // 而"没有窗口"这件事只写在 `warning` 里；渲染层在 started 分支**根本不打印 warning**，
    // 于是 agent 看到的是"已启动 pid=… 窗口=null"，接着去用别的 ui_* 工具，全部失败。
    // 修法（数据层，两面通用）：`ok` 只在**窗口真的可用**时为 true；
    // 半成功显式标 `partial:true` + `windowReady:false` + 可执行的 hint。
    const partial = running && !(last && last.title)
    return {
      ok: false,
      windowReady: !!(last && last.title),
      partial,
      started: running,
      alreadyRunning: false,
      pid: last ? last.pid : null,
      title: last ? last.title : null,
      waitedMs: Date.now() - startedAt,
      polls,
      statusTimeouts,
      warning: running ? '进程已起但主窗口超时未出现' : (statusTimeouts > 0 ? '启动超时（其中 ' + statusTimeouts + ' 次状态查询自身超时，进程状态未知）' : '启动超时'),
      ...(forceKill ? { forceKill } : {}),
      hint: partial
        ? '进程在跑但没有可用的主窗口：**不要当成启动成功**（其余 ui_* 工具都需要一个可用窗口）。' +
          '下一步用 ui_status / ui_windows 看窗口列表（**不要直接重发 ui_launch**：进程已存在时它会再拉起一个实例），' +
          '若确认客户端是**卡死**了要重启，请显式传 force=true（会先结束该进程再启动，先跟用户确认）。'
        : '进程在 ' + budget + 'ms 内没有起来：先 ui_status 看是否已在运行，再确认 DSH_UI_CLIENT_EXE 指向的 exe 能手工双击启动。',
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

  // 快照世代（W1 新鲜度门）：客户端/常驻进程重启（warmRestart）时 ++，
  // 令重启前签发的 snapshotId 一律失效（expiredSnapshot）——B-2 绑定：
  // 重启前解析出的元素/快照绝不能授权重启后的副作用动作。
  let currentGen = 0

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
    const warmEnv = { ...process.env }
    if (c.procName) warmEnv.DSH_UI_PROC_NAME = c.procName
    if (c.windowName) warmEnv.DSH_UI_WINDOW_NAME = c.windowName
    if (c.clientExe) warmEnv.DSH_UI_CLIENT_EXE = c.clientExe
    const warmSnoop = envOr('DSH_SNOOP_DIR')
    if (warmSnoop) warmEnv.DSH_SNOOP_DIR = warmSnoop
    // 常驻进程是**长活**的：它的环境在启动那一刻就固定了，之后再来的 `${cred:...}` 只能靠这里注入。
    // 所以走同一条凭据注入（与一次性脚本路径共用 missingCredEnv，避免两处不一致）。
    Object.assign(warmEnv, missingCredEnv(warmEnv))
    const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', batchScript(), '-Serve', '-ProcName', c.procName, '-WindowName', c.windowName, '-ScriptStamp', stamp], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: warmEnv })
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
      if (!e) {
        // 迟到响应：请求已超时（或已被看门狗判死）并出队，响应这时才回来。
        // 复核（Codex 2026-09-11）指出旧实现直接丢弃、不留痕迹 —— 至少要把「结果未知」记下来，
        // 否则事后无法判断「那次超时到底有没有被执行」。
        warm.lateResponses = (warm.lateResponses || 0) + 1
        warm.lastLateResponseAt = Date.now()
        return
      }
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
      let oldestTimeout = 0
      for (const [, e] of warm.pending) {
        if (e.since && e.since < oldest) { oldest = e.since; oldestTimeout = Number(e.timeoutMs) || 0 }
      }
      const now = Date.now()
      // 阈值必须**动作感知**：复核（Codex 2026-09-11）指出固定 stallMs 会误杀合法长动作
      // （例如调用方给了 180s 超时的截图，跑 100s 就被 90s 阈值砍掉）。取
      // max(stallMs, 最老请求自己的超时) —— 看门狗只可能「比请求自己的超时更晚」动手，
      // 于是它只杀真僵死的进程，不会抢在请求还没到期之前替它判死。
      const effStall = Math.max(stallMs, oldestTimeout)
      const idleOk = now - (warm.lastOkAt || warm.startedAt || now)
      const idleOldest = oldest === Number.MAX_SAFE_INTEGER ? 0 : now - oldest
      if (idleOk > effStall && idleOldest > effStall) {
        warm.stalls++
        warm.lastStallAt = now
        warm.lastStallReason = 'watchdog: 排队 ' + warm.pending.size + ' 个请求、' + Math.round(idleOk / 1000) + 's 无成功响应（阈值 ' + Math.round(effStall / 1000) + 's）→ 判僵死并重启常驻进程'
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
        timeoutMs,         // 看门狗用：这条请求自己允许等多久（长动作不能被固定阈值误杀）
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
    // 世代 +1：重启前签发的 snapshotId 就此失效（写门判 expiredSnapshot），
    // 不授权重启后的副作用动作。drive() 的瞬时失败重试也走这里——元素已被销毁/重建，旧快照本就该失效。
    currentGen++
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
      lateResponses: warm.lateResponses || 0,
      lastLateResponseAt: warm.lastLateResponseAt || null,
      disabled: warm.disabled,
    }
  }

  // ------------------------------------------------------------ 单步驱动

  // 纯输入型动作（移动鼠标/滚轮）：不会致效、可逆，因此不受 allowSideEffects 护栏限制
  // （K线十字光标、列表滚动要用）。
  // 注意（2026-09-11 三方联合评审 P0）：drag/clickat/doubleclick 原先被一并豁免是安全漏洞 ——
  // 它们能落在任意控件上（含任意具名控件），而坐标动作没有控件名，$DENY_RE 无从匹配；
  // 且 drag 的文档一直承诺"必须 allowSideEffects"，代码却没兑现。现三者已移出本集合。
  const INPUT_ACTIONS = new Set(['move', 'wheel'])
  const READ_ONLY_ACTIONS = new Set(['find', 'read', 'shot', 'status', 'windows', 'waitfor', 'state', 'state-live', 'expectwindow', 'expecttext', 'waitany', 'move', 'wheel', 'capture'])

  /**
   * 新动作（type/drag/windows/waitfor/state/expectwindow/expecttext/waitany）与带条件的
   * 等待（waitFor）只有批量引擎实现；一次性脚本路径不支持时走批量引擎单步执行——
   * 语义一致，代价是每步多付一次 PowerShell 启动（约 0.4s），可接受。
   */
  const BATCH_ONLY_ACTIONS = new Set(['type', 'drag', 'move', 'wheel', 'clickat', 'doubleclick', 'pattern', 'scroll', 'selecttext', 'windows', 'waitfor', 'state', 'state-live', 'expectwindow', 'expecttext', 'waitany', 'capture'])

  /** 动作名归一化：waitFor / WaitFor / WAITFOR 都是 waitfor（模型大小写写法不一致）。 */
  function normAction(a) {
    return typeof a === 'string' ? a.trim().toLowerCase() : a
  }

  // ============================================================ W1：动作分类 + 新鲜度门 + diff
  //
  // 三件事共用同一处「写侧单点」checkSideEffectGate（见 driveOnce 开头），不新增第二处接线点：
  //  1) 动作分类契约（W5a）：classifyAction → read / effect / coord-effect / input，未知动作按副作用处理；
  //     写门只 key 在这张表上——W2 的 deny/急停、W5b 的新动词都复用它（表漏一个动词，门就漏一条路）。
  //  2) 新鲜度门（W1）：snapshotId = {seq, gen, windowHandle}。写侧校验
  //     seq==全局最新 ∧ gen==当前世代 ∧（动作若显式声明目标窗口）windowHandle==该窗口；不传则放行（零回归）。
  //     权威 seq 只由 read/state 抬升；state-live 不抬升、不发权威 id。
  //  3) read(diff=true)：与上一次「完整」读做增量；skipped>0 或空枚举时抑制 diff、回落完整清单。

  // 坐标副作用：纯坐标、无具名元素（$DENY_RE 无从按名匹配）→ 快照门是它们的主护栏（W2 靠 estop/坐标策略）。
  // doubleclick 虽走 GetClickablePoint，但解析到了具名 $el（可按名 deny）→ 归 'effect' 而非坐标类。
  const COORD_EFFECT_ACTIONS = new Set(['clickat', 'drag'])

  /**
   * 动作分类契约（W5a）：把「只读 / 具名副作用 / 坐标副作用 / 纯输入」固化成一张表 + 一个函数。
   * 未知动作一律按副作用处理（Codex X3 硬约束）——分类表漏一个动词，写门就漏一条路。
   * @param {string} action
   * @returns {'read'|'effect'|'coord-effect'|'input'}
   */
  function classifyAction(action) {
    const a = normAction(action)
    if (INPUT_ACTIONS.has(a)) return 'input'          // move/wheel：可逆、豁免副作用门
    if (READ_ONLY_ACTIONS.has(a)) return 'read'       // find/read/state/shot/waitfor/... 只读
    if (COORD_EFFECT_ACTIONS.has(a)) return 'coord-effect'
    return 'effect'                                    // click/setvalue/key/type/doubleclick + 一切未知动词
  }
  const isSideEffectKind = (k) => k === 'effect' || k === 'coord-effect'

  // ---- 新鲜度令牌 ----
  // snap.seq   = 权威读的单调快照号；snap.latest = 最近一次权威读的 {seq,gen,windowHandle}。
  // 只有 read/state（经 ui_observe/ui_state/ui_drive）抬升 snap.seq；state-live 不抬升
  //   （否则 live 每 3s 采样一次就系统性作废 agent 的读快照）。currentGen 见上（warmRestart ++）。
  const snap = { seq: 0, latest: null }
  const diffState = { baseline: null } // 上一次「完整」读的 lines（供 diff）；不完整读绝不写它

  /** snapshotId 编码：seq/gen 明文可读，windowHandle 走 base64url（窗口标题可含任意字符）。 */
  function encodeSnapshotId({ seq, gen, windowHandle }) {
    const wh = Buffer.from(String(windowHandle == null ? '' : windowHandle), 'utf8').toString('base64url')
    return 's' + seq + '.g' + gen + '.w' + wh
  }
  /** snapshotId 解码 → {seq,gen,windowHandle}；非字符串/格式不符返回 null（→ unknownSnapshot）。 */
  function decodeSnapshotId(str) {
    if (typeof str !== 'string') return null
    const m = str.match(/^s(\d+)\.g(\d+)\.w(.*)$/)
    if (!m) return null
    let windowHandle = ''
    try { windowHandle = Buffer.from(m[3], 'base64url').toString('utf8') } catch { return null }
    return { seq: Number(m[1]), gen: Number(m[2]), windowHandle }
  }

  /**
   * 抬升权威 seq、记录 latest，返回 {snapshotId}。挂在每个读产出点的 skipInfo 兄弟位。
   * 只对权威读（read/state）调用；state-live 走非权威标记（snapshotAuthoritative:false），不调这里。
   */
  function snapshotStamp(windowHandle) {
    const id = { seq: ++snap.seq, gen: currentGen, windowHandle: String(windowHandle == null ? '' : windowHandle) }
    snap.latest = id
    return { snapshotId: encodeSnapshotId(id) }
  }

  /**
   * 写侧新鲜度校验（W1 缝契约的一半，W2 复用）。纯函数：权威状态从 ctx 显式传入，便于单测/复用。
   * @param {{snapshotId?:string}} args   动作参数（只看 snapshotId）
   * @param {{currentGen:number, latest:(object|null), targetWindow?:string}} ctx  权威状态 + 本次目标窗口
   * @returns {{allow:boolean, code:string, reason?:string}}
   *   code: 'no-snapshot' | 'fresh' | 'staleSnapshot' | 'expiredSnapshot' | 'unknownSnapshot'
   *   reason（仅 staleSnapshot）: 'newer-read-same-window' | 'newer-read-other-window'
   */
  function validateSnapshot(args, ctx) {
    const raw = args ? args.snapshotId : undefined
    if (raw === undefined || raw === null || raw === '') return { allow: true, code: 'no-snapshot' } // 不传 → 放行（零回归）
    const parsed = decodeSnapshotId(String(raw))
    if (!parsed) return { allow: false, code: 'unknownSnapshot' }
    if (parsed.gen !== (ctx.currentGen | 0)) return { allow: false, code: 'expiredSnapshot' } // 重启世代不符
    const latest = ctx.latest
    if (!latest || parsed.seq > latest.seq) return { allow: false, code: 'unknownSnapshot' } // 从未签发（含尚无权威读）
    if (parsed.seq < latest.seq) {
      // 全局 seq 只有一个「最新」：windowHandle 仅用于把 stale 细分成「本窗口真变了」vs
      // 「别的窗口读过、本窗口可能没变」——不建立 per-window latest（那是 v2 (procId,winHandle) 分桶）。
      const reason = parsed.windowHandle === latest.windowHandle ? 'newer-read-same-window' : 'newer-read-other-window'
      return { allow: false, code: 'staleSnapshot', reason }
    }
    // 新鲜（seq==最新 且 gen 一致）。若动作显式声明了目标窗口且与快照来源窗口不符 → 跨窗口复用，
    // 落安全侧拒（v1 不支持「读弹窗后拿其快照点主窗」，多拒→重读；per-window 覆盖列 v2）。
    const target = ctx.targetWindow ? String(ctx.targetWindow) : ''
    if (target && parsed.windowHandle && target !== parsed.windowHandle) {
      return { allow: false, code: 'staleSnapshot', reason: 'newer-read-other-window' }
    }
    return { allow: true, code: 'fresh' }
  }

  /**
   * 写侧单点（唯一接线点）：副作用动作在此过 allowSideEffects + 新鲜度门。
   * W2 的 deny/急停判定在同一函数内、snapshot 校验之后挂钩（见下方 seam 注释），不新增第二处接线点。
   * @returns {{allow:true}|{allow:false, result:object}}
   */
  async function checkSideEffectGate(action, allowSideEffects, gateArgs) {
    if (!isSideEffectKind(classifyAction(action))) return { allow: true } // 只读 / 纯输入：放行
    if (!allowSideEffects) {
      return { allow: false, result: { ok: false, action, error: '动作 ' + action + ' 是真实副作用操作，必须显式传 allowSideEffects=true 才执行（安全护栏）' } }
    }
    const ctx = { currentGen, latest: snap.latest, targetWindow: gateArgs.winTitle || gateArgs.winHandle || c.windowName || '' }
    const v = validateSnapshot(gateArgs, ctx)
    if (!v.allow) {
      const result = { ok: false, action }
      if (v.code === 'staleSnapshot') {
        result.staleSnapshot = v.reason
        result.error = '快照已过期（' + v.reason + '）：此后已有更新的权威读，请重新 read/state 取最新 snapshotId 再操作'
      } else if (v.code === 'expiredSnapshot') {
        result.expiredSnapshot = true
        result.error = '快照世代失效（客户端/常驻进程已重启）：请重新 read/state 取最新 snapshotId 再操作'
      } else {
        result.unknownSnapshot = true
        result.error = '未知 snapshotId（无法解析或从未签发）：拒绝执行，请先 read/state 取 snapshotId'
      }
      return { allow: false, result }
    }
    // —— W2 seam：deny / 急停（estop）判定（同一写侧单点、snapshot 校验之后）——
    // 未配置规则表且无急停哨兵 → 直接放行（零开销，保持既有行为；这是显式集成取舍，见 policy.mjs）。
    if (policy.needsCheck && policy.needsCheck()) {
      let identity = {}
      if (policy.requiresIdentity) {
        try {
          const st = await resolveIdentity()
          identity = st ? { exe: st.exeCanonical || st.exe || '', windowHandle: st.handle, aid: gateArgs.aid } : {}
        } catch {
          // 身份解析失败 → identity 留空，交给 policy 按 deny-first 返回 policy_unavailable（绝不放行）
        }
      }
      const pol = policy.check({ action, identity, allowSideEffects, sessionId: gateArgs.sessionId })
      if (!pol.ok) {
        return { allow: false, result: { ok: false, action, error: pol.error || '策略拒绝', policyCode: pol.code } }
      }
    }
    return { allow: true }
  }

  /**
   * 目标进程身份（W2 policy 门用）：走 status() 的 -Status 快路径，取 exeCanonical / handle。
   * status 是一次性 PS 进程（~0.4s），**按 30s 缓存**，避免每个副作用动作都付这个代价；
   * 缓存失效时重新解析（客户端重启 → exe/句柄变化）。
   */
  let identCache = { at: 0, gen: -1, value: null }
  async function resolveIdentity() {
    // 身份是**授权主键**，必须与 snapshot 挂同一个新鲜度信号：客户端/常驻进程重启（warmRestart → gen++）
    // 后一律重解析。原实现只按 30s TTL，重启后最长 30s 内会用"重启前的身份"去授权"重启后的动作"
    // （独立复核洞 #2：恰好在真正靠 policy 拦人的部署里最不稳）。
    if (identCache.value && identCache.gen === currentGen && Date.now() - identCache.at < 30000) return identCache.value
    const st = await status({ timeoutMs: 8000 })
    const value = st && st.running && st.identity ? st.identity : null
    if (value) identCache = { at: Date.now(), gen: currentGen, value: Object.assign({ handle: st.handle }, value) }
    return identCache.value
  }

  // ---- diff ----
  /** 去掉行首 #序号（位置易变、每次重排都变，不参与语义 diff）。 */
  const diffKey = (line) => String(line).replace(/^#\d+\s*/, '')
  /**
   * read(diff=true)：与上一次「完整」读做增量（B-1 同源护栏）。
   *  · 首读（无基线）→ diffBaseline:true、完整 lines、无幻影 diff；
   *  · skipped>0 或空枚举 → 抑制 diff、diffSuppressed:true、保留 warn、回落完整 lines，且不更新基线
   *    （不完整读写进基线，元素复现时会谎报「新增」；拿它做 diff，会把没读到谎报成「移除」）；
   *  · 否则 → diff:{added,removed,unchanged}，并把当前完整清单设为新基线。
   */
  function attachDiff(out) {
    const incomplete = (typeof out.skipped === 'number' && out.skipped > 0) || out.observation === 'empty-enumeration'
    if (incomplete) return { ...out, diffSuppressed: true }
    const cur = Array.isArray(out.lines) ? out.lines : []
    if (diffState.baseline === null) {
      diffState.baseline = cur
      return { ...out, diffBaseline: true }
    }
    const baseKeys = new Set(diffState.baseline.map(diffKey))
    const curKeys = new Set(cur.map(diffKey))
    const added = cur.filter((l) => !baseKeys.has(diffKey(l)))
    const removed = diffState.baseline.filter((l) => !curKeys.has(diffKey(l)))
    let unchanged = 0
    for (const k of curKeys) if (baseKeys.has(k)) unchanged++
    diffState.baseline = cur
    return { ...out, diff: { added, removed, unchanged } }
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

  async function driveInner(args) {
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

  /**
   * ui_drive：单步动作（公开入口）。
   * W3：**副作用**动作（含被拒的）落一份审查证据包到证据目录（一行一条 JSONL），
   * 返回值带紧凑摘要 evidence/evidenceId；只读与纯输入动作不落（零开销）。
   * 证据写入失败**不得**影响驱动结果，但也**不得静默** —— 失败时结果里带 evidenceError。
   */
  async function drive(args) {
    const res = await driveInner(args)
    return attachEvidence(res, args)
  }

  /** 证据文件：证据目录下按天分目录，一行一个包。 */
  function evidenceFile() { return join(c.evidenceDir, tsDir(), 'evidence.jsonl') }

  function recordEvidence(env) {
    const f = evidenceFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, envelopeToLine(env) + '\n')
    return env.id
  }

  /**
   * 敏感值绝不进证据：凭据占位符与 secret 标记一律脱敏（模型侧本来也看不到明文）。
   * ⚠️ 独立复核 P1-B：原实现只脱敏 `value`，**走 `keys` 的凭据明文落盘** —— 现在两者走同一判定。
   */
  function evidenceSafeValue(args, field) {
    const v = args && args[field]
    if (v == null) return null
    if (args.secret === true || /^\$\{cred:/.test(String(v))) return '[redacted]'
    return String(v)
  }

  /** 从驱动结果反推门结论（供证据固化：判定依据比结论更重要）。 */
  function gateVerdictOf(res) {
    const code = (res && res.policyCode) || null
    let snapshotVerdict = 'ok'
    if (res && res.staleSnapshot) snapshotVerdict = 'stale'
    else if (res && res.expiredSnapshot) snapshotVerdict = 'expired'
    else if (res && res.unknownSnapshot) snapshotVerdict = 'unknown'
    else if (res && res.ok === false && /snapshotId/.test(String(res.error || ''))) snapshotVerdict = 'rejected'
    else if (!(res && (res.snapshotId || (res.__gate && res.__gate.snapshotId)))) snapshotVerdict = 'not_passed'
    return {
      snapshot: { id: (res && res.snapshotId) || null, verdict: snapshotVerdict },
      policy: {
        enabled: !!(policy.isConfigured && policy.isConfigured()),
        decision: code ? 'deny' : ((policy.isConfigured && policy.isConfigured()) ? 'allow' : null),
        code,
      },
      estop: code === 'stopped_by_user' ? { code } : null,
    }
  }

  function attachEvidence(res, args) {
    try {
      const action = normAction((args && args.action) || (res && res.action))
      if (!isSideEffectKind(classifyAction(action))) return res // 只读/纯输入不落证据
      const g = gateVerdictOf(res)
      const ident = identCache.value || {}
      // 账本语义必须自洽（独立复核 P1-A）：
      //   · denied  —— **只有门拒了**才算（policy / 急停 / allowSideEffects / 快照三件套）；
      //   · unknown —— 常驻进程超时等"可能已执行"的情形：驱动自己就标了 unknown，
      //                证据不得反过来断言"被拒/没执行"（原实现就是这么自相矛盾的）；
      //   · action  —— 其余（含"执行器跑了但失败"：executed=true 而 applied=false）。
      const gateDeniedNow = !!(res && (res.policyCode || res.staleSnapshot || res.expiredSnapshot || res.unknownSnapshot))
      const maybeExecuted = !!(res && res.unknown)
      const kindNow = gateDeniedNow ? 'denied' : (maybeExecuted ? 'unknown' : 'action')
      const executedNow = gateDeniedNow ? false : (maybeExecuted ? null : true)
      const appliedNow = !!(res && res.ok)
      const env = createEnvelope({
        kind: kindNow,
        surface: 'ui_drive',
        action,
        params: {
          name: args && args.name,
          aid: args && args.aid,
          value: evidenceSafeValue(args, 'value'),
          keys: evidenceSafeValue(args, 'keys'),
          index: args && args.index,
          extra: stableExtra(args),
        },
        target: {
          name: args && args.name,
          aid: args && args.aid,
          controlType: (res && res.controlType) || null,
          exeCanonical: ident.exeCanonical || null,
          windowHandle: ident.handle == null ? null : ident.handle,
        },
        gates: { allowSideEffects: !!(args && args.allowSideEffects), snapshot: g.snapshot, policy: g.policy, estop: g.estop },
        result: { ok: appliedNow, executed: executedNow, applied: appliedNow, error: res && res.error, output: res && (res.output || res.detail) },
        observation: { before: null, after: null },
        trust: { source: 'agent', untrustedContent: false },
      })
      const id = recordEvidence(env)
      return Object.assign({}, res, { evidence: envelopeSummary(env), evidenceId: id })
    } catch (e) {
      // 不静默：证据失败必须可见，但不能影响驱动本身
      return Object.assign({}, res, { evidenceError: String((e && e.message) || e).slice(0, 200) })
    }
  }

  /** 证据里只放"能定位动作"的最小上下文，避免把整包参数塞进去。 */
  function stableExtra(args) {
    if (!args) return null
    const e = {}
    for (const k of ['winTitle', 'winHandle', 'snapshotId', 'fromX', 'fromY', 'toX', 'toY', 'x', 'y', 'count', 'state']) {
      if (args[k] !== undefined && args[k] !== null) e[k] = args[k]
    }
    return Object.keys(e).length ? e : null
  }

  async function driveOnce(args) {
    const { action: rawAction, name = '', aid = '', value = '', ascii = false, match = '', waitMs = c.defaultWaitMs, procId = 0, allowSideEffects = false, workspace = '', label = '', shotsDir = '', index, inAid = '', inName = '', waitFor = null, state = '', keys = '', fromX, fromY, toX, toY, steps = 12, holdMs = 120, max, winTitle = '', winHandle, secret = false, expectValue, titleRe = '', textRe = '', gone = false, ms, interval, conds, stableCount, observe = false, observeMatch = '', observeMax = 15, x, y, delta, count, mods = '', double = false, button = '', focus = false, snapshotId, diff = false } = args
    const action = normAction(rawAction)
    // 写侧单点：副作用动作（含坐标副作用 clickat/drag）过 allowSideEffects + 新鲜度门；只读/纯输入放行。
    // W2 的 deny/急停在 checkSideEffectGate 内挂钩（同一处），不新增第二处接线点。
    const gate = await checkSideEffectGate(action, allowSideEffects, { snapshotId, winTitle, winHandle, aid })
    if (!gate.allow) return gate.result

    // ---- 配置类错误**前置判定**（在**安全门之后**）：没配目标进程就立即回，
    // 绝不进"起脚本 → 等超时 → 再重试"那条路（实测纯配置错误要 90s+，只读动作重试后 180s 无返回）。
    // ⚠ 顺序很重要：**安全门必须排在最前面** —— allowSideEffects / 快照新鲜度 / 急停这些拒绝对
    //   必须在任何其它判断之前生效（mcp-snapshot-gate 测试就是为这条顺序立的哨兵）。
    if (!hasTarget(procId)) return unconfiguredResult(action)

    // read(diff=true) 是 Node 侧对返回 lines 的后处理（不下发 PS1）；仅对成功的 read 生效。
    const wantDiff = diff === true
    const maybeDiff = (out) => (wantDiff && out && out.ok === true && out.action === 'read') ? attachDiff(out) : out

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
        // **快照也必须带观测完整性**（Claude 第十轮真机反例，2026-09-11）：
        //   这里过去手工挑 `{window, focused, count, lines}` —— 把 truncated/scanned/skipped 全丢了，
        //   于是"动作后快照"看起来永远是一份完整清单。真机反例：`ui_state(max=15)` 给
        //   `{count:15, truncated:true, scanned:1828}`，剥掉字段后就只剩"15 个控件"。
        //   这正是我在 live.mjs 修过的同型 bug 的孪生 —— 所以这里不再手写字段，走同一个 completenessInfo。
        snapshot = st.ok
          ? { window: st.window, focused: st.focused, count: st.count, lines: st.lines, ...completenessInfo(st) }
          : { error: st.error }
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
          // 换新进程 + ready 握手 + 重新解析 PID/主窗口。**只有重试这一腿**受 20s 上限约束；
          // 整次调用最坏时长 = 首次超时（effMs，read 默认 90s）+ 握手（≤15s）+ 重试（≤20s）。
          // （复核 Claude 2026-09-11 的 N2：旧注释把「重试腿上限」写成了「总时长上限」，名不副实。）
          // 只读重放没有副作用，重试是安全的。
          // killOnTimeout 与首次保持一致：`capture` 这类「宁可放弃这一帧也不杀进程」的动作
          // 不能被重试偷偷变成「延迟 8s 后照杀」。
          const up = await warmStart()
          if (up) {
            const r2 = await warmSend(payload, Math.min(effMs, 20000), { killOnTimeout: action === 'capture' ? false : true })
            if (r2 && r2.ok === true) res = r2
            else if (!res.killed && r2 && r2.error) res = r2
          }
        }
        if (res) return await attachObserve(maybeDiff(shapeResult(action, res, shotPlan, workspace)))
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
        // 批量路径的错误同样要升级：`ui_windows`（以及 type/drag/waitfor 等**只有批量引擎实现**的动作）
        // 走的就是这条路，冷启动时原本只回一句"未指定目标进程"，连变量名都不给。
        return { ok: false, action, error: augmentPsError(b.error) || '批量单步执行失败' }
      }
      return await attachObserve(maybeDiff(shapeResult(action, b.steps[0], shotPlan, workspace)))
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
      // 回退脚本（ui-drive.ps1）同样逐元素容错、并回报 SKIPPED / SKIPREASON / SCANNED（B-1）。
      // 老版本脚本没有这些行 → skipped=null（未知）、scanned 缺失（不谎报 0）。
      // 复核（Claude 2026-09-11 的 N3）指出：上一版一次**没有解析 SCANNED**，于是空枚举 warn
      // 在这条回退路径上永不触发 —— 现在补上。
      const sk = text.match(/^SKIPPED\s+(\d+)\s*$/m)
      const scanned = text.match(/^SCANNED\s+(\d+)\s*$/m)
      const reason = text.match(/^SKIPREASON\s+(.+)$/m)
      const raw = { skipped: sk ? Number(sk[1]) : null }
      if (scanned) raw.scanned = Number(scanned[1])
      if (reason) raw.skippedReasons = [reason[1].trim()]
      // 一次性 read 无窗口信息 → windowHandle=''（不参与 target 校验，见 validateSnapshot）。
      return maybeDiff({ ok: true, action, count: lines.length, lines: lines.slice(0, 200), truncated: text.length > LIMIT_READ, ...skipInfo(raw), ...snapshotStamp('') })
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
   * B-1：观测完整性归一化（两半，缺一不可）。
   *  · skipped：逐元素读取**失败**被跳过的数量（异常路径）——静默 continue 会制造假空；
   *  · scanned：本次枚举**扫到多少个元素**——UIA 在界面重绘/最小化瞬间会返回**空集合而不报错**
   *    （2026-09-11 上午实测：重绘窗口连续 4 次 FindAll 返回 0 元素、无异常、无过滤），
   *    此时只报 count=0 会被读成「界面上没有控件」，这是另一种假空。
   *    scanned>0 而 count=0 且无 skipped，才是真的「有元素但都被过滤掉（offscreen/match）」。
   * res.skipped 缺失 = 该引擎没回报 → null（未知），绝不谎报 0。
   */
  const skipInfo = (res) => {
    const n = typeof res.skipped === 'number' ? res.skipped : null
    const reasons = res.skippedReasons ? normLines(res.skippedReasons) : []
    const out = { skipped: n }
    if (typeof res.scanned === 'number') out.scanned = res.scanned
    if (typeof res.offscreen === 'number') out.offscreen = res.offscreen
    if (reasons.length) out.skippedReasons = reasons
    if (n > 0) {
      out.warn = '⚠ 跳过 ' + n + ' 个读不到状态的元素，本次清单不完整（' +
        (reasons.length ? reasons.join('；') : '原因未回报') +
        '）——不要把「没读到」当成「界面上没有」'
    } else if (out.scanned === 0 && (res.count || 0) === 0) {
      // 空枚举：结构化标出来（调用方可据此决定是否重读），并用 warn 说清它不是「界面没有控件」。
      // 复核（Codex 2026-09-11）指出「真实空窗口无法与重绘空枚举区分」—— 所以这里只声明
      // 「这次没看到」，不声称界面一定有什么；重试已把最坏等待压到 150ms。
      out.observation = 'empty-enumeration'
      out.warn = '⚠ 本次枚举返回 0 个元素（UIA 给了空集合，通常是界面正在重绘或窗口刚切换）：' +
        '这不等于「界面上没有控件」，请稍后重读或用 shot 复核'
    }
    // 复核指出的第二个静默口子：skipped 缺失（老脚本/回退路径）时调用方看不到任何提示。
    // 不冒充 skipped>0，而是明确标成「未知」，由调用方决定要不要重读。
    if (n === null) out.observationWarning = '跳过计数未回报（引擎或脚本未提供），本次观测完整性未知'
    return out
  }

  /**
   * UD-04：读取范围（inAid/inName 限定）必须一路透传到 agent 能看见的地方。
   *
   * 为什么抽成一个函数：read/state 的**产出点有三个**（shapeResult 的 read、shapeResult 的
   * state、ui_flow 的 transcript），UD-04 的第一版只补了前两个 —— 单测立刻抓到
   * 「flow transcript 带 narrowed/scope」红了一条。这类"同一漏洞修一半"本轮已出现四次
   * （F-021 / AV-03 / UD-02 / UD-04），所以凡是需要在多处同时出现的字段，一律走同一个函数。
   *
   * 语义：一份被限定过范围的清单如果不标注，会被当成整个窗口的清单 —— 那不是"少印一行"，
   * 而是给了一个**范围错误**的答案。
   */
  const scopeInfo = (res) => {
    const out = {}
    if (res.narrowed === true) {
      out.narrowed = true
      out.scope = res.scope || ''
    }
    if (res.waitedMs) out.waitedMs = res.waitedMs
    return out
  }

  /**
   * 上限截断（cap）也必须说出来 —— 与 scopeInfo/skipInfo 同源的第三半。
   *
   * 真机实测（Claude 第九轮 Q1，2026-09-11）：`ui_state max=5` 报 `truncated:true, maxApplied:5`，
   * 但**同一个脚本分支**产出的 `ui_observe state-live max=5` 什么都不报，而那次 scanned=1962 ——
   * 1962 个元素只给 5 条却标记为完整清单。根因：state 分支补了字段、state-live 分支没补（白名单形状）。
   * 这已经是本轮第六次"同一漏洞只修了一半"（F-021 / AV-03 / UD-02 / UD-04 / Q1-state / 这里），
   * 所以凡是"清单可能不完整"的信号，一律由 completenessInfo 一处产出、所有读产出点共用。
   */
  const capInfo = (res) => {
    const out = {}
    if (res.truncated === true) {
      out.truncated = true
      if (typeof res.maxApplied === 'number') out.maxApplied = res.maxApplied
      if (typeof res.returned === 'number') out.returned = res.returned
    }
    return out
  }

  /**
   * 观测完整性总集（**单一产出点**）：范围限定 + 上限截断 + 跳过/扫描计数。
   *
   * live 循环也用它（`live.mjs` 经 driver.completenessInfo 取用）：live.mjs 之前是
   * `{ window, focused, count, lines }` 手工重建对象，把 skipped/truncated/narrowed **全部丢掉** ——
   * 于是 ui_live 的控件摘要永远显示为"完整清单"。重建对象就是白名单，白名单就是下一个静默口子。
   */
  const completenessInfo = (res) => {
    if (!res || typeof res !== 'object') return {}
    return { ...scopeInfo(res), ...capInfo(res), ...skipInfo(res) }
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
      // 复核（Codex 2026-09-11）指出：这里曾硬编码 `truncated:false`，而脚本明明在超过 300 行时
      // 会截断并设 `$res.truncated=$true` —— 等于把「被截断的清单」当完整清单交给调用方。
      // 现在如实透传，并在截断时补一个 returned=实际返回行数（count 是匹配总数，两者本就可以不同）。
      // UD-04：这是**白名单**，脚本新加的字段不在这里透传就等于不存在（渲染层根本看不见）。
      // narrowed/scope 必须过：一份被 inAid 限定过的清单如果没被标注，会被当成整个窗口的清单。
      const lines = normLines(res.lines)
      // 注意：这一支**也曾是白名单** —— 它自己写 `truncated`+`returned`，于是脚本新回报的
      // `maxApplied`（read 现在也支持 max，见 ui-drive-batch.ps1 的 read 分支）根本到不了调用方。
      // 统一走 capInfo：脚本回报什么就带什么，别再手工列字段。
      const cap = capInfo(res)
      const out = {
        ok: true,
        action,
        count: res.count || 0,
        lines,
        truncated: false, // 脚本没回报时保持历史形状（false 而不是缺字段）
        ...cap,
        ...scopeInfo(res),
        ...skipInfo(res),
        ...snapshotStamp(res.window ?? ''), // 权威读：抬升 seq，戳 snapshotId
      }
      if (out.truncated === true) out.returned = lines.length
      return out
    }
    if (action === 'windows') {
      const out = { ok: true, action, count: res.count || 0, lines: normLines(res.lines) }
      // 嵌套窗口（2026-09-11 真机自查）：WPF 的登录窗/许可协议/弹窗常常是**主窗口视觉树里的 Window 元素**，
      // 而 UIA 只把进程的顶层窗口报为桌面元素 —— 实测客户端停在「用户许可协议」对话框时 ui_windows 只报 1 个窗口。
      // 只给"1 个窗口"会让 agent 以为界面上没有别的窗，然后在被遮住的主界面上找控件。
      const nested = normLines(res.nestedWindows)
      if (nested.length) {
        out.nestedWindows = nested
        out.nestedWindowsTotal = typeof res.nestedWindowsTotal === 'number' ? res.nestedWindowsTotal : nested.length
        out.note = '⚠ 除顶层窗口外，主窗口内部还有 ' + out.nestedWindowsTotal + ' 个**嵌套窗口元素**（登录窗/对话框/弹窗往往是这种形态）：' +
          '它们不出现在顶层窗口清单里，但会**遮住**下面的控件。判断"现在该操作哪个界面"请看这里，或用 ui_observe(state) 看焦点。'
      }
      // 与其它读路径共用同一套完整性字段（截断/跳过）
      Object.assign(out, capInfo(res), skipInfo(res))
      return out
    }
    if (action === 'state') {
      return {
        ok: true,
        action,
        window: res.window ?? null,
        focusedWindow: res.focusedWindow ?? null,
        focused: res.focused ?? null,
        count: res.count || 0,
        lines: normLines(res.lines),
        // 观测完整性（范围/截断/跳过）统一由 completenessInfo 产出 —— 见其文档注释。
        // state 的 max 上限过去是**隐式**的（只靠 scanned>count 推），现在显式回报 truncated/maxApplied。
        ...completenessInfo(res),
        ...snapshotStamp(res.window ?? ''), // 权威读：抬升 seq，戳 snapshotId
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
        // Claude 第九轮 Q1（真机）：state 分支补了 truncated/maxApplied、这一支没补，于是
        // `ui_observe(state-live, max=5)` 依旧静默截断（同窗 scanned=1962）。
        // 现在两支共用 completenessInfo，**结构上不可能再只修一半**。
        ...completenessInfo(res),
        // state-live 不抬升权威 seq、不发权威 snapshotId：live 每 3s 采样一次，若参与就系统性作废读快照。
        snapshotAuthoritative: false,
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
    const handleM = text.match(/HANDLE (\d+)/)
    // 进程身份（W2 policy 门用）：PS1 以 IDENT <base64(JSON)> 单行输出；解析失败 → identity 为 null，
    // 由 policy 按 deny-first 处理（identity 不可解析 = 不放行），绝不"解析不到就放行"。
    let identity = null
    const identM = text.match(/IDENT ([A-Za-z0-9+/=]+)/)
    if (identM) {
      try { identity = JSON.parse(Buffer.from(identM[1], 'base64').toString('utf8')) } catch { identity = null }
    }
    const title = winM ? winM[1].trim() : null
    return {
      running: true,
      pid: Number(pidM[1]),
      title: title === 'NONE' ? null : title,
      handle: handleM ? Number(handleM[1]) : null,
      identity,
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
   *
   * ⚠️ 护栏警告——这是**不过任何门的裸引擎**：batch() 本身不做 allowSideEffects / 新鲜度
   *    (validateSnapshot) / policy-deny / 急停(estop) 任何判定，会**原样执行**传入的副作用步骤。
   *    今天唯一合法的调用点是 driveOnce() 与 flow()，二者都在调用 batch() **之前**先过了写侧门
   *    （driveOnce → checkSideEffectGate；flow → 逐步 policy.check + 本地副作用护栏）。
   *    任何**新增调用点**若可能承载副作用动作，都**必须自行先过 checkSideEffectGate**（见 W2 seam），
   *    否则就是第二处「空接线」——正是 W2 集成刚堵掉的那类绕过口。外部消费者要执行副作用一律走
   *    drive()/flow()，绝不要直接调 batch()。
   * @returns {Promise<{ok:boolean, steps:object[], elapsedMs:number, pid:number, window:string, error?:string}>}
   */
  async function batch({ steps = [], procId = 0, waitMs = c.defaultWaitMs, tmpDir = '' } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, steps: [], error: 'steps 不能为空' }
    // 同一条前置判定：批量路径单次超时上限 10 分钟，没配目标时更不该进这条路
    if (!hasTarget(procId)) return { ok: false, steps: [], error: '未配置目标进程', unconfigured: true, configHint: unconfiguredHint(['DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE']) }
    if (!existsSync(batchScript())) {
      return { ok: false, steps: [], error: '批量脚本不存在：' + batchScript() }
    }
    const dir = tmpDir || join(c.evidenceDir, tsDir())
    mkdirSync(dir, { recursive: true })
    const stepsFile = join(dir, 'batch-steps.json')
    const outFile = join(dir, 'batch-result.json')
    // **跑之前先清掉结果文件**（2026-09-11，被 ui_tree 降级路径的单测抓出来）：
    // 目录名是**秒级**时间戳（`tsDir()`）→ 同一秒内两次批量调用会落到同一个目录，
    // 而下面"文件存在就解析"的读法是**有就算**：这一轮的脚本如果失败/没输出，
    // 读到的是**上一轮的结果** —— 一次失败被伪装成成功，且内容是陈旧的。
    // （本轮被这条坑过：注入空树 + 批量脚本坏掉，本该 ok:false，结果返回了上一次的树。）
    try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
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
      // 2026-09-11 自查：这份白名单**漏了 8 个 drive() 认的参数** → flow 步里写它们等于没写，
      // 且不报错（UD-04 家族的第四个成员）。最危险的是 `snapshotId`：调用方要求"绑新鲜度门"，
      // 白名单一丢，门就**静默失效**（本该被拒的动作照做）。
      if (s.maxDepth !== undefined && s.maxDepth !== null) o.maxDepth = s.maxDepth
      if (s.snapshotId !== undefined && s.snapshotId !== '') o.snapshotId = s.snapshotId
      if (s.observe !== undefined) o.observe = s.observe
      if (s.observeMatch !== undefined && s.observeMatch !== '') o.observeMatch = s.observeMatch
      if (s.observeMax !== undefined && s.observeMax !== null) o.observeMax = s.observeMax
      if (s.label !== undefined && s.label !== '') o.label = s.label
      if (s.shotsDir !== undefined && s.shotsDir !== '') o.shotsDir = s.shotsDir
      if (s.workspace !== undefined && s.workspace !== '') o.workspace = s.workspace
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

  /** ui_tree：进程内视觉树 dump（只读深查）。注入探针不可用时**降级到 UIA 层级树**并如实标注来源。
   *  · maxDepth：最大深度
   *  · inAid/inName：**限定到某个容器**（2026-09-11 新增）——大树的正文会撞 14000 字符上限，
   *    "先缩小范围再深挖"是唯一能拿到完整子树的办法；UIA 路径天然支持（Resolve-ReadScope），
   *    注入探针不支持（它 dump 整个 Application），所以**给了范围就走 UIA 路径**并如实标注。 */
  async function tree({ maxDepth = 8, inAid = '', inName = '', max = 0 } = {}) {
    const depth = Math.min(Math.max(Math.round(maxDepth || 8), 1), 20)
    const scoped = !!(inAid || inName)
    let injectorProblem = null
    if (scoped) {
      // 显式跳过注入探针：它不理解 inAid/inName，硬走它等于**静默忽略调用方的范围参数**。
      injectorProblem = {
        ok: false,
        probeNotRun: false,
        error: '本次指定了 inAid/inName 范围，注入探针不支持范围限定（它 dump 整个 Application）',
        hint: '已改用支持范围限定的 UIA 层级树。要 DataContext/模板级信息，请不带范围参数调用。',
      }
    } else if (!existsSync(probeScript())) {
      injectorProblem = {
        ok: false,
        probeUnavailable: true,
        error: 'ui_tree 的注入探针脚本不存在（' + probeScript() + '）',
        hint: '已自动降级为 UIA 层级树（不含 DataContext）。',
      }
    } else {
      const r = await runPs1(probeScript(), ['-Action', 'dump-tree', '-MaxDepth', String(depth)], 180000)
      if (r.timedOut) return { ok: false, error: 'dump-tree 超时' }
      // 探针**没跑起来**与"跑起来了但没内容"是两件事（2026-09-11 真机自查）：
      //   本机的 ui-probe.ps1 第 28 行会因 `DSH_SNOOP_DIR` 未配置而 throw，错误只进 stderr、
      //   stdout 里连 `--- RESULT ---` 都没有 —— 而旧代码落到「探针执行成功但一个节点都没拿到」，
      //   把"探针压根没启动"说成"探针成功了但界面没内容"，把排查方向指到了客户端上。
      const hasMarker = r.stdout.includes('--- RESULT ---')
      if (!hasMarker) {
        const detail = (r.stderr || '').trim() || (r.stdout || '').trim() || '（无输出）'
        const snoop = /DSH_SNOOP_DIR|Snoop 目录|Path.*null/i.test(detail)
        injectorProblem = {
          ok: false,
          probeNotRun: true,
          error: '注入探针未运行：' + detail.slice(-400),
          hint: snoop
            ? '探针需要 Snoop 注入器目录（DSH_SNOOP_DIR，用于定位 Snoop.InjectorLauncher.x86.exe）。本机未配置/未找到。'
            : '',
        }
      } else {
        const idx = r.stdout.lastIndexOf('--- RESULT ---')
        const text = idx >= 0 ? r.stdout.slice(idx + '--- RESULT ---'.length) : r.stdout
        if (/CSC_EXIT=[^0]/.test(r.stdout) || /INJECT_EXIT=[^0]/.test(r.stdout)) {
          return { ok: false, error: (r.stdout + '\n' + r.stderr).slice(-1500) }
        }
        const shaped = shapeInjectedTree(text, depth)
        if (shaped.ok === true) return withScopeHint(shaped, scoped)
        // 注入侧"成功但没内容/失败标记"也降级（UIA 至少能给出层级与类型）
        injectorProblem = shaped
      }
    }

    // ---------------- 降级路径：UIA 层级树（不需要注入器） ----------------
    const treeStep = { action: 'tree', maxDepth: depth }
    if (inAid) treeStep.inAid = inAid
    if (inName) treeStep.inName = inName
    if (Number(max) > 0) treeStep.max = Number(max)   // 节点数上限（PS 侧 treeCap）
    const b = await batch({ steps: [treeStep] })
    const step = (Array.isArray(b.steps) ? b.steps : [])[0] || null
    if (b.ok !== true || !step || step.ok !== true) {
      const uiaErr = (step && step.error) || b.error || '未知'
      // 注入侧的分类标记**要提到顶层**（F-015 的判据）：调用方必须能区分
      //   · emptyTree（探针跑到了、但界面真是空的）—— 与"探针没跑起来/崩了"是两码事；
      //   · probeNotRun（探针压根没启动，通常是 DSH_SNOOP_DIR 未配置）。
      // 藏在 injectorUnavailable 里只能说"有这回事"，提上来才能让上层直接判。
      return {
        ok: false,
        truncated: false,
        ...(injectorProblem.emptyTree === true ? { emptyTree: true } : {}),
        ...(injectorProblem.probeNotRun === true ? { probeNotRun: true } : {}),
        error: 'ui_tree 不可用：注入探针不可行（' + (injectorProblem.error || '未知') + '），且 UIA 降级也失败（' + uiaErr + '）',
        hint: (injectorProblem.hint ? injectorProblem.hint + '\n' : '') +
          'UIA 降级失败通常是进程/窗口问题：先 ui_status 看进程、ui_windows 看窗口。' +
          '要拿到 DataContext/模板级信息，需要配置 DSH_SNOOP_DIR 指向 Snoop 安装目录。',
        injectorUnavailable: injectorProblem,
      }
    }
    const lines = Array.isArray(step.lines) ? step.lines : []
    const treeText = lines.join('\n')
    const textCapped = treeText.length > LIMIT_TREE
    const out = {
      ok: true,
      source: 'uia',
      // 来源必须显式：这份树是 UIA 层级，**没有** 注入探针才有的真实 WPF 类型与 DataContext。
      // 不标注的话，调用方会以为自己拿到的是"最全的那份树"（与 truncated 那一类是同一种病）。
      sourceNote: '这份树来自 **UIA 递归**（注入探针不可用：' + String(injectorProblem.error || '').slice(0, 160) + '）。' +
        '可用字段：控件类型/Name/AutomationId/enabled/offscreen/位置尺寸/层级；' +
        '**不可用**：WPF 真实类型全名、DataContext 类型（要这些需配置 DSH_SNOOP_DIR 让注入探针可运行）。',
      text: treeText.slice(0, LIMIT_TREE),
      nodes: step.count,
      maxDepthApplied: step.maxDepthApplied,
      nodeCap: step.nodeCap,
      truncated: textCapped || step.depthLimited === true || step.nodeCapHit === true,
      injectorUnavailable: {
        probeNotRun: injectorProblem.probeNotRun === true,
        probeUnavailable: injectorProblem.probeUnavailable === true,
        error: injectorProblem.error,
        hint: injectorProblem.hint || '',
      },
    }
    if (step.depthLimited === true) out.depthLimited = true
    if (step.nodeCapHit === true) out.nodeCapHit = true
    if (textCapped) out.textCapped = true
    if (typeof step.skipped === 'number') out.skipped = step.skipped
    if (step.narrowed === true) { out.narrowed = true; out.scope = step.scope }
    // **UIA 看不见内容的区域**（Claude 第十轮真机反例）：CEF/自绘宿主在树里是"大矩形 + 无子节点"，
    // 而截图里是满屏内容。不报出来，调用方会把"UIA 没内容"读成"这里什么都没有"。
    const opaque = normLines(step.opaqueRegions)
    if (opaque.length) {
      out.opaqueRegions = opaque
      out.opaqueRegionsTotal = typeof step.opaqueRegionsTotal === 'number' ? step.opaqueRegionsTotal : opaque.length
      out.opaqueNote = '⚠ 有 ' + out.opaqueRegionsTotal + ' 个**UIA 看不到内容的大区域**（≥300×300 且无子节点，通常是 CEF/WebView/自绘宿主）：' +
        '树里它们只是空叶子，但画面上可能有整页内容（真机实例：`Chrome Legacy Window` 下的许可协议/广告页）。' +
        '**要看内容必须用 shot/capture + 视觉描述**（describe_image），不要据此判定"这里没有控件"。'
    }
    // 被跳过的元素同样意味着"清单不完整"：整棵子树因异常被丢掉时，count/truncated 都不会变
    // （Claude 第十轮 §2.3）。这里把 skipped 也纳入 completeness 口径。
    if (typeof step.skipped === 'number' && step.skipped > 0) {
      out.skippedNote = '⚠ 本次遍历跳过了 ' + step.skipped + ' 个读不到状态的元素 —— 可能有整棵子树没进这份树，' +
        'truncated 只反映"上限截断"，不反映这种丢失。'
    }
    const why = []
    if (step.depthLimited === true) why.push('被 maxDepth=' + step.maxDepthApplied + ' 切断（调大 maxDepth 重跑）')
    if (step.nodeCapHit === true) why.push('撞到 ' + step.nodeCap + ' 节点上限（先 ui_observe(state) 缩小范围）')
    if (textCapped) why.push('正文超 ' + LIMIT_TREE + ' 字符被截断')
    if (why.length) out.note = '⚠ 这份视觉树**不是完整的**：' + why.join('；') + '。'
    return withScopeHint(out, scoped)
  }

  /**
   * 整棵树撞上 14000 字符上限时，**唯一**能拿到完整子树的办法是先缩范围再深挖 —— 把话说明白。
   * 抽成一个函数：注入路径与 UIA 路径都会碰到同一个上限，两处各写一份必然会漂移（本轮的老毛病）。
   */
  function withScopeHint(out, scoped) {
    if (!out || out.ok !== true) return out
    if (out.textCapped === true && !scoped && !out.hint) {
      out.hint = '本次树被正文上限截断。要拿到某个容器的**完整**子树：先 ui_observe(read/state) 找到容器 aid，' +
        '再用 ui_tree(maxDepth=20, inAid="<容器aid>") 重跑（范围限定后正文通常装得下）。'
    }
    return out
  }

  /** 注入探针输出的整形（含 TREE_META 解析、两个隐性上限、失败标记）。 */
  function shapeInjectedTree(rawText, depth) {
    const body = String(rawText || '').trim()
    if (/^NO_APPLICATION\b/.test(body)) {
      return {
        ok: false,
        probeNotRun: false,
        error: 'dump-tree：探针注入成功，但在目标进程里**找不到 WPF Application**（NO_APPLICATION）',
        hint: '可能是注入了错误的进程，或该进程不是 WPF 应用。下一步：ui_status 确认 pid/窗口，再用 ui_observe(state) 交叉验证。',
      }
    }
    if (/^DUMP_ERR\b/m.test(body)) {
      const line = (body.match(/^DUMP_ERR.*$/m) || [''])[0]
      return {
        ok: false,
        error: 'dump-tree：探针遍历视觉树时抛异常 —— ' + line.slice(0, 300),
        hint: '树可能只 dump 了一部分。可用较小的 maxDepth 重试，或改用 ui_observe(state)。',
      }
    }
    // F-015 / 架构级修复（2026-09-11，Claude 在第二轮指出）：
    // `mcp/server.mjs:88-89` 明写「renderDrive/renderState 只被 DSH 的 output.render 消费，
    // 它们加的'下一步'文本永远到不了 MCP 客户端」。也就是说**只在渲染层修诚实性是半效的**——
    // MCP 面的消费者拿到的是这里的**原始对象**。
    // 所以诚实信号必须落在**数据**里：探针执行成功但一个节点都没返回，那是**观测失败**，
    // 不是"界面上没有控件"。
    if (body === '') {
      return {
        ok: false,
        emptyTree: true,
        error: 'dump-tree 返回空树（探针执行到但一个节点都没拿到）',
        hint: '这不等于「界面上没有控件」。可先看 UIA 侧交叉验证（ui_observe(state)）；本工具会自动降级到 UIA 层级树。',
      }
    }
    let tree = body
    let meta = null
    const metaM = /^TREE_META (.*)$/m.exec(body.split(/\r?\n/, 1)[0] || '')
    if (metaM) {
      meta = {}
      for (const kv of metaM[1].split(/\s+/)) {
        const [k, v] = kv.split('=')
        if (k) meta[k] = v === 'true' ? true : (v === 'false' ? false : (Number.isFinite(Number(v)) ? Number(v) : v))
      }
      // META 之后紧跟 TREE_OPAQUE 明细（同样在头部，避免被正文截断丢掉）——先摘出来，再从正文里剥掉
      const rest = body.slice(body.indexOf('\n') + 1)
      const opaqueLines = []
      let cut = rest
      while (/^TREE_OPAQUE /.test(cut)) {
        const nl = cut.indexOf('\n')
        opaqueLines.push(cut.slice('TREE_OPAQUE '.length, nl < 0 ? undefined : nl))
        cut = nl < 0 ? '' : cut.slice(nl + 1)
      }
      meta._opaque = opaqueLines
      tree = cut
    }
    const textCapped = tree.length > LIMIT_TREE
    const depthLimited = meta ? meta.depthHit === true : false
    const nodeCapHit = meta ? meta.capHit === true : false
    const out = {
      ok: true,
      source: 'injection',
      text: tree.slice(0, LIMIT_TREE),
      truncated: textCapped || depthLimited || nodeCapHit,
    }
    if (meta) {
      out.nodes = meta.nodes
      out.maxDepthApplied = meta.maxDepth
      out.windows = meta.windows
      if (depthLimited) out.depthLimited = true
      if (nodeCapHit) out.nodeCapHit = true
      if (textCapped) out.textCapped = true
      // 注入路径的盲区明细（TREE_OPAQUE）：与 UIA 路径**同一套说法**（单一实现，别再分叉）
      const opaque = Array.isArray(meta._opaque) ? meta._opaque : []
      if (opaque.length) {
        out.opaqueRegions = opaque
        out.opaqueRegionsTotal = opaque.length
        out.opaqueNote = '⚠ 有 ' + opaque.length + ' 个**树里看不到内容的大元素**（≥300×300 且无可见子节点，通常是 CEF/WebView/自绘宿主）：' +
          '树里它们只是空叶子，画面上可能有整页内容。**要看内容必须用 shot/capture + 视觉描述**，不要据此判定"这里没有控件"。'
      }
      if (depthLimited || nodeCapHit || textCapped) {
        out.note = '⚠ 这份视觉树**不是完整的**：' +
          (depthLimited ? '被 maxDepth=' + meta.maxDepth + ' 切断（更深的节点没 dump，调大 maxDepth 重跑）；' : '') +
          (nodeCapHit ? '撞到 ' + meta.cap + ' 节点上限被截断（先用 ui_observe(state) 定位目标，再用 maxDepth 逐层下钻）；' : '') +
          (textCapped ? '正文超过 ' + LIMIT_TREE + ' 字符被截断。' : '')
      }
    } else {
      out.observationWarning = '探针未回报 TREE_META（深度/节点上限是否命中未知）→ 本次树的完整性未知，不等于"这是完整视觉树"'
    }
    return out
  }

  // ------------------------------------------------------------ 流程自验

  // W5b 三个新动词已放行（W1 新鲜度门 + W2 policy/急停门均已落地，冻结稿的"禁用前提"解除）。
  // 分类仍走 classifyAction 的默认分支 = 'effect'（未知动作按副作用），因此它们必须显式 allowSideEffects
  // 并过 policy/急停门；不单独加进 COORD_EFFECT（它们有具名元素或可定位祖先）。
  const FLOW_ACTIONS = new Set(['find', 'click', 'setvalue', 'key', 'type', 'drag', 'pattern', 'scroll', 'selecttext', 'read', 'state', 'shot', 'wait', 'waitfor', 'expect', 'windows', 'expectwindow', 'expecttext', 'waitany'])

  /**
   * ui_flow：步骤序列驱动 + 证据收集。
   * steps: [{action, name?, aid?, value?, ascii?, match?, waitMs?, label?,
   *          expectEnabled?, expectMatch?}]
   * expect 步 = find + 断言（expectMatch 匹配 detail 正则；expectEnabled 检查启用态）。
   * 默认只读（find/read/shot/wait/expect）；含 click/setvalue/key 必须 allowSideEffects=true。
   * 执行引擎：整个序列进一个 PowerShell 进程（batch），步间无进程启动开销。
   */
  /**
   * ui_flow：序列驱动（公开入口）。
   * W3：**含副作用步**的 flow 落一份证据包（kind=flow 或 denied）；纯只读 flow 不落（零开销）。
   */
  async function flow(args = {}) {
    const res = await flowInner(args)
    return attachFlowEvidence(res, args)
  }

  function attachFlowEvidence(res, args) {
    try {
      const steps = (args && args.steps) || []
      const sideCount = steps.filter((s) => s && isSideEffectKind(classifyAction(s.action))).length
      if (!sideCount) return res
      const g = gateVerdictOf(res)
      const ident = identCache.value || {}
      const env = createEnvelope({
        kind: (res && res.ok) ? 'flow' : 'denied',
        surface: 'ui_flow',
        action: 'flow',
        params: { extra: { tag: (args && args.tag) || 'flow', steps: steps.length, sideEffectSteps: sideCount } },
        target: { exeCanonical: ident.exeCanonical || null, windowHandle: ident.handle == null ? null : ident.handle },
        gates: { allowSideEffects: !!(args && args.allowSideEffects), snapshot: g.snapshot, policy: g.policy, estop: g.estop },
        result: {
          ok: !!(res && res.ok),
          executed: !!(res && !res.policyCode),   // 被门拦下的整段 flow = 没执行
          error: res && res.error,
          output: res ? ('passed=' + (res.passed || 0) + ' failed=' + (res.failed || 0)) : null,
        },
        observation: { before: null, after: null },
        trust: { source: 'agent', untrustedContent: false },
      })
      const id = recordEvidence(env)
      return Object.assign({}, res, { evidence: envelopeSummary(env), evidenceId: id })
    } catch (e) {
      return Object.assign({}, res, { evidenceError: String((e && e.message) || e).slice(0, 200) })
    }
  }

  async function flowInner({ steps = [], tag = 'flow', failFast = false, allowSideEffects = false, waitMs } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'steps 不能为空' }
    if (steps.length > 60) return { ok: false, error: 'steps 最多 60 步' }

    const dir = join(c.evidenceDir, tsDir() + '-' + safeLabel(tag, 'flow'))
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'flow.log')
    const transcript = []
    let passed = 0
    let failed = 0
    // UD-03（2026-09-11 审计确证）：非断言步（click/read/shot/…）的失败过去只在 `failFast` 时才计入 `failed`，
    // 而返回的 `ok` 是 `failed === 0` —— 于是一个**失败的 click** 会得到 `{ok:true, passed:0, failed:0}`，
    // 渲染成「0 通过 / 0 失败」，agent 据此认为整段流程跑通了。
    // 更糟的连带效应：失败语料库（failure corpus）也永不触发，这套错误从此不再被记录。
    // 修法：失败**一律计数**；`failFast` 只决定"要不要中断"，不决定"算不算失败"。
    let stepFailures = 0
    const stepFailureNames = []
    let finalShot = null
    const w = (line) => {
      try { writeFileSync(log, new Date().toISOString() + ' ' + line + '\n', { flag: 'a' }) } catch { /* ignore */ }
    }

    w('flow start tag=' + tag + ' steps=' + steps.length + ' allowSideEffects=' + allowSideEffects)

    // ---- W2：flow 级 policy / 急停门（与 driveOnce 共用同一个 policy 实例与同一套判定）----
    // 集成时发现的**绕过口**：原 flow 只查 allowSideEffects，完全没有 policy/急停判定 ——
    // 于是"配了 deny 规则"或"拉了急停哨兵"之后，ui_flow 仍能照常驱动副作用动作。
    // 急停是外部总闸，绝不允许任何路径绕过；这里先做 flow 级判定，命中即整段不执行。
    // （逐步的快照新鲜度门仍列 v2：flow 是预排序列、没有逐步 snapshotId。）
    const sideEffectSteps = steps.filter((s) => s && isSideEffectKind(classifyAction(s.action)))
    if (sideEffectSteps.length && policy.needsCheck && policy.needsCheck()) {
      let identity = {}
      if (policy.requiresIdentity) {
        try {
          const st = await resolveIdentity()
          identity = st ? { exe: st.exeCanonical || st.exe || '', windowHandle: st.handle } : {}
        } catch { /* 身份解析失败 → identity 留空，交给 policy 按 deny-first 处理（绝不放行） */ }
      }
      // **逐步**判定：身份（exe/窗口）对所有步相同、只有 aid 会变，而规则表支持按 aid/windowHandle 匹配。
      // 只判 sideEffectSteps[0] 会让"命中后续步的 deny 规则"整体失效，且结果依赖步序
      // （独立复核洞 #3：steps=[ok,sell] 放行、[sell,ok] 拒绝 —— 同一组规则顺序不同结论相反）。
      for (const s of sideEffectSteps) {
        const pol = policy.check({ action: s.action, identity: Object.assign({}, identity, { aid: s.aid }), allowSideEffects })
        if (!pol.ok) {
          w('flow blocked by policy: ' + pol.code + ' on step action=' + s.action + ' aid=' + (s.aid || ''))
          const blocked = finish()
          blocked.ok = false
          blocked.policyCode = pol.code
          blocked.error = (pol.error || '策略拒绝') + '（含副作用的 flow 整段未执行）'
          blocked.transcript = [{ step: 0, action: 'policy', ok: false, error: blocked.error, policyCode: pol.code }]
          return blocked
        }
      }
    }

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
      // ⚠️ 整体展开 s，而不是手写字段清单。
      // 手写清单的代价（2026-09-11 实测）：`count` 与 `expectValue` 从未被列出 ——
      // scroll 的页数永远到不了执行器（恒滚 1 页，还回一个像成功的结果），
      // selecttext 只给 suffix 时走"无前缀无后缀"分支选第一个匹配且不做校验。
      // 下面显式覆盖的字段都是**本层计算出来**的，必须先展开再覆盖。
      const batchStep = {
        ...s,
        action,
        waitMs: stepWait,
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
        // Claude 第七轮证伪（Q2，真机）：transcript 里的 read 只 `slice(0,50)`，
        // **既不透传脚本已经算好的 `truncated`，也不给 `returned`** ——
        // 真机实测：read 步 count=320、lines 只有 50 条、无 truncated、无 returned；
        // 而同一次整窗的独立 read 是 truncated:true / returned:300。
        // 于是 `count > lines.length` 成了唯一且隐式的截断信号，看 transcript 的人会把
        // "50 条"当成"这个容器的全部控件"（比独立 read 的 300 更狠）。
        entry.count = res.count || 0
        const allLines = normLines(res.lines)
        const capped = allLines.slice(0, TRANSCRIPT_READ_LINES)
        entry.lines = capped
        entry.returned = capped.length
        if (allLines.length > capped.length || res.truncated === true) {
          entry.truncated = true
          entry.linesCappedAt = TRANSCRIPT_READ_LINES
          entry.note = 'transcript 里的 read 只保留前 ' + TRANSCRIPT_READ_LINES + ' 行（脚本层另有 300 行上限，' +
            '本次匹配 ' + (res.count || 0) + ' 行）——**不要把这份清单当成容器的全部控件**；' +
            '要全量请单独 ui_observe(read, match/inAid 收窄) 或看 steps.json 之外的直接调用结果。'
        }
        Object.assign(entry, scopeInfo(res)) // UD-04：范围限定随每一步一起回报
        Object.assign(entry, skipInfo(res)) // B-1：跳过数随每一步一起回报
        Object.assign(entry, snapshotStamp(res.window ?? b.window ?? '')) // 权威读：戳 snapshotId
      } else if (action === 'windows') {
        entry.count = res.count || 0
        entry.lines = normLines(res.lines)
      } else if (action === 'state') {
        entry.window = res.window ?? null
        entry.focusedWindow = res.focusedWindow ?? null
        entry.focused = res.focused ?? null
        entry.count = res.count || 0
        entry.lines = normLines(res.lines)
        // Q2 对称性：transcript 里 read 标了截断，state 的 max 上限同样要标
        if (res.truncated === true) {
          entry.truncated = true
          if (typeof res.maxApplied === 'number') entry.maxApplied = res.maxApplied
        }
        Object.assign(entry, scopeInfo(res)) // UD-04
        Object.assign(entry, skipInfo(res))
        Object.assign(entry, snapshotStamp(res.window ?? b.window ?? '')) // 权威读：戳 snapshotId
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
      if (!ok) {
        // UD-03：非断言步的失败必须计数（旧代码 `if (!ok && failFast) { failed++; break }`
        // 让"不启用 failFast"的调用方拿到 ok:true）。failFast 只控制中断。
        stepFailures++
        stepFailureNames.push(r.step + ':' + action)
        if (failFast) break
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
        stepFailures,
        stepFailureNames,
        totalSteps: steps.length,
        engine: 'batch',
        batchElapsedMs: batchInfo ? batchInfo.elapsedMs : null,
        transcript: clean(transcript),
      }
      writeFileSync(join(dir, 'steps.json'), JSON.stringify(stepsOut, null, 2), 'utf8')
      w('flow end passed=' + passed + ' failed=' + failed + ' stepFailures=' + stepFailures + ' batchElapsedMs=' + (batchInfo ? batchInfo.elapsedMs : '-'))
      return {
        // 只有"断言失败 0 次"**且**"动作步也全都成功"才算 ok（UD-03）。
        ok: failed === 0 && stepFailures === 0,
        passed,
        failed,
        stepFailures,
        stepFailureNames,
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

  /**
   * 「没有可用目标进程」的统一返回（**单点定义**，所有动作共用），并且必须在打脚本**之前**判。
   *
   * 起因（2026-09-12 实测）：没配 DSH_UI_PROC_NAME 时，`ui_windows` 不会立刻失败 ——
   * 它会照常起脚本、等脚本抛错；而脚本里的参数检查发生在**进程启动/加锁之后**，于是：
   *   · 这条"纯配置错误"要等**步超时**才回；
   *   · 只读动作还会**重试一次**（READ_ONLY_ACTIONS），批量路径单次超时上限 10 分钟；
   *   · 实测直接调 `drive({action:'windows'})`：**180s 内没返回**（2 × 90s 重试），
   *     而它本该毫秒级告诉调用方"你没配目标进程，去设 DSH_UI_PROC_NAME"。
   * 对 agent 而言这就是"ui 驱动卡住了"，与用户报的卡死/卡顿现象混在一起，最难排查。
   * 结论：**配置类错误一律前置判定、立即返回、不重试、不等超时。**
   */
  function unconfiguredResult(action, extra = {}) {
    return {
      ok: false,
      action,
      unconfigured: true,
      error: '未配置目标进程：' + action + ' 需要 DSH_UI_PROC_NAME（或 DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE）才能工作。',
      configHint: unconfiguredHint(['DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE']),
      ...extra,
    }
  }

  /** 目标进程是否可用（显式给了 procId 视为可用）。只看**已解析过的**配置，不裸读环境变量。 */
  function hasTarget(procId = 0) {
    return Number(procId) > 0 || !!(c.procName || c.clientExe)
  }

  /**
   * 补齐子进程需要的 `DSH_CRED_*`（**只在进程环境里没有时**才从注册表补，已有值不覆盖）。
   *
   * 为什么必须做（2026-09-12 复核发现，与前面那些"裸读"同源）：
   *   `${cred:name}` 的展开发生在 **PowerShell 子进程**里（`dshtest` 脚本读 `$env:DSH_CRED_name`），
   *   而它是**带前缀的动态名** —— `envValue(name)` 只按完整名查，救不了它。
   *   于是"用户在用户级环境变量里配好凭据、长活宿主没继承"这条真实路径上，
   *   工具会报「凭据占位符未解析」，而用户明明配过；后果是**人会把明文直接贴进参数**，
   *   恰恰毁掉这个机制存在的意义（凭据不进模型上下文/证据文件）。
   */
  function missingCredEnv(baseEnv) {
    const out = {}
    let reg = {}
    try { reg = envWithPrefix('DSH_CRED_', { env: baseEnv }) } catch { reg = {} }
    for (const [k, v] of Object.entries(reg)) {
      if (!baseEnv[k] && String(v) !== '') out[k] = String(v)
    }
    return out
  }

  /** PowerShell 错误流很长，只留关键行。 */
  function cleanPsError(stderr) {
    const lines = String(stderr || '').split(/\r?\n/)
    const first = lines.find((l) => /Exception|错误|error|失败|not|无法|找不到|拒绝/i.test(l) && !/CategoryInfo|FullyQualified|^\s*\+|^\s*~/.test(l))
    return augmentPsError(first ? first.trim().slice(0, 400) : (lines[0] || '').slice(0, 400))
  }

  /**
   * 把 PowerShell 侧"缺参数"类报错**升级成可执行说明**（单点，所有动作共用）。
   *
   * 起因（2026-09-12 冷启动巡检）：同一插件的两个工具对"没配目标进程"说法完全不同 ——
   *   `ui_status` 会带上 `configHint`（说清该设哪个变量、以及"没配过"还是"配了没继承"）；
   *   而 `ui_windows`/`ui_tree`/`ui_read`/`ui_act` 等只回一句
   *   「未指定目标进程（-ProcName 或 -ProcId 至少一个）」—— agent 拿着这句只能猜：
   *   是客户端没开？是权限不够？还是少配了什么？**连变量名都不给**。
   * 所有这些报错都来自同一个 PS1 参数检查、又都汇集到 cleanPsError，
   * 所以在这里升级一次即可覆盖全部动作（同一个修法只写一处 —— 本仓反复吃过的亏）。
   */
  function augmentPsError(msg) {
    const s = String(msg || '')
    if (!/未指定目标进程|-ProcName 或 -ProcId/.test(s)) return s
    return s + '\n（原因：本机没有可用的目标进程配置。下一步：设置 DSH_UI_PROC_NAME（或 DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE）后重试——' +
      unconfiguredHint(['DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE']) + '）'
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
    /**
     * 急停状态（只读）。为什么要有它（Claude r15 复核）：
     *   急停一旦锁存，`check()` 会**持续拒绝**该 session 的所有副作用动作，而 `reset()` 全仓**无调用点**
     *   ⇒ 复位只能靠重启宿主进程；而两个面的描述里**一个字都没提**急停/策略表 ——
     *   agent 只会看到"策略拒绝"，既不知道护栏存在、也不知道怎么恢复。
     *   这里把状态暴露出来（哨兵在不在、锁没锁、策略配没配），让拒绝可解释、复位可执行。
     */
    estopStatus: () => {
      // ⚠ 路径必须取自**策略自己**（policy.estopFilePath()），不能重新读环境变量：
      //   注入的 policy（测试/多策略）与状态输出各说各话，就是又一次"两个面不一致"。
      const sentinel = policy.estopFilePath()
      const policyFile = policy.policyFilePath()
      return {
        sentinel,
        sentinelExists: !!sentinel && existsSync(sentinel),
        policyFile,
        policyConfigured: !!policy.isConfigured(),
        latched: !!policy.latchedSession(),
        latchedSession: policy.latchedSession(),
        // 安全策略文本**不参与判定**，如实标出来（否则"我配了它"会被当成"有护栏"）。
        safetyPolicyFile: policy.diagnostics.safetyPolicyFile || '',
        safetyPolicyLoaded: policy.diagnostics.safetyPolicyLoaded === true,
        safetyPolicyGatesActions: false,
        note: '急停是外部总闸：哨兵文件在盘上时任何 session 一律拒；文件删掉后**已锁存的 session 仍拒**（删文件 ≠ 复位）。复位：POST /api/dsh-ui-drive/estop/reset（仅本机回环、非 agent 工具）。',
      }
    },
    /**
     * r44：当前焦点是否落在**敏感控件**上（密码/验证码/token/口令；词表 + IsPassword 双源判定，在 PS 侧算）。
     *
     * 为什么 fail-closed：这个函数唯一的用途是决定"要不要把一张截图交给视觉模型"。
     * 查不到（客户端没跑 / state-live 失败）时**不能**当成"不敏感" —— 那恰恰是密码输入瞬间的常态。
     * 返回 { ok, secret, unknown, focused, reason }；调用方应把 unknown 与 secret 同等对待。
     */
    secretFocusNow: async ({ procId = 0, winTitle = '' } = {}) => {
      try {
        const r = await drive({ action: 'state-live', max: 1, procId, winTitle })
        if (!r || r.ok !== true) {
          return { ok: false, secret: null, unknown: true, focused: '', reason: (r && (r.error || r.reason)) || 'state-live 未成功' }
        }
        return { ok: true, secret: r.secretFocused === true, unknown: false, focused: String(r.focused || ''), reason: '' }
      } catch (e) {
        return { ok: false, secret: null, unknown: true, focused: '', reason: String((e && e.message) || e) }
      }
    },
    /** 显式复位急停锁存（**运维路径**：给面板/本机回环路由用，不作为 agent 工具，免得模型自己关掉护栏）。 */
    estopReset: (sessionId) => {
      policy.reset(sessionId)
      return { ok: true, reset: true, latched: !!policy.latchedSession(), latchedSession: policy.latchedSession() }
    },
    // 显式释放客户端互斥锁（长跑脚本轮间让锁用；进程退出时会自动释放）
    releaseLock: () => {
      if (!lockPath) return
      try { rmSync(lockPath, { force: true }) } catch { /* ignore */ }
      HELD_LOCKS.delete(lockPath)
    },
    // r44：`shot` + `describe` 之前把门（G1 黑盒指出：ui_live 有 secretFocused 防线，
    //   而**会把像素交给视觉模型**的 describe 通道没有）。**实现见上面的 secretFocusNow 成员** ——
    //   这里不要再写 `secretFocusNow,` 这种简写：那会变成"引用一个不存在的绑定"，
    //   整个 makeDriver() 直接抛 `secretFocusNow is not defined`（我第一版就这么写的，
    //   被 param-forwarding-e2e / mcp-toolface-consistency 两个测试当场抓住）。
    warmStatus,
    // W1 缝契约（冻结）：写侧单点的两个纯函数 + snapshotId 编解码 + 权威状态诊断。W2 复用这些挂 deny/急停。
    classifyAction,
    validateSnapshot,
    encodeSnapshotId,
    decodeSnapshotId,
    // 观测完整性单一产出点（Claude 第九轮 Q1）：live.mjs 等**其它模块**必须经此取用，
    // 否则它们只能手工重建对象 —— 而重建就是白名单，就是下一个"只修一半"。
    completenessInfo,
    snapshotState: () => ({ seq: snap.seq, gen: currentGen, latest: snap.latest ? { ...snap.latest } : null }),
    evidenceDir: () => c.evidenceDir,
    scriptsDir: () => c.scriptsDir,
    clientExe: () => c.clientExe,
  }
}

