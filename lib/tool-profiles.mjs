/**
 * 工具 profile 分组 —— tools/list 按需精简加载（审计 L08 / 交互成本一节）。
 *
 * 56 个工具按名字前缀归到少数几个域（ui/build/perf/hang/memory/capture/failure）+ 一个 core
 * （状态、任务、验证、决策、通用 HTTP —— 任何 profile 都需要的基础设施）。
 *
 * 设 DSH_TOOL_PROFILE=ui,build 时只注册这些域 + core；**默认（未设）全开**，不支持动态发现的
 * 客户端完全不受影响（审计明确要求：不应在不支持动态列表的客户端上直接动态删工具）。
 * 收益是减少工具目录注入的 token（56 个工具紧凑 JSON 约 22–24k token 估算）。
 */

/** 工具名 → 所属域。无明确业务前缀的基础设施工具归 core。 */
export function toolGroup(name) {
  switch (String(name).split('_')[0]) {
    case 'ui': return 'ui'
    case 'build': return 'build'
    case 'dev': return 'dev'
    case 'perf': return 'perf'
    case 'hang': return 'hang'
    case 'memory': return 'memory'
    case 'capture': return 'capture'
    case 'failure': return 'failure'
    // core：基础设施，任何 profile 都在 —— 状态/任务/验证/决策/通用 HTTP。
    case 'http':
    case 'jev':
    case 'verify':
    case 'toolchain':
    default: return 'core'
  }
}

/** 解析 DSH_TOOL_PROFILE：逗号/空白分隔的域名集合；空/全空白 → null（全开）。 */
export function parseProfile(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!v) return null
  const set = new Set(v.split(/[,\s]+/).filter(Boolean))
  return set.size ? set : null
}

/** profileSet 为 null（全开）或 group 集合。core 恒放行；其余按 group 命中。 */
export function toolAllowed(name, profileSet) {
  if (!profileSet) return true
  const g = toolGroup(name)
  if (g === 'core') return true
  return profileSet.has(g)
}
