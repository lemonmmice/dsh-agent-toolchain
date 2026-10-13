import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStorage } from './capture-storage.mjs'
import { queryPage, readRetention } from './capture-store.mjs'
import { buildQueryView } from '../plugins/dsh-api-visualizer/lib/query-view.mjs'

const directory = mkdtempSync(join(tmpdir(), 'capture-query-'))
process.env.DSH_API_CAPTURE_STORE = directory
const records = Array.from({ length: 20000 }, (_, index) => ({ id: 'row-' + index, ts: index, method: index % 2 ? 'POST' : 'GET', url: 'https://example.invalid/' + index, source: 'realtime', status: index % 3 ? 200 : 500, resBody: '中文 payload ' + 'x'.repeat(1024), ...(index % 7 ? {} : { caller: { view: 'fixture' } }) }))
const file = join(directory, 'records.jsonl')
writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n') + '\n')
const filters = [{}, { method: 'POST', errors: true, limit: 17, offset: 3 }, { bodyQ: '中文', caller: 'fixture' }, { minDurationMs: 1 }, { status: '2xx', maxBytes: 5 }]
try {
  const module = await import('./capture-query-service.mjs')
  for (const filter of filters) {
    const expected = queryPage(filter)
    let heartbeat = false
    const timer = setTimeout(() => { heartbeat = true }, 1)
    const actual = await module.queryCaptureAsync(filter)
    clearTimeout(timer)
    assert.deepEqual(actual.page, expected)
    assert.equal(actual.summary.total, records.length)
    if (filter.method === 'POST') assert.equal(actual.scannedRecords, 10000)
    assert.equal(actual.retention.oldestKeptTs, readRetention().oldestKeptTs)
    assert.deepEqual(buildQueryView({ summary: actual.summary, now: 1 }), buildQueryView({ all: records, now: 1 }))
    if (filter === filters[0]) assert.equal(heartbeat, true)
  }
  appendFileSync(file, JSON.stringify({ ...records[0], id: 'new', ts: 99999 }) + '\n')
  assert.equal((await module.queryCaptureAsync({})).page.items[0].id, 'new')
  const firstPage = (await module.queryCaptureAsync({ limit: 3 })).page
  appendFileSync(file, JSON.stringify({ ...records[0], id: 'newer', ts: 999999 }) + '\n')
  const nextPage = (await module.queryCaptureAsync({ limit: 3, cursor: firstPage.nextCursor })).page
  assert.ok(nextPage.items.every(row => !firstPage.items.some(previous => previous.id === row.id)))
  assert.equal(nextPage.items[0].id, 'row-19997')
  await assert.rejects(module.queryCaptureAsync({ method: 'GET', cursor: firstPage.nextCursor }), error => error.code === 'INVALID_CURSOR')
  const storage = new CaptureStorage(directory)
  const before = storage.readAll()
  storage.summary()
  storage.append([{ ...records[0], id: 'appended', ts: Date.now() }])
  assert.equal(storage.readAll(), before, 'append updates the resident array without copying all references')
  assert.equal(storage.summary().total, records.length + 3)
  assert.equal(storage.sortedRecords()[0].id, 'appended')
  module.closeCaptureQueries()
  console.log('PASS capture queries: full filter parity, external append, same-snapshot metadata, responsive cold query and incremental resident updates')
} finally { rmSync(directory, { recursive: true, force: true }) }
