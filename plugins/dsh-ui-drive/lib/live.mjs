/**
 * dsh-ui-drive live — 「agent 实时看见客户端」后台循环。
 *
 * 消费方是 agent 不是人：agent 在每轮对话里随时 ui_live({action:'frame'}) 拿到
 * 最新一帧截图路径（读 latest.png）+ 帧 hash + 控件状态摘要（state 动作文本），
 * 用 wait({fromHash}) 阻塞等画面变化，从而实现「实时看见」。
 *
 * 设计约束（两轮外部评审 + 实测代码确认）：
 *  - 复用现有 warm serve 常驻进程（零新增 PowerShell 进程）；Node setInterval
 *    驱动，tick 单飞行（上一帧没完就跳过，绝不排队——排队会在 agent 长动作
 *    read/find 期间堆积 pending，超时杀常驻进程连坐副作用动作）。
 *  - 帧走 action=capture（新增）：抓窗口内容（PrintWindow），不抢前台、不强制
 *    恢复最小化；最小化/不可见/无窗口时只返回 state，不产出帧。
 *  - 超时不杀常驻进程（warmSend killOnTimeout:false）——live 与 agent 共用
 *    一条通道，live tick 超时绝不能把 agent 动作的 serve 进程清掉。
 *  - 帧变化 = PNG md5（无解码、无视觉调用）；另带 ui.hash（控件状态文本 md5，
 *    不受时钟/光标闪烁干扰，变化信号更稳）。
 *  - 敏感帧（焦点在密码/验证码/token 控件）默认标记 secretFocused=true，
 *    frame() 不返回 path（像素无法脱敏），agent 需显式 allowSensitive=true。
 *  - 视觉模型描述（describeImage）绝不进循环：秒级+费用+配额，按需由调用方做。
 *  - 目录独立：DSH_UI_LIVE_DIR（默认 ~/.dsh-agent-toolchain/ui-live），只保留
 *    latest.png / latest.json / frame-<seq>.png（最新版本帧）；
 *    与证据目录（ui-evidence）物理隔离，不进 /evidence 路由。
 *
 * latest.json 字段（冻结命名，消费方（agent/路由）只看这一份）：
 * {
 *   live:  { running, intervalMs, startedAt, frameCount, lastError, autostopReason },
 *   client:{ pid, window, running },
 *   frame: { seq, ts, hash, w, h, captureMs, changed, path, state, captureMethod, secretFocused },
 *   ui:    { hash, ts, window, focused, count, lines[] },   // state 动作结果（maxControls 截断）
 *   dir
 * }
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LIVE_DIR = () =>
  process.env.DSH_UI_LIVE_DIR || join(homedir(), '.dsh-agent-toolchain', 'ui-live')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** PNG 文件 md5（1MB 级几 ms，无解码）；不存在返回 null。 */
