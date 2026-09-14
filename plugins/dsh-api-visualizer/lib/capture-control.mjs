/**
 * 实时捕获引擎的**控制面**（起 / 停 / 查状态）—— 单一实现，三个消费者共用。
 *
 * 为什么单独成模块（两个 G1 黑盒 agent 独立点名同一处，2026-09-12）：
 *   面板上有一个「开始实时捕获」按钮、HTTP 上有 `POST /capture/start|stop`、`GET /capture/status`，
 *   但**没有任何工具**能做这件事。而 `api_capture_query` 的描述写着
 *   "需要当前流量请**先 POST** /api/dsh-api-visualizer/capture/start" —— 目录又没给 host/port，
 *   于是 agent 连 URL 都拼不出来：**一份报告里描述的能力，在工具面上不存在**（本仓第 29 类）。
 *
 * 为什么把逻辑放这里而不是塞进工具里：
 *   路由与工具**必须**给出同一句话（本仓第 38 类：同一逻辑两份实现必然漂移）。
 *   这里只依赖传入的 `capture` 引擎对象（依赖注入）⇒ 普通 node 进程里**import 得进来**，
 *   可以用假引擎把每条分支都测到（第 26 类：危险路径零测试的原因常常是"模块根本进不来"）。
 */

/**
 * 「一进一出」的完整性判定：引擎自己说 emit 了 N 条，库里同一时间段多了几条？
 *
 * 为什么必须有它（r39 真机查出，实测量级就是 2×）：
 *   运行中的宿主里，**引擎 counters.emitted 增量 = 12，而库的行数增量 = 24**（180 秒窗口），
 *   且两条记录同 URL、同 durationMs、ts 差 0~30ms。排除法把解析器（静态/分块/活体都 1:1）、
 *   写入路径（单条与批写都 1:1）、多引擎（停掉引擎 210 秒库零增长，且带日志增长对照）全部排掉，
 *   最后用"当前代码跑同一段日志"做对照：**日志 16 次请求 = 引擎 16 条 = 库 +16（1.000）**，
 *   而运行中的旧宿主是 2.000 ⇒ 这是**那个版本代码**的缺陷，重启宿主即消失。
 *   ⚠ 在它消失之前，面板上所有"调用次数/重复请求"都会被**放大一倍**。
 *
 * ⚠⚠ **两个量必须来自同一区间** —— 我第一版就栽在这里：
 *   `counters.emitted` 是**引擎对象创建以来的累计值**，而 `startedAt` 每次 `start()` 都会重置。
 *   于是"停一下再起"之后，我拿"累计 3417 条"去比"本次启动以来的 16 条"，算出 **ratio 0.005 并报 ok:true**
 *   —— 一个**假绿灯**（真实比值当时是 2.0）。所以这里的参数**强制调用方自己保证同区间**：
 *   `emitted` 必须是"自 `startedAt` 起"的增量，`realtimeSinceStart` 必须是"ts ≥ startedAt"的条数。
 */
