/**
 * dsh-hang-inspector 渲染层 — 工具输出的「agent 可见文本」。
 *
 * 为什么单独成模块（与 dsh-perf/lib/render.mjs、dsh-ui-drive/lib/render.mjs 同一先例）：
 * 渲染文本是**契约**——agent 只看得见这里打出来的东西。而 index.js 依赖宿主的
 * `@deepseek-ai/dsh-tools`，普通 node 进程里 import 不到，留在里面就等于不可测。
 *
 * 这里的每一条规则都来自实测踩坑：
 *  · 失败必须给**原因 + 下一步**，不给「未知错误」（同 dsh-perf 的 F-001）；
 *  · 证据包要**自曝年龄**：几小时前的 dump 不是"现在的卡死"（同 F-005：陈旧数据不标年龄会被当现状）；
 *  · 源码没配 / 没命中时**必须明说"这不是代码级证据"**，不许用类型名假装定位到了代码。
 */

function fmtBytes(n) {
  const b = Number(n)
  if (!Number.isFinite(b) || b <= 0) return ''
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (Math.round(b / 102.4) / 10) + 'KB'
  return (Math.round(b / 1024 / 102.4) / 10) + 'MB'
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const min = ms / 60000
  if (min < 1) return '刚刚'
  if (min < 60) return Math.round(min) + ' 分钟前'
  const h = min / 60
  if (h < 24) return (Math.round(h * 10) / 10) + ' 小时前'
  return (Math.round(h / 24 * 10) / 10) + ' 天前'
}

export function renderStatus(v) {
  const lines = []
  if (!v) return '（状态读取失败：没有拿到任何数据）'
  // ⚠ 字段名必须与 `runStatus()` 的**真实产出**对齐（Claude 第十二轮审计发现，2026-09-11）：
  //   runStatus 给的是 `status`（字符串 'running'|'exited'|'idle'）+ `pid`，**没有 `running` 布尔** ——
  //   旧渲染读 `v.running` 于是**监测明明在跑也永远显示「未运行」**。
  //   根因是渲染层的单测喂了手写的假形状，与生产层互相自洽 → 单测全绿、真机脱节（F-001/F-021 同型）。
  const isRunning = v.status === 'running' || v.running === true
  const statusText = v.status ? String(v.status) : (isRunning ? 'running' : 'unknown')
  lines.push('监测进程：' + (isRunning ? '运行中' + (v.pid ? '（pid ' + v.pid + '）' : '') : '未运行') +
    '（status=' + statusText + (isRunning ? '' : '/exited') + '）' +
    (v.exitCode !== undefined && v.exitCode !== null ? '，上次退出码 ' + v.exitCode : '') +
    (v.maxSeconds ? '，自动停止 ' + v.maxSeconds + 's' : ''))
  if (v.error) lines.push('错误：' + v.error)
  if (v.logTail) lines.push('--- 日志尾部 ---\n' + String(v.logTail).slice(-1500))
  else lines.push('（没有日志：监测可能还没开始；用 hang_run 启动，或让用户点面板「启动监测」）')
  lines.push('证据目录：' + (v.evidenceDir || v.packsDir || '?') + '（用 hang_packs 列证据包）')

  // ---- 预检块：**这些配置决定了"卡死能不能拿到代码级证据"**，必须在只读的 hang_status 里就能看见 ----
  //
  // 起因（Claude 第十二轮 + 我实测确认）：生产层早就把目标进程/取证工具/警告算出来了
  // （`monitor.procNameConfigured` / `toolWarnings` / `procdump`…），而渲染层**一个都没印** ——
  // 于是 agent 只能先启动监测、等用户复现、拿到一个没有 dump 的包，才知道本机根本抓不了 dump；
  // 源码根更是连生产层都没放进状态里（现在补上了）。
  // 预检的意义正是：**在花时间之前就把"这次能不能给你代码级证据"说清楚**。
  const m = v.monitor
  if (m) {
    const ok = (b) => (b ? '✓' : '✗')
    if (m.procName || m.procNameConfigured) {
      lines.push('目标进程：' + (m.procName || '?') + (m.procNameConfigured ? '' : '（**未配置**：设 DSH_UI_PROC_NAME，否则监测不知道看谁）'))
    } else {
      lines.push('目标进程：**未配置**（DSH_UI_PROC_NAME 为空 —— 监测脚本没有监视对象，不会产出任何证据包）')
    }
    // 三件套：缺任何一件，"卡死"就退化成模块级线索
    const tools = [['procdump', m.procdump, m.procdumpExists], ['DumpStack', m.dumpStack, m.dumpStackExists], ['dac', m.dacDir, m.dacDirExists]]
    lines.push('取证工具：' + tools.map(([n, p, e]) => n + ok(e)).join(' / ') +
      (m.toolsChecked === false ? '  ⚠ **未检查**（别把 ✗/空 当成"没有"）' : '') +
      (tools.some(([, , e]) => !e) ? '  ⚠️ 缺件 → **抓不到/分析不了 dump**，卡死只能给模块级线索（不是代码级证据）' : '') +
      (m.dumpStackOrigin ? '\n  （DumpStack 来源：' + m.dumpStackOrigin + '）' : '') +
      (m.toolsNote ? '\n  （' + m.toolsNote + '）' : ''))
    if (m.srcRootConfigured && m.srcRootExists) lines.push('源码根：' + m.srcRoot + '（存在）—— hang_analyze 可映射到 文件:行号')
    else if (m.srcRootConfigured) lines.push('源码根：' + m.srcRoot + '（**路径不存在**）—— hang_analyze 大概率映射不到源码，请核对 DSH_HANG_SRC_ROOT')
    else lines.push('源码根：**未配置**（DSH_HANG_SRC_ROOT）—— hang_analyze 只能给「模块!类型.方法」，**不是代码级证据**；要行号级定位请先配置它')
    if (Array.isArray(m.toolWarnings) && m.toolWarnings.length) {
      for (const w of m.toolWarnings) lines.push('  ⚠️ ' + w)
    }
  }
  return lines.join('\n')
}

