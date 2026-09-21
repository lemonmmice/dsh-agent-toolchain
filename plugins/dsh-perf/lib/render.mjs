/**
 * dsh-perf 渲染层 — 工具输出的「agent 可见文本」。
 *
 * 为什么单独成模块（与 dsh-ui-drive/lib/render.mjs 同一先例）：
 * 渲染文本是**契约的一部分**——agent 只看得见这里打出来的东西，看不见生产者返回的对象。
 * 而 index.js 依赖宿主的 `@deepseek-ai/dsh-tools`，普通 node 进程里 import 不到，
 * 渲染逻辑留在 index.js 里就等于**不可测**。
 *
 * 这里承载的是一条被真机实测踩出来的教训（F-001，2026-09-11）：
 * **渲染层的判定条件必须与生产者的返回形状对齐**。
 * 旧 `renderProbe` 用 `if (!v.ok)` 判定，而 `report()` 读回来的 report.json 是
 * perf-probe.ps1 的输出形状、**根本没有 ok 字段** → 只要有历史记录就必然渲染成
 * 「监测失败：未知错误」，把一份正常报告谎报成失败。
 * 同类第二处：`renderAnalysis` 在分析失败时 `return ''` —— **静默空**，
 * 调用方看到"有 dump 路径但没有分析"，既不知道失败也不知道为什么。
 */

/** 失败时统一附上原始输出尾部，避免"未知错误"这种无从下手的结论。 */
function rawTail(v, n) {
  if (!v) return ''
  const out = []
  if (v.stdout) out.push('\n--- 脚本输出尾部 ---\n' + String(v.stdout).slice(-(n || 600)))
  if (v.stderr) out.push('\n--- 脚本错误尾部 ---\n' + String(v.stderr).slice(-400))
  if (!out.length && v.raw) out.push('\n' + String(v.raw).slice(0, 400))
  if (!out.length && v.tail) out.push('\n' + String(v.tail).slice(-400))
  return out.join('')
}

/**
 * `perf_report` 的渲染：把"没跑过"与"跑过但报告没了/坏了"分开说。
 *
 * F-030（2026-09-12，r30，**读代码发现**）：旧实现任何异常都吞成 `hasRun:false` ⇒ 渲染成"还没有监测记录"；
 * 而"指针在、报告文件被清理掉"这一种会被说成**"没跑过"** —— **"没读到" 被说成了 "没有"**，
 * 用户会以为"我从没跑过监测"，于是重跑一遍并怀疑自己的记忆。
 * （更正：我最初以为本机就是这个状态，核对后发现是本机宿主在跑旧代码 + 报告在子目录里，**那条"真机复现"已撤回**。）
 */
export function renderReport(v) {
  if (v && v.hasRun === true && v.ok === true) return renderProbe(v)
  const reason = v && v.reason
  if (reason === 'report-missing' || reason === 'report-corrupt') {
    return '⚠ ' + String(v.error || '报告读不出来')
      + (v.ranAt ? '\n（该次运行记录于 ' + v.ranAt + '）' : '')
      + (v.reportPath ? '\n（记录指向的报告路径：' + v.reportPath + '）' : '')
      + '\n下一步：重跑 perf_probe（例：perf_probe(seconds=30, capture="log")）。'
  }
  if (reason === 'pointer-unreadable') {
    return '⚠ ' + String(v.error || '监测指针文件读不出来')
      + '\n下一步：重跑 perf_probe（会重写指针文件）。'
  }
  if (reason === 'never-ran') {
    return '还没有监测记录（指针文件 ' + String(v?.pointerPath ?? '(未知)') + ' 不存在 ⇒ 确实没跑过）。'
      + '\n下一步：perf_probe(seconds=30) 跑一次。'
  }
  return '还没有监测记录'
}

/**
 * 卡顿报告渲染（perf_probe 与 perf_report 共用）。
 *
 * 三个诚实性要求：
 *  1. 失败必带**可操作**信息 —— 真正的原因、原始输出、下一步，而不是「未知错误」；
 *  2. 成功必标**新鲜度与样本量** —— perf_report 读的是「最近一次」，可能很久以前；
 *     样本不足时百分位没有统计意义，绝不能让人把 P95/P99 当结论；
 *  3. **测量口径必标**（Claude 第九轮 Q3，2026-09-11 真机标定）——
 *     本探针只测 UI 线程消息泵：非 UI 线程的卡顿（GC/IO/worker/后台线程）**结构性测不到**，
 *     而「0 次卡顿」极容易被读成「客户端流畅」。标定数据见 MEASUREMENT_SCOPE.calibration。
 */