export function doubleWriteVerdict({ emitted, realtimeSinceStart } = {}) {
  // 「没有值」与「值太小」是两件事：前者返回 null（没有数据），后者返回 ok:null + 一句说明（还不知道）。
  // ⚠ 注意 `Number(null) === 0`、`Number(undefined) === NaN` —— 直接 Number() 会把"缺字段"变成 0
  //   （我第一版就是这样，于是"缺字段"被说成了"样本太小"，两个不同的状态被合并了）。
  if (emitted === undefined || emitted === null || realtimeSinceStart === undefined || realtimeSinceStart === null) return null
  const e = Number(emitted)
  const n = Number(realtimeSinceStart)
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null
  if (e === 0) {
    return { ok: null, ratio: null, emitted: e, realtimeSinceStart: n, note: '这个窗口里引擎一条都没解析出来（emitted=0）—— **无法判定**，换个更长的窗口（客户端可能在这段时间没发请求）。' }
  }
  // 门槛说明（被自己的测试逼出来的）：这个客户端的请求率是 **~4 条/分钟**，
  // 所以"采 90 秒"往往只采到 ~6 条。若门槛设 20，这个检测器在真实场景里**永远不下结论**（等于没用）。
  // 但比值型判据在**单边**上是安全的：库的条目只可能来自写入者，**不可能合理地多于**引擎自己 emit 的数
  // （≥1.5 倍基本只有一个解释：同一条被写了两次）。所以：只要 emitted ≥ 10 就敢下结论，
  // 低于 10 判"还不知道"（很可能是被别的写入者/历史残留混淆）。
  const MIN_SAMPLE = 10
  if (e < MIN_SAMPLE) {
    return { ok: null, ratio: null, emitted: e, realtimeSinceStart: n, note: '样本太少（窗口内只有 ' + e + ' 条，门槛 ' + MIN_SAMPLE + '），暂不判定 —— 这是"还不知道"，不是"没问题"。下一步：把 sampleSeconds 调大（例如 180~240 秒）再采一次（本机客户端大约每分钟发 4 次请求）。' }
  }
  const ratio = n / e
  if (ratio >= 1.5) {
    return {
      ok: false,
      ratio: Number(ratio.toFixed(3)),
      emitted: e,
      realtimeSinceStart: n,
      note: '⚠ **疑似重复写入**：捕获引擎自己数到 ' + e + ' 条，而库里同一时间段有 ' + n + ' 条 realtime 记录' +
        '（比值 ' + ratio.toFixed(2) + '）。这意味着**面板/工具里的调用次数被放大了**，' +
        '"重复请求 / 定时器风暴"这类结论在修好之前**不能按现在的倍数下**。' +
        '已知成因：某些版本的插件代码在同一进程里把每条记录写了两遍（当前代码实测 1.00）——**重启 DSH 宿主**即可恢复。',
    }
  }
  return { ok: true, ratio: Number(ratio.toFixed(3)), emitted: e, realtimeSinceStart: n, note: null }
}

/**
 * 采样式判定：**同一窗口取两次**，用增量算比值。
 *
 * 为什么需要它：上面那个判定要求"两个量同区间"，而**运行中的旧宿主**并不提供"自启动起的 emitted 增量"
 *   （它只有累计值，且 startedAt 会被 start() 重置）。要在这台机器上**当场**判定，
 *   只能自己在同一个窗口里量两次。
 */
export function sampleDeltaVerdict(before, after) {
  const dEmit = Number(after?.emitted) - Number(before?.emitted)
  const dStore = Number(after?.realtimeCount) - Number(before?.realtimeCount)
  if (!Number.isFinite(dEmit) || !Number.isFinite(dStore)) return { ok: null, ratio: null, note: '采样数据不完整，无法判定。' }
  if (dEmit <= 0) {
    return {
      ok: null, ratio: null, emittedDelta: dEmit, storeDelta: dStore,
      note: '这个窗口里引擎一条都没解析出来（Δemitted=' + dEmit + '）—— **无法判定**，换个更长的窗口（客户端可能在这段时间没发请求）。',
    }
  }
  const v = doubleWriteVerdict({ emitted: dEmit, realtimeSinceStart: dStore })
  return { ...v, emittedDelta: dEmit, storeDelta: dStore, windowSampled: true }
}

/** 引擎状态的公共形状（`capture.status()` 的返回 + 我们追加的事实）。 */
function statusOf(capture) {
  try {
    return capture && typeof capture.status === 'function' ? capture.status() : null
  } catch {
    return null
  }
}

/**
 * 起捕获。**返回里必须带上"现在到底抓不抓得到东西"** —— 这正是最容易骗人的地方：
 * 实测踩过（F-022）：跟踪日志不存在时旧实现仍回 200，捕获静默变成"读空气"。
 *
 * @param capture 引擎（有 setLogPath / start / status）
 * @param body    { logPath?, replay? }
 */
