// Shared host/MCP storage seam. JSON semantics stay in JS; the Rust module owns
// file writes, per-ID byte accounting, ordering for retention and writer locks.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_RECORDS_DEFAULT, MAX_STORE_BYTES_DEFAULT } from '../plugins/dsh-api-visualizer/lib/compaction.mjs'

const require = createRequire(import.meta.url)
let Binding
function binding() {
  if (Binding) return Binding
  const file = process.env.DSH_CAPTURE_STORE_NATIVE || fileURLToPath(new URL(
    `../plugins/dsh-api-visualizer/bin/${process.platform}-${process.arch}/capture-store.node`, import.meta.url))
  try { Binding = require(file).CaptureStore }
  catch (cause) { throw new Error('Capture storage native module unavailable. Run npm run build:capture-store and deploy the api-visualizer bin directory.', { cause }) }
  return Binding
}

export function shardName(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now())
  const p = n => String(n).padStart(2, '0')
  return `records-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.jsonl`
}

function keyOf(id) {
  const key = new Array(id.length)
  for (let i = 0; i < id.length; i++) key[i] = id.charCodeAt(i)
  return key
}
function idOf(key) {
  // Avoid argument-count limits for externally supplied long IDs.
  let id = ''
  for (let i = 0; i < key.length; i += 4096) id += String.fromCharCode(...key.slice(i, i + 4096))
  return id
}
function timestamp(r) {
  const ts = Number(r.ts)
  return Number.isFinite(ts) && ts !== 0 ? ts : 0
}
const changed = error => String(error.message).includes('CAPTURE_STORE_CHANGED:')
const newestFirst = (first, second) => (Number(second.ts) || 0) - (Number(first.ts) || 0) || (String(first.id) < String(second.id) ? 1 : String(first.id) > String(second.id) ? -1 : 0)
const hasCaller = row => Boolean(row?.caller && (row.caller.viewModel || row.caller.apiMethod || row.caller.view || row.caller.trigger || (Array.isArray(row.caller.stack) && row.caller.stack.length)))

export class CaptureStorage {
  constructor(directory) {
    this.directory = resolve(directory)
    const Native = binding()
    this.native = new Native(this.directory)
    this.records = null
    this.byId = new Map()
    this.pendingIndex = null
    this.positions = new Map()
    this.derived = null
    this.revision = 0
  }

  invalidate() { this.records = null; this.byId.clear(); this.pendingIndex = null; this.positions.clear(); this.derived = null; this.revision++ }

  readAll() {
    if (this.records !== null && this.native.isFresh()) return this.records
    for (let attempt = 0; ; attempt++) {
      try {
        const byId = new Map(), sources = new Map()
        for (const shard of this.native.load()) {
          for (const line of shard.text.split('\n')) {
            const text = line.trim()
            if (!text) continue
            let record
            try { record = JSON.parse(text) } catch { continue } // tolerate incomplete/malformed legacy rows
            if (!record || typeof record.id !== 'string') continue
            byId.set(record.id, record)
            sources.set(record.id, shard.file)
          }
        }
        if (!this.native.isFresh()) throw new Error('CAPTURE_STORE_CHANGED: shards changed while parsing')
        this.byId = byId
        this.records = [...byId.values()]
        this.positions = new Map(this.records.map((row, index) => [row.id, index]))
        this.derived = null
        this.revision++
        this.pendingIndex = sources
        return this.records
      } catch (error) {
        this.invalidate()
        if (!changed(error) || attempt >= 2) throw error
      }
    }
  }

  writeRows(records) {
    return records.map(r => ({ key: keyOf(r.id), ts: timestamp(r), json: JSON.stringify(r), shard: shardName(r.ts) }))
  }

  sortedRecords() {
    this.readAll()
    if (!this.derived) {
      this.derived = { sorted: [...this.records].sort(newestFirst), withCaller: 0, realtimeCount: 0, indexes: new Map(['method', 'source', 'runId'].map(field => [field, new Map()])) }
      for (const row of this.derived.sorted) {
        if (hasCaller(row)) this.derived.withCaller++
        if (row.source === 'realtime') this.derived.realtimeCount++
        for (const [field, index] of this.derived.indexes) {
          const key = row[field] ?? ''
          if (!index.has(key)) index.set(key, [])
          index.get(key).push(row)
        }
      }
    }
    return this.derived.sorted
  }

  summary() {
    const sorted = this.sortedRecords()
    let newestTs = null, oldestKeptTs = null
    for (const row of sorted) { if (Number.isFinite(Number(row.ts))) { newestTs = Number(row.ts); break } }
    for (let index = sorted.length - 1; index >= 0; index--) { if (Number.isFinite(Number(sorted[index].ts))) { oldestKeptTs = Number(sorted[index].ts); break } }
    return { total: this.records.length, withCaller: this.derived.withCaller, realtimeCount: this.derived.realtimeCount, newestTs, oldestKeptTs, revision: this.revision }
  }