export function renderRun(v) {
  if (!v) return '（启动监测失败：没有返回数据）'
  if (v.ok === false) {
    return '启动监测失败：' + (v.error || '原因未回报') +
      (/已在运行/.test(String(v.error || '')) ? '\n（下一步：监测已在跑，直接让用户复现卡死；用 hang_status 看进展，或先 hang_stop）' : '') +
      (/hang-loop|脚本|缺失|不存在/i.test(String(v.error || '')) ? '\n（下一步：检查 DSH_HANG_EVIDENCE_DIR / hang-loop.ps1 是否存在）' : '')
  }
  // `startRun()` 把 pid 放在**顶层**也放在 `run` 里（两个形状都认，防再漂移）
  const pid = v.pid ?? (v.run && v.run.pid)
  const max = v.maxSeconds ?? (v.run && v.run.maxSeconds)
  return '已启动卡死监测' + (pid ? '（pid ' + pid + '）' : '') + '。\n' +
    '重要：本工具**不会自动点击客户端** —— 请让用户按平常的方式操作、复现卡死；\n' +
    '监测到主窗口无响应会自动收集证据（冻结截图 / 时间线 / 进程信息 / net-trace 尾部 / 完整 dump）。\n' +
    '下一步：用 hang_status 看进展，或 hang_packs 看已收集的证据包。' +
    (max ? '\n（将在 ' + max + 's 后自动停止）' : '')
}

export function renderStop(v) {
  if (!v) return '（停止失败：没有返回数据）'
  if (v.ok === false) return '停止监测失败：' + (v.error || '原因未回报')
  // 「本来就没在跑」不许说成「已停止监测」：那就把"无事可做"说成了"我把它停了"。
  if (v.stopped === false || v.reason === 'not-running') {
    return '没有需要停止的监测：它本来就没在跑（reason=' + (v.reason || 'not-running') + '）。已收集的证据包会保留。'
  }
  const pid = v.pid ?? v.killed
  // 「下发了停止指令」≠「它真的停了」：killVerified 由生产层**核对进程是否真的没了**后给出。
  if (v.killVerified === false || v.killed === false) {
    return '⚠ 已下发停止指令，但**未能确认进程已经退出**' + (pid ? '（pid ' + pid + ' 仍存活）' : '')
      + '：' + (v.note || '原因未回报') + ' 已收集的证据包会保留。'
  }
  return '已停止监测' + (pid ? '（结束进程树 ' + pid + (v.killVerified ? '，已确认退出' : '') + '）' : '（已下发停止指令）')
    + '。已收集的证据包会保留。'
}

