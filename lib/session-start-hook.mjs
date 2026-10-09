/**
 * lib/session-start-hook.mjs —— SessionStart 钩子：在 .NET 桌面仓库里开会话时，用几行字告诉 agent
 * 工具链接入了什么、UI/性能工具**作用在哪个进程上**、它和当前目录对不对得上。
 *
 * 为什么要有：本机配置是全局的（目标进程、源码根），而人会在不同仓库之间切换。配置指向 A 客户端、
 * 会话却开在 B 仓库时，ui_* / perf_* / hang_* 会照样作用到 A 上 —— 这件事 agent 自己看不出来。
 *
 * 只读、快：只看环境变量与本机配置文件（不查注册表、不探测进程），不相关的目录静默。
 */
import { readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { envFilePath, readEnvFile } from './toolchain-env-file.mjs'
import { envValues } from './env-fallback.mjs'

const ROOT_KEYS = ['DSH_BUILD_REPO_ROOT', 'DSH_BUILD_CLIENT_ROOT', 'DSH_API_SRC_ROOT', 'DSH_HANG_SRC_ROOT', 'DSH_PERF_SRC_ROOT']
const SOLUTION_RE = /\.(sln|slnx|csproj)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'packages', '.vs'])

const norm = (p) => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const inside = (child, parent) => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** cwd 往下 maxDepth 层内有没有 .sln/.slnx/.csproj（有界扫描）。 */
export function looksLikeDotnetRepo(cwd, maxDepth = 3, budget = { left: 400 }) {
  let entries
  try { entries = readdirSync(cwd, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (--budget.left <= 0) return false
    if (e.isFile() && SOLUTION_RE.test(e.name)) return true
  }
  if (maxDepth <= 0) return false
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
    if (looksLikeDotnetRepo(join(cwd, e.name), maxDepth - 1, budget)) return true
    if (budget.left <= 0) return false
  }
  return false
}

/**
 * 本机配置文件 > 进程环境 > 用户/机器环境变量（注册表），与 mcp/launch.mjs 的口径一致 ——
 * 这里报的目标必须就是 MCP server 实际会作用的那个进程。
 * 必须经 env-fallback 读（lib/config-discipline.test.mjs 的纪律）：钩子进程继承的是宿主启动时的环境块，
 * 用户之后才配进注册表的值它看不见 —— 直接读 process.env 会把"配了"说成"未配置"。
 */
function effectiveConfig(env, exec) {
  const file = readEnvFile(envFilePath(env))
  const merged = { ...env, ...file.values }
  const vals = envValues([...ROOT_KEYS, 'DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE'], { env: merged, ...(exec ? { exec } : {}) })
  return { file, get: (k) => (vals[k] && vals[k].value) || undefined }
}

export function buildSessionContext({ cwd, env = process.env, exec }) {
  if (!cwd) return null
  const { file, get } = effectiveConfig(env, exec)
  const roots = ROOT_KEYS.map((k) => get(k)).filter(Boolean)
  const inConfiguredRoot = roots.some((r) => inside(cwd, r))
  if (!inConfiguredRoot && !looksLikeDotnetRepo(cwd)) return null

  const proc = get('DSH_UI_PROC_NAME')
  const exe = get('DSH_UI_CLIENT_EXE')
  const lines = ['dsh-agent-toolchain 已接入：构建与编译集（build_*）、桌面 UI（ui_*）、抓包（capture_*）、性能与卡死（perf_* / hang_*）、收尾裁决（verify_report）。拿不准环境时先调 toolchain_status。']
  if (proc || exe) {
    lines.push(`UI/性能工具的目标进程：${proc || '（按 exe 推断）'}${exe ? `（${exe}）` : ''}` + (roots.length ? `；已配置的源码根：${[...new Set(roots)].join('、')}` : '') + '。')
    if (roots.length && !inConfiguredRoot) {
      lines.push('⚠ 当前会话目录不在已配置的源码根内 —— ui_* / perf_* / hang_* 会作用在上面那个进程上，而不是本仓库的客户端；动手前先向用户确认，或让用户改本机配置（' + file.path + '）。')
    }
  } else {
    lines.push('UI/性能工具的目标进程未配置（DSH_UI_PROC_NAME / DSH_UI_CLIENT_EXE，可写在 ' + file.path + '）；构建、编译集检查与收尾裁决不受影响。')
  }
  if (file.error) lines.push('⚠ 本机配置文件无法使用：' + file.error)
  lines.push('收尾规则：本回合改了代码却没调用 verify_report 时，Stop 钩子会拦一次（DSH_STOP_GATE=warn 只提醒，off 关闭）。')
  return lines.join('\n')
}

/** 钩子入口：原始 stdin → 输出对象或 null。永不抛。 */
export function runSessionStartHook(rawInput, env = process.env) {
  try {
    const input = JSON.parse(String(rawInput || '{}'))
    const ctx = buildSessionContext({ cwd: input.cwd, env })
    return ctx ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } } : null
  } catch {
    return null
  }
}