export function renderProbe(v) {
  if (!v.ok) {
    return '监测失败：' + (v.error || '原因未回报（工具本身没有拿到 error 字段）') +
      (v.clientNotRunning ? '\n（下一步：客户端未运行，先 ui_launch 启动，再 ui_status 确认主窗口）' : '') +
      (v.timedOut ? '\n（下一步：probe 超时，缩短 seconds，或检查客户端是否已无响应）' : '') +
      rawTail(v)
  }
  const ageLine = (v.staleHours !== null && v.staleHours !== undefined)
    ? (v.staleHours >= 1
      ? '\n⚠ 这是 ' + v.staleHours + ' 小时前的报告（' + (v.ranAt || '?') + '），不是刚测的 —— 判断当前卡顿请重跑 perf_probe。'
      : '\n报告时间：' + (v.ranAt || '刚刚') + '（' + Math.round((v.ageMs || 0) / 1000) + 's 前）')
    : ''
  const sampleWarn = (!v.samples || v.samples < 5)
    ? '\n⚠ 样本仅 ' + (v.samples || 0) + ' 个，P95/P99 不具备统计意义，不要把这两个数当结论。'
    : ''
  // F-007：工具自己报告"我跑的可能是旧代码" —— 没有这句，宿主未重启时
  // 每个修复看起来都"没生效"，agent 会把旧行为当成当前事实。
  const staleLine = v.codeStaleNote ? '\n' + v.codeStaleNote : ''
  const stutters = Array.isArray(v.stutters) ? v.stutters : []
  return '监测 ' + v.durationSec + 's：' + v.samples + ' 样本，P50=' + v.p50Ms + 'ms P95=' + v.p95Ms + 'ms P99=' + v.p99Ms + 'ms max=' + v.maxMs + 'ms，卡顿事件 ' + v.stutterCount + ' 次（阈值 ' + v.thresholdMs + 'ms）' +
    (stutters.length > 0 ? '\n卡顿明细：' + stutters.slice(0, 10).map((s) => s.at + ' ' + s.ms + 'ms' + (s.shot ? ' [shot:' + s.shot + ']' : '') + (s.dump ? ' [dump:' + s.dump + ']' : '')).join('，') : '') +
    scopeBlock(v) +
    ageLine + sampleWarn + staleLine +
    '\n证据目录：' + v.evidenceDir
}

/**
 * 测量口径（**恒打印**）：探针能看见什么、看不见什么、下限在哪。
 *
 * 为什么必须恒打印而不是"只在 0 卡顿时打印"：
 *   非 UI 线程阻塞时探针会给出**和空闲一模一样**的数字（实测 max=9ms），
 *   "0 次卡顿"与"这一段没测到"在数字上不可区分 —— 唯一能区分的就是这句话。
 */
function scopeBlock(v) {
  const s = v.measurementScope || {}
  const lines = []
  lines.push('测量口径：' + (s.what || '只测 UI 线程消息泵响应（SendMessageTimeout 打到主窗口）'))
  // P50=0 是本工具的**常态**：周期性卡顿下大多数采样落在空闲期（标定里 UI 每 3s 堵 2000ms 的那组也是 p50=0）
  if (typeof v.p50Ms === 'number' && v.p50Ms === 0) {
    lines.push('  · P50=0ms 是**正常读数**（周期性卡顿下多数采样落在空闲期）：判断有没有卡顿看 max 与命中数，**别把 P50=0 读成「没卡顿」**。')
  }
  // 0 卡顿 = 最强歧义点，必须显式解释
  if (!v.stutterCount) {
    lines.push('  · 本次 **0 次卡顿**只说明「UI 线程在这段窗口里没有超过 ' + v.thresholdMs + 'ms 的阻塞」，' +
      '**不等于客户端流畅**：非 UI 线程的卡顿（GC/IO/worker/后台线程）本探针结构性测不到' +
      '（标定：后台线程阻塞 2000ms → 命中 0 次、max 仅 8~9ms）。')
  }
  // 阈值低于标定下限：这个阈值下"没测到"几乎必然，别当结论
  const floor = s.reliableFloorMs || 500
  if (typeof v.thresholdMs === 'number' && v.thresholdMs < floor) {
    lines.push('  · ⚠ 阈值 ' + v.thresholdMs + 'ms 低于本方法的**可靠下限 ~' + floor + 'ms**：' +
      '标定显示 500ms 阻塞只有部分命中、300ms 及以下基本测不到（详见 calibration）。' +
      '低于 ' + floor + 'ms 的阈值可以拿来"看分布"，但**不能用来下「没有卡顿」的结论**。')
  }
  if (s.tuning) lines.push('  · 调参建议：' + s.tuning)
  if (s.calibration) lines.push('  · 标定（' + (s.calibratedAt || '本机实测') + '）：' + s.calibration)
  const blind = Array.isArray(s.blind) ? s.blind : []
  for (const b of blind) lines.push('  · 盲区：' + b)
  return '\n' + lines.join('\n')
}

/** 字节数 → 人话。**不是有限数就说"大小未知"，绝不把 null/undefined 算成 0**（F-049 就这样编出过「0MB」）。 */
function fmtBytes(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num < 0) return '大小未知'
  return (num / 1024 / 1024).toFixed(0) + 'MB'
}

/**
 * `perf_trace(action="status")` 的渲染 —— 与"采完了"必须长得完全不一样。
 *
 * 三处诚实性由本函数负责：**只读**（没有启停任何东西）/ 不存在的文件**不给尺寸** /
 * `samplerProcessFound === null`（查不到）**不等于**没在跑。
 */
function renderTraceStatus(v) {
  const sizeKnown = v.sizeBytes !== null && v.sizeBytes !== undefined && Number.isFinite(Number(v.sizeBytes))
  const sizeTxt = !sizeKnown ? '**文件不存在**（还没有产出 etl）'
    : Number(v.sizeBytes) === 0 ? '0 字节（文件已出现；wpr filemode 是边采边写，此刻还没落数据）'
      : fmtBytes(v.sizeBytes) + '（' + Number(v.sizeBytes) + ' 字节）'
  const secs = (typeof v.elapsedMs === 'number' && Number.isFinite(v.elapsedMs))
    ? Math.round(v.elapsedMs / 1000) + ' 秒' : '—（没有会话标记，无从计时）'
  const sampler = v.samplerProcessFound === true ? '找到采样进程'
    : v.samplerProcessFound === false ? '没找到采样进程'
      : '查不到（**不等于没在跑**）'
  return '采样状态（**只读**：这次没有启动/停止任何采集）\n' +
    '  · 是否在跑：' + (v.running === true ? '**是**' : '否') + '（依据：' + (v.runningBasis || 'start 时写的会话标记文件') + '）\n' +
    '  · 已跑：' + secs + '\n' +
    '  · etl：' + (v.etlPath || '(未知路径)') + '\n      大小：' + sizeTxt + '\n' +
    '  · 旁证 samplerProcessFound：' + sampler + '\n' +
    '  · profile：' + (v.profile || '未知（profile 记在会话标记里，没有标记就没有）') + '\n' +
    '  · 下一步：' + (v.hint || '（生产者没给）')
}

