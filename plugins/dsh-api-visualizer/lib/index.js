/**
 * dsh-api-visualizer — host half.
 *
 * Mounts the JSONL capture store (records.jsonl under the dsh data dir),
 * the /api/dsh-api-visualizer route family (records / stats / ingest /
 * clear, loopback-only), the api_capture_append agent tool, and a
 * system-prompt announcement. The browser half (./client) renders the
 * 「接口捕获」 sidebar entry and live panel. Everything rides official DSH
 * packages — no dsh source changes.
 *
 * Record shape (one JSON object per line):
 *   { id, ts, source, process, method, url, status, durationMs,
 *     reqHeaders, reqBody, resHeaders, resBody, note }
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在各 defineTool 的 name；capture 家族按 MCP 名索引）。
import { dshParameters, dshDescription } from '../../../lib/tool-registry.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CaptureEngine, DEFAULT_LOG, DEFAULT_CALLER_LOG } from './capture-engine.mjs'
import { captureStart, captureStop, captureStatus, captureStatusSummary, doubleWriteVerdict, sampleDeltaVerdict } from './capture-control.mjs'
// AV-03：'这次该不该整库重写'的纯判定（可测；避免在 flush 热路径里做上百 MB 的同步 IO）
import { shouldCompact, COMPACT_MIN_INTERVAL_MS, MAX_STORE_BYTES_DEFAULT, trimToCaps } from './compaction.mjs'
// F-007：宿主不热加载插件代码 —— 抓包/代理这些"看数据下结论"的工具必须自报代码是否陈旧。
import { staleCodeInfo, moduleRoots } from '../../../lib/code-freshness.mjs'
import { dirname as dirNameOf } from 'node:path'

/** 本插件目录（仓库与 profile 两种布局下都成立）。 */
const AV_PLUGIN_DIR = dirNameOf(dirNameOf(fileURLToPath(import.meta.url)))
import { ProxyEngine, readSystemProxy } from './proxy-engine.mjs'
import { buildQueryView, freshnessNote, callerAttributionNote, retentionNote, renderQuery } from './query-view.mjs'
import { envOr } from '../../../lib/env-fallback.mjs'

/** Stable cordis plugin name. */
export const name = 'api-visualizer'

/** Services required before the API surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Route family prefix. */
const API = '/api/dsh-api-visualizer'

/** Store cap: keep the newest records (rotation trims the head). */
const MAX_RECORDS = 20000
/**
 * 保留集**字节上限**（AV-03 剩余缺口，Claude 第六轮方案 A）。
 * 触发看字节、裁剪只看条数 —— 两维不一致会让"整理"回收 ≈0 字节并永不自愈（每 5 分钟白跑一次全量重写）。
 * 可用 DSH_API_CAPTURE_MAX_BYTES 覆盖；约束：≥8×单条上限（≥32MB），保证单条自身永不超预算。
 */
const MAX_STORE_BYTES = Number(process.env.DSH_API_CAPTURE_MAX_BYTES) > 0
  ? Number(process.env.DSH_API_CAPTURE_MAX_BYTES)
  : MAX_STORE_BYTES_DEFAULT
/** Max records per ingest call. */
const MAX_BATCH = 500
/** Cap on JSON request bodies (ingest batches can be sizable; 2MB per field). */
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024
/** Per-field body cap: Fiddler-like full bodies for normal API payloads. */
const MAX_FIELD_BYTES = 2 * 1024 * 1024

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 140

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-api-visualizer 插件（DSH Web GUI 的接口捕获面板，Fiddler 式实时抓包）：侧边栏「接口捕获」入口，可视化展示 本机客户端进程 的 HTTP 接口调用。' +
  '能力：记录存本地 JSONL 库（按天分片 records-YYYYMMDD.jsonl，上限 20000 条）；面板内「开始实时捕获」按钮驱动宿主实时引擎，tail 客户端 System.Net 跟踪日志（%TEMP%\\uiprobe-net-trace.log，由客户端配置的 system.diagnostics 注入产生）自动解析出 方法/URL/状态/请求头/响应头/请求体/响应体（gzip 自动解包）并实时入库，source=realtime，并关联调用方归因（ViewModel/API/调用链，来自 %TEMP%\\uiprobe-caller.log）；' +
  '捕获控制面**有工具**：api_capture_start（起）/ api_capture_stop（停）/ api_capture_status（查状态 —— running:true 但跟踪日志不存在时**抓不到任何数据**，两者不是一回事）；对应路由 POST /api/dsh-api-visualizer/capture/start（body 可选 {logPath, replay}）、POST /capture/stop、GET /capture/status、POST /capture/rotate（body {keepDays}，轮转 trace/caller 日志并清理过期 .bak）；' +
  '⚠ **跟踪日志不会在运行中自动轮转**（R1-02 / F-056 实测）：唯一那次"超 300MB 自动轮转"发生在 **start() 且当时没在跑**的那一刻，跑起来之后只涨不停（本机实测 ≈11–12 MB/分钟），而且默认就写在 **%TEMP%（C 盘）**。长跑前请自己 `POST /capture/rotate`（或面板「轮转日志」）；api_capture_start 每次都会把当前大小与这件事印在返回里。' +
  'agent 工具：api_capture_append（追加记录）、api_capture_query（查询/过滤已捕获记录，支持 q/method/source/status/host/minDurationMs/errors/caller 等，返回调用方归因）；也可经 POST /api/dsh-api-visualizer/ingest 灌入。' +
  '本地代理模式（抓任意进程，Fiddler 式）：POST /proxy/start（body 可选 {port, upstream}，默认 8899、上游自动读系统代理）、POST /proxy/stop、GET /proxy/status、GET /proxy/ca-cert.der（根证书下载）、POST /proxy/install-ca（导入本机信任，免管理员）、POST /proxy/system-proxy（body {enable}，把系统代理指向本代理/恢复原值）；HTTPS 走 CONNECT + 按域签发证书解密，source=proxy；WebSocket 升级请求同样被抓取（帧统计+文本解码，source=proxy, method=WS）。' +
  'AutoResponder 规则引擎（对代理流量生效）：GET/POST/DELETE /proxy/rules（规则：方法/URL 匹配 + mock 响应/伪造状态码/注入延迟/阻断），用于模拟错误、mock 行情、验证客户端容错。' +
  '记录编辑：PATCH /records/{id}（body {note?, tag?, flag?}）；列表过滤支持 flag=1、host、Content-Type、耗时、响应字节、时间范围、body、sessionId、traceId；GET /stats/timeline 提供 P50/P95/P99 和吞吐趋势，GET /stats/sessions 提供会话聚合，GET /stats/repeats 检测高频重复请求（定时器风暴）。面板支持重放结果 JSON 差异、HAR/JSON/CSV/OpenAPI 契约导出、瀑布图、重复检测、基线/契约回归（POST /baseline/save、POST /baseline/diff）、调用方源码定位（POST /source/locate、POST /source/open，环境变量 DSH_API_SRC_ROOT 指向客户端源码根）。' +
  '限制：实时捕获依赖客户端已注入 system.diagnostics 跟踪配置（重启客户端后生效）；请求/响应体截断 ≤ 2MB；日志与记录含真实 token（本机本地存储，不外传，用户明确要求不脱敏）。' +
  '用户提到「接口可视化 / 抓接口 / 接口面板 / 接口捕获 / 实时抓包 / Fiddler」时即指本插件，请据此协作。'

/** Primary store location (env override, then ~/.dsh). */
function storeDir() {
  // 与 lib/capture-store.mjs 用同一种读法（用户级配置必须经 env-fallback）：两处不一致就会出现
  // "面板读得到、工具读不到"这种两面行为不同的假象。
  if (envOr('DSH_API_CAPTURE_STORE')) return envOr('DSH_API_CAPTURE_STORE')
  return join(envOr('DSH_HOME') || join(homedir(), '.dsh'), 'api-capture')
}
const storeFile = (ts) => join(storeDir(), shardName(ts ?? Date.now()))

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
function normalize(raw) {
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

/** Parse the JSONL store into records (newest last); deduped by id, last occurrence wins. */
let storeCache = { key: null, records: [], index: null }
let duplicateAppendsSinceCompact = 0
// AV-03：整库重写（compaction）的成本与库体积同阶，绝不能每次 flush 都做。
// 这三项记录"上次何时压、压了几次、为什么压"，供诊断用 —— 没有它们，写放大是不可见的。
let lastCompactAt = 0
let compactCount = 0
let lastCompactReason = null
// AV-03 补充：'条件成立但被节流'的累计次数必须可见（否则节流是不可观测的）。
let compactThrottled = false
let compactWantedButThrottled = 0
// AV-03 剩余缺口：字节维度的裁剪结果。没有这三个数，"按字节裁剪到底回收了多少"只能靠猜。
let lastCompactKeptBytes = null
let lastCompactDropped = 0
let lastCompactTruncatedBy = null

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

function invalidateStoreCache() {
  storeCache = { key: null, records: [], index: null }
}

function readAll() {
  const files = shardFiles()
  const key = storeKey(files)
  if (storeCache.key === key) return storeCache.records
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
        // skip malformed lines (manual edits, concurrent writers)
      }
    }
  }
  const out = order.map((id) => byId.get(id)).filter((record) => record !== undefined)
  const index = new Map()
  for (let i = 0; i < out.length; i++) index.set(out[i].id, i)
  storeCache = { key, records: out, index }
  return out
}

/**
 * Apply a just-appended batch to the in-memory cache without re-reading disk.
 * The host is the store's sole writer, so after appendToShards() the new state
 * = cached records + this batch (deduped by id, newest content wins, first-seen
 * order preserved — identical to readAll() semantics). This replaces a per-flush
 * invalidate + full re-parse of every shard (incl. 2MB bodies), which was ~O(N²)
 * over a capture session. The cache key is refreshed to the post-write disk stat,
 * so any later external edit still busts the cache through storeKey.
 */
function applyAppendToCache(records) {
  if (storeCache.key === null || storeCache.index === null) return // no valid base → next readAll rebuilds
  const out = storeCache.records
  const index = storeCache.index
  for (const rec of records) {
    const at = index.get(rec.id)
    if (at === undefined) { index.set(rec.id, out.length); out.push(rec) }
    else out[at] = rec
  }
  storeCache.key = storeKey(shardFiles())
}

