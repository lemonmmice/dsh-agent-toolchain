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
function skipTail(v) {
  const parts = []
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
  if (!v.ok) return '失败：' + (v.error || '未知错误')
  return '窗口=' + (v.window || '?') + ' 焦点=' + (v.focused || '无') +
    '\n交互控件 ' + v.count + ' 个：\n' + (v.lines || []).join('\n') + skipTail(v)
}

export function renderDrive(v) {
  if (!v.ok) return '失败：' + (v.error || '未知错误')
  switch (v.action) {
    case 'find': return v.found ? ('找到：' + v.detail + (v.count > 1 ? '（共 ' + v.count + ' 个匹配，可用 index 指定第几个）' : '')) : '未找到目标控件'
    case 'read': return '读到 ' + v.count + ' 个控件：\n' + (v.lines || []).join('\n') + skipTail(v) + diffTail(v)
    case 'state': return renderState(v)
    case 'windows': return v.count + ' 个顶层窗口：\n' + (v.lines || []).join('\n')
    case 'waitfor': return (v.found ? '条件已满足' : '条件已满足（目标已消失）') + '（等待 ' + (v.waitedMs || 0) + 'ms）' + (v.detail ? '：' + v.detail : '')
    case 'shot': return '截图：' + v.path + ' ' + v.w + 'x' + v.h + (v.workspacePath ? '（副本 ' + v.workspacePath + '，可用 describe_image 复核）' : '') + (v.description ? '\n界面描述：' + v.description : '')
    default: return v.output || '完成'
  }
}
