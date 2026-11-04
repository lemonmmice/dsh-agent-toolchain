#!/usr/bin/env node
/**
 * no-op Stop-hook 兼容垫片。
 *
 * 收尾裁决面（verify_report / failure_* / Stop 收尾裁决闸）已整体下线，`hooks/hooks.json`
 * 不再注册任何 Stop 钩子。但**已在运行、于会话启动时缓存了旧 Stop 引用**的宿主（本 Claude
 * 会话、DSH web GUI、Codex 等）仍会在 Stop 时调用本文件 —— 文件若不存在就会抛
 * MODULE_NOT_FOUND 把回合收尾打断。
 *
 * 因此保留这个**零逻辑**垫片：读完 stdin、什么都不判、exit 0（= 允许收尾、无反馈）。
 * 所有宿主重载后此文件可直接删除。
 */
try {
  process.stdin.resume()
  process.stdin.on('data', () => {})
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
} catch {
  process.exit(0)
}
// 宿主不写 stdin（或不关闭）时兜底退出，绝不卡住收尾。
setTimeout(() => process.exit(0), 200)