/** Append normalized records into day shards (grouped by each record's own ts). */
function appendToShards(records) {
  if (records.length === 0) return
  mkdirSync(storeDir(), { recursive: true })
  const byFile = new Map()
  for (const rec of records) {
    const file = join(storeDir(), shardName(rec.ts))
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(rec)
  }
  for (const [file, list] of byFile) {
    appendFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
}

/** Migrate the legacy single-file store into day shards (once per process). */
let legacyMigrated = false
function migrateLegacy() {
  if (legacyMigrated) return
  legacyMigrated = true
  const legacy = join(storeDir(), 'records.jsonl')
  if (!existsSync(legacy)) return
  const recs = []
  for (const line of readFileSync(legacy, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const r = JSON.parse(t)
      if (r && typeof r.id === 'string') recs.push(r)
    } catch {
      // skip
    }
  }
  try {
    rmSync(legacy, { force: true })
  } catch {
    // keep legacy as read-only archive if it cannot be removed
  }
  if (recs.length > 0) appendToShards(recs)
}

/** Rewrite the whole store: drop every shard, then write records grouped by day. */
function persistAll(records) {
  const dir = storeDir()
  if (!existsSync(dir)) {
    if (records.length === 0) return
    mkdirSync(dir, { recursive: true })
  } else {
    try {
      const legacy = join(dir, 'records.jsonl')
      if (existsSync(legacy)) rmSync(legacy, { force: true })
      for (const name of readdirSync(dir)) {
        if (/^records-\d{8}\.jsonl$/.test(name)) rmSync(join(dir, name), { force: true })
      }
    } catch {
      // best effort; append below may still succeed
    }
  }
  appendToShards(records)
  duplicateAppendsSinceCompact = 0
  invalidateStoreCache()
}

/**
 * Append normalized records; enforce the global newest-N cap across shards.
 *
 * Codex 第八轮指出的**两个 store 语义漂移**里最实质的一条：
 * MCP 共享 store（`lib/capture-store.mjs`）的 `appendRecords(rawRecords, { runId })` 支持
 * **注入 runId**（把一批记录绑到同一个证据 run 上），而宿主这份**完全不接受** runId ——
 * 于是「runId 证据链」只对 agent 自己 POST 的记录有效，
 * **实时捕获/代理捕获的真实客户端流量永远没有 runId**（正是最该被串起来的那部分）。
 * 现在两侧同签名：`opts.runId` 只给**缺 runId** 的记录补，不覆盖记录自带的。
 *
 * 另一条（迁移/压缩状态/缓存）确实只属于宿主运行时（宿主是唯一写者：它有 legacy 迁移、
 * 增量索引缓存与 AV-03 节流状态）；MCP 那份是无状态的读写器。这是**有意的分工**，
 * 已在两侧注释里写明，避免下次有人看到"不一样"就顺手改成一样而破坏其中一边。
 */
function appendRecords(rawRecords, opts = {}) {
  migrateLegacy()
  const records = []
  const runId = typeof opts.runId === 'string' && opts.runId !== '' ? opts.runId : ''
  for (const raw of rawRecords) {
    const rec = normalize(raw)
    if (rec !== null) {
      if (runId && rec.runId === undefined) rec.runId = runId
      records.push(rec)
    }
  }
  if (records.length === 0) return { ingested: 0, total: readAll().length }
  // 宿主是 store 唯一写者：按已维护的 id 索引统计重复（供压缩阈值判断），
  // 写盘后增量更新缓存，避免每次 flush 全量重读所有分片（含 2MB body）。
  readAll() // 确保 storeCache 已就绪/有效，作为增量更新的基线
  const seen = new Set()
  for (const record of records) {
    if ((storeCache.index !== null && storeCache.index.has(record.id)) || seen.has(record.id)) duplicateAppendsSinceCompact += 1
    seen.add(record.id)
  }
  appendToShards(records)
  applyAppendToCache(records)
  let all = readAll()
  let physicalBytes = 0
  for (const file of shardFiles()) {
    try { physicalBytes += statSync(file).size } catch { /* file may rotate between list/stat */ }
  }
  // AV-03（2026-09-11 审计确证）：这里的 `physicalBytes > 128MB` 是**状态型条件**，
  // 而 persistAll 之后的物理大小 = 保留集（≤MAX_RECORDS 条）的大小。
  // 一旦保留集本身超过 128MB，条件就**永真** → 每 800ms 的 flush 都整库重写一次
  // （库越大越慢，且永远不会自愈）。flush 是由 800ms 定时器驱动的，等于持续做 128MB+ 的同步 IO。
  //
  // 修法：**节流**。真正必须立即执行的是硬上限（条数），其余（去重积压、体积）改为
  // 最快每 COMPACT_MIN_INTERVAL_MS 一次；并留出 10% 余量，避免在阈值上下反复抖动。
  const verdict = shouldCompact({
    allCount: all.length, maxRecords: MAX_RECORDS, physicalBytes, maxBytes: MAX_STORE_BYTES,
    duplicateAppends: duplicateAppendsSinceCompact, now: Date.now(), lastCompactAt,
  })
  if (verdict.compact) {
    // AV-03 剩余缺口（Claude 第六轮方案 A）：裁剪必须与触发**同维**。
    // 旧写法只 `slice(0, MAX_RECORDS)`（条数），而触发看的是字节 ——
    // 保留集自身 140MB 时每 5 分钟全量重写、回收 ≈0 字节、永不自愈（写放大只是被摊薄）。
    // 现在双上限、最旧优先，且目标 0.9× 上限 → 裁剪后必定落到触发阈值以下。
    const trimmed = trimToCaps(sortNewestFirst(all), { maxRecords: MAX_RECORDS, maxBytes: MAX_STORE_BYTES })
    all = trimmed.keep.reverse() // 保留集仍按时间正序写回
    persistAll(all)
    all = readAll()
    lastCompactAt = Date.now()
    compactCount++
    lastCompactReason = verdict.reason
    // 字节维度的结果必须可观测：没有它，"按字节裁剪到底有没有回收"只能靠猜。
    lastCompactKeptBytes = trimmed.keptBytes
    lastCompactDropped = trimmed.dropped
    lastCompactTruncatedBy = trimmed.truncatedBy
    duplicateAppendsSinceCompact = 0
    compactThrottled = false
    compactWantedButThrottled = 0
  } else if (verdict.throttled) {
    // AV-03 补充（Claude 第五轮指出）：`verdict.throttled` 过去在调用点**被丢弃** ——
    // 于是"节流可观测"只是一句承诺，根本没到 /capture/status。纯函数的 12/12 测试
    // 只证明了"函数会返回 throttled"，证明不了"这个值真的被用上"（那正是假信心）。
    // 现在把它累计下来并对外暴露。
    compactThrottled = true
    compactWantedButThrottled++
  } else {
    compactThrottled = false
  }
  return { ingested: records.length, total: all.length }
}

/** Drop every record (all shards). */
function clearRecords() {
  const all = readAll()
  for (const file of shardFiles()) {
    try {
      rmSync(file, { force: true })
    } catch {
      // best effort
    }
  }
  duplicateAppendsSinceCompact = 0
  invalidateStoreCache()
  return { cleared: all.length }
}

/** Store API, exported for capture backends and tests. */
export { storeDir, storeFile, readAll, appendRecords, clearRecords }

/** Strip bodies + ws frames from list payloads (keep the table light). */
function withoutBodies(records) {
  return records.map((r) => {
    const { reqBody, resBody, ws, ...rest } = r
    return rest
  })
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh's fence). */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
  // AV-04：统一兜底，任何未捕获异常都不会变成宿主的空 400。
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read and parse a JSON request body with a size cap. */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`body too large (> ${maxBytes} bytes)`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      // 空 body 与"坏 JSON"是**两件事**：前者的接口在文档里就写着 body 可选
      // （`POST /capture/start` 不带 body 也能起），后者才是调用方写错了。
      // 旧实现两者都 reject ⇒ 空 body 也被回 400 'invalid JSON body'
      // —— 我自己在实验里用无 body 的 POST 恢复捕获时当场撞上（可以不带参数的接口却要先构造一个 `{}`）。
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
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

/** Linear-interpolated percentile for an already sorted numeric array. */
function percentileOf(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const rank = Math.max(0, Math.min(1, p)) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low))
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

/**
 * Shared filter pipeline for GET /records and DELETE /records?filtered=1.
 * Params: q, regex, method, source, status, flag, host (comma list),
 * contentType (comma list, substring), minDurationMs, minBytes, maxBytes,
 * fromTs, toTs, sessionId, traceId, errors, noNoise, bodyQ.
 */
/**
 * 按时间新→旧（ts 相同按 id 倒序）排序副本。位置切片（offset/limit）与游标过滤
 * 都依赖时间序，而分片文件顺序可能因乱序写入（导入/重放/跨日分片）与 ts 序不一致，
 * 任何按位置取页的消费点都必须先经此排序（绝不原地排序，避免改坏 storeCache）。
 */
function sortNewestFirst(list) {
  return [...list].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0))
}

function applyFilters(all, params) {
  // 「字段缺失」的计数桶（见下方 status / durationMs / bytesRes 三处过滤的说明，F-046）。
  // 声明在函数最前面，因为 status 过滤先用它 —— 放在下面会踩 const 的暂时性死区。
  const noField = { durationMs: 0, bytesRes: 0, status: 0 }
  const q = (params.get('q') ?? '').trim()
  const regexMode = params.get('regex') === '1'
  let re = null
  if (q !== '') {
    if (regexMode) {
      try {
        re = new RegExp(q, 'i')
      } catch {
        re = null
      }
    }
  }
  const methodFilter = (params.get('method') ?? '').toUpperCase()
  const sourceFilter = (params.get('source') ?? '').trim()
  const statusFilter = (params.get('status') ?? '').trim()
  const normalizedStatus = statusFilter.toLowerCase()
  const hostFilter = (params.get('host') ?? '').trim().toLowerCase()
  const ctFilter = (params.get('contentType') ?? '').trim().toLowerCase()
  const minDurRaw = params.get('minDurationMs')
  const minDur = minDurRaw === null || minDurRaw === '' ? null : Number(minDurRaw)
  const minBytesRaw = params.get('minBytes')
  const minBytes = minBytesRaw === null || minBytesRaw === '' ? null : Number(minBytesRaw)
  const maxBytesRaw = params.get('maxBytes')
  const maxBytes = maxBytesRaw === null || maxBytesRaw === '' ? null : Number(maxBytesRaw)
  const fromRaw = params.get('fromTs')
  const toRaw = params.get('toTs')
  const fromTs = fromRaw === null || fromRaw === '' ? null : Number(fromRaw)
  const toTs = toRaw === null || toRaw === '' ? null : Number(toRaw)
  const sessionId = (params.get('sessionId') ?? '').trim()
  const traceId = (params.get('traceId') ?? '').trim()
  const errorsOnly = params.get('errors') === '1'
  const noNoise = params.get('noNoise') === '1'
  const bodyQ = (params.get('bodyQ') ?? '').trim().toLowerCase()

  let items = all
  if (q !== '') {
    if (re !== null) {
      items = items.filter((r) => re.test(r.url) || (typeof r.note === 'string' && re.test(r.note)))
    } else {
      const lq = q.toLowerCase()
      items = items.filter((r) => r.url.toLowerCase().includes(lq) || (typeof r.note === 'string' && r.note.toLowerCase().includes(lq)))
    }
  }
  if (methodFilter !== '' && methodFilter !== 'ALL') items = items.filter((r) => r.method === methodFilter)
  if (sourceFilter !== '' && sourceFilter !== 'all') items = items.filter((r) => (r.source ?? '') === sourceFilter)
  if (statusFilter !== '') {
    // 同上：**没有 status 字段**的记录不是"不是 2xx"，而是"不知道" —— 单独计数，别混进"不匹配"。
    noField.status += items.filter((r) => !Number.isInteger(r.status)).length
    items = normalizedStatus.endsWith('xx')
      ? items.filter((r) => Number.isInteger(r.status) && Math.floor(r.status / 100) === Number(normalizedStatus[0]))
      : items.filter((r) => String(r.status) === statusFilter)
  }
  if (params.get('flag') === '1') items = items.filter((r) => r.flag === true || r.flag === 1)
  if (hostFilter !== '') {
    const hosts = hostFilter.split(',').map((h) => h.trim()).filter((h) => h !== '')
    items = items.filter((r) => hosts.includes(hostOf(r)))
  }
  if (ctFilter !== '') {
    const cts = ctFilter.split(',').map((c) => c.trim()).filter((c) => c !== '')
    items = items.filter((r) => {
      const ct = String(headerValue(r.resHeaders, 'content-type') ?? r.contentType ?? '').toLowerCase()
      return cts.some((c) => ct.includes(c))
    })
  }
  // ⚠ 「字段缺失」不是「不满足条件」—— 这两个被混在一起过（F-046，2026-09-12 G1 黑盒测试提出）：
  //   旧实现 `minDurationMs` 用 `Number.isFinite(r.durationMs) && r.durationMs >= min` ⇒
  //   **没有 durationMs 的记录被静默丢掉**，而空结果有两种完全不同的原因（"没有慢请求" vs "这些记录压根没这个字段"），
  //   调用方只能看到空。更糟的是 `maxBytes` 用 `(Number(r.bytesRes) || 0) <= max`
  //   ⇒ **"字节数未知"被当成"0 字节"**，于是未知大小的记录会**通过**"响应 ≤ N 字节"的过滤 ——
  //   那不是漏报，是**答错**。
  //   现在：这类记录一律**排除**（未知不能证明满足条件），并**计数**带出去（excludedNoField），让空结果可解释。
  if (minDur !== null && Number.isFinite(minDur)) {
    noField.durationMs += items.filter((r) => !Number.isFinite(r.durationMs)).length
    items = items.filter((r) => Number.isFinite(r.durationMs) && r.durationMs >= minDur)
  }
  if (minBytes !== null && Number.isFinite(minBytes)) {
    noField.bytesRes += items.filter((r) => !Number.isFinite(Number(r.bytesRes))).length
    items = items.filter((r) => Number.isFinite(Number(r.bytesRes)) && Number(r.bytesRes) >= minBytes)
  }
  if (maxBytes !== null && Number.isFinite(maxBytes)) {
    noField.bytesRes += items.filter((r) => !Number.isFinite(Number(r.bytesRes))).length
    items = items.filter((r) => Number.isFinite(Number(r.bytesRes)) && Number(r.bytesRes) <= maxBytes)
  }
  if (Number.isFinite(fromTs)) items = items.filter((r) => Number(r.ts) >= fromTs)
  if (Number.isFinite(toTs)) items = items.filter((r) => Number(r.ts) <= toTs)
  if (sessionId !== '') items = items.filter((r) => sessionKeyOf(r) === sessionId)
  if (traceId !== '') items = items.filter((r) => r.traceId === traceId)
  // runId：MCP 面早就有这个过滤，插件面**一直没有** —— 而 append 的描述却写着"与查询过滤 runId 配套使用"。
  // 面与面不一致本身就是缺陷（E4 精神），描述引用一个本面不存在的参数更糟（F-047，两个 G1 黑盒 agent 都撞到）。
  const runIdFilter = (params.get('runId') ?? '').trim()
  if (runIdFilter !== '') items = items.filter((r) => r.runId === runIdFilter)
  if (errorsOnly) {
    noField.status += items.filter((r) => !Number.isInteger(r.status)).length
    items = items.filter((r) => Number.isInteger(r.status) && r.status >= 400)
  }
  if (noNoise) items = items.filter((r) => !NOISE_PATTERNS.some((p) => p.test(r.url)))
  if (bodyQ !== '') {
    items = items.filter((r) => {
      const hay = `${typeof r.reqBody === 'string' ? r.reqBody : ''}\n${typeof r.resBody === 'string' ? r.resBody : ''}\n${JSON.stringify(r.reqHeaders ?? {})}\n${JSON.stringify(r.resHeaders ?? {})}`.toLowerCase()
      return hay.includes(bodyQ)
    })
  }
  // 把"因字段缺失而被排除"的计数挂在返回的数组上（非枚举属性 ⇒ 不会混进 JSON/序列化）。
  // 调用方（路由/工具）负责把它带出去 —— **空结果必须可解释**，否则就是"没读到当成没有"。
  Object.defineProperty(items, 'excludedNoField', { value: noField, enumerable: false, configurable: true })
  return items
}

