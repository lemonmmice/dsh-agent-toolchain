/**
 * dsh-ui-drive 渲染层 — 工具输出的「agent 可见文本」。
 *
 * 为什么单独成模块：渲染文本是**契约的一部分**（agent 只看得见这里打出来的东西），
 * 必须能离线单测；而 index.js 依赖宿主的 `@deepseek-ai/dsh-tools`，普通 node 进程
 * 里 import 不到，渲染逻辑留在 index.js 里就等于不可测。
 */

/**
 * B-1：观测完整性提示的显示尾巴。
 *  · `warn` 由 driver 统一生成（lib/driver.mjs 的 skipInfo）：跳过数 > 0 或空枚举时必须说清；
 *  · `observationWarning`：连「跳过计数」都没拿到（老脚本/回退路径）时，明确告诉调用方
 *    「完整性未知」——复核（Codex 2026-09-11）指出的第二个静默口子。
 * 逐元素容错后如果不说「少了几行」，调用方会把「没读到」当成「界面上没有」，
 * 那就是换了个地方藏的新一轮假空。
 */
/**
 * ui_flow 的渲染。
 *
 * UD-03（2026-09-11 审计确证）：旧渲染只印 `passed`/`failed`，而这两个数**只统计断言步**；
 * 一个失败的 click 会得到 `{ok:true, passed:0, failed:0}`，渲染成「0 通过 / 0 失败」，
 * 于是 agent 认为整段流程跑通了。现在把**动作步失败数**单独印出来，并且只要有任何失败
 * （断言失败或动作失败）就在首行醒目提示 —— 别让"0 通过 / 0 失败"这种空话掩盖失败。
 */
export function renderFlow(v) {
  if (!v) return '（流程没有返回结果）'
  if (v.ok === false && v.error) return '流程失败：' + v.error
  const sf = typeof v.stepFailures === 'number' ? v.stepFailures : 0
  const bad = (v.failed || 0) + sf
  const head = '自验流程结束：' + v.passed + ' 断言通过 / ' + v.failed + ' 断言失败' +
    (sf > 0 ? ' / **' + sf + ' 个动作步失败**' : '') +
    '（批量执行 ' + (v.elapsedMs != null ? v.elapsedMs + 'ms' : '?') + '），证据：' + v.evidenceDir
  const warn = []
  if (bad > 0) {
    warn.push('⚠ 本次流程**没有全部成功**（失败合计 ' + bad + '）。' +
      (Array.isArray(v.stepFailureNames) && v.stepFailureNames.length
        ? '失败的动作步：' + v.stepFailureNames.join('，')
        : '') +
      '\n  下一步：看 steps.json 的 transcript（每步带 ok/error），别只看这一行的计数。')
  } else if (v.totalSteps > 0 && v.passed === 0 && sf === 0) {
    warn.push('ℹ 全部步骤成功，但**一个断言都没有**（passed=0）——这说明"流程跑通了"，' +
      '不说明"结果正确"。要验正确性请加 expect / expectwindow / expecttext / waitany 步。')
  }
  return [head, ...warn].join('\n')
}

/**
 * 观测完整性尾注 —— agent 判断"这份清单能不能当依据"的唯一信息来源。
 *
 * 三条都是实测踩出来的，且同源：**driver 已经算准了，渲染层却没印出来**，
 * 而宿主只把 render 的文本交给模型（`dsh-agent-loop` 只传 `content`）——
 * 没印出来的字段对 agent 等于不存在。
 *
 *  · **F-002（skipped 契约）**：工具描述与 README 都承诺「read/state 结果**恒带** skipped=N」，
 *    但旧 skipTail 只在 `warn`/`observationWarning` 存在时才输出 —— 于是 `skipped=0` 时什么都不打，
 *    agent 无法区分「skipped=0（清单完整）」与「工具没给（未知）」。现在**恒显式打印**：
 *    `skipped=0（清单完整）` / `skipped=N（清单不完整）` / `skipped=?（该引擎未回报 → 完整性未知）`。
 *
 *  · **UD-01（截断当完整）**：driver 透传了 `truncated`/`returned`（`driver.mjs:1129-1130`），
 *    脚本层也有 300 行上限，但 read 分支从不打印 —— 一个 250 行的窗口被当成"全部控件"读。
 *    回退路径更把截断**谎报成完整**（`lines.slice(0,200), truncated: text.length > LIMIT_READ` 里的比较是错的）。
 *
 *  · **UD-02（0 行无解释）**：脚本专门算了 `scanned`/`offscreen`，
 *    就是为了"让 0 行永远解释得清"，渲染层同样一个词都没印 ——
 *    agent 看到的逐字符就是 `"读到 0 个控件：\n"`，于是推断"界面是空的"。
 */
