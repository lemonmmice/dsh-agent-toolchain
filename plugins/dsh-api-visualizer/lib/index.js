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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CaptureEngine, DEFAULT_LOG, DEFAULT_CALLER_LOG } from './capture-engine.mjs'
import { captureStart, captureStop, captureStatus, captureStatusSummary, doubleWriteVerdict, sampleDeltaVerdict } from './capture-control.mjs'
// AV-03：'这次该不该整库重写'的纯判定（可测；避免在 flush 热路径里做上百 MB 的同步 IO）
import { shouldCompact, COMPACT_MIN_INTERVAL_MS, MAX_STORE_BYTES_DEFAULT } from './compaction.mjs'
// F-007：宿主不热加载插件代码 —— 抓包/代理这些"看数据下结论"的工具必须自报代码是否陈旧。
import { staleCodeInfo, moduleRoots } from '../../../lib/code-freshness.mjs'
import { dirname as dirNameOf } from 'node:path'

/** 本插件目录（仓库与 profile 两种布局下都成立）。 */
const AV_PLUGIN_DIR = dirNameOf(dirNameOf(fileURLToPath(import.meta.url)))
import { ProxyEngine, readSystemProxy } from './proxy-engine.mjs'
import { runInterceptTool } from './intercept-control.mjs'
import { buildQueryView, freshnessNote, callerAttributionNote, retentionNote, renderQuery } from './query-view.mjs'
import { envOr } from '../../../lib/env-fallback.mjs'
import { storeDir, stateDir, recordsDirFor, captureClientInfo, sameDir, normalize, readAll, getCaptureStorage, writeTrimMarker, clearRecords as clearSharedRecords, queryRecords } from '../../../lib/capture-store.mjs'
// 多客户端捕获库：记录目录跟着用户启动的客户端切换（规则 / 证书 / 拦截状态 / 过滤器始终在捕获根目录 stateDir）。
import { loadClientsConfig, saveClientsConfig, activeClientOf, startClientWatcher } from '../../../lib/capture-clients.mjs'
import { shardName } from '../../../lib/capture-storage.mjs'
import { queryCaptureAsync } from '../../../lib/capture-query-service.mjs'
// Fiddler 式命名过滤器（条件构造 / 存取 / 导入导出，面板、agent 工具、查询 worker 共用一份语义）与「AI 分析包」导出。
import {
  FILTER_FIELDS, FILTER_OPS, compileFilter, describeFilter, filterSignature, loadFilters, upsertFilter, deleteFilter, findFilter, exportFilters, importFilters,
  resolveQueryConditions, realtimeProcessName,
} from '../../../lib/capture-filters.mjs'
import { buildAiDigest, describeQueryParams, AI_BODY_LIMIT_DEFAULT, AI_BODY_LIMIT_MAX } from './ai-export.mjs'
// R4-03：有异步（分批让出事件循环）的摘要生成器就用它；旧版 ai-export.mjs 没有时退回同步版（按名字探测，不靠具名导入）。
import * as aiExportModule from './ai-export.mjs'
import { resolve as resolvePath } from 'node:path'

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

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 140

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-api-visualizer 插件（DSH Web GUI 的接口捕获面板，Fiddler 式实时抓包）：侧边栏「接口捕获」入口，可视化展示 本机客户端进程 的 HTTP 接口调用。' +
  '能力：记录存本地 JSONL 库（按天分片 records-YYYYMMDD.jsonl，上限 20000 条）；面板内「开始实时捕获」按钮驱动宿主实时引擎，tail 客户端 System.Net 跟踪日志（%TEMP%\\uiprobe-net-trace.log，由客户端配置的 system.diagnostics 注入产生）自动解析出 方法/URL/状态/请求头/响应头/请求体/响应体（gzip 自动解包）并实时入库，source=realtime，并关联调用方归因（ViewModel/API/调用链，来自 %TEMP%\\uiprobe-caller.log）；' +
  '捕获控制面**有工具**：api_capture_start（起）/ api_capture_stop（停）/ api_capture_status（查状态 —— running:true 但跟踪日志不存在时**抓不到任何数据**，两者不是一回事）；对应路由 POST /api/dsh-api-visualizer/capture/start（body 可选 {logPath, replay}）、POST /capture/stop、GET /capture/status、POST /capture/rotate（body {keepDays}，轮转 trace/caller 日志并清理过期 .bak）；' +
  '⚠ **跟踪日志不会在运行中自动轮转**（R1-02 / F-056 实测）：唯一那次"超 300MB 自动轮转"发生在 **start() 且当时没在跑**的那一刻，跑起来之后只涨不停（本机实测 ≈11–12 MB/分钟），而且默认就写在 **%TEMP%（C 盘）**。长跑前请自己 `POST /capture/rotate`（或面板「轮转日志」）；api_capture_start 每次都会把当前大小与这件事印在返回里。' +
  'agent 工具：api_capture_append（追加记录）、api_capture_query（查询/过滤已捕获记录，支持 q/method/source/status/host/minDurationMs/errors/caller 等，以及自定义过滤器 filter / conditions，返回调用方归因）；也可经 POST /api/dsh-api-visualizer/ingest 灌入。' +
  '自定义过滤器（Fiddler 式命名过滤器，面板「过滤器」按钮）：每个条件 = 字段（URL / 域名 / 路径 / 查询参数 / 方法 / 状态码 / 进程 / 捕获渠道 / Content-Type / 耗时 / 大小 / 请求头 / 响应头 / 正文 / 备注 / 调用方 / 标签）+ 运算（包含 / 等于 / 开头是 / 结尾是 / 匹配正则 / 数值比较 / 有值 / 为空，及其否定）+ 值，整组按「满足全部 / 满足任一」组合；' +
  '存在捕获库目录的 capture-filters.json，面板、agent 工具和同事共用。路由 GET /filters（含字段表与运算表）、POST /filters {filter}（带已有 id 为更新；名称重复回 409 FILTER_NAME_TAKEN）、DELETE /filters?id=、GET /filters/export、POST /filters/import {data, mode?: merge | replace}；' +
  'GET /records 支持 conditions（条件 JSON：{mode, conditions:[{field, op, value, header?, caseSensitive?, enabled?}]} 或它的数组）与 filterId（已存过滤器的 id 或名称），与其余过滤参数同时生效，条件不合法回 400 FILTER_INVALID、过滤器不存在回 404 FILTER_NOT_FOUND（available 列出已有名称），返回里 filterApplied 说明实际生效的条件；' +
  'api_capture_query 的 filter（已存过滤器的名称或 id）/ conditions（同上的条件 JSON）用的是同一套过滤器。记录上的 clientProcess / clientPid 是发起请求的进程（实时日志记录取配置的客户端进程名 DSH_UI_PROC_NAME）。' +
  '多客户端捕获库：捕获根目录（DSH_API_CAPTURE_STORE）下的 capture-clients.json 配了多个客户端（{name, process, dir}）时，记录按客户端分库 —— 当前客户端默认跟着用户最近启动的那个走（mode=auto），面板工具栏「客户端」下拉可锁定某一个（mode=manual）；' +
  '每条记录按发起进程落进它自己客户端的库，认不出进程的落当前客户端的库；规则、证书、拦截状态、弱网、过滤器所有客户端共用一套。路由 GET /capture-clients、POST /capture-clients {active?, mode?, clients?}；GET /capture/status 与 api_capture_query 的返回里 captureClient 说明当前查的是哪个客户端。' +
  'mock 规则导出 / 导入：GET /proxy/rules/export（规则文件，不含命中数）、POST /proxy/rules/export-file {path?, overwrite?}（默认写到捕获库目录 exports/rules-时间.json；给 path 时必须是 .json 绝对路径且目录已存在，文件已存在又没带 overwrite:true 回 409 EXPORT_EXISTS）、' +
  'POST /proxy/rules/import {data 或 path, mode?, baseRevision?}（mode=merge：加在最前、跳过和现有规则完全相同的；replace：整表换成导入的；文件不存在回 404 IMPORT_FILE_NOT_FOUND，内容不对回 400 IMPORT_INVALID / RULE_INVALID）；工具 api_capture_rules action=export / import。' +
  'AI 分析包：POST /records/export-ai {params（与 GET /records 同名的过滤参数，含 conditions / filterId）, limit?（默认 500，最多 5000）, bodyLimit?（每个正文最多导出的字节数，默认 4096，0 = 不含正文）, redact?, title?} 把命中的记录（最新的 limit 条）整理成 Markdown：概况、按接口的次数 / 错误 / 平均与 P95 耗时汇总、最慢与出错的请求、按时间先后的请求明细（JSON 正文无损美化，二进制正文只写大小），' +
  '保存到捕获库目录 exports/ai-capture-时间.md 并返回 {path, count, totalMatched, bytes, truncatedBodies, markdown}；用户想让 AI 分析抓包时，把这个文件交给它比交原始 HAR 更省上下文。' +
  '本地代理模式（抓任意进程，Fiddler 式）：POST /proxy/start（body 可选 {port, upstream}，默认 8899、上游自动读系统代理）、POST /proxy/stop、GET /proxy/status（含规则 revision / 弱网 / 断点 / 透明拦截摘要）、GET /proxy/ca-cert.der（根证书下载）、POST /proxy/install-ca（导入本机信任，免管理员）、POST /proxy/system-proxy（body {enable}，把系统代理指向本代理/恢复原值）；HTTPS 走 CONNECT + 按域签发证书解密，source=proxy；WebSocket 升级请求同样被抓取（帧统计+文本解码，source=proxy, method=WS）。' +
  'AutoResponder 规则引擎（对经过本地代理 / 透明拦截的流量生效）：GET /proxy/rules（含 revision）、POST /proxy/rules（body {rules, baseRevision?} 整表替换；baseRevision 已过期回 409 RULES_CONFLICT 并带当前 revision）、' +
  'POST /proxy/rules/op（**单条改动**，body {op, id?, rule?, url?, method?}，op = add / update / remove / enable / disable / clear / removeQuick —— 改一条不要整表重写）、GET /proxy/rules/item?id=（取一条完整规则）、' +
  'POST /proxy/rules/quick（一键 mock：body {url, method?, preset, body?, status?, latencyMs?, recordId?, name?}；preset=original / empty-lists 由宿主自己找该接口最近一次真实响应）、DELETE /proxy/rules（清空）；' +
  '规则无效回 400 RULE_INVALID、id 不存在回 404 RULE_NOT_FOUND；任何路由的请求体超限都回 413 BODY_TOO_LARGE（不会直接断开连接）。断点：GET/POST /proxy/breakpoints、POST /proxy/breakpoints/release（body {id, action, edits}，编辑非法回 400 BP_EDIT_INVALID）。' +
  '**工具**：api_capture_rules（action=list / get id=… / mock（一键把某接口改成 {} / [] / 保留外壳清空数组 / 500 / 延迟 N 秒 / 挂起超时 / 断开）/ add（ruleJson：Map Local / Map Remote / 改写真实响应 `set data.list = []` 等）/ remove / enable / disable / clear；mock 的返回里 reach 说清这条规则此刻能不能被客户端命中）、' +
  'api_capture_intercept（**透明拦截**，action=status / suggest / start / stop：客户端强制直连、不走代理时，把它的接口域名经 hosts 指向本机 127.77.0.1 做反向代理，规则/断点/延时随即对它生效；会改系统 hosts，重启电脑或监听不在时由安全网计划任务自动还原；启用后重启客户端立即生效；' +
  '路由 GET /proxy/intercept/status?deep=0|1&fresh=0|1、GET /proxy/intercept/suggest（候选域名，sources 分 realtime / proxy / other 计数，只有 realtime 才算客户端自己的流量）、POST /proxy/intercept/start {hosts, ip?, strictUpstreamTls?}、POST /proxy/intercept/stop {graceMs?, force?}）、' +
  'api_capture_netsim（全局接口延时/弱网，对标 Fiddler 的 Simulate Modem Speeds；路由 GET/POST /proxy/netsim）。典型闭环：api_capture_intercept start → api_capture_rules mock → 让客户端刷新页面 → 截图看渲染 → api_capture_rules remove。' +
  '记录编辑：PATCH /records/{id}（body {note?, tag?, flag?}）；列表过滤支持 flag=1、host、Content-Type、耗时、响应字节、时间范围、body、sessionId、traceId；GET /stats/timeline 提供 P50/P95/P99 和吞吐趋势，GET /stats/sessions 提供会话聚合，GET /stats/repeats 检测高频重复请求（定时器风暴）。面板支持重放结果 JSON 差异、HAR/JSON/CSV/OpenAPI 契约导出、瀑布图、重复检测、基线/契约回归（POST /baseline/save、POST /baseline/diff）、调用方源码定位（POST /source/locate、POST /source/open，环境变量 DSH_API_SRC_ROOT 指向客户端源码根）。' +
  '限制：实时捕获依赖客户端已注入 system.diagnostics 跟踪配置（重启客户端后生效）；请求/响应体截断 ≤ 2MB；日志与记录含真实 token（本机本地存储，不外传，用户明确要求不脱敏）。' +
  '用户提到「接口可视化 / 抓接口 / 接口面板 / 接口捕获 / 实时抓包 / Fiddler」时即指本插件，请据此协作。'

const storeFile = (ts) => join(storeDir(), shardName(ts ?? Date.now()))

