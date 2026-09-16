/**
 * W1 —— 把注册表（lib/tool-registry.mjs）的中性参数 spec 转成 MCP 侧的 zod raw shape。
 * 单列在 mcp/ 下：只有 MCP 进程加载 zod，DSH 插件路径不碰它。
 *
 * 忠实复现现有内联 zod 的写法（守卫按运行时 tools/list 逐字段比对，任何差异都会红）：
 *   基础：type 'boolean' → z.boolean()；有 enum → z.enum(values)；否则 z.string()
 *   有 mcpDefault → .default(x)（不再 .optional()）
 *   否则 required → 保持必填（不加 .optional()）
 *   否则 → .optional()
 *   en 非空 → .describe(en)（空串则不调，复现如 configuration 那种"有 default 无 describe"）
 */
import { z } from 'zod'
import { REGISTRY } from '../lib/tool-registry.mjs'

function zodOfParam(p) {
  let t = p.enum ? z.enum(p.enum) : (p.type === 'boolean' ? z.boolean() : z.string())
  if (p.mcpDefault !== undefined) t = t.default(p.mcpDefault)
  else if (!p.required) t = t.optional()
  if (p.en) t = t.describe(p.en)
  return t
}

/** 某工具的 MCP zod raw shape（{ paramName: zodType }）。 */
export function mcpShape(toolName) {
  const entry = REGISTRY[toolName]
  if (!entry) throw new Error('registry-zod: 未知工具 ' + toolName)
  const shape = {}
  for (const p of entry.params) shape[p.name] = zodOfParam(p)
  return shape
}