function completenessTail(v, count) {
  const parts = []

  // 0) UD-04（范围限定必须说出来）：inAid/inName 是「限定读取范围」，但旧实现把它静默吞掉，
  //    渲染层却还在教模型「用 inAid/inName 限定容器后重读」—— 文档教了一个不存在的功能。
  //    实现补上之后这里也必须标注：一份只覆盖某个容器的清单如果不标，会被当成整个窗口的清单。
  if (v && v.narrowed === true) {
    parts.push('范围=' + (v.scope || '(指定容器)') +
      '（**本次清单只覆盖该容器内的控件，不是整个窗口的清单**）')
  }

  // 1) 截断：必须说清"你看到的不是全部"，并给出拿全的办法
  //    两个来源共用这个字段（语义统一："这份清单被上限截短了"）：
  //      · read 的 300 行上限；
  //      · state / state-live 的 max 上限（Claude 第八轮问的"隐性 40 上限"—— 已改成显式回报）。
  if (v && v.truncated === true) {
    const shown = Array.isArray(v.lines) ? v.lines.length : (v.count ?? count ?? '?')
    parts.push('⚠ 本次输出**已截断**（不是全部控件）：返回了 ' + shown + ' 条' +
      (typeof v.maxApplied === 'number' ? '（state 的 max=' + v.maxApplied + ' 已用满）' : '') +
      (typeof v.scanned === 'number' ? '（本次共扫描到 ' + v.scanned + ' 个元素）' : '') +
      '。要更小的集合请用 match 正则过滤、或用 inAid/inName 限定容器后重读（限定后的清单会标注 范围=…）；' +
      'state 也可直接调大 max。')
  }

  // 2) 跳过计数：文档承诺恒带 → 0 也要出现；没回报就说"未知"，绝不冒充 0
  if (v && typeof v.skipped === 'number') {
    parts.push('skipped=' + v.skipped + (v.skipped > 0 ? '（读不到状态的元素，**本次清单不完整**）' : '（清单完整）'))
  } else {
    parts.push('skipped=?（该读取路径未回报跳过计数 → **完整性未知**，不等于清单完整）')
  }
  if (v && Array.isArray(v.skippedReasons) && v.skippedReasons.length > 0) {
    parts.push('  跳过原因：' + v.skippedReasons.slice(0, 3).join('；'))
  }

  // 3) 0 行必须解释得清：scanned=0 是"这次真没看到"，scanned>0 是"看到了但都被过滤掉"
  if (count === 0) {
    const scanned = typeof (v && v.scanned) === 'number' ? v.scanned : null
    const offscreen = typeof (v && v.offscreen) === 'number' ? v.offscreen : null
    if (scanned === 0) {
      parts.push('ℹ 0 行的解释：本次枚举**扫到 0 个元素**（scanned=0）—— 可能是窗口还没内容、或枚举时机太早。')
    } else if (scanned !== null) {
      parts.push('ℹ 0 行的解释：扫到 ' + scanned + ' 个元素，但都被过滤掉了' +
        (offscreen !== null ? '（其中 ' + offscreen + ' 个在可视区外 offscreen）' : '') +
        '。**这不代表界面上没有控件** —— 试试去掉 match、或把窗口恢复到前台后重读。')
    } else {
      parts.push('ℹ 0 行的解释：**未回报扫描计数**（scanned 未知）→ 无法区分「确实没控件」与「没读到」。' +
        '先 ui_observe(state) 交叉验证，再下结论。')
    }
  }

  // 4) driver 生成的 warn（skipped>0 / 空枚举）与"连计数都没拿到"的 observationWarning
  if (v && v.warn) parts.push(v.warn)
  if (v && v.observationWarning && !v.warn) parts.push('ℹ ' + v.observationWarning)

  return parts.length ? '\n' + parts.join('\n') : ''
}