/** 记录目录的比较键（解析成绝对路径；Windows 不区分大小写）。 */
const dirKey = (dir) => {
  const r = resolvePath(dir)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * AV-03：整库重写（compaction）的成本与库体积同阶，绝不能每次 flush 都做；节流与诊断计数都在这里。
 * 多客户端捕获库：**每个记录目录各一份**。同时开着两个客户端时，非当前客户端的记录照样落进它自己的库，
 * 它那个库满了也走同一套节流 —— 否则每 800 ms 一次 flush 就会把那个满库整个重写一遍（写放大）。
 *   lastCompactAt / compactCount / lastCompactReason：上次何时压、压了几次、为什么压（没有它们，写放大不可见）；
 *   compactThrottled / compactWantedButThrottled：「条件成立但被节流」必须可见；
 *   lastCompactKeptBytes / lastCompactDropped / lastCompactTruncatedBy：字节维度的裁剪结果（否则只能猜回收了多少）。
 */
const compactStates = new Map()
function compactStateOf(dir) {
  const key = dirKey(dir)
  let st = compactStates.get(key)
  if (st === undefined) {
    st = {
      duplicateAppendsSinceCompact: 0, lastCompactAt: 0, compactCount: 0, lastCompactReason: null, lastCompactError: null,
      compactThrottled: false, compactWantedButThrottled: 0, lastCompactKeptBytes: null, lastCompactDropped: 0, lastCompactTruncatedBy: null,
    }
    compactStates.set(key, st)
  }
  return st
}

/**
 * 最近写过的记录 id → 它落进的记录目录。同一条代理记录会被引擎 emit 多次（流式进度、终态、挂起前后），
 * 进程归因也可能晚到：后面几次必须落回**第一次落的那个库**，不能因为后来才知道进程就在另一个库里再留一份。
 */
const STICKY_DIRS_MAX = 20000
const stickyDirs = new Map()
function rememberDir(id, dir) {
  if (typeof id !== 'string' || id === '') return
  stickyDirs.delete(id)
  stickyDirs.set(id, dir)
  if (stickyDirs.size > STICKY_DIRS_MAX) stickyDirs.delete(stickyDirs.keys().next().value)
}

/**
 * 进程内标记：这条记录必须写进指定的记录目录（归因补丁写回原行所在的库）。
 * 用不可枚举的 Symbol 属性：normalize 只复制认识的字段，JSON 与断言比较都看不到它。
 */
const PIN_DIR = Symbol('dsh-api-visualizer.pinDir')
function pinToDir(rec, dir) {
  Object.defineProperty(rec, PIN_DIR, { value: dir, enumerable: false, configurable: true })
  return rec
}

/** Persist explicit edits/deletions against the snapshot they were derived from (default: the active client's records). */
function persistAll(records, dir = storeDir()) {
  getCaptureStorage(dir).replace(records)
  compactStateOf(dir).duplicateAppendsSinceCompact = 0
}

/**
 * Host capture batches keep their existing compaction throttle and counters.
 * 多客户端：每条记录按 固定目录（PIN_DIR）→ 同 id 上次落的目录 → recordsDirFor（发起进程所属客户端，否则当前客户端）分组，
 * 各组写进各自的库、各自节流裁剪。没配置客户端时只有一组 = 捕获根目录，行为与原来完全一样。
 */
function appendRecords(rawRecords, opts = {}) {
  const records = []
  const pins = new Map()
  const runId = typeof opts.runId === 'string' ? opts.runId : ''
  for (const raw of rawRecords) {
    const rec = normalize(raw)
    if (rec !== null) {
      rec.evidenceLevel = opts.evidenceLevel === 'observed' ? 'observed' : 'imported'
      if (runId && rec.runId === undefined) rec.runId = runId
      const pinned = raw !== null && typeof raw === 'object' ? raw[PIN_DIR] : undefined
      if (typeof pinned === 'string' && pinned !== '') pins.set(rec, pinned)
      records.push(rec)
    }
  }
  if (records.length === 0) return { ingested: 0, total: readAll().length }
  const groups = new Map()
  for (const rec of records) {
    const dir = pins.get(rec) ?? stickyDirs.get(rec.id) ?? recordsDirFor(rec)
    const key = dirKey(dir)
    let g = groups.get(key)
    if (g === undefined) {
      g = { dir, part: [] }
      groups.set(key, g)
    }
    g.part.push(rec)
  }
  const active = storeDir()
  const routed = {}
  let trimError = null
  for (const { dir, part } of groups.values()) {
    const r = appendToDir(dir, part)
    for (const rec of part) rememberDir(rec.id, dir)
    if (r.trimError !== null) trimError = r.trimError
    if (!sameDir(dir, active)) routed[dir] = (routed[dir] ?? 0) + part.length
  }
  return { ingested: records.length, total: readAll().length,
    ...(Object.keys(routed).length > 0 ? { routed } : {}),
    ...(trimError !== null ? { trimFailed: true, trimError } : {}) }
}

/** 把一组已规范化的记录写进 dir，并按该目录自己的节流状态决定要不要整理（裁剪标记写在同一目录）。 */
function appendToDir(dir, records) {
  const storage = getCaptureStorage(dir)
  const st = compactStateOf(dir)
  const appended = storage.append(records)
  st.duplicateAppendsSinceCompact += appended.duplicates
  const stats = storage.stats()
  const verdict = shouldCompact({
    allCount: stats.count, maxRecords: MAX_RECORDS, physicalBytes: stats.physicalBytes, maxBytes: MAX_STORE_BYTES,
    duplicateAppends: st.duplicateAppendsSinceCompact, now: Date.now(), lastCompactAt: st.lastCompactAt,
  })
  let trimError = null
  if (verdict.compact) {
    const trimmed = storage.plan(MAX_RECORDS, MAX_STORE_BYTES) || {
      keep: sortNewestFirst([...storage.readAll()]), keptBytes: stats.retainedBytes, dropped: 0, truncatedBy: null,
    }
    try {
      persistAll([...trimmed.keep].reverse(), dir)
      if (trimmed.dropped > 0) writeTrimMarker(dir, {
        dropped: trimmed.dropped, truncatedBy: trimmed.truncatedBy,
        maxRecords: MAX_RECORDS, maxBytes: MAX_STORE_BYTES,
      })
      st.lastCompactAt = Date.now()
      st.compactCount++
      st.lastCompactReason = verdict.reason
      st.lastCompactError = null
      st.lastCompactKeptBytes = trimmed.keptBytes
      st.lastCompactDropped = trimmed.dropped
      st.lastCompactTruncatedBy = trimmed.truncatedBy
      st.compactThrottled = false
      st.compactWantedButThrottled = 0
    } catch (error) { trimError = error.message; st.lastCompactError = trimError }
  } else if (verdict.throttled) {
    st.compactThrottled = true
    st.compactWantedButThrottled++
  } else {
    st.compactThrottled = false
  }
  return { trimError }
}

/** 清空当前客户端的记录（其它客户端的库不动）。 */
function clearRecords() {
  const result = clearSharedRecords()
  compactStateOf(storeDir()).duplicateAppendsSinceCompact = 0
  return result
}

/**
 * 归因补丁要找的那一行可能在哪些库里：记得的目录优先，然后当前客户端、其它已配置的客户端、捕获根目录（去重，按这个顺序）。
 * 没配置客户端时就是 [捕获根目录]，与原来只读当前库一样。
 */
function candidateDirsFor(ids) {
  const out = []
  const seen = new Set()
  const add = (dir) => {
    if (typeof dir !== 'string' || dir === '') return
    const key = dirKey(dir)
    if (seen.has(key)) return
    seen.add(key)
    out.push(dir)
  }
  for (const id of ids) add(stickyDirs.get(id))
  add(storeDir())
  const root = stateDir()
  for (const c of loadClientsConfig(root).clients) add(c.dir)
  add(root)
  return out
}

/** 宿主里「跟随启动的客户端」的轮询器（apply 时启动；自测只加载 makeRoutes 时没有 ⇒ null）。 */
let clientWatcher = null
const clientWatcherOf = () => clientWatcher

/**
 * GET / POST /capture-clients 的返回：captureClientInfo + 每个客户端（映像名 / 记录目录 / 是否在跑 / 是否当前）+ 轮询器状态。
 * 没有轮询器时 running 是 null（不知道），不是 false。
 */
function captureClientsView(watcher) {
  const info = captureClientInfo()
  const cfg = loadClientsConfig(info.stateDir)
  const active = activeClientOf(cfg)
  let ws = null
  try { ws = watcher !== null && typeof watcher.status === 'function' ? watcher.status() : null } catch { ws = null }
  const running = new Set(ws !== null && Array.isArray(ws.runningClients) ? ws.runningClients : [])
  return {
    ...info,
    activeAt: cfg.activeAt,
    activeReason: cfg.activeReason,
    clients: cfg.clients.map((c) => ({
      name: c.name,
      processes: [...c.processes],
      dir: c.dir,
      running: ws === null || ws.disabled === true ? null : running.has(c.name),
      active: active !== null && c.name === active.name,
    })),
    watcher: ws === null
      ? { running: false, disabled: false, lastScanAt: null, lastChangeAt: null, lastError: null }
      : { running: ws.running === true, disabled: ws.disabled === true, lastScanAt: ws.lastScanAt ?? null, lastChangeAt: ws.lastChangeAt ?? null, lastError: ws.lastError ?? null },
  }
}

/** Store API, exported for capture backends. */
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

/** One JSON response (extraHeaders: e.g. content-disposition for the export downloads). */
function writeJson(res, status, body, extraHeaders = null) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer', ...(extraHeaders ?? {}) })
  res.end(payload)
}

/**
 * 超过上限之后最多再读掉（丢弃、不缓存）这么多字节；再多就只能断开连接。
 * 为什么要读完再回：客户端（浏览器 fetch / undici）通常先把整个请求体发完才读响应，
 * 服务端边收边断（RST）时它只看得到"连接被重置"，看不到 413。
 */
const BODY_DISCARD_LIMIT_BYTES = 128 * 1024 * 1024

/**
 * Read and parse a JSON request body with a size cap.
 *
 * C3：超限**不再**当场 `req.destroy()` —— 那会直接掐断 socket，路由写的错误响应根本发不出去：
 * 面板只看到 'Failed to fetch'，MCP 面则被误报成"连不上宿主回环路由"。现在超限后继续把剩余正文读完并丢弃，
 * 读完才以 `code: 'BODY_TOO_LARGE'`（`limit` = 上限字节数）拒绝，由路由回 413；
 * 超限部分再超过 discardLimitBytes 才断开（防无底洞上传）。
 */
function readJsonBody(req, maxBytes, { discardLimitBytes = BODY_DISCARD_LIMIT_BYTES, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const tooLargeError = () => Object.assign(new Error(`request body too large (> ${maxBytes} bytes)`), { code: 'BODY_TOO_LARGE', limit: maxBytes })
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (tooLarge) {
        if (size > maxBytes + discardLimitBytes) {
          settle(reject, tooLargeError())
          req.destroy()
        }
        return
      }
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0 // 已缓存的部分也不要了：之后只计数、不留字节
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        settle(reject, tooLargeError())
        return
      }
      // raw：原样的字节（Buffer，空 body 是空 Buffer），由调用方自己解码 —— 例如规则导入 ?raw=1（R3-04）
      if (raw) {
        settle(resolve, Buffer.concat(chunks))
        return
      }
      // 空 body 与"坏 JSON"是**两件事**：前者的接口在文档里就写着 body 可选
      // （`POST /capture/start` 不带 body 也能起），后者才是调用方写错了。
      // 旧实现两者都 reject ⇒ 空 body 也被回 400 'invalid JSON body'
      // —— 我自己在实验里用无 body 的 POST 恢复捕获时当场撞上（可以不带参数的接口却要先构造一个 `{}`）。
      if (size === 0) {
        settle(resolve, {})
        return
      }
      try {
        settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        settle(reject, error)
      }
    })
    req.on('error', (error) => settle(reject, error))
    // 客户端中途放弃：'end' 永远不会来 —— 别让路由一直挂着
    req.on('close', () => settle(reject, Object.assign(new Error('request aborted before the body was complete'), { code: 'BODY_ABORTED' })))
  })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** C3：readJsonBody 的失败 → 413（超限，带上限字节数）/ 400（其余：坏 JSON、请求中途断开）。 */
function replyBodyError(res, error, { detail = false } = {}) {
  if (error !== null && typeof error === 'object' && error.code === 'BODY_TOO_LARGE') {
    writeJson(res, 413, { error: 'request body too large', code: 'BODY_TOO_LARGE', ...(Number.isFinite(error.limit) ? { limitBytes: error.limit } : {}) })
    return
  }
  writeJson(res, 400, { error: detail ? `invalid JSON body: ${errorMessage(error)}` : 'invalid JSON body' })
}

/**
 * 读 JSON 正文；失败时**已经回好** 413 / 400 并返回 undefined —— 调用方见 undefined 直接 return。
 * （JSON 本身产不出 undefined，所以它不会和合法正文混淆。）
 */
async function readBodyOrReply(req, res, maxBytes, { detail = false } = {}) {
  try {
    return (await readJsonBody(req, maxBytes)) ?? {}
  } catch (error) {
    replyBodyError(res, error, { detail })
    return undefined
  }
}

/** 引擎（proxy-engine.mjs）/ 过滤器（lib/capture-filters.mjs）/ 导入导出带 code 的错误 → HTTP 状态（共享契约）。 */
const ENGINE_ERROR_STATUS = Object.freeze({
  RULES_CONFLICT: 409,
  RULE_INVALID: 400,
  RULE_NOT_FOUND: 404,
  BP_EDIT_INVALID: 400,
  BODY_TOO_LARGE: 413,
  FILTER_INVALID: 400,
  FILTER_NOT_FOUND: 404,
  FILTER_NAME_TAKEN: 409,
  // R1-01：自定义条件在 list-family 路由的时间预算内没算完（多半是回溯爆炸的正则）—— 调用方改条件就能好，按请求不合法回 400
  FILTER_TOO_SLOW: 400,
  IMPORT_INVALID: 400,
  IMPORT_FILE_NOT_FOUND: 404,
  EXPORT_EXISTS: 409,
  EXPORT_PATH_INVALID: 400,
  // R3-04：规则信封比导入上限还大（导出来也导不回去），拒绝导出
  EXPORT_TOO_LARGE: 400,
  // 过滤器文件读不了（或损坏且挪不开）/ 两次读改写之间都被别的进程改了 —— 两种情况都什么也没写
  FILTERS_UNREADABLE: 503,
  FILTERS_CONFLICT: 409,
  // R7-08：规则文件损坏、又没法先挪到一边备份 —— 拒绝覆盖，等用户处理
  RULES_FILE_DAMAGED: 409,
})

/** 这个错误带着契约表里的 code（路由该按表回状态，而不是当成宿主内部错误回 500）。 */
function isContractError(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' && Object.hasOwn(ENGINE_ERROR_STATUS, error.code)
}

/** 导入 / 导出相关的错误里，path 是调用方自己给的文件路径：带回去，方便对照。 */
const PATH_ERROR_CODES = new Set(['EXPORT_EXISTS', 'EXPORT_PATH_INVALID', 'IMPORT_FILE_NOT_FOUND'])

/** 引擎错误的统一外形 `{ error, code?, revision?, available?, path? }`（路由与 DSH 面工具共用）。 */
function engineErrorBody(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== '' ? error.code : undefined
  return {
    error: errorMessage(error),
    ...(code !== undefined ? { code } : {}),
    ...(code === 'RULES_CONFLICT' && error.revision !== undefined ? { revision: error.revision } : {}),
    // FILTER_NOT_FOUND：已有过滤器的名称（resolveQueryConditions 挂在 error.available 上），调用方照着改名就能查
    ...(code === 'FILTER_NOT_FOUND' && Array.isArray(error.available) ? { available: error.available } : {}),
    ...(code !== undefined && PATH_ERROR_CODES.has(code) && typeof error.path === 'string' ? { path: error.path } : {}),
  }
}

/** 带 code 的错误（code 取契约表里的值）。 */
function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * 契约里的 code 按表映射；Node 自己的系统/内部错误（EACCES、ERR_*）与程序错误（TypeError…）是宿主的问题 → 500；
 * 其余没有 code 的错误沿用旧口径按"请求不合法"回 400（规则校验历来就是这么报的）。
 */
function replyEngineError(res, error) {
  const body = engineErrorBody(error)
  let status = 400
  if (body.code !== undefined && Object.hasOwn(ENGINE_ERROR_STATUS, body.code)) status = ENGINE_ERROR_STATUS[body.code]
  else if (body.code !== undefined && /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(body.code)) status = 500
  else if (body.code === undefined && (error instanceof TypeError || error instanceof ReferenceError)) status = 500
  writeJson(res, status, body)
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

/**
 * 按时间新→旧（ts 相同按 id 倒序）排序副本。位置切片（offset/limit）与游标过滤
 * 都依赖时间序，而分片文件顺序可能因乱序写入（导入/重放/跨日分片）与 ts 序不一致，
 * 任何按位置取页的消费点都必须先经此排序（绝不原地排序，避免改坏 storeCache）。
 */
function sortNewestFirst(list) {
  return [...list].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0))
}

/**
 * 自定义条件在 list-family 路由（/stats/*、DELETE /records?filtered=1、基线）里的时间预算（R1-01）。
 * 这些路由在宿主主线程上算：一个回溯爆炸的正则会冻住整个 DSH（网页、全部工具、进程内的正向代理与透明拦截）。
 * 超过预算就中止、回 400 FILTER_TOO_SLOW；正则本身没法中途打断，所以预算只能卡在记录（与条件）之间。
 */
const LIST_FILTER_BUDGET_MS = 3000
/** 同一组条件刚超过预算：这段时间内再来（面板开着视图时每秒轮询一次）直接拒绝，不再陪它在主线程上跑满预算。 */
const SLOW_FILTER_COOLDOWN_MS = 60_000
/** JSON([客户端进程名, filterSignature]) → 冷却到期时间。 */
const slowFilters = new Map()

/** 一个条件的中文描述（describeFilter 的单条件版，去掉「全部满足：」前缀）。 */
function conditionText(condition) {
  try {
    return describeFilter({ mode: 'all', conditions: [condition] }).replace(/^(全部满足|任一满足)：/, '')
  } catch {
    return `${String(condition.field ?? '')} ${String(condition.op ?? '')}`.trim()
  }
}

/**
 * FILTER_TOO_SLOW（R1-01）的错误：中文说明点名慢的条件 —— compileFilter 的超时错误带了（description / condition）就用它的，
 * 否则列出其中启用的正则条件（只有正则会慢到这个程度）。cooling = 这次是冷却期内直接拒绝，没有再算。
 */
function filterTooSlowError(cause, conditions, budgetMs, cooling) {
  const own = cause !== null && typeof cause === 'object' ? cause : {}
  let which = []
  if (typeof own.description === 'string' && own.description.trim() !== '') which = [own.description.trim()]
  else if (own.condition !== null && typeof own.condition === 'object') which = [conditionText(own.condition)]
  if (which.length === 0) {
    for (const filter of Array.isArray(conditions) ? conditions : [conditions]) {
      const list = filter !== null && typeof filter === 'object' && Array.isArray(filter.conditions) ? filter.conditions : []
      for (const c of list) {
        if (c !== null && typeof c === 'object' && c.enabled !== false && (c.op === 'regex' || c.op === 'notRegex')) which.push(conditionText(c))
      }
    }
  }
  const secs = budgetMs / 1000
  const lead = cooling
    ? `这组自定义条件刚才在 ${secs} 秒的时间预算内没有算完，${SLOW_FILTER_COOLDOWN_MS / 1000} 秒内同样的条件直接拒绝（不再在宿主主线程上重算）。`
    : `自定义条件太慢：${secs} 秒内没有对全部记录算完，已中止（删除筛选结果时一条都没删）。`
  const named = which.length === 0 ? '' : `慢的多半是${which.length > 1 ? '这几个' : '这个'}条件：${which.join('；')}。`
  return codedError(
    'FILTER_TOO_SLOW',
    lead + named + '常见原因是正则回溯爆炸（嵌套量词，例如 (a+)+、(x*)*）：把正则改简单（去掉嵌套的 + / *、加上明确的边界），或改用「包含 / 开头是」这类条件再试。',
    { budgetMs, ...(which.length > 0 ? { conditions: which } : {}) },
  )
}

