/**
 * lib/build-root.mjs —— 「本次构建的仓库根」的**单一解析口径**（F06）。
 *
 * 背景：资源互斥键（task-tool-support 的 taskResources）与实际构建（builder 的 build()）原先各自解析根目录，
 * 口径还不一样：
 *   · 资源键：args.repoRoot → DSH_BUILD_CLIENT_ROOT → cwd；
 *   · builder：opts.repoRoot → opts.clientRoot → DSH_BUILD_REPO_ROOT → DSH_BUILD_CLIENT_ROOT。
 * 结果：设了 DSH_BUILD_REPO_ROOT 时，一个任务省略 repoRoot、另一个显式传同一目录，会拿到**不同的锁键** ⇒
 * 两个实际目标相同的构建任务绕过互斥、并发跑（会互相污染 obj/bin）。
 *
 * 这里把解析收敛成一份，资源键与业务执行都调它，顺序与 builder 既有口径一致：
 *   本次调用 opts → builder 构造配置 cfg → DSH_BUILD_REPO_ROOT → DSH_BUILD_CLIENT_ROOT。
 * 都没有时返回 null（构建侧据此 fail-closed；锁键侧再退回 cwd，以仍能串行化"同目录、都没配"的调用）。
 *
 * R6：cfg 必须排在环境变量**之前**。原 makeBuilder 是「环境默认 → cfg 覆盖」，build() 读 c.repoRoot；
 *   若这里只按 opts → env 解析，就会让显式构造配置被全局环境盖过（makeBuilder({repoRoot:A}) 却用了 env 的 B）。
 *   因此 build()/锁都传入已解析的 builder 配置；任务层无 cfg 时退化为 opts → env（MCP 路径的 cfg 本就源自 env，一致）。
 */
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { envOr } from './env-fallback.mjs'

/**
 * 解析本次构建的仓库根；都没有则 null。
 * @param args 本次调用 opts（repoRoot / clientRoot）
 * @param cfg  builder 构造配置（repoRoot / clientRoot）；省略时只看 opts 与环境
 */
export function resolveBuildRoot(args = {}, cfg = {}) {
  return args.repoRoot || args.clientRoot || (cfg && (cfg.repoRoot || cfg.clientRoot)) ||
    envOr('DSH_BUILD_REPO_ROOT') || envOr('DSH_BUILD_CLIENT_ROOT') || null
}

/** 规范化路径身份（绝对化 + 解符号链接 + Windows 大小写归一），用于资源锁键比较。 */
export function canonicalPath(value) {
  let path = resolve(value)
  try { path = realpathSync.native(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return process.platform === 'win32' ? path.toLowerCase() : path
}
