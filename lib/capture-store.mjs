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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
// 双上限裁剪与判定住在宿主编译模块里（`plugins/dsh-api-visualizer/lib/compaction.mjs`），
// 这里**复用同一份**：两面对 cap 的理解一旦各写各的就会漂移，而"同一语义两处实现"
// 正是本仓反复踩的坑（F-017 的部署漂移、F-021 的两面不一致都属这一类）。
// MCP server 本来就直接 import 插件的 lib（builder/driver/perf/postman/memory），
// 部署脚本也把 `lib/` 与 `plugins/` 一起同步，所以相对路径在 profile 里同样成立。
import { trimToCaps, MAX_STORE_BYTES_DEFAULT } from '../plugins/dsh-api-visualizer/lib/compaction.mjs'
import { envOr } from './env-fallback.mjs'

/** Store cap: keep the newest records (rotation trims the head). */
const MAX_RECORDS = 20000
/** 保留集字节上限（AV-03 剩余缺口）。 */
const MAX_STORE_BYTES = Number(process.env.DSH_API_CAPTURE_MAX_BYTES) > 0
  ? Number(process.env.DSH_API_CAPTURE_MAX_BYTES)
  : MAX_STORE_BYTES_DEFAULT
/** Per-field body cap. */
const MAX_FIELD_BYTES = 2 * 1024 * 1024

export function storeDir() {
  // 用户级配置 → 必须经 env-fallback（长活宿主的进程环境里读不到用户后来设的变量）。
  if (envOr('DSH_API_CAPTURE_STORE')) return envOr('DSH_API_CAPTURE_STORE')
  return join(envOr('DSH_HOME') || join(homedir(), '.dsh'), 'api-capture')
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
  if (typeof raw.runId === 'string' && raw.runId !== '') rec.runId = raw.runId
  if (typeof raw.caller === 'object' && raw.caller !== null) rec.caller = raw.caller
  if (typeof raw.tag === 'string' && raw.tag !== '') rec.tag = raw.tag
  if (raw.flag === 1 || raw.flag === true) rec.flag = 1
  return rec
}

/** Parse the JSONL store into records; deduped by id, last occurrence wins. */
let cache = { key: null, records: [] }
/** 最近一次裁剪重写是否失败（F-033）。失败时**旧分片仍在**，但要如实回报给调用方。 */
let trimError = null

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

/**
 * Append normalized records; enforce the global newest-N cap across shards.
 * opts.runId attaches the evidence-pack run id to every record that lacks one.
 */