/**
 * `perf_trace` 的渲染。
 *
 * F-049（2026-09-14，r54，**宿主重启复验时在现网实测抓到**）：
 *   r48 给生产者加了 `action:'status'`（`lib/trace.mjs` 第 224 行）与 `cancel`（第 250 行）两个分支，
 *   **渲染层没跟上**。这两者都是 `ok:true` 但**什么都没采**，于是双双掉进下面那句"trace 完成"：
 *     · status 把"没在采样"渲染成「**trace 完成**」；
 *     · `sizeBytes` 是 `null` ⇒ `null/1024/1024` = `0` ⇒ `toFixed(0)` 打成字面量「**0MB**」
 *       —— **给一个根本不存在的文件编了个尺寸**；`profiles` 只有 start/stop/run 才返回 ⇒ 打出「预设 」；
 *       紧接着第二行又说"也没有找到 etl" ⇒ **同一条结果自相矛盾**；
 *     · cancel 连 `etlPath` 都没有 ⇒ 「trace 完成：**undefined**（**NaNMB**，预设 ）」。
 *   真机原话（2026-09-14 10:55，宿主 47 工具，`perf_trace(action="status")`）：
 *     `trace 完成：C:\...\perf-evidence\trace-2026-09-14T02-55-09\trace.etl（0MB，预设 ）`
 *     `没有进行中的采样（按标记），也没有找到 etl。`
 *   ⇒ 教训与 F-001 同源：**渲染层的判定必须与生产者的返回形状对齐**；新增一个 action 而渲染层
 *     没有显式分支，就会**静默掉进旧分支的措辞里** —— 而"没有测试覆盖渲染层"（本函数此前**零断言**）
 *     正是它能活到现网的原因。所以这里按 `v.action` 显式分支，并由 `test/render-trace.test.mjs`
 *     拿生产者的 `enum` 驱动一条不变量：**每声明一个 action，渲染层都必须有对应说法**。
 */
/**
 * 失败路径的公共尾巴：raw + **定向诊断**。
 *
 * ⚠ 2026-09-15（R1-12）：原来这里只印 `raw`。而 `wpr -stop` 失败时生产者会额外给出
 *   `diagnosis`（说清"这不是这次没问题"）与 `nextSteps`（重启机器 / 换采集手段 / 别读成没有热点）——
 *   **不印出来就等于没写**（第 60 类：算出来了没印出来）。MCP 面是 jtext 直出，所以**只有 DSH 面中招**，
 *   与 F-049 / `state-live` 那两处一字不差。
 */
function failureTail(v) {
  const parts = []
  if (v && v.diagnosis) parts.push('诊断：' + v.diagnosis)
  if (v && Array.isArray(v.nextSteps) && v.nextSteps.length) parts.push('下一步：\n  ' + v.nextSteps.join('\n  '))
  if (v && v.cleanedUp !== undefined && v.cleanedUp !== null) parts.push('（已顺手 `wpr -cancel` 清场：' + String(v.cleanedUp).slice(0, 120) + '）')
  if (v && typeof v.needsElevation === 'boolean' && v.needsElevation) parts.push('（ETW 需要管理员权限：请以管理员身份启动 DSH）')
  return (parts.length ? '\n' + parts.join('\n') : '') + rawTail(v)
}

