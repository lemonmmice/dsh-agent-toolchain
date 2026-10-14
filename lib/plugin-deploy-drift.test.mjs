// lib/plugin-deploy-drift.mjs 单测 —— 「现网跑的那份，还是我改的这份吗？」
//
// 为什么值得单独钉：2026-10-14 实测栽过一跤（改完插件 → 重启 DSH → 界面还是旧的），
// 根因是 profile 里的部署副本停在 6 天前。现有两个机制都盖不住这一格：
//   · code-freshness 比的是「进程 vs 磁盘」；
//   · deploy-plugins --check 比的是「仓库 vs profile」，但只在你手动跑脚本时才说话。
//
// 断言分三层：① 判据本身（内容相同 → in-sync；差一个字节/缺文件 → drift）；
// ② 同步集展开（plugins/* 逐插件报告）；③ 诚实边界（profile 不存在 / 读不到 ≠ 没漂移）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanDeployDrift, compareSyncUnit, expandUnits, defaultProfileDir, readDeployStamp, newestMtime, sourceNewerThanDeploy, SYNC_DIRS,
} from './plugin-deploy-drift.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const write = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text) }
const tmp = mkdtempSync(join(tmpdir(), 'deploy-drift-'))

// 造一个假仓库 + 假 profile
const root = join(tmp, 'repo')
write(join(root, 'plugins', 'dsh-alpha', 'index.js'), 'alpha v1\n')
write(join(root, 'plugins', 'dsh-alpha', 'lib', 'deep.mjs'), 'deep v1\n')
write(join(root, 'plugins', 'dsh-alpha', 'test', 'x.test.mjs'), 'test file\n')
write(join(root, 'plugins', 'dsh-beta', 'index.js'), 'beta v1\n')
write(join(root, 'lib', 'shared.mjs'), 'shared v1\n')
write(join(root, 'lib', 'shared.test.mjs'), 'test file\n')

const profile = join(tmp, 'profile')
/** 把仓库那几个文件复制进 profile（模拟"部署过"）。 */
const deployAll = () => {
  for (const rel of ['plugins/dsh-alpha/index.js', 'plugins/dsh-alpha/lib/deep.mjs', 'plugins/dsh-beta/index.js', 'lib/shared.mjs']) {
    write(join(profile, rel), readFileSync(join(root, rel), 'utf8'))
  }
}

// ---------------------------------------------------------------- 1. 一致 → in-sync
deployAll()
{
  const r = scanDeployDrift({ root, profileDir: profile })
  check('仓库与 profile 一致 → not stale', r.stale === false && r.driftedUnits.length === 0, JSON.stringify(r.driftedUnits))
  check('逐插件展开：3 个同步单元都报 in-sync', r.units.length === 3 && r.units.every((u) => u.state === 'in-sync'), r.units.map((u) => u.rel + '=' + u.state).join(','))
  check('测试文件不参与同步（它们不该进 profile）', r.units.every((u) => !u.missingFiles.some((f) => f.endsWith('.test.mjs'))))
  check('"一致"的措辞不越界（只说磁盘一致，提醒仍需重启）', /仍需重启/.test(r.note), r.note)
}

// ---------------------------------------------------------------- 2. 内容改了 → drift（核心判据）
{
  write(join(root, 'plugins', 'dsh-alpha', 'lib', 'deep.mjs'), 'deep v2 — 改了一个字\n')
  const r = scanDeployDrift({ root, profileDir: profile })
  check('★ 仓库里改一个字节 → 该插件报 drift（这就是"改了没生效"的形状）', r.stale === true && r.driftedUnits.includes('plugins/dsh-alpha'), JSON.stringify(r.driftedUnits))
  check('未改动的插件仍报 in-sync（不因为别的插件漂了就一起报）', r.units.find((u) => u.rel === 'plugins/dsh-beta')?.state === 'in-sync')
  check('回报里点名具体是哪个文件变了', r.units.find((u) => u.rel === 'plugins/dsh-alpha')?.changedFiles.join(',') === 'lib/deep.mjs', JSON.stringify(r.units.find((u) => u.rel === 'plugins/dsh-alpha')?.changedFiles))
  check('摘要含"落后于仓库"与计数', /落后于仓库/.test(r.note) && r.changed === 1 && r.missing === 0, r.note)
  deployAll() // 复原
}

// ---------------------------------------------------------------- 3. 缺文件 → drift
{
  rmSync(join(profile, 'plugins', 'dsh-beta', 'index.js'))
  const r = scanDeployDrift({ root, profileDir: profile })
  check('副本缺一个文件 → 报 drift 且列入 missingFiles', r.units.find((u) => u.rel === 'plugins/dsh-beta')?.missingFiles.join(',') === 'index.js', JSON.stringify(r.units.find((u) => u.rel === 'plugins/dsh-beta')))
  deployAll()
}

// ---------------------------------------------------------------- 4. 新增插件（仓库有、副本整个没有）
{
  write(join(root, 'plugins', 'dsh-gamma', 'index.js'), 'gamma v1\n')
  const r = scanDeployDrift({ root, profileDir: profile })
  check('仓库新增插件、副本整个没有 → 报 drift（整目录缺）', r.driftedUnits.includes('plugins/dsh-gamma'), JSON.stringify(r.driftedUnits))
  check('新插件的缺失文件数 = 它的文件数', r.units.find((u) => u.rel === 'plugins/dsh-gamma')?.missingFiles.length === 1)
  rmSync(join(root, 'plugins', 'dsh-gamma'), { recursive: true })
}

