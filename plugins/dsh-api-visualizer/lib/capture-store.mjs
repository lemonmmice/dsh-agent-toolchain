/**
 * dsh-api-visualizer capture store — framework-free core.
 *
 * Reads/writes the SAME day-shard JSONL store the DSH plugin uses
 * (~/.dsh/api-capture/records-YYYYMMDD.jsonl, override DSH_API_CAPTURE_STORE),
 * so MCP tools and the host plugin share one source of truth: capture in the
 * panel, query from any MCP client.
 *
 * NOTE: the host plugin (lib/index.js) owns realtime/proxy ingestion and its
 * own in-memory cache; this module is the shared reader/writer for the MCP
 * surface. Keep the shard layout and normalize() in sync with lib/index.js.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Store cap: keep the newest records (rotation trims the head). */
const MAX_RECORDS = 20000
/** Per-field body cap. */
const MAX_FIELD_BYTES = 2 * 1024 * 1024

export function storeDir() {
  if (process.env.DSH_API_CAPTURE_STORE) return process.env.DSH_API_CAPTURE_STORE
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'api-capture')
}

/** Day shard name for a record timestamp (local date). */
function shardName(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `records-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.jsonl`
}

/** All shard files: legacy single file first, then day shards ordered by name. */
function shardFiles() {
  const dir = storeDir()
  if (!existsSync(dir)) return []
  const out = []
  const legacy = join(dir, 'records.jsonl')
  if (existsSync(legacy)) out.push(legacy)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    if (/^records-\d{8}\.jsonl$/.test(name)) out.push(join(dir, name))
  }
  return out
}

/** Normalize one raw record; returns null when it cannot form a record. */
export function normalize(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : ''
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (method === '' || url === '') return null
  const rec = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'agent',
    method,
    url,
  }
  if (typeof raw.process === 'string' && raw.process !== '') rec.process = raw.process
  if (Number.isInteger(raw.status)) rec.status = raw.status
  if (Number.isFinite(raw.durationMs)) rec.durationMs = raw.durationMs
  if (typeof raw.reqHeaders === 'object' && raw.reqHeaders !== null) rec.reqHeaders = raw.reqHeaders
  if (typeof raw.reqBody === 'string') rec.reqBody = raw.reqBody.slice(0, MAX_FIELD_BYTES)
  if (typeof raw.resHeaders === 'object' && raw.resHeaders !== null) rec.resHeaders = raw.resHeaders
  if (typeof raw.resBody === 'string') rec.resBody = raw.resBody.slice(0, MAX_FIELD_BYTES)
  if (typeof raw.note === 'string' && raw.note !== '') rec.note = raw.note
  if (typeof raw.contentType === 'string' && raw.contentType !== '') rec.contentType = raw.contentType
  if (Number.isFinite(raw.firstByteMs)) rec.firstByteMs = raw.firstByteMs
  if (Number.isFinite(raw.ttfbMs)) rec.ttfbMs = raw.ttfbMs
  if (Number.isFinite(raw.connectMs)) rec.connectMs = raw.connectMs
  if (Number.isFinite(raw.tlsMs)) rec.tlsMs = raw.tlsMs
  if (typeof raw.ruleId === 'string' && raw.ruleId !== '') rec.ruleId = raw.ruleId
  if (typeof raw.ws === 'object' && raw.ws !== null) rec.ws = raw.ws
  if (Number.isFinite(raw.bytesReq)) rec.bytesReq = raw.bytesReq
  if (Number.isFinite(raw.bytesRes)) rec.bytesRes = raw.bytesRes
  if (Number.isInteger(raw.chunkCount)) rec.chunkCount = raw.chunkCount
  if (typeof raw.complete === 'boolean') rec.complete = raw.complete
  if (typeof raw.streaming === 'boolean') rec.streaming = raw.streaming
  if (typeof raw.sessionId === 'string' && raw.sessionId !== '') rec.sessionId = raw.sessionId
  if (typeof raw.traceId === 'string' && raw.traceId !== '') rec.traceId = raw.traceId
  if (typeof raw.parentId === 'string' && raw.parentId !== '') rec.parentId = raw.parentId
  if (typeof raw.caller === 'object' && raw.caller !== null) rec.caller = raw.caller
  if (typeof raw.tag === 'string' && raw.tag !== '') rec.tag = raw.tag
  if (raw.flag === 1 || raw.flag === true) rec.flag = 1
  return rec
}

