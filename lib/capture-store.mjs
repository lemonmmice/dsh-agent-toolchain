/**
 * dsh-api-visualizer capture store — framework-free core.
 *
 * Reads/writes the SAME day-shard JSONL store the DSH plugin uses
 * (~/.dsh/api-capture/records-YYYYMMDD.jsonl, override DSH_API_CAPTURE_STORE),
 * so MCP tools and the host plugin share one source of truth: capture in the
 * panel, query from any MCP client.
 *
 * The host and MCP surfaces share the same Rust storage/index implementation
 * through capture-storage.mjs, and the same normalization function below.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { MAX_STORE_BYTES_DEFAULT } from '../plugins/dsh-api-visualizer/lib/compaction.mjs'
import { CaptureStorage } from './capture-storage.mjs'
import { envOr } from './env-fallback.mjs'
import { compileFilter, filterSignature } from './capture-filters.mjs'
import { loadClientsConfig, activeClientOf, clientForProcess, sameDir } from './capture-clients.mjs'

/** Store cap: keep the newest records (rotation trims the head). */
const MAX_RECORDS = 20000
/** 保留集字节上限（AV-03 剩余缺口）。 */
const MAX_STORE_BYTES = Number(process.env.DSH_API_CAPTURE_MAX_BYTES) > 0
  ? Number(process.env.DSH_API_CAPTURE_MAX_BYTES)
  : MAX_STORE_BYTES_DEFAULT
/** Per-field body cap. */
const MAX_FIELD_BYTES = 2 * 1024 * 1024

/**
 * 捕获根目录：所有客户端共用的状态（规则、证书、拦截状态、弱网、过滤器、capture-clients.json）都在这里。
 * 用户级配置 → 必须经 env-fallback（长活宿主的进程环境里读不到用户后来设的变量）。
 */
export function stateDir() {
  if (envOr('DSH_API_CAPTURE_STORE')) return envOr('DSH_API_CAPTURE_STORE')
  return join(envOr('DSH_HOME') || join(homedir(), '.dsh'), 'api-capture')
}

/**
 * 记录目录 = **当前客户端**的记录目录（见 lib/capture-clients.mjs：记录跟着用户启动的客户端切换）。
 * 没有 capture-clients.json（或里面一个合法客户端都没有）⇒ 就是捕获根目录本身 —— 与原来完全一样。
 */
export function storeDir() {
  const root = stateDir()
  const client = activeClientOf(loadClientsConfig(root))
  return client === null ? root : client.dir
}

/** 一条记录该落到哪个记录目录：clientProcess 属于某个已配置的客户端 ⇒ 那个客户端的目录；否则当前客户端的目录。 */
export function recordsDirFor(rec) {
  const root = stateDir()
  const cfg = loadClientsConfig(root)
  if (cfg.clients.length > 0 && rec !== null && typeof rec === 'object' && typeof rec.clientProcess === 'string' && rec.clientProcess !== '') {
    const owner = clientForProcess(cfg, rec.clientProcess)
    if (owner !== null) return owner.dir
  }
  const active = activeClientOf(cfg)
  return active === null ? root : active.dir
}

/** 给状态 / 路由 / 工具看的一句话：根目录、当前记录目录、当前客户端、模式（auto 跟随启动的客户端 / manual 锁定）。 */
export function captureClientInfo() {
  const root = stateDir()
  const cfg = loadClientsConfig(root)
  const active = activeClientOf(cfg)
  return {
    stateDir: root,
    recordsDir: active === null ? root : active.dir,
    client: active === null ? null : active.name,
    mode: cfg.mode,
    configured: cfg.clients.length > 0,
    ...(cfg.error ? { error: cfg.error } : {}),
  }
}