export function renderTrace(v) {
  if (!v || !v.ok) {
    // ⚠ 失败路径也可能**已经有 CLR etl**：CLR 是第二条独立会话，主采集（内核/WPR）挂了不代表它没数据。
    //   不点明的话，那份好数据会跟着主采集一起被读成"这次什么都没有"。
    return '采集失败：' + ((v && v.error) || '原因未回报') + failureTail(v) +
      (v && v.clrEtlPath
        ? '\n（注意：CLR 会话的 ' + v.clrEtlPath + ' 里可能已经有数据，不受这次失败影响 —— 可以直接 perf_clrevents 读它。）'
        : '') +
      (v && v.clrWarning ? '\n' + v.clrWarning : '')
  }
  const prof = (v.profiles || []).join('+')
  // ★ R1-14：**通道必须印出来**。engine 是新增的结构化字段，第一版只把它放进返回值、**没放进渲染** ——
  //   于是调用方看到 "trace 完成…" 却不知道这次走的是 WPR 还是 xperf（而两者的后果不同：xperf 要靠 `-merge` 才有模块归属）。
  //   这正是 R1-06「渲染层吞掉结构化结果」那一类，我自己又踩了一次（r61 真机冒烟时发现：输出里读不出通道）。
  //   ⚠ 老的值里没有 engine 字段 ⇒ 不臆造通道，如实写"未回报"（不许替它猜一个）。
  const eng = v.engine ? String(v.engine) : null
  const engLine = eng
    ? '，通道 ' + eng + (eng === 'xperf' ? '（收尾已做 `xperf -merge`：模块归属来自那一步）' : '')
    : '，通道未回报'
  // ★ R1-12：`start` 成功**也可能是个陷阱** —— 采集前自检发现这台机器的 WPR 收不了尾时，
  //   采样照起（决定权在调用方），但**必须当场说出来**：否则用户会照着"请复现问题"去白跑一轮。
  const warn = v.warning ? '\n' + v.warning : ''
  // CLR 会话（`clr=true`）是**第二条独立会话**：一条在跑不代表另一条也在跑，
  // 所以它的成败必须单独出现；`clrWarning` 里已经写明"没有 GC 数据 ≠ 没有 GC 停顿"。
  const clrWarn = v.clrWarning ? '\n' + v.clrWarning : ''
  const clrLine = v.clrEtlPath
    ? '\nCLR 会话：' + (v.clr && v.clr.ok === false ? '**没起来**' : '已并行启动') + ' → ' + v.clrEtlPath
    : ''
  if (v.started) {
    const pf = v.preflight
    const pfLine = pf ? '\n（采集前自检：' + (pf.ok ? '通过' : '**不通过**') + '，' + (pf.elapsedMs != null ? pf.elapsedMs + 'ms' : '耗时未回报') +
      (pf.signature ? '，签名 ' + pf.signature : '') + '）' : ''
    return '已开始采集（预设 ' + prof + engLine + '）。请复现问题，然后调用 perf_trace(action="stop", etlPath="' + v.etlPath + '")。' +
      clrLine + pfLine + warn + clrWarn
  }
  if (v.action === 'status') return renderTraceStatus(v) + warn
  if (v.cancelled) {
    return '已取消采集（wpr -cancel，**没有产出 etl**）。' + (v.raw ? '\n' + String(v.raw).slice(0, 300) : '') + clrLine + warn + clrWarn
  }
  // run / stop 的完成路径
  // ⚠ 失败路径（合并没成 / WPR 收尾坏）也可能**已经有 CLR etl** —— 那份数据是好的，别跟着主采集一起被读成失败。
  if (!v.ok && v.clrEtlPath) {
    return '采集失败：' + (v.error || '原因未回报') + failureTail(v) +
      '\n（注意：CLR 会话的 ' + v.clrEtlPath + ' 里已经有数据，不受这次失败影响 —— 可以直接 perf_clrevents 读它。）' + clrWarn
  }
  return 'trace 完成：' + (v.etlPath || '(路径未回报)') + '（' + fmtBytes(v.sizeBytes) +
    (v.seconds ? '，采集 ' + v.seconds + 's' : '') + '，预设 ' + prof + engLine + '）\n' + (v.hint || '') +
    (v.clrEtlPath ? '\nCLR 会话产出：' + v.clrEtlPath + '（' + (v.clrEtlBytes == null ? '大小未读到' : fmtBytes(v.clrEtlBytes)) + '）' : '') +
    warn + clrWarn
}

/**
 * `perf_clrevents` 渲染 —— CLR 运行期事件（GC 停顿 / 各代 / 托管堆 / 锁争用）。
 *
 * ★ 本函数存在的**首要理由不是把数字排好看，而是把三态说清楚**：
 *   「这个 etl 里根本没有 CLR provider」必须与「provider 在、窗口内 0 次 GC」在**文字上**分开。
 *   混起来的后果是具体的：agent 会拿"0"去回答"客户端有没有 GC 停顿"，而真相是"没采"。
 *   所以失败/未解码的每一句都带"**未知，不是 0**"，成功且 0 次时则明说"确实没发生"。
 */