export function appendRecords(rawRecords, opts = {}) {
  const records = []
  for (const raw of rawRecords) {
    const rec = normalize(raw)
    if (rec !== null) {
      if (opts.runId && rec.runId === undefined) rec.runId = opts.runId
      records.push(rec)
    }
  }
  if (records.length === 0) return { ingested: 0, total: readAll().length }
  mkdirSync(storeDir(), { recursive: true })
  for (const rec of records) {
    appendFileSync(join(storeDir(), shardName(rec.ts)), JSON.stringify(rec) + '\n', 'utf8')
  }
  cache = { key: null, records: [] }
  let all = readAll()
  // AV-03 剩余缺口：条数上限单独存在时，**真实磁盘上界**约 22000×4MB ≈ 85.9GB。
  // 这里与宿主插件用**同一个** trimToCaps（双上限、最旧优先），否则两面对 cap 的理解会漂移 ——
  // 而"同一语义两处实现"正是本仓已经踩过多次的坑。
  const trimmed = trimToCaps(sortNewestFirst(all), { maxRecords: MAX_RECORDS, maxBytes: MAX_STORE_BYTES })
  if (trimmed.dropped > 0) {
    const dir = storeDir()
    // **按时间正序**（最旧在前，理由见 writeTrimMarker 上面那段历史注释）+ **按分片分组，一次写完一个分片**。
    const keepOldestFirst = [...trimmed.keep].reverse()
    const grouped = new Map() // shard 文件名 → 行数组
    for (const rec of keepOldestFirst) {
      const name = shardName(rec.ts)
      if (!grouped.has(name)) grouped.set(name, [])
      grouped.get(name).push(JSON.stringify(rec))
    }
    /**
     * F-033（2026-09-12，r33 审计）：旧顺序是 **"先把分片全删掉，再逐条写回"** ——
     * 于是**在删完之后、写回完成之前**的任何中断（进程被杀 / 崩溃 / 宿主重启 / 断电）
     * 都会让**整个接口捕获库消失**。这不是"少几条"，是**全没了**，而且 `trimmed.json` 也还没写，
     * 事后连"曾经裁剪过"都看不出来 —— 而这个库里存的是**用户的真实接口流量**。
     *
     * 现在：**写临时文件 → 原子 rename 覆盖 → 最后才删多余分片**。
     * 任何时刻崩溃，磁盘上要么是**旧内容**、要么是**新内容**，绝不会两者皆无。
     * （Windows 上 `renameSync` 走 `MOVEFILE_REPLACE_EXISTING`，是原子替换。）
     */
    const written = new Set()
    let trimRewriteError = null
    try {
      for (const [name, lines] of grouped) {
        const target = join(dir, name)
        const tmp = target + '.tmp'
        writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
        renameSync(tmp, target)
        written.add(name)
      }
      // 新集合里没有的分片：**最后**删（顺序不能反 —— 反了就是上面那个"两者皆无"的窗口）
      for (const file of shardFiles()) {
        if (!written.has(basename(file))) {
          try {
            rmSync(file, { force: true })
          } catch {
            // best effort
          }
        }
      }
    } catch (e) {
      // 重写中途失败：**旧分片一个都还没删**（删除在最后一步）⇒ 数据完好。
      // 如实记下"这次裁剪没做成"，而不是假装成功、也不是把异常甩给采集管线。
      trimRewriteError = e instanceof Error ? e.message : String(e)
    }
    trimError = trimRewriteError
    if (trimRewriteError === null) {
      // **把"裁剪过多少"落到盘上**（2026-09-12，r17 主题自查）。
      // 病：裁剪会 `rmSync` 掉旧分片，而**不留任何痕迹** —— 宿主插件里那个 `lastCompactDropped` 只在**内存**、
      // 且在 **DSH 进程**里，MCP 面（agent 最常用的 `capture_query`）根本看不到。
      // 后果正中用户场景："这段时间有没有报错的接口？" → 答案 0 条，而真相是**那段时间的记录已被裁掉**。
      // 「没读到」被呈现成「没有」—— 本仓反复出现的那类缺陷，这次在接口线上。
      writeTrimMarker(dir, {
        dropped: trimmed.dropped,
        truncatedBy: trimmed.truncatedBy || null,
        maxRecords: MAX_RECORDS,
        maxBytes: MAX_STORE_BYTES,
      })
    }
    cache = { key: null, records: [] }
    all = readAll()
  }
  return {
    ingested: records.length,
    total: all.length,
    // 裁剪没做成时**必须说出来**（否则"库还在涨"会被当成"裁剪逻辑没触发"）
    ...(trimError !== null ? { trimError, trimFailed: true } : {}),
  }
}

/** 裁剪标记文件（累积计数）。读不到就当"从未裁剪过"，绝不抛。 */
function trimMarkerPath() { return join(storeDir(), 'trimmed.json') }

function writeTrimMarker(dir, info) {
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
export function readRetention() {
  let marker = null
  try { marker = JSON.parse(readFileSync(trimMarkerPath(), 'utf8')) } catch { marker = null }
  let oldest = null
  let newest = null
  try {
    const all = readAll()
    for (const r of all) {
      const ts = Number(r && r.ts)
      if (!Number.isFinite(ts)) continue
      if (oldest === null || ts < oldest) oldest = ts
      if (newest === null || ts > newest) newest = ts
    }
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
  // F-046（2026-09-12，G1 黑盒测试提出）：**「字段缺失」不是「不满足条件」**。
  //   旧实现：`minDurationMs` 用 `Number.isFinite(r.durationMs) && r.durationMs >= min` ⇒ 没有该字段的记录被**静默丢掉**；
  //   更糟的是 `min/maxBytes` 用 `(Number(r.bytesRes) || 0)` ⇒ **"字节数未知"被当成"0 字节"**，
  //   于是未知大小的记录会**通过** `maxBytes`（"响应 ≤ N 字节"）—— 那不是漏报，是**答错**。
  //   现在：未知一律排除（未知不能证明满足条件），并**计数**带出去，让"0 条"可解释。
  const noField = { durationMs: 0, bytesRes: 0, status: 0 }
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
  const sorted = sortNewestFirst(items)
  // 非枚举属性：不会混进 JSON，但调用方（queryPage / MCP / 面板路由）能把它带出去。
  Object.defineProperty(sorted, 'excludedNoField', { value: noField, enumerable: false, configurable: true })
  return sorted
}

/** Filter + page: returns { total, returned, hasMore, items, excludedNoField? }. */
export function queryPage(filter = {}) {
  const items = queryRecords(filter)
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 500)
  const offset = Math.max(Number(filter.offset) || 0, 0)
  const page = items.slice(offset, offset + limit)
  const noField = items.excludedNoField
  const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0)
  return {
    total: items.length,
    returned: page.length,
    hasMore: offset + page.length < items.length,
    items: filter.includeBody ? page : withoutBodies(page),
    ...(noFieldAny ? { excludedNoField: noField } : {}),
  }
}