/** Method+path key of a record (endpoint aggregation). */
function endpointKeyOf(rec) {
  let pathname
  try {
    pathname = new URL(rec.url).pathname
  } catch {
    pathname = String(rec.url).split('?')[0]
  }
  return `${rec.method} ${pathname}`
}

/** Flatten a JSON value into dotted "path:type" shape entries (contract fingerprint). */
function jsonShape(value, depth = 0) {
  const out = []
  if (depth > 7) return out
  if (Array.isArray(value)) {
    if (value.length > 0) {
      for (const p of jsonShape(value[0], depth + 1)) out.push(`[]${p === '' ? '' : '.' + p}`)
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      const v = value[key]
      const child = jsonShape(v, depth + 1)
      if (child.length === 0) {
        out.push(`${key}:${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}`)
      } else {
        for (const p of child) out.push(`${key}.${p}`)
      }
    }
    return out
  }
  return []
}

/** Contract fingerprint of one endpoint from its records (status, content-type, response shape). */
function endpointContract(records) {
  const statuses = new Set()
  const contentTypes = new Set()
  const shape = new Set()
  for (const r of records) {
    if (Number.isInteger(r.status)) statuses.add(r.status)
    const ct = String(headerValue(r.resHeaders, 'content-type') ?? r.contentType ?? '').split(';')[0].trim().toLowerCase()
    if (ct !== '') contentTypes.add(ct)
    if (typeof r.resBody === 'string' && r.resBody !== '') {
      try {
        for (const p of jsonShape(JSON.parse(r.resBody))) shape.add(p)
      } catch {
        // non-JSON body: no shape
      }
    }
  }
  return { statuses: [...statuses].sort(), contentTypes: [...contentTypes].sort(), shape: [...shape].sort() }
}

/** Aggregate current store into endpoint contracts (baseline building block). */
function buildContracts(all) {
  const byKey = new Map()
  for (const r of all) {
    const key = endpointKeyOf(r)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }
  const out = {}
  for (const [key, recs] of byKey) out[key] = endpointContract(recs)
  return out
}

// ---------------------------------------------------------------- baselines

function baselineDir() {
  return join(storeDir(), 'baselines')
}

function baselineFile(name) {
  const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
  return join(baselineDir(), `${safe}.json`)
}

function listBaselines() {
  const dir = baselineDir()
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const b = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (b && typeof b.name === 'string') out.push({ name: b.name, savedAt: b.savedAt ?? null, endpoints: Object.keys(b.endpoints ?? {}).length, records: b.records ?? 0 })
    } catch {
      // skip corrupt baseline
    }
  }
  return out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
}

function readBaseline(name) {
  const file = baselineFile(name)
  if (!existsSync(file)) return null
  try {
    const b = JSON.parse(readFileSync(file, 'utf8'))
    return b && typeof b.name === 'string' ? b : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- source locate

function srcRoots() {
  // 源码根是**用户级配置**：必须走 env-fallback（进程环境 → 用户级注册表 → 机器级）。
  // 直接读 process.env 的后果：长活宿主的环境块里没有用户后来设置的变量 →
  // 「源码定位」永远返回空 → 面板上"定位不到源码"，而用户明明配了（工具在说谎）。
  const env = envOr('DSH_API_SRC_ROOT') || envOr('DSH_HANG_SRC_ROOT')
  if (env.trim() !== '') {
    return env.split(';').map((p) => p.trim()).filter((p) => p !== '' && existsSync(p))
  }
  return []
}

const sourceSearchCache = new Map() // key -> {files, at}

/** Locate .cs files defining the given type / method under the source roots (bounded two-stage scan). */
function searchSource({ vm, api }) {
  const roots = srcRoots()
  if (roots.length === 0) {
    return { files: [], roots: [], searched: 0, hint: 'set DSH_API_SRC_ROOT to the client source root (multiple roots separated by ;)' }
  }
  const apiType = typeof api === 'string' && api.includes('.') ? api.split('.')[0] : ''
  const apiMethod = typeof api === 'string' && api.includes('.') ? api.slice(api.lastIndexOf('.') + 1) : ''
  const key = `${roots.join(';')}|${vm ?? ''}|${apiType ?? ''}|${apiMethod ?? ''}`
  const cached = sourceSearchCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < 30000) return cached.value
  const needleVms = typeof vm === 'string' && vm !== '' ? [vm, ...(vm.endsWith('ViewModel') ? [vm.slice(0, -9)] : [])] : []
  const needleApi = apiType !== '' ? [apiType] : []
  const needleNames = [...needleVms, ...needleApi]

  // Stage 0: walk the tree and collect candidate .cs paths (no file reads).
  const csFiles = []
  const stack = [...roots]
  while (stack.length > 0 && csFiles.length < 40000) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['bin', 'obj', '.git', '.vs', 'node_modules', 'packages', 'packages-api'].includes(entry.name.toLowerCase())) continue
        stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.cs')) csFiles.push(full)
    }
  }
  const hits = []
  const pushHit = (path, what, line) => {
    if (!hits.some((h) => h.path === path)) hits.push({ path, matches: [{ what, line }] })
    else hits.find((h) => h.path === path).matches.push({ what, line })
  }

  // Stage 1: filename equals the type name (C# convention) — cheap and usually decisive.
  const rest = []
  for (const file of csFiles) {
    const base = file.slice(file.lastIndexOf('\\') + 1, -3)
    if (needleNames.includes(base)) {
      try {
        const text = readFileSync(file, 'utf8')
        const needle = needleVms.includes(base) ? `class ${base}` : base
        const idx = text.split('\n').findIndex((l) => l.includes(needle))
        pushHit(file, needle, idx >= 0 ? idx + 1 : 1)
      } catch {
        // unreadable
      }
    } else {
      rest.push(file)
    }
  }

  // Stage 2: content scan (only when filename hits are sparse).
  let searched = 0
  if (hits.length < 12) {
    for (const file of rest) {
      if (hits.length >= 30 || searched >= 5000) break
      searched++
      let text = null
      const need = (read) => {
        if (text === null) text = read
        const lines = text.split('\n')
        const found = []
        for (const nv of needleVms) {
          const idx = lines.findIndex((l) => l.includes(`class ${nv}`))
          if (idx >= 0) found.push({ what: `class ${nv}`, line: idx + 1 })
        }
        if (found.length === 0) {
          for (const na of needleApi) {
            if (lines.some((l) => l.includes(`class ${na}`))) {
              const needleLine = apiMethod !== '' ? apiMethod : `class ${na}`
              const idx = lines.findIndex((l) => l.includes(needleLine))
              found.push({ what: `class ${na}` + (apiMethod !== '' ? `.${apiMethod}` : ''), line: idx >= 0 ? idx + 1 : 1 })
            }
          }
        }
        return found
      }
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      if (size > 2 * 1024 * 1024) continue
      try {
        const found = need(readFileSync(file, 'utf8'))
        if (found.length > 0) pushHit(file, found[0].what, found[0].line)
      } catch {
        // unreadable
      }
    }
  }
  hits.sort((a, b) => {
    const rank = (h) => (h.matches.some((m) => m.what.startsWith('class') && needleVms.includes(m.what.slice(6))) ? 0 : 1)
    return rank(a) - rank(b)
  })
  const value = { files: hits, roots, searched: searched + (csFiles.length - rest.length) }
  sourceSearchCache.set(key, { value, at: Date.now() })
  return value
}

/** Build the route family. */
/**
 * 路由 handler 的错误兜底（AV-04 通用化）。
 *
 * 宿主的 web 层把任何 handler rejection 统一变成**空 400**
 * （`dsh-host-webserver/lib/index.js:247-255`）—— 状态码没有语义、body 是空的，
 * 里面那句可操作的原因一个字都传不出去，调用方只能猜。
 * 同文件里大部分路由各自包了 try/catch，但**漏一个就漏一条信息**，且新加路由时没人会记得。
 * 所以统一在这里兜一层：未捕获的异常一律转成**结构化** 500 + hint，而不是空 400。
 */
function guardHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      try {
        if (!res.headersSent) {
          writeJson(res, 500, {
            ok: false,
            error: 'route handler threw: ' + msg.slice(0, 400),
            hint: '这是插件内部未捕获的异常。请把这条原文回报给插件维护者；' +
              '同时确认请求体是合法 JSON、目标资源存在、以及相关前置（如"捕获未在运行"）已满足。',
          })
        } else {
          try { res.end() } catch { /* 已发出的响应无法补救 */ }
        }
      } catch { /* 连兜底都失败：至少别再抛 */ }
    }
  }
}