export function renderClrEvents(v) {
  if (!v) return '（未产出 CLR 事件汇总）'
  const state = String(v.state || 'unknown')
  if (!v.ok) {
    const head = {
      'etl-missing': '读不了：',
      'tracerpt-missing': '环境缺件：',
      'tracerpt-timeout': '读摘要超时 —— **未知，不是 0**：',
      'tracerpt-failed': '读摘要失败 —— **未知，不是 0**：',
      'summary-unreadable': '摘要解析失败 —— **未知，不是 0**：',
      'no-clr-provider': '⚠ 这个 etl 里**没有 CLR provider** —— 这是「**没采**」，不是「没有 GC 停顿」：',
      'not-captured-for-target': '⚠ 未采集到目标 PID 的 CLR 事件 —— **未知，不是 0**：',
      'xml-too-large': '解码体积超限，**未解码 ⇒ 未知，不是 0**：',
      'decode-timeout': '解码超时 —— **未知，不是 0**：',
      'decode-failed': '解码失败 —— **未知，不是 0**：',
      'xml-unreadable': '解码产物读不出来 —— **未知，不是 0**：',
    }[state] || ('失败（state=' + state + '）：')
    const lines = [head + (v.error || '原因未回报')]
    if (v.etlPath) lines.push('  etl：' + v.etlPath + (v.etlBytes != null ? '（' + fmtBytes(v.etlBytes) + '）' : ''))
    if (Array.isArray(v.providers) && v.providers.length) {
      lines.push('  这个 etl 里实际有的 provider（名字用本机注册表反查；查不到的按 GUID 原样列）：')
      for (const p of v.providers.slice(0, 12)) {
        lines.push('    ' + String(p.events).padStart(9) + '  ' + (p.name || '(未收录)') + '   ' + p.guid)
      }
      if (v.providers.length > 12) lines.push('    …（共 ' + v.providers.length + ' 个 provider，此处只列前 12）')
    }
    if (v.hint) lines.push('  下一步：' + v.hint)
    if (v.raw) lines.push('  tracerpt 原话：' + String(v.raw).slice(-400))
    return lines.join('\n')
  }
  const g = v.byGen || { gen0: 0, gen1: 0, gen2: 0 }
  const p = v.pauseMs || { count: 0, totalMs: 0, maxMs: 0, p99Ms: 0 }
  const h = v.heap
  const lines = []
  lines.push('CLR 事件汇总（' + v.etlPath + '，' + fmtBytes(v.etlBytes) + ' → 解码 ' + fmtBytes(v.xmlBytes) + '）')
  if (v.scope) lines.push('  统计范围：' + (v.scope === 'process' ? '仅 PID ' + v.pid : 'machine-wide（整份 ETL 的全部进程，未归因目标客户端）') + '；事件过滤前 ' + v.originalParsedEvents + ' / 过滤后 ' + v.filteredEvents)
  lines.push('  采集证据：runtime ' + v.clrRuntimeEvents + ' 条 / rundown ' + v.clrRundownEvents + ' 条；解析出 ' + v.parsedEvents + ' 条 CLR 事件')
  lines.push('  GC：共 ' + v.gcCount + ' 次（gen0 ' + g.gen0 + ' / gen1 ' + g.gen1 + ' / gen2 ' + g.gen2 + '）' +
    '，其中**显式触发** ' + v.inducedCount + ' 次' +
    (v.inducedCount > 0 ? '（GC.Collect / Induced —— 通常是代码在手动调，值得看一眼）' : ''))
  lines.push('  停顿（同一 PID 与 CLR 实例的 GC/SuspendEEStart → GC/RestartEEStop）：' +
    p.count + ' 段，合计 ' + p.totalMs + 'ms，最长 ' + p.maxMs + 'ms，P99 ' + p.p99Ms + 'ms')
  lines.push('  托管堆（末次 GC/HeapStats 尾值' + (v.heapProcessId != null ? '，PID ' + v.heapProcessId : '') + '）：' +
    (h
      ? 'gen0 ' + fmtBytes(h.gen0) + ' / gen1 ' + fmtBytes(h.gen1) + ' / gen2 ' + fmtBytes(h.gen2) +
        ' / LOH ' + fmtBytes(h.lohGen3) + '；GC 句柄 ' + h.gcHandleCount
      : '**没有 HeapStats 事件**（这一项未知，不是 0）'))
  lines.push('  锁争用（Contention/Start）：' + v.contentionCount + ' 次')
  if (Array.isArray(v.topPauses) && v.topPauses.length) {
    lines.push('  最长的几段停顿落在（用于跟你看到的卡对上号）：')
    for (const t of v.topPauses) {
      lines.push('    ' + new Date(t.atMs).toISOString() + '   ' + round1(t.ms) + 'ms' + (t.processId != null ? '   PID ' + t.processId : ''))
    }
    // ★ 实测（2026-09-17）：本机时区 +08:00，而 tracerpt 把**全部** SystemTime 渲染成 +07:59
    //   ⇒ 绝对时刻系统性偏约 1 分钟。停顿时长是**差值**，不受影响 —— 但拿绝对时刻去跟别的日志对齐会说错。
    lines.push('    ⚠ 绝对时刻来自 tracerpt 渲染的 SystemTime，本机实测它把偏移写成 +07:59（真值 +08:00）' +
      '⇒ **绝对时刻可能有约 1 分钟误差**；上面各段**时长是差值，不受影响**。')
  }
  if (Array.isArray(v.eventsByKind) && v.eventsByKind.length) {
    lines.push('  事件构成 Top ' + v.eventsByKind.length + '：' + v.eventsByKind.map((e) => e.kind + '×' + e.n).join('，'))
  }
  if (v.note) lines.push('  ' + v.note)
  return lines.join('\n')
}

function round1(n) { return Math.round(Number(n) * 10) / 10 }

export function renderHotstacks(v) {
  if (!v.ok) {
    // ⚠️ Codex r37 第 2 条：这里原先把**超时**直接写成"xperf 卡在符号解码"。
    //    超时只能证明"到点了" —— 符号解码只是**其中一种**可能（还有 etl 太大、系统级报告太慢、
    //    公网符号服务器慢…）。生产者给的 hint 是**有条件**的（"若症状是 ~0% CPU + 报告 0 字节"），
    //    渲染层无条件地把它说成诊断，就是把可能性当成了结论。现在：原样传递生产者的 hint，自己不升级成诊断。
    return '出报告失败：' + (v.error || '原因未回报') + rawTail(v) +
      (v.timedOut && v.hint ? '\n（生产者给的提示，**是可能性不是诊断**：' + v.hint + '）' : '') +
      (v.timedOut && !v.hint
        ? '\n（下一步：**先别急着调小 timeoutMs** —— 加 process 过滤、用 focus 收窄，或先 offline:true 只拿原生帧；' +
          '若症状是"xperf 长时间 ~0% CPU 且报告一直 0 字节"才更像卡在符号解码（见 xperfRaw））'
        : '')
  }
  // F-044：符号路径"被我们接过"这件事**必须出现在 agent 看得见的文本里**。
  //   工具结果是对象，但 agent 读的是这段渲染文本 —— 只写进对象字段 = 等于没说。
  const symNote = v.symbolPathNote ? '\n\n⚠ 符号路径：' + v.symbolPathNote : ''
  // F-044 的第二半：`debugSymbols` 的说明书说"结果 xperfRaw 里回带"，而成功路径**从来不带 raw** ——
  //   于是"报告出得来、但满屏不认识的名字"这种最需要符号日志的情形恰好拿不到日志。
  //   现在成功路径也回带（截断且有上限，并把真实字节数说清楚 —— 是**字节**不是字符数）。
  const rawBlock = v.xperfRaw
    ? '\n\n--- xperf 原话' + (v.xperfRawFiltered ? '（已按符号相关行 + 其上下文行过滤）' : '') +
      (v.xperfRawTruncated ? '，仅前 4000 字符 / 原始输出共 ' + v.xperfRawBytes + ' 字节' : '，原始输出共 ' + v.xperfRawBytes + ' 字节') + ' ---\n' + v.xperfRaw
    : ''
  return v.text + (v.eventScope ? '\n\n事件范围：' + v.eventScope + '（指标：' + (v.metric || 'stack-sample-count') + '；仅代表采样命中数，不是 CPU 百分比）' : '') +
    '\n\n（报告：' + v.reportPath + '，' + (v.reportBytes / 1024).toFixed(0) + 'KB，耗时 ' +
    (v.elapsedMs / 1000).toFixed(0) + 's' + (v.symbols ? '，已启用符号解析' : '，未启用符号解析') +
    (v.symbolPath ? '\n 生效符号路径：' + v.symbolPath : '') +
    (v.modulesTruncated ? '\n 模块表共 ' + v.modulesTotal + ' 个（此处只列前 30；"没列出"≠"不在报告里"）' : '') + '）' +
    symNote + rawBlock
}