/**
 * 证据包列表。
 * 关键是**年龄**：一个 6 小时前的证据包不能用来解释"刚才那次卡死"。
 */
export function renderPacks(v, env = {}) {
  if (!v) return '（读取证据包失败：没有返回数据）'
  if (v.error) return '读取证据包失败：' + v.error
  const items = Array.isArray(v.items) ? v.items : []
  if (!items.length) {
    return '还没有任何卡死证据包。\n证据目录：' + (v.evidenceDir || '?') + '\n' +
      '（下一步：先 hang_run 启动监测，再让用户复现卡死；或让用户在面板点「启动监测」）'
  }
  const now = Number.isFinite(env.now) ? env.now : Date.now()
  const out = ['共 ' + items.length + ' 个证据包（新的在前），证据目录：' + (v.evidenceDir || '?')]
  for (const p of items.slice(0, 10)) {
    const ts = Number(p.ts || p.mtimeMs || 0) || null
    const age = ts ? ageText(now - ts) : '?'
    const bits = []
    if (p.hasScreenshot) bits.push('截图')
    if (p.dumpBytes) bits.push('dump ' + Math.round(p.dumpBytes / 1024 / 1024) + 'MB')
    else if (p.hasDump) bits.push('dump')
    if (p.analysisStatus && p.analysisStatus !== 'none') bits.push('分析:' + p.analysisStatus)
    // 工具描述承诺"列出**文件清单**"，而生产层的 `files: [{name,bytes}]` 旧渲染**一个都没用** ——
    // 于是只有"截图/dump/分析"三个位，没截图没 dump 的包看起来像空的。这里把文件名也带出来。
    const files = Array.isArray(p.files) ? p.files : []
    if (files.length) {
      const names = files.slice(0, 4).map((f) => (typeof f === 'string' ? f : f.name)).filter(Boolean)
      bits.push('文件 ' + files.length + ' 个' + (names.length ? '：' + names.join('、') + (files.length > names.length ? '…' : '') : ''))
    }
    out.push('  · ' + (p.id || '?') + '  ' + age + (bits.length ? '  [' + bits.join(' / ') + ']' : ''))
    // `summaryFirst` 才是 listPacks 的真实字段（旧渲染读 summaryFirstLine → 证据包列表**永不显示这个包是关于什么的**）
    const summ = p.summaryFirst ?? p.summaryFirstLine
    if (summ) out.push('      ' + String(summ).slice(0, 160))
  }
  if (items.length > 10) out.push('  …（还有 ' + (items.length - 10) + ' 个未列出）')
  out.push('下一步：hang_pack(id) 读全文证据；hang_analyze(id) 跑托管栈分析并映射源码。')
  return out.join('\n')
}

/**
 * 单个证据包的全文证据。
 * 判断"这是不是一次真的卡死"要看这里：时间线 + 主窗口响应 + 冻结截图。
 */
