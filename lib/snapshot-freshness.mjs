/**
 * 共享只读快照的新鲜度判定（审计反复强调：状态/快照返回必须带 observedAt / ageMs / refreshing；
 * 终端 inspector 的 snapshot() 是同步契约，缺少可用新鲜数据时要暴露 stale/unknown 而不是假装有数据；
 * 而且「展示旧状态」与「动作授权」是两回事 —— 停进程 / 点击 / 删除等破坏性动作必须实时重验目标身份，
 * 绝不能用展示用的缓存快照来授权）。
 *
 * 纯逻辑 + 可离线单测。接到真实终端进程表 / UIA 快照源、以及共享刷新 worker 的实现与收益，
 * 需 Windows 真机 + 真实客户端验证（分级交付：本环境不声称验证过原生部分）。
 */

/** 判定快照新鲜度：fresh / stale / unknown，附 ageMs。时钟回拨时 ageMs 收敛到 0；无 TTL 不判 stale。 */
export function snapshotFreshness({ capturedAt, now, ttlMs, refreshing = false } = {}) {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now)) return { state: 'unknown', ageMs: null, refreshing }
  const ageMs = Math.max(0, now - capturedAt)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return { state: 'fresh', ageMs, refreshing }
  return { state: ageMs <= ttlMs ? 'fresh' : 'stale', ageMs, refreshing }
}

/**
 * 能否用一个展示用快照**授权破坏性动作**（停进程 / 点击 / 删除）？—— 恒 false。
 * 这是审计的硬边界：显示缓存可以带年龄地展示旧状态，但破坏性动作必须在执行前实时重验目标身份，
 * 不存在「快照够新就免重验」的快捷路径。保留此函数是为了让调用点显式表达该约束、并被测试钉住。
 */
export function canAuthorizeDestructiveAction() {
  return false
}
