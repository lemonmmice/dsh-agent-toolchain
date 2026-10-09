/**
 * lib/compile-check-hook.mjs —— PostToolUse 钩子：写/改了 .cs/.vb/.fs 之后，立刻核对它在不在编译集里。
 *
 * 为什么要有：legacy .csproj 不会自动包含新文件，漏写 `<Compile Include>` 时**构建 0 错误、文件根本没编**
 * —— 这是本仓 README 头一条点名的陷阱，而 agent 通常要到最后（甚至永远）才发现。
 * 这里在写文件的那一刻就用 build_compile_check 同款判定（lib/compile-membership.mjs）核一次：
 *   能证明"不在"才提醒（additionalContext 给 agent 看）；在、判不了、找不到工程 —— 一律静默。
 * 同一会话同一文件只提醒一次（状态放系统临时目录），避免反复刷屏。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { checkCompileMembership } from './compile-membership.mjs'

const SOURCE_RE = /\.(cs|vb|fs)$/i
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/** 往上找 .git 所在目录作为 repoRoot（跨目录 include 的扫描边界）；找不到就 null。 */
export function gitRootOf(file) {
  let dir = dirname(resolve(file))
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function stateFile(sessionId, stateDir) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_').slice(0, 80)
  return join(stateDir, `compile-check-${safe}.json`)
}

function alreadyWarned(sessionId, file, stateDir) {
  try { return JSON.parse(readFileSync(stateFile(sessionId, stateDir), 'utf8')).includes(file) } catch { return false }
}

function markWarned(sessionId, file, stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true })
    let list = []
    try { list = JSON.parse(readFileSync(stateFile(sessionId, stateDir), 'utf8')) } catch { list = [] }
    if (!list.includes(file)) list.push(file)
    writeFileSync(stateFile(sessionId, stateDir), JSON.stringify(list.slice(-200)), 'utf8')
  } catch { /* 记不住就下次再提醒一次，无害 */ }
}

/** 钩子入口：原始 stdin → 输出对象或 null。永不抛。 */
export function runCompileCheckHook(rawInput, { check = checkCompileMembership, stateDir = join(tmpdir(), 'dsh-agent-toolchain-hooks') } = {}) {
  try {
    const input = JSON.parse(String(rawInput || '{}'))
    if (!EDIT_TOOLS.has(input.tool_name)) return null
    const file = input.tool_input && input.tool_input.file_path
    if (typeof file !== 'string' || !SOURCE_RE.test(file)) return null
    const abs = resolve(input.cwd || process.cwd(), file)
    if (alreadyWarned(input.session_id, abs, stateDir)) return null
    const v = check(abs, { repoRoot: gitRootOf(abs) ?? undefined })
    if (!v || v.ok !== true || v.included !== false) return null
    markWarned(input.session_id, abs, stateDir)
    const proj = v.project ? relative(gitRootOf(abs) ?? dirname(v.project), v.project) : null
    const rel = v.project ? relative(dirname(v.project), abs) : null
    const fix = v.project
      ? `需要在 ${proj} 里加 <Compile Include="${rel}" />（老式 csproj 不会自动包含新文件），否则构建 0 错误也编不到它。`
      : '仓库里没有任何工程把它列进编译。'
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠ dsh 编译集检查：${abs} 不在编译集里（${v.basis}）。${fix}（与 build_compile_check 同一判定；判不了时不会提醒。）`,
      },
    }
  } catch {
    return null
  }
}