function makeRoutes(capture, proxy) {
  const routes = [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname
        const rest = pathname.startsWith(API) ? pathname.slice(API.length) : pathname
        const params = url.searchParams

        // GET / — probe
        if (method === 'GET' && (rest === '' || rest === '/')) {
          writeJson(res, 200, { name: 'dsh-api-visualizer', api: API, ok: true })
          return
        }

        // GET /stats — counters for the panel chips
        if (method === 'GET' && rest === '/stats') {
          const all = readAll()
          const byMethod = {}
          const bySource = {}
          const byStatus = {}
          const byHost = {}
          for (const r of all) {
            byMethod[r.method] = (byMethod[r.method] ?? 0) + 1
            bySource[r.source] = (bySource[r.source] ?? 0) + 1
            const status = r.status
            const bucket = Number.isInteger(status) ? `${Math.floor(status / 100)}xx` : '-'
            byStatus[bucket] = (byStatus[bucket] ?? 0) + 1
            let host = '-'
            try {
              host = new URL(r.url).hostname
            } catch {
              // relative or malformed url
            }
            byHost[host] = (byHost[host] ?? 0) + 1
          }
          writeJson(res, 200, {
            total: all.length,
            lastTs: all.length > 0 ? all[all.length - 1].ts : null,
            storeFile: storeFile(),
            byMethod,
            bySource,
            byStatus,
            byHost,
          })
          return
        }

        // GET /records?limit&offset&cursor&q&regex&method&source&status&flag&host&contentType&minDurationMs&minBytes&maxBytes&fromTs&toTs&sessionId&traceId&errors&noNoise&bodyQ&includeBody
        if (method === 'GET' && rest === '/records') {
          const all = readAll()
          const includeBody = params.get('includeBody') === '1'
          const limitRaw = Number(params.get('limit'))
          const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), 2000)
          const offsetRaw = Number(params.get('offset'))
          const offset = Math.max(Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0, 0)
          let items = sortNewestFirst(applyFilters(all, params))
          const cursor = params.get('cursor')
          if (cursor !== null && cursor !== '') {
            const [tsText, id] = cursor.split('|')
            const ts = Number(tsText)
            if (Number.isFinite(ts)) items = items.filter((r) => Number(r.ts) < ts || (Number(r.ts) === ts && String(r.id) < String(id ?? '')))
          }
          const total = items.length
          const page = items.slice(offset, offset + limit)
          const oldest = page.length > 0 ? page[page.length - 1] : null
          const nextCursor = oldest !== null ? `${oldest.ts}|${oldest.id}` : null
          // 面板路由同样要带新鲜度/归因（第十轮自查：它此前只回 total/items/cursor，
          // 于是面板与脚本消费者看不到"引擎没在跑 = 这是历史数据"和"归因没有生产者"）。
          let stForRoute = null
          try { stForRoute = capture && typeof capture.status === 'function' ? capture.status() : null } catch { stForRoute = null }
          const view = buildQueryView({ records: page, all, status: stForRoute, callerFilter: String(params.get('caller') ?? ''), retention: retentionInfo() })
          // 过滤掉的"字段缺失"记录必须出声：空结果有两种成因（"确实没有" vs "这些记录没有该字段"），
          // 只说一个 total 会让调用方把后者读成前者（F-046，G1 黑盒测试提的场景 A）。
          const noField = items.excludedNoField
          const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0)
          writeJson(res, 200, {
            total,
            items: includeBody ? page : withoutBodies(page),
            nextCursor,
            hasMore: offset + page.length < items.length,
            ...(noFieldAny ? { excludedNoField: noField } : {}),
            ...(noFieldAny
              ? {
                  excludedNoFieldNote: '有记录因**缺少被过滤的那个字段**而被排除（不是"不满足条件"）：' +
                    `durationMs ${noField.durationMs} 条 / bytesRes ${noField.bytesRes} 条 / status ${noField.status} 条。` +
                    '想去掉这个歧义：把 minDurationMs / minBytes / maxBytes / status / errors 这些过滤条件去掉再查一次，两次条数之差就是它们的数量。',
                }
              : {}),
            ...view,
            freshnessNote: freshnessNote(view.freshness),
            callerAttributionNote: callerAttributionNote(view.callerAttribution),
            retentionNote: retentionNote(view.retention),
          })
          return
        }

        // GET /stats/endpoints — aggregate by method + path (P1 observability)
        if (method === 'GET' && rest === '/stats/endpoints') {
          const all = applyFilters(readAll(), params)
          const byKey = new Map()
          for (const r of all) {
            let pathname
            try {
              pathname = new URL(r.url).pathname
            } catch {
              pathname = r.url.split('?')[0]
            }
            const key = `${r.method} ${pathname}`
            let e = byKey.get(key)
            if (e === undefined) {
              e = { method: r.method, path: pathname, count: 0, errors: 0, durs: [], lastTs: 0, lastStatus: null, sampleUrl: r.url }
              byKey.set(key, e)
            }
            e.count += 1
            if (Number.isInteger(r.status) && r.status >= 400) e.errors += 1
            if (Number.isFinite(r.durationMs)) e.durs.push(r.durationMs)
            if ((r.ts ?? 0) > e.lastTs) {
              e.lastTs = r.ts ?? 0
              e.lastStatus = r.status
            }
          }
          const items = [...byKey.values()].map((e) => {
            e.durs.sort((a, b) => a - b)
            return {
              method: e.method,
              path: e.path,
              count: e.count,
              errors: e.errors,
              errorRate: e.count > 0 ? Number((e.errors / e.count).toFixed(3)) : 0,
              avgMs: e.durs.length > 0 ? Math.round(e.durs.reduce((a, b) => a + b, 0) / e.durs.length) : null,
              p95Ms: percentileOf(e.durs, 0.95),
              maxMs: e.durs.length > 0 ? e.durs[e.durs.length - 1] : null,
              lastTs: e.lastTs,
              lastStatus: e.lastStatus,
              sampleUrl: e.sampleUrl,
            }
          })
          items.sort((a, b) => b.count - a.count)
          writeJson(res, 200, withRetention({ total: items.length, items }))
          return
        }

        // GET /stats/timeline — time-bucketed request/error/latency/bytes trend.
        if (method === 'GET' && rest === '/stats/timeline') {
          const bucketMs = Math.max(1000, Math.min(Number(params.get('bucketMs') ?? 60000) || 60000, 86400000))
          const filtered = applyFilters(readAll(), params)
          const buckets = new Map()
          for (const r of filtered) {
            const ts = Number(r.ts)
            if (!Number.isFinite(ts)) continue
            const start = Math.floor(ts / bucketMs) * bucketMs
            let bucket = buckets.get(start)
            if (bucket === undefined) {
              bucket = { start, count: 0, errors: 0, bytesRes: 0, bytesUnknown: 0, durations: [] }
              buckets.set(start, bucket)
            }
            bucket.count += 1
            if (Number.isInteger(r.status) && r.status >= 400) bucket.errors += 1
            // F-046 同型：求和时"未知"不该悄悄按 0 算 —— 0 是"真的是 0"，缺字段是"不知道"。
            // 求和本身没法不把它当 0，但**必须把"有几条是不知道"带出去**，否则 bytesRes 会被读成"总流量"。
            if (Number.isFinite(Number(r.bytesRes))) bucket.bytesRes += Number(r.bytesRes)
            else bucket.bytesUnknown += 1
            if (Number.isFinite(r.durationMs)) bucket.durations.push(r.durationMs)
          }
          const items = [...buckets.values()].sort((a, b) => a.start - b.start).map((b) => {
            b.durations.sort((a, c) => a - c)
            return { start: b.start, end: b.start + bucketMs, count: b.count, errors: b.errors, errorRate: b.count === 0 ? 0 : Number((b.errors / b.count).toFixed(3)), bytesRes: b.bytesRes, bytesUnknown: b.bytesUnknown, avgMs: b.durations.length === 0 ? null : Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length), p50Ms: percentileOf(b.durations, 0.5), p95Ms: percentileOf(b.durations, 0.95), p99Ms: percentileOf(b.durations, 0.99) }
          })
          // **空桶不许静默消失**（Claude r17 的 A1）：原先只对"有记录的桶"建行，真机上出现过相邻两行
          // 之间隔着 **27 个空桶（27 小时）**、而返回里没有任何标记 —— 读者无从区分
          // 「客户端没发流量」「捕获停了」「记录被裁了」这三种完全不同的情况。
          const gaps = []
          if (items.length > 0) {
            const spanStart = items[0].start
            const spanEnd = items[items.length - 1].start
            const expected = Math.floor((spanEnd - spanStart) / bucketMs) + 1
            for (let i = 0; i < expected; i++) {
              const s = spanStart + i * bucketMs
              if (!buckets.has(s)) gaps.push({ start: s, end: s + bucketMs })
            }
          }
          const engine = (() => { try { return capture && typeof capture.status === 'function' ? capture.status() : null } catch { return null } })()
          writeJson(res, 200, withRetention({
            bucketMs,
            total: items.length,
            items,
            emptyBuckets: gaps.length,
            gaps: gaps.length ? gaps.slice(0, 50) : [],
            gapsNote: gaps.length
              ? '⚠ 时间线**只含有记录的桶**：区间内还有 ' + gaps.length + ' 个空桶（gaps 给了前 ' + Math.min(gaps.length, 50) + ' 个）。' +
                '空桶的三种含义完全不同 —— **客户端没发流量 / 捕获停了 / 记录被裁掉了** —— 本响应无法替你区分；' +
                '请结合 freshness.captureRunning 与 retention 判断，不要读成"这段时间没有请求"。'
              : null,
            captureRunning: engine ? engine.running === true : null,
          }))
          return
        }

        // GET /stats/sessions — group by explicit session/trace, then caller/time fallback.
        if (method === 'GET' && rest === '/stats/sessions') {
          const groups = new Map()
          for (const r of applyFilters(readAll(), params)) {
            const key = sessionKeyOf(r)
            let group = groups.get(key)
            if (group === undefined) {
              group = { sessionId: key, explicit: Boolean(r.sessionId || r.traceId), firstTs: r.ts ?? 0, lastTs: r.ts ?? 0, count: 0, errors: 0, bytesRes: 0, bytesUnknown: 0, methods: {}, hosts: {}, records: [] }
              groups.set(key, group)
            }
            group.firstTs = Math.min(group.firstTs, r.ts ?? group.firstTs)
            group.lastTs = Math.max(group.lastTs, r.ts ?? group.lastTs)
            group.count += 1
            if (Number.isInteger(r.status) && r.status >= 400) group.errors += 1
            // 同上（F-046）：求和把"未知"按 0 算可以，但必须把"有几条是未知"带出去，
            // 否则 bytesRes 会被读成"这个会话的总流量"，而它是"已知部分的合计"。
            if (Number.isFinite(Number(r.bytesRes))) group.bytesRes += Number(r.bytesRes)
            else group.bytesUnknown += 1
            group.methods[r.method] = (group.methods[r.method] ?? 0) + 1
            const host = hostOf(r) || '-'
            group.hosts[host] = (group.hosts[host] ?? 0) + 1
            if (group.records.length < 20) group.records.push({ id: r.id, ts: r.ts, method: r.method, url: r.url, status: r.status })
          }
          const items = [...groups.values()].sort((a, b) => b.lastTs - a.lastTs)
          writeJson(res, 200, withRetention({ total: items.length, items }))
          return
        }

        // GET /records/{id} — full record incl. bodies
        const idMatch = rest.match(/^\/records\/([^/]+)$/)
        if (method === 'GET' && idMatch !== null) {
          const id = decodeURIComponent(idMatch[1])
          const found = readAll().find((r) => r.id === id)
          if (found === undefined) {
            writeJson(res, 404, { error: 'record not found' })
            return
          }
          writeJson(res, 200, found)
          return
        }

        // PATCH /records/{id} — update note / tag / flag
        if (method === 'PATCH' && idMatch !== null) {
          const id = decodeURIComponent(idMatch[1])
          let patch
          try {
            patch = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          const all = readAll()
          const idx = all.findIndex((r) => r.id === id)
          if (idx === -1) {
            writeJson(res, 404, { error: 'record not found' })
            return
          }
          const rec = all[idx]
          if (typeof patch.note === 'string') {
            if (patch.note === '') delete rec.note
            else rec.note = patch.note
          }
          if (typeof patch.tag === 'string') {
            if (patch.tag === '') delete rec.tag
            else rec.tag = patch.tag
          }
          if (typeof patch.flag === 'boolean') {
            if (patch.flag) rec.flag = true
            else delete rec.flag
          }
          persistAll(all)
          writeJson(res, 200, rec)
          return
        }

        // POST /ingest — append a batch { records: [...] }
        if (method === 'POST' && rest === '/ingest') {
          let body
          try {
            body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          const raw = Array.isArray(body) ? body : body?.records
          if (!Array.isArray(raw)) {
            writeJson(res, 400, { error: 'expected { records: [...] } or an array' })
            return
          }
          if (raw.length > MAX_BATCH) {
            writeJson(res, 400, { error: `batch too large (> ${MAX_BATCH})` })
            return
          }
          const result = appendRecords(raw, { runId: typeof body?.runId === 'string' ? body.runId : '' })
          writeJson(res, 200, result)
          return
        }

        // DELETE /records/{id} — remove one record
        if (method === 'DELETE' && idMatch !== null) {
          const id = decodeURIComponent(idMatch[1])
          const all = readAll()
          const kept = all.filter((r) => r.id !== id)
          if (kept.length === all.length) {
            writeJson(res, 404, { error: 'record not found' })
            return
          }
          persistAll(kept)
          writeJson(res, 200, { deleted: all.length - kept.length })
          return
        }

        // DELETE /records — clear the store, or ?filtered=1 to delete the current filter set
        if (method === 'DELETE' && rest === '/records') {
          if (params.get('filtered') === '1') {
            const all = readAll()
            const matched = applyFilters(all, params)
            if (matched.length === 0) {
              writeJson(res, 200, { deleted: 0 })
              return
            }
            const ids = new Set(matched.map((r) => r.id))
            persistAll(all.filter((r) => !ids.has(r.id)))
            writeJson(res, 200, { deleted: matched.length })
            return
          }
          writeJson(res, 200, clearRecords())
          return
        }

        // GET /capture/status — realtime engine state + store counters
        if (method === 'GET' && rest === '/capture/status') {
          const all = readAll()
          writeJson(res, 200, {
            ok: true,
            // 一句话说清"现在到底能不能抓到东西" —— 与工具面**共用 capture-control.mjs**，
            // 否则面板/路由/MCP 三个消费者又会各说各话（本仓第 38 类：同一逻辑两份实现必然漂移）。
            // 实测：MCP 面的 capture_status 原先拿不到 summary/ok（路由里没有），审查时当场发现。
            summary: captureStatusSummary(capture.status()),
            ...capture.status(),
            managed: true,
            storeTotal: all.length,
            storeRealtime: all.filter((r) => (r.source ?? '') === 'realtime').length,
            // AV-03：把"整库重写"这件事变可见 —— 没有这三个数，写放大在外部是完全观测不到的。
            store: {
              total: all.length,
              cap: MAX_RECORDS,
              // AV-03 剩余缺口：字节维度的上限与上次裁剪结果。
              // 只有条数 cap 时真实磁盘上界 ≈22000×4MB ≈ 85.9GB —— 128MB 从来不是"上界"，
              // 而是"该整理了"。这两个数并排，调用方才能判断"整理到底止不止得住"。
              maxBytes: MAX_STORE_BYTES,
              lastCompactKeptBytes,
              lastCompactDropped,
              lastCompactTruncatedBy,
              compactCount,
              lastCompactAt: lastCompactAt || null,
              lastCompactAgoMs: lastCompactAt ? Date.now() - lastCompactAt : null,
              lastCompactReason,
              duplicateAppendsSinceCompact,
              // AV-03 补充：把'被节流'如实暴露 —— 没有它，写放大在外部不可观测。
              throttled: compactThrottled,
              wantedButThrottled: compactWantedButThrottled,
              intervalMs: COMPACT_MIN_INTERVAL_MS,
              // F-007：这份 status 出自哪个版本的代码，一并说清（不陈旧时不加字段）
              ...(staleCodeInfo(moduleRoots(AV_PLUGIN_DIR)) || {}),
            },
          })
          return
        }

        // POST /capture/start { logPath?, replay? } — begin Fiddler-style live capture
        if (method === 'POST' && rest === '/capture/start') {
          let body = {}
          try {
            // 空 body 现在由 readJsonBody 解析成 `{}`（它是**合法**的：文档就写着 body 可选）；
            // 这里剩下的 400 只对应"body 非空但不是合法 JSON" —— 那是调用方真的写错了。
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          // 逻辑搬到 lib/capture-control.mjs（路由于工具**共用一句话**，见该文件头部说明）。
          // 旧实现还把 setLogPath 的异常漏在外面 ⇒ 宿主把 rejection 变成**空 400**、原因传不出去（AV-04）。
          const r = captureStart(capture, body)
          if (r.ok === false) {
            writeJson(res, r.hint ? 409 : 500, r)
            return
          }
          writeJson(res, 200, { ...r, managed: true })
          return
        }

        // POST /capture/stop — stop live capture
        if (method === 'POST' && rest === '/capture/stop') {
          const r = captureStop(capture)
          writeJson(res, r.ok === false ? 500 : 200, { ...r, managed: true })
          return
        }

        // GET /proxy/status — local MITM proxy state
        if (method === 'GET' && rest === '/proxy/status') {
          writeJson(res, 200, { ...proxy.status(), managed: true })
          return
        }

        // POST /proxy/start { port?, upstream? } — start the local proxy
        if (method === 'POST' && rest === '/proxy/start') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const status = await proxy.start({
              port: Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : 8899,
              upstream: typeof body.upstream === 'string' ? body.upstream : undefined,
            })
            writeJson(res, 200, { ...status, managed: true })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /proxy/stop
        if (method === 'POST' && rest === '/proxy/stop') {
          writeJson(res, 200, { ...(await proxy.stop()), managed: true })
          return
        }

        // GET /proxy/ca-cert.der — root CA download (loopback only)
        if (method === 'GET' && rest === '/proxy/ca-cert.der') {
          try {
            const derPath = proxy.caCertDerPath()
            res.writeHead(200, {
              'content-type': 'application/x-x509-ca-cert',
              'content-disposition': 'attachment; filename="dsh-api-visualizer-ca.der"',
            })
            const { createReadStream } = await import('node:fs')
            createReadStream(derPath).pipe(res)
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /proxy/install-ca — import the CA into CurrentUser\Root
        if (method === 'POST' && rest === '/proxy/install-ca') {
          try {
            writeJson(res, 200, await proxy.installCa())
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /proxy/system-proxy { enable } — point/restore the WinINET system proxy
        if (method === 'POST' && rest === '/proxy/system-proxy') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const result = await proxy.setSystemProxy(body.enable === true)
            writeJson(res, 200, { ...result, managed: true })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /logs/clear — run the bundled cleanup script (trace log + capture-dir logs)
        if (method === 'POST' && rest === '/logs/clear') {
          const script = fileURLToPath(new URL('./scripts/clean-capture-logs.ps1', import.meta.url))
          const traceLog = join(process.env.TEMP || process.env.TMP || '', 'uiprobe-net-trace.log')
          const traceBefore = existsSync(traceLog)
          const run = await new Promise((resolve) => {
            execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TraceLog', traceLog, '-LogDir', storeDir()], { timeout: 60000, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
              resolve({ ok: error === null, output: (stdout ?? '').trim().slice(0, 400), err: error ? String(error.message ?? error).slice(0, 200) : null })
            })
          })
          const traceAfter = existsSync(traceLog)
          writeJson(res, 200, {
            ...run,
            traceLogDeleted: traceBefore && !traceAfter,
            traceLogSkipped: traceBefore && traceAfter,
            hint: traceBefore && traceAfter ? '客户端正在运行，跟踪日志被占用未删除（重启客户端后可清除）' : '',
          })
          return
        }

        // GET /stats/repeats — burst/repeated-request detection (timer-storm finder)
        if (method === 'GET' && rest === '/stats/repeats') {
          const windowMs = Math.max(500, Math.min(Number(params.get('windowMs') ?? 10000) || 10000, 3600000))
          const minCount = Math.max(2, Math.min(Number(params.get('minCount') ?? 5) || 5, 100000))
          const all = applyFilters(readAll(), params)
          const byKey = new Map()
          for (const r of all) {
            const key = endpointKeyOf(r)
            if (!byKey.has(key)) byKey.set(key, [])
            byKey.get(key).push(r)
          }
          const items = []
          for (const [key, recs] of byKey) {
            const times = recs.map((r) => Number(r.ts)).filter(Number.isFinite).sort((a, b) => a - b)
            if (times.length < minCount) continue
            let maxInWindow = 0
            let left = 0
            for (let right = 0; right < times.length; right++) {
              while (times[right] - times[left] > windowMs) left++
              maxInWindow = Math.max(maxInWindow, right - left + 1)
            }
            if (maxInWindow < minCount) continue
            const last = recs.slice().sort((a, b) => Number(b.ts) - Number(a.ts))[0] ?? {}
            const caller = last.caller ?? {}
            items.push({
              method: recs[0].method,
              path: key.slice(recs[0].method.length + 1),
              count: times.length,
              firstTs: times[0],
              lastTs: times[times.length - 1],
              windowMs,
              maxInWindow,
              peakRatePerMin: windowMs > 0 ? Number(((maxInWindow * 60000) / windowMs).toFixed(1)) : null,
              caller: [caller.viewModel, caller.apiMethod].filter(Boolean).join(' ← ') || null,
              lastStatus: last.status,
              lastUrl: last.url,
            })
          }
          items.sort((a, b) => b.maxInWindow - a.maxInWindow)
          writeJson(res, 200, withRetention({ windowMs, minCount, total: items.length, items }))
          return
        }

        // GET /baseline/list — saved contract baselines
        if (method === 'GET' && rest === '/baseline/list') {
          writeJson(res, 200, { total: listBaselines().length, items: listBaselines() })
          return
        }

        // POST /baseline/save { name, filter? } — snapshot endpoint contracts under the filter
        if (method === 'POST' && rest === '/baseline/save') {
          let body = {}
          try {
            body = (await readJsonBody(req, 256 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const name = String(body.name ?? '').trim()
          if (name === '') {
            writeJson(res, 400, { error: 'name required' })
            return
          }
          const filtered = applyFilters(readAll(), paramsFromObj(body.filter ?? {}))
          const baseline = {
            name,
            savedAt: Date.now(),
            records: filtered.length,
            filter: body.filter ?? {},
            endpoints: buildContracts(filtered),
          }
          mkdirSync(baselineDir(), { recursive: true })
          writeFileSync(baselineFile(name), JSON.stringify(baseline, null, 2), 'utf8')
          writeJson(res, 200, { name, savedAt: baseline.savedAt, records: baseline.records, endpoints: Object.keys(baseline.endpoints).length })
          return
        }

        // POST /baseline/diff { name } — contract drift vs the saved baseline
        if (method === 'POST' && rest === '/baseline/diff') {
          let body = {}
          try {
            body = (await readJsonBody(req, 256 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const baseline = readBaseline(String(body.name ?? ''))
          if (baseline === null) {
            writeJson(res, 404, { error: 'baseline not found' })
            return
          }
          const current = buildContracts(applyFilters(readAll(), paramsFromObj(baseline.filter ?? {})))
          const changes = []
          const beforeKeys = new Set(Object.keys(baseline.endpoints))
          const afterKeys = new Set(Object.keys(current))
          for (const key of [...afterKeys].filter((k) => !beforeKeys.has(k))) {
            changes.push({ endpoint: key, kind: '新增端点', detail: '本次会话出现了基线之外的接口' })
          }
          for (const key of [...beforeKeys].filter((k) => !afterKeys.has(k))) {
            changes.push({ endpoint: key, kind: '端点缺失', detail: '基线中的接口本次没有再出现（可能被移除或未走到）' })
          }
          for (const key of beforeKeys) {
            if (!afterKeys.has(key)) continue
            const b = baseline.endpoints[key]
            const c = current[key]
            const detail = []
            const bStatus = new Set(b.statuses)
            const cStatus = new Set(c.statuses)
            for (const s of c.statuses) if (!bStatus.has(s)) detail.push(`状态码 +${s}`)
            for (const s of b.statuses) if (!cStatus.has(s)) detail.push(`状态码 -${s}`)
            for (const ct of c.contentTypes) if (!b.contentTypes.includes(ct)) detail.push(`Content-Type +${ct}`)
            for (const ct of b.contentTypes) if (!c.contentTypes.includes(ct)) detail.push(`Content-Type -${ct}`)
            for (const p of c.shape) if (!b.shape.includes(p)) detail.push(`响应字段 +${p}`)
            for (const p of b.shape) if (!c.shape.includes(p)) detail.push(`响应字段 -${p}`)
            if (detail.length > 0) {
              changes.push({ endpoint: key, kind: '契约变化', detail: detail.slice(0, 40).join('; ') + (detail.length > 40 ? ' …' : '') })
            }
          }
          writeJson(res, 200, {
            name: baseline.name,
            savedAt: baseline.savedAt,
            baselineRecords: baseline.records,
            currentRecords: applyFilters(readAll(), paramsFromObj(baseline.filter ?? {})).length,
            baselineEndpoints: Object.keys(baseline.endpoints).length,
            currentEndpoints: Object.keys(current).length,
            changes,
          })
          return
        }

        // DELETE /baseline/{name}
        const baselineMatch = rest.match(/^\/baseline\/([^/]+)$/)
        if (method === 'DELETE' && baselineMatch !== null) {
          const file = baselineFile(decodeURIComponent(baselineMatch[1]))
          if (!existsSync(file)) {
            writeJson(res, 404, { error: 'baseline not found' })
            return
          }
          rmSync(file, { force: true })
          writeJson(res, 200, { deleted: 1 })
          return
        }

        // POST /source/locate { vm?, api?, stack? } — find client source files defining the caller
        if (method === 'POST' && rest === '/source/locate') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          writeJson(res, 200, searchSource({ vm: body.vm, api: body.api }))
          return
        }

        // POST /source/open { path, line } — open a located file (VS Code with line, else explorer)
        if (method === 'POST' && rest === '/source/open') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const target = String(body.path ?? '')
          const roots = srcRoots()
          const inside = roots.some((root) => {
            const rel = relative(root, target)
            // path.relative returns the ABSOLUTE target when the drives
            // differ — an absolute result is outside every root on this
            // drive and must be rejected (cross-drive traversal).
            return !isAbsolute(rel) && rel !== '' && !rel.startsWith('..')
          })
          if (!inside || !existsSync(target)) {
            writeJson(res, 400, { error: 'path outside source roots or missing' })
            return
          }
          const line = Number.isInteger(body.line) && body.line > 0 ? body.line : 1
          const localAppData = process.env.LOCALAPPDATA ?? ''
          const codeCandidates = [
            ...(typeof process.env.DSH_CODE_EXE === 'string' && process.env.DSH_CODE_EXE.trim() !== '' ? [process.env.DSH_CODE_EXE.trim()] : []),
            localAppData !== '' ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
            'C:\\Program Files\\Microsoft VS Code\\Code.exe',
          ].filter((p) => p !== '' && existsSync(p))
          let opened = null
          if (codeCandidates.length > 0) {
            // `start` detaches the GUI process; cmd exits 0 immediately once launched
            opened = await new Promise((resolve) => {
              execFile('cmd.exe', ['/c', 'start', '', codeCandidates[0], '-g', `"${target}:${line}"`], { timeout: 10000, windowsHide: true }, (error) => {
                resolve(error === null ? 'vscode' : null)
              })
            })
          }
          if (opened === null) {
            // `start` returns immediately (exit 0) even though explorer opens async
            opened = await new Promise((resolve) => {
              execFile('cmd.exe', ['/c', 'start', '', 'explorer', `/select,"${target}"`], { timeout: 10000, windowsHide: true }, (error) => {
                resolve(error === null ? 'explorer' : null)
              })
            })
          }
          writeJson(res, 200, opened !== null ? { ok: true, method: opened, path: target, line } : { ok: false, error: 'open failed (no VS Code found; explorer launch failed)' })
          return
        }

        // POST /capture/rotate { keepDays? } — rotate the trace/caller logs (rename + prune old)
        if (method === 'POST' && rest === '/capture/rotate') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const keepDays = Math.max(0, Math.min(Number(body.keepDays ?? 7) || 7, 365))
          writeJson(res, 200, capture.rotate({ keepDays, pruneOnly: body.pruneOnly === true }))
          return
        }

        // GET /proxy/rules — AutoResponder rule list (+ hit counters)
        if (method === 'GET' && rest === '/proxy/rules') {
          writeJson(res, 200, proxy.getRules())
          return
        }

        // POST /proxy/rules { rules: [...] } — replace the rule set
        if (method === 'POST' && rest === '/proxy/rules') {
          let body = {}
          try {
            body = (await readJsonBody(req, 256 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const list = Array.isArray(body) ? body : body.rules
          if (!Array.isArray(list)) {
            writeJson(res, 400, { error: 'expected { rules: [...] } or an array' })
            return
          }
          writeJson(res, 200, proxy.setRules(list))
          return
        }

        // DELETE /proxy/rules — clear all rules
        if (method === 'DELETE' && rest === '/proxy/rules') {
          writeJson(res, 200, proxy.setRules([]))
          return
        }

        // GET /proxy/breakpoints — 断点配置 + 当前挂起的请求
        if (method === 'GET' && rest === '/proxy/breakpoints') {
          writeJson(res, 200, proxy.getBreakpoints())
          return
        }

        // POST /proxy/breakpoints { enabled?, urlFilter?, methodFilter? } — 更新断点配置
        if (method === 'POST' && rest === '/proxy/breakpoints') {
          let body = {}
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          writeJson(res, 200, proxy.setBreakpoints(body))
          return
        }

        // POST /proxy/breakpoints/release { id, action:'continue'|'drop', edits? } — 放行/丢弃一个挂起请求
        if (method === 'POST' && rest === '/proxy/breakpoints/release') {
          let body = {}
          try {
            body = (await readJsonBody(req, MAX_JSON_BODY_BYTES)) ?? {}
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const ok = proxy.releaseBreakpoint(String(body.id ?? ''), body.action === 'drop' ? 'drop' : 'continue', body.edits ?? null)
          writeJson(res, ok ? 200 : 404, ok ? proxy.getBreakpoints() : { error: 'breakpoint not found (already released or timed out?)' })
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]

  // AV-04：统一兜底，任何未捕获异常都不会变成宿主的空 400。
  return routes.map((r) => ({ ...r, handler: guardHandler(r.handler) }))
}

/** The api_capture_append agent tool: push captured API records into the store. */
function apiCaptureTool() {
  return defineTool({
    name: 'api_capture_append',
    description: dshDescription('capture_append'),
    parameters: { ...dshParameters('capture_append'), records: {
        type: 'array',
        required: true,
        description: 'Captured API records. Each record: method + url are required; status/durationMs/reqBody/resBody/note optional. Keep reqBody/resBody ≤ 2MB.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            method: { type: 'string', required: true, description: 'HTTP method, e.g. GET/POST.' },
            // r50：G1 黑盒点名 —— 没有 ts 时，导入/回放**历史**抓包只能落成「此刻发生」（时间线错位）。
            // 存储层本来就支持显式 ts（capture-store.mjs: `Number.isFinite(raw.ts) ? raw.ts : Date.now()`），
            // 而这里是 `additionalProperties: false` ⇒ 不声明 = 传不进来。
            ts: { type: 'number', description: '这条记录的**发生时间**（epoch 毫秒）。不传 = 写入此刻。⚠ 导入/回放**历史**流量时必须显式传：查询按这个字段做 fromTs/toTs 过滤，不传会把几分钟前的事写成「此刻发生」。' },
            url: { type: 'string', required: true, description: 'Request URL (absolute or relative).' },
            runId: { type: 'string', description: 'Evidence-pack run id: 把这一批记录绑到同一个 run 上（缺 runId 的记录才补，不覆盖记录自带的）。与查询过滤 runId 配套使用。' },
            status: { type: 'integer', description: 'HTTP status code, if known.' },
            durationMs: { type: 'number', description: 'Round-trip duration in ms, if known.' },
            source: { type: 'string', description: 'Capture origin tag: etw / proxy / client-log / agent / other.' },
            process: { type: 'string', description: 'Source process name, e.g. client.exe.' },
            reqHeaders: { type: 'object', additionalProperties: true, description: 'Request headers, if known.' },
            reqBody: { type: 'string', description: 'Request body (truncated to 2MB).' },
            resHeaders: { type: 'object', additionalProperties: true, description: 'Response headers, if known.' },
            resBody: { type: 'string', description: 'Response body (truncated to 2MB).' },
            firstByteMs: { type: 'number', description: 'Time to first response byte.' },
            bytesReq: { type: 'number', description: 'Request bytes observed.' },
            bytesRes: { type: 'number', description: 'Response bytes observed.' },
            chunkCount: { type: 'integer', description: 'Observed response/request chunks.' },
            complete: { type: 'boolean', description: 'Whether the response completed.' },
            streaming: { type: 'boolean', description: 'Whether the response is streaming-like.' },
            sessionId: { type: 'string', description: 'Explicit request session identifier.' },
            traceId: { type: 'string', description: 'Distributed trace identifier.' },
            parentId: { type: 'string', description: 'Parent request identifier.' },
            caller: { type: 'object', additionalProperties: true, description: 'Caller attribution: {viewModel, view, apiMethod, trigger, stack[]}.' },
            tag: { type: 'string', description: 'Short tag label.' },
            flag: { type: 'boolean', description: 'Mark the record (starred).' },
            ttfbMs: { type: 'number', description: 'Time to first response byte (alias of firstByteMs).' },
            connectMs: { type: 'number', description: 'TCP connect time (proxy captures).' },
            tlsMs: { type: 'number', description: 'TLS handshake time (proxy captures).' },
            ruleId: { type: 'string', description: 'AutoResponder rule id when the record was mocked/rewritten.' },
            ws: { type: 'object', additionalProperties: true, description: 'WebSocket metadata: {frames, closeCode, closeReason, frameCount, msgCount}.' },
            note: { type: 'string', description: 'Human note, e.g. what this interface does.' },
          },
        },
      } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ingested: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `ingested: ${value.ingested}, store total: ${value.total}` }],
    },
    async execute(args) {
      // runId 与 MCP 共享 store 对齐：把这一批绑到同一个证据 run 上（缺 runId 的记录才补）
      return appendRecords(args.records, { runId: typeof args.runId === 'string' ? args.runId : '' })
    },
  })
}

/** Build a URLSearchParams from a plain object (shared by tool + routes). */
const FILTER_PARAM_ALIASES = Object.freeze({
  flagged: 'flag',
  ct: 'contentType',
  minDur: 'minDurationMs',
  errorsOnly: 'errors',
})

function paramsFromObj(obj) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value === undefined || value === null || value === '' || value === false) continue
    params.set(FILTER_PARAM_ALIASES[key] ?? key, value === true ? '1' : String(value))
  }
  return params
}

/**
 * The api_capture_query agent tool: read/filter captured records.
 *
 * F-005 / F-004c（2026-09-11 真机实测确证）：这个工具过去只回 `matched N record(s)`，
 * 于是有两种"看起来正常、其实在骗人"的结果：
 *   · **陈旧**：捕获引擎不自动启动，库里躺着**昨天**的记录，查询照常返回格式完美的数据，
 *     没有任何字段提示年龄 → agent 会把昨天的流量当成今天的分析并下结论。
 *   · **归因不可用**：调用方归因的旁路日志**没有生产者**（客户端源码里搜不到 ApiCallerTrace），
 *     所有记录都没有 caller；用 `caller=` 过滤必然 0 条 → agent 会读成
 *     「这个 ViewModel 没发过请求」，而事实是「这个过滤维度当前没有数据」。
 * 现在两者都在返回里如实标注；带 `caller=` 且归因不可用时，额外给一句明确提示。
 */
function apiQueryTool(capture) {
  return defineTool({
    name: 'api_capture_query',
    description: dshDescription('capture_query'),
    parameters: dshParameters('capture_query'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          hasMore: { type: 'boolean', required: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          freshness: { type: 'object', additionalProperties: true, description: '新鲜度：最新记录年龄 + 捕获引擎是否在跑' },
          callerAttribution: { type: 'object', additionalProperties: true, description: '调用方归因是否真的有数据' },
          // ⚠ F-055（2026-09-14 真机实测抓到）：`execute` 的返回里一直带着 `retention` / `retentionNote`
          //   （见本工具末尾 `return { ...obj, retention, retentionNote: … }`），但**schema 里从没声明**，
          //   而本 schema 是 `additionalProperties: false` ⇒ **宿主判"非法输出"，整个工具直接不可用**：
          //     Error: tool "api_capture_query" returned invalid output:
          //       "value.retention" is not a declared property (additionalProperties: false)
          //   ⇒ 调用方拿不到任何数据。**这比"少一个字段"严重得多：它让整个工具死了。**
          retention: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], description: '保留期：被裁剪/丢弃的统计与最早保留记录时间（生产者可能返回 null）' },
          // ⚠ 两个字段都必须是**可空**的：`retentionNote` 在"没有发生裁剪"时是 **null**。
          //   第一版我写的是 `type: 'string'` / `type: 'object'` —— **宿主照样会拒**
          //   （`"value.retentionNote" must be a string`），**修复只做了一半**。
          //   是新加的输出校验关（拿宿主自己的校验器跑真实返回值）把它抓出来的。
          //   本方言里可空只能写 `oneOf`（`type` 与 `oneOf` **不能同时出现**，
          //   且 `oneOf` 旁边不许有 properties/required/additionalProperties/items/enum/const）。
          retentionNote: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '保留期的人话说明（被裁剪过就必须出声；没裁剪时为 null）' },
        },
      },
      // 渲染逻辑在可测的 lib/query-view.mjs 里（本文件依赖 dsh-tools，普通 node 进程 import 不到）。
      render: (args, value) => renderQuery(args, value),
    },
    async execute(args) {
      const params = paramsFromObj(args)
      const all = readAll()
      let items = sortNewestFirst(applyFilters(all, params))
      const caller = (args.caller ?? '').trim().toLowerCase()
      if (caller !== '') {
        items = items.filter((r) => {
          const c = r.caller ?? {}
          const hay = [c.viewModel, c.view, c.apiMethod, c.trigger, ...(Array.isArray(c.stack) ? c.stack : [])].filter(Boolean).join('\n').toLowerCase()
          return hay.includes(caller)
        })
      }
      const total = items.length
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500)
      const offset = Math.max(Number(args.offset) || 0, 0)
      const page = items.slice(offset, offset + limit)
      const out = args.includeBody === true ? page : withoutBodies(page)

      // F-005 / F-004c：新鲜度 + 调用方归因 —— **走共享的单一产出点**（第十轮自查：这段原来只写在这里，
      // 于是 MCP 面与面板路由都拿不到它）。见 lib/query-view.mjs。
      let st = null
      try { st = capture && typeof capture.status === 'function' ? capture.status() : null } catch { st = null }
      // 保留期同样要带出来（工具面与路由面不许各说各话）
      const retention = retentionInfo()
      const { freshness, callerAttribution } = buildQueryView({ records: page, all, status: st, callerFilter: String(args.caller ?? ''), retention })

      // F-046：**空结果必须可解释**。`minDurationMs`/`minBytes`/`maxBytes`/`status`/`errors` 这些过滤，
      // 会把**没有那个字段**的记录排除掉（旧实现里 maxBytes 更糟：把"字节未知"当成 0 字节，于是**放行**了它）。
      // 于是"0 条"有两种完全不同的含义 —— 不把计数带出来，调用方只能猜成"没有慢请求/没有错误"。
      const noField = items.excludedNoField
      const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0)
      return {
        total,
        returned: out.length,
        hasMore: offset + page.length < items.length,
        items: out,
        ...(noFieldAny ? { excludedNoField: noField } : {}),
        ...(noFieldAny
          ? {
              excludedNoFieldNote: '有记录因**缺少被过滤的那个字段**被排除（不是"不满足条件"）：' +
                `durationMs ${noField.durationMs} 条 / bytesRes ${noField.bytesRes} 条 / status ${noField.status} 条。` +
                '要把这层歧义去掉：去掉 minDurationMs / minBytes / maxBytes / status / errors 再查一次，两次条数之差就是它们的数量。',
            }
          : {}),
        freshness,
        callerAttribution,
        retention,
        retentionNote: retentionNote(retention),
      }
    },
  })

}

