/**
 * dsh-ui-drive 截图就绪态（**两个面共用一份实现**，避免 DSH 面与 MCP 面行为漂移）。
 *
 * 2026-10-14（用户决定）：插件**不再调用任何视觉模型** —— 不产出界面文字描述，只产出 PNG。
 * 于是原先「靠视觉模型回答里出现『纯黑/空白』来判定没渲染完并重拍」这条判据没了，改由
 * 截图侧本地给出信号：`distinctColors`（PS 侧在截图位图上做 24x24 网格采样得到的颜色种数，
 * 见 scripts/ui-drive-batch.ps1 的 Render-WindowPng）。
 *
 * 为什么必须补这个判据：真机抓到过整幅纯白的 launch-state.png
 * （<ui-evidence>/<run>/launch-state.png，1266x741 仅 3767B，
 * 肉眼确认纯白）—— 窗口句柄出现 ≠ 画面已经画完。
 *
 * ⚠ 口径（不许含糊）：`distinctColors<=2` 是**启发式**，不是"空白的证明"：
 *   · 它只能说"采样到的颜色很少"；一个真的只有两种颜色的界面也会命中；
 *   · 反过来，未渲染完的画面未必只有 2 种颜色（例如只画了背景+边框）。
 *   所以结果里同时给出 `distinctColors` 与 `settleRetries`，让调用方自己判断。
 */

/**
 * @param driver  driver 实例（`drv()`）
 * @param opts.settleMs   首次截图前的静置（默认 0；ui_launch 用 400ms 让刚出现的窗口先画完）
 * @returns {{screenshot,size,distinctColors,settleRetries,note?}|null} 截图本身失败时返回 null
 */
export async function shotState(driver, { workspace = '', label = 'state', settleMs = 0, maxRetries = 2, retryWaitMs = 500, procId = 0 } = {}) {
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
  let last = null
  for (let i = 0; i <= maxRetries; i++) {
    let s
    try {
      s = await driver.drive({ action: 'shot', label: i === 0 ? label : label + '-retry' + i, workspace, procId })
    } catch (e) {
      // drive 抛（驱动层异常/锁忙）也不许把整个 ui_launch 带崩：转成一次可重试的失败
      s = { ok: false, error: String((e && e.message) || e) }
    }
    if (!s || s.ok !== true) {
      // 截图**失败**也要重拍：真机实测窗口刚可见那一刻会失败一次（GetWindowRect 还没稳定），
      // 旧写法直接 return null ⇒ 调用方静默拿不到图，看起来像"没这功能"。
      // 用满次数仍失败 ⇒ 如实返回 error（**不许**当成"没有界面"）。
      if (i < maxRetries) { await new Promise((r) => setTimeout(r, retryWaitMs)); continue }
      return { screenshot: null, size: null, distinctColors: null, settleRetries: i, error: (s && s.error) || '截图失败（原因未回报）' }
    }
    last = {
      screenshot: s.workspacePath || s.path,
      size: s.w + 'x' + s.h,
      // 老脚本/老部署副本不返回这个字段 ⇒ 明确报 null（未知），**不要**当成"渲染好了"
      distinctColors: typeof s.distinctColors === 'number' ? s.distinctColors : null,
      settleRetries: i,
    }
    if (last.distinctColors === null || last.distinctColors > 2) return last
    if (i < maxRetries) await new Promise((r) => setTimeout(r, retryWaitMs))
  }
  last.note = '截图采样到的颜色 ≤2 种（疑似窗口尚未渲染完成；已重拍 ' + last.settleRetries + ' 次仍是纯色）。' +
    '这是本地启发式判据，不是"空白的证明"：请自己 read_image 确认，必要时隔一会儿再 shot。'
  return last
}