/**
 * `perf_flame` 渲染 —— CPU 火焰图（folded stacks + 自包含可交互 HTML）。
 *
 * 诚实性要求（与本文件其它渲染同源）：
 *  1. **失败要出声**：0 采样、超时、没产出 CSV 各有各的说法，且都不能被读成"它不占 CPU"；
 *  2. **`[unknown]` 必须解释**：模块模式下客户端自己的方法（JIT 代码，见 docs/perfview-parity.md §3）
 *     会聚成一条 `[unknown]` 带 —— 不点破的话，用户会以为"有一大坨不知道是什么的开销"，
 *     其实那多半就是**客户端自己的代码**，只是符号还没接线（§4 的 JIT 地址→方法映射）。
 *  3. 口径要标：模块模式（快、只到模块）vs 符号模式（慢、原生/框架帧有函数名）；成本（CSV 体积/耗时）。
 */
export function renderFlame(v) {
  if (!v) return '（未产出火焰图）'
  if (!v.ok) {
    return '火焰图失败：' + (v.error || '原因未回报') +
      (v.timedOut ? '' : '') + rawTail(v)
  }
  const N = v.samplesTarget || 0
  const pct = (h) => N ? (100 * h / N).toFixed(1) + '%' : '?'
  const mods = Array.isArray(v.topModules) ? v.topModules : []
  const leaves = Array.isArray(v.topLeaves) ? v.topLeaves : []
  const lines = []
  lines.push('CPU 火焰图已生成 → **' + v.htmlPath + '**（浏览器打开：可点击缩放 / 悬停看详情 / 搜索高亮，颜色=模块）')
  lines.push('  进程「' + v.process + '」：' + N + ' 个 CPU 采样（全机 ' + v.samplesAll + '），折叠成 ' + v.uniqueStacks + ' 条唯一栈' +
    '（' + (v.symbols ? '符号模式' : '模块模式') + '）')
  if (mods.length) {
    lines.push('  最热模块（**包含命中**：采样的栈里出现过该模块的比例）：')
    for (const m of mods.slice(0, 10)) lines.push('    ' + pct(m.hits).padStart(6) + '  ' + m.name)
  }
  if (leaves.length) {
    lines.push('  最热叶子（采样**落点**所在帧）：')
    for (const l of leaves.slice(0, 8)) lines.push('    ' + pct(l.hits).padStart(6) + '  ' + l.name)
  }
  // JIT 映射（§4）：接上了就报解析率；没接上就告诉怎么接。
  const jit = v.jit
  if (jit && jit.attempted) {
    lines.push('  JIT 符号（§4）：客户端 `"Unknown"` 帧解出 ' + jit.resolved + '/' + jit.attempted +
      '（= ' + (100 * jit.resolved / jit.attempted).toFixed(0) + '%）真实托管方法名。' +
      (jit.resolved < jit.attempted ? '未解出的多为分层重编译搬了地址 / 调用桩 —— 属机制损耗，不是漏采。' : ''))
  } else if (v.jitEtl && v.jitInfo && v.jitInfo.state !== 'ok') {
    lines.push('  ⚠ JIT 映射没建起来（' + v.jitInfo.state + '）：客户端 JIT 帧仍是 [unknown]。')
  } else if (!v.jitEtl) {
    lines.push('  · 未接 JIT 映射：客户端自己的方法名会聚成 [unknown]。要真实方法名，采集时带 `perf_trace(jit=true)`（stop 时低污染出方法表，perf_flame 自动接上）。')
  }
  // `[unknown]` 说明 —— 只在它确实占了份量、且没被 JIT 映射解掉时出声，避免噪音。
  const unk = mods.find((m) => m.name === '[unknown]')
  if (unk && N && unk.hits / N > 0.03) {
    lines.push('  ⚠ `[unknown]` 占 ' + pct(unk.hits) + '：**没有镜像的 JIT 代码** —— ' +
      '大概率就是**客户端自己的方法**（客户端程序集是 JIT 的，dbghelp 认地址认不出方法，见 §3）。' +
      (jit && jit.attempted ? '本次已接 JIT 映射、尽力解了；剩下这些是没进 rundown 的（分层重编译/桩）。' : '带 `perf_trace(jit=true)` 采一份，这条带就会显出真实方法名。') +
      '它诚实地聚成一格，**不是「未知开销」**。')
  }
  if (!v.symbols) {
    lines.push('  · 本次**模块模式**（快）：只到模块级。原生/框架帧想要函数名，加 symbols=true 重跑（会连符号服务器，慢）。')
  } else if (typeof v.resolvedLeafRatio === 'number') {
    lines.push('  · 符号模式：叶子帧解析率 ' + (100 * v.resolvedLeafRatio).toFixed(0) + '%（客户端 JIT 帧仍解不出，见 §3/§4）。')
  }
  lines.push('  · 另有 flame.folded（' + v.foldedPath + '）：可直接拖进 https://speedscope.app，或喂 flamegraph.pl。')
  if (v.csvBytes) {
    lines.push('  · 成本：dumper CSV ' + fmtBytes(v.csvBytes) + '（' + (v.csvKept ? '已保留：' + v.csvPath : '已删') + '），' +
      'dumper ' + (v.dumperMs != null ? Math.round(v.dumperMs / 1000) + 's' : '?') + ' / 合计 ' + Math.round((v.elapsedMs || 0) / 1000) + 's。')
  }
  return lines.join('\n')
}

