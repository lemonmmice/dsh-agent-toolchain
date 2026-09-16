// r51 单测：perf 证据清理（`cleanEvidence`）—— 默认只看不删、只在自己的目录里动、采样中不删 etl。
// 用临时目录现造文件，绝不碰真实证据目录。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanEvidence, renderClean } from '../lib/evidence-clean.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-perf-clean-'))
const mk = (name, bytes) => writeFileSync(join(root, name), 'x'.repeat(bytes))
mk('client.dmp', 1000)
mk('trace.etl', 2000)
mk('notes.txt', 10)          // 非证据大件 ⇒ 永不触碰
mkdirSync(join(root, 'symbol-cache'), { recursive: true })   // 目录 ⇒ 绝不递归

// ---- 1. 默认（不传 confirm）= 只看不删 ----
{
  const r = cleanEvidence({ dir: root })
  check('★ 默认只看不删（dryRun=true，文件仍在）',
    r.ok === true && r.dryRun === true && r.candidates.length === 2 && existsSync(join(root, 'client.dmp')) && existsSync(join(root, 'trace.etl')),
    JSON.stringify({ dryRun: r.dryRun, n: r.candidates.length }))
  check('★ 命中清单只含 .dmp/.etl（不动 .txt，也不进子目录）',
    r.candidates.every((c) => /\.(dmp|etl)$/i.test(c.path)) && r.candidates.length === 2)
  check('★ 报出总字节数与下一步（要人显式确认）', r.totalBytes === 3000 && /confirm=true/.test(r.hint), String(r.totalBytes))
  check('渲染给人话（含"只看不删"与目录）', /只看不删/.test(renderClean(r)) && renderClean(r).includes(root))
}

// ---- 2. what 过滤 ----
{
  const r = cleanEvidence({ dir: root, what: 'dumps' })
  check('what=dumps 时只列 .dmp', r.candidates.length === 1 && /\.dmp$/i.test(r.candidates[0].path), JSON.stringify(r.candidates.map((c) => c.path)))
}

// ---- 3. 采样进行中 ⇒ 不删 etl ----
{
  writeFileSync(join(root, 'trace-session.json'), JSON.stringify({ etlPath: join(root, 'trace.etl'), startedAt: Date.now(), profile: 'cpu' }), 'utf8')
  const r = cleanEvidence({ dir: root, confirm: true })
  check('★★ 有采样会话标记时**不删 etl**（那可能正是它在写的文件），且如实说出为什么',
    existsSync(join(root, 'trace.etl')) && r.skipped.some((s) => /采样进行中/.test(s.reason)),
    JSON.stringify(r.skipped))
  check('  dmp 仍然被删（禁令只针对 etl）', !existsSync(join(root, 'client.dmp')))
  rmSync(join(root, 'trace-session.json'), { force: true })
}

// ---- 4. confirm=true 真的删（并在无标记后把 etl 也删掉）----
{
  const r = cleanEvidence({ dir: root, confirm: true })
  check('confirm=true 后两个证据大件都没了', !existsSync(join(root, 'client.dmp')) && !existsSync(join(root, 'trace.etl')))
  check('★ 只删文件：目录与无关文件都在',
    existsSync(root) && existsSync(join(root, 'notes.txt')) && existsSync(join(root, 'symbol-cache')))
  check('释放字节数如实回报（2000 字节的 etl）', r.freedBytes === 2000 && r.deleted.length === 1, JSON.stringify({ freed: r.freedBytes, n: r.deleted.length }))
}

// ---- 5. 只在自己的目录里动 + 读不到就说清楚 ----
{
  // ⚠ 这里原来写的是 `cleanEvidence({ dir: join(root, '..') })` —— `root` 是 `mkdtempSync(tmpdir())` 建的，
  //   于是"父目录"= **整个系统 %TEMP%**，而断言要求它"没有 .dmp/.etl"。
  //   那等于断言**机器全局状态干净**：任何别的进程（WPR 探针的 etl、另一次采集、浏览器崩溃转储）
  //   往 %TEMP% 丢一个 .dmp/.etl，这条就**假红**（Claude r61 实测撞到：残留的 `%TEMP%\r61-raw.etl`）。
  //   测试断言机器全局状态 = 测试自身有缺陷。改成**自控容器**：真正要钉的性质是"清 A 不碰 B"。
  const container = mkdtempSync(join(tmpdir(), 'dsh-perf-clean-container-'))
  const evA = join(container, 'ev-a')
  const evB = join(container, 'ev-b')
  const empty = join(container, 'empty-evidence')
  for (const d of [evA, evB, empty]) mkdirSync(d, { recursive: true })
  writeFileSync(join(evA, 'a.dmp'), 'x'.repeat(64))
  writeFileSync(join(evB, 'b.dmp'), 'x'.repeat(64))

  const cleanedA = cleanEvidence({ dir: evA, confirm: true })
  check('★★ 清 A **不碰兄弟目录 B**（"只在自己的目录里动"这条性质的正身）',
    cleanedA.deleted.length === 1 && !existsSync(join(evA, 'a.dmp')) && existsSync(join(evB, 'b.dmp')),
    JSON.stringify({ deleted: cleanedA.deleted.map((d) => d.path), bStillThere: existsSync(join(evB, 'b.dmp')) }))

  const outside = cleanEvidence({ dir: empty })   // 自控的空目录（**不是** %TEMP%）
  check('★ 空目录里给"没有符合条件的文件"（不会去动别处的东西）',
    outside.ok === true && outside.candidates.length === 0, JSON.stringify(outside.candidates.map((c) => c.path)))

  rmSync(container, { recursive: true, force: true })
  const missing = cleanEvidence({ dir: join(root, 'does-not-exist') })
  check('★ 目录不存在 ⇒ ok:false + 原因（不静默"什么都没做"）',
    missing.ok === false && /不存在/.test(missing.error), JSON.stringify(missing.error))
  const none = cleanEvidence({})
  check('★ 没给目录 ⇒ ok:false + 原因', none.ok === false && /没有可用的 perf 证据目录/.test(none.error))
  check('渲染失败态也说清原因（不是"干净"）', /清理失败/.test(renderClean(missing)))
}

// ---- 6. keepDays 过滤（只删旧的）----
{
  mk('old.dmp', 500)
  const r = cleanEvidence({ dir: root, keepDays: 7 })
  check('keepDays=7 时不删刚生成的文件（并说明被过滤的原因）',
    r.candidates.length === 0 && r.skipped.some((s) => /未超龄/.test(s.reason)), JSON.stringify(r.skipped.map((s) => s.reason)))
}

rmSync(root, { recursive: true, force: true })
if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: perf 证据清理（默认只看不删 / 只删 .dmp,.etl / 采样中不删 etl / 越界与缺目录都如实报）')