/** Parse the JSONL store into records; deduped by id, last occurrence wins. */
let cache = { key: null, records: [] }

function storeKey(files) {
  let mtime = 0
  let size = 0
  for (const file of files) {
    try {
      const st = statSync(file)
      if (st.mtimeMs > mtime) mtime = st.mtimeMs
      size += st.size
    } catch {
      // file may vanish between list and stat
    }
  }
  return `${mtime}:${size}:${files.length}`
}

export function readAll() {
  const files = shardFiles()
  const key = storeKey(files)
  if (cache.key === key) return cache.records
  const byId = new Map()
  const order = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try {
        const record = JSON.parse(t)
        if (record && typeof record.id === 'string') {
          if (!byId.has(record.id)) order.push(record.id)
          byId.set(record.id, record)
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  const out = order.map((id) => byId.get(id)).filter((record) => record !== undefined)
  cache = { key, records: out }
  return out
}

/** Append normalized records; enforce the global newest-N cap across shards. */
export function appendRecords(rawRecords) {
  const records = []
  for (const raw of rawRecords) {
    const rec = normalize(raw)
    if (rec !== null) records.push(rec)
  }
  if (records.length === 0) return { ingested: 0, total: readAll().length }
  mkdirSync(storeDir(), { recursive: true })
  for (const rec of records) {
    appendFileSync(join(storeDir(), shardName(rec.ts)), JSON.stringify(rec) + '\n', 'utf8')
  }
  cache = { key: null, records: [] }
  let all = readAll()
  if (all.length > MAX_RECORDS) {
    const keep = sortNewestFirst(all).slice(0, MAX_RECORDS)
    const dir = storeDir()
    for (const file of shardFiles()) {
      try {
        rmSync(file, { force: true })
      } catch {
        // best effort
      }
    }
    for (const rec of keep) {
      appendFileSync(join(dir, shardName(rec.ts)), JSON.stringify(rec) + '\n', 'utf8')
    }
    cache = { key: null, records: [] }
    all = readAll()
  }
  return { ingested: records.length, total: all.length }
}

/** Drop every record (all shards). */
export function clearRecords() {
  const all = readAll()
  for (const file of shardFiles()) {
    try {
      rmSync(file, { force: true })
    } catch {
      // best effort
    }
  }
  cache = { key: null, records: [] }
  return { cleared: all.length }
}

/** Strip bodies + ws frames from list payloads (keep the table light). */
function withoutBodies(records) {
  return records.map((r) => {
    const { reqBody, resBody, ws, ...rest } = r
    return rest
  })
}

/** Hostname of a record url, or ''. */
function hostOf(rec) {
  try {
    return new URL(rec.url).hostname
  } catch {
    return ''
  }
}

function headerValue(headers, name) {
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

function sessionKeyOf(rec) {
  const caller = rec.caller ?? {}
  return rec.sessionId || rec.traceId || `${rec.source ?? ''}|${rec.process ?? ''}|${caller.viewModel ?? caller.view ?? ''}|${Math.floor((Number(rec.ts) || 0) / 10000)}`
}

/** Static-resource / heartbeat noise patterns (hide-no-noise filter). */
const NOISE_PATTERNS = [
  /\.(png|jpe?g|gif|svg|ico|webp|css|js|woff2?|ttf|eot|map)([?#]|$)/i,
  /(heart|ping|beacon|favicon)/i,
  /buryingpoint/i,
]

/** Newest-first sort (ts desc, id desc as tiebreaker). */
export function sortNewestFirst(list) {
  return [...list].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0))
}

/**
 * Shared filter pipeline (object interface).
 * Params: q, method, source, status, flag, host (comma list), contentType
 * (comma list, substring), minDurationMs, minBytes, maxBytes, fromTs, toTs,
 * sessionId, traceId, errors, noNoise, bodyQ, caller (attribution substring).
 */
export function queryRecords(filter = {}) {
  let items = readAll()
  const q = String(filter.q ?? '').trim()
  if (q !== '') {
    const lq = q.toLowerCase()
    items = items.filter((r) => r.url.toLowerCase().includes(lq) || (typeof r.note === 'string' && r.note.toLowerCase().includes(lq)))
  }
  const method = String(filter.method ?? '').toUpperCase()
  if (method !== '' && method !== 'ALL') items = items.filter((r) => r.method === method)
  const source = String(filter.source ?? '').trim()
  if (source !== '' && source !== 'all') items = items.filter((r) => (r.source ?? '') === source)
  const status = String(filter.status ?? '').trim()
  if (status !== '') {
    const s = status.toLowerCase()
    items = s.endsWith('xx')
      ? items.filter((r) => Number.isInteger(r.status) && Math.floor(r.status / 100) === Number(s[0]))
      : items.filter((r) => String(r.status) === status)
  }
  if (filter.flag) items = items.filter((r) => r.flag === true || r.flag === 1)
  const host = String(filter.host ?? '').trim().toLowerCase()
  if (host !== '') {
    const hosts = host.split(',').map((h) => h.trim()).filter((h) => h !== '')
    items = items.filter((r) => hosts.includes(hostOf(r)))
  }
  const ct = String(filter.contentType ?? '').trim().toLowerCase()
  if (ct !== '') {
    const cts = ct.split(',').map((c) => c.trim()).filter((c) => c !== '')
    items = items.filter((r) => {
      const value = String(headerValue(r.resHeaders, 'content-type') ?? r.contentType ?? '').toLowerCase()
      return cts.some((c) => value.includes(c))
    })
  }
  if (Number.isFinite(filter.minDurationMs)) items = items.filter((r) => Number.isFinite(r.durationMs) && r.durationMs >= filter.minDurationMs)
  if (Number.isFinite(filter.minBytes)) items = items.filter((r) => (Number(r.bytesRes) || 0) >= filter.minBytes)
  if (Number.isFinite(filter.maxBytes)) items = items.filter((r) => (Number(r.bytesRes) || 0) <= filter.maxBytes)
  if (Number.isFinite(filter.fromTs)) items = items.filter((r) => Number(r.ts) >= filter.fromTs)
  if (Number.isFinite(filter.toTs)) items = items.filter((r) => Number(r.ts) <= filter.toTs)
  const sessionId = String(filter.sessionId ?? '').trim()
  if (sessionId !== '') items = items.filter((r) => sessionKeyOf(r) === sessionId)
  const traceId = String(filter.traceId ?? '').trim()
  if (traceId !== '') items = items.filter((r) => r.traceId === traceId)
  if (filter.errors) items = items.filter((r) => Number.isInteger(r.status) && r.status >= 400)
  if (filter.noNoise) items = items.filter((r) => !NOISE_PATTERNS.some((p) => p.test(r.url)))
  const bodyQ = String(filter.bodyQ ?? '').trim().toLowerCase()
  if (bodyQ !== '') {
    items = items.filter((r) => {
      const hay = `${typeof r.reqBody === 'string' ? r.reqBody : ''}\n${typeof r.resBody === 'string' ? r.resBody : ''}\n${JSON.stringify(r.reqHeaders ?? {})}\n${JSON.stringify(r.resHeaders ?? {})}`.toLowerCase()
      return hay.includes(bodyQ)
    })
  }
  const caller = String(filter.caller ?? '').trim().toLowerCase()
  if (caller !== '') {
    items = items.filter((r) => {
      const c = r.caller ?? {}
      const hay = [c.viewModel, c.view, c.apiMethod, c.trigger, ...(Array.isArray(c.stack) ? c.stack : [])].filter(Boolean).join('\n').toLowerCase()
      return hay.includes(caller)
    })
  }
  return sortNewestFirst(items)
}

/** Filter + page: returns { total, returned, hasMore, items }. */
export function queryPage(filter = {}) {
  const items = queryRecords(filter)
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 500)
  const offset = Math.max(Number(filter.offset) || 0, 0)
  const page = items.slice(offset, offset + limit)
  return {
    total: items.length,
    returned: page.length,
    hasMore: offset + page.length < items.length,
    items: filter.includeBody ? page : withoutBodies(page),
  }
}