/**
 * `perf_uifreeze` 渲染 —— UI 冻结的等待时间分析（复刻 PerfView UI Freeze）。
 * 核心是回答"UI 线程冻了多久、其中多少时间卡在哪个调用"——所以要突出 wait 占比 + topWaits + 等待火焰图。
 */
function uiSimpleFrame(f) {
  if (!f) return '?'
  const bang = f.indexOf('!')
  let s = bang >= 0 ? f.slice(bang + 1) : f
  const paren = s.indexOf('(')
  if (paren >= 0) s = s.slice(0, paren)
  return s
}

export function renderUiFreeze(v) {
  if (!v) return '（未产出 UI 冻结分析）'
  if (v.started) {
    return '已开始 PerfView /threadTime 采集。\n' + (v.hint || '复现卡顿后调 perf_uifreeze(action="stop")。')
  }
  if (!v.ok) return 'UI 冻结分析失败：' + (v.error || '原因未回报') + (v.needsElevation ? '\n（需要管理员权限起 ETW 内核会话）' : '') + rawTail(v)
  const lines = []
  const t = v.target || {}
  const thr = Math.round(v.freezeThresholdMs || 200)
  lines.push('主 UI 线程：os tid ' + (t.tid != null ? t.tid : '?') + '（进程 ' + (t.process || v.process || '?') + '，pid ' + (t.pid != null ? t.pid : (v.pid != null ? v.pid : '?')) + '）｜ 采样窗口 ' + Math.round(v.sessionMs || 0) + 'ms ｜ 符号 ' + (v.symbols || 'cached'))
  const n = v.freezeCount || 0
  if (!n) {
    lines.push('**判据（dotTrace）：主 UI 线程消息泵间隙 > ' + thr + 'ms = UI 冻结。结果：本次无 UI 冻结。**')
    lines.push('该 UI 线程全程在正常泵消息/响应，没有 > ' + thr + 'ms 的卡顿段。')
    lines.push('（若你确定刚才卡了：可能卡在别的进程/线程；或采集窗口没覆盖到那一下；或该动作走异步、没同步卡 UI。）')
  } else {
    lines.push('**UI 冻结 ' + n + ' 次，合计 ' + Math.round(v.freezeTotalMs || 0) + 'ms（dotTrace 判据：消息泵间隙 > ' + thr + 'ms）**')
    const fs = Array.isArray(v.freezes) ? v.freezes : []
    for (const f of fs.slice(0, 12)) {
      lines.push('  • **' + Math.round(f.durMs) + 'ms** @ t=' + Math.round(f.startMs) + 'ms')
      const m = Array.isArray(f.managed) ? f.managed : []
      if (m.length) {
        lines.push('      托管调用链（越往下越接近卡住点）：')
        for (const fr of m) lines.push('        → ' + uiSimpleFrame(fr))
      } else {
        lines.push('      （无托管帧——纯 native/等待，或该段符号未解到应用层）')
      }
      lines.push('      阻塞点(leaf): ' + (f.leaf || '?'))
    }
  }
  if (v.etlZip) lines.push('\n证据：' + v.etlZip + '（symbols="full" 可补内核符号重跑；也可用 PerfView GUI 直接打开）')
  lines.push('\n口径：UI 冻结按 **dotTrace 判据**（主 UI 线程消息泵间隙 > ' + thr + 'ms）——一直泵消息的空闲**不算**卡顿。' +
    '托管调用链来自 CLR rundown（不依赖 msdl，故 symbols=off 也有名）；阻塞点(leaf) 是 native 等待（socket/锁/GC），symbols="full" 才解出内核函数名。')
  return lines.join('\n')
}

/**
 * `perf_allocflame` 渲染 —— 分配火焰图（#3，PerfView 的 GC Heap Alloc Stacks）。
 * 口径必须打印：AllocationTick 是**采样**（每~100KB 一次）、权重是字节、**分配多 ≠ 泄漏**。
 */
export function renderAllocFlame(v) {
  if (!v) return '（未产出分配火焰图）'
  if (!v.ok) return '分配火焰图失败：' + (v.error || '原因未回报') + rawTail(v)
  const mb = (n) => (Number(n) / 1048576).toFixed(1) + 'MB'
  const lines = []
  lines.push('分配火焰图已生成 → **' + v.htmlPath + '**（浏览器打开，按**分配字节**加权，可点击缩放/搜索）')
  lines.push('  进程「' + v.process + '」：' + v.ticksTarget + ' 个 AllocationTick（全机 ' + v.ticksAll + '），采样分配约 ' + mb(v.totalBytes) +
    '（' + (v.symbols ? '符号模式' : '模块模式') + '）')
  const tt = Array.isArray(v.topTypes) ? v.topTypes : []
  if (tt.length) {
    lines.push('  分配大头类型（按字节）：')
    for (const t of tt.slice(0, 12)) lines.push('    ' + mb(t.bytes).padStart(8) + '  ×' + t.ticks + '  ' + t.type)
  }
  const jit = v.jit
  if (jit && jit.attempted) lines.push('  JIT 符号：分配路径的客户端帧解出 ' + jit.resolved + '/' + jit.attempted + ' 个真实方法名。')
  else if (!v.jitEtl) lines.push('  · 未接 JIT 映射：客户端的分配调用路径会聚成 [unknown]。采集时带 `perf_trace(jit=true, alloc=true)` 可解出是**哪段代码**在分配。')
  lines.push('  · 另有 ' + v.foldedPath + '（可拖进 https://speedscope.app）。')
  lines.push('\n⚠ 口径：AllocationTick **每分配约 100KB 采一次** ⇒ 这是**采样**、权重是字节近似；' +
    '**分配多 ≠ 泄漏**（多数分配很快被 GC 回收）——它答的是"**谁在制造 GC 压力/churn**"（这类才是 WPF 卡顿常见成因）；要查泄漏用 perf_gcroot。')
  return lines.join('\n')
}

