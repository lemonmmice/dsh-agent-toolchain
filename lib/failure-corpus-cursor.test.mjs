// failure_query 稳定游标（keyset，(ts,id) 降序全序）分页：翻页不重不漏，顶部新增不会让已看过的记录重复出现。
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { makeFailureCorpus } from './failure-corpus.mjs'

const dir = mkdtempSync(join(tmpdir(), 'fc-cursor-'))
try {
  const c = makeFailureCorpus({ dir, maxBytes: 20 * 1024 * 1024 })
  for (let i = 0; i < 6; i++) c.record({ task: `t${i}`, failureClass: 'tool-error', description: `d${i}` })

  const all = c.query({ limit: 100 })
  assert.equal(all.total, 6)
  assert.equal(all.hasMore, false)
  assert.equal(all.nextCursor, null)

  // 三页 limit=2 覆盖全部 6 条，不重不漏，顺序与全量一致
  const seen = []
  let cur
  for (let p = 0; p < 3; p++) {
    const page = c.query({ limit: 2, cursor: cur })
    assert.equal(page.rows.length, 2)
    assert.equal(page.hasMore, p < 2)
    seen.push(...page.rows.map((r) => r.id))
    cur = page.nextCursor
  }
  assert.equal(cur, null, '翻到末页后 nextCursor 为 null')
  assert.equal(new Set(seen).size, 6, '六条各出现一次，不重不漏')
  assert.deepEqual(seen, all.rows.map((r) => r.id), 'cursor 翻页顺序与全量一致')

  // 稳定性：第一页后在顶部插入新记录，继续用 cursor 翻页不会重复已看过的记录（offset 在此会重复）
  const p1 = c.query({ limit: 2 })
  const p1ids = p1.rows.map((r) => r.id)
  c.record({ task: 'newest-after-page1', failureClass: 'tool-error', description: 'inserted at top after first page' })
  const laterIds = []
  let cc = p1.nextCursor
  while (cc) {
    const pg = c.query({ limit: 2, cursor: cc })
    laterIds.push(...pg.rows.map((r) => r.id))
    cc = pg.nextCursor
  }
  for (const id of p1ids) assert.ok(!laterIds.includes(id), 'cursor 翻页不重复已看过的记录（即使顶部新增）')

  // 坏游标不崩：无法解析的游标按"无游标"处理（回退到头部）
  const bad = c.query({ limit: 2, cursor: 'not-a-valid-cursor!!!' })
  assert.equal(bad.rows.length, 2)

  console.log('PASS: failure_query stable keyset cursor (no dup/skip, stable under top inserts, bad cursor tolerated)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
