// lib/capture-store.test.mjs — store self-test:
// append / query filters / caller attribution / no-noise / pagination / runId spine.
// Runs on a temp store dir via DSH_API_CAPTURE_STORE; no network.
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendRecords, queryRecords, queryPage, readAll, clearRecords, storeDir } from './capture-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cap-store-'))
process.env.DSH_API_CAPTURE_STORE = dir

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}

const base = Date.now()
appendRecords([
  { id: 'r1', ts: base, method: 'POST', url: 'https://api.example.com/v1/login', status: 200, durationMs: 80, resHeaders: { 'content-type': 'application/json' }, caller: { viewModel: 'LoginViewModel', apiMethod: 'LoginAsync' } },
  { id: 'r2', ts: base + 1000, method: 'GET', url: 'https://api.example.com/v1/quotes?code=AAA', status: 500, durationMs: 2100, resBody: '{"error":"timeout"}', caller: { viewModel: 'QuotesViewModel', apiMethod: 'LoadQuotes' } },
  { id: 'r3', ts: base + 2000, method: 'GET', url: 'https://cdn.example.com/app/logo.png', status: 200, durationMs: 10 },
  { method: 'GET', url: 'https://api.example.com/v1/heartbeat', status: 200, durationMs: 5, source: 'proxy' },
])

ok(readAll().length === 4, 'four records appended (normalize + uuid fallback)')
ok(readdirSync(dir).some((n) => /^records-\d{8}\.jsonl$/.test(n)), 'day shard file written')

ok(queryRecords({ q: 'login' }).length === 1, 'q filter matches url')
ok(queryRecords({ method: 'GET' }).length === 3, 'method filter')
ok(queryRecords({ status: '5xx' }).length === 1, 'status class filter (5xx)')
ok(queryRecords({ errors: true }).length === 1, 'errors-only filter')
ok(queryRecords({ minDurationMs: 1000 }).length === 1, 'minDurationMs filter')
ok(queryRecords({ host: 'cdn.example.com' }).length === 1, 'host filter')
ok(queryRecords({ noNoise: true }).length === 2, 'noNoise hides static/heartbeat noise')
ok(queryRecords({ caller: 'LoginViewModel' }).length === 1, 'caller attribution filter')
ok(queryRecords({ caller: 'LoadQuotes' }).length === 1, 'caller apiMethod filter')
ok(queryRecords({ bodyQ: 'timeout' }).length === 1, 'bodyQ searches bodies')
ok(queryRecords({ source: 'proxy' }).length === 1, 'source filter')

appendRecords([{ id: 'r5', ts: base + 3000, method: 'GET', url: 'https://api.example.com/v1/status', status: 200 }], { runId: 'run-x' })
ok(readAll().length === 5, 'fifth record appended with runId option')
ok(queryRecords({ runId: 'run-x' }).length === 1, 'runId spine: query filters by runId')
ok(queryRecords({ runId: 'nope' }).length === 0, 'unknown runId matches nothing')