// ---------------------------------------------------------------- 5. mtime 不参与判定（copyFileSync 会保留源 mtime）
{
  // 把 profile 副本的 mtime 改成"比仓库旧很多"，内容一致 → 仍必须 in-sync
  const dst = join(profile, 'lib', 'shared.mjs')
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(dst, old, old)
  const r = scanDeployDrift({ root, profileDir: profile, units: ['lib'] })
  check('mtime 差 6 年但内容相同 → in-sync（判据是内容，不是时间戳）', r.stale === false, JSON.stringify(r.units[0]))
  const nm = newestMtime(root, ['lib'])
  check('newestMtime 仍能给出"最近改动"给人看（不参与判定）', nm.newestMs > 0 && nm.file.includes('shared.mjs'), JSON.stringify(nm))
}

// ---------------------------------------------------------------- 6. 诚实边界
{
  const r = scanDeployDrift({ root, profileDir: join(tmp, 'nope') })
  check('profile 目录不存在 → 明说"未做比对"，不报"没有漂移"', r.stale === false && /未做比对/.test(r.note) && /不等于/.test(r.note), r.note)
  const r2 = scanDeployDrift({ root, profileDir: '' })
  check('profileDir 没给 → 同样只说"未做比对"', /未做比对/.test(r2.note))
  const u = compareSyncUnit({ root, profileDir: profile, rel: 'lib/does-not-exist' })
  check('同步单元在仓库里不存在 → state=missing + 原因（不当成 in-sync）', u.state === 'missing' && /仓库里没有/.test(u.reason), JSON.stringify(u))
  check('SYNC_DIRS 用的是逐插件通配（不是一整个 plugins 目录）', SYNC_DIRS.includes('plugins/*') && SYNC_DIRS.includes('lib'))
  const ex = expandUnits(root, SYNC_DIRS)
  check('expandUnits 把 plugins/* 展开成逐个插件目录', ex.includes('plugins/dsh-alpha') && ex.includes('plugins/dsh-beta') && !ex.includes('plugins/*'), ex.join(','))
}

// ---------------------------------------------------------------- 7. 部署戳 / 默认目录
{
  write(join(profile, '.dsh-toolchain-deploy.json'), JSON.stringify({ at: 'x', atMs: 123, count: 9 }))
  const s = readDeployStamp(profile)
  check('能读到部署戳', s.found === true && s.stamp?.atMs === 123)
  const none = readDeployStamp(join(tmp, 'nope'))
  check('没有部署戳 → found=false（不抛错）', none.found === false && none.stamp === null)
  check('defaultProfileDir 优先 DSH_PROFILE_DIR', defaultProfileDir({ DSH_PROFILE_DIR: 'D:/x' }) === 'D:/x')
  check('defaultProfileDir 由 DSH_HOME 推导', defaultProfileDir({ DSH_HOME: 'D:/home' }).replace(/\\/g, '/') === 'D:/home/profiles/web')
  check('defaultProfileDir 全缺时返回空串（调用方自己决定怎么办）', defaultProfileDir({}) === '')
}

// ---------------------------------------------------------------- 8. 「源码比部署戳新」这条独立信号
{
  const repo2 = join(tmp, 'repo2')
  const profile2 = join(tmp, 'profile2')
  mkdirSync(profile2, { recursive: true })
  write(join(repo2, 'plugins', 'dsh-zz', 'index.js'), 'v1\n')
  const stampFile = join(profile2, '.dsh-toolchain-deploy.json')
  const srcFile = join(repo2, 'plugins', 'dsh-zz', 'index.js')

  // 没有部署戳 ⇒ compared=false（不许当绿灯）
  let r = sourceNewerThanDeploy({ root: repo2, profileDir: profile2 })
  check('没有部署戳 → compared=false（"没得比" ≠ "不比副本新"）', r.compared === false && r.stale === false && /不等于/.test(r.note), JSON.stringify(r))

  // 部署戳比源码新 ⇒ 不陈旧
  const now = Date.now()
  write(stampFile, JSON.stringify({ atMs: now + 60_000, count: 1 }))
  r = sourceNewerThanDeploy({ root: repo2, profileDir: profile2 })
  check('部署戳晚于源码 mtime → compared=true 且不报陈旧', r.compared === true && r.stale === false, JSON.stringify(r))

  // 部署之后又改了源码（把 mtime 往后挪）⇒ 必须报陈旧并点名文件
  const later = new Date(now + 120_000)
  utimesSync(srcFile, later, later)
  r = sourceNewerThanDeploy({ root: repo2, profileDir: profile2 })
  check('★ 部署之后又改了源码 → 报陈旧并点名文件（这就是"改了没生效"的第一信号）',
    r.compared === true && r.stale === true && r.file.includes('dsh-zz'), JSON.stringify(r))
  check('措辞点明"大概率还没部署"，且不越界成"内容一定不同"', /还没部署/.test(r.note) && !/内容一定/.test(r.note), r.note)

  // 部署戳坏掉（JSON 解不开）⇒ 如实说读不到
  write(stampFile, '{ 坏掉的 json')
  r = sourceNewerThanDeploy({ root: repo2, profileDir: profile2 })
  check('部署戳损坏 → compared=false + 带原因（不抛错、不当绿灯）', r.compared === false && r.error.length > 0, JSON.stringify(r))
}

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nplugin-deploy-drift：${failures} 项未通过`)
  process.exit(1)
}
console.log('\nplugin-deploy-drift：全部通过')
