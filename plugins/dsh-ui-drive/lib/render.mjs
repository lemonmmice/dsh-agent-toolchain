/**
 * dsh-ui-drive 渲染层 — 工具输出的「agent 可见文本」。
 *
 * 为什么单独成模块：渲染文本是**契约的一部分**（agent 只看得见这里打出来的东西），
 * 必须能离线单测；而 index.js 依赖宿主的 `@deepseek-ai/dsh-tools`，普通 node 进程
 * 里 import 不到，渲染逻辑留在 index.js 里就等于不可测。
 */

/**
 * B-1：跳过计数的显示尾巴。
 * `warn` 由 driver 统一生成（lib/driver.mjs 的 skipInfo），这里只负责显示——
 * 逐元素容错后如果不说「少了几行」，调用方会把「没读到」当成「界面上没有」，
 * 那就是换了个地方藏的新一轮假空。
 */
function skipTail(v) {
  return v && v.warn ? '\n' + v.warn : ''
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
    case 'read': return '读到 ' + v.count + ' 个控件：\n' + (v.lines || []).join('\n') + skipTail(v)
    case 'state': return renderState(v)
    case 'windows': return v.count + ' 个顶层窗口：\n' + (v.lines || []).join('\n')
    case 'waitfor': return (v.found ? '条件已满足' : '条件已满足（目标已消失）') + '（等待 ' + (v.waitedMs || 0) + 'ms）' + (v.detail ? '：' + v.detail : '')
    case 'shot': return '截图：' + v.path + ' ' + v.w + 'x' + v.h + (v.workspacePath ? '（副本 ' + v.workspacePath + '，可用 describe_image 复核）' : '') + (v.description ? '\n界面描述：' + v.description : '')
    default: return v.output || '完成'
  }
}