export function renderPack(v) {
  if (!v) return '（读取失败：没有返回数据）'
  if (v.error) return '读取证据包失败：' + v.error
  const out = ['证据包 ' + (v.id || '?') + '（目录 ' + (v.dir || '?') + '）']
  const files = Array.isArray(v.files) ? v.files : []
  if (files.length) {
    // ⚠ **同一形状必须两处都对**：`packDetail()` 给的是 `{name,bytes}` **对象**数组（不是字符串数组），
    //   直接 `files.join(', ')` 会打出一排 `[object Object]` —— 文件名与大小全丢，而"包里到底有什么"
    //   恰恰是判断"这是不是一次真卡死"的第一步。（与 renderPacks 同一族的第 10 次"形状假设"事故；
    //   Claude 第十二轮审计后的加固：render-producer-alignment 现在同时禁 `undefined` 与 `[object Object]`。）
    const names = files
      .map((f) => (typeof f === 'string' ? f : (f && f.name ? f.name + (fmtBytes(f.bytes) ? ' (' + fmtBytes(f.bytes) + ')' : '') : null)))
      .filter(Boolean)
    out.push('文件（' + names.length + '）：' + names.join(', '))
  }
  const order = ['summary', 'process-info', 'timeline', 'net-trace', 'probe', 'procdump']
  const texts = v.texts || v.text || {}
  for (const key of order) {
    const t = texts[key]
    if (typeof t === 'string' && t.trim()) out.push('\n--- ' + key + ' ---\n' + t.slice(0, 4000))
  }
  for (const [k, t] of Object.entries(texts)) {
    if (order.includes(k) || typeof t !== 'string' || !t.trim()) continue
    out.push('\n--- ' + k + ' ---\n' + t.slice(0, 2000))
  }
  if (!Object.keys(texts).length) out.push('（这个包里没有可读的文本证据）')
  if (v.hasScreenshot) out.push('\n冻结截图：' + (v.screenshotPath || (v.dir ? v.dir + '\\frozen-screen.png' : 'frozen-screen.png')) +
    '\n（像素无法用文本描述，需要时把该 PNG 路径交给视觉工具复核）')
  out.push('\n下一步：hang_analyze(id) 跑托管线程栈分析 —— 那才是"哪一行代码卡住了"的答案。')
  return out.join('\n')
}

/**
 * dump 分析结果（卡死定位的核心输出）。
 *
 * 三个诚实性要求：
 *  1. 没配源码根 → 明说"只有类型级线索、不是代码级证据"，不许拿类型名冒充定位；
 *  2. 行号是**声明处**，不是卡死瞬间执行的那一行 —— ClrMD 给不出后者；
 *  3. 识别不出 UI/嫌疑线程本身就是结论（可能根本没卡死，或卡在原生代码里），不许含糊带过。
 */