export { sameDir }

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
  // 发起请求的客户端进程（代理按 TCP 连接反查；实时捕获由宿主按配置的客户端进程名补上）。
  if (typeof raw.clientProcess === 'string' && raw.clientProcess !== '' && raw.clientProcess.length <= 260) rec.clientProcess = raw.clientProcess
  if (Number.isInteger(raw.clientPid) && raw.clientPid >= 0) rec.clientPid = raw.clientPid
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
  if (typeof raw.runId === 'string' && raw.runId !== '') rec.runId = raw.runId
  if (raw.evidenceLevel === 'observed' || raw.evidenceLevel === 'imported') rec.evidenceLevel = raw.evidenceLevel
  if (typeof raw.caller === 'object' && raw.caller !== null) rec.caller = raw.caller
  if (typeof raw.tag === 'string' && raw.tag !== '') rec.tag = raw.tag
  if (raw.flag === 1 || raw.flag === true) rec.flag = 1
  return rec
}

// A single storage instance is shared by the host and MCP code within a process.
// Other processes coordinate through the native writer lock and shard stamps.
// 多客户端：每个记录目录一个实例（按解析后的绝对路径缓存；Windows 不区分大小写）。
const storages = new Map()
export function getCaptureStorage(dir = storeDir()) {
  const directory = resolve(dir)
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory
  let storage = storages.get(key)
  if (storage === undefined) {
    try { mkdirSync(directory, { recursive: true }) } catch { /* 交给存储层报错 */ }
    storage = new CaptureStorage(directory)
    storages.set(key, storage)
  }
  return storage
}

export function readAll() { return [...getCaptureStorage().readAll()] }

/** Append normalized rows; keep the newest records within both retention caps. */
export function appendRecords(rawRecords, opts = {}) {
  const records = []
  for (const raw of rawRecords) {
    const rec = normalize(raw)
    if (rec !== null) {
      rec.evidenceLevel = 'imported'
      if (opts.runId && rec.runId === undefined) rec.runId = opts.runId
      records.push(rec)
    }
  }
  if (records.length === 0) return { ingested: 0, total: readAll().length }
  // 按记录所属的客户端分组，各自落到自己的记录目录（各目录各自的保留上限 / 裁剪标记）
  const active = storeDir()
  let trimError = null
  const routed = {}
  for (const { dir, part } of groupByRecordsDir(records)) {
    const result = appendNormalizedTo(dir, part)
    if (result.trimError) trimError = result.trimError
    if (!sameDir(dir, active)) routed[dir] = (routed[dir] ?? 0) + part.length
  }
  return { ingested: records.length, total: readAll().length,
    ...(Object.keys(routed).length > 0 ? { routed } : {}),
    ...(trimError !== null ? { trimError, trimFailed: true } : {}) }
}

/** 已规范化的记录按 recordsDirFor 分组（保持各组内的原顺序）。 */
export function groupByRecordsDir(records) {
  const groups = new Map()
  for (const rec of records) {
    const dir = recordsDirFor(rec)
    const resolved = resolve(dir)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    let g = groups.get(key)
    if (g === undefined) { g = { dir, part: [] }; groups.set(key, g) }
    g.part.push(rec)
  }
  return [...groups.values()]
}

/** 把已规范化的记录追加进指定记录目录，并按该目录自己的上限裁剪（裁剪标记写在同一目录）。 */
export function appendNormalizedTo(dir, records) {
  const storage = getCaptureStorage(dir)
  if (!Array.isArray(records) || records.length === 0) return { appended: 0, total: storage.readAll().length, dropped: 0 }
  storage.append(records)
  const trimmed = storage.plan(MAX_RECORDS, MAX_STORE_BYTES)
  let trimError = null
  let dropped = 0
  if (trimmed) {
    try {
      // Native replace stages every shard before publishing replacements and
      // deletes obsolete shards last. Failed staging preserves all old rows.
      storage.replace([...trimmed.keep].reverse())
      dropped = trimmed.dropped
      writeTrimMarker(dir, {
        dropped: trimmed.dropped, truncatedBy: trimmed.truncatedBy,
        maxRecords: MAX_RECORDS, maxBytes: MAX_STORE_BYTES,
      })
    } catch (error) { trimError = error.message }
  }
  return { appended: records.length, total: storage.readAll().length, dropped,
    ...(trimError !== null ? { trimError, trimFailed: true } : {}) }
}