function fileHash(p) {
  try {
    return createHash('md5').update(readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

/** 文本摘要 md5：state 结果（window/focused/lines）的变化信号，不受像素噪声干扰。 */
function textHash(obj) {
  const s = JSON.stringify({ w: obj.window, f: obj.focused, l: obj.lines || [] })
  return createHash('md5').update(s).digest('hex')
}

/**
 * @param {object} opts
 * @param {import('./driver.mjs').Driver} opts.driver   makeDriver 实例
 * @param {string} [opts.dir]     live 目录（默认 DSH_UI_LIVE_DIR）
 * @param {number} [opts.intervalMs]  截图间隔（默认 1500）
 * @param {number} [opts.stateIntervalMs] 控件状态采集间隔（默认 3000）
 * @param {number} [opts.maxControls] state 动作最多返回控件数（默认 40）
 */
export function makeLive({ driver, dir = '', intervalMs = 1500, stateIntervalMs = 3000, maxControls = 40 } = {}) {
  const c = {
    dir: dir || LIVE_DIR(),
    intervalMs: Math.max(500, Math.min(Number(intervalMs) || 1500, 60000)),
    stateIntervalMs: Math.max(1000, Math.min(Number(stateIntervalMs) || 3000, 120000)),
    maxControls: Math.max(5, Math.min(Number(maxControls) || 40, 200)),
  }
  const st = {
    running: false,
    timer: null,
    seq: 0,          // 帧序号（递增）
    frameCount: 0,
    startedAt: null,
    lastError: null,
    autostopReason: null,
    // 单飞行：tick 正在跑就跳过本次（绝不排队）
    tickInFlight: false,
    lastFrame: null, // {seq,ts,hash,w,h,captureMs,changed,path,state,captureMethod,secretFocused}
    lastClient: null,
    lastUi: null,    // {hash,ts,window,focused,count,lines}
    // 连续失败计数：只有客户端真正消失才 autostop，单帧失败仅记 lastError
    failStreak: 0,
    lastCaptureAt: 0, // 防 state 与 capture 同 tick 并发（serve 单通道本就串行，双保险）
  }

  mkdirSync(c.dir, { recursive: true })

  // ------------------------------------------------------------ 单帧捕获
  /** 抓一帧：capture 动作 → frame-<seq>.png → md5 → 原子 rename → latest.json。 */
  async function captureFrame() {
    const seq = ++st.seq
    const out = join(c.dir, 'frame-' + seq + '.png')
    const t0 = Date.now()
    const r = await driver.drive({ action: 'capture', label: 'frame-' + seq, shotsDir: c.dir, timeoutMs: 8000 })
    const captureMs = Date.now() - t0

    // 客户端消失/最小化/无窗口：不是「坏帧」，是状态，绝不抛错
    if (!r.ok || !r.path) {
      const err = r.error || ('capture 失败 state=' + r.state)
      st.lastError = err
      // Claude 评审 1.2：minimized/hidden 是正常状态（ok:true 但无 path），
      // 绝不计入 failStreak——否则用户最小化客户端 5 次就 autostop('capture-failed')。
      const isState = (r.state === 'minimized' || r.state === 'hidden' || r.state === 'nowindow') && r.ok === true
      if (!isState) st.failStreak++
      // 更新客户端状态快照（status 路由暴露给 agent 的关键信息）
      st.lastClient = { pid: r.pid ?? null, window: r.window ?? null, running: r.ok === true && !isState, state: r.state ?? null, error: isState ? null : err.slice(0, 200) }
      // 连续 3 次失败且窗口都没了 → 客户端已消失，自动停（agent 的 wait 会拿到 autostop）
      if (st.failStreak >= 3 && (r.state === 'nowindow' || /未运行|进程未运行|NOT_RUNNING/.test(err))) {
        stop('client-gone')
      } else if (st.failStreak >= 5) {
        stop('capture-failed')
      }
      writeLatestJson()
      if (isState) { st.lastStateChanged = true }
      return null
    }

    st.failStreak = 0
    st.lastClient = { pid: r.pid ?? null, window: r.window ?? null, running: true, state: 'visible' }
    // Claude 1.7（脆弱耦合修复）：hash 用驱动回传的 r.path（真实落盘帧），
    // 不再自己重算 out——safeLabel 一改就会 hash 到不存在的文件。
    const capPath = r.path || out
    const hash = fileHash(capPath)
    if (!hash) {
      st.lastError = '帧文件 hash 失败：' + capPath
      return null
    }
    const changed = st.lastFrame ? st.lastFrame.hash !== hash : true

    // 原子写：同目录 rename（win32 MoveFileExW MOVEFILE_REPLACE_EXISTING 可覆盖）。
    // 目标被图片查看器占用（未共享删除）时重试 3 次；仍失败则保留 version 帧、
    // 用 frame.path 指针兜底（读端永远拿到完整帧）。
    let renamed = false
    for (let i = 0; i < 3 && !renamed; i++) {
      try {
        renameSync(capPath, join(c.dir, 'latest.png'))
        renamed = true
      } catch (e) {
        if (i < 2) await sleep(100 * (i + 1))
        else st.lastError = 'rename latest.png 失败：' + e.message
      }
    }

    st.frameCount++
    st.lastFrame = {
      seq,
      ts: Date.now(),
      hash,
      w: r.w,
      h: r.h,
      captureMs,
      changed,
      path: renamed ? 'latest.png' : 'frame-' + seq + '.png',
      state: r.state,
      captureMethod: r.captureMethod,
      secretFocused: false, // 由 refreshUi 标记（capture 本身不查焦点）
    }
    if (!renamed) st.lastFrame.failedRename = true
    writeLatestJson()
    return st.lastFrame
  }

  /**
   * 采集控件状态（state-live 动作：免前台——不 ShowWindow/不 SetForegroundWindow，
   * Claude 评审 1.1）；失败不致命，但返回 null 时调用方必须 fail-closed（跳过抓帧）。
   * 返回 {ui, secretFocused}。
   */
  async function refreshUi() {
    const r = await driver.drive({ action: 'state-live', max: c.maxControls, timeoutMs: 10000 })
    if (!r.ok) {
      st.lastError = 'ui state-live: ' + (r.error || 'failed')
      return null
    }
    const lines = Array.isArray(r.lines) ? r.lines : [String(r.lines || '')]
    const ui = { window: r.window ?? null, focused: r.focused ?? null, count: r.count || 0, lines: lines.slice(0, c.maxControls) }
    ui.hash = textHash(ui)
    ui.ts = Date.now()
    st.lastUi = ui
    // 敏感标记直接来自 PS 侧 state-live（词表 + IsPassword 双源判定，与资源一致）
    return { ui, secretFocused: r.secretFocused === true }
  }

  // ------------------------------------------------------------ tick
  async function tick() {
    if (st.tickInFlight) return   // 单飞行：上一帧还在跑（agent 长动作占用通道）就跳过
    st.tickInFlight = true
    try {
      // 敏感检测「每次抓帧前」：不靠 stateIntervalMs 门控（Claude 2.2——门控下
      // 用户点进密码框后最多 3s（配置可到 120s）密码画面仍被抓进 latest.png）。
      // 为了性能，state-live 只按 due 采样，但每次 tick 都先查一次缓存的上次
      // 敏感标记；若上次 state 失败（fail-closed，Claude 2.3）则跳帧保护。
      let secretFocused = false
      const due = !st.lastUi || Date.now() - st.lastUi.ts >= c.stateIntervalMs
      if (due) {
        const r = await refreshUi()
        if (r) {
          secretFocused = r.secretFocused
          st.lastSecret = { value: r.secretFocused, ts: Date.now() }
        } else {
          // fail-closed：state 读不到时绝不裸抓（密码输入瞬间抓漏是泄漏不是 bug）
          st.lastSkips = (st.lastSkips || 0) + 1
          st.lastError = (st.lastError || '') + ' | state 失败，敏感检测未知 → 跳帧（fail-closed）'
          return
        }
      } else {
        // 复用缓存判定（上次 state 的敏感标记，最多滞后一个 stateIntervalMs）
        secretFocused = st.lastSecret ? st.lastSecret.value : false
      }
      if (secretFocused) {
        // 敏感帧防线：焦点在密码/验证码控件时，最新帧保持上一帧（latest.png 不
        // 更新为敏感画面），只在 latest.json 标记 secretFocused + skipped。
        // 像素无法脱敏，磁盘上不留下「密码输入瞬间」的画面是唯一可靠的边界
        // （仅靠返回层拒出 path，磁盘 latest.png 已是敏感内容——裸读径仍在）。
        st.lastSkips = (st.lastSkips || 0) + 1
        if (st.lastFrame) {
          st.lastFrame.secretFocused = true
          st.lastFrame.skipped = st.lastSkips
          writeLatestJson()
        }
        return
      }
      await captureFrame()
    } finally {
      st.tickInFlight = false
    }
  }

  // ------------------------------------------------------------ 对外

  /** 写 latest.json（原子：tmp + rename 同目录）。给路由/外部消费者读。 */
  function writeLatestJson() {
    try {
      const tmp = join(c.dir, 'latest.json.tmp')
      writeFileSync(tmp, JSON.stringify({ ...snapshot(), dir: c.dir }, null, 2), 'utf8')
      renameSync(tmp, join(c.dir, 'latest.json'))
    } catch (e) {
      st.lastError = 'write latest.json: ' + e.message
    }
  }

  function snapshot() {
    return {
      live: {
        running: st.running,
        intervalMs: c.intervalMs,
        startedAt: st.startedAt,
        frameCount: st.frameCount,
        skips: st.lastSkips || 0,          // 敏感帧跳过次数（密码/验证码焦点）
        lastSec: st.lastFrame ? Math.round((Date.now() - st.lastFrame.ts) / 1000) : null, // 距上次成功抓帧秒
        lastError: st.lastError,
        autostopReason: st.autostopReason,
      },
      client: st.lastClient || { pid: null, window: null, running: false },
      frame: st.lastFrame,
      ui: st.lastUi,
      dir: c.dir,
    }
  }

  /** 启动循环（幂等）。返回当前快照。 */
  async function start(opts = {}) {
    if (st.running) return snapshot()
    if (opts.intervalMs) c.intervalMs = Math.max(500, Math.min(Number(opts.intervalMs) || 1500, 60000))
    if (opts.stateIntervalMs) c.stateIntervalMs = Math.max(1000, Math.min(Number(opts.stateIntervalMs) || 3000, 120000))
    if (opts.maxControls) c.maxControls = Math.max(5, Math.min(Number(opts.maxControls) || 40, 200))
    st.running = true
    st.startedAt = Date.now()
    st.autostopReason = null
    st.seq = 0
    st.frameCount = 0
    st.failStreak = 0
    // 立即抓第一帧（不等到第一个 interval）——agent 刚 start 就能看到画面
    try { await tick() } catch (e) { st.lastError = 'first tick: ' + e.message }
    st.timer = setInterval(() => { tick().catch((e) => { st.lastError = 'tick: ' + e.message }) }, c.intervalMs)
    if (st.timer.unref) st.timer.unref()
    return snapshot()
  }

  /** 停止循环（幂等）。Claude 1.6：stop/autostop 后回写 latest.json——
   *  否则只读该文件的脚本/面板永远看到 running:true（谎报）。 */
  function stop(reason = 'user') {
    if (st.timer) {
      clearInterval(st.timer)
      st.timer = null
    }
    if (st.running) {
      st.running = false
      st.autostopReason = reason !== 'user' ? (reason || null) : null
    }
    writeLatestJson()
    return snapshot()
  }

  /**
   * 取最新帧信息。未启动时退化为一次性捕获（零配置可用）。
   * @param {object} opts {fresh=false, allowSensitive=false}
   *  - fresh=true：强制新抓一帧（不等循环节奏）
   *  - allowSensitive=true：敏感帧（焦点=密码/验证码）也返回 path
   */
  async function frame(opts = {}) {
    if (!st.running) {
      // 未启动：单次捕获（不启动循环，调用方自己决定要不要 start）。
      // Claude 2.1：一次性路径必须与循环路径一样先做敏感预检——否则
      // 「零配置 frame」对着登录页 = 密码/验证码画面路径直接裸奔。
      st.seq = 0; st.frameCount = 0; st.failStreak = 0
      const r = await refreshUi()
      if (r && r.secretFocused) {
        st.lastSkips = (st.lastSkips || 0) + 1
        st.lastSecret = { value: true, ts: Date.now() }
        if (st.lastFrame) { st.lastFrame.secretFocused = true; st.lastFrame.skipped = st.lastSkips; writeLatestJson() }
        return snapshot()
      }
      if (!r) {
        // fail-closed：状态读不到就不出帧（无法确认是否敏感）
        st.lastError = (st.lastError || '') + ' | frame 一次性路径 state 失败，敏感判定未知 → 不出帧'
        return snapshot()
      }
      await captureFrame()
      return snapshot()
    }
    if (opts.fresh) await tick()
    return snapshot()
  }

  /**
   * 阻塞等到帧变化：轮询内存 hash（不读盘），≠fromHash 返回。
   * 未启动/已 autostop 返回 {ok:false, reason}。
   */
  async function wait(opts = {}) {
    const fromHash = opts.fromHash || (st.lastFrame ? st.lastFrame.hash : '')
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 100), 120000)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (!st.running) return { ok: false, reason: 'live 未运行' + (st.autostopReason ? '（autostop: ' + st.autostopReason + '）' : ''), snapshot: snapshot() }
      if (st.lastFrame && st.lastFrame.hash !== fromHash) {
        return { ok: true, changed: true, hash: st.lastFrame.hash, seq: st.lastFrame.seq, timedOut: false, waitedMs: Date.now() - t0, snapshot: snapshot() }
      }
      await sleep(200)
    }
    return { ok: false, changed: false, timedOut: true, waitedMs: Date.now() - t0, snapshot: snapshot() }
  }

  return { start, stop, frame, wait, status: snapshot, dir: () => c.dir }
}