/**
 * W1：read(diff=true) 的变化摘要尾巴。
 *  · diffBaseline → 只说「基线已建立」，不出增减摘要（首读没有可比对象，出摘要就是幻影 diff）；
 *  · diffSuppressed → 明说「本次读取不完整、已回落完整清单、不做比对」（skipped>0/空枚举时）；
 *  · diff → 「新增 a / 移除 b / 不变 c」摘要 + 增/删逐行（agent 一眼看清界面变了什么）。
 */
function hintTail(v) {
  if (v?.staleSnapshot) return '（下一步：界面已刷新，重新 ui_observe(state) 获取新 snapshotId）'
  if (v?.denied) return '（下一步：该控件被驱动层拒绝；改用 find/read 做只读验证，或请用户手动确认）'
  if (v?.requiresAllowSideEffects) return '（下一步：确认目标无误后重发，并带 allowSideEffects=true）'
  return '（下一步：先用 ui_observe(state/read) 重新确认当前界面与目标控件）'
}

function diffTail(v) {
  if (!v) return ''
  if (v.diffBaseline) return '\n（diff 基线已建立：首次读取，后续 read(diff=true) 才比对增减）'
  if (v.diffSuppressed) return '\n（diff 已抑制：本次读取不完整，已回落完整清单，不做增减比对）'
  if (v.diff) {
    const d = v.diff
    const head = '\n变化：新增 ' + d.added.length + ' / 移除 ' + d.removed.length + ' / 不变 ' + d.unchanged
    const add = (d.added || []).map((l) => '\n  + ' + l).join('')
    const rem = (d.removed || []).map((l) => '\n  - ' + l).join('')
    return head + add + rem
  }
  return ''
}

export function renderState(v) {
  if (!v.ok) return '失败：' + (v.error || '未知错误') + hintTail(v)
  return '窗口=' + (v.window || '?') + ' 焦点=' + (v.focused || '无') +
    '\n交互控件 ' + v.count + ' 个：\n' + (v.lines || []).join('\n') + completenessTail(v, v.count)
}

