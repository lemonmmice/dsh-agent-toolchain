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
 *   2) 单一 chokepoint：全部 content.text 共享估算预算，包含说明块；image/structuredContent/resource 不在此预算内。
 *   3) 永不抛：预算处理出任何错都绝不改变工具结论（兜住，原样返回）。
 *   4) 截断必留痕：追加说明块；JSON 文本改为明确的截断信封，previewText 只供阅读，不冒充原结构。
 *   5) 极小预算放不下最小信封与说明时，保留二者并明确实际最低开销，不声称总 token 硬上限。
 */

/**
 * 估算 token 数（无依赖、CJK 感知）：CJK/假名/全角等按**每字≈1 token**，其余按 **≈1 token/4 字符**。
 * 目的是给 agent 一个"够用来决策"的量级，不追求与某个具体 tokenizer 精确一致。
 */
export function estimateTokens(s) {
  return measureText(s).tokens
}

function measureText(value) {
  const str = String(value == null ? '' : value)
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
  return { tokens: cjk + Math.ceil(other / 4), codePoints: cjk + other }
}

function headAndTail(str, count) {
  const headCount = Math.ceil(count / 2)
  const tailCount = count - headCount
  let headEnd = 0
  let tailStart = str.length
  for (let index = 0; index < headCount && headEnd < str.length; index++) headEnd += str.codePointAt(headEnd) > 0xffff ? 2 : 1
  for (let index = 0; index < tailCount && tailStart > headEnd; index++) {
    tailStart--
    const code = str.charCodeAt(tailStart)
    if (code >= 0xdc00 && code <= 0xdfff && tailStart > 0) {
      const previous = str.charCodeAt(tailStart - 1)
      if (previous >= 0xd800 && previous <= 0xdbff) tailStart--
    }
  }
  return [str.slice(0, headEnd), str.slice(tailStart)]
}