export function captureStart(capture, body = {}) {
  if (!capture || typeof capture.start !== 'function') {
    return { ok: false, error: '捕获引擎不可用（宿主未加载实时捕获模块）', hint: '这是宿主侧能力；MCP 面请走回环路由 /capture/start。' }
  }
  if (typeof body.logPath === 'string' && body.logPath.trim() !== '') {
    try {
      capture.setLogPath(body.logPath.trim())
    } catch (e) {
      // 原文（setLogPath 在运行时会抛）：这句**可操作**的原因必须传出去 ——
      // 旧实现没有 try/catch，宿主 web 层把 rejection 统一变成**空 400**，agent 只能猜。
      return {
        ok: false,
        error: e && e.message ? String(e.message) : String(e),
        hint: '捕获正在运行，不能中途改跟踪日志路径。下一步：先停止捕获（api_capture_stop / POST /capture/stop），改完路径再启动。',
      }
    }
  }
  capture.start({ replay: body.replay === true })
  const st = statusOf(capture) ?? {}
  const warnings = []
  if (st.logExists !== true) {
    warnings.push('跟踪日志当前**不存在**：' + (st.logPath || '(未知)') +
      ' —— 要么路径不对，要么客户端还没写（system.diagnostics 注入需要**重启客户端**才生效）。此刻捕获读不到任何数据。')
  }
  if (st.caller && st.caller.logExists !== true) {
    warnings.push('调用方归因旁路日志不存在：' + (st.caller.logPath || '?') +
      ' —— 该能力当前不可用（不影响跟踪日志的解析）；看到 caller 为空时不要读成"没有调用方"。')
  }
  return { ok: true, ...st, ...(warnings.length ? { warnings } : {}) }
}

/** 停捕获。返回停止后的状态（调用方需要知道它真的停了）。 */
export function captureStop(capture) {
  if (!capture || typeof capture.stop !== 'function') {
    return { ok: false, error: '捕获引擎不可用（宿主未加载实时捕获模块）' }
  }
  capture.stop()
  return { ok: true, ...(statusOf(capture) ?? {}) }
}

/** 查捕获状态（只读）。`extras` 由宿主补上 store 侧的计数等。 */
export function captureStatus(capture, extras = {}) {
  const st = statusOf(capture)
  if (st === null) {
    return { ok: false, error: '捕获引擎不可用（宿主未加载实时捕获模块）', ...extras }
  }
  return { ok: true, ...st, ...extras }
}

/**
 * 一条**人话**总结：现在到底能不能拿到当前流量。
 * 存在的理由：状态字段有十几个，"能不能用"这件事不该让每个调用方自己拼。
 */
export function captureStatusSummary(st) {
  if (!st || st.ok === false) return '捕获引擎不可用：' + ((st && st.error) || '未知原因')
  const parts = []
  parts.push(st.running === true ? '**正在捕获**' : '**未在捕获**（下面 `storeTotal` 之类的计数是历史数据）')
  if (st.running === true) {
    if (st.logExists !== true) parts.push('⚠ 跟踪日志不存在 ⇒ **此刻抓不到任何流量**')
    else parts.push('跟踪日志 ' + Math.round((Number(st.logSize) || 0) / 1024) + 'KB，已读 ' + (st.offset ?? 0) + ' 字节')
    if (st.caller && st.caller.logExists !== true) parts.push('⚠ 调用方归因不可用（旁路日志不存在）')
  }
  if (st.counters && typeof st.counters === 'object') {
    parts.push('本次已解析 ' + (st.counters.emitted ?? 0) + ' 条（见到 ' + (st.counters.requestsSeen ?? 0) + ' 个请求）')
  }
  // 重复写入必须**进入这一句人话**：它是"面板上的次数能不能信"的唯一信号。
  if (st.integrity && st.integrity.ok === false) {
    parts.push('⚠ 疑似重复写入（比值 ' + st.integrity.ratio + '）—— 面板里的调用次数被放大了，重启 DSH 宿主可恢复')
  }
  return parts.join('；')
}
