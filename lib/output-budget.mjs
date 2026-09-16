/**
 * W2（第二块）—— 统一输出预算信封（token-budget envelope）。
 * 见 CODEX-STEAL-ANALYSIS-20260916.md「Tier 1 ④」「第二部分 W2」。
 *
 * 背景：本仓的截断是**各插件按域各自做**的（capped errors/warnings 数组等），MCP 文本出口本身
 * 没有一层统一的"输出太大 → 按 token 截 + 告诉调用方原本多大"。Codex `output_schema`/token 预算
 * 的纪律是：**永远告诉调用方截了多少、原本多少 token**，让它自己决定换更大预算或更窄查询重取，
 * 而不是无声截断（agent 以为拿全了 —— 和"失败显示完成"同一类欺骗）。
 *
 * 约束（对齐本仓既有规矩，与 tool-trace / inline-image 一致）：
 *   1) 默认关（env DSH_OUTPUT_MAX_TOKENS 未设/<=0 → wrap 恒等，零开销、零回归）。
 *   2) 单一 chokepoint：包 server.tool 的 handler，只动返回结果里的**文本块**；image 块（W5）原样保留。
 *   3) 永不抛：预算处理出任何错都绝不改变工具结论（兜住，原样返回）。
 *   4) 截断必留痕：截了就**追加一个说明块**，带 originalTokenCount / keptTokens，绝不无声截断。
 */

/**
 * 估算 token 数（无依赖、CJK 感知）：CJK/假名/全角等按**每字≈1 token**，其余按 **≈1 token/4 字符**。
 * 目的是给 agent 一个"够用来决策"的量级，不追求与某个具体 tokenizer 精确一致。
 */
export function estimateTokens(s) {
  const str = String(s == null ? '' : s)
  let cjk = 0, other = 0
  for (const ch of str) {              // for...of 按 code point 迭代：astral（扩展B+）也算 1 个，
    const c = ch.codePointAt(0)         // 不被 UTF-16 代理对拆成 2（用 str.length 推 rest 会双算，踩过）。
    if (
      (c >= 0x3000 && c <= 0x9fff) ||   // CJK 符号/标点 + 假名 + CJK 统一表意
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容表意
      (c >= 0xff00 && c <= 0xffef) ||   // 全角/半角形式
      (c >= 0x20000 && c <= 0x2ffff)    // CJK 扩展 B+
    ) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 读输出 token 预算：DSH_OUTPUT_MAX_TOKENS（默认 0 = 不截）。opts.maxTokens 显式优先。 */
export function outputMaxTokens(opts = {}, env = process.env) {
  const v = Number(opts.maxTokens ?? env.DSH_OUTPUT_MAX_TOKENS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 按 token 预算截断一段文本。
 * 返回 { text, truncated, originalTokens, keptTokens, originalChars, keptChars }。
 * 不截时 text 原样、truncated:false。截断按"token≈字符线性"估算保留长度，宁可略少不超预算。
 */
export function budgetText(s, maxTokens) {
  const str = String(s == null ? '' : s)
  const originalTokens = estimateTokens(str)
  const max = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0
  if (!max || originalTokens <= max) {
    return { text: str, truncated: false, originalTokens, keptTokens: originalTokens, originalChars: str.length, keptChars: str.length }
  }
  const ratio = str.length / Math.max(1, originalTokens)   // 字符/ token
  let keepChars = Math.max(0, Math.floor(max * ratio) - 40) // 留点余量给说明块本身不算，纯保守
  if (keepChars > str.length) keepChars = str.length
  let kept = str.slice(0, keepChars)
  // 保守收敛：估算仍超预算就按 90% 逐步回退（几何收敛，kept 归零即止，绝不死循环）。
  while (kept.length > 0 && estimateTokens(kept) > max) {
    keepChars = Math.floor(keepChars * 0.9)
    kept = str.slice(0, keepChars)
  }
  return { text: kept, truncated: true, originalTokens, keptTokens: estimateTokens(kept), originalChars: str.length, keptChars: kept.length }
}

const note = (msg) => ({ type: 'text', text: '[output-budget] ' + msg })

/**
 * 在既有 MCP 结果 {content:[...]} 上按需施加输出预算：只动**第一个** text 块（截断其文本），
 * 其余块（含 W5 的 image 块）原样保留；截断时**追加**一个说明块带 originalTokenCount。
 * 就地改并返回同一对象，从不抛。
 */
export function attachBudget(mcpResult, opts = {}, env = process.env) {
  try {
    if (!mcpResult || !Array.isArray(mcpResult.content)) return mcpResult
    const max = outputMaxTokens(opts, env)
    if (!max) return mcpResult
    const block = mcpResult.content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
    if (!block) return mcpResult
    const r = budgetText(block.text, max)
    if (!r.truncated) return mcpResult
    block.text = r.text
    mcpResult.content.push(note(
      `output truncated to fit ~${max} tokens: kept ~${r.keptTokens} of ~${r.originalTokens} tokens ` +
      `(${r.keptChars}/${r.originalChars} chars). Narrow the query or raise DSH_OUTPUT_MAX_TOKENS for the rest.`))
    return mcpResult
  } catch { return mcpResult }
}

/**
 * server.tool 包装用：把 handler 的返回结果过一遍输出预算。默认关（max<=0）时是恒等 —— 注册的仍是原 handler。
 * @param {object} o
 * @param {number} [o.maxTokens]  token 预算（<=0 或非法 = 关）
 */
export function makeOutputBudget({ maxTokens } = {}) {
  const max = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0
  function wrap(name, handler) {
    if (!max) return handler // 关：透明直通
    return async (...a) => attachBudget(await handler(...a), { maxTokens: max })
  }
  return { enabled: !!max, wrap }
}