/**
 * 给"基于**保留集**的统计/列表"挂上保留期信息（r17 / Codex 复核发现）。
 *
 * 病：`/stats/timeline`、`/stats/sessions`、`/stats/repeats`、`/stats/endpoints` 都只回
 * `{total, items}` —— 库裁剪过之后 `total: 0` 会被读成"这段时间没有流量/没有重复请求"，
 * 而真相是**那些记录已被裁掉**。这和 capture_query 是同一个病，我上一轮只修了 capture_query
 * （典型的"同一个修法只做了一半"），这里统一挂上。
 */
function withRetention(obj) {
  const retention = retentionInfo()
  return { ...obj, retention, retentionNote: retentionNote(retention) }
}

/** 人类可读的年龄（用于陈旧警告）。 */
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '?'
  const min = ms / 60000
  if (min < 1) return '刚刚'
  if (min < 60) return Math.round(min) + ' 分钟前'
  const h = min / 60
  if (h < 24) return (Math.round(h * 10) / 10) + ' 小时前'
  return (Math.round(h / 24 * 10) / 10) + ' 天前'
}

/**
 * 保留期信息（本进程视角）。
 *
 * ⚠ 本文件**有自己的一份 store 实现**（不 import lib/capture-store.mjs），所以"裁剪过多少"曾经只活在
 * 本进程的 `lastCompactDropped` 内存变量里 —— MCP 面与面板路由都拿不到（r17 主题自查发现）。
 * 现在两侧共用**同一个标记文件**（store 目录下的 trimmed.json）：
 *   · MCP 侧 `lib/capture-store.mjs` 裁剪时写它（readRetention 读它）；
 *   · 本文件读它 + 合并本进程的内存计数（本进程裁剪时也会写）。
 * 这样"库被裁剪过"这件事在**两个面**都看得见，不会一方说"没有"、另一方知道"被裁掉了"。
 */
