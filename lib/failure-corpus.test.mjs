// lib/failure-corpus.test.mjs — self-test for the failure corpus core.
// Runs on a temp dir; no network, no side effects outside that dir.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFailureCorpus } from './failure-corpus.mjs'

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}
const throws = (fn, msg) => {
  try {
    fn()
    failures++
    console.error('  FAIL - ' + msg + ' (did not throw)')
  } catch {
    console.log('  ok - ' + msg + ' (rejected)')
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fc-test-'))
const c = makeFailureCorpus({ dir, maxBytes: 700 })

const r1 = c.record({
  task: 'push CI workflow file',
  failureClass: 'tool-error',
  description: 'token lacked workflow scope',
  resolution: 'device-flow token',
  tags: ['git', 'auth'],
  costMs: 600000,
  context: { runtime: 'cli' },
})
ok(!!r1.id && !!r1.ts && r1.failureClass === 'tool-error', 'record returns full record with id/ts')

throws(() => c.record({ task: 'x', description: 'y' }), 'missing failureClass')
throws(() => c.record({ task: 'x', failureClass: 'nonsense', description: 'y' }), 'unknown failureClass')
throws(() => c.record({ task: 'x', failureClass: 'flaky', description: 'y', tags: ['a', 1] }), 'non-string tag')
throws(() => c.record({ task: 'x', failureClass: 'flaky', description: 'y', costMs: -1 }), 'negative costMs')

c.record({ task: 'UI render mismatch', failureClass: 'agent-misjudge', description: 'claimed rendered, screenshot showed old page', tags: ['ui'] })
c.record({ task: 'flaky unit test', failureClass: 'flaky', description: 'passed locally, failed in CI', tags: ['ci'] })

ok(c.query({ q: 'workflow' }).total === 1, 'substring query')
ok(c.query({ failureClass: 'flaky' }).total === 1, 'class filter')
ok(c.query({ tag: 'auth' }).total === 1, 'tag filter')
ok(c.query({ fromTs: Date.now() + 1e9 }).total === 0, 'fromTs filter')
ok(c.query({ limit: 1 }).count === 1, 'limit applied')

const s = c.stats()
ok(s.total === 3 && s.byClass['tool-error'] === 1 && s.last7d === 3, 'stats shape')

// rotation: write records until the active file exceeds maxBytes
for (let i = 0; i < 25; i++) {
  c.record({ task: `filler ${i}`, failureClass: 'flaky', description: 'padding record to cross the rotation threshold' })
}
const archives = readdirSync(dir).filter((n) => n.startsWith('records-') && n.endsWith('.jsonl'))
ok(archives.length >= 1, 'rotation produced an archive file')
ok(existsSync(join(dir, 'records.jsonl')), 'active file exists after rotation')
ok(c.stats().total < 28, 'rotated records moved out of the active file')

// ---------------------------------------------- F-032-a（2026-09-12，r30 读代码发现）
// 上面那条断言把"total 只算活动文件"当成了契约（**保留，不改**）。但**旧实现让轮转掉的记录对 query 也隐形了** ——
// 于是"查不到"会被读成"从来没有过这条失败记录"。现在：query 读全部分片，stats 同时给出全量口径与分片清单。
const sAfter = c.stats()
ok(sAfter.totalAllShards > sAfter.total, 'stats 同时给出全量口径（totalAllShards > total）')
ok(sAfter.archivedRecords > 0 && /另有 .* 条在已轮转的分片里/.test(String(sAfter.archivedNote)),
  'stats 说明"还有 N 条在归档分片里"（不让 total 悄悄变小）')
ok(Array.isArray(sAfter.filesScanned) && sAfter.filesScanned.length >= 2, 'stats 报出读过的分片清单')
ok(c.query({ q: 'filler 0' }).total === 1, '★ 轮转掉的记录仍然**查得到**（query 读全部分片）')
ok(Array.isArray(c.query({}).filesScanned) && c.query({}).filesScanned.length >= 2, 'query 也报出读过的分片清单')

// ---------------------------------------------- F-032-b：撤回（append-only）
// 起因：F-023 让 verify_report 把两句真话判成失败，失败库里因此留下 `class=agent-misjudge` 的**假记录**。
// 删掉＝掩盖"工具诬告过我"；留着＝污染唯一的反自欺数据源。第三条路：**追加撤回事件**。
{
  const bad = c.record({ task: '被诬告的任务', failureClass: 'agent-misjudge', description: 'claim contradicted by evidence: 真话被判成假话' })
  const before = c.stats().byClassAllShards['agent-misjudge']
  const r = c.retract({ id: bad.id, reason: 'F-023：verify_report 相对路径基准缺陷导致误判，该 claim 实际为真', by: 'dsh' })
  ok(r.ok === true && String(r.retractionId).startsWith('fc-retract-'), 'retract 返回撤回事件 id')
  const s2 = c.stats()
  ok(s2.byClassAllShards['agent-misjudge'] === before - 1, '★ 撤回后不再计入')
  ok(s2.retracted === 1 && /已被撤回/.test(String(s2.retractedNote)), '★ 如实报告撤回了多少条（不静默改数）')
  ok(s2.byClassRetracted && s2.byClassRetracted['agent-misjudge'] === 1, '撤回按类别可见')
  const q1 = c.query({ q: '被诬告的任务' })
  ok(q1.total === 0 && q1.retractedExcluded === 1, '★ 默认查询排除已撤回项，但报出排除了几条')
  const q2 = c.query({ q: '被诬告的任务', includeRetracted: true })
  ok(q2.total === 1 && q2.rows[0].retracted === true && /F-023/.test(String(q2.rows[0].retractedReason)),
    '★ includeRetracted 时能拿到**原文 + 撤回理由**（不是删掉）')
  ok(c.retract({ id: bad.id, reason: '再来' }).ok === false, '重复撤回被拒绝')
  ok(c.retract({ id: 'fc-不存在', reason: 'x' }).ok === false, '撤回不存在的 id 被拒绝')
  ok(c.retract({ id: bad.id, reason: '   ' }).ok === false, '撤回必须给理由')
  const lines = readFileSync(join(dir, 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  ok(lines.some((x) => x.kind === 'retraction'), '★ 撤回是**追加事件**：原记录行仍在文件里（可审计，没被删）')
}

// 坏行：跳过但**计数并说明**（不静默）
{
  writeFileSync(join(dir, 'records-corrupt.jsonl'), '{ 这不是 JSON\n', 'utf8')
  const q = c.query({})
  ok(q.corruptLines === 1 && /解析失败/.test(String(q.note)), '★ 坏行被跳过但计数并说明（不静默）')
  ok(c.stats().corruptLines === 1, 'stats 也带出坏行数')
}

// ---------------------------------------------- F-034：id 熵与"按 id 撤回"的歧义
// @codex r33 实测：旧 id 是 `fc-<日期>-<2 字节 hex>`，**每天只有 65536 种** —— 2000 条就撞出 31 个重复 id；
// 我在**真库**里也复核到 2 组重复（4 条）。危害：**撤回按 id 生效 ⇒ 会连带撤回同 id 的另一条**，
// 于是"一条有效的失败记录被静默地从统计里抹掉"。修法：id 加宽到 6 字节（48 bit），
// 并且**撤回要精确定位**（id 有歧义时要求附 `ts`，否则拒绝）。
{
  const dir2 = mkdtempSync(join(tmpdir(), 'fc-id-'))
  const c2 = makeFailureCorpus({ dir: dir2 })
  const N = 3000
  const ids = new Set()
  for (let i = 0; i < N; i++) ids.add(c2.record({ task: 't' + i, failureClass: 'flaky', description: 'd' }).id)
  // ⚠ 本文件用的是 `ok(cond, msg)`（**条件在前**）—— 我第一版按 `ok(name, cond, extra)` 写，
  //   于是三条断言都被当成"条件=字符串（truthy）"而**恒真**（输出成了 `ok - true`）。
  //   这是"空断言"：**测试绿了但什么也没验**。下面按本文件的约定写。
  ok(ids.size === N, `F-034 ★ 连写 ${N} 条 id 全部唯一（旧实现这里会撞出几十个重复）unique=${ids.size}/${N}`)
  ok(/^fc-\d{8}-[0-9a-f]{12}$/.test([...ids][0]), `F-034 id 仍是可读的 fc-<日期>-<hex> 形状：${[...ids][0]}`)

  // 歧义撤回：手工造两条**同 id** 记录（模拟历史数据），要求撤回时给 ts 才放行
  const { appendFileSync } = await import('node:fs')
  const sameId = 'fc-20260101-deadbeefdead'
  const active = join(dir2, 'records.jsonl')
  appendFileSync(active, JSON.stringify({ id: sameId, ts: '2026-01-01T00:00:01.000Z', task: 'A', failureClass: 'flaky', description: 'a' }) + '\n', 'utf8')
  appendFileSync(active, JSON.stringify({ id: sameId, ts: '2026-01-01T00:00:02.000Z', task: 'B', failureClass: 'tool-error', description: 'b' }) + '\n', 'utf8')

  const amb = c2.retract({ id: sameId, reason: '只该撤回其中一条' })
  ok(amb.ok === false && amb.ambiguous === true && amb.count === 2 && Array.isArray(amb.candidates),
    `F-034 ★ id 有歧义时**拒绝**撤回并给出候选：${JSON.stringify(amb).slice(0, 160)}`)
  const exact = c2.retract({ id: sameId, ts: '2026-01-01T00:00:01.000Z', reason: '只有 A 是误判' })
  ok(exact.ok === true, `F-034 ★ 附上 ts 后可精确撤回：${JSON.stringify(exact).slice(0, 140)}`)
  const bRow = c2.query({ q: 'B', includeRetracted: true }).rows.filter((r) => r.id === sameId)
  ok(bRow.length === 1 && bRow[0].retracted !== true,
    `F-034 ★★ 同 id 的另一条**不能**被连带撤回（旧实现会静默抹掉它）：${JSON.stringify(bRow.map((r) => ({ task: r.task, retracted: r.retracted })))}`)
  const aRow = c2.query({ q: 'A', includeRetracted: true }).rows.filter((r) => r.id === sameId)
  ok(aRow.length === 1 && aRow[0].retracted === true,
    `F-034 被指定的那条确实撤回了：${JSON.stringify(aRow.map((r) => ({ task: r.task, retracted: r.retracted })))}`)
  rmSync(dir2, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nFAILURE-CORPUS TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nFAILURE-CORPUS TEST PASSED')