/**
 * `perf_gcroot` 渲染 —— 堆 GC root / 保留链（#2）。
 *
 * 两件事必须说清（否则又变成"看起来像结论、其实不是"）：
 *  1. 保留链是**答"谁 keep 住了对象"**的（root → … → 对象），不是泄漏判定；
 *  2. 口径：只看托管堆、单次快照 —— 大 ≠ 泄漏（渲染层再强调一次，和 perf_heap 同源）。
 */
export function renderGcRoot(v) {
  if (!v) return '（未产出 GC root 分析）'
  if (!v.ok) return 'GC root 分析失败：' + (v.error || '原因未回报') + rawTail(v)
  const lines = []
  const mb = (n) => (Number(n) / 1024 / 1024).toFixed(1) + 'MB'
  lines.push('托管堆（' + (v.bitness || '?') + '，CLR ' + (v.clr || '?') + '）：' +
    v.managedTotalObjects + ' 对象 / ' + mb(v.managedTotalBytes) +
    (v.cappedWalk ? '（⚠ 遍历到上限就停了，未走完整个堆）' : ''))
  const top = Array.isArray(v.topTypes) ? v.topTypes : []
  if (top.length) {
    lines.push('Top 类型（按占用）：')
    for (const t of top.slice(0, 15)) lines.push('  ' + mb(t.bytes) + '  ×' + t.count + '  ' + t.type)
  }
  if (v.queriedType) {
    const paths = Array.isArray(v.rootPaths) ? v.rootPaths : []
    lines.push('')
    lines.push('「' + v.queriedType + '」匹配 ' + v.typeMatchedObjects + ' 个对象；保留链（GC root → 对象，答"谁 keep 住了它"）：')
    if (!paths.length) {
      lines.push('  ⚠ 没找到到 root 的路径（可能：匹配到 0 个、或 BFS 在上限内没触达 —— 不代表它没被引用）。')
    } else {
      for (const p of paths) {
        const chain = Array.isArray(p.chain) ? p.chain.map((c) => c.type).join('  →  ') : ''
        lines.push('  [root:' + p.rootKind + '] ' + chain)
      }
      lines.push('  读法：最左是 GC root（' + rootKindHint() + '），顺箭头往右直到目标类型 —— 把这条链上的持有者断开，对象才能被回收。')
    }
  } else {
    lines.push('（要查"谁持有某类型"：perf_gcroot(dumpPath, type="你的类型名子串")）')
  }
  if (v.scopeNote) lines.push('\n⚠ ' + v.scopeNote)
  return lines.join('\n')
}

function rootKindHint() {
  return 'StrongHandle/Pinned=GC 句柄（常是 static 字段或 P/Invoke 固定）、Stack=某线程栈上的局部、Finalizer=终结队列、RefCount=COM 引用'
}

/**
 * dump 分析渲染。
 *
 * 旧实现 `if (!a || !a.ok) return ''` —— **静默空**：dump 抓到了、分析失败了，
 * 调用方只看到一行 dump 路径，既不知道分析没做，也不知道为什么。
 * 现在失败必须出声。
 */
export function renderAnalysis(a) {
  if (!a) return '（未产出分析：dump 已抓到，但分析这一步没有回报 —— 检查 dump 路径与 DumpStack 是否存在）'
  if (!a.ok) return '（dump 分析失败：' + (a.error || '原因未回报') + rawTail(a) + '）'
  const stack = Array.isArray(a.uiThread && a.uiThread.stack) ? a.uiThread.stack : []
  const lines = ['线程数 ' + a.threadCount +
    (a.uiThread
      ? '，UI 线程(mid=' + a.uiThread.managedId + ') 栈：\n' + stack.join('\n')
      : '，未识别出 UI 线程（若这是个卡死现场，UI 线程识别失败本身就是结论：不要据此说"没有卡死"）')]
  if (a.topLockThreads && a.topLockThreads.length > 0) {
    lines.push('锁热点线程 Top ' + a.topLockThreads.length + '：')
    for (const t of a.topLockThreads) {
      if (!t.lockCount) continue
      const st = Array.isArray(t.stack) ? t.stack.slice(0, 8).join('\n    ') : ''
      lines.push('  [mid=' + t.managedId + ' locks=' + t.lockCount + (t.uiLikely ? ' UI' : '') + ']\n    ' + st)
    }
  }
  // 证据链健康度：必须让调用方知道"这到底算不算代码级证据"。
  // 帧里带 `← 文件:行号 (方法声明)` 才是；一个都没映射上时，绝不能让它看起来像定位到了代码。
  if (a.srcMap) {
    const s = a.srcMap
    if (s.framesResolved > 0) {
      lines.push('源码定位：' + s.framesResolved + '/' + s.framesTotal + ' 帧已落到源码（' + (s.srcRoot || '?') + '）。' +
        '行号是**声明处**，不是崩溃瞬间执行的哪一行 —— ClrMD 给不出后者，别把它当成精确执行位置。')
    } else {
      lines.push('⚠ 源码定位：0/' + s.framesTotal + ' 帧落到源码，**以上只是类型级线索、不是代码级证据**。' + (s.note || ''))
    }
  }
  return lines.join('\n')
}