/** 裁剪标记文件（累积计数）。读不到就当"从未裁剪过"，绝不抛。 */
function trimMarkerPath() { return join(storeDir(), 'trimmed.json') }

export function writeTrimMarker(dir, info) {
  try {
    const p = join(dir, 'trimmed.json')
    let prev = null
    try { prev = JSON.parse(readFileSync(p, 'utf8')) } catch { prev = null }
    const next = {
      schema: 1,
      droppedTotal: (Number(prev && prev.droppedTotal) || 0) + (Number(info.dropped) || 0),
      lastDropped: Number(info.dropped) || 0,
      lastDroppedAt: Date.now(),
      truncatedBy: info.truncatedBy || null,
      maxRecords: info.maxRecords,
      maxBytes: info.maxBytes,
      note: '库按上限裁剪过：被裁掉的记录**已不在库内**，查不到 ≠ 没发生过。',
    }
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 标记写不进去也不该影响裁剪本身（best effort），但查询侧会因此说"未知"而不是"没有"
  }
}

/**
 * 保留期信息（给查询侧用来解释"你看到的不是全部"）。
 * @returns {{droppedTotal:number|null, lastDroppedAt:number|null, truncatedBy:string|null, maxRecords:number, maxBytes:number, oldestKeptTs:number|null, newestTs:number|null, note:string|null}}
 */
export function readRetention(summary) {
  let marker = null
  try { marker = JSON.parse(readFileSync(trimMarkerPath(), 'utf8')) } catch { marker = null }
  let oldest = null
  let newest = null
  try {
    const metadata = summary || getCaptureStorage().summary()
    oldest = metadata.oldestKeptTs
    newest = metadata.newestTs
  } catch { /* 读不到就留 null = 未知，不谎报 */ }
  const dropped = marker && Number.isFinite(Number(marker.droppedTotal)) ? Number(marker.droppedTotal) : null
  return {
    droppedTotal: dropped,
    lastDroppedAt: marker && Number.isFinite(Number(marker.lastDroppedAt)) ? Number(marker.lastDroppedAt) : null,
    truncatedBy: marker ? (marker.truncatedBy || null) : null,
    maxRecords: MAX_RECORDS,
    maxBytes: MAX_STORE_BYTES,
    oldestKeptTs: oldest,
    newestTs: newest,
    note: dropped !== null && dropped > 0
      ? '库按上限裁剪过（累计 ' + dropped + ' 条）—— **被裁掉的记录已不在库内，查不到 ≠ 没发生过**；' +
        (oldest !== null ? '当前库内最早一条 ' + new Date(oldest).toLocaleString('zh-CN') + '。' : '')
      : null,
  }
}

