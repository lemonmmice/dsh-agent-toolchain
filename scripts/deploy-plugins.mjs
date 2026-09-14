// scripts/deploy-plugins.mjs — copy the repo's plugins into a live DSH profile.
//
// The DSH host loads profile plugins from files on disk, so a repo edit is not
// live until it is copied into the profile and the plugin is reloaded (the web
// profile watches its cordis.patch.yml). This script is the supported way to do
// that copy: no absolute machine paths in the repo, target comes from an
// argument or DSH_PROFILE_DIR.
//
// Usage:
//   node scripts/deploy-plugins.mjs                       # default profile: $DSH_HOME/profiles/web
//   node scripts/deploy-plugins.mjs --profile <dir>       # explicit profile dir
//   node scripts/deploy-plugins.mjs --only dsh-ui-drive
//   node scripts/deploy-plugins.mjs --check               # dry run: report drift only
//
// Every repo plugin is deployed to <profile>/plugins/<name> (the same layout the
// profile's cordis.patch.yml references). npm-installed plugin packages under
// <profile>/node_modules are NOT touched — those are managed by `dsh plugin add`.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}
const check = argv.includes('--check')
const only = argOf('only')
const profileDir = argOf('profile') || process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web')

if (!existsSync(profileDir)) {
  console.error('profile dir not found: ' + profileDir)
  process.exit(2)
}

const pluginsRoot = join(root, 'plugins')
const targets = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => (only ? n === only : true))

const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function listFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else out.push(p)
    }
  }
  return out
}

/**
 * `lib/` 里只有**运行期模块**需要进 profile；`*.test.mjs` 是仓库侧的测试，同步过去只会出问题：
 * Codex 第八轮实测报了一个 `mcp/server.mjs` 的 ENOENT —— 它跑的是 profile 里的那份测试副本，
 * 而 `mcp/` **不在**同步集里（宿主不需要它），于是 `profile/lib/mcp-newtools.test.mjs`
 * 引用 `profile/mcp/server.mjs` 必然失败。测试文件进 profile 没有任何运行价值，只制造假故障。
 */
const isTestFile = (p) => /\.test\.mjs$/i.test(p) || p.includes('\\test\\') || p.includes('/test/')