function retentionInfo() {
  let marker = null
  try { marker = JSON.parse(readFileSync(join(storeDir(), 'trimmed.json'), 'utf8')) } catch { marker = null }
  const memDropped = Number(lastCompactDropped) || 0
  const fileDropped = marker && Number.isFinite(Number(marker.droppedTotal)) ? Number(marker.droppedTotal) : 0
  // 本进程内存计数与文件计数取**较大者**：两者记录的是不同进程/不同时刻的裁剪，取大不会漏报
  const droppedTotal = Math.max(memDropped, fileDropped)
  let oldest = null
  try {
    const all = readAll()
    for (const r of all) { const ts = Number(r && r.ts); if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts }
  } catch { oldest = null }
  return {
    droppedTotal,
    lastDroppedAt: marker && Number.isFinite(Number(marker.lastDroppedAt)) ? Number(marker.lastDroppedAt) : null,
    truncatedBy: marker ? (marker.truncatedBy || null) : null,
    oldestKeptTs: oldest,
    maxRecords: MAX_RECORDS,
    maxBytes: MAX_STORE_BYTES_DEFAULT,
    note: droppedTotal > 0
      ? '库按上限裁剪过（累计 ' + droppedTotal + ' 条）—— 被裁掉的记录已不在库内，查不到 ≠ 没发生过；' +
        (oldest !== null ? '当前库内最早一条 ' + new Date(oldest).toLocaleString('zh-CN') + '。' : '')
      : null,
  }
}