/** 自定义条件按预算逐条过滤（R1-01）；超时抛 FILTER_TOO_SLOW，并让同一组条件进入冷却。 */
function matchWithBudget(items, custom, budgetMs = LIST_FILTER_BUDGET_MS) {
  let key = null
  try { key = JSON.stringify([custom.realtimeProcess, filterSignature(custom.conditions)]) } catch { key = null }
  const started = Date.now()
  if (key !== null && slowFilters.has(key)) {
    if (slowFilters.get(key) > started) throw filterTooSlowError(null, custom.conditions, budgetMs, true)
    slowFilters.delete(key)
  }
  const deadline = started + budgetMs
  // compileFilter 认 deadlineMs（绝对时刻，Date.now() 的毫秒数）时，谓词自己隔几次调用看一次钟、超时抛 FILTER_TOO_SLOW；
  // 不认这个选项的版本会忽略它 —— 下面每条记录之前也看一次表，两种版本都受同一个预算约束。
  const match = compileFilter(custom.conditions, { realtimeProcess: custom.realtimeProcess, deadlineMs: deadline })
  if (match.matchesAll === true) return [...items]
  const out = []
  try {
    for (const r of items) {
      if (Date.now() > deadline) throw codedError('FILTER_TOO_SLOW', 'deadline passed')
      if (match(r)) out.push(r)
    }
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'FILTER_TOO_SLOW') throw error
    if (key !== null) {
      if (slowFilters.size >= 100) slowFilters.clear()
      slowFilters.set(key, Date.now() + SLOW_FILTER_COOLDOWN_MS)
    }
    throw filterTooSlowError(error, custom.conditions, budgetMs, false)
  }
  return out
}

/**
 * /stats/*、DELETE /records?filtered=1、基线共用的过滤：参数与 GET /records 完全相同（含 conditions / filterId）。
 * R4-02：快捷过滤与 GET /records 用**同一个**过滤对象（recordFilterOf：重复参数的取法、caller……都一样）和
 * **同一个**实现（存储层 queryRecords —— 查询 worker 给 GET /records 跑的就是它），所以「删除筛选结果」删掉的
 * 正好是列表里看到的那一批（分页参数 limit / offset / cursor 除外：删除针对全部匹配）。
 * 返回库里原顺序的子集（不排序：会话 / 端点聚合按遇到的先后取样本）；excludedNoField（非枚举）= 快捷过滤里因字段缺失被排除的条数。
 */
function applyFilters(all, params) {
  // 自定义过滤器先解析：条件不合法 / 过滤器不存在直接抛（FILTER_INVALID / FILTER_NOT_FOUND，由路由兜底按表回 400 / 404），一条都不动。
  const custom = customConditionsOf(params)
  const items = queryRecords(recordFilterOf(params), all, true)
  if (custom.conditions === null) return items
  // 自定义过滤器与上面每一个快捷条件 AND —— 与 GET /records 同一套语义，只是多了主线程上的时间预算（R1-01）。
  const matched = matchWithBudget(items, custom)
  Object.defineProperty(matched, 'excludedNoField', { value: items.excludedNoField, enumerable: false, configurable: true })
  return matched
}

/** 配置的客户端进程名（实时日志记录的「进程」）；没配置 / 读不到就是 ''（绝不抛）。 */
function realtimeProcessSafe() {
  try {
    const name = realtimeProcessName()
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

/**
 * 自定义过滤（GET /records 一族与 AI 导出共用）：查询参数 conditions（条件 JSON：一个过滤器对象或数组）与
 * filterId（已存过滤器的 id 或名称）→ { conditions: Filter[] | null, applied: [{ name, description }], realtimeProcess }。
 * 两个都给 ⇒ 都生效（AND）；都没给 ⇒ 不读过滤器文件（面板每秒轮询列表，这条路径要便宜）。
 * 条件不合法抛 FILTER_INVALID，过滤器不存在抛 FILTER_NOT_FOUND（error.available = 已有名称）。
 */
function customConditionsOf(params) {
  const rawConditions = (params.get('conditions') ?? '').trim()
  // filter= 是工具那一面的参数名：当成 filterId 的别名，免得手写请求时被静默忽略、变成「不过滤」（R4-01）
  const filterId = (params.get('filterId') ?? params.get('filter') ?? '').trim()
  if (rawConditions === '' && filterId === '') return { conditions: null, applied: [], realtimeProcess: '' }
  const realtimeProcess = realtimeProcessSafe()
  const resolved = resolveQueryConditions(
    { filter: filterId === '' ? undefined : filterId, conditions: rawConditions === '' ? undefined : rawConditions },
    { dir: stateDir(), realtimeProcess },
  )
  const conditions = resolved !== null && typeof resolved === 'object' && resolved.conditions !== undefined ? resolved.conditions : null
  const applied = resolved !== null && typeof resolved === 'object' && Array.isArray(resolved.applied) ? resolved.applied : []
  return { conditions, applied, realtimeProcess }
}

/** 交给 queryCaptureAsync 的自定义过滤字段：没有自定义条件时一个键都不加（不改变原有查询，也不改游标的查询键）。 */
function customQueryFields(custom) {
  return custom.conditions !== null ? { conditions: custom.conditions, realtimeProcess: custom.realtimeProcess } : {}
}

/** R4-10：excludedNoField 能怪到的快捷过滤键（只列本次真给了的）。o = recordFilterOf 的结果或工具参数。 */
function quickNoFieldKeys(o) {
  const given = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))
  const keys = ['minDurationMs', 'minBytes', 'maxBytes'].filter((k) => given(o[k]))
  if (String(o.status ?? '').trim() !== '') keys.push('status')
  if (o.errors === true || o.errors === '1' || o.errors === 1) keys.push('errors')
  return keys
}

/**
 * R4-10：excludedNoField 的人话说明。只给本次真用到的快捷过滤键出主意；自定义过滤器里的数字条件另说：
 * 存储层把「只因缺了自定义数字条件的字段才被排除」的条数记在 noField.conditions（字段在 conditionFields）；
 * 旧版存储层没有这一格、把它们计进 durationMs / bytesRes / status —— 那时用了自定义过滤器就两句都说。
 */
function excludedNoFieldNote(noField, quickKeys, customApplied) {
  const byConditions = Number(noField.conditions) > 0 ? Number(noField.conditions) : 0
  const fields = Array.isArray(noField.conditionFields) && noField.conditionFields.length > 0 ? noField.conditionFields.join(' / ') : '耗时 / 响应字节 / 状态码'
  const quickCount = noField.durationMs + noField.bytesRes + noField.status
  const tips = []
  if (quickKeys.length > 0 && quickCount > 0) tips.push(`把 ${quickKeys.join(' / ')} 这些过滤条件去掉再查一次，两次条数之差就是它们的数量`)
  if (byConditions > 0 || (noField.conditions === undefined && customApplied)) {
    tips.push(`自定义过滤器里的数字条件（${fields}）同样会排除缺这个字段的记录：放宽这些条件，或用「存在 / 不存在」条件把缺这个字段的记录单独查出来`)
  }
  if (tips.length === 0) tips.push('把 minDurationMs / minBytes / maxBytes / status / errors 这些过滤条件去掉再查一次，两次条数之差就是它们的数量')
  return '有记录因**缺少被过滤的那个字段**而被排除（不是"不满足条件"）：' +
    `durationMs ${noField.durationMs} 条 / bytesRes ${noField.bytesRes} 条 / status ${noField.status} 条` +
    (byConditions > 0 ? `；自定义条件（${fields}）${byConditions} 条` : '') + '。' +
    `想去掉这个歧义：${tips.join('；')}。`
}

/** GET /records 与 AI 导出共用：查询参数 → queryCaptureAsync 的快捷过滤字段（自定义过滤另由 customConditionsOf 解析）。 */
function recordFilterOf(params) {
  const filter = Object.fromEntries(params)
  for (const key of ['regex', 'flag', 'errors', 'noNoise']) filter[key] = params.get(key) === '1'
  for (const key of ['minDurationMs', 'minBytes', 'maxBytes', 'fromTs', 'toTs']) filter[key] = params.has(key) && params.get(key) !== '' ? Number(params.get(key)) : undefined
  // 原样的 JSON 字符串绝不能交给存储层（它要的是解析好的过滤器数组）；客户端进程名只由宿主自己定（不许从查询串改）
  delete filter.conditions
  delete filter.filterId
  delete filter.realtimeProcess
  return filter
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

/**
 * R4-08：基线里存的过滤条件 —— 原样的快捷过滤参数 + 解析好的自定义条件（custom.conditions，过滤器对象数组）；
 * filterId 换成它当时指向的条件本身，之后对比只用这份快照，不再按名字 / id 去查当前的过滤器。
 */
function baselineFilterSnapshot(raw, custom) {
  const out = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  delete out.filterId
  delete out.conditions
  if (custom.conditions !== null) out.conditions = custom.conditions
  return out
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

// ---------------------------------------------------------------- 导出文件 / 导入（规则、过滤器、AI 分析包）

/** AI 分析包默认导出的记录条数 / 上限。 */
const AI_EXPORT_DEFAULT_RECORDS = 500
const AI_EXPORT_MAX_RECORDS = 5000
/** AI 分析包超过这个字节数就不随响应回 markdown（只回文件路径）。 */
const AI_MARKDOWN_INLINE_MAX = 4 * 1024 * 1024
/** POST /filters 单个过滤器的请求体上限（≤ 50 个条件 × 2000 字符，留足余量）。 */
const FILTER_BODY_MAX_BYTES = 1024 * 1024

/** 导出文件的默认目录：<捕获库目录>/exports。 */
function exportsDir() {
  return join(storeDir(), 'exports')
}

/** 本机时间 YYYYMMDD-HHmmss（文件名用）。 */
function fileStamp(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 在 dir 下新建 base + ext（UTF-8）；同名已存在（同一秒导出两次）就依次试 base-2、base-3…，返回实际写入的路径。
 * 用 'wx' 独占创建：两个导出同时挑中同一个名字也不会互相覆盖。
 */
function writeNewFile(dir, base, ext, text) {
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 1000; i++) {
    const target = join(dir, `${base}${i === 1 ? '' : `-${i}`}${ext}`)
    try {
      writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw codedError('EXPORT_EXISTS', `导出目录里同名文件太多：${join(dir, base + ext)}`, { path: join(dir, base + ext) })
}

/**
 * 调用方指定的导出路径：必须是绝对路径、以 .json 结尾、所在目录已存在、不是目录；
 * 文件已存在且没有 overwrite ⇒ EXPORT_EXISTS（409）。返回规整后的绝对路径。
 */
function checkExportTarget(raw, overwrite) {
  const p = raw.trim()
  if (p.includes('\0')) throw codedError('EXPORT_PATH_INVALID', '导出路径里不能有空字符', { path: p })
  if (!isAbsolute(p)) throw codedError('EXPORT_PATH_INVALID', `导出路径必须是绝对路径：${p}`, { path: p })
  if (!/\.json$/i.test(p)) throw codedError('EXPORT_PATH_INVALID', `导出文件必须以 .json 结尾：${p}`, { path: p })
  const target = resolvePath(p)
  let dirStat = null
  try { dirStat = statSync(dirname(target)) } catch { dirStat = null }
  if (dirStat === null || !dirStat.isDirectory()) throw codedError('EXPORT_PATH_INVALID', `目录不存在：${dirname(target)}（先建好目录，或不给 path 用默认位置）`, { path: target })
  let st = null
  try { st = statSync(target) } catch { st = null }
  if (st !== null && st.isDirectory()) throw codedError('EXPORT_PATH_INVALID', `这是一个目录，不是文件：${target}`, { path: target })
  if (isReservedDeviceName(target)) throw codedError('EXPORT_PATH_INVALID', `${basename(target)} 是 Windows 的保留设备名（CON / NUL / AUX / PRN / COM1-9 / LPT1-9，带什么扩展名都一样）：写进去的文件用普通工具打不开也删不掉，换个文件名`, { path: target })
  if (insideStateDir(target)) throw codedError('EXPORT_PATH_INVALID', `不能导出到捕获库目录里（${stateDir()}，以及各客户端的记录目录）：那里是插件自己的状态文件（规则表、过滤器、拦截状态、记录…），覆盖了会把它们弄坏；不给 path 就写到 ${exportsDir()}`, { path: target })
  if (st !== null && !overwrite) throw codedError('EXPORT_EXISTS', `文件已存在：${target}（要覆盖请带 overwrite: true）`, { path: target })
  return target
}

/** R3-07：Windows 保留设备名（不分大小写、带任何扩展名，名字后面跟空格也算）。 */
function isReservedDeviceName(p) {
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *([.]|$)/i.test(basename(p))
}

/** 真实路径（解开 junction / 符号链接）；不存在的末段原样接在已存在的父目录后面。 */
function realPathLoose(p) {
  try { return realpathSync.native(p) } catch { /* 不存在：看父目录 */ }
  try { return join(realpathSync.native(dirname(p)), basename(p)) } catch { return resolvePath(p) }
}

/** child 在 parent 里面（不含 parent 本身）。 */
function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * R3-08：目标在捕获库目录里（导出目录 exports 除外）—— proxy-rules.json、capture-filters.json、intercept-state.json、
 * 记录分片等都在那儿；把规则信封写到 proxy-rules.json 上，引擎读到的就不是数组，全部规则当场失效。
 */
function insideStateDir(target) {
  const real = realPathLoose(target)
  if (isInside(realPathLoose(exportsDir()), real)) return false
  // 多客户端：状态文件在捕获根目录；各客户端的记录目录（dir 可以是根目录外的绝对路径）同样不许写（只放行当前客户端的 exports）
  const root = stateDir()
  const protectedDirs = [root, ...loadClientsConfig(root).clients.map((c) => c.dir)]
  return protectedDirs.some((dir) => isInside(realPathLoose(dir), real))
}

/**
 * 导入文件的字节 → 文本：认 UTF-8 / UTF-16 的 BOM（记事本另存的文件常带），其余按 UTF-8（严格解码）。
 * R3-05：不是合法的 UTF-8（多半是中文 Windows 上另存的 ANSI / GBK）⇒ 按 GB18030 解码，并往 warnings 里记一句（不再静默变成 U+FFFD）。
 */
function decodeTextFile(buf, warnings = null) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：复制后按 16 位翻转字节序（swap16 要求偶数长度，落单的末字节丢掉）
    const even = buf.subarray(2, 2 + Math.floor((buf.length - 2) / 2) * 2)
    return Buffer.from(even).swap16().toString('utf16le')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* 不是 UTF-8：下面按 GB18030 试 */ }
  let text
  try {
    text = new TextDecoder('gb18030', { fatal: true }).decode(buf)
  } catch {
    if (Array.isArray(warnings)) warnings.push('文件既不是 UTF-8 / UTF-16，也不是 GBK / GB18030：按 UTF-8 解码，解不出的字节变成了 U+FFFD（规则名、mock 正文里可能有乱码）。请把文件另存为 UTF-8 再导入。')
    return buf.toString('utf8')
  }
  if (Array.isArray(warnings)) warnings.push('文件不是 UTF-8（像是中文 Windows 上另存的 ANSI / GBK）：已按 GB18030 解码。请核对规则名和 mock 正文里的中文；以后导出 / 编辑请存成 UTF-8。')
  return text
}

/** 导入内容（JSON 文本）→ 值；不是合法 JSON ⇒ IMPORT_INVALID。 */
function parseImportText(text, where = '') {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(src)
  } catch (error) {
    throw codedError('IMPORT_INVALID', `${where !== '' ? where + ' ' : ''}不是合法的 JSON：${errorMessage(error)}`)
  }
}

/** 请求体里的 data：对象 / 数组原样交给导入方校验；字符串按 JSON 解析；其余类型 ⇒ IMPORT_INVALID。 */
function importDataOf(data) {
  if (typeof data === 'string') return parseImportText(data)
  if (data !== null && typeof data === 'object') return data
  throw codedError('IMPORT_INVALID', 'data 必须是导出的文件内容（JSON 对象 / 数组，或它的 JSON 字符串）')
}

/** 导入方式：merge（默认）/ replace。 */
function importModeOf(mode) {
  if (mode === undefined || mode === null || mode === '') return 'merge'
  if (mode === 'merge' || mode === 'replace') return mode
  throw codedError('IMPORT_INVALID', `mode 只能是 merge（合并，默认）或 replace（替换）：${String(mode)}`)
}

/** 读调用方给的导入文件（绝对路径、.json、不超过 MAX_JSON_BODY_BYTES）；解码上的提醒（GBK 等）推进 warnings。 */
function readImportFile(raw, warnings = null) {
  const p = raw.trim()
  if (p.includes('\0') || !isAbsolute(p)) throw codedError('IMPORT_INVALID', `导入路径必须是绝对路径：${p}`)
  if (!/\.json$/i.test(p)) throw codedError('IMPORT_INVALID', `导入文件必须是 .json 文件：${p}`)
  const target = resolvePath(p)
  if (isReservedDeviceName(target)) throw codedError('IMPORT_INVALID', `${basename(target)} 是 Windows 的保留设备名（CON / NUL / AUX / PRN / COM1-9 / LPT1-9）：读到的是设备，不是文件`)
  let st = null
  try { st = statSync(target) } catch { st = null }
  if (st === null) throw codedError('IMPORT_FILE_NOT_FOUND', `文件不存在：${target}`, { path: target })
  if (!st.isFile()) throw codedError('IMPORT_INVALID', `不是文件：${target}`)
  if (st.size > MAX_JSON_BODY_BYTES) throw codedError('IMPORT_INVALID', `文件太大（${st.size} 字节，上限 ${MAX_JSON_BODY_BYTES} 字节）：${target}`, { limitBytes: MAX_JSON_BODY_BYTES })
  return parseImportText(decodeTextFile(readFileSync(target), warnings), target)
}

/** 引擎导出信封里的规则条数。 */
function ruleCountOf(envelope) {
  if (envelope !== null && typeof envelope === 'object') {
    if (Number.isInteger(envelope.count)) return envelope.count
    if (Array.isArray(envelope.rules)) return envelope.rules.length
  }
  return 0
}

/**
 * 规则导出成文件（POST /proxy/rules/export-file 与 api_capture_rules action=export 共用）→ { path, count, bytes }。
 * 不给 path ⇒ <捕获库目录>/exports/rules-<时间>.json；给了 path ⇒ 先校验路径，再取规则写入（UTF-8、缩进 2）。
 */
async function exportRulesToFile(proxy, { path, overwrite } = {}) {
  const given = typeof path === 'string' && path.trim() !== ''
  if (!given && path !== undefined && path !== null && path !== '') {
    throw codedError('EXPORT_PATH_INVALID', 'path 必须是字符串（.json 文件的绝对路径），不给就写到默认位置')
  }
  const target = given ? checkExportTarget(path, overwrite === true) : null
  const envelope = await proxy.exportRules()
  const text = JSON.stringify(envelope, null, 2) + '\n'
  checkExportSize(text)
  let written
  if (target !== null) {
    try {
      writeFileSync(target, text, { encoding: 'utf8', flag: overwrite === true ? 'w' : 'wx' })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
        throw codedError('EXPORT_EXISTS', `文件已存在：${target}（要覆盖请带 overwrite: true）`, { path: target })
      }
      throw error
    }
    written = target
  } else {
    written = writeNewFile(exportsDir(), `rules-${fileStamp()}`, '.json', text)
  }
  return { path: written, count: ruleCountOf(envelope), bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * R3-04：导出的规则文件必须导得回来 —— 导入（path / 请求体 / ?raw=1）的上限都是 MAX_JSON_BODY_BYTES（与其余 JSON 路由同一个），
 * 比它大的信封直接拒绝导出（否则得到一个哪条路都导不回去的文件，要到导入时才发现）。
 */
function checkExportSize(text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_JSON_BODY_BYTES) return
  const mb = (n) => (n / 1048576).toFixed(1)
  throw codedError('EXPORT_TOO_LARGE', `规则文件有 ${mb(bytes)} MB，超过导入上限 ${mb(MAX_JSON_BODY_BYTES)} MB：导出来也导不回去，已拒绝导出。大的 mock 正文请改用 Map Local（本地文件），或删掉 / 拆小几条再导出。`, { bytes, limitBytes: MAX_JSON_BODY_BYTES })
}

/** 解码时的提醒（GBK 等）并进导入结果的 warnings。 */
function withImportWarnings(result, warnings) {
  if (warnings.length === 0 || result === null || typeof result !== 'object') return result
  return { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), ...warnings] }
}

