/**
 * 捕获库查询的**诚实性视图**（新鲜度 + 调用方归因）—— 三个面共用一份实现。
 *
 * 为什么抽出来（2026-09-11，第十轮自查）：
 *   这段逻辑原来**只写在 DSH 插件的 `api_capture_query` 工具里**（`plugins/dsh-api-visualizer/lib/index.js`），
 *   于是另外两个面拿不到它：
 *     · **MCP 面 `capture_query`**（agent 最常用的那个）只回 `total/returned/items`；
 *     · **面板路由 `GET /records`** 只回 `total/items/nextCursor/hasMore`。
 *   两边的消费者都看不到"捕获引擎没在跑 → 你看到的是历史数据"，也看不到
 *   "调用方归因根本没有生产者（F-004）" —— 正是本仓反复出现的那类**静默**问题（同一个修复只落在一个面）。
 *
 * 单一产出点：任何面要返回查询结果，都必须经过 `buildQueryView`。
 */

/**
 * @param {object} p
 *   · records  本次查询命中的记录（用于统计 caller 覆盖）
 *   · all      库内全部记录（用于算最新时间与总体覆盖）
 *   · status   捕获引擎状态快照（可空；拿不到就如实标 null，不要编）
 * @returns {{freshness:object, callerAttribution:object}}
 */
export function buildQueryView({ records = [], all = [], status = null, now = Date.now(), callerFilter = '', retention = null } = {}) {
  const st = status && typeof status === 'object' ? status : null
  let newestTs = null
  for (const r of (Array.isArray(all) ? all : [])) {
    const t = Number(r && r.ts)
    if (Number.isFinite(t) && (newestTs === null || t > newestTs)) newestTs = t
  }
  const freshness = {
    captureRunning: st ? st.running === true : null,
    newestAt: newestTs,
    newestAgeMs: newestTs === null ? null : now - newestTs,
    storeRecords: Array.isArray(all) ? all.length : 0,
    engineNote: st && st.note ? st.note : null,
    // ⚠ **主日志的存在性不能丢**（Claude r17 的 A2）：
    //   `/capture/status` 本来给了 `logExists`，但这里只取了 `running` 一个布尔 ——
    //   于是"捕获在跑、却在读一个**不存在**的文件（读空气）"这种状态，在 agent 面上**零告警**：
    //   `running:true` ⇒ `freshnessNote` 返回 null（不刷提示）⇒ 看什么都不像有问题，而一条也进不来。
    //   讽刺的是旁路 caller 日志的存在性反倒保留了 —— 决定"有没有数据流"的那个恰恰被丢了。
    logExists: st ? (st.logExists === undefined ? null : st.logExists === true) : null,
    logPath: st && st.logPath ? String(st.logPath) : null,
    callerLog: st && st.caller ? { exists: st.caller.logExists === true, missing: st.caller.missing === true, note: st.caller.note ?? null } : null,
    asOf: now,
  }

  // 归因到底有没有数据 —— 不让"0 条"冒充"没有发生"。
  const scan = Array.isArray(all) ? all : []
  let withCaller = 0
  for (const r of scan) {
    const c = r && r.caller
    if (c && (c.viewModel || c.apiMethod || c.view || c.trigger || (Array.isArray(c.stack) && c.stack.length))) withCaller++
  }
  const callerLogMissing = freshness.callerLog ? freshness.callerLog.exists === false : null
  const baseReason = withCaller > 0
    ? null
    : (callerLogMissing === true
      ? '调用方归因的旁路日志不存在（' + (freshness.callerLog.note || '无生产者') + '）。它不是本插件产生的，需要客户端侧提供同名格式的探针。'
      : '库里没有任何记录带 caller 字段。')
  // **用 caller 过滤时**要额外说清（Codex 第十二轮审计的建议）：0 条不是"没有这种调用"，
  // 而是"归因数据不存在"。这类"过滤条件 + 空结果"最容易被读成结论。
  const usedCallerFilter = typeof callerFilter === 'string' && callerFilter !== ''
  const callerAttribution = {
    available: withCaller > 0,
    recordsWithCaller: withCaller,
    scannedRecords: scan.length,
    callerLogExists: callerLogMissing === null ? null : !callerLogMissing,
    callerFilter: usedCallerFilter ? String(callerFilter) : null,
    reason: baseReason === null
      ? null
      : (usedCallerFilter
        ? '⚠ 你用了 caller 过滤（"' + String(callerFilter) + '"），但**归因数据不可用** —— 本次 0 条**不代表没有这种调用**。' + baseReason
        : baseReason),
  }
  return { freshness, callerAttribution, retention: retention ? { ...retention } : null }
}