// ⚠ 这里原来有一份 `fmtMs`。它是**死代码**：唯一的使用者是 `api_capture_query` 那段内联 render，
//   而 0fad407 把那段换成了 `renderQuery(...)`（见 lib/query-view.mjs）⇒ 本函数再没人调。
//   按第 24 类（同一件事不许两份实现）把它删掉，格式化统一走 `query-view.mjs` 导出的 `fmtMs`。

/**
 * Host-managed realtime capture: CaptureEngine -> batched store append.
 * Records are written straight into the JSONL store (source='realtime'),
 * so the panel sees them on its next poll — Fiddler-style live flow.
 */
function createCapture() {
  let queue = []
  let engine = null
  let flushTimer = null
  let logPath = process.env.DSH_CAPTURE_LOG ?? DEFAULT_LOG
  let callerLogPath = process.env.DSH_CAPTURE_CALLER_LOG ?? DEFAULT_CALLER_LOG
  // 本次 start() 时刻的 emitted 基线（见 status() 里完整性判据的说明）
  let emittedAtStart = 0

  const AUTO_ROTATE_BYTES = 300 * 1024 * 1024

  const flushQueue = () => {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    try {
      appendRecords(batch)
    } catch {
      queue.unshift(...batch)
    }
  }

  /** Rename a trace log to a timestamped .bak; returns 'rotated' | 'skipped' | 'missing'. */
  const rotateFile = (file) => {
    if (!existsSync(file)) return 'missing'
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const dest = `${file}.${stamp}.bak`
    try {
      renameSync(file, dest)
      return 'rotated'
    } catch {
      return 'skipped' // locked by the client process
    }
  }

  const pruneOldBaks = (keepDays) => {
    const tempDir = process.env.TEMP || process.env.TMP || ''
    const dirs = [...new Set([tempDir, dirname(logPath), dirname(callerLogPath)])].filter((d) => d !== '' && existsSync(d))
    const cutoff = Date.now() - keepDays * 86400000
    let pruned = 0
    for (const dir of dirs) {
      try {
        for (const name of readdirSync(dir)) {
          if (!/^uiprobe-(net-trace|caller)\.log\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.bak$/.test(name)) continue
          const full = join(dir, name)
          try {
            if (statSync(full).mtimeMs < cutoff) {
              rmSync(full, { force: true })
              pruned++
            }
          } catch {
            // skip
          }
        }
      } catch {
        // best effort
      }
    }
    return pruned
  }

  const startFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setInterval(flushQueue, 800)
  }
  const stopFlush = ({ drain = false } = {}) => {
    if (flushTimer !== null) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (drain) flushQueue()
  }
  const ensure = () => {
    if (engine === null) {
      engine = new CaptureEngine({ logPath, callerLogPath, onRecord: (rec) => { queue.push(rec) } })
    }
    return engine
  }
  const wasRunning = () => engine !== null && engine.tailer.running === true

  const doRotate = ({ keepDays = 7, pruneOnly = false } = {}) => {
    const result = { trace: 'missing', caller: 'missing', pruned: 0, restarted: false }
    if (!pruneOnly) {
      const running = wasRunning()
      if (running) Promise.resolve(engine.stop()).catch(() => {})
      result.trace = rotateFile(logPath)
      result.caller = rotateFile(callerLogPath)
      if (running) {
        if (engine !== null) engine.start()
        result.restarted = true
      }
    }
    result.pruned = pruneOldBaks(keepDays)
    return result
  }

  return {
    start({ replay = false, autoRotate = true } = {}) {
      const eng = ensure()
      if (autoRotate && !wasRunning()) {
        let size = 0
        try {
          size = statSync(logPath).size
        } catch {
          size = 0
        }
        if (size > AUTO_ROTATE_BYTES) doRotate({ keepDays: 7, pruneOnly: false })
      }
      if (replay === true && eng.tailer.startedAt === null) eng.tailer.replay = true
      eng.start()
      // ★ 完整性判据需要"自**本次**启动以来的 emitted 增量"：`counters.emitted` 是引擎对象创建以来的累计值，
      //   而 startedAt 每次 start() 都会重置 —— 两个量不同区间时比值毫无意义（我第一版就因此算出 0.005 的假绿灯）。
      emittedAtStart = Number(eng.parser && eng.parser.counters && eng.parser.counters.emitted) || 0
      startFlush()
    },
    stop() {
      if (engine !== null) Promise.resolve(engine.stop()).catch(() => {})
      stopFlush({ drain: true })
    },
    /** 采样式完整性判定的两端点（工具面在同一窗口里各取一次）。 */
    integritySample() {
      const st = this.status()
      return {
        ts: Date.now(),
        emitted: Number(st.counters && st.counters.emitted) || 0,
        startedAt: Number(st.startedAt) || null,
        realtimeCount: (() => {
          try { return readAll().filter((r) => (r.source ?? '') === 'realtime').length } catch { return null }
        })(),
      }
    },
    setLogPath(path) {
      if (path === logPath) return
      if (engine !== null && engine.tailer.running) throw new Error('capture running; stop it before changing logPath')
      logPath = path
      engine = null
    },
    setCallerLogPath(path) {
      if (path === callerLogPath) return
      if (engine !== null && engine.callerTailer.running) throw new Error('capture running; stop it before changing caller logPath')
      callerLogPath = path
      engine = null
    },
    rotate({ keepDays = 7, pruneOnly = false } = {}) {
      return doRotate({ keepDays, pruneOnly })
    },
    /**
     * 引擎状态 + **完整性判据**。
     *
     * 为什么要在这里算（r39 真机查出）：运行中的旧宿主里"引擎 emit 12 条、库多了 24 行"（比值 2.000），
     * 而当前代码实测 1.000。差异存在期间，面板/工具里所有"调用次数"都是**两倍** ——
     * 这件事必须由状态接口**自己报出来**（`integrity`），而不是只写在文档里等人去读。
     * 判据是"引擎自己的计数" vs "库里同时间段的 realtime 行数"，两个量都来自它自己的账本。
     */
    status() {
      if (engine === null) {
        return { running: false, logPath, logExists: existsSync(logPath), logSize: null, offset: 0, replay: false, startedAt: null, errors: 0, counters: null, integrity: null }
      }
      const st = engine.status()
      let integrity = null
      try {
        const startedAt = Number(st.startedAt) || 0
        const emitted = (Number(st.counters && st.counters.emitted) || 0) - emittedAtStart  // 自本次启动起的增量（同区间）
        if (startedAt > 0) {
          const realtime = readAll().filter((r) => (r.source ?? '') === 'realtime' && (Number(r.ts) || 0) >= startedAt - 1000).length
          integrity = doubleWriteVerdict({ emitted, realtimeSinceStart: realtime })
        }
      } catch { integrity = null } // 拿不到就不报（"没读到" ≠ "没问题"，但也不许编一个）
      return { ...st, integrity }
    },
    dispose() {
      if (engine !== null) Promise.resolve(engine.stop()).catch(() => {})
      stopFlush({ drain: true })
    },
  }
}