/**
 * 规则导入（POST /proxy/rules/import 与 api_capture_rules action=import 共用）：data（文件内容：信封 / 数组 / 它的 JSON 字符串）
 * 或 path（.json 文件的绝对路径，由宿主读）二选一；mode = merge（默认）/ replace；baseRevision 过期 ⇒ RULES_CONFLICT。
 * 校验（逐条 normalizeRule、全有或全无）在引擎里做。
 */
async function importRulesFrom(proxy, { data, path, mode, baseRevision } = {}) {
  const m = importModeOf(mode)
  if (path !== undefined && path !== null && path !== '' && typeof path !== 'string') {
    throw codedError('IMPORT_INVALID', 'path 必须是字符串（规则文件的绝对路径）')
  }
  const hasPath = typeof path === 'string' && path.trim() !== ''
  const hasData = data !== undefined && data !== null && !(typeof data === 'string' && data.trim() === '')
  if (hasPath && hasData) throw codedError('IMPORT_INVALID', 'data 和 path 只能给一个：data 是规则文件的内容，path 是规则文件的绝对路径')
  if (!hasPath && !hasData) throw codedError('IMPORT_INVALID', '需要 data（规则文件的内容）或 path（规则文件的绝对路径）')
  const warnings = []
  const input = hasPath ? readImportFile(path, warnings) : importDataOf(data)
  return withImportWarnings(await proxy.importRules(input, { mode: m, baseRevision }), warnings)
}

/**
 * AI 导出的 params（与 GET /records 同名的过滤参数）→ URLSearchParams；不是对象 / 查询串 ⇒ null（路由回 400）。
 * 对象里 conditions 可以是对象 / 数组（按 JSON 传）；host / contentType 可以是数组（逗号拼接）；别的键不许再嵌套对象。
 * limit / offset / cursor / includeBody 由本路由自己定，params 里的一律不用。
 */
function exportParamsOf(raw) {
  let params
  if (raw === undefined || raw === null) params = new URLSearchParams()
  else if (typeof raw === 'string') params = new URLSearchParams(raw.trim().replace(/^\?/, ''))
  else if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key !== 'conditions' && value !== null && typeof value === 'object' && !Array.isArray(value)) return null
    }
    params = paramsFromObj(raw)
  } else return null
  for (const key of ['limit', 'offset', 'cursor', 'includeBody']) params.delete(key)
  return params
}

