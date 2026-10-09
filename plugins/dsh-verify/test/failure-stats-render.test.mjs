// failure_stats 渲染：反复出现排行必须印出来（F-059 同病：算出来了、没印出来）。
// 夹具直接来自生产者（makeFailureCorpus 真写到临时目录），不手搓形状。
// node plugins/dsh-verify/test/failure-stats-render.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderFailureStats } from '../lib/render-failure.mjs'
import { makeFailureCorpus } from '../../../lib/failure-corpus.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }
const tmp = mkdtempSync(join(tmpdir(), 'fc-stats-render-'))

try {
  const c = makeFailureCorpus({ dir: tmp, dedupeWindowMs: 3600000 })
  const base = { failureClass: 'tool-error', task: 'http_request', description: 'request could not be made: timeout after 1500ms', tags: ['auto'] }
  c.record({ ...base, dedupe: true })
  c.record({ ...base, description: 'request could not be made: timeout after 2000ms', dedupe: true })
  c.record({ ...base, description: 'request could not be made: timeout after 3000ms', dedupe: true })
  c.record({ failureClass: 'human-handoff', task: 'release', description: 'needed a signing key' })
  const text = renderFailureStats(c.stats())[0].text
  ok(/活动分片 2 条/.test(text), '总数照旧（重复不计入 total）')
  ok(/去重折叠的重复发生 2 次/.test(text), '折叠掉的重复次数印出来')
  ok(/×3\s+tool-error\s+http_request/.test(text), '反复出现排行：一行 ×3（类别 + task）')
  ok(/request could not be made: timeout after/.test(text), '排行里带样例描述（不是只有数字）')
  ok(/按类别（活动分片）：/.test(text) && /tool-error 1/.test(text) && /human-handoff 1/.test(text), '按类别计数（顺序跟随固定分类表）')
  ok(!/ \- → \-/.test(text) && !/NaN/.test(text), '时间来自生产者的 ISO 串，不印成 - 或 NaN')
  const empty = renderFailureStats(makeFailureCorpus({ dir: join(tmp, 'empty') }).stats())[0].text
  ok(/活动分片 0 条/.test(empty) && !/反复出现/.test(empty), '空库：只有汇总行，不编造排行')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: failure_stats render' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
