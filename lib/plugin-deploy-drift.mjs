/**
 * 插件部署漂移检测 —— 「现网跑的那份，还是我改的这份吗？」
 *
 * 为什么需要它（2026-10-14 实测栽的一跤，真实代价约半小时）：
 *   DSH 宿主**不从仓库加载插件**，而是从 profile 目录加载磁盘副本：
 *     ~/.dsh/profiles/web/plugins/<name>/… 与 ~/.dsh/profiles/web/lib/…
 *   `scripts/deploy-plugins.mjs` 负责把仓库复制过去。于是存在**第三种"陈旧"**，
 *   而现有机制一个都盖不住：
 *     · `code-freshness`（lib/code-freshness.mjs）比的是 **进程 vs 磁盘**（宿主启动后文件被改过）；
 *     · `deploy-plugins --check` 比的是 **仓库 vs profile**，但它只在**人手动跑脚本**时才说话。
 *   实测场景：改完 `dsh-api-visualizer/lib/client.js` → 重启 DSH → 界面还是旧的。
 *   一查：profile 副本停在 10/8（183KB），仓库已是 10/14（204KB）——
 *   宿主重启一万次也不会加载一个根本不存在的文件。
 *
 * 两条**独立**信号（一硬一快，谁都别冒充谁）：
 *   · `scanDeployDrift()` —— **内容**判据（逐文件 sha256）：缺文件或内容不同即漂移。这是"漂移"的
 *     正式结论。为什么不看 mtime：Windows 的 copyFileSync 会**保留源文件 mtime**，部署后 profile
 *     里那份的 mtime 等于"仓库被编辑的时刻"，拿它判新鲜度会双向出错（见 code-freshness 注释）。
 *   · `sourceNewerThanDeploy()` —— **mtime + 部署戳**，成本近乎 0：`仓库最新源码 mtime > 部署时刻`
 *     ⇒ 部署之后又改过源码。它是**提醒**不是结论（touch 一下也会亮），但正好是"改了没部署"的形状。
 *
 * 同步集（与 deploy-plugins.mjs 必须保持一致 —— 本模块就是它抽出来的单一真源）：
 *   · `<root>/plugins/<name>/**` **排除**测试文件（测试进 profile 只会制造假故障，F-017 的邻居）；
 *   · `<root>/lib/**` 同样排除测试文件（共享模块是从 profile 根解析的）。
 *
 * 诚实边界：
 *   · "未漂移" = 两边**内容一致**，**不等于"宿主已经加载了它"**——宿主是长活进程，
 *     只有重启才会重新加载（这条由 code-freshness 与部署脚本的提示各自负责）。
 *   · "没比对上"（profile 不存在 / 读不到部署戳）一律 `compared:false`，**不许**当成绿灯。
 *   · 仓库根不在这里推导（模块保持纯粹、可测）：调用方给 root 与 profileDir。
 *   · 无关目录（profile 里有、仓库没有的第三方插件）不算漂移，也不回报。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 测试文件不进 profile：宿主不需要它们，而 profile 里缺 `mcp/` 会让它们必然失败。 */
const isTestFile = (p) => /\.test\.mjs$/i.test(p) || p.includes('\\test\\') || p.includes('/test/')

/** 仓库侧要同步进 profile 的同步集（deploy-plugins.mjs 的同步集，逐插件报告）。 */
export const SYNC_DIRS = ['plugins/*', 'lib']

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(p, out)
    else out.push(p)
  }
  return out
}

const sha256Of = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * 回报里的相对路径统一用 `/`：Windows 的 `relative()` 给的是 `lib\deep.mjs`，
 * 而这份报告会被 agent 读、被测试断言、还可能被贴进 issue —— 平台无关写法更稳。
 */
const relPosix = (from, to) => relative(from, to).split('\\').join('/')

/**
 * 把带 `/*` 的同步单元展开成逐个目录（`plugins/*` → 每个插件一行）。
 * 逐插件报告是刻意的：只说"plugins 目录漂移了"，用的人还得自己猜是哪一个。
 */
export function expandUnits(root, units = SYNC_DIRS) {
  const out = []
  for (const rel of units) {
    if (!rel.endsWith('/*')) { out.push(rel); continue }
    const parent = join(root, rel.slice(0, -2))
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(rel.slice(0, -1) + entry.name)
    }
  }
  return out
}

/**
 * 比对**一个**同步单元（`<root>/<rel>` 对 `<profileDir>/<rel>`）。
 * @returns {{rel: string, state: 'missing'|'in-sync'|'drift', checked: number,
 *            missingFiles: string[], changedFiles: string[], reason?: string}}
 */
export function compareSyncUnit({ root, profileDir, rel }) {
  const src = join(root, rel)
  const dst = join(profileDir, rel)
  // 仓库侧都没有这个单元 ⇒ 这一项**没查**，如实报"没查"，不报 in-sync
  if (!existsSync(src)) return { rel, state: 'missing', checked: 0, missingFiles: [], changedFiles: [], reason: '仓库里没有 ' + rel }
  const files = listFiles(src).filter((f) => !isTestFile(f))
  const missingFiles = []
  const changedFiles = []
  for (const f of files) {
    const rf = relPosix(src, f)
    const df = join(dst, rf)
    if (!existsSync(df)) missingFiles.push(rf)
    else if (sha256Of(f) !== sha256Of(df)) changedFiles.push(rf)
  }
  const drift = missingFiles.length > 0 || changedFiles.length > 0
  return { rel, state: drift ? 'drift' : 'in-sync', checked: files.length, missingFiles, changedFiles }
}

