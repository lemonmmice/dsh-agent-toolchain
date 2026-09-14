// dsh-api-visualizer 单测：查询诚实性视图（新鲜度 + 调用方归因）必须是**三个面共用的一份实现**。
//
// 起因（2026-09-11 第十轮自查）：这段逻辑原来只写在 DSH 插件的 api_capture_query 里，于是
//   · MCP 面 capture_query（agent 最常用的那个）只回 total/returned/items；
//   · 面板路由 GET /records 只回 total/items/nextCursor/hasMore。
// 两边都看不到"捕获引擎没在跑 → 你看到的是历史数据"，也看不到"调用方归因没有生产者（F-004）"。
// 这正是本仓反复出现的"同一个修复只落在一个面"。
import { buildQueryView, freshnessNote, callerAttributionNote } from '../lib/query-view.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// ------------------------------------------------- 1. 新鲜度：引擎在跑 vs 没跑 vs 状态未知
{
  const now = 1_700_000_000_000
  const all = [{ ts: now - 5000, url: 'a' }, { ts: now - 1000, url: 'b' }]
  const running = buildQueryView({ records: all, all, status: { running: true }, now })
  check('引擎在跑：captureRunning=true', running.freshness.captureRunning === true, JSON.stringify(running.freshness))
  check('引擎在跑：newestAgeMs 是"最新一条的年龄"', running.freshness.newestAgeMs === 1000, String(running.freshness.newestAgeMs))
  check('引擎在跑：不刷陈旧提示', freshnessNote(running.freshness) === null, String(freshnessNote(running.freshness)))

  const stopped = buildQueryView({ records: all, all, status: { running: false }, now })
  check('引擎没跑：captureRunning=false', stopped.freshness.captureRunning === false)
  const note = freshnessNote(stopped.freshness)
  check('引擎没跑：提示"你看到的是历史数据"并给下一步', /历史数据/.test(note) && /开始实时捕获|capture\/start/.test(note), String(note).slice(0, 160))

  const unknown = buildQueryView({ records: all, all, status: null, now })
  check('状态拿不到：captureRunning=null（未知，不是 false）', unknown.freshness.captureRunning === null)
  check('状态拿不到：提示"未知 ≠ 没在跑"', /未知/.test(String(freshnessNote(unknown.freshness))) && /≠/.test(String(freshnessNote(unknown.freshness))), String(freshnessNote(unknown.freshness)).slice(0, 160))

  const empty = buildQueryView({ records: [], all: [], status: { running: true }, now })
  check('空库：newestAgeMs=null（不编成 0）', empty.freshness.newestAgeMs === null && empty.freshness.newestAt === null, JSON.stringify(empty.freshness))
}

// ------------------------------------------------- 2. 调用方归因：有没有数据、以及"为什么没有"
{
  const withCaller = [{ ts: 1, caller: { viewModel: 'MainViewModel', apiMethod: 'GetKline' } }, { ts: 2 }]
  const v1 = buildQueryView({ records: withCaller, all: withCaller, status: { running: true } })
  check('有归因：available=true 且计数正确', v1.callerAttribution.available === true && v1.callerAttribution.recordsWithCaller === 1, JSON.stringify(v1.callerAttribution))
  check('有归因：不给理由（不刷噪音）', v1.callerAttribution.reason === null && callerAttributionNote(v1.callerAttribution) === null)

  const none = buildQueryView({ records: [{ ts: 1 }, { ts: 2 }], all: [{ ts: 1 }, { ts: 2 }], status: { running: true, caller: { logExists: false, missing: true, note: '无生产者' } } })
  check('无归因且旁路日志不存在：reason 点明"日志不存在、需要客户端侧探针"',
    /旁路日志不存在/.test(none.callerAttribution.reason) && /客户端侧/.test(none.callerAttribution.reason), String(none.callerAttribution.reason).slice(0, 160))
  check('无归因：callerLogExists=false（可机器判定）', none.callerAttribution.callerLogExists === false, JSON.stringify(none.callerAttribution.callerLogExists))
  const cn = callerAttributionNote(none.callerAttribution)
  check('无归因：人可读提示说清"不要读成没有调用方"', /不要把它读成/.test(cn), String(cn).slice(0, 200))

  const noInfo = buildQueryView({ records: [{ ts: 1 }], all: [{ ts: 1 }], status: null })
  check('旁路日志状态未知：callerLogExists=null 且理由不瞎编"不存在"',
    noInfo.callerAttribution.callerLogExists === null && !/日志不存在/.test(String(noInfo.callerAttribution.reason)), JSON.stringify(noInfo.callerAttribution))
}