export function renderAnalyze(v) {
  if (!v) return '（分析失败：没有返回数据）'
  if (v.status === 'running') {
    return '分析仍在进行中（' + (v.startedAt ? ageText(Date.now() - v.startedAt) + ' 开始' : '已启动') + '）。\n' +
      '（下一步：稍后用 hang_packs 看 analysis 状态，或再调 hang_analyze(id, wait=true) 阻塞等待）'
  }
  if (v.ok === false || v.status === 'error') {
    return '卡死分析失败：' + (v.error || '原因未回报') +
      (/DAC|no CLR runtime/i.test(String(v.error || ''))
        ? '\n（下一步：dump 内 CLR 与本机 DAC 不匹配，从微软符号服务器取对应 mscordacwks.dll 放到 DAC 目录）' : '') +
      (/pack not found/i.test(String(v.error || '')) ? '\n（下一步：先 hang_packs 拿正确的 id）' : '')
  }
  const out = []
  // 分析器出处与置信度：**先说清"这份结论是怎么来的、有多可信"**，再给结论。
  // 之前这些字段生产层有、渲染层一个都不印 → 低置信度的分析和干净的完全同脸（真机实测缺的第 15 个字段族）。
  const meta = []
  if (v.engine) meta.push(v.engine)
  if (v.clrVersion) meta.push('CLR ' + v.clrVersion)
  if (v.arch && (v.arch.dump || v.arch.clr)) meta.push('dump=' + (v.arch.dump || '?') + '/clr=' + (v.arch.clr || '?'))
  if (Number.isFinite(v.analyzerElapsedMs)) meta.push('耗时 ' + v.analyzerElapsedMs + 'ms')
  if (meta.length) out.push('分析器：' + meta.join('，') + (v.confidence ? '，置信度 ' + v.confidence : ''))
  // **这份结论是用哪套配置算出来的、是不是复用的缓存** —— 不写清楚，读者无法解释
  // "上次明明有源码定位、这次怎么没了"（真机实测：重算会用当前 srcRoot 覆盖旧结果）。
  if (v.cached === true) {
    out.push('（本次为**复用**的已缓存分析' + (v.analyzedAt ? '，时间 ' + v.analyzedAt : '') +
      (v.srcRootConfigured ? '，当时源码根 ' + v.srcRoot : '，当时**未配源码根**') +
      ' —— 若你刚配好 DSH_HANG_SRC_ROOT，用 hang_analyze(id, refresh=true) 重算）')
    if (v.srcRootUpgradeAvailable === true) {
      out.push('  ⚠ 这份缓存是**未配源码根**时算的，而你**现在配了** —— 重算就能给出 文件:行号（hang_analyze(id, refresh=true)）。')
    }
    if (v.fingerprintUnknown === true) {
      out.push('  ℹ️ 这份老分析没有记 dump 指纹，无法判断它是不是对着当前这份 dump 做的；要确定就 refresh=true。')
    }
  } else if (v.dumpChanged === true) {
    out.push('（**检测到 frozen.dmp 已更换**，缓存作废 → 本次为**新算**' + (v.analyzedAt ? '，时间 ' + v.analyzedAt : '') + '）')
  } else if (v.srcRootRegression === true) {
    // refresh=true + 当前没配源码根，把**原先有源码定位**的结果重算成了没有的 —— 必须点出来
    out.push('  ⚠ 本次重算**丢掉了源码定位**：上一次分析是在配了源码根时做的（有 文件:行号），' +
      '而这次用的环境**没配 DSH_HANG_SRC_ROOT**。要用回那份结论，请配好源码根后 refresh=true 再算一次。')
  } else if (v.analyzedAt || v.srcRootConfigured !== undefined) {
    out.push('（本次为**新算**' + (v.analyzedAt ? '，时间 ' + v.analyzedAt : '') +
      (v.srcRootConfigured ? '，源码根 ' + v.srcRoot : '，**未配源码根**（DSH_HANG_SRC_ROOT）') + '）')
  }
  if (v.confidence && v.confidence !== 'high') {
    out.push('  ⚠ 置信度 **' + v.confidence + '**（非 high）—— 下面的结论只能当线索，不足以定位到确定的代码行。')
  }
  if (Array.isArray(v.analyzerWarnings) && v.analyzerWarnings.length) {
    out.push('  ⚠ 分析器告警（' + v.analyzerWarnings.length + ' 条，原文带出）：')
    for (const w of v.analyzerWarnings.slice(0, 6)) out.push('    · ' + String(w).slice(0, 300))
  }
  if (v.diagnosis) out.push('诊断：' + v.diagnosis)
  // 帧解析总况**始终印**（只要确实有未解析帧）：与"在哪儿未解析"无关 ——
  // 未解析帧散布在**中段**时，上面两个分支都不会提它，于是"22 帧里 19 帧没解析"这种事实会消失。
  // 事实性的数字没有取舍余地：宁可多一行，也不要让读者以为整条栈都是可信的。
  if (v.unresolved && v.unresolved.count > 0) {
    out.push('帧解析：' + (v.unresolved.total - v.unresolved.count) + '/' + v.unresolved.total +
      ' 帧解析出名字，' + v.unresolved.count + ' 帧无模块/符号信息' +
      (v.unresolved.top5 > 0 ? '（栈顶 5 帧里 ' + v.unresolved.top5 + ' 帧）' : '（**不在栈顶**，散布在更深的位置）') +
      ' —— 没有名字的帧里**看不见代码**，不要把它们当成"已确认的框架代码"。')
  }
  if (v.suspectThread) {
    const t = v.suspectThread
    out.push('嫌疑线程：mid=' + (t.managedId ?? '?') + ' os=' + (t.osId ?? '?') +
      (t.lockCount ? ' locks=' + t.lockCount : ''))
    // **栈在 `stackText`（字符串）里**，`suspectThread` 只有 {managedId,osId}（Claude 第十二轮）——
    // 旧渲染读 `suspectThread.frames` 于是**嫌疑线程栈整个丢失**，而那正是"卡在哪"的原始证据。
    const framesText = typeof v.stackText === 'string' && v.stackText.trim()
      ? v.stackText.trim()
      : (Array.isArray(t.frames) ? t.frames.map((f) => (typeof f === 'string' ? f : (f.text || JSON.stringify(f)))).join('\n') : '')
    if (framesText) {
      out.push('  托管栈（前 25 帧）：')
      for (const line of framesText.split('\n').slice(0, 25)) out.push('    ' + line)
    } else {
      out.push('  （没有托管栈文本：dump 里该线程没有可解析的托管帧）')
    }
  } else {
    out.push('未识别出嫌疑/UI 线程 —— **这本身就是结论**：可能客户端当时并没卡死，' +
      '也可能卡在原生代码里（托管栈看不到）。不要据此反向推断"没问题"。')
  }
  if (v.source) {
    // `locateSource()` 给的是 {file, rel, startLine, endLine, suspectLine, code} —— **不是** {line, method, snippet}。
    // 旧渲染读 v.source.line → 真机上打出来的是 `文件:undefined`（而且是"哪一行代码卡住了"的答案所在处）。
    const lineNo = v.source.suspectLine ?? v.source.line
    out.push('源码定位：' + (v.source.rel || v.source.file) + ':' + (lineNo ?? '?') +
      (v.source.startLine && v.source.endLine ? '（方法体 ' + v.source.startLine + '-' + v.source.endLine + '）' : '') +
      '\n  ⚠ 行号是方法**声明处**，不是卡死瞬间执行的那一行（ClrMD 给不出后者）。')
    const snippet = v.source.code ?? v.source.snippet
    if (snippet) out.push('--- 代码片段（行号: 源码）---\n' + String(snippet).slice(0, 1500))
    // 命中的这一帧**上面还有未解析帧**时必须点出来：否则读者会以为"定位到的那一行"就是堵塞点，
    // 而实际上方那几帧才是（真机 WPF 卡死就是这个形态：栈顶 `?.?()`、业务帧在下面）。
    const above = v.unresolved && v.unresolved.aboveUser
    if (above > 0) {
      out.push('  ⚠ 注意：这条定位**上方还有 ' + above + ' 个未解析帧** —— 它们没有模块/符号信息，' +
        '真正的阻塞点可能在其中。要把这段坐实：配好符号（DSH_PERF_SYMBOL_PATH）或让客户端带 PDB 后重抓。')
    }
  } else {
    // 没命中的**原因**要分清：是"没有源码根/是框架类型"，还是"栈顶压根没解析出来"。
    // 后者不是"没匹配上"，而是"看不见"——两者的下一步完全不同。
    const unres = v.unresolved
    if (unres && unres.top5 > 0) {
      out.push('⚠ 源码定位：**没有命中**，而且**栈顶 ' + unres.top5 + ' 帧未解析**（' + unres.count + '/' + unres.total + ' 帧没有模块/符号信息）。\n' +
        '  这不是"匹配不到源码"，而是**在最关键的位置看不见**：根因很可能就在那几帧里。\n' +
        '  因此本次输出**只有「模块!类型.方法」级别的线索，不是代码级证据**。\n' +
        '  下一步：① 给该进程/模块配上符号（DSH_PERF_SYMBOL_PATH）；② 确认客户端发布时带 PDB；③ 再抓一次 dump。')
    } else {
      out.push('⚠ 源码定位：**没有命中**——以上只有「模块!类型.方法」级别的线索，**不是代码级证据**。\n' +
        '  常见原因：① DSH_HANG_SRC_ROOT 未配置或路径不对；② 该帧属于框架/系统类型（本就不在项目源码树里）。')
    }
  }
  // `threadsSummary` 是真实字段（旧渲染读 v.threads 数组 → 线程数永远不显示）
  const ts = Array.isArray(v.threadsSummary) ? v.threadsSummary : (Array.isArray(v.threads) ? v.threads : null)
  if (ts) out.push('线程数：' + (v.threadCount ?? ts.length) + (ts.length ? '（前 ' + Math.min(ts.length, 15) + ' 个：' + ts.slice(0, 3).map((th) => 'mid=' + th.managedId + ' ' + (th.user || th.top || '')).join('；') + '）' : ''))
  return out.join('\n')
}

export function renderDelete(v) {
  if (!v) return '（删除失败：没有返回数据）'
  if (v.ok === false || v.error) return '删除失败：' + (v.error || '原因未回报')
  if (v.blocked) return v.blocked
  return v.all ? ('已清空全部证据包（删除 ' + (v.deleted ?? 0) + ' 个，本地删除不可恢复）')
    : ('已删除证据包 ' + (v.deleted || '?') + '（本地删除不可恢复）')
}