/** 整数参数：没给 / 不是数（positive=true 时还有 ≤ 0）⇒ 默认值；其余夹到 [min, max]。 */
function intParam(value, min, max, fallback, { positive = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || (positive && n <= 0)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

/** AI 分析包里"过滤条件"那一段：快捷过滤栏一行 + 每个自定义过滤器一行。 */
function filterTextOf(params, applied) {
  const lines = []
  const quick = describeQueryParams(params)
  if (quick.length > 0) lines.push(`快捷过滤：${quick.join('；')}`)
  for (const a of applied) {
    const name = a !== null && typeof a === 'object' && typeof a.name === 'string' ? a.name.trim() : ''
    const description = a !== null && typeof a === 'object' && typeof a.description === 'string' ? a.description : ''
    // 没起名的临时条件由 resolveQueryConditions 叫「临时条件」/「临时条件 N」：不再套「过滤器「…」」
    const label = name === '' ? '自定义条件' : /^临时条件( \d+)?$/.test(name) ? name : `过滤器「${name}」`
    lines.push(`${label}：${description}`)
  }
  return lines.join('\n')
}

/**
 * POST /records/export-ai 的主体：按 params 查（新→旧、带正文、最多 limit 条）→ 生成摘要 → 存到 <捕获库目录>/exports/ai-capture-<时间>.md。
 * 返回 { path, count, totalMatched, bytes, truncatedBodies, markdown?（≤ 4 MB 才带）, markdownOmitted?, filterApplied? }。
 */
async function exportAiDigest(body, params) {
  const custom = customConditionsOf(params)
  const filter = recordFilterOf(params)
  // limit ≤ 0 与 GET /records 一样按默认值（不是"只导 1 条"）；bodyLimit 0 有含义（不含正文），负数按 0
  const limit = intParam(body.limit, 1, AI_EXPORT_MAX_RECORDS, AI_EXPORT_DEFAULT_RECORDS, { positive: true })
  const bodyLimit = intParam(body.bodyLimit, 0, AI_BODY_LIMIT_MAX, AI_BODY_LIMIT_DEFAULT)
  const snapshot = await queryCaptureAsync(
    { ...filter, ...customQueryFields(custom), limit, offset: 0, includeBody: true },
    storeDir(),
    { maxLimit: AI_EXPORT_MAX_RECORDS, legacyCursor: true },
  )
  const records = Array.isArray(snapshot.page.items) ? snapshot.page.items : []
  const totalMatched = Number.isFinite(snapshot.page.total) ? snapshot.page.total : records.length
  const generatedAt = Date.now()
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 200) : undefined
  // R4-03：5000 条 × 大正文的摘要同步生成会把宿主事件循环卡住好几秒（同进程的正向代理 / 透明拦截跟着停）：
  // ai-export.mjs 提供 buildAiDigestAsync（分批生成、批间让出事件循环）时用它，旧版只有同步的 buildAiDigest。
  const buildDigest = typeof aiExportModule.buildAiDigestAsync === 'function' ? aiExportModule.buildAiDigestAsync : buildAiDigest
  const { markdown, truncatedBodies } = await buildDigest(records, {
    title,
    filterText: filterTextOf(params, custom.applied),
    totalMatched,
    generatedAt,
    bodyLimit,
    redact: body.redact === true,
    realtimeProcess: custom.realtimeProcess !== '' ? custom.realtimeProcess : realtimeProcessSafe(),
  })
  const path = writeNewFile(exportsDir(), `ai-capture-${fileStamp(generatedAt)}`, '.md', markdown)
  const bytes = Buffer.byteLength(markdown, 'utf8')
  return {
    path,
    count: records.length,
    totalMatched,
    bytes,
    truncatedBodies,
    ...(bytes <= AI_MARKDOWN_INLINE_MAX ? { markdown } : { markdownOmitted: true, markdownNote: `摘要有 ${bytes} 字节（超过 4 MB），只存成了文件，没有随响应返回；需要全文请直接读 path。` }),
    ...(custom.applied.length > 0 ? { filterApplied: custom.applied } : {}),
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
      // 带契约 code 的错误（过滤器不合法 / 不存在、导入导出失败、规则冲突…）是调用方能照着改的那类，按表回状态；
      // 例如时间线 / 会话 / 重复检测 / 删除筛选结果这些路由里，applyFilters 解析自定义过滤器失败时抛出来的。
      if (isContractError(e) && !res.headersSent) {
        try { replyEngineError(res, e) } catch { /* 连兜底都失败：至少别再抛 */ }
        return
      }
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
          writeJson(res, 200, { name: 'dsh-api-visualizer', api: API, ok: true, captureClient: captureClientInfo() })
          return
        }

        // GET /capture-clients — 多客户端捕获库：当前客户端、各客户端是否在跑、跟随进程的轮询器状态
        if (method === 'GET' && rest === '/capture-clients') {
          writeJson(res, 200, captureClientsView(clientWatcherOf()))
          return
        }

        // POST /capture-clients { active?, mode?, clients? } — 锁定某个客户端 / 回到自动跟随 / 改客户端列表
        if (method === 'POST' && rest === '/capture-clients') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            writeJson(res, 400, { ok: false, code: 'CLIENTS_INVALID', error: '要写成对象 { active?, mode?, clients? }' })
            return
          }
          const patch = {}
          for (const key of ['active', 'mode', 'clients']) if (body[key] !== undefined) patch[key] = body[key]
          if (Object.keys(patch).length === 0) {
            writeJson(res, 400, { ok: false, code: 'CLIENTS_INVALID', error: '至少给一个：active（客户端名称，null = 跟随第一个）/ mode（auto | manual）/ clients（整张客户端列表）' })
            return
          }
          // 选定某个客户端 = 锁定它（只给 active 不给 mode 时按 manual）：自动模式下轮询器 3 s 内就会把它改回在跑的那个
          if (patch.active !== undefined && patch.active !== null) {
            patch.activeReason = 'manual'
            if (patch.mode === undefined) patch.mode = 'manual'
          }
          try {
            saveClientsConfig(stateDir(), patch)
          } catch (error) {
            if (error !== null && typeof error === 'object' && error.code === 'CLIENTS_INVALID') {
              writeJson(res, 400, { ok: false, code: 'CLIENTS_INVALID', error: error.message })
              return
            }
            throw error
          }
          // 切回自动 / 改了列表：马上按在跑的进程重算一次，不等下一轮
          const watcher = clientWatcherOf()
          if (watcher !== null && (patch.mode === 'auto' || patch.clients !== undefined)) {
            try { await watcher.tick() } catch { /* 轮询器自己记 lastError */ }
          }
          writeJson(res, 200, { ok: true, ...captureClientsView(watcher) })
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

        // GET /records?limit&offset&cursor&q&regex&method&source&status&flag&host&contentType&minDurationMs&minBytes&maxBytes&fromTs&toTs&sessionId&traceId&errors&noNoise&bodyQ&includeBody&conditions&filterId
        //   conditions = 自定义过滤器的条件 JSON（一个过滤器对象或数组），filterId = 已存过滤器的 id 或名称；与其余参数 AND。
        //   条件不合法 ⇒ 400 FILTER_INVALID；过滤器不存在 ⇒ 404 FILTER_NOT_FOUND（available = 已有名称）。total 仍是匹配条数。
        if (method === 'GET' && rest === '/records') {
          const includeBody = params.get('includeBody') === '1'
          const limitRaw = Number(params.get('limit'))
          const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), 2000)
          const offsetRaw = Number(params.get('offset'))
          const offset = Math.max(Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0, 0)
          const filter = recordFilterOf(params)
          let custom
          let snapshot
          try {
            custom = customConditionsOf(params)
            snapshot = await queryCaptureAsync({ ...filter, ...customQueryFields(custom), limit, offset, includeBody }, storeDir(), { maxLimit: 2000, legacyCursor: true })
          } catch (error) {
            if (!isContractError(error)) throw error // worker 超时 / 库在查询途中变了：宿主侧问题，交给兜底回 500
            replyEngineError(res, error)
            return
          }
          const page = snapshot.page.items
          const total = snapshot.page.total
          const nextCursor = snapshot.page.nextCursor
          // 面板路由同样要带新鲜度/归因（第十轮自查：它此前只回 total/items/cursor，
          // 于是面板与脚本消费者看不到"引擎没在跑 = 这是历史数据"和"归因没有生产者"）。
          let stForRoute = null
          try { stForRoute = capture && typeof capture.status === 'function' ? capture.status() : null } catch { stForRoute = null }
          const view = buildQueryView({ records: page, summary: snapshot.summary, status: stForRoute, callerFilter: String(params.get('caller') ?? ''), retention: snapshot.retention })
          // 过滤掉的"字段缺失"记录必须出声：空结果有两种成因（"确实没有" vs "这些记录没有该字段"），
          // 只说一个 total 会让调用方把后者读成前者（F-046，G1 黑盒校验提的场景 A）。
          const noField = snapshot.page.excludedNoField
          const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0 || noField.conditions > 0)
          writeJson(res, 200, {
            total,
            items: page,
            nextCursor,
            hasMore: snapshot.page.hasMore,
            ...(custom.applied.length > 0 ? { filterApplied: custom.applied } : {}),
            ...(noFieldAny ? { excludedNoField: noField } : {}),
            ...(noFieldAny
              ? {
                  excludedNoFieldNote: excludedNoFieldNote(noField, quickNoFieldKeys(filter), custom.applied.length > 0),
                }
              : {}),
            ...view,
            freshnessNote: freshnessNote(view.freshness),
            callerAttributionNote: callerAttributionNote(view.callerAttribution),
            retentionNote: retentionNote(view.retention),
          })
          return
        }

        // POST /records/export-ai { params, limit?, bodyLimit?, redact?, title? } — 「AI 分析包」：把命中的记录整理成 Markdown 存成文件
        //   params 与 GET /records 同名（含 conditions / filterId）；新→旧取最多 limit 条（默认 500，最多 5000），摘要里按时间先后排。
        if (method === 'POST' && rest === '/records/export-ai') {
          const body = await readBodyOrReply(req, res, 1024 * 1024)
          if (body === undefined) return
          const exportParams = exportParamsOf(body.params)
          if (exportParams === null) {
            writeJson(res, 400, { error: 'params 要写成对象（键与 GET /records 的查询参数同名，如 {"method":"GET","filterId":"…"}）或查询串' })
            return
          }
          let out
          try {
            out = await exportAiDigest(body, exportParams)
          } catch (error) {
            if (!isContractError(error)) throw error
            replyEngineError(res, error)
            return
          }
          writeJson(res, 200, out)
          return
        }

        // GET /filters — 已存的自定义过滤器 + 条件构造器用的字段表 / 运算表
        if (method === 'GET' && rest === '/filters') {
          writeJson(res, 200, { filters: loadFilters(stateDir()), fields: FILTER_FIELDS, ops: FILTER_OPS })
          return
        }

        // POST /filters { filter } — 新建 / 更新（filter.id 是已有过滤器 ⇒ 更新）；名称不区分大小写唯一（重名 409 FILTER_NAME_TAKEN）
        if (method === 'POST' && rest === '/filters') {
          const body = await readBodyOrReply(req, res, FILTER_BODY_MAX_BYTES)
          if (body === undefined) return
          if (body.filter === null || typeof body.filter !== 'object' || Array.isArray(body.filter)) {
            writeJson(res, 400, { error: '请求体要写成 { "filter": { "name": "…", "mode": "all", "conditions": [ … ] } }', code: 'FILTER_INVALID' })
            return
          }
          try {
            writeJson(res, 200, upsertFilter(stateDir(), body.filter))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // DELETE /filters?id= — 删除一个过滤器（id；也认名称）
        if (method === 'DELETE' && rest === '/filters') {
          const key = (params.get('id') ?? '').trim()
          if (key === '') {
            writeJson(res, 400, { error: '需要 id：DELETE /api/dsh-api-visualizer/filters?id=<过滤器 id>', code: 'FILTER_INVALID' })
            return
          }
          try {
            const found = findFilter(loadFilters(stateDir()), key)
            writeJson(res, 200, { filters: deleteFilter(stateDir(), found !== null && found !== undefined ? found.id : key) })
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // GET /filters/export — 过滤器文件（{ format, version, exportedAt, filters }，浏览器下载）
        if (method === 'GET' && rest === '/filters/export') {
          writeJson(res, 200, exportFilters(loadFilters(stateDir())), { 'content-disposition': `attachment; filename="api-filters-${fileStamp()}.json"` })
          return
        }

        // POST /filters/import { data, mode? } — data = 导出的文件内容（对象 / 数组 / JSON 字符串）；merge（默认：同名不同内容改名）/ replace
        if (method === 'POST' && rest === '/filters/import') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          try {
            const mode = importModeOf(body.mode)
            if (body.data === undefined || body.data === null) throw codedError('IMPORT_INVALID', '需要 data（导出的过滤器文件内容）')
            // 字符串 / 对象 / 数组的解析与校验都在 importFilters 里（IMPORT_INVALID / FILTER_INVALID，全有或全无）
            writeJson(res, 200, importFilters(stateDir(), body.data, { mode }))
          } catch (error) {
            replyEngineError(res, error)
          }
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
          const patch = await readBodyOrReply(req, res, 64 * 1024, { detail: true })
          if (patch === undefined) return
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
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES, { detail: true })
          if (body === undefined) return
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
          const cs = compactStateOf(storeDir())
          writeJson(res, 200, {
            ok: true,
            // 一句话说清"现在到底能不能抓到东西" —— 与工具面**共用 capture-control.mjs**，
            // 否则面板/路由/MCP 三个消费者又会各说各话（本仓第 38 类：同一逻辑两份实现必然漂移）。
            // 实测：MCP 面的 capture_status 原先拿不到 summary/ok（路由里没有），审查时当场发现。
            summary: captureStatusSummary(capture.status()),
            ...capture.status(),
            managed: true,
            // 多客户端捕获库：下面的计数都是**当前客户端**那个库的（captureClient.recordsDir）
            captureClient: captureClientInfo(),
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
              lastCompactKeptBytes: cs.lastCompactKeptBytes,
              lastCompactDropped: cs.lastCompactDropped,
              lastCompactTruncatedBy: cs.lastCompactTruncatedBy,
              compactCount: cs.compactCount,
              lastCompactAt: cs.lastCompactAt || null,
              lastCompactAgoMs: cs.lastCompactAt ? Date.now() - cs.lastCompactAt : null,
              lastCompactReason: cs.lastCompactReason,
              lastCompactError: cs.lastCompactError,
              duplicateAppendsSinceCompact: cs.duplicateAppendsSinceCompact,
              // AV-03 补充：把'被节流'如实暴露 —— 没有它，写放大在外部不可观测。
              throttled: cs.compactThrottled,
              wantedButThrottled: cs.compactWantedButThrottled,
              intervalMs: COMPACT_MIN_INTERVAL_MS,
              // F-007：这份 status 出自哪个版本的代码，一并说清（不陈旧时不加字段）
              ...(staleCodeInfo(moduleRoots(AV_PLUGIN_DIR)) || {}),
            },
          })
          return
        }

        // POST /capture/start { logPath?, replay? } — begin Fiddler-style live capture
        if (method === 'POST' && rest === '/capture/start') {
          // 空 body 现在由 readJsonBody 解析成 `{}`（它是**合法**的：文档就写着 body 可选）；
          // 剩下的 400 只对应"body 非空但不是合法 JSON" —— 那是调用方真的写错了（超限回 413）。
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
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
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
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
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
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
            execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TraceLog', traceLog, '-LogDir', stateDir()], { timeout: 60000, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
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
          const body = await readBodyOrReply(req, res, 256 * 1024)
          if (body === undefined) return
          const name = String(body.name ?? '').trim()
          if (name === '') {
            writeJson(res, 400, { error: 'name required' })
            return
          }
          // R4-08：filterId / conditions 在保存时就解析成条件快照存进基线（不存引用）—— 之后改名、改条件、删掉那个过滤器，
          // 都不会让对比换了一批记录去比（假的契约漂移）或 404。不合法 / 不存在照常回 400 / 404，什么都不存。
          const custom = customConditionsOf(paramsFromObj(body.filter ?? {}))
          const storedFilter = baselineFilterSnapshot(body.filter, custom)
          const filtered = applyFilters(readAll(), paramsFromObj(storedFilter))
          const baseline = {
            name,
            savedAt: Date.now(),
            records: filtered.length,
            filter: storedFilter,
            ...(custom.applied.length > 0 ? { filterApplied: custom.applied } : {}),
            endpoints: buildContracts(filtered),
          }
          mkdirSync(baselineDir(), { recursive: true })
          writeFileSync(baselineFile(name), JSON.stringify(baseline, null, 2), 'utf8')
          writeJson(res, 200, { name, savedAt: baseline.savedAt, records: baseline.records, endpoints: Object.keys(baseline.endpoints).length })
          return
        }

        // POST /baseline/diff { name } — contract drift vs the saved baseline
        if (method === 'POST' && rest === '/baseline/diff') {
          const body = await readBodyOrReply(req, res, 256 * 1024)
          if (body === undefined) return
          const baseline = readBaseline(String(body.name ?? ''))
          if (baseline === null) {
            writeJson(res, 404, { error: 'baseline not found' })
            return
          }
          const currentList = applyFilters(readAll(), paramsFromObj(baseline.filter ?? {}))
          const current = buildContracts(currentList)
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
            currentRecords: currentList.length,
            ...(Array.isArray(baseline.filterApplied) ? { filterApplied: baseline.filterApplied } : {}),
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
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          writeJson(res, 200, searchSource({ vm: body.vm, api: body.api }))
          return
        }

        // POST /source/open { path, line } — open a located file (VS Code with line, else explorer)
        if (method === 'POST' && rest === '/source/open') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
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
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          const keepDays = Math.max(0, Math.min(Number(body.keepDays ?? 7) || 7, 365))
          writeJson(res, 200, capture.rotate({ keepDays, pruneOnly: body.pruneOnly === true }))
          return
        }

        // GET /proxy/rules — AutoResponder rule list (+ hit counters, revision)
        if (method === 'GET' && rest === '/proxy/rules') {
          writeJson(res, 200, proxy.getRules())
          return
        }

        // POST /proxy/rules { rules: [...], baseRevision? } — replace the rule set
        //   C3：上限与 /proxy/rules/quick 一样是 MAX_JSON_BODY_BYTES —— 一键 'original' 规则能带上 2MB 级的正文，
        //   旧的 256KB 上限会让之后任何一次整表保存失败（还被误报成"连不上宿主"）。
        //   C12：带 baseRevision ⇒ 乐观并发检查：规则表在你读取之后被别人（agent / 另一个面板）改过 ⇒ 409 + 当前 revision，
        //   而不是拿一份旧快照把别人新加的规则悄悄删掉。
        if (method === 'POST' && rest === '/proxy/rules') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          const list = Array.isArray(body) ? body : body.rules
          if (!Array.isArray(list)) {
            writeJson(res, 400, { error: 'expected { rules: [...] } or an array' })
            return
          }
          // 规则在写入时校验（改写脚本语法、Map Local 路径…）：错在这里报，而不是到流量里"悄悄不生效"
          try {
            writeJson(res, 200, await proxy.setRules(list, { baseRevision: Array.isArray(body) ? undefined : body.baseRevision }))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // POST /proxy/rules/op { op, id?, rule?, url?, method? } — 单条改动（C12：面板/agent 改一条，不再整表重写）
        //   op = add（rule，插到最前）/ update（id + rule，保留 id 与命中数）/ remove / enable / disable（id）/ clear /
        //   removeQuick（url + method：删掉该路径上方法相同或不限方法的一键规则；method='' 删该路径上全部一键规则）
        if (method === 'POST' && rest === '/proxy/rules/op') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          if (typeof body.op !== 'string' || body.op === '') {
            writeJson(res, 400, { error: 'op required: add / update / remove / enable / disable / clear / removeQuick', code: 'RULE_INVALID' })
            return
          }
          if (body.rule !== undefined && (body.rule === null || typeof body.rule !== 'object' || Array.isArray(body.rule))) {
            writeJson(res, 400, { error: 'rule must be a JSON object', code: 'RULE_INVALID' })
            return
          }
          try {
            writeJson(res, 200, await proxy.ruleOp({ op: body.op, id: body.id, rule: body.rule, url: body.url, method: body.method }))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // GET /proxy/rules/item?id= — 一条完整规则（工具/列表只给精简投影时，用它取完整正文）
        if (method === 'GET' && rest === '/proxy/rules/item') {
          const id = (params.get('id') ?? '').trim()
          if (id === '') {
            writeJson(res, 400, { error: 'id required: /proxy/rules/item?id=<rule id>', code: 'RULE_INVALID' })
            return
          }
          const rule = await proxy.getRule(id)
          if (rule === null || rule === undefined) {
            writeJson(res, 404, { error: `rule not found: ${id}`, code: 'RULE_NOT_FOUND' })
            return
          }
          writeJson(res, 200, { rule })
          return
        }

        // GET /proxy/rules/export — 规则文件 { format, version, exportedAt, count, rules }（不含命中数与编译后的 ops；浏览器下载）
        if (method === 'GET' && rest === '/proxy/rules/export') {
          let envelope
          try {
            envelope = await proxy.exportRules()
          } catch (error) {
            replyEngineError(res, error)
            return
          }
          try {
            checkExportSize(JSON.stringify(envelope, null, 2))
          } catch (error) {
            replyEngineError(res, error)
            return
          }
          writeJson(res, 200, envelope, { 'content-disposition': `attachment; filename="api-rules-${fileStamp()}.json"` })
          return
        }

        // POST /proxy/rules/export-file { path?, overwrite? } — 规则写成文件 → { path, count, bytes }
        //   不给 path：<捕获库目录>/exports/rules-<时间>.json；给 path：.json 绝对路径、目录已存在（否则 400 EXPORT_PATH_INVALID），
        //   文件已存在且没带 overwrite:true ⇒ 409 EXPORT_EXISTS。
        if (method === 'POST' && rest === '/proxy/rules/export-file') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          try {
            writeJson(res, 200, await exportRulesToFile(proxy, { path: body.path, overwrite: body.overwrite }))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // POST /proxy/rules/import { data? | path?, mode?, baseRevision? } — 导入规则文件
        //   mode=merge（默认：新 id、命中数清零、跳过与现有规则完全相同的，其余按文件顺序插到最前）/ replace（整表换成导入的）；
        //   400 IMPORT_INVALID / RULE_INVALID、404 IMPORT_FILE_NOT_FOUND、409 RULES_CONFLICT。
        //   R3-04：?raw=1 ⇒ 请求体就是规则文件本身（原样字节；认 BOM / UTF-16 / GBK，与 path 导入同一套解码），mode / baseRevision 走查询参数。
        //   面板不必再把文件文本 JSON 转义一遍塞进 {data}（转义后会胀到超过上限：48 MB 的导出文件变成 65 MB 的请求）。
        if (method === 'POST' && rest === '/proxy/rules/import' && params.get('raw') === '1') {
          let bytes
          try {
            bytes = await readJsonBody(req, MAX_JSON_BODY_BYTES, { raw: true })
          } catch (error) {
            replyBodyError(res, error)
            return
          }
          try {
            if (bytes.length === 0) throw codedError('IMPORT_INVALID', '?raw=1 时请求体就是规则文件本身，不能为空')
            const warnings = []
            const data = parseImportText(decodeTextFile(bytes, warnings), '规则文件')
            const mode = params.get('mode') ?? undefined
            const baseRevision = params.get('baseRevision') ?? undefined
            writeJson(res, 200, withImportWarnings(await importRulesFrom(proxy, { data, mode, baseRevision }), warnings))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }
        if (method === 'POST' && rest === '/proxy/rules/import') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          try {
            writeJson(res, 200, await importRulesFrom(proxy, { data: body.data, path: body.path, mode: body.mode, baseRevision: body.baseRevision }))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // POST /proxy/rules/quick { url, method?, preset, body?, status?, latencyMs?, recordId?, name? } — 一键 mock / 延时 / 超时
        //   preset=original / empty-lists 需要"该接口最近一次的真实响应"：宿主按 recordId / 方法+路径自己找（findOriginal），
        //   连同 Content-Type、是否截断、是否 hex/base64 一起交给引擎判定（C25 / C40）；返回里的 reach 说清此刻能否命中（C9）。
        if (method === 'POST' && rest === '/proxy/rules/quick') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          try {
            writeJson(res, 200, await proxy.quickRule({
              url: String(body.url ?? ''),
              method: typeof body.method === 'string' ? body.method : '',
              preset: typeof body.preset === 'string' ? body.preset : 'empty-object',
              body: typeof body.body === 'string' ? body.body : undefined,
              status: Number.isInteger(body.status) ? body.status : undefined,
              latencyMs: Number(body.latencyMs) > 0 ? Number(body.latencyMs) : undefined,
              recordId: typeof body.recordId === 'string' ? body.recordId : undefined,
              name: typeof body.name === 'string' ? body.name : undefined,
            }))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // GET /proxy/netsim — 全局延时 / 弱网设置（含预设表）
        if (method === 'GET' && rest === '/proxy/netsim') {
          writeJson(res, 200, proxy.getNetsim())
          return
        }

        // POST /proxy/netsim { enabled?, preset?, requestDelayMs?, responseDelayMs?, jitterMs?, downKbps?, upKbps?, hosts?, urlFilter?, scope? }
        if (method === 'POST' && rest === '/proxy/netsim') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          try {
            writeJson(res, 200, await proxy.setNetsim(body))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // GET /proxy/intercept/status?deep=0|1&fresh=0|1 — 透明拦截状态（deep：外加根证书信任 / 安全网任务；fresh=1：不用缓存）
        if (method === 'GET' && rest === '/proxy/intercept/status') {
          const deep = params.get('deep') !== '0'
          const fresh = params.get('fresh') === '1'
          try {
            writeJson(res, 200, await proxy.interceptStatus({ deep, fresh }))
          } catch (error) {
            writeJson(res, 500, { ok: false, ...engineErrorBody(error) })
          }
          return
        }

        // GET /proxy/intercept/suggest[?limit=] — 从捕获库里挑候选域名（sources 分来源计数；只有 realtime 才算客户端自己的流量）
        if (method === 'GET' && rest === '/proxy/intercept/suggest') {
          const limitRaw = Number(params.get('limit'))
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 40
          writeJson(res, 200, { items: interceptSuggestions(limit) })
          return
        }

        // POST /proxy/intercept/start { hosts: [...] | "a.com b.com", ip?, strictUpstreamTls?, allowWithoutSafetyNet? } — 启用 / 更新名单（会改 hosts）
        if (method === 'POST' && rest === '/proxy/intercept/start') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          let r
          try {
            r = await proxy.interceptStart(body)
          } catch (error) {
            writeJson(res, 500, { ok: false, ...engineErrorBody(error) })
            return
          }
          writeJson(res, r && r.ok === true ? 200 : 409, r ?? { ok: false, error: 'intercept start returned nothing' })
          return
        }

        // POST /proxy/intercept/stop { graceMs?, force? } — 还原 hosts，排空后关监听
        if (method === 'POST' && rest === '/proxy/intercept/stop') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          let r
          try {
            r = await proxy.interceptStop(body)
          } catch (error) {
            writeJson(res, 500, { ok: false, ...engineErrorBody(error) })
            return
          }
          writeJson(res, r && r.ok === true ? 200 : 409, r ?? { ok: false, error: 'intercept stop returned nothing' })
          return
        }

        // DELETE /proxy/rules — clear all rules
        if (method === 'DELETE' && rest === '/proxy/rules') {
          try {
            writeJson(res, 200, await proxy.setRules([]))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // GET /proxy/breakpoints — 断点配置 + 当前挂起的请求
        if (method === 'GET' && rest === '/proxy/breakpoints') {
          writeJson(res, 200, proxy.getBreakpoints())
          return
        }

        // POST /proxy/breakpoints { enabled?, urlFilter?, methodFilter? } — 更新断点配置
        if (method === 'POST' && rest === '/proxy/breakpoints') {
          const body = await readBodyOrReply(req, res, 64 * 1024)
          if (body === undefined) return
          try {
            writeJson(res, 200, await proxy.setBreakpoints(body))
          } catch (error) {
            replyEngineError(res, error)
          }
          return
        }

        // POST /proxy/breakpoints/release { id, action:'continue'|'drop', edits? } — 放行/丢弃一个挂起请求
        //   非法编辑（状态码越界、响应头名/值非法）引擎抛 BP_EDIT_INVALID ⇒ 400，请求仍挂着、改好了可以再放
        if (method === 'POST' && rest === '/proxy/breakpoints/release') {
          const body = await readBodyOrReply(req, res, MAX_JSON_BODY_BYTES)
          if (body === undefined) return
          let released
          try {
            released = await proxy.releaseBreakpoint(String(body.id ?? ''), body.action === 'drop' ? 'drop' : 'continue', body.edits ?? null)
          } catch (error) {
            replyEngineError(res, error)
            return
          }
          writeJson(res, released ? 200 : 404, released ? proxy.getBreakpoints() : { error: 'breakpoint not found (already released or timed out?)' })
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
    // 自定义过滤器的条件是对象 / 数组：按 JSON 传（String() 只会得到 "[object Object]"）
    if (key === 'conditions' && typeof value === 'object') {
      params.set('conditions', JSON.stringify(value))
      continue
    }
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
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
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
          // 同一个 F-055 坑：下面 execute 在"有记录因缺字段被排除"时会带这两个字段，schema 不声明 ⇒ 那一次查询整个工具报错。
          excludedNoField: { type: 'object', additionalProperties: true, description: '因缺少被过滤的字段而被排除的条数 {durationMs, bytesRes, status}' },
          excludedNoFieldNote: { type: 'string', description: 'excludedNoField 的人话说明' },
          // 自定义过滤器（filter / conditions）实际生效的条件；没用自定义过滤时不出现（声明成可空，同样是为了不让宿主判非法输出）
          filterApplied: {
            oneOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'null' }],
            description: '实际生效的自定义过滤器，每项 {name, description}',
          },
          // 多客户端捕获库：查的是哪个客户端的记录（没配置客户端时不出现；同样声明成可空，免得宿主判非法输出）
          captureClient: {
            oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
            description: '本次查询的记录属于哪个客户端 {client, mode, recordsDir}（mode: auto 跟随启动的客户端 / manual 锁定）',
          },
        },
      },
      // 渲染逻辑在可测的 lib/query-view.mjs 里（本文件依赖 dsh-tools，普通 node 进程 import 不到）；
      // 用了自定义过滤器时在最前面补一行"按什么条件过滤的"。
      render: (args, value) => {
        const blocks = renderQuery(args, value)
        const applied = value !== null && typeof value === 'object' && Array.isArray(value.filterApplied) ? value.filterApplied : []
        if (applied.length === 0 || blocks.length === 0 || blocks[0].type !== 'text') return blocks
        const line = '自定义过滤：' + applied.map((f) => {
          const name = f !== null && typeof f === 'object' && typeof f.name === 'string' && f.name !== '' ? `「${f.name}」` : ''
          return name + (f !== null && typeof f === 'object' && typeof f.description === 'string' ? f.description : '')
        }).join('；')
        return [{ ...blocks[0], text: line + '\n' + blocks[0].text }, ...blocks.slice(1)]
      },
    },
    async execute(args) {
      const a = args !== null && typeof args === 'object' ? args : {}
      // 自定义过滤器：filter = 面板「过滤器」里存的名称或 id，conditions = 条件 JSON；两个都给 ⇒ 都生效（AND）。
      // 与 GET /records、MCP 面同一个解析（resolveQueryConditions），同一个匹配（存储层 compileFilter）。
      const { filter: savedFilter, conditions: rawConditions, ...queryArgs } = a
      const wantsCustom = (typeof savedFilter === 'string' && savedFilter.trim() !== '') ||
        (rawConditions !== undefined && rawConditions !== null && !(typeof rawConditions === 'string' && rawConditions.trim() === ''))
      let custom = { conditions: null, applied: [], realtimeProcess: '' }
      if (wantsCustom) {
        const realtimeProcess = realtimeProcessSafe()
        let resolved
        try {
          resolved = resolveQueryConditions(
            { filter: typeof savedFilter === 'string' && savedFilter.trim() !== '' ? savedFilter.trim() : undefined, conditions: rawConditions },
            { dir: stateDir(), realtimeProcess },
          )
        } catch (error) {
          throw customFilterToolError(error, savedFilter)
        }
        custom = {
          conditions: resolved !== null && typeof resolved === 'object' && resolved.conditions !== undefined ? resolved.conditions : null,
          applied: resolved !== null && typeof resolved === 'object' && Array.isArray(resolved.applied) ? resolved.applied : [],
          realtimeProcess,
        }
      }
      // 先定下查哪个客户端的库，再查：查询途中当前客户端切换了，返回里报的也还是实际查的那一个
      const clientInfo = captureClientInfo()
      let snapshot
      try {
        snapshot = await queryCaptureAsync({ ...queryArgs, ...customQueryFields(custom) }, clientInfo.recordsDir)
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'FILTER_INVALID') throw customFilterToolError(error, savedFilter)
        throw error
      }
      const page = snapshot.page
      const out = page.items

      // F-005 / F-004c：新鲜度 + 调用方归因 —— **走共享的单一产出点**（第十轮自查：这段原来只写在这里，
      // 于是 MCP 面与面板路由都拿不到它）。见 lib/query-view.mjs。
      let st = null
      try { st = capture && typeof capture.status === 'function' ? capture.status() : null } catch { st = null }
      // 保留期同样要带出来（工具面与路由面不许各说各话）
      const retention = snapshot.retention
      const { freshness, callerAttribution } = buildQueryView({ records: out, summary: snapshot.summary, status: st, callerFilter: String(args.caller ?? ''), retention })

      // F-046：**空结果必须可解释**。`minDurationMs`/`minBytes`/`maxBytes`/`status`/`errors` 这些过滤，
      // 会把**没有那个字段**的记录排除掉（旧实现里 maxBytes 更糟：把"字节未知"当成 0 字节，于是**放行**了它）。
      // 于是"0 条"有两种完全不同的含义 —— 不把计数带出来，调用方只能猜成"没有慢请求/没有错误"。
      const noField = page.excludedNoField
      const noFieldAny = noField && (noField.durationMs > 0 || noField.bytesRes > 0 || noField.status > 0 || noField.conditions > 0)
      return {
        total: page.total,
        returned: out.length,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        items: out,
        ...(noFieldAny ? { excludedNoField: noField } : {}),
        ...(noFieldAny
          ? {
              excludedNoFieldNote: excludedNoFieldNote(noField, quickNoFieldKeys(queryArgs), custom.applied.length > 0),
            }
          : {}),
        freshness,
        callerAttribution,
        retention,
        retentionNote: retentionNote(retention),
        ...(custom.applied.length > 0 ? { filterApplied: custom.applied } : {}),
        ...(clientInfo.configured ? { captureClient: { client: clientInfo.client, mode: clientInfo.mode, recordsDir: clientInfo.recordsDir } } : {}),
      }
    },
  })

}

