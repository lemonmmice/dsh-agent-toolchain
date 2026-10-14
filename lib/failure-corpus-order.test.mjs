// F03 回归：query 复用按版本构建一次的稳定全序快照；过滤保持有序、游标二分定位。
//   验证：过滤 + 游标分页不重不漏且顺序与全量过滤一致；重复查询结果一致（快照复用不改变结果）。
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFailureCorpus } from './failure-corpus.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }
const dir = mkdtempSync(join(tmpdir(), 'fc-order-'))
try {
  const c = makeFailureCorpus({ dir, maxBytes: 20 * 1024 * 1024 })
  // 混入两类，交替写入（许多条会落在同一毫秒，考验 (ts,id) 全序的稳定性）
  for (let i = 0; i < 40; i++) c.record({ task: 't' + i, failureClass: i % 2 ? 'tool-error' : 'flaky', description: 'd' + i, tags: i % 3 === 0 ? ['x'] : [] })

  // 全量过滤基准
  const all = c.query({ limit: 500, failureClass: 'tool-error' })
  const allIds = all.rows.map((r) => r.id)
  check('过滤计数正确（20 条 tool-error）', all.total === 20 && allIds.length === 20, String(all.total))

  // 过滤 + 游标分页：覆盖全部、不重不漏、顺序与全量过滤一致
  const seen = []
  let cur
  for (let p = 0; p < 10; p++) {
    const page = c.query({ limit: 3, failureClass: 'tool-error', cursor: cur })
    seen.push(...page.rows.map((r) => r.id))
    cur = page.nextCursor
    if (!cur) break
  }
  check('过滤 + 游标：不重不漏（20 条各一次）', seen.length === 20 && new Set(seen).size === 20, String(seen.length))
  check('★ 过滤 + 游标：顺序与全量过滤一致', JSON.stringify(seen) === JSON.stringify(allIds))

  // 顺序稳定：全序要求 ts 降序优先；同 ts 的相对序在重复查询间不变
  const again = c.query({ limit: 500, failureClass: 'tool-error' }).rows.map((r) => r.id)
  check('重复查询顺序完全一致（快照复用不改变结果）', JSON.stringify(again) === JSON.stringify(allIds))
  const times = all.rows.map((r) => Date.parse(r.ts))
  check('结果按 ts 降序（新 → 旧）', times.every((t, i) => i === 0 || times[i - 1] >= t))

  // tag 过滤 + 游标也成立
  const tagAll = c.query({ limit: 500, tag: 'x' }).rows.map((r) => r.id)
  const tagSeen = []
  let tcur
  for (let p = 0; p < 20; p++) {
    const page = c.query({ limit: 2, tag: 'x', cursor: tcur })
    tagSeen.push(...page.rows.map((r) => r.id))
    tcur = page.nextCursor
    if (!tcur) break
  }
  check('tag 过滤 + 游标：顺序一致、不重不漏', JSON.stringify(tagSeen) === JSON.stringify(tagAll) && new Set(tagSeen).size === tagAll.length, tagAll.length + ' vs ' + tagSeen.length)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: failure_query stable ordered snapshot (filter preserves order, binary cursor paginates exactly)')
