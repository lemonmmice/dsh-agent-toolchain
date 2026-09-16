/**
 * W5 —— 截图内联（inline screenshots）。见 CODEX-STEAL-ANALYSIS-20260916.md「第二部分」。
 *
 * 背景：UI 工具原本只在 JSON 里回一个磁盘路径（shot 的 workspacePath/path、ui_launch 的
 * uiState.screenshot），有视觉能力的 MCP 客户端还得再开一个"读图"工具才看得到界面。Codex 的
 * view_image 把图当成 image content block 直接交回模型。这里照抄那个形状：在既有 jtext() 文本
 * 结果之上**追加**一个 MCP image 内容块。
 *
 * 设计约束（贴合本仓既有规矩）：
 *   1) 默认关（env DSH_UI_INLINE_IMAGE 未开 → 零行为变化、零回归）；调用点可用 opts.enabled 显式覆盖。
 *   2) 不新增任何工具 schema 参数 —— 避免触碰 param-forwarding-completeness 等一致性守卫。
 *   3) 永不丢路径：无论内联成功还是跳过，原来的文本 JSON（含 path）都原样保留。
 *   4) 永不抛：图不存在 / 过大 / 读失败 → 追加一个说明性 text 块，绝不让截图问题改变工具结论。
 *   5) 失败结果（ok===false）不内联（截不到有效图时别塞垃圾）。
 */
import { readFileSync, statSync } from 'node:fs'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const DEFAULT_MAX_BYTES = 5_000_000

/** 是否开启：opts.enabled 显式优先；否则看 env（默认关）。 */
export function inlineEnabled(opts = {}, env = process.env) {
  if (typeof opts.enabled === 'boolean') return opts.enabled
  return TRUTHY.has(String(env.DSH_UI_INLINE_IMAGE ?? '').toLowerCase())
}

/** 上限字节（解码后原图大小）。默认 5MB；env DSH_UI_INLINE_IMAGE_MAXBYTES 可调。 */
export function inlineMaxBytes(opts = {}, env = process.env) {
  const v = Number(opts.maxBytes ?? env.DSH_UI_INLINE_IMAGE_MAXBYTES)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES
}

/**
 * 从驱动结果里挑出可内联的截图绝对路径（挑不到 → null）。
 * 只对成功结果、且确有图的动作生效：
 *   · shot / capture 动作 → workspacePath || path
 *   · ui_launch          → uiState.screenshot
 *   · 兜底               → screenshot 字段
 */
export function pickImagePath(r) {
  if (!r || typeof r !== 'object' || r.ok === false) return null
  const uiShot = r.uiState && typeof r.uiState === 'object' ? r.uiState.screenshot : null
  if (uiShot) return String(uiShot)
  if ((r.action === 'shot' || r.action === 'capture') && (r.workspacePath || r.path)) {
    return String(r.workspacePath || r.path)
  }
  if (typeof r.screenshot === 'string' && r.screenshot) return r.screenshot
  return null
}

function mimeOf(path) {
  const p = String(path).toLowerCase()
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

const noteBlock = (msg) => ({ type: 'text', text: '[inline-image] ' + msg })

/**
 * 读一张图 → { content: MCP image block } 或 { skip: 说明 }。读不了/过大都不抛。
 * 单独导出便于单测直接验证编码与封顶，不必经过完整 mcp 结果封装。
 */
export function readImageContent(absPath, maxBytes) {
  try {
    const size = statSync(absPath).size
    if (size > maxBytes) {
      return { skip: `screenshot ${absPath} is ${size}B > cap ${maxBytes}B; not inlined (open the path instead). Raise DSH_UI_INLINE_IMAGE_MAXBYTES to inline larger shots.` }
    }
    const data = readFileSync(absPath).toString('base64')
    return { content: { type: 'image', data, mimeType: mimeOf(absPath) } }
  } catch (e) {
    return { skip: `screenshot ${absPath} could not be read (${String((e && e.message) || e)}); path kept in the JSON above.` }
  }
}

/**
 * 在既有 MCP 结果（jtext()/text() 产物）上按需追加内联图。就地改 content 数组并返回同一对象，从不抛。
 * @param {{content: any[]}} mcpResult  jtext()/text() 的返回
 * @param {object} resultObj            驱动的原始结果对象（用于挑图路径）
 * @param {{enabled?: boolean, maxBytes?: number, imagePath?: string}} [opts]
 */
export function attachInlineImage(mcpResult, resultObj, opts = {}, env = process.env) {
  if (!mcpResult || !Array.isArray(mcpResult.content)) return mcpResult
  if (!inlineEnabled(opts, env)) return mcpResult
  const path = opts.imagePath || pickImagePath(resultObj)
  if (!path) return mcpResult
  const r = readImageContent(path, inlineMaxBytes(opts, env))
  if (r.content) mcpResult.content.push(r.content)
  else if (r.skip) mcpResult.content.push(noteBlock(r.skip))
  return mcpResult
}
