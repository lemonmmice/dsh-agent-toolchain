// F06 回归：构建资源键与实际构建根用**同一套**解析，互斥放在所有执行方式共用的一层；锁位置与 logsDir 脱钩。
//   (a) implicit(env) 与 explicit(repoRoot/clientRoot) 指向同一目录时，解析结果与锁键一致。
//   (R4) 同一构建根、**不同 logsDir** 仍互斥（锁父目录是共享锁根，不是输出日志目录）。
//   (R6) 显式构造配置（cfg.repoRoot）优先于全局环境变量（opts > cfg > env）。
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveBuildRoot, canonicalPath } from './build-root.mjs'
import { withFileTransaction } from './file-transaction.mjs'
import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'

process.env.DSH_NO_ENV_FALLBACK = '1'
let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }
const dir = mkdtempSync(join(tmpdir(), 'build-root-'))
// R4：锁根与 logsDir 脱钩；测试用独立锁目录隔离（生产默认 ~/.dsh-agent-toolchain/build-locks）。
const lockRoot = join(dir, 'locks')
process.env.DSH_BUILD_LOCK_DIR = lockRoot
const key = (args, cfg) => 'build:' + canonicalPath(resolveBuildRoot(args, cfg) || process.cwd())
const lockPathFor = (root) => join(lockRoot, 'build-lock-' + createHash('sha1').update(canonicalPath(root)).digest('hex').slice(0, 16))
try {
  const root = mkdtempSync(join(dir, 'repo-'))

  // ---- (a) 解析口径一致 ----
  delete process.env.DSH_BUILD_CLIENT_ROOT
  process.env.DSH_BUILD_REPO_ROOT = root
  try {
    check('implicit(env) 与 explicit repoRoot 解析一致', resolveBuildRoot({}) === resolveBuildRoot({ repoRoot: root }))
    check('clientRoot 也被纳入解析', resolveBuildRoot({ clientRoot: root }) === root)
    check('★ 资源锁键一致：implicit vs explicit 同根 ⇒ 同键', key({}) === key({ repoRoot: root }) && key({}) === key({ clientRoot: root }))
  } finally { delete process.env.DSH_BUILD_REPO_ROOT }
  check('都没配时解析为 null（构建侧 fail-closed）', resolveBuildRoot({}) === null)

  // ---- (R6) cfg（构造配置）优先于 env；opts 仍优先于 cfg ----
  process.env.DSH_BUILD_REPO_ROOT = join(dir, 'env-root')
  try {
    check('★ cfg.repoRoot 优先于环境变量（opts 缺省时）', resolveBuildRoot({}, { repoRoot: root }) === root, resolveBuildRoot({}, { repoRoot: root }))
    check('opts.repoRoot 仍优先于 cfg', resolveBuildRoot({ repoRoot: root }, { repoRoot: join(dir, 'cfg-other') }) === root)
    check('无 cfg 时退化为 opts > env（任务层口径）', resolveBuildRoot({}) === join(dir, 'env-root'))
    // 端到端：makeBuilder({repoRoot:root}) 在 env 指向别处时，错误路径应用 root（不是 env）
    const b = makeBuilder({ logsDir: join(dir, 'logs-r6'), repoRoot: root })
    const r = await b.build({ project: 'Missing.csproj' })
    check('★ makeBuilder({repoRoot}) 的目标路径取 cfg 根、不被 env 盖过', String(r.error || '').includes(root) && !String(r.error || '').includes('env-root'), r.error)
  } finally { delete process.env.DSH_BUILD_REPO_ROOT }

  // ---- (R4) 同根、不同 logsDir 仍互斥（锁在共享锁根，不随 logsDir 变）----
  const builderA = makeBuilder({ logsDir: join(dir, 'logs-A'), repoRoot: root })
  const r1 = await builderA.build({ repoRoot: root })
  check('单次构建正常返回（无占用 ⇒ 不是 BUSY）', r1 && r1.errorCode !== 'FILE_TRANSACTION_BUSY', JSON.stringify({ ok: r1?.ok, errorCode: r1?.errorCode }))

  let busySame = false, busyDiff = false
  await withFileTransaction(lockPathFor(root), async () => {
    // 同 logsDir 的 builder
    try { await makeBuilder({ logsDir: join(dir, 'logs-A'), repoRoot: root }).build({ repoRoot: root }) } catch (e) { busySame = e.code === 'FILE_TRANSACTION_BUSY' }
    // ★ 不同 logsDir 的 builder —— R4 修复前这里能拿到不同锁、并发构建同仓库
    try { await makeBuilder({ logsDir: join(dir, 'logs-B'), repoRoot: root }).build({ repoRoot: root }) } catch (e) { busyDiff = e.code === 'FILE_TRANSACTION_BUSY' }
  })
  check('同 logsDir：被占用 ⇒ BUSY', busySame === true)
  check('★ 不同 logsDir：同一构建根仍 ⇒ BUSY（锁与 logsDir 脱钩）', busyDiff === true)

  const r3 = await builderA.build({ repoRoot: root })
  check('锁释放后再次构建不再 BUSY', r3 && r3.errorCode !== 'FILE_TRANSACTION_BUSY')
} finally {
  delete process.env.DSH_BUILD_LOCK_DIR
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: build-root mutex (shared lock root independent of logsDir; cfg>env precedence restored)')