  candidateRecords(filter) {
    let candidates = this.sortedRecords()
    const keys = [['method', String(filter.method ?? '').toUpperCase(), 'ALL'], ['source', String(filter.source ?? '').trim(), 'all']]
    if (!String(filter.status ?? '').trim() && ![filter.minDurationMs, filter.minBytes, filter.maxBytes].some(Number.isFinite)) keys.push(['runId', String(filter.runId ?? '').trim(), null])
    for (const [field, key, wildcard] of keys) {
      if (!key || key === wildcard) continue
      const indexed = this.derived.indexes.get(field).get(key) || []
      if (indexed.length < candidates.length) candidates = indexed
    }
    return candidates
  }

  insertSorted(rows, row) {
    let lower = 0, upper = rows.length
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (newestFirst(rows[middle], row) <= 0) lower = middle + 1
      else upper = middle
    }
    rows.splice(lower, 0, row)
  }

  updateDerived(previous, row) {
    if (!this.derived) return
    const derived = this.derived
    if (previous) {
      const index = derived.sorted.indexOf(previous)
      if (index >= 0) derived.sorted.splice(index, 1)
      if (hasCaller(previous)) derived.withCaller--
      if (previous.source === 'realtime') derived.realtimeCount--
    }
    if (hasCaller(row)) derived.withCaller++
    if (row.source === 'realtime') derived.realtimeCount++
    this.insertSorted(derived.sorted, row)
    for (const [field, index] of derived.indexes) {
      if (previous) {
        const oldKey = previous[field] ?? ''
        const prior = index.get(oldKey)
        const position = prior?.indexOf(previous) ?? -1
        if (position >= 0) prior.splice(position, 1)
        if (prior?.length === 0) index.delete(oldKey)
      }
      const key = row[field] ?? ''
      if (!index.has(key)) index.set(key, [])
      this.insertSorted(index.get(key), row)
    }
  }

  indexCurrent() {
    if (this.pendingIndex === null) return
    // Build the byte index only for writes/retention. Read-only queries do not
    // need to serialize every body. JS canonicalization preserves exact bytes
    // for hand-edited JSON, number formats and lone-surrogate escaping.
    const metadata = []
    for (const r of this.records) metadata.push({ key: keyOf(r.id), ts: timestamp(r),
      bytes: Buffer.byteLength(JSON.stringify(r)) + 1, shard: this.pendingIndex.get(r.id) })
    this.native.index(metadata) // rejects changes since this snapshot was read
    this.pendingIndex = null
  }

  ensureIndexed() {
    for (let attempt = 0; ; attempt++) {
      try { this.readAll(); this.indexCurrent(); return }
      catch (error) {
        this.invalidate()
        if (!changed(error) || attempt >= 2) throw error
      }
    }
  }

  append(records) {
    const rows = this.writeRows(records)
    for (let attempt = 0; ; attempt++) {
      this.readAll()
      try {
        this.indexCurrent()
        const result = this.native.append(rows)
        if (result.reload) this.invalidate()
        else {
          for (let i = 0; i < records.length; i++) {
            if (!result.applied[i]) continue
            const row = records[i]
            const previous = this.byId.get(row.id)
            this.updateDerived(previous, row)
            if (this.positions.has(row.id)) this.records[this.positions.get(row.id)] = row
            else { this.positions.set(row.id, this.records.length); this.records.push(row) }
            this.byId.set(row.id, row)
          }
          this.revision++
        }
        return { ...result, total: this.readAll().length }
      } catch (error) {
        this.invalidate()
        // This error is issued under the lock BEFORE any write. Other failures
        // may have appended a partial batch and must not be retried silently.
        if (!changed(error) || attempt >= 2) throw error
      }
    }
  }

  plan(maxRecords, maxBytes) {
    this.ensureIndexed()
    // Preserve trimToCaps' defaults and fractional count threshold at the FFI boundary.
    const count = Number.isFinite(maxRecords) ? Math.min(0xffffffff, Math.max(0, Math.ceil(maxRecords))) : MAX_RECORDS_DEFAULT
    const bytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_STORE_BYTES_DEFAULT
    const p = this.native.plan(count, bytes)
    if (!p) return null
    return { keep: p.keys.map(key => this.byId.get(idOf(key))), keptBytes: p.keptBytes,
      dropped: p.dropped, truncatedBy: p.truncatedBy }
  }

  replace(records) {
    // Never refresh an already-loaded snapshot here: doing so would bless a
    // stale read/modify/write and discard another process's newly appended rows.
    if (this.records === null) this.readAll()
    try { this.indexCurrent(); this.native.replace(this.writeRows(records)) }
    finally { this.invalidate() }
  }

  stats() { this.ensureIndexed(); return this.native.stats() }
}