/**
 * 扫描整个 profile 的部署漂移。默认只看 `plugins` 与 `lib` 两个单元。
 * @returns {{profileDir: string, units: Array<object>, driftedUnits: string[],
 *            missing: number, changed: number, stale: boolean, note: string}}
 */
export function scanDeployDrift({ root, profileDir, units = SYNC_DIRS } = {}) {
  const out = { profileDir, units: [], driftedUnits: [], missing: 0, changed: 0, stale: false, compared: false, note: '' }
  if (!profileDir || !existsSync(profileDir)) {
    // compared=false 是**关键**：没比对 ≠ 没漂移。调用方必须能区分这两件事，
    // 否则会印出一个"✓ 一切正常"，而真相是"这次什么都没查"。
    out.note = 'profile 目录不存在：' + (profileDir || '(未指定)') + ' —— 未做比对（这不等于"没有漂移"）'
    return out
  }
  out.compared = true
  for (const rel of expandUnits(root, units)) {
    const unit = compareSyncUnit({ root, profileDir, rel })
    out.units.push(unit)
    out.missing += unit.missingFiles.length
    out.changed += unit.changedFiles.length
    if (unit.state === 'drift') out.driftedUnits.push(rel)
  }
  out.stale = out.driftedUnits.length > 0
  out.note = out.stale
    ? 'profile 副本落后于仓库：' + out.driftedUnits.join('、') + `（缺 ${out.missing} 个文件 / 改 ${out.changed} 个）`
    : (out.units.some((u) => u.state === 'missing')
      ? '有同步单元在仓库里不存在，本次没比对上（不等于没有漂移）'
      : '仓库与 profile 副本内容一致（注：这只说明**磁盘一致**，运行中的宿主仍需重启才会加载）')
  return out
}

/** profile 目录的默认位置（与 deploy-plugins.mjs 同一套推导，不写死机器路径）。 */
export function defaultProfileDir(env = process.env, homedir = '') {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR
  const home = env.DSH_HOME || (homedir ? join(homedir, '.dsh') : '')
  return home ? join(home, 'profiles', 'web') : ''
}

/** 部署戳（deploy-plugins.mjs 写）——用来判断"上次部署是什么时候"，读不到就说读不到。 */
export function readDeployStamp(profileDir) {
  const file = join(profileDir || '', '.dsh-toolchain-deploy.json')
  try {
    if (!existsSync(file)) return { file, found: false, stamp: null }
    return { file, found: true, stamp: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { file, found: true, stamp: null, error: e.message }
  }
}

/** mtime 只用于给人看的"最近改动"，不参与判定。 */
export function newestMtime(root, units = SYNC_DIRS) {
  let newest = 0
  let which = ''
  for (const rel of expandUnits(root, units)) {
    const dir = join(root, rel)
    if (!existsSync(dir)) continue
    for (const f of listFiles(dir)) {
      if (isTestFile(f)) continue
      try {
        const t = statSync(f).mtimeMs
        if (t > newest) { newest = t; which = relPosix(root, f) }
      } catch { /* 读不到就跳过这个文件，不影响判定 */ }
    }
  }
  return { newestMs: newest, file: which }
}

/**
 * 「源码比上次部署新吗」—— 与内容漂移**互补**的一条独立信号。
 *
 * 为什么还要它：内容漂移要逐文件哈希（一次全仓比对约 1~2 秒），而这条只看 mtime 与部署戳，
 * 成本近乎 0，可以塞进高频路径。更关键的是它**正对症**：2026-10-14 那次栽的是
 * 「改完源码 → 没跑部署 → 重启宿主 → 界面还是旧的」，而那份副本是 6 天前的、内容也早就不同，
 * 两条信号都会亮 —— 但只有这条能在**完全不读文件内容**的前提下先说一句"你可能忘了部署"。
 *
 * 判据：`仓库里最新的源文件 mtime > 部署戳时刻` ⇒ 部署之后又改过源码。
 * 边界（刻意写清）：
 *   · 它**不证明内容不同**（改完又改回来、或只是 touch 一下，也会亮）—— 所以它是"提醒"，
 *     不是"漂移结论"；内容判定仍以逐文件哈希为准。
 *   · 没有部署戳 ⇒ 返回 compared=false（**不是** false=不陈旧）：没戳就没法比，不许当绿灯。
 */
export function sourceNewerThanDeploy({ root, profileDir, units = SYNC_DIRS } = {}) {
  const { stamp, found, error } = readDeployStamp(profileDir)
  if (!found || !stamp || !Number.isFinite(Number(stamp.atMs))) {
    return { compared: false, stale: false, newestMs: 0, file: '', deployedAtMs: null, error: error || '', note: '读不到部署戳，无法判断"源码是否比上次部署新"（这不等于"源码不比副本新"）' }
  }
  const newest = newestMtime(root, units)
  const deployedAtMs = Number(stamp.atMs)
  const stale = newest.newestMs > deployedAtMs
  return {
    compared: true,
    stale,
    newestMs: newest.newestMs,
    file: newest.file,
    deployedAtMs,
    error: '',
    note: stale
      ? `仓库源码比上次部署新：${newest.file}（改于 ${new Date(newest.newestMs).toISOString()}）晚于部署时刻 ${new Date(deployedAtMs).toISOString()} —— 大概率**还没部署**`
      : '仓库源码不比上次部署新（mtime 判据；内容是否有差异以逐文件比对为准）',
  }
}
