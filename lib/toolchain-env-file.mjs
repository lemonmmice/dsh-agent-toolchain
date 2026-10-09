/**
 * lib/toolchain-env-file.mjs —— 本机配置文件（插件安装方式用）。
 *
 * 为什么要有：以前 MCP server 的本机配置（目标进程、源码根、证据目录、工具路径……）写在
 * `claude mcp add ... -e KEY=VALUE` 的那条注册里。改成插件分发后，插件清单是公共的、不能写本机路径，
 * 于是本机配置挪到一个文件里：默认 `~/.dsh-agent-toolchain/env.json`（`DSH_ENV_FILE` 可改路径，
 * 设为 `none` 关闭），内容是一个扁平对象 `{ "DSH_UI_PROC_NAME": "…", … }`。
 *
 * 规则：
 *   · 只接受 `DSH_` 开头的键、字符串值；`DSH_CRED_*`（凭据）一律拒收 —— 凭据继续放真正的环境变量；
 *   · 文件里的值**覆盖**继承来的进程环境：与旧的 MCP 注册 `env` 块同一语义（那一块就是覆盖宿主环境的）。
 *     2026-10 实测为什么必须这样：Windows 用户环境变量里配的是一个客户端（给 DSH 宿主用），
 *     MCP 注册里覆盖成了另一个；若改成"进程环境优先"，插件版会悄悄换成驱动用户环境变量里的那个客户端。
 *   · 优先级因此是：本文件 > 进程环境 > 用户/机器环境变量（env-fallback 的注册表回退）。
 *   · 文件不存在 = 没配置（正常）；文件坏了 = 如实报错，一个值都不套用。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const KEY_RE = /^DSH_[A-Z0-9_]+$/
const CRED_RE = /^DSH_CRED_/

/** 配置文件路径；`DSH_ENV_FILE=none` 时返回 null（关闭）。 */
export function envFilePath(env = process.env) {
  const v = env.DSH_ENV_FILE
  if (typeof v === 'string' && v.trim().toLowerCase() === 'none') return null
  return v || join(homedir(), '.dsh-agent-toolchain', 'env.json')
}

/** → { path, exists, values, rejected?, error? }；坏文件不返回任何值。 */
export function readEnvFile(path) {
  if (!path) return { path: null, exists: false, values: {}, disabled: true }
  if (!existsSync(path)) return { path, exists: false, values: {} }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return { path, exists: true, values: {}, error: 'env 文件不是合法 JSON：' + String(e.message ?? e).slice(0, 160) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, exists: true, values: {}, error: 'env 文件必须是一个 { "DSH_…": "…" } 对象' }
  }
  const values = {}
  const rejected = []
  for (const [k, v] of Object.entries(parsed)) {
    if (KEY_RE.test(k) && !CRED_RE.test(k) && typeof v === 'string') values[k] = v
    else rejected.push(k)
  }
  return { path, exists: true, values, ...(rejected.length ? { rejected } : {}) }
}

/**
 * 把文件里的值写进 env（覆盖同名的继承值）。
 * → { path, applied, overridden, rejected?, error? } —— 只报键名，不报值。
 */
export function applyEnvFile(env = process.env, { path = envFilePath(env) } = {}) {
  const r = readEnvFile(path)
  const applied = []
  const overridden = []
  for (const [k, v] of Object.entries(r.values)) {
    if (env[k] !== undefined && env[k] !== v) overridden.push(k)
    env[k] = v
    applied.push(k)
  }
  return { path: r.path, applied, overridden, ...(r.rejected ? { rejected: r.rejected } : {}), ...(r.error ? { error: r.error } : {}) }
}
