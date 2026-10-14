// F06 回归：构建资源键与实际构建根用**同一套**解析，且互斥放在所有执行方式共用的一层。
//   (a) implicit(env) 与 explicit(repoRoot/clientRoot) 指向同一目录时，解析结果与锁键必须一致（原先不一致 ⇒ 绕过互斥）。
//   (b) 同一构建根已被占用时，builder.build 取不到锁即 BUSY（同步 / 后台 / 异步最终都走这把锁）。
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
const key = (args) => 'build:' + canonicalPath(resolveBuildRoot(args) || process.cwd())
try {
  const root = mkdtempSync(join(dir, 'repo-'))

  // ---- (a) 解析口径一致 ----
  delete process.env.DSH_BUILD_CLIENT_ROOT
  process.env.DSH_BUILD_REPO_ROOT = root
  try {
    check('implicit(env DSH_BUILD_REPO_ROOT) 与 explicit repoRoot 解析一致', resolveBuildRoot({}) === resolveBuildRoot({ repoRoot: root }))
    check('clientRoot 也被纳入解析（原先资源键不读它）', resolveBuildRoot({ clientRoot: root }) === root)
    check('★ 资源锁键一致：implicit vs explicit 同根 ⇒ 同键（否则并发绕过互斥）', key({}) === key({ repoRoot: root }) && key({}) === key({ clientRoot: root }), JSON.stringify([key({}), key({ repoRoot: root })]))
  } finally { delete process.env.DSH_BUILD_REPO_ROOT }
  check('都没配时解析为 null（构建侧 fail-closed）', resolveBuildRoot({}) === null)

  // ---- (b) 构建互斥：同一根的锁被占用时，build 取不到锁即 BUSY ----
  const logsDir = join(dir, 'logs')
  const builder = makeBuilder({ logsDir, repoRoot: '', clientRoot: '' })

  const r1 = await builder.build({ repoRoot: root })
  check('单次构建正常返回（无占用 ⇒ 不是 BUSY）', r1 && r1.errorCode !== 'FILE_TRANSACTION_BUSY', JSON.stringify({ ok: r1?.ok, errorCode: r1?.errorCode }))

  const lockFile = join(logsDir, 'build-lock-' + createHash('sha1').update(canonicalPath(root)).digest('hex').slice(0, 16))
  let busy = false
  await withFileTransaction(lockFile, async () => {
    try { await builder.build({ repoRoot: root }) } catch (e) { busy = e.code === 'FILE_TRANSACTION_BUSY' }
  })
  check('★ 同一构建根被占用 ⇒ build 取不到锁、报 BUSY（所有执行方式共用这把锁）', busy === true)

  const r3 = await builder.build({ repoRoot: root })
  check('锁释放后再次构建不再 BUSY', r3 && r3.errorCode !== 'FILE_TRANSACTION_BUSY')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: build-root mutex (shared resolution ⇒ consistent lock key; builder lock serializes all paths)')