// ------------------------------------------------- 2b. 用 caller 过滤 + 归因不可用 → 0 条必须解释清楚
// Codex 第十二轮审计的建议：`capture_query({caller:'ViewModel'})` 返回 0 条时，
// 最容易被读成"没有这种调用"，而真相是"归因数据根本不存在"。
{
  const all = [{ ts: 1 }, { ts: 2 }]
  const filtered = buildQueryView({ records: [], all, status: { running: true, caller: { logExists: false, missing: true, note: '无生产者' } }, callerFilter: 'ViewModel' })
  check('caller 过滤 + 归因不可用：reason 明说"0 条不代表没有这种调用"',
    /你用了 caller 过滤/.test(filtered.callerAttribution.reason) && /不代表没有这种调用/.test(filtered.callerAttribution.reason),
    String(filtered.callerAttribution.reason).slice(0, 200))
  check('caller 过滤：回显过滤词（可核对）', filtered.callerAttribution.callerFilter === 'ViewModel', JSON.stringify(filtered.callerAttribution.callerFilter))
  const unfiltered = buildQueryView({ records: [], all, status: { running: true, caller: { logExists: false } } })
  check('未用 caller 过滤：不加"过滤"那句（不刷噪音）', !/你用了 caller 过滤/.test(String(unfiltered.callerAttribution.reason)), String(unfiltered.callerAttribution.reason).slice(0, 120))
  check('caller 过滤：callerFilter=null 表示没过滤', unfiltered.callerAttribution.callerFilter === null)
  // 有归因时即使过滤也不该报"不可用"
  const ok = buildQueryView({ records: [{ ts: 1, caller: { viewModel: 'V' } }], all: [{ ts: 1, caller: { viewModel: 'V' } }], status: { running: true }, callerFilter: 'V' })
  check('有归因 + caller 过滤：可用，不报不可用', ok.callerAttribution.available === true && ok.callerAttribution.reason === null, JSON.stringify(ok.callerAttribution))
}

// ------------------------------------------------- 3. 健壮性：坏输入不抛（三个面都会调它）
{
  for (const bad of [undefined, {}, { all: null }, { all: 'x', records: 5, status: 'nope' }, { all: [null, 3, { ts: 'NaN' }] }]) {
    let ok = true
    try { buildQueryView(bad) } catch { ok = false }
    check('坏输入不抛：' + String(JSON.stringify(bad)).slice(0, 40), ok)
  }
}