export function renderDrive(v) {
  if (!v.ok) return '失败：' + (v.error || '未知错误') + hintTail(v)
  switch (v.action) {
    case 'find': return v.found ? ('找到：' + v.detail + (v.count > 1 ? '（共 ' + v.count + ' 个匹配，可用 index 指定第几个）' : '')) : '未找到目标控件（下一步：重新 ui_observe(state/read) 确认当前界面与控件名称）'
    case 'read': return '读到 ' + v.count + ' 个控件：\n' + (v.lines || []).join('\n') + completenessTail(v, v.count) + diffTail(v)
    case 'state': return renderState(v)
    // Claude 第九轮 Q1（顺带发现）：renderDrive **没有 state-live 分支**，于是
    // `ui_drive(action:'state-live')` / `ui_observe(state-live)` 落到 `default` → 只打印
    // `v.output || '完成'`，整份控件清单**在外壳面上被吞掉**（MCP 面走 jtext 原始对象，所以只有外壳面中招）。
    // 与 state 同形渲染（同一个 completenessTail），不再有"某条读路径悄悄不印"。
    case 'state-live': return renderState(v)
    case 'windows': return v.count + ' 个顶层窗口：\n' + (v.lines || []).join('\n')
    // ── R1-06（D.1 核出来的三处，同一形状：生产者给了结构化结果，渲染层没有分支 ⇒ 掉进 default）──
    // 为什么"掉进 default"在这里等于**信息被吞**而不是"文字难看"：这三个 action 的结果里
    // **都没有 `output` 字段**（见 lib/driver.mjs:1586/1593/1603），而 default 渲染的是 `v.output || '完成'`
    // ⇒ agent 看到的逐字符就是「完成」。渲染文本是 agent 唯一看得见的东西（本文件开头那句）。
    case 'capture': {
      // driver.mjs:1603 `{ok,action,state,captureMethod,pid,window,path?,w?,h?}`；
      // 字段语义照 scripts/ui-drive-batch.ps1:2045 的注释（state=visible|minimized|hidden|nowindow，
      // captureMethod=print|screen）——**不编方向，照实印**。
      const bits = ['窗口状态=' + (v.state || '?')]
      if (v.captureMethod) {
        bits.push('方式=' + (v.captureMethod === 'print' ? 'print（PrintWindow，窗口被遮挡也抓得到）'
          : v.captureMethod === 'screen' ? 'screen（CopyFromScreen，**窗口被遮挡/最小化时画面不可信**）'
            : v.captureMethod))
      }
      if (v.pid) bits.push('pid=' + v.pid + (v.window ? ' 窗口=' + v.window : ''))
      const head = '抓帧：' + bits.join('，')
      if (!v.path) return head + '\n⚠ 本次**没有帧文件路径**（没抓到帧）—— 别把它读成"抓到了一张空图"'
      return head + '\n帧文件：' + v.path + (v.w && v.h ? ' ' + v.w + 'x' + v.h : '')
    }
    case 'expectwindow':
    case 'expecttext': {
      // driver.mjs:1586 `{ok,action,found,waitedMs,detail?,count?,lines?}`。
      // README 把这两个说成"判定登录结果的唯一可靠信号"——而它们此前渲染成「完成」。
      // ⚠ **不猜方向**：结果里没有 `gone` 字段，成功路径无法区分"出现了"与"消失了"，
      //    所以只说"条件成立"；方向（gone=…/textRe=…）在失败时由 error 带出。
      const what = v.action === 'expectwindow' ? '窗口条件' : '文本条件'
      const body = []
      if (v.detail) body.push('  ' + v.detail)
      if (Array.isArray(v.lines) && v.lines.length) body.push(...v.lines.map((l) => '  ' + l))
      if (typeof v.count === 'number') body.push('  命中 ' + v.count + ' 条')
      return (v.found === true ? '✓ ' + what + '成立' : '✗ ' + what + '未成立') +
        '（等待 ' + (v.waitedMs || 0) + 'ms）' + (body.length ? '\n' + body.join('\n') : '')
    }
    case 'waitany': {
      // driver.mjs:1593 `{ok,action,hitIndex,hitKind,hitLabel,waitedMs,detail?}`。
      // waitany 的卖点就是"一次押注多支、并告诉你哪一支中了"（工具描述原话）——
      // 此前渲染成「完成」⇒ **"命中哪一支"这个唯一有价值的信息被吞掉**，agent 只能再猜一次。
      const hit = Number(v.hitIndex) >= 0
      const bits = []
      if (v.hitKind) bits.push('kind=' + v.hitKind)
      if (v.hitLabel) bits.push('label=' + v.hitLabel)
      return (hit ? '竞速命中第 ' + v.hitIndex + ' 支' : '竞速结束：**没有任何一支成立**') +
        '（等待 ' + (v.waitedMs || 0) + 'ms）' + (bits.length ? '：' + bits.join(' ') : '') +
        (v.detail ? '\n  ' + v.detail : '')
    }
    case 'waitfor': return (v.found ? '条件已满足' : '条件已满足（目标已消失）') + '（等待 ' + (v.waitedMs || 0) + 'ms）' + (v.detail ? '：' + v.detail : '')
    case 'shot': return '截图：' + v.path + ' ' + v.w + 'x' + v.h + (v.workspacePath ? '（副本 ' + v.workspacePath + '，可用 describe_image 复核）' : '') + (v.description ? '\n界面描述：' + v.description : '')
    default: return v.output || '完成'
  }
}