/**
 * api_capture_query 的自定义过滤失败 → 一个说清怎么改的 Error（工具面抛错即失败，宿主把 message 交给模型）：
 *   FILTER_NOT_FOUND 列出已存过滤器的名称；FILTER_INVALID 原样带上"第 N 个条件：…"。
 */
function customFilterToolError(error, savedFilter) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
  let message = errorMessage(error)
  if (code === 'FILTER_NOT_FOUND') {
    const names = Array.isArray(error.available) ? error.available.filter((n) => typeof n === 'string' && n !== '') : []
    message = `没有这个自定义过滤器：「${String(savedFilter ?? '').trim()}」。` + (names.length > 0
      ? `已存的过滤器：${names.map((n) => `「${n}」`).join('、')}（filter 填名称或 id）。`
      : '还没有保存任何过滤器：在面板「过滤器」里新建，或改用 conditions 直接写条件。')
  } else if (code === 'FILTER_INVALID') {
    message = `自定义过滤条件不合法：${errorMessage(error)}`
  }
  return Object.assign(new Error(message), code !== undefined ? { code } : {})
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
 * 宿主与 MCP 已共用 Rust 存储；两条裁剪入口都写 trimmed.json。
 * 合并内存计数，保留标记文件暂时无法写入时的本进程证据。
 */