// ------------------------------------------------- 4. 跨面守卫：三个面都必须用它（防"只修一个面"）
{
  const plugin = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const mcp = readFileSync(join(repoRoot, 'mcp', 'server.mjs'), 'utf8')
  check('插件面：import 了 query-view', /from '\.\/query-view\.mjs'/.test(plugin))
  check('插件面：api_capture_query 用 buildQueryView 且传 callerFilter',
    /buildQueryView\(\{ records: page, all, status: st, callerFilter: String\(args\.caller/.test(plugin), '未传 callerFilter → "过滤+0 条"又会被误读')
  check('插件面：/records 路由也用 buildQueryView（此前它只回 total/items/cursor）',
    /buildQueryView\(\{ records: page, all, status: stForRoute, callerFilter: String\(params\.get\('caller'\)/.test(plugin) && /freshnessNote: freshnessNote\(view\.freshness\)/.test(plugin))
  check('MCP 面：import 了 query-view', /from '\.\.\/plugins\/dsh-api-visualizer\/lib\/query-view\.mjs'/.test(mcp))
  check('MCP 面：capture_query 用 buildQueryView 且传 callerFilter',
    /buildQueryView\(\{ records: page && page\.items, all: readAll\(\), status, callerFilter: String\(args\.caller/.test(mcp), '未传 callerFilter → 过滤+0 条会被误读')
  check('MCP 面：会去问宿主引擎状态（问不到就 null，不猜）', /capture\/status/.test(mcp) && /status = null/.test(mcp))
  // 反例护栏：插件里不该再出现这段逻辑的手写副本（那正是反复漂移的根源）
  check('插件面：不再手写 freshness 对象（应只剩调用）', !/const freshness = \{/.test(plugin), '又出现手写副本了')
  check('插件面：不再手写 callerAttribution 对象', !/const callerAttribution = \{/.test(plugin), '又出现手写副本了')
}

// ---------------------------------------------------------------- 保留期（「查不到」≠「没发生过」）
// 病（2026-09-12 r17 主题自查）：库到上限会 `rmSync` 掉旧分片而不留痕迹；`lastCompactDropped` 只在
// DSH 进程内存里 ⇒ MCP 面 `capture_query` 看不到 ⇒ "这段时间有没有报错接口？"答 0 条，
// 而真相是那段时间的记录已被裁掉。用户排查接口异常时，这种误导代价最高。
{
  const { retentionNote, buildQueryView } = await import('../lib/query-view.mjs')
  const now = Date.now()
  const note = retentionNote({ droppedTotal: 7, lastDroppedAt: now - 60_000, truncatedBy: 'max-records', oldestKeptTs: now - 3_600_000 })
  check('★ 裁剪过时给出提示', !!note && /已按上限裁剪过/.test(note) && /7/.test(note), String(note).slice(0, 160))
  check('★ 提示里必须写明「查不到不代表没过」', /查不到不代表/.test(note), String(note).slice(0, 200))
  check('提示里带触发原因与库内最早一条（可核对保留窗口）', /max-records/.test(note) && /最早一条/.test(note), String(note).slice(0, 220))
  check('没裁剪过 → 不提示（不刷噪音）', retentionNote({ droppedTotal: 0 }) === null)
  check('保留期未知 → 不提示、也不假装是 0', retentionNote(null) === null && retentionNote({}) === null)

  const view = buildQueryView({ records: [], all: [], status: null, retention: { droppedTotal: 3, oldestKeptTs: now } })
  check('buildQueryView 把 retention 原样带出（两个面共用同一份）', view.retention && view.retention.droppedTotal === 3, JSON.stringify(view.retention))
  const noRet = buildQueryView({ records: [], all: [], status: null })
  check('没传 retention 时字段为 null（而不是伪造一个 0）', noRet.retention === null, JSON.stringify(noRet.retention))

  // 跨面守卫：两个面都必须接上保留期，否则又会"一面说没有、一面知道被裁了"
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const mcpSrc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'server.mjs'), 'utf8')
  const pluginSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  const storeSrc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'lib', 'capture-store.mjs'), 'utf8')
  check('MCP 面：capture_query 传 readRetention 并渲染 retentionNote',
    /retention: readRetention\(\)/.test(mcpSrc) && /retentionNote: retentionNote\(view\.retention\)/.test(mcpSrc))
  check('DSH 面：路由与工具面都传 retentionInfo 并渲染 retentionNote',
    (pluginSrc.match(/retentionInfo\(\)/g) || []).length >= 2 && /retentionNote: retentionNote\(retention\)/.test(pluginSrc))
  check('★ store 裁剪时**落盘**标记（否则跨进程看不到）', /writeTrimMarker\(dir/.test(storeSrc) && /trimmed\.json/.test(storeSrc))

  // 同一个病在**兄弟路由**上（Codex r17）：`/stats/timeline`、`/stats/sessions`、`/stats/repeats`、
  // `/stats/endpoints` 都只回 `{total, items}` —— 裁剪后 `total: 0` 会被读成"这段时间没有流量"。
  // 我上一轮只修了 capture_query（同一个修法只做了一半），这里把它钉死。
  const routeNames = [...pluginSrc.matchAll(/rest === '(\/stats\/[a-z]+)'/g)].map((m) => m[1])
  // ⚠ 不用正则去"解析"响应体（嵌套括号会让它只匹配到 1 个 —— 第一版就栽在这，幸好有自证断言）；
  //   改成**计数**：路由有几个，被 withRetention 包起来的 writeJson 就该有几个。
  const wrapped = (pluginSrc.match(/writeJson\(res, 200, withRetention\(/g) || []).length
  check('解析出 stats 路由（扫描器自证：≥3 个）', routeNames.length >= 3, JSON.stringify(routeNames))
  check('★ 每个基于保留集的 stats 路由都挂上了 withRetention（裁剪后 total:0 不会被读成"没有"）',
    wrapped >= routeNames.length, '路由 ' + routeNames.length + ' 个（' + routeNames.join('、') + '），挂了 ' + wrapped + ' 个')

  // ---- Claude r17 A2：「在跑」不等于「抓到了」—— 主日志不存在时必须报警 ----
  const { freshnessNote } = await import('../lib/query-view.mjs')
  const runningNoLog = buildQueryView({ records: [], all: [], status: { running: true, logExists: false, logPath: 'X:\\nope.log' } })
  check('freshness 不再丢掉主日志存在性（logExists/logPath）',
    runningNoLog.freshness.logExists === false && runningNoLog.freshness.logPath === 'X:\\nope.log',
    JSON.stringify({ e: runningNoLog.freshness.logExists, p: runningNoLog.freshness.logPath }))
  const noteA2 = freshnessNote(runningNoLog.freshness)
  check('★ 在跑但主日志不存在 → 必须报警（原先 running:true 时返回 null，agent 零感知）',
    !!noteA2 && /主跟踪日志不存在/.test(noteA2) && /读空气/.test(noteA2), String(noteA2).slice(0, 200))
  const runningWithLog = buildQueryView({ records: [], all: [], status: { running: true, logExists: true } })
  check('在跑且日志存在 → 不刷提示', freshnessNote(runningWithLog.freshness) === null, String(freshnessNote(runningWithLog.freshness)))
  const noStatus = buildQueryView({ records: [], all: [], status: null })
  check('拿不到引擎状态 → logExists 为 null（未知，不假装 false）', noStatus.freshness.logExists === null, JSON.stringify(noStatus.freshness.logExists))

  // ---- Claude r17 A1：时间线不许静默丢空桶 ----
  check('★ stats/timeline 返回里带空桶信息（emptyBuckets/gaps/gapsNote）',
    /emptyBuckets: gaps\.length/.test(pluginSrc) && /gapsNote:/.test(pluginSrc) && /只含有记录的桶/.test(pluginSrc),
    '时间线仍在静默丢空桶')
}

console.log(failures === 0 ? '\nPASS: dsh-api-visualizer 查询诚实性视图（三面共用）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