/**
 * live 快照脱敏（统一出口）：任何 live 输出（status/frame/frame.png 路由、**MCP 面**）都过这里。
 * 敏感帧（焦点=密码/验证码）默认把帧路径全部置空 + sensitiveBlocked 标记，
 * agent/路由拿不到 png 路径（像素无法脱敏）；allowSensitive=true 显式解锁。
 * old codex 评审否决项①：/live/status 曾直出未过滤快照。
 *
 * UD-05（原 P1 第 5 条）第一版只清了 `path`/`pathAbs`，而 Claude 第八轮真机指出**两条绕过路径**：
 *   ① `...s.frame` 会把 `file`（= 'latest.png'）留下、`...s` 会把顶层 `dir` 留下 ——
 *      `join(dir, file)` 正好就是刚刚被 null 掉的 `pathAbs`：**换个字段泄漏**，与 UD-05 一字不差；
 *   ② MCP 面的 ui_live 压根不调用本函数（jtext 直出原始快照）→ 脱敏只活在 DSH 面。
 * 现在：`file` 与 `dir` 一起清（宁可少给一个目录名，也不能让路径可重组），
 * 且 MCP 面走同一个函数（见 mcp/server.mjs）。
 */
export function sanitizeLive(s, allowSensitive) {
  if (!s || !s.frame) return s
  if (s.frame.secretFocused && !allowSensitive) {
    return {
      ...s,
      dir: null,
      frame: { ...s.frame, path: null, pathAbs: null, file: null, sensitiveBlocked: true },
    }
  }
  return s
}

/**
 * UD-05：帧路径的显示文本。
 * `frame.path` 是**文件名**（相对 live 目录；路由 `/live/frame.png` 靠 `join(dir, path)` 读它），
 * `frame.pathAbs` 才是能**直接喂给 read_image** 的绝对路径。
 * 只印 path 会让 agent 去**当前工作目录**找 latest.png —— 而工具描述承诺的正是
 * "read_image(frame.path) 即看见当前画面"。文档说了一个不存在的绝对路径，就是撒谎。
 */
export function framePathText(f) {
  if (!f) return ''
  const dim = f.w && f.h ? ' ' + f.w + 'x' + f.h : ''
  if (f.pathAbs) return f.pathAbs + dim + '（这个绝对路径可直接 read_image；frame.path 只是文件名）'
  if (!f.path) return ''
  return String(f.path) + dim + '（注意：这是**文件名**，不是绝对路径——要绝对路径请用 frame.pathAbs）'
}

/**
 * UD-06（原 P1 清单第 6 条，2026-09-11）：ui_launch 的显示文本。
 * 旧渲染在 `v.started` 分支只印 `已启动 pid=… 窗口=…`，把 `warning`
 * （进程起了但主窗口没出现）**整个丢掉** —— 半成功被渲染成成功，
 * agent 接着去用别的 ui_* 工具，全部失败却不知道原因。
 */