/**
 * 保留期提示（查询侧**必须**把它渲染出来）。
 *
 * 病（2026-09-12 r17 主题自查）：库到上限会 `rmSync` 掉旧分片，而**不留痕迹**；
 * 宿主插件里的 `lastCompactDropped` 只在内存、且不在 MCP 进程里 ⇒ `capture_query` 看不到。
 * 于是"这段时间有没有报错接口？"得到 0 条，而真相是**那段时间的记录已被裁掉** ——
 * 「没读到」被当成「没有」，正是用户排查接口异常时最怕的那种误导。
 */
export function retentionNote(retention) {
  if (!retention || typeof retention !== 'object') return null
  const dropped = Number(retention.droppedTotal)
  if (!Number.isFinite(dropped) || dropped <= 0) return null
  const when = Number.isFinite(Number(retention.lastDroppedAt)) ? new Date(Number(retention.lastDroppedAt)).toLocaleString('zh-CN') : '未知时间'
  const oldest = Number.isFinite(Number(retention.oldestKeptTs)) ? new Date(Number(retention.oldestKeptTs)).toLocaleString('zh-CN') : null
  return '⚠ 存储**已按上限裁剪过**：累计丢弃 ' + dropped + ' 条（最近一次 ' + when +
    (retention.truncatedBy ? '，触发原因 ' + retention.truncatedBy : '') + '）。' +
    '**被裁掉的记录已不在库内 —— 本次查不到不代表那段时间没有这种调用**' +
    (oldest ? '；当前库内最早一条是 ' + oldest + '。' : '。')
}

/**
 * 陈旧提示（人可读）：引擎没跑时"有数据"是历史数据。
 * 不陈旧时返回 null（不刷噪音）。
 */
export function freshnessNote(freshness) {
  if (!freshness || typeof freshness !== 'object') return null
  const parts = []
  if (freshness.captureRunning === false) {
    parts.push('⚠ 捕获引擎**未在运行**：你看到的是**历史数据**' +
      (Number.isFinite(freshness.newestAgeMs) ? '（最新一条 ' + Math.round(freshness.newestAgeMs / 1000) + ' 秒前）' : '') +
      '。要抓当前流量请先在面板点「开始实时捕获」，或用 POST /capture/start。')
  } else if (freshness.captureRunning === null) {
    parts.push('ℹ 拿不到捕获引擎状态（≠ 没在跑）：本次结果的新鲜度未知。')
  }
  // **"在跑"也可能一条都抓不到**：主跟踪日志不存在 ⇒ 引擎在"读空气"。
  // 这一条必须在 running===true 时也报，否则正好是最需要它的时候不吭声（Claude r17 A2）。
  if (freshness.captureRunning === true && freshness.logExists === false) {
    parts.push('⚠ **捕获显示在跑，但主跟踪日志不存在**（' + (freshness.logPath || '路径未回报') +
      '）—— 引擎在**读空气**，这条链路**一条记录都不会进来**。' +
      '下一步：确认客户端已按 system.diagnostics 注入写该文件，或用 POST /capture/start 带 logPath 指向真实日志。')
  }
  return parts.length ? parts.join('\n') : null
}

/** 归因不可用时的可执行提示（可用时返回 null）。 */
export function callerAttributionNote(callerAttribution) {
  if (!callerAttribution || typeof callerAttribution !== 'object') return null
  if (callerAttribution.available === true) return null
  return 'ℹ 调用方归因不可用：' + (callerAttribution.reason || '原因未回报') +
    '（因此"某接口由哪个 ViewModel 发出"这类结论**目前拿不到** —— 不要把它读成"没有调用方"。）'
}