let drift = 0
let copied = 0
for (const name of targets) {
  const src = join(pluginsRoot, name)
  const dst = join(profileDir, 'plugins', name)
  const files = listFiles(src)
  const missing = []
  const changed = []
  for (const f of files) {
    const rel = relative(src, f)
    const df = join(dst, rel)
    if (!existsSync(df)) missing.push(rel)
    else if (hashOf(f) !== hashOf(df)) changed.push(rel)
  }
  const status = missing.length === 0 && changed.length === 0 ? 'in sync' : 'drift'
  if (status === 'drift') drift++
  console.log(`${name.padEnd(28)} ${status}` + (missing.length ? ` missing=${missing.length}` : '') + (changed.length ? ` changed=${changed.length}` : ''))
  for (const m of missing.slice(0, 5)) console.log('    + ' + m)
  for (const c of changed.slice(0, 5)) console.log('    ~ ' + c)
  if (!check && status === 'drift') {
    mkdirSync(dst, { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
    copied++
  }
}

console.log(check ? `\nDRY RUN: ${drift} plugin(s) drifted` : `\nDEPLOYED: ${copied} plugin(s) updated into ${profileDir}`)

// ---------------------------------------------------------------------------
// F-017（2026-09-11 实测确证）：这段过去**只同步 `plugins/`，从不同步仓库根的 `lib/`**。
//
// 后果比"少复制几个文件"严重得多：`dsh-build` / `dsh-ui-drive` / `dsh-verify` 的
// 共享模块（`decode` / `build-resolve` / `failure-corpus` / `capture-store` / `verify/report`）
// 是**从 profile 根的 `lib/` 解析**的，而 `--check` 只看 plugins/，
// 于是脚本会报 **"0 plugin(s) drifted"——一份假的安全感**。
// 实测：仓库 `lib/verify/report.mjs` 288 行（09-09）vs profile 270 行（09-08），
// 差异里正包括两条"防绿卫兵"（`expect.min<1`、空测试 gate 模式），
// 而 `verify_report` 是整套工具链的**诚实兜底**——它自己被部署漏掉了。
// 更讽刺的是 MCP 面（`mcp/server.mjs`）import 的是**仓库那份**，于是同一个断言
// 在 DSH 面与 MCP 面会给出**相反**的结论。
//
// 现在：`lib/` 进同步集，且**独立报告**，让"共享模块漂移"这件事不可能再被 `0 drifted` 掩盖。
// ---------------------------------------------------------------------------
const sharedLib = join(root, 'lib')
if (existsSync(sharedLib)) {
  const dst = join(profileDir, 'lib')
  const files = listFiles(sharedLib).filter((f) => !isTestFile(f))
  const missing = []
  const changed = []
  for (const f of files) {
    const rel = relative(sharedLib, f)
    const df = join(dst, rel)
    if (!existsSync(df)) missing.push(rel)
    else if (hashOf(f) !== hashOf(df)) changed.push(rel)
  }
  // 过去同步过、现在不该在 profile 里的测试文件：如实列出来（不是 drift，但必须可见，
  // 否则"profile 里躺着一份坏掉的测试"这件事永远没人知道）。
  const stale = []
  for (const f of listFiles(sharedLib).filter(isTestFile)) {
    const rel = relative(sharedLib, f)
    if (existsSync(join(dst, rel))) stale.push(rel)
  }
  const status = missing.length === 0 && changed.length === 0 ? 'in sync' : 'drift'
  if (status === 'drift') drift++
  console.log(`${'lib (shared)'.padEnd(28)} ${status}` + (missing.length ? ` missing=${missing.length}` : '') + (changed.length ? ` changed=${changed.length}` : ''))
  for (const m of missing.slice(0, 8)) console.log('    + ' + m)
  for (const c of changed.slice(0, 8)) console.log('    ~ ' + c)
  if (stale.length) {
    console.log(`    ! profile 里残留 ${stale.length} 个测试文件（不该同步过去：它们引用未部署的 mcp/，跑起来必然 ENOENT）`)
    for (const s of stale.slice(0, 8)) console.log('      - ' + s)
  }
  if (!check) {
    mkdirSync(dst, { recursive: true })
    for (const f of files) {
      const rel = relative(sharedLib, f)
      const df = join(dst, rel)
      if (!existsSync(df) || hashOf(f) !== hashOf(df)) copyFileSync(f, df)
    }
    for (const s of stale) {
      try { rmSync(join(dst, s), { force: true }) } catch { /* best effort */ }
    }
    if (status === 'drift' || stale.length) copied++
  }
}

if (check) {
  console.log(drift
    ? `\nDRY RUN: ${drift} target(s) drifted（插件 + 共享 lib 合计）`
    : '\nDRY RUN: 0 drift（插件 + 共享 lib 都已同步）')
  // 明确提示"文件同步 ≠ 进程已加载"，避免把 0 drift 读成"修复已生效"。
  console.log('注意：同步的是**磁盘文件**。DSH 宿主与 MCP server 是长活进程，' +
    '不会热加载插件代码 —— 要让改动在现网生效必须重启它们（重启会中断正在用它们的会话）。')
} else {
  // 部署戳（Claude 第九轮 Q2）：Windows 的 copyFileSync 会**保留源文件 mtime**，
  // 于是 profile 里那份文件的 mtime 等于"仓库里被编辑的时刻"，不是部署时刻 ——
  // 「改码 → 重启宿主 → 再部署」这一序下，只按 mtime 判断新鲜度会**漏报**。
  // 这里落一个部署时刻，让 codeFreshness 有第二条独立判据（改的是**磁盘内容**比进程新）。
  // 只在真有文件变化时写：纯粹"跑一次没变化"不该让所有工具报"代码陈旧"。
  try {
    const stampFile = join(profileDir, '.dsh-toolchain-deploy.json')
    if (copied > 0 || existsSync(stampFile) === false) {
      writeFileSync(stampFile, JSON.stringify({
        at: new Date().toISOString(),
        atMs: Date.now(),
        target: profileDir,
        count: copied,
        note: 'deploy-plugins.mjs 写入：部署时刻（codeFreshness 的第二判据，用于免疫 CopyFileW 保留 mtime）',
      }, null, 2), 'utf8')
    }
  } catch (e) {
    console.log('（部署戳写入失败，不影响部署本身：' + e.message + '）')
  }
  console.log(`\nDEPLOYED: ${copied} target(s) updated into ${profileDir}` +
    (copied > 0 ? '\n⚠ 已写入磁盘，但**运行中的宿主不会热加载** —— 需要重启宿主才生效（会中断当前会话）。' : ''))
}