/** 读输出 token 预算：DSH_OUTPUT_MAX_TOKENS（默认 0 = 不截）。opts.maxTokens 显式优先。 */
export function outputMaxTokens(opts = {}, env = process.env) {
  const v = Number(opts.maxTokens ?? env.DSH_OUTPUT_MAX_TOKENS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 按 token 预算截断一段文本 —— **保头 + 保尾**（中间省略）。
 * 返回 { text, truncated, originalTokens, keptTokens, originalChars, keptChars }。
 * 不截时 text 原样、truncated:false。
 *
 * 截断时把预算劈成头尾两半：text = 原文头 + 省略标记 + 原文尾。
 * 为什么保尾：构建日志 / xperf 报告 / 线程栈都**头轻尾重** —— 错误数（`N Error(s)`）、退出码、
 * 栈最后一帧都在**尾部**。旧实现 `str.slice(0, keepChars)` 只保头，恰好把"结论"丢了
 * （对照 Codex `truncate_middle`：对称保头保尾）。
 * 按 code point 切边界（与 estimateTokens 同口径，不把 surrogate pair 拆成两半）；
 * 省略标记本身计入预算，连标记仍超则按 90% 收敛（几何收敛，归零即止，绝不死循环）。
 */
export function budgetText(s, maxTokens) {
  const str = String(s == null ? '' : s)
  const measured = measureText(str)
  const originalTokens = measured.tokens
  const max = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0
  if (!max || originalTokens <= max) {
    return { text: str, truncated: false, originalTokens, keptTokens: originalTokens, originalChars: str.length, keptChars: str.length }
  }
  const ratio = measured.codePoints / Math.max(1, originalTokens)
  let keepCps = Math.max(0, Math.floor(max * ratio) - 40)   // 留余量给省略标记本身，纯保守
  if (keepCps >= measured.codePoints) keepCps = measured.codePoints - 1
  // 头尾各一半（头用 ceil 略多，尾取其余），中间插一行省略标记（含被省略的 token 数）。
  const build = (kc) => {
    if (kc <= 0) return `…[output-budget] ${originalTokens} tokens truncated（全部省略，预算过小）…`
    const [head, tail] = headAndTail(str, kc)
    const omitted = Math.max(0, originalTokens - estimateTokens(head) - estimateTokens(tail))
    return head + `\n…[output-budget] ${omitted} tokens truncated（中间省略，头尾保留）…\n` + tail
  }
  let kept = build(keepCps)
  // 保守收敛：连省略标记在内仍超预算就按 90% 回退（几何收敛，keepCps 归零即止，绝不死循环）。
  while (keepCps > 0 && estimateTokens(kept) > max) {
    keepCps = Math.floor(keepCps * 0.9)
    kept = build(keepCps)
  }
  return { text: kept, truncated: true, originalTokens, keptTokens: estimateTokens(kept), originalChars: str.length, keptChars: kept.length }
}

const note = (msg) => ({ type: 'text', text: '[output-budget] ' + msg })

function jsonEnvelope(previewText) {
  return JSON.stringify({ outputBudget: { truncated: true, originalFormat: 'json' }, previewText })
}

function isJsonText(text) {
  try { JSON.parse(text); return true } catch { return false }
}

function fitBlock(block, measured, maxTokens, json) {
  if (measured.tokens <= maxTokens) return block
  const minimum = json ? jsonEnvelope('') : ''
  if (estimateTokens(minimum) > maxTokens) return null
  const available = Math.max(0, maxTokens - estimateTokens(minimum))
  let retained = Math.min(measured.codePoints - 1, Math.floor(available * measured.codePoints / Math.max(1, measured.tokens)))
  let preview = minimum
  while (retained > 0) {
    const [head, tail] = headAndTail(block.text, retained)
    const text = head + '\n…\n' + tail
    preview = json ? jsonEnvelope(text) : text
    if (estimateTokens(preview) <= maxTokens) break
    retained = Math.floor(retained * 0.9)
    preview = minimum
  }
  return preview ? { ...block, text: preview } : null
}

function budgetNote({ maxTokens, originalTokens, keptTokens, omittedBlocks, minimumOverheadTokens = null }) {
  return note(`Text budget ~${maxTokens}: kept ~${keptTokens} of ~${originalTokens} tokens; omitted ${omittedBlocks} text blocks. ` +
    'Excludes image, structuredContent and resource blocks. Narrow the query to retrieve omitted content.' +
    (minimumOverheadTokens == null ? '' : ` Minimum envelope/metadata overhead ~${minimumOverheadTokens} tokens exceeds the requested budget.`))
}

function applyTextBudget(result, textBlocks, measured, maxTokens) {
  const originalTokens = measured.reduce((total, item) => total + item.tokens, 0)
  if (originalTokens <= maxTokens) return result
  const primaryJson = isJsonText(textBlocks[0].text)
  const emptyEnvelope = jsonEnvelope('')
  const requiredEnvelope = primaryJson
    ? (measured[0].tokens <= estimateTokens(emptyEnvelope) ? textBlocks[0] : { ...textBlocks[0], text: emptyEnvelope })
    : null
  const requiredTokens = requiredEnvelope ? estimateTokens(requiredEnvelope.text) : 0
  const noteArguments = { maxTokens, originalTokens, keptTokens: originalTokens, omittedBlocks: textBlocks.length }
  const reservedTokens = estimateTokens(budgetNote(noteArguments).text)
  const replacements = []
  let omittedBlocks = 0
  let keptTokens = 0
  let explanation
  if (maxTokens < reservedTokens + requiredTokens) {
    replacements.length = textBlocks.length
    replacements.fill(null)
    if (requiredEnvelope) replacements[0] = requiredEnvelope
    keptTokens = requiredTokens
    omittedBlocks = textBlocks.length - (requiredEnvelope ? 1 : 0)
    explanation = budgetNote({ maxTokens, originalTokens, keptTokens, omittedBlocks })
    let minimumOverheadTokens = requiredTokens + estimateTokens(explanation.text)
    if (minimumOverheadTokens > maxTokens) {
      for (;;) {
        explanation = budgetNote({ maxTokens, originalTokens, keptTokens, omittedBlocks, minimumOverheadTokens })
        const actual = requiredTokens + estimateTokens(explanation.text)
        if (actual === minimumOverheadTokens) break
        minimumOverheadTokens = actual
      }
    }
  } else {
    let remaining = maxTokens - reservedTokens
    for (let index = 0; index < textBlocks.length; index++) {
      const block = textBlocks[index]
      const replacement = remaining > 0 ? fitBlock(block, measured[index], remaining, index === 0 ? primaryJson : isJsonText(block.text)) : null
      replacements.push(replacement)
      if (!replacement) { omittedBlocks++; continue }
      const used = estimateTokens(replacement.text)
      keptTokens += used
      remaining -= used
    }
    explanation = budgetNote({ maxTokens, originalTokens, keptTokens, omittedBlocks })
  }
  const content = []
  let textIndex = 0
  for (const block of result.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const replacement = replacements[textIndex++]
      if (replacement) content.push(replacement)
    } else content.push(block)
  }
  content.push(explanation)
  result.content = content
  return result
}

/**
 * 在既有 MCP 结果 {content:[...]} 上为全部 text 块共享预算，优先保留靠前的块，并预留说明开销。
 * 超限 JSON 文本返回 {outputBudget:{truncated:true,originalFormat:'json'},previewText}，不返回损坏 JSON。
 * 其余块及 structuredContent 原样保留且不计入文本预算；极小预算在说明中标出最低实际开销。
 * 就地改并返回同一对象，从不抛。
 */
export function attachBudget(mcpResult, opts = {}, env = process.env) {
  try {
    if (!mcpResult || !Array.isArray(mcpResult.content)) return mcpResult
    const max = outputMaxTokens(opts, env)
    if (!max) return mcpResult
    const blocks = mcpResult.content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    if (!blocks.length) return mcpResult
    return applyTextBudget(mcpResult, blocks, blocks.map(block => measureText(block.text)), max)
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