export function launchText(v) {
  if (!v) return '启动没有返回结果（工具执行异常）'
  // force 重启：先把"动过谁"印在最前面 —— 破坏性操作必须留下可核对的事实
  const killLine = v.forceKill && !v.forceKill.nothingToKill
    ? '\n' + (v.forceKill.killed
      ? '（force 重启：已结束 ' + (v.forceKill.pids || []).join(',') + '，等待 ' + (v.forceKill.waitedMs || 0) + 'ms 确认退出）'
      : '（force：未结束任何进程 —— ' + (v.forceKill.refused ? '已拒绝执行（见原因）' : '未能确认退出') + '）')
    : ''
  if (v.ok === true) {
    return (v.alreadyRunning
      ? '客户端已在运行（pid=' + v.pid + ' 窗口=' + (v.title || '?') + '）'
      : (v.restarted ? '已**重启**客户端' : '已启动') + ' pid=' + v.pid + ' 窗口=' + (v.title || '?')) + killLine
  }
  if (v.partial) {
    return '⚠ **半成功**：进程已起（pid=' + v.pid + '）但主窗口在 ' + (v.waitedMs || 0) + 'ms 内没出现 —— ' +
      '不要当成启动成功。' + (v.hint ? '\n' + v.hint : '') + killLine
  }
  return '启动失败：' + (v.error || v.warning || '未知原因') + (v.hint ? '\n' + v.hint : '') + killLine
}

export function renderLive(v) {
  if (!v) return '（实时视图没有返回结果）'
  if (v.error) return 'ui_live 失败：' + v.error
  // Claude 1.4：wait() 返回 {ok,changed,hash,seq,timedOut,waitedMs,reason,snapshot}，
  // 顶层没有 live/frame/ui —— 必须单独渲染，否则 agent 看到的永远是「已停止 0 帧」。
  if (v.changed !== undefined || v.timedOut !== undefined) {
    const snap = v.snapshot || {}
    const f = snap.frame || null
    const lines = []
    lines.push('帧变化等待：' + (v.timedOut ? '超时 ' + (v.waitedMs || 0) + 'ms（画面未变化）' : (v.changed ? '已变化 ' + (v.waitedMs || 0) + 'ms，新帧 #' + v.seq + ' hash=' + String(v.hash || '').slice(0, 12) + '…' : '结束')))
    if (!v.ok && v.reason) lines.push('原因：' + v.reason)
    if (snap.live) lines.push('实时视图：' + (snap.live.running ? '运行中' : '已停止') + '（帧 ' + (snap.live.frameCount || 0) + (snap.live.autostopReason ? '，autostop=' + snap.live.autostopReason : '') + '）')
    if (f && (f.path || f.pathAbs)) lines.push('最新帧 #' + f.seq + '：' + framePathText(f))
    return lines.join('\n')
  }
  const l = v.live || {}
  const f = v.frame || null
  const ui = v.ui || null
  const lines = []
  lines.push('实时视图：' + (l.running ? '运行中' : '已停止') + '（帧 ' + (l.frameCount || 0) + '，间隔 ' + (l.intervalMs || '-') + 'ms' + (l.autostopReason ? '，autostop=' + l.autostopReason : '') + (l.lastError ? '，最近错误：' + l.lastError : '') + '）')
  if (v.client && v.client.pid) lines.push('客户端：pid=' + v.client.pid + ' ' + (v.client.window || '') + (v.client.running === false ? '（未运行）' : ''))
  if (f) {
    const state = f.state || '?'
    const sec = f.secretFocused ? '，敏感帧' : ''
    const hasPath = !!(f.path || f.pathAbs)
    lines.push('最新帧 #' + f.seq + '：' + (hasPath ? framePathText(f) : ('未出帧（' + state + sec + '）')) + (f.changed === false ? '（无变化）' : '（已变化）') + ' hash=' + String(f.hash || '').slice(0, 12) + '…' + sec + (f.captureMethod ? ' 抓法=' + f.captureMethod : ''))
  }
  if (ui) {
    lines.push('控件状态：' + (ui.window || '?') + ' 焦点=' + (ui.focused || '无') + ' 共 ' + (ui.count || 0) + ' 个')
    // Claude 第九轮 Q1：live 的控件摘要同样可能**被截断/被限定范围/有条目读不到** ——
    // 这里过去只印 count，于是 ui_live 给出的清单永远是"看起来完整"的。
    // 与 read/state 共用 completenessTail（单一产出点），任何一处漏印都会立刻不一致。
    lines.push(...completenessTail(ui, ui.count || 0).split('\n').filter(Boolean))
  }
  return lines.join('\n')
}