// ---------------------------------------------- F-046：「字段缺失」不是「不满足条件」
// 现场（2026-09-12，G1 黑盒测试）：调用方看到"0 条"有两种完全不同的成因 ——
//   ① 真的没有慢请求；② 那些记录**压根没有 durationMs 字段**（append 侧明说它是 optional）。
// 旧实现把两种情况混成一个空数组；而 maxBytes 更糟：把"字节未知"当成 0 字节 ⇒ 未知大小的记录**通过**"≤N 字节"。
{
  appendRecords([
    { id: 'nf-dur', ts: base + 4000, method: 'GET', url: 'https://api.example.com/v1/nodur', status: 200 },
    { id: 'nf-bytes', ts: base + 5000, method: 'GET', url: 'https://api.example.com/v1/nobytes', status: 200, durationMs: 50 },
    { id: 'nf-status', ts: base + 6000, method: 'GET', url: 'https://api.example.com/v1/nostatus', durationMs: 50 },
  ])
  const total = readAll().length
  ok(total === 8, 'eight records now in the store')
  // ⚠️ 期望值**从数据里算**，不要凭印象写死：我第一版手写 "1 条"，真跑是 2 条
  //    （`r5` 也没有 durationMs）—— 又一条"凭印象的断言"。这里用独立统计再比对。
  const all = readAll()
  const lackDur = all.filter((r) => !Number.isFinite(r.durationMs)).length
  const lackBytes = all.filter((r) => !Number.isFinite(Number(r.bytesRes))).length
  const lackStatus = all.filter((r) => !Number.isInteger(r.status)).length

  const byDur = queryRecords({ minDurationMs: 1 })
  ok(byDur.every((r) => Number.isFinite(r.durationMs)), 'minDurationMs 只返回**确有**该字段的记录')
  ok(byDur.excludedNoField.durationMs === lackDur, 'minDurationMs 把"没有 durationMs"的条数**单独计数**（不是混进"不匹配"）',
    `计数 ${byDur.excludedNoField.durationMs} vs 独立统计 ${lackDur}`)

  const byMax = queryRecords({ maxBytes: 100000 })
  ok(byMax.every((r) => Number.isFinite(Number(r.bytesRes))), 'maxBytes **不再**把"字节未知"当成 0 字节放行')
  ok(!byMax.some((r) => r.id === 'nf-bytes'), '"字节未知"的记录不会被 maxBytes 误判为"很小"')
  ok(byMax.excludedNoField.bytesRes === lackBytes, 'maxBytes 排除的"缺字段"条数被计出来',
    `计数 ${byMax.excludedNoField.bytesRes} vs 独立统计 ${lackBytes}`)

  const page2 = queryPage({ minBytes: 1 })
  ok(page2.excludedNoField && page2.excludedNoField.bytesRes >= 1, 'queryPage 把 excludedNoField 带出去（空结果可解释）', JSON.stringify(page2.excludedNoField))

  const errs = queryRecords({ errors: true })
  ok(errs.excludedNoField.status === lackStatus, 'errors=true 会把"没有 status"的记录计数（而不是当成"不是错误"）',
    `计数 ${errs.excludedNoField.status} vs 独立统计 ${lackStatus}`)
  const ok2xx = queryRecords({ status: '2xx' })
  ok(ok2xx.excludedNoField.status === lackStatus, 'status=2xx 同样把"没有 status"的单独计数', String(ok2xx.excludedNoField.status))

  const noFilter = queryRecords({})
  ok(noFilter.excludedNoField.durationMs === 0 && noFilter.excludedNoField.bytesRes === 0, '不带这些过滤时计数为 0（不制造噪声）')
}

const page = queryPage({ errors: true, limit: 1 })
ok(page.total === 1 && page.returned === 1 && page.hasMore === false, 'pagination shape')
ok(page.items[0].resBody === undefined, 'bodies stripped by default')
ok(queryPage({ errors: true, includeBody: true }).items[0].resBody === '{"error":"timeout"}', 'includeBody keeps bodies')

const newest = queryRecords({ limit: 1 })
ok(queryRecords({})[0].id === newest[0].id, 'sorted newest first')

ok(clearRecords().cleared === 8 && readAll().length === 0, 'clearRecords empties the store')
ok(storeDir() === dir, 'storeDir honors DSH_API_CAPTURE_STORE')

// AV-03 剩余缺口（按字节裁剪）的**端到端**验证在 av03-byte-cap-store.test.mjs ——
// 那里必须用**子进程**跑：上限是模块加载时求值的常量，本进程里改 env 已经太晚。
// （我第一版就在这里写了几条"未超上限时不裁剪"的断言 —— 那是个永远为真的假信心测试，删掉了。）

rmSync(dir, { recursive: true, force: true })
delete process.env.DSH_API_CAPTURE_STORE

if (failures > 0) {
  console.error(`\nCAPTURE-STORE TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nCAPTURE-STORE TEST PASSED')
