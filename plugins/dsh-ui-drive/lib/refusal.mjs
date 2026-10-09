/**
 * 「这次失败是闸门按设计拒绝 / 环境没配置，还是工具真的坏了？」—— 两个判定放在一处。
 *
 * isExpectedRefusal —— 给**失败库**用：策略表拒绝、未带 allowSideEffects、快照三件套
 *   （stale / expired / unknown snapshotId）、目标进程未配置。这些是安全门在正常工作或环境状态，
 *   不是工具失灵；自动记成 tool-error 只会制造噪声。2026-10 真库复盘：811 条 tool-error 里约 94%
 *   正是这几类（而且基本由一个测试反复写入），真正的故障被淹没在里面。
 *
 * isGateDenied —— 给**证据账本**用（driver.mjs 的 denied/unknown/action 三分）：在上面的基础上
 *   还包括 notExecuted（排队到期、动作从未发出）。账本关心"动作执行了没有"，所以它算 denied；
 *   失败库关心"工具是否失灵"，排队超时恰恰是要记下来的拥堵信号 —— 所以两者**有意不等价**。
 */
export function isExpectedRefusal(res) {
  return !!(res && (res.policyCode || res.requiresAllowSideEffects || res.unconfigured ||
    res.staleSnapshot || res.expiredSnapshot || res.unknownSnapshot))
}

export function isGateDenied(res) {
  return isExpectedRefusal(res) || !!(res && res.notExecuted)
}
