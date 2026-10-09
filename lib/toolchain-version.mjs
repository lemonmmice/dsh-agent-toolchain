/**
 * lib/toolchain-version.mjs —「是哪一版工具链产生的这条记录」。
 *
 * 为什么要有（2026-10）：失败库里 89 条 agent-misjudge 有 42 条后来被撤回，典型如 F-023 ——
 * 是 verify_report 自己的 `kind=file` 相对路径缺陷把真话判成了假话，账却记在 agent 头上。
 * 裁决器修好之后，想"把那几版裁决器产出的记录一起撤回"，前提是每条记录都知道自己出自哪一版。
 *
 * 只读文件、不起 git 子进程（这个函数会在失败路径上被调用，不能慢、不能抛）：
 *   version —— 仓库根 package.json 的 version；
 *   sha     —— .git/HEAD 指向的提交前 12 位；拿不到（插件缓存副本没有 .git、HEAD 是坏的）就**不给**，
 *              绝不猜。注意它说的是"已提交的那一版"，工作区里没提交的改动它看不见。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let cached = null

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

/** `.git` 可能是目录（普通 checkout）也可能是文件（worktree：`gitdir: <path>`）。 */
function gitDirOf(root) {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return null
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotGit) ?? '')
    return m ? resolve(root, m[1].trim()) : null
  } catch { return null }
}

/** worktree 的 refs 在公共目录里（commondir 指过去）。 */
function commonDirOf(gitDir) {
  const rel = (readText(join(gitDir, 'commondir')) ?? '').trim()
  return rel ? resolve(gitDir, rel) : gitDir
}

export function readHeadSha(root = ROOT) {
  const gitDir = gitDirOf(root)
  if (!gitDir) return null
  const head = (readText(join(gitDir, 'HEAD')) ?? '').trim()
  if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase()
  const m = /^ref:\s*(\S+)$/.exec(head)
  if (!m) return null
  const ref = m[1]
  for (const dir of [gitDir, commonDirOf(gitDir)]) {
    const loose = (readText(join(dir, ref)) ?? '').trim()
    if (/^[0-9a-f]{40}$/i.test(loose)) return loose.toLowerCase()
  }
  const packed = readText(join(commonDirOf(gitDir), 'packed-refs')) ?? ''
  for (const line of packed.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/)
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha ?? '')) return sha.toLowerCase()
  }
  return null
}

/** `{ version, sha? }`；进程内缓存一次（同一进程里代码版本不会变）。 */
export function toolchainVersion() {
  if (cached) return cached
  let version = null
  let ownPackage = false
  try {
    const pkg = JSON.parse(readText(join(ROOT, 'package.json')) ?? '{}')
    ownPackage = pkg.name === 'dsh-agent-toolchain'
    if (ownPackage && typeof pkg.version === 'string') version = pkg.version
  } catch { version = null }
  if (!ownPackage) {
    try {
      const stamp = JSON.parse(readText(join(ROOT, '.dsh-toolchain-deploy.json')) ?? '{}')
      if (typeof stamp.version === 'string' && /^[0-9a-f]{12}$/i.test(stamp.sha) && typeof stamp.dirty === 'boolean') {
        cached = { version: stamp.version, sha: stamp.sha.toLowerCase(), dirty: stamp.dirty, source: 'deploy-stamp' }
        return cached
      }
    } catch { version = null }
    cached = { version: null }
    return cached
  }
  const sha = readHeadSha(ROOT)
  cached = { version, ...(sha ? { sha: sha.slice(0, 12) } : {}) }
  return cached
}