/** Host-managed local MITM proxy: records batched into the same store (source='proxy'). */
function createProxy() {
  let queue = []
  let engine = null
  let flushTimer = null

  const flushQueue = () => {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    try {
      appendRecords(batch)
    } catch {
      queue.unshift(...batch)
    }
  }

  const startFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setInterval(flushQueue, 800)
  }
  const stopFlush = ({ drain = false } = {}) => {
    if (flushTimer !== null) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (drain) flushQueue()
  }
  const ensure = () => {
    if (engine === null) {
      engine = new ProxyEngine({
        certDir: join(storeDir(), 'proxy-certs'),
        onRecord: (rec) => { queue.push(rec) },
      })
    }
    return engine
  }

  return {
    async start({ port = 8899, upstream = undefined } = {}) {
      const eng = ensure()
      const status = await eng.start({ port, upstream })
      startFlush()
      return status
    },
    stop() {
      if (engine !== null) Promise.resolve(engine.stop()).catch(() => {})
      stopFlush({ drain: true })
      return engine !== null ? engine.status() : { running: false }
    },
    status() {
      if (engine === null) {
        // F-018：**不能**在引擎为空时硬编码 systemProxyActive:false ——
        // 那正是"把用户机器改坏却说没动过"的写法。这里如实读当前系统代理，
        // 并指出它指向哪里（若指向本插件端口而引擎没跑，就是需要用户处理的险情）。
        const sys = readSystemProxy()
        const pointsAtUs = sys.enable === true && String(sys.server || '').includes('127.0.0.1:' + 8899)
        return {
          running: false, port: 8899, upstream: null,
          caPath: join(storeDir(), 'proxy-certs', 'ca-cert.pem'), caReady: false,
          systemProxyActive: pointsAtUs,
          systemProxy: sys,
          warning: pointsAtUs
            ? '⚠ 系统代理**仍指向 127.0.0.1:8899，但代理引擎没有在运行** —— 此时整机网络连接会被拒。' +
              '处理：启动代理后再调 POST /proxy/system-proxy {enable:false} 恢复，或直接改回原来的 ' + (sys.server || '(空)') + '。'
            : undefined,
          counters: null, startedAt: null,
        }
      }
      return engine.status()
    },
    installCa() {
      return ensure().installCa()
    },
    caCertDerPath() {
      return ensure().exportCaDer()
    },
    setSystemProxy(enable) {
      return ensure().setSystemProxy(enable)
    },
    getRules() {
      return ensure().getRules()
    },
    setRules(list) {
      return ensure().setRules(list)
    },
    getBreakpoints() {
      return ensure().getBreakpoints()
    },
    setBreakpoints(cfg) {
      return ensure().setBreakpoints(cfg)
    },
    releaseBreakpoint(id, action, edits) {
      return ensure().releaseBreakpoint(id, action, edits)
    },
    dispose() {
      this.stop()
    },
  }
}

/**
 * Mount the routes, tool, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 */
export function apply(ctx) {
  const capture = createCapture()
  const proxy = createProxy()
  const routes = makeRoutes(capture, proxy)
  const disposeRoutes = ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-api-visualizer: routes',
  )
  const disposeTool = ctx.effect(() => ctx.tools.register(apiCaptureTool()), 'dsh-api-visualizer: tools')
  const disposeQueryTool = ctx.effect(() => ctx.tools.register(apiQueryTool(capture)), 'dsh-api-visualizer: query-tool')
  // 起/停/查状态三件套。**必须在这里注册**（见 captureControlTools 的注释：写进别的函数体里=不执行）。
  const disposeCaptureCtl = ctx.effect(() => captureControlTools(capture).forEach((t) => ctx.tools.register(t)), 'dsh-api-visualizer: capture-control')
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:api-visualizer',
    order: SECTION_ORDER,
    text: GUIDANCE,
  })
  ctx.effect(
    () => () => {
      disposeRoutes()
      disposeTool()
      disposeQueryTool()
      disposeSection()
      capture.dispose()
      proxy.dispose()
    },
    'dsh-api-visualizer: teardown',
  )
}

// Test surface (unused by the cordis loader; keeps the store/filter logic unit-testable).
export { applyFilters, buildContracts, createCapture, createProxy, endpointKeyOf, jsonShape, normalize, paramsFromObj, searchSource, apiQueryTool, fmtAge }

/**
 * 捕获控制面三件套（起 / 停 / 查状态）。
 *
 * 单独成函数并**在 apply() 里注册**的原因：我第一版把这三段直接写在了 `apiQueryTool()` 的函数体末尾，
 * 而那个函数以 `return defineTool({...})` 结束 ⇒ 三段代码**永远不执行**。
 * 语法能过、check 能过、代码还在，但工具压根没注册（加载冒烟 + E4 的反向断言当场抓住）。
 */
function captureControlTools(capture) {
  const tools = []
  // ------------------------------------------------------------------ 捕获控制面（r39）
  //
  // 两个 G1 黑盒 agent **独立点名**同一处：目录里没有任何工具能起停实时捕获，
  // 而 `api_capture_query` 的描述让人"先 POST /api/dsh-api-visualizer/capture/start"——
  // 目录又没给 host/port，agent 连 URL 都拼不出来。工具补上之后，描述里那条路由指引也就不再是死路。
  tools.push(defineTool({
    name: 'api_capture_start',
    description: dshDescription('capture_start'),
    parameters: dshParameters('capture_start'),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          running: { type: 'boolean' },
          logExists: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: (v && v.summary ? v.summary : captureStatusSummary(v)) + (v && v.warnings ? '\n' + v.warnings.map((w) => '⚠ ' + w).join('\n') : '') }],
    },
    async execute(args) {
      const r = captureStart(capture, args ?? {})
      return { ...r, summary: captureStatusSummary(r) }
    },
  }))

  tools.push(defineTool({
    name: 'api_capture_stop',
    description: dshDescription('capture_stop'),
    parameters: dshParameters('capture_stop'),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, running: { type: 'boolean' }, summary: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v && v.summary ? v.summary : captureStatusSummary(v) }],
    },
    async execute() {
      const r = captureStop(capture)
      return { ...r, summary: captureStatusSummary(r) }
    },
  }))

  tools.push(defineTool({
    name: 'api_capture_status',
    description: dshDescription('capture_status'),
    parameters: dshParameters('capture_status'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, running: { type: 'boolean' }, summary: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v && v.summary ? v.summary : captureStatusSummary(v) }],
    },
    async execute(args) {
      const all = readAll()
      if (Number(args?.sampleSeconds) > 0) {
        const secs = Math.min(Math.max(Number(args.sampleSeconds), 5), 600)
        const before = capture.integritySample()
        await new Promise((r) => setTimeout(r, secs * 1000))
        const after = capture.integritySample()
        const integrity = sampleDeltaVerdict(before, after)
        const r = captureStatus(capture, { managed: true, storeTotal: readAll().length, integrity, sampledSeconds: secs })
        return { ...r, summary: captureStatusSummary(r) + (integrity && integrity.note ? '\n' + integrity.note : '') }
      }
      const r = captureStatus(capture, {
        managed: true,
        storeTotal: all.length,
        storeRealtime: all.filter((x) => (x.source ?? '') === 'realtime').length,
        // 新鲜度也一起给：只看"running:true"不够 —— 引擎可能在跑但**日志根本没数据**。
        freshness: (() => {
          try { return buildQueryView({ records: [], all, status: capture.status(), callerFilter: '', retention: retentionInfo() }).freshness } catch { return null }
        })(),
      })
      return { ...r, summary: captureStatusSummary(r) }
    },
  }))
  return tools
}