/** Drop every record (all shards), refusing a stale snapshot. */
export function clearRecords() {
  const storage = getCaptureStorage()
  const cleared = storage.readAll().length
  storage.replace([])
  return { cleared }
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
 * sessionId, traceId, errors, noNoise, bodyQ, caller (attribution substring),
 * conditions (custom filters from lib/capture-filters.mjs: one filter, an array
 * of filters that must all match, or their JSON — AND-ed with every key above),
 * realtimeProcess (the client process name realtime records count as).
 * Invalid conditions throw FILTER_INVALID, even when there are no records.
 */
export function queryRecords(filter = {}, records = readAll(), presorted = false) {
  // F-046（2026-09-12，G1 黑盒校验提出）：**「字段缺失」不是「不满足条件」**。
  //   旧实现：`minDurationMs` 用 `Number.isFinite(r.durationMs) && r.durationMs >= min` ⇒ 没有该字段的记录被**静默丢掉**；
  //   更糟的是 `min/maxBytes` 用 `(Number(r.bytesRes) || 0)` ⇒ **"字节数未知"被当成"0 字节"**，
  //   于是未知大小的记录会**通过** `maxBytes`（"响应 ≤ N 字节"）—— 那不是漏报，是**答错**。
  //   现在：未知一律排除（未知不能证明满足条件），并**计数**带出去，让"0 条"可解释。
  const noField = { durationMs: 0, bytesRes: 0, status: 0 }
  // 自定义过滤器先编译：条件不合法必须报 FILTER_INVALID，哪怕库里一条记录都没有。
  const conditions = filter.conditions === undefined || filter.conditions === null
    ? null
    : compileFilter(filter.conditions, { realtimeProcess: filter.realtimeProcess ?? '' })
  let items = records
  const q = String(filter.q ?? '').trim()
  if (q !== '') {
    const lq = q.toLowerCase()
    let expression = null
    if (filter.regex === true) { try { expression = new RegExp(q, 'i') } catch { expression = null } }
    items = expression
      ? items.filter(row => expression.test(row.url) || (typeof row.note === 'string' && expression.test(row.note)))
      : items.filter((r) => r.url.toLowerCase().includes(lq) || (typeof r.note === 'string' && r.note.toLowerCase().includes(lq)))
  }
  const method = String(filter.method ?? '').toUpperCase()
  if (method !== '' && method !== 'ALL') items = items.filter((r) => r.method === method)
  const source = String(filter.source ?? '').trim()
  if (source !== '' && source !== 'all') items = items.filter((r) => (r.source ?? '') === source)
  const status = String(filter.status ?? '').trim()
  if (status !== '') {
    const s = status.toLowerCase()
    noField.status += items.filter((r) => !Number.isInteger(r.status)).length
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
  if (Number.isFinite(filter.minDurationMs)) {
    noField.durationMs += items.filter((r) => !Number.isFinite(r.durationMs)).length
    items = items.filter((r) => Number.isFinite(r.durationMs) && r.durationMs >= filter.minDurationMs)
  }
  if (Number.isFinite(filter.minBytes)) {
    noField.bytesRes += items.filter((r) => !Number.isFinite(Number(r.bytesRes))).length
    items = items.filter((r) => Number.isFinite(Number(r.bytesRes)) && Number(r.bytesRes) >= filter.minBytes)
  }
  if (Number.isFinite(filter.maxBytes)) {
    noField.bytesRes += items.filter((r) => !Number.isFinite(Number(r.bytesRes))).length
    items = items.filter((r) => Number.isFinite(Number(r.bytesRes)) && Number(r.bytesRes) <= filter.maxBytes)
  }
  if (Number.isFinite(filter.fromTs)) items = items.filter((r) => Number(r.ts) >= filter.fromTs)
  if (Number.isFinite(filter.toTs)) items = items.filter((r) => Number(r.ts) <= filter.toTs)
  const sessionId = String(filter.sessionId ?? '').trim()
  if (sessionId !== '') items = items.filter((r) => sessionKeyOf(r) === sessionId)
  const traceId = String(filter.traceId ?? '').trim()
  if (traceId !== '') items = items.filter((r) => r.traceId === traceId)
  const runId = String(filter.runId ?? '').trim()
  if (runId !== '') items = items.filter((r) => r.runId === runId)
  if (filter.errors) {
    noField.status += items.filter((r) => !Number.isInteger(r.status)).length
    items = items.filter((r) => Number.isInteger(r.status) && r.status >= 400)
  }
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
  if (conditions !== null && !conditions.matchesAll) {
    // 与上面每个过滤键都是 AND。数字条件遇到「字段缺失」同样不成立（未知不能证明满足条件），并按 F-046 的口径计数，
    // 否则「0 条」分不清是「没有」还是「这些记录缺这个字段」。每条记录只计一次，单独记在 noField.conditions：
    // durationMs / bytesRes / status 三格只算快捷过滤参数排除的；conditionFields 列出缺的是自定义条件里的哪些数字字段，
    // 调用方据此说「是自定义条件排除的」，而不是让人去掉根本没传过的快捷参数。
    let byConditions = 0
    const fields = new Set()
    items = items.filter((r) => {
      if (conditions(r)) return true
      const missing = conditions.missingNumberFields(r)
      if (missing.length > 0) {
        byConditions++
        for (const field of missing) fields.add(field)
      }
      return false
    })
    if (byConditions > 0) Object.assign(noField, { conditions: byConditions, conditionFields: [...fields].sort() })
  }
  const sorted = presorted ? [...items] : sortNewestFirst(items)
  // 非枚举属性：不会混进 JSON，但调用方（queryPage / MCP / 面板路由）能把它带出去。
  Object.defineProperty(sorted, 'excludedNoField', { value: noField, enumerable: false, configurable: true })
  return sorted
}

/** Filter + page: returns { total, returned, hasMore, items, excludedNoField? }. */
export function queryPage(filter = {}, records, presorted = false, { maxLimit = 500, legacyCursor = false } = {}) {
  const items = queryRecords(filter, records, presorted)
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), maxLimit)
  const offset = Math.max(Number(filter.offset) || 0, 0)
  // 游标绑定查询：哈希分页字段以外的全部过滤键（conditions、realtimeProcess 也在内）。
  // conditions 换成规范签名再哈希 —— 临时条件每次解析都会拿到新的随机 id，直接哈希原始对象会让第 2 页对不上第 1 页的游标；
  // 签名为 null（null / [] / '' 都是「没有条件」）时不进哈希，与不带 conditions 的查询同一个键。
  const queryKey = createHash('sha256').update(JSON.stringify(Object.entries(filter)
    .filter(([key, value]) => value !== undefined && !['cursor', 'limit', 'offset', 'includeBody', 'fresh'].includes(key))
    .map(([key, value]) => key === 'conditions' ? [key, filterSignature(value)] : [key, value])
    .filter(([key, value]) => key !== 'conditions' || value !== null)
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0))).digest('hex')
  let eligible = items
  if (filter.cursor) {
    let cursor
    if (legacyCursor) {
      const [timestamp, id = ''] = String(filter.cursor).split('|')
      cursor = { ts: Number(timestamp), id }
    } else {
      try { cursor = JSON.parse(Buffer.from(String(filter.cursor), 'base64url').toString('utf8')) }
      catch { throw Object.assign(new Error('Invalid capture cursor'), { code: 'INVALID_CURSOR' }) }
      if (cursor.version !== 1 || cursor.query !== queryKey || !Number.isFinite(cursor.ts) || typeof cursor.id !== 'string') throw Object.assign(new Error('Capture cursor does not match this query'), { code: 'INVALID_CURSOR' })
    }
    if (Number.isFinite(cursor.ts)) eligible = items.filter(row => (Number(row.ts) || 0) < cursor.ts || ((Number(row.ts) || 0) === cursor.ts && String(row.id) < cursor.id))
  }
  const page = eligible.slice(offset, offset + limit)
  const hasMore = offset + page.length < eligible.length
  const last = page.at(-1)
  const nextCursor = legacyCursor ? (last ? `${last.ts}|${last.id}` : null)
    : hasMore && last && Number.isFinite(Number(last.ts) || 0) ? Buffer.from(JSON.stringify({ version: 1, query: queryKey, ts: Number(last.ts) || 0, id: String(last.id) })).toString('base64url') : null
  const noField = items.excludedNoField
  const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0 || noField.conditions > 0)
  return {
    total: legacyCursor ? eligible.length : items.length,
    returned: page.length,
    hasMore,
    nextCursor,
    items: filter.includeBody ? page : withoutBodies(page),
    ...(noFieldAny ? { excludedNoField: noField } : {}),
  }
}
