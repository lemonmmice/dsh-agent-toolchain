/**
 * W2（第一块）—— 工具调用追踪（structured tool dispatch trace）。
 * 见 CODEX-STEAL-ANALYSIS-20260916.md「第二部分 W2」。
 *
 * 抄 Codex `call_trace.rs` 的纪律：每次工具调用记一条结构化轨迹，但**只记**
 * 工具名 / runId / 起止时间 / ok / errorCode —— **绝不记参数或输出**（其中可能有
 * 手机号、验证码、token、下单参数）。用来回答"这次任务里哪些工具被调过、各自多久、
 * 成没成"，把散落各处的调用关联到一个 runId 上。
 *
 * 约束：
 *   1) 默认关（env DSH_TOOL_TRACE 未开 → wrap 原样返回 handler，零开销、零回归）。
 *   2) 永不影响工具本身：写轨迹失败被吞掉；handler 抛出的错误**原样重抛**（先记后抛）。
 *   3) 隐私安全：记录字段是固定白名单，errorCode 只取 error.code/name（不含自由文本 message）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** MCP 结果 → ok？本仓 jtext() 在 ok:false / verdict:fail 时置 isError，这里据此判定。 */
export function resultOk(result) {
  return !(result && typeof result === 'object' && result.isError === true)
}

/** 从 error 取一个短代码（不带自由文本，避免把路径/密钥写进轨迹）。 */
export function errorCodeOf(e) {
  return (e && (e.code || e.name)) || 'Error'
}

/**
 * server.tool(...) 的参数里，最后一个是 handler（本仓固定 4 参：name, desc, schema, handler；
 * 但 SDK 还支持 2/3/5 参重载）。就地把最后一个函数参数换成包裹版，返回同一个 args 数组。
 * 单独导出以便单测覆盖各种 arity。
 */
export function wrapToolArgs(args, wrap) {
  const i = args.length - 1
  if (i >= 0 && typeof args[i] === 'function') {
    const name = typeof args[0] === 'string' ? args[0] : '(anon)'
    args[i] = wrap(name, args[i])
  }
  return args
}

/**
 * @param {object} o
 * @param {boolean} o.enabled  总开关
 * @param {string}  [o.dir]    轨迹目录（默认写 tool-trace.jsonl 到此）
 * @param {() => number} [o.now]  可注入时钟（测试用）
 * @param {(rec: object) => void} [o.sink]  可注入落地（测试用；默认追加 JSONL）
 */
export function makeToolTrace({ enabled, dir, now = () => Date.now(), sink } = {}) {
  const on = !!enabled
  const write = sink || ((rec) => {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'tool-trace.jsonl'), JSON.stringify(rec) + '\n')
    } catch { /* 轨迹写不进去绝不能改变工具结论 */ }
  })

  function wrap(name, handler) {
    if (!on) return handler // 关：透明直通，注册的还是原函数本身
    return async (...a) => {
      const startedAt = now()
      const runId = a[0] && typeof a[0] === 'object' && typeof a[0].runId === 'string' ? a[0].runId : null
      let ok = true
      let errorCode = null
      try {
        const res = await handler(...a)
        ok = resultOk(res)
        return res
      } catch (e) {
        ok = false
        errorCode = errorCodeOf(e)
        throw e // 先记（finally）后重抛，绝不吞掉工具错误
      } finally {
        const finishedAt = now()
        // 任何 sink（默认 JSONL 或注入的）抛错都不能改变工具结论 —— 兜在调用点。
        try { write({ tool: name, runId, startedAt, finishedAt, ms: finishedAt - startedAt, ok, errorCode }) } catch { /* 轨迹绝不能拖垮工具 */ }
      }
    }
  }

  return { enabled: on, wrap }
}