function retentionInfo() {
  let marker = null
  try { marker = JSON.parse(readFileSync(join(storeDir(), 'trimmed.json'), 'utf8')) } catch { marker = null }
  const memDropped = Number(compactStateOf(storeDir()).lastCompactDropped) || 0
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
    maxBytes: MAX_STORE_BYTES,
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
 *
 * 三个注入口只给自测用（假引擎 / 假落库 / 假的客户端进程名）；宿主走默认值。
 */
function createCapture({
  newEngine = (opts) => new CaptureEngine(opts),
  append = (batch) => appendRecords(batch, { evidenceLevel: 'observed' }),
  processName = realtimeProcessSafe,
} = {}) {
  let queue = []
  let engine = null
  let flushTimer = null
  let logPath = process.env.DSH_CAPTURE_LOG ?? DEFAULT_LOG
  let callerLogPath = process.env.DSH_CAPTURE_CALLER_LOG ?? DEFAULT_CALLER_LOG
  // 本次 start() 时刻的 emitted / 去重 基线（见 status() 里完整性判据的说明）
  let emittedAtStart = 0
  let dedupedAtStart = 0
  // 透明拦截开着时，同一条请求代理那边已经记了一条（更全：带规则/改写信息），
  // 实时日志稍后再解析出同一条 ⇒ 由代理"认领"掉，免得面板上每个接口都出现两次。
  //   dedupe(rec) → null（不是重复，照常入库）| { proxyRecordId }（代理已记过：这条丢弃）
  //   onDedupedCaller(proxyRecordId, caller)：被丢弃的这条带着调用方归因时，交给代理那条（E2）
  let dedupe = null
  let onDedupedCaller = null
  // C1：这里曾用 `claimedIds.has(rec.id)` 预筛 —— 但实时记录在 normalize（appendRecords 里）之前**根本没有 id**，
  // 第一次认领就把 undefined 放进集合，此后**每一条**实时记录都被当成"已认领"静默丢掉（任何域名、拦截停了也一样），
  // 直到宿主重启。实时记录只在 finalize 时 emit 一次，不需要按 id 去重；
  // 真正要防的是"落库失败退回队列的那批再跑一遍认领"（会把代理那边的认领名额白白多吃掉）——
  // 所以按**对象身份**记住已判过的记录（WeakSet，不必清理，也不依赖任何字段）。
  const evaluated = new WeakSet()
  let dedupedCount = 0

  const AUTO_ROTATE_BYTES = 300 * 1024 * 1024

  /** 认领结果规整成 null | { proxyRecordId }（钩子抛错 / 返回别的东西一律当"不是重复"：宁可重复一条也不丢记录）。 */
  const claimOf = (rec) => {
    let claim = null
    try { claim = dedupe(rec) } catch { claim = null }
    return claim !== null && typeof claim === 'object' && !Array.isArray(claim) ? claim : null
  }

  /**
   * 实时日志记录本来就是客户端进程自己的流量：没带 clientProcess 的补上配置的客户端进程名（过滤器的「进程」、AI 分析包都看它）。
   * 只在认领判定**之后**、对留下来的记录做，并且**原地**写在同一个对象上 —— 落库失败退回队列时对象身份不变，
   * evaluated 照样认得它（不会再跑一遍认领），去重计数与完整性判据都不受影响；已经有进程名的记录不动。
   */
  const tagRealtimeProcess = (batch) => {
    let name = null
    for (const rec of batch) {
      if (rec === null || typeof rec !== 'object' || rec.source !== 'realtime') continue
      if (typeof rec.clientProcess === 'string' && rec.clientProcess !== '') continue
      if (name === null) {
        try { name = String(processName() ?? '').trim().replace(/\.exe$/i, '') } catch { name = '' }
      }
      if (name === '') return // 没配置客户端进程名：不编一个
      rec.clientProcess = name
    }
  }

  const flushQueue = () => {
    if (queue.length === 0) return
    let batch = queue.splice(0, queue.length)
    if (dedupe !== null) {
      const kept = []
      for (const rec of batch) {
        if (rec === null || typeof rec !== 'object' || evaluated.has(rec)) {
          kept.push(rec)
          continue
        }
        evaluated.add(rec)
        const claim = claimOf(rec)
        if (claim === null) {
          kept.push(rec)
          continue
        }
        dedupedCount++
        const proxyRecordId = typeof claim.proxyRecordId === 'string' && claim.proxyRecordId !== '' ? claim.proxyRecordId : null
        if (proxyRecordId !== null && onDedupedCaller !== null && rec.caller !== null && typeof rec.caller === 'object') {
          try { onDedupedCaller(proxyRecordId, rec.caller) } catch { /* 归因搬运失败不影响去重本身 */ }
        }
      }
      batch = kept
      if (batch.length === 0) return
    }
    tagRealtimeProcess(batch)
    try {
      append(batch)
    } catch {
      queue.unshift(...batch) // 已判过的不会再跑认领（evaluated）
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
      engine = newEngine({ logPath, callerLogPath, onRecord: (rec) => { queue.push(rec) } })
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
      dedupedAtStart = dedupedCount
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
    /**
     * 透明拦截的去重钩子：fn(rec) → null（照常入库）| { proxyRecordId }（代理已经记过这条：丢弃并计数）；
     * onCaller(proxyRecordId, caller)：被丢弃的实时记录带着调用方归因时调用（把归因搬到代理那条上，E2）。
     */
    setDedupe(fn, onCaller = null) {
      dedupe = typeof fn === 'function' ? fn : null
      onDedupedCaller = typeof onCaller === 'function' ? onCaller : null
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
        const emittedRaw = (Number(st.counters && st.counters.emitted) || 0) - emittedAtStart  // 自本次启动起的增量（同区间）
        // 被透明拦截认领掉的实时记录**本来就不进库**（代理那条代表它）⇒ 不算进"应当进库"的条数；
        // 不扣掉的话，一半流量被认领时，真的双写也只算出 1.0 —— 又一个假绿灯。
        const dedupedSinceStart = Math.max(0, dedupedCount - dedupedAtStart)
        const emitted = Math.max(0, emittedRaw - dedupedSinceStart)
        if (startedAt > 0) {
          const realtime = readAll().filter((r) => (r.source ?? '') === 'realtime' && (Number(r.ts) || 0) >= startedAt - 1000).length
          integrity = doubleWriteVerdict({ emitted, realtimeSinceStart: realtime })
          if (integrity !== null && dedupedSinceStart > 0) {
            integrity = { ...integrity, emittedRaw, dedupedByIntercept: dedupedSinceStart }
            if (emitted === 0 && emittedRaw > 0) {
              integrity.note = '本次启动以来解析出的 ' + emittedRaw + ' 条实时记录**全部**被透明拦截认领（代理那边已记录同一请求，实时这条不重复入库）' +
                ' —— 库里没有新增 realtime 行，无法判定是否重复写入（这是"还不知道"，不是"没问题"）。'
            }
          }
        }
      } catch { integrity = null } // 拿不到就不报（"没读到" ≠ "没问题"，但也不许编一个）
      return { ...st, integrity, dedupedByIntercept: dedupedCount }
    },
    dispose() {
      if (engine !== null) Promise.resolve(engine.stop()).catch(() => {})
      stopFlush({ drain: true })
    },
  }
}

// ---------------------------------------------------------------- 一键 mock 的"原响应"（C25 / C40）

/** 存储层单字段上限：与 lib/capture-store.mjs 的 MAX_FIELD_BYTES 一致（normalize 按它截断 resBody，截断标记也会被一起切掉）。 */
const STORE_FIELD_CAP = 2 * 1024 * 1024
/** 代理 / 实时引擎在正文超过 BODY_CAP 时追加的截断标记。 */
const BODY_TRUNCATED_MARK = '…(截断)'
/** 二进制正文落库成 'hex:' + 前 64KB（不带截断标记）。 */
const HEX_BODY_CAP_CHARS = 'hex:'.length + 2 * 64 * 1024

/** 接口路径键：去 #片段（实时日志的实例号后缀）、去查询串、去尾部 /、小写。 */
function endpointPathKey(url) {
  return String(url ?? '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase()
}

/**
 * 这条记录的响应体是不是**规则造出来的**（不能当"原响应"）：
 *   · 备注以「规则 mock」「规则 Map Local」开头（本地回包：mock / Map Local，含读文件失败那条）；
 *   · 或带 ruleId，且那条规则（还在的话）是 mock / Map Local，或带响应阶段的改写指令（正文被改过）。
 *   规则已经删了就只能看备注（含「规则改写(响应)」⇒ 正文被改过）。延迟 / 改状态码 / Map Remote 这类规则不动正文，照常可用。
 */
function bodyMadeByRule(rec, ruleOf) {
  const note = typeof rec.note === 'string' ? rec.note : ''
  if (note.startsWith('规则 mock') || note.startsWith('规则 Map Local')) return true
  const ruleId = typeof rec.ruleId === 'string' ? rec.ruleId : ''
  if (ruleId === '') return false
  let rule = null
  try { rule = ruleOf(ruleId) } catch { rule = null }
  if (rule === null || rule === undefined || typeof rule !== 'object') return note.includes('规则改写(响应)')
  const action = rule.action !== null && typeof rule.action === 'object' ? rule.action : {}
  if (action.type === 'mock' || action.type === 'map-local') return true
  if (action.type === 'rewrite') {
    return note.includes('规则改写(响应)') ||
      (Array.isArray(action.ops) && action.ops.some((op) => op !== null && typeof op === 'object' && op.phase === 'res'))
  }
  return false
}

/**
 * 一键 mock（preset=original / empty-lists）要的"该接口最近一次的真实响应"，返回记录本身或 null。
 *
 * C40：recordId 命中的那条**也要过同一组过滤**，过不了就退回按 方法 + 接口路径 找最新一条：
 *   有正文、完整（complete !== false：流中断的半截正文不算）、方法/路径对得上（调用方给了才比）、不是规则造的。
 *   旧实现对 recordId 命中直接返回 —— 用户打开的恰好是 mock 出来的那条 '{}' 时，"保留外壳·清空数组"就把真实外壳弄丢了。
 * 另外：实时日志那份拷贝（source=realtime）若紧跟在同一接口的规则回包之后（没被去重认领掉），它的正文同样是假的 —— 也跳过。
 */
function findOriginalRecord(all, { recordId, url, method } = {}, { ruleOf = () => null } = {}) {
  const records = Array.isArray(all) ? all : []
  const isRec = (r) => r !== null && typeof r === 'object'
  const hit = typeof recordId === 'string' && recordId !== '' ? records.find((r) => isRec(r) && r.id === recordId) : undefined
  // 路径：调用方给了就以调用方为准（命中那条也必须对得上）；只给了 recordId 时用命中那条自己的
  const key = endpointPathKey(typeof url === 'string' && url !== '' ? url : (hit !== undefined ? hit.url : ''))
  const m = String(method ?? '').toUpperCase()
  const madeByRule = []
  const candidates = []
  for (const r of records) {
    if (!isRec(r) || endpointPathKey(r.url) !== key) continue
    if (m !== '' && String(r.method ?? '').toUpperCase() !== m) continue
    if (bodyMadeByRule(r, ruleOf)) {
      madeByRule.push(r)
      continue
    }
    if (typeof r.resBody === 'string' && r.resBody !== '' && r.complete !== false) candidates.push(r)
  }
  const shadowedByRule = (r) => {
    if ((r.source ?? '') !== 'realtime' || madeByRule.length === 0) return false
    const t = Number(r.ts) || 0
    return madeByRule.some((x) => {
      const t0 = Number(x.ts) || 0
      return t >= t0 - 1000 && t <= t0 + (Number(x.durationMs) || 0) + 15000
    })
  }
  if (hit !== undefined && candidates.includes(hit) && !shadowedByRule(hit)) return hit
  const newestFirst = candidates.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
  for (const r of newestFirst) if (!shadowedByRule(r)) return r
  return null
}

/**
 * C25：交给引擎的"原响应"：{ body, contentType, truncated, encoding }。
 *   truncated：正文以截断标记结尾，或长度到了存储层单字段上限（normalize 截断时标记已被切掉），或是到了上限的 hex 转储；
 *   encoding：'hex' / 'base64'（二进制 / 图片落库时的转储形态，不能原样当响应体回给客户端）或 null；
 *   contentType：记录上的 contentType，没有就取响应头（大小写不敏感）；都没有为 null。
 */
function originalOf(rec) {
  if (rec === null || rec === undefined || typeof rec !== 'object' || typeof rec.resBody !== 'string') return null
  const body = rec.resBody
  const encoding = /^hex:[0-9a-f]*$/i.test(body) ? 'hex' : (/^base64:[^;\s]*;[A-Za-z0-9+/=]*$/.test(body) ? 'base64' : null)
  const truncated = body.endsWith(BODY_TRUNCATED_MARK) || body.length >= STORE_FIELD_CAP || (encoding === 'hex' && body.length >= HEX_BODY_CAP_CHARS)
  const header = headerValue(rec.resHeaders, 'content-type')
  const fromHeader = Array.isArray(header) ? header.find((v) => typeof v === 'string' && v.trim() !== '') : header
  const contentType = typeof rec.contentType === 'string' && rec.contentType.trim() !== ''
    ? rec.contentType
    : (typeof fromHeader === 'string' && fromHeader.trim() !== '' ? fromHeader : null)
  return { body, contentType, truncated, encoding }
}

/** baseRevision（取自 getRules().revision）→ setRules 的第二个参数；没给就不做并发检查。 */
function revisionOption(baseRevision) {
  if (baseRevision === undefined || baseRevision === null || baseRevision === '') return {}
  if (typeof baseRevision === 'string') return { baseRevision }
  if (typeof baseRevision === 'number' && Number.isFinite(baseRevision)) return { baseRevision: String(baseRevision) }
  throw new Error('baseRevision 必须是字符串（取自 GET /proxy/rules 返回的 revision）')
}

/**
 * U45：插件在同一进程里被卸载再加载时，上一实例 dispose() 启动的 engine.shutdown() 还没关完拦截监听，
 * 新实例的 recover() 就去 listen 同一个 127.77.0.1:443 ⇒ EADDRINUSE。上一实例把关闭的 Promise 挂在这里，新实例先等它。
 */
const PROXY_SHUTDOWN_KEY = Symbol.for('dsh-api-visualizer.proxy-shutdown')
/** 等上一实例关闭的上限（之后照样恢复：引擎自己对 EADDRINUSE 还会重试约 10 s）。 */
const PREVIOUS_SHUTDOWN_WAIT_MS = 10000

/** 等一个 Promise，最多 ms 毫秒；成功、失败、超时都只是"不再等"。 */
function waitAtMost(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    Promise.resolve(promise).then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

/** E2：实时日志被认领时搬过来的调用方归因，在代理记录 id 上保留这么久（之后同一 id 的再次 emit 也补上）。 */
const CALLER_HOLD_MS = 30000
const MAX_HELD_CALLERS = 5000

/**
 * Host-managed local MITM proxy: records batched into the same store (source='proxy').
 * 注入口只给自测用（假引擎 / 假落库 / 等上一实例关闭的上限）；宿主走默认值。
 */
function createProxy({
  newEngine = (opts) => new ProxyEngine(opts),
  append = (batch) => appendRecords(batch, { evidenceLevel: 'observed' }),
  previousShutdownWaitMs = PREVIOUS_SHUTDOWN_WAIT_MS,
} = {}) {
  let queue = []
  let engine = null
  let flushTimer = null
  let disposed = false
  let shutdownChain = null
  // E2：被认领的实时记录带来的调用方归因（proxyRecordId → { caller, until }）。
  // 同一条代理记录可能被引擎多次 emit（流式进度、挂起的首末两条），30 s 内后续 emit 也补上；Map 按插入序 ⇒ 最早的在前。
  const heldCallers = new Map()

  const pruneHeldCallers = (now) => {
    for (const [id, held] of heldCallers) {
      if (held.until > now && heldCallers.size <= MAX_HELD_CALLERS) break
      heldCallers.delete(id)
    }
  }

  /** R2-01：引擎在记录发出之后才查到进程时，补发的是 {id, attributionPatch:true, clientProcess?, clientPid?} —— 只补这两个字段。 */
  const isAttributionPatch = (rec) => rec !== null && typeof rec === 'object' && rec.attributionPatch === true && typeof rec.id === 'string' && rec.id !== ''
  const attributionOf = (rec) => {
    const out = {}
    if (typeof rec.clientProcess === 'string' && rec.clientProcess !== '') out.clientProcess = rec.clientProcess
    if (Number.isInteger(rec.clientPid) && rec.clientPid >= 0) out.clientPid = rec.clientPid
    return out
  }
  /**
   * 补丁的去处：同一批里有同 id 的完整记录 ⇒ 补进它（它自己已有的不覆盖）；否则补到库里还在的那一行
   * （以同 id 追加 {...库里那行, 进程}，用户的标记 / 标签 / 备注都保留）；库里已经没有（删掉 / 清空 / 被保留上限裁掉）⇒ 丢掉，不让它复活。
   */
  const applyAttributionPatches = (batch, patches) => {
    const matched = new Set()
    for (const rec of batch) {
      if (rec === null || typeof rec !== 'object' || typeof rec.id !== 'string') continue
      const p = patches.get(rec.id)
      if (p === undefined) continue
      if (rec.clientProcess === undefined && p.clientProcess !== undefined) rec.clientProcess = p.clientProcess
      if (rec.clientPid === undefined && p.clientPid !== undefined) rec.clientPid = p.clientPid
      matched.add(rec.id)
    }
    const want = new Set([...patches.keys()].filter((id) => !matched.has(id)))
    if (want.size === 0) return
    // 多客户端：那一行可能在任何一个客户端的库里 —— 按 candidateDirsFor 的顺序找，找到就**写回它所在的库**（不搬家）
    for (const dir of candidateDirsFor([...want])) {
      if (want.size === 0) break
      let stored = []
      try { stored = getCaptureStorage(dir).readAll() } catch { stored = [] }
      for (const row of stored) {
        if (row === null || typeof row !== 'object' || !want.has(row.id)) continue
        want.delete(row.id)
        batch.push(pinToDir({ ...row, ...patches.get(row.id) }, dir))
      }
    }
  }

  const flushQueue = () => {
    if (queue.length === 0) return
    const taken = queue.splice(0, queue.length)
    const batch = []
    const patches = new Map()
    for (const rec of taken) {
      if (!isAttributionPatch(rec)) { batch.push(rec); continue }
      const p = attributionOf(rec)
      if (p.clientProcess !== undefined || p.clientPid !== undefined) patches.set(rec.id, { ...(patches.get(rec.id) ?? {}), ...p })
    }
    if (patches.size > 0) applyAttributionPatches(batch, patches)
    if (batch.length === 0) return
    if (heldCallers.size > 0) {
      pruneHeldCallers(Date.now())
      for (const rec of batch) {
        if (rec === null || typeof rec !== 'object' || typeof rec.id !== 'string') continue
        const held = heldCallers.get(rec.id)
        if (held !== undefined && (rec.caller === undefined || rec.caller === null)) rec.caller = held.caller
      }
    }
    try {
      append(batch)
    } catch {
      queue.unshift(...batch)
    }
  }

  const startFlush = () => {
    if (flushTimer !== null || disposed) return
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
      engine = newEngine({
        certDir: join(stateDir(), 'proxy-certs'),
        onRecord: (rec) => { queue.push(rec) },
      })
    }
    // 正向代理与透明拦截共用一个记录队列：任何一个前门开着都要有人把队列刷进库
    startFlush()
    return engine
  }

  /** 一键 mock 需要"该接口最近一次的真实响应"（见 findOriginalRecord / originalOf）；找不到返回 null。 */
  const findOriginal = ({ recordId, url, method } = {}) => {
    let rules = []
    try {
      const r = engine !== null ? engine.getRules() : null
      rules = r !== null && typeof r === 'object' && Array.isArray(r.rules) ? r.rules : []
    } catch {
      rules = []
    }
    const byId = new Map(rules.filter((r) => r !== null && typeof r === 'object').map((r) => [r.id, r]))
    return originalOf(findOriginalRecord(readAll(), { recordId, url, method }, { ruleOf: (id) => byId.get(id) ?? null }))
  }

  /** C9：契约里 reach 由引擎随一键规则结果给出；万一缺了，按同一个判定（ruleReach）补上，别让调用方去猜"现在生效没有"。 */
  const withReach = (eng, out, url) => {
    if (out === null || typeof out !== 'object' || out.reach !== undefined) return out
    let reach = null
    try { reach = typeof eng.ruleReach === 'function' ? eng.ruleReach(url) : null } catch { reach = null }
    return { ...out, reach }
  }

  /** 启动（或接在上一次后面）引擎关闭；关完再把关闭过程中补发的最后几条记录刷进库。 */
  const beginShutdown = () => {
    const eng = engine
    const run = () => (eng !== null && typeof eng.shutdown === 'function' ? eng.shutdown() : undefined)
    let started
    if (shutdownChain === null) {
      try { started = Promise.resolve(run()) } catch (e) { started = Promise.reject(e) }
    } else {
      started = shutdownChain.then(run)
    }
    const done = started.catch(() => {}).then(() => {
      try { flushQueue() } catch { /* 库不可写：留在队列里 */ }
    })
    shutdownChain = done
    globalThis[PROXY_SHUTDOWN_KEY] = done
    done.then(() => { if (globalThis[PROXY_SHUTDOWN_KEY] === done) delete globalThis[PROXY_SHUTDOWN_KEY] })
    return done
  }

  return {
    async start({ port = 8899, upstream = undefined } = {}) {
      const eng = ensure()
      return eng.start({ port, upstream })
    },
    stop() {
      if (engine !== null) {
        const eng = engine
        let stopping
        try { stopping = Promise.resolve(eng.stop()) } catch (e) { stopping = Promise.reject(e) }
        // 停的过程中收尾的请求还会 emit 记录：停完再刷一次，别让它们留在已经不刷的队列里
        stopping.catch(() => {}).then(() => { try { flushQueue() } catch { /* 留给下一次 */ } })
      }
      if (!(engine !== null && engine.redirect !== null)) stopFlush({ drain: true })
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
          caPath: join(stateDir(), 'proxy-certs', 'ca-cert.pem'), caReady: false,
          systemProxyActive: pointsAtUs,
          systemProxy: sys,
          warning: pointsAtUs
            ? '⚠ 系统代理**仍指向 127.0.0.1:8899，但代理引擎没有在运行** —— 此时整机网络连接会被拒。' +
              '处理：启动代理后再调 POST /proxy/system-proxy {enable:false} 恢复，或直接改回原来的 ' + (sys.server || '(空)') + '。'
            : undefined,
          counters: null, startedAt: null,
          // 与引擎 status() 同形（契约字段）：引擎还没建 ⇒ 规则表没读过（null = 未知）；弱网开关与断点不落盘，必然是关
          rules: { total: null, enabled: null, revision: null },
          netsim: { enabled: false, summary: '' },
          breakpoints: { enabled: false, phase: 'request', paused: 0 },
          // 与引擎 status().processLookups 同形：引擎没建 ⇒ 还没查过任何连接的进程
          processLookups: { ok: 0, miss: 0, errors: 0, pending: 0 },
          intercept: { listening: false, active: false, draining: false, ip: null, hosts: [], requests: 0, tlsErrors: 0 },
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
    /** 整表替换；带 baseRevision 时规则表已被别人改过 ⇒ 引擎抛 RULES_CONFLICT（带当前 revision）。 */
    setRules(list, { baseRevision } = {}) {
      return ensure().setRules(list, revisionOption(baseRevision))
    },
    /** 单条改动（C12）：只把契约里的字段交给引擎。 */
    ruleOp(args = {}) {
      const a = args !== null && typeof args === 'object' ? args : {}
      return ensure().ruleOp({
        op: typeof a.op === 'string' ? a.op : '',
        ...(a.id !== undefined && a.id !== null && a.id !== '' ? { id: String(a.id) } : {}),
        ...(a.rule !== null && typeof a.rule === 'object' && !Array.isArray(a.rule) ? { rule: a.rule } : {}),
        ...(typeof a.url === 'string' ? { url: a.url } : {}),
        ...(typeof a.method === 'string' ? { method: a.method } : {}),
      })
    },
    getRule(id) {
      return ensure().getRule(String(id ?? ''))
    },
    /** 规则导出：引擎的信封 { format, version, exportedAt, count, rules }（不含命中数与编译后的 ops）。 */
    exportRules() {
      return ensure().exportRules()
    },
    /**
     * 规则导入：input = 导出的信封或规则数组；mode = merge（默认）/ replace；
     * baseRevision（取自 getRules().revision）已过期 ⇒ 引擎抛 RULES_CONFLICT，与 setRules 同一个检查。
     */
    importRules(input, { mode = 'merge', baseRevision } = {}) {
      return ensure().importRules(input, { mode, ...revisionOption(baseRevision) })
    },
    quickRule(args = {}) {
      const a = args !== null && typeof args === 'object' ? args : {}
      const eng = ensure()
      const preset = typeof a.preset === 'string' && a.preset !== '' ? a.preset : 'empty-object'
      const url = String(a.url ?? '')
      const method = typeof a.method === 'string' ? a.method : ''
      // C25 / C40：要"原响应"的预设由宿主自己找（recordId 命中且可用就用它，否则按 方法 + 路径 取最新一条），
      // 正文、Content-Type、是否截断、是否 hex/base64 形态一并交给引擎 —— 用不了时由引擎拒绝（RULE_INVALID）并说明原因。
      const original = preset === 'original' || preset === 'empty-lists'
        ? findOriginal({ recordId: typeof a.recordId === 'string' ? a.recordId : undefined, url, method })
        : null
      const out = eng.quickRule({
        url,
        method,
        preset,
        ...(typeof a.body === 'string' ? { body: a.body } : {}),
        ...(Number.isInteger(a.status) ? { status: a.status } : {}),
        ...(Number(a.latencyMs) > 0 ? { latencyMs: Number(a.latencyMs) } : {}),
        ...(typeof a.name === 'string' && a.name !== '' ? { name: a.name } : {}),
        original,
      })
      if (out !== null && typeof out === 'object' && typeof out.then === 'function') return out.then((o) => withReach(eng, o, url))
      return withReach(eng, out, url)
    },
    /** 只读：按与一键 mock 相同的规则找"原响应"（自测与诊断用）。 */
    findOriginal(query = {}) {
      return findOriginal(query ?? {})
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
    getNetsim() {
      return ensure().getNetsim()
    },
    setNetsim(cfg) {
      return ensure().setNetsim(cfg)
    },
    async interceptStart(args = {}) {
      const a = args !== null && typeof args === 'object' ? args : {}
      // 只放行契约里的选项：引擎的 startRedirect 还有内部用的 applyHosts / recovering / pinnedSeed，不许从路由或工具传进去
      return ensure().startRedirect({
        hosts: Array.isArray(a.hosts) ? a.hosts.map(String) : String(a.hosts ?? ''),
        ...(typeof a.ip === 'string' && a.ip !== '' ? { ip: a.ip } : {}),
        ...(typeof a.strictUpstreamTls === 'boolean' ? { strictUpstreamTls: a.strictUpstreamTls } : {}),
        ...(typeof a.allowWithoutSafetyNet === 'boolean' ? { allowWithoutSafetyNet: a.allowWithoutSafetyNet } : {}),
      })
    },
    async interceptStop(args = {}) {
      const a = args !== null && typeof args === 'object' ? args : {}
      const grace = a.graceMs === undefined || a.graceMs === null || a.graceMs === '' ? NaN : Number(a.graceMs)
      return ensure().stopRedirect({
        ...(Number.isFinite(grace) ? { graceMs: grace } : {}),
        force: a.force === true,
      })
    },
    async interceptStatus({ deep = true, fresh = false } = {}) {
      const eng = ensure()
      return deep ? eng.redirectStatusDeep({ fresh: fresh === true }) : eng.redirectStatus()
    },
    /**
     * 宿主启动 / 插件重载时：hosts 段落还在 ⇒ 立刻恢复监听（否则客户端连不上这些域名）。
     * U45：先等上一实例的 shutdown()（最多 previousShutdownWaitMs），再交给引擎恢复（它对 EADDRINUSE 自己会重试）。
     */
    async recover() {
      const previous = globalThis[PROXY_SHUTDOWN_KEY]
      if (previous !== undefined && previous !== null && previous !== shutdownChain && typeof previous.then === 'function') {
        await waitAtMost(previous, previousShutdownWaitMs)
      }
      if (disposed) return { recovered: false, reason: 'disposed' }
      try {
        const r = await ensure().recoverRedirect()
        if (disposed) {
          // 恢复途中本实例已被卸载：刚起的监听没人管了 —— 再关一次（hosts 段落照旧留给下一个实例接管）
          beginShutdown()
          return { ...(r !== null && typeof r === 'object' ? r : {}), recovered: false, reason: 'disposed' }
        }
        if (r && r.recovered === true) console.log('[dsh-api-visualizer] 透明拦截已按 hosts 段落恢复监听')
        else if (r && r.reason === 'foreign-owner') console.warn('[dsh-api-visualizer] 透明拦截：hosts 段落正由另一个运行中的实例服务，本实例不接管、也不删除它:', r.error ?? '')
        else if (r && r.reason !== 'no-block') console.error('[dsh-api-visualizer] 透明拦截恢复失败:', r.error)
        return r
      } catch (e) {
        console.error('[dsh-api-visualizer] 透明拦截恢复异常:', errorMessage(e))
        return { recovered: false, error: String(e) }
      }
    },
    /**
     * 实时日志记录是否就是代理刚拦到的那条（透明拦截去重）：null | { proxyRecordId }。
     * 不再先看"拦截此刻开着没有"—— 刚停用 / 排空结束前代理见过的请求，它的实时记录稍后才到，认领窗口由引擎自己管。
     */
    claimDuplicate(rec) {
      if (engine === null || typeof engine.claimInterceptedDuplicate !== 'function') return null
      let claim = null
      // R2-04：带上实时日志所属的客户端进程名 —— 引擎只认领同一进程的代理记录（没配置进程名时照旧只按时间配对）
      try { claim = engine.claimInterceptedDuplicate(rec, { processName: realtimeProcessSafe() }) } catch { return null }
      if (claim === true) return { proxyRecordId: null } // 旧式布尔返回：认领了，但不知道是哪条代理记录
      if (claim === null || typeof claim !== 'object') return null
      return { proxyRecordId: typeof claim.proxyRecordId === 'string' && claim.proxyRecordId !== '' ? claim.proxyRecordId : null }
    },
    /**
     * E2：被认领丢弃的实时记录带着调用方归因（ViewModel / API / 调用链）—— 代理那条没有，把它搬过去：
     *   代理记录还在本队列里 ⇒ 直接写到排队的对象上；已经落库 ⇒ 以同一 id 追加 { ...stored, caller }（同 id 覆盖）；
     *   都不在（客户端先完成、代理的 onRecord 稍后才到）⇒ 先挂着，≤30 s 内它进队列时补上。
     * 返回 'queued' | 'stored' | 'pending' | 'ignored'（自测用）。
     */
    attachCaller(proxyRecordId, caller) {
      if (typeof proxyRecordId !== 'string' || proxyRecordId === '' || caller === null || typeof caller !== 'object') return 'ignored'
      const now = Date.now()
      heldCallers.delete(proxyRecordId)
      heldCallers.set(proxyRecordId, { caller, until: now + CALLER_HOLD_MS })
      pruneHeldCallers(now)
      let queued = false
      for (const rec of queue) {
        // 归属补丁不是完整记录（落库时只取进程两个字段）：挂在它上面的调用方会丢，别算成已入队
        if (rec !== null && typeof rec === 'object' && rec.attributionPatch !== true && rec.id === proxyRecordId) {
          rec.caller = caller
          queued = true
        }
      }
      if (queued) return 'queued'
      let stored
      try { stored = readAll().find((r) => r !== null && typeof r === 'object' && r.id === proxyRecordId) } catch { stored = undefined }
      if (stored === undefined) return 'pending'
      const updated = { ...stored, caller }
      try {
        append([updated])
      } catch {
        queue.push(updated) // 落库失败：交给下一次 flush 重试（同 id 覆盖）
        startFlush()
      }
      return 'stored'
    },
    dispose() {
      // 只关监听、不动 hosts：插件重载/宿主重启后由 recover() 按段落接管。
      // U45：关闭的 Promise 挂到 globalThis 上，下一个实例的 recover() 先等它关完再 listen。
      disposed = true
      stopFlush({ drain: true })
      beginShutdown()
    },
  }
}

/**
 * 透明拦截候选域名：从捕获库里挑出客户端真正访问过的 http(s) 域名。
 * C41：按来源分别计数（sources: realtime / proxy / other）——只有 **realtime**（实时日志 = 客户端进程自己的流量）才算 fromClient；
 * 正向代理 / 系统代理抓到的可能是浏览器等任何进程的流量，不能拿来当"直接拦截"的默认名单。
 * IP / localhost 不列（hosts 对它们无效）。
 */
function interceptSuggestions(limit = 40) {
  const stats = new Map()
  const all = readAll()
  const recent = all.length > 8000 ? sortNewestFirst(all).slice(0, 8000) : all
  for (const r of recent) {
    let u
    try { u = new URL(String(r.url ?? '')) } catch { continue }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host) || host.includes(':') || !host.includes('.')) continue
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
    const s = stats.get(host) ?? { host, count: 0, sources: { realtime: 0, proxy: 0, other: 0 }, ports: new Set(), lastTs: 0 }
    s.count++
    const source = String(r.source ?? '')
    if (source === 'realtime') s.sources.realtime++
    else if (source === 'proxy') s.sources.proxy++
    else s.sources.other++
    s.ports.add(`${u.protocol.slice(0, -1)}:${port}`)
    s.lastTs = Math.max(s.lastTs, Number(r.ts) || 0)
    stats.set(host, s)
  }
  return [...stats.values()]
    .sort((a, b) => (b.sources.realtime > 0) - (a.sources.realtime > 0) || b.count - a.count)
    .slice(0, limit)
    .map((s) => {
      const ports = [...s.ports]
      // 只有默认端口 ⇒ 写裸域名（443+80 都拦）；有非默认端口 ⇒ 按 scheme://host:port 写
      const nonDefault = ports.filter((p) => p !== 'https:443' && p !== 'http:80')
      const entries = nonDefault.length === 0 ? [s.host] : [...(ports.some((p) => p === 'https:443' || p === 'http:80') ? [s.host] : []), ...nonDefault.map((p) => `${p.split(':')[0]}://${s.host}:${p.split(':')[1]}`)]
      return { host: s.host, count: s.count, fromClient: s.sources.realtime > 0, sources: { ...s.sources }, ports, entries, lastTs: s.lastTs }
    })
}

/**
 * Mount the routes, tool, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 */
export function apply(ctx) {
  const capture = createCapture()
  const proxy = createProxy()
  // 透明拦截开着时，实时日志里与代理重复的那条由代理认领（一对一，只认领代理确实见过的）；
  // 被认领的那条若带着调用方归因，搬到代理记录上（E2：代理自己看不到 ViewModel / 调用链）
  capture.setDedupe(
    (rec) => proxy.claimDuplicate(rec),
    (proxyRecordId, caller) => proxy.attachCaller(proxyRecordId, caller),
  )
  // hosts 段落还在（宿主重启 / 插件重载）⇒ 客户端此刻正被指向本机，马上恢复监听（U45：先等上一实例关完监听）
  proxy.recover().catch(() => {})
  // 多客户端捕获库：每 3 s 看一次在跑的进程，当前客户端跟着用户启动的客户端走（没有 capture-clients.json 时只 stat 一下，什么都不做）
  const watcher = startClientWatcher({
    stateDir: () => stateDir(),
    onChange: ({ from, to, reason }) => {
      console.log(`[dsh-api-visualizer] 捕获库切到客户端「${to}」（原来「${from ?? '无'}」，${reason}）`)
    },
  })
  clientWatcher = watcher
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
  // mock 规则 / 透明拦截 / 全局弱网：让 agent 能"把某接口改成空数据 → 截图看客户端怎么渲染"
  ctx.effect(() => {
    // profile 里的共享 lib/ 可能比插件旧（部署漂移是本仓的已知问题）：注册表里没有这几个工具时
    // 只跳过 agent 工具，路由与面板照常工作 —— 绝不能因为一个可选工具把整个宿主 boot 拖垮。
    let tools = []
    try {
      tools = interceptTools(proxy)
    } catch (e) {
      console.error('[dsh-api-visualizer] 跳过 mock/拦截/弱网工具注册（共享 tool-registry 太旧？）:', e instanceof Error ? e.message : String(e))
    }
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => {
      for (const d of disposers) {
        try { if (typeof d === 'function') d() } catch { /* host already tearing down */ }
      }
    }
  }, 'dsh-api-visualizer: intercept-tools')
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:api-visualizer',
    order: SECTION_ORDER,
    text: GUIDANCE,
    // 按字面量注入：宿主默认把双花括号当提示词变量解析，名字不合规会让整轮失败（见 scripts/check.mjs）
    interpolate: false,
  })
  ctx.effect(
    () => () => {
      disposeRoutes()
      disposeTool()
      disposeQueryTool()
      disposeSection()
      watcher.stop()
      if (clientWatcher === watcher) clientWatcher = null
      capture.dispose()
      proxy.dispose()
    },
    'dsh-api-visualizer: teardown',
  )
}

