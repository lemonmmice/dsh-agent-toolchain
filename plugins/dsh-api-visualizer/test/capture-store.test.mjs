// plugins/dsh-api-visualizer/test/capture-store.test.mjs — store self-test:
// append / query filters / caller attribution / no-noise / pagination.
// Runs on a temp store dir via DSH_API_CAPTURE_STORE; no network.
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendRecords, queryRecords, queryPage, readAll, clearRecords, storeDir } from '../lib/capture-store.mjs'

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

const page = queryPage({ errors: true, limit: 1 })
ok(page.total === 1 && page.returned === 1 && page.hasMore === false, 'pagination shape')
ok(page.items[0].resBody === undefined, 'bodies stripped by default')
ok(queryPage({ errors: true, includeBody: true }).items[0].resBody === '{"error":"timeout"}', 'includeBody keeps bodies')

const newest = queryRecords({ limit: 1 })
ok(queryRecords({})[0].id === newest[0].id, 'sorted newest first')

ok(clearRecords().cleared === 4 && readAll().length === 0, 'clearRecords empties the store')
ok(storeDir() === dir, 'storeDir honors DSH_API_CAPTURE_STORE')

rmSync(dir, { recursive: true, force: true })
delete process.env.DSH_API_CAPTURE_STORE

if (failures > 0) {
  console.error(`\nCAPTURE-STORE TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nCAPTURE-STORE TEST PASSED')
