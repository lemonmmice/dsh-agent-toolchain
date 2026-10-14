/**
 * lib/result-completeness.mjs —— 工具结果「完整性」的**单一归一化口径**（F04）。
 *
 * 背景：任务裁决（task-tool-support → task-service）与输出预算封套（output-budget）原先各自
 * 判「这次做完没有」，而且口径都不全：
 *   · task-tool-support 的 outcome() 只认 MCP content 封套里第一段 text 的 JSON，纯对象（DSH 业务结果，
 *     如 memory_index 直接返回 {indexed,stoppedBy,remainingFiles,...}）**原样返回、不判完整性** ⇒
 *     stoppedBy=budget / remainingFiles>0 的"部分成功"被当成 complete。
 *   · output-budget 截断 JSON 时，封套只保留 state/errorCode 等，**丢掉 incomplete/stoppedBy/failedFiles**，
 *     于是"截断后把 incomplete 悄悄变成 complete"。
 *
 * 这里把二者收敛成一份：任意工具结果（MCP 封套或纯对象）→ 统一的 { ok, unknown, incomplete, cancelled }。
 * 判「未完成」的信号（任一成立即 incomplete）：
 *   incomplete===true | deferred===true | stoppedBy 非空且非 'done'
 *   | remaining/remainingFiles/remainingCount/deferredFiles/failedFiles 任一有量。
 * 「普通成功的进程结束」(stoppedBy==='done'、无剩余) 与「全部工作完成」被明确区分。
 */

/** 把"剩余量"字段折算成非负数：数组按长度、有限数字按值、其余按 0。 */
function amount(value) {
  if (Array.isArray(value)) return value.length
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 从单个业务 payload 对象推断完整性标志（不解析 MCP 封套）。非对象一律按"完整成功"处理。 */
export function classifyPayload(payload) {
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const stoppedBy = typeof obj.stoppedBy === 'string' ? obj.stoppedBy.trim() : ''
  const stopped = stoppedBy !== '' && stoppedBy.toLowerCase() !== 'done'
  const pending = amount(obj.remaining) + amount(obj.remainingFiles) + amount(obj.remainingCount) +
    amount(obj.deferredFiles) + amount(obj.failedFiles)
  const incomplete = obj.incomplete === true || obj.deferred === true || stopped || pending > 0
  return { ok: obj.ok !== false, unknown: obj.unknown === true, incomplete, cancelled: obj.cancelled === true }
}

/** 解析 MCP content 里第一段 text 的 JSON（没有/坏 JSON 返回 null）。 */
export function parseMcpPayload(value) {
  if (!Array.isArray(value?.content)) return null
  const block = value.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
  if (!block) return null
  try { return JSON.parse(block.text) } catch { return null }
}

/**
 * 归一化任意工具结果 → { ok, unknown, incomplete, cancelled }。
 * MCP 封套：解析第一段 text 判业务字段，并叠加封套级 isError（isError===true ⇒ ok:false）。
 * 纯对象：直接判业务字段。
 */
export function classifyResult(value) {
  if (Array.isArray(value?.content)) {
    const flags = classifyPayload(parseMcpPayload(value))
    return { ...flags, ok: value.isError !== true && flags.ok }
  }
  return classifyPayload(value)
}