// Reusable surface (unused by the cordis loader; keeps the store/filter logic reusable).
// readJsonBody / makeRoutes / interceptTools / findOriginalRecord / originalOf / interceptSuggestions 另外导出给本地自测（假引擎、假代理对象）。
export {
  applyFilters, buildContracts, createCapture, createProxy, endpointKeyOf, jsonShape, normalize, paramsFromObj, searchSource, apiQueryTool, fmtAge,
  readJsonBody, makeRoutes, interceptTools, interceptApi, findOriginalRecord, originalOf, interceptSuggestions,
}

/**
 * mock 规则 / 透明拦截 / 全局弱网的**进程内传输层**（共享契约的 api 对象）：直接调宿主里的代理对象。
 * 每个方法返回 Promise<object>；失败统一是 { ok:false, error, code?, revision? }（与 MCP 面走回环路由时拿到的错误体同形）。
 */
function interceptApi(proxy) {
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, ...engineErrorBody(e) }
    }
  }
  return {
    getRules: guard(async () => proxy.getRules()),
    setRules: guard(async (list, opts = {}) => proxy.setRules(list, { baseRevision: opts !== null && typeof opts === 'object' ? opts.baseRevision : undefined })),
    ruleOp: guard(async (a) => proxy.ruleOp(a ?? {})),
    getRule: guard(async (id) => {
      const rule = await proxy.getRule(id)
      return rule === null || rule === undefined
        ? { ok: false, error: `rule not found: ${String(id ?? '')}`, code: 'RULE_NOT_FOUND' }
        : { rule }
    }),
    quickRule: guard(async (a) => proxy.quickRule(a ?? {})),
    interceptStatus: guard(async ({ fresh = false } = {}) => proxy.interceptStatus({ deep: true, fresh: fresh === true })),
    interceptStart: guard(async (a) => proxy.interceptStart(a ?? {})),
    interceptStop: guard(async (a) => proxy.interceptStop(a ?? {})),
    suggest: guard(async () => ({ items: interceptSuggestions(40) })),
    getNetsim: guard(async () => proxy.getNetsim()),
    setNetsim: guard(async (c) => proxy.setNetsim(c ?? {})),
    // 规则导出 / 导入：与 POST /proxy/rules/export-file、/proxy/rules/import 同一份实现（MCP 面走的就是这两条路由）
    exportRules: guard(async (a) => {
      const o = a !== null && typeof a === 'object' ? a : {}
      return { ok: true, ...(await exportRulesToFile(proxy, { path: o.path, overwrite: o.overwrite })) }
    }),
    importRules: guard(async (a) => {
      const o = a !== null && typeof a === 'object' ? a : {}
      const r = await importRulesFrom(proxy, { data: o.data, path: o.path, mode: o.mode, baseRevision: o.baseRevision })
      return r !== null && typeof r === 'object' && !Array.isArray(r) ? { ok: true, ...r } : { ok: true, result: r }
    }),
  }
}

/**
 * mock 规则 / 透明拦截 / 全局弱网（DSH 面）。动作语义只有一份（intercept-control.mjs），
 * 这里只提供"进程内直接调代理对象"的传输层；MCP 面给的是"走回环路由"的传输层。
 * face:'dsh' ⇒ 返回里所有"下一步该调哪个工具"的提示都用本面的名字（api_capture_*），不是 MCP 面的 capture_*（C44）。
 */
function interceptTools(proxy) {
  const api = interceptApi(proxy)
  const output = {
    schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, summary: { type: 'string' } } },
    render: (_a, v) => [{ type: 'text', text: v && typeof v.summary === 'string' ? v.summary : JSON.stringify(v ?? null).slice(0, 4000) }],
  }
  const run = (name, args) => runInterceptTool(name, args ?? {}, api, { face: 'dsh' })
  return [
    defineTool({
      name: 'api_capture_rules',
      description: dshDescription('capture_rules'),
      parameters: dshParameters('capture_rules'),
      output,
      async execute(args) { return run('capture_rules', args) },
    }),
    defineTool({
      name: 'api_capture_intercept',
      description: dshDescription('capture_intercept'),
      parameters: dshParameters('capture_intercept'),
      output,
      async execute(args) { return run('capture_intercept', args) },
    }),
    defineTool({
      name: 'api_capture_netsim',
      description: dshDescription('capture_netsim'),
      parameters: dshParameters('capture_netsim'),
      output,
      async execute(args) { return run('capture_netsim', args) },
    }),
  ]
}

/**
 * 捕获控制面三件套（起 / 停 / 查状态）。
 *
 * 单独成函数并**在 apply() 里注册**的原因：我第一版把这三段直接写在了 `apiQueryTool()` 的函数体末尾，
 * 而那个函数以 `return defineTool({...})` 结束 ⇒ 三段代码**永远不执行**。
 * 语法能过、check 能过、代码还在，但工具压根没注册（加载加载检查 + E4 的反向断言当场抓住）。
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
