/**
 * dsh-perf — DSH 插件（host 侧）：性能剖析。
 * 与 hang-inspector（卡死）互补，覆盖「卡顿」（UI 线程 500ms~数秒阻塞）与内存泄漏初筛：
 *  - perf_probe：窗口消息延迟采样（SendMessageTimeout 实测耗时），P50/P95/P99 + 卡顿事件
 *  - perf_dump：procdump 抓全 dump → DumpStack(ClrMD) 自动分析 UI 线程栈 + 锁热点线程
 *  - perf_heap：托管堆类型统计 Top N（泄漏初筛）
 *  - perf_analyze：对已有 dump 重分析
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { makePerf } from './lib/perf.mjs'
import { makeTrace } from './lib/trace.mjs'
import { cleanEvidence, renderClean } from './lib/evidence-clean.mjs'
// 渲染层单独成模块：它是 agent 唯一看得见的契约，必须能离线单测（见 lib/render.mjs 顶部说明）。
import { renderProbe, renderReport, renderTrace, renderHotstacks, renderAnalysis } from './lib/render.mjs'
import { envOr } from '../../lib/env-fallback.mjs'
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在各 defineTool 的 name）。
import { dshParameters, dshDescription } from '../../lib/tool-registry.mjs'

export const name = 'dsh-perf'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 146
const API = '/api/dsh-perf'

const GUIDANCE =
  '本机已安装 dsh-perf 插件（DSH 的性能剖析面板）：与 hang-inspector（卡死分析）互补，覆盖 UI「卡顿」（500ms~数秒阻塞）与内存泄漏初筛。' +
  '工具：perf_probe(seconds, thresholdMs, capture=log|shot|dump) 循环给目标客户端主窗口发消息实测响应耗时（空闲毫秒级、UI 忙则同步挂起），统计 P50/P95/P99 并记录每次超过阈值的卡顿事件，capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿抓全 dump；' +
  '**注意它的测量口径（本机标定）**：只测 UI 线程消息泵 —— 非 UI 线程的卡顿（GC/IO/后台线程）测不到（后台阻塞 2000ms → 命中 0 次、max 8~9ms）；P50 恒为 0ms 是常态；「0 次卡顿」不等于客户端流畅；要抓 ≥500ms 卡顿请把阈值设成 200~300、采样 100~150ms；' +
  'perf_report 读最近一次监测报告；perf_dump(note) 按需 procdump 抓全 dump 并自动 DumpStack(ClrMD) 分析（UI 线程栈 + 锁热点线程）；' +
  'perf_analyze(dumpPath) 对已有 dump 重分析；perf_heap(dumpPath, topN) 托管堆类型统计 Top N（对象数/总大小，内存泄漏初筛）；' +
  'perf_trace(action, seconds, profile, tag, etlPath) + perf_hotstacks(etlPath, focus, process, topN, minHits) = **ETW 采样剖析**：' +
  '连续采样后可得到「最热函数排行」与「每个函数的调用者/被调用者（蝶形视图）」，即**完整调用链** —— ' +
  '这是"某串代码导致图表反复重绘、但不知道是哪一串"这类**间歇性**卡顿的正解（dump 只抓一个瞬间、抓不到就只能猜）。' +
  'perf_trace 需要 DSH 以管理员身份运行（ETW 内核会话），.etl 可能数百 MB；perf_hotstacks 支持 focus 正则聚焦，' +
  '并会在首行如实报告**符号未解析比例**（未解析多时先配 DSH_PERF_SYMBOL_PATH 再看结论）。' +
  '分工：偶发 500ms~2s 卡顿用 perf_probe/dump；完全无响应用 hang-inspector 的卡死流程；怀疑内存涨用 perf_dump + perf_heap 对比两次 dump。' +
  '注意：dump 文件较大（数百 MB，在 ~/.dsh-agent-toolchain/perf-evidence），分析完可让用户确认后删除；procdump 挂起进程几秒，用户界面会短暂冻结。' +
  '证据目录默认 ~/.dsh-agent-toolchain/perf-evidence（DSH_PERF_EVIDENCE_DIR 可覆盖），源码根由 DSH_PERF_SRC_ROOT 指定。' +
  '用户提到「性能剖析 / 卡顿分析 / 内存泄漏 / 抓 dump 分析 / 性能证据」时即指本插件，请据此协作。'

let perf = null
function prf() {
  if (!perf) {
    // 配置统一走 env-fallback（进程环境 → 用户级注册表 → 机器级）：DSH 宿主是长活进程，
    // 用户后来设置的用户级变量在它的环境块里**看不到** —— 直接读 process.env 会把"用户已经配好"
    // 读成"没配置"，于是 perf_dump/perf_trace 找不到目标进程，而报错还教用户去设置（他已经设过了）。
    // 同批插件里 ui-drive/perf 的 lib 层早就用了 envOr；这里是 DSH 面的**配置入口**，漏了同样会中招。
    perf = makePerf({
      scriptsDir: join(import.meta.dirname, 'scripts'),
      procName: envOr('DSH_UI_PROC_NAME'),
      windowName: envOr('DSH_UI_WINDOW_NAME'),
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      srcRoot: envOr('DSH_PERF_SRC_ROOT'),
    })
  }
  return perf
}

let tracer = null
function trc() {
  if (!tracer) {
    tracer = makeTrace({
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      procName: envOr('DSH_UI_PROC_NAME'),
    })
  }
  return tracer
}

const OBJECT = { type: 'object', additionalProperties: true }

const tools = () => [
  defineTool({
    name: 'perf_probe',
    description: dshDescription('perf_probe'),
    parameters: dshParameters('perf_probe'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderProbe(v) }] },
    timeoutMs: 62 * 60 * 1000,
    async execute(args) {
      return await prf().probe(args)
    },
  }),
  defineTool({
    name: 'perf_report',
    description: dshDescription('perf_report'),
    parameters: dshParameters('perf_report'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderReport(v) }] },
    async execute() {
      return prf().report()
    },
  }),
  defineTool({
    name: 'perf_dump',
    description: dshDescription('perf_dump'),
    parameters: dshParameters('perf_dump'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('dump: ' + v.dumpPath + '（' + (v.sizeBytes / 1024 / 1024).toFixed(0) + 'MB，' + (v.durationMs / 1000).toFixed(1) + 's）\n' + renderAnalysis(v.analysis)) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().dump(args)
    },
  }),
  defineTool({
    name: 'perf_analyze',
    description: dshDescription('perf_analyze'),
    parameters: dshParameters('perf_analyze'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? renderAnalysis(v) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().analyzeDump(args.dumpPath)
    },
  }),
  defineTool({
    name: 'perf_heap',
    description: dshDescription('perf_heap'),
    parameters: dshParameters('perf_heap'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('堆对象总数 ' + v.totalObjects + ' / ' + (v.totalSizeBytes / 1024 / 1024).toFixed(1) + 'MB，Top 类型（按占用）：\n' + (v.top || []).slice(0, 15).map((t) => t.type + ' x' + t.count + ' = ' + (t.sizeBytes / 1024 / 1024).toFixed(1) + 'MB').join('\n')) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().heapStats(args.dumpPath, args.topN)
    },
  }),
  defineTool({
    name: 'perf_trace',
    description: dshDescription('perf_trace'),
    parameters: dshParameters('perf_trace'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderTrace(v) }] },
    timeoutMs: 20 * 60 * 1000,
    async execute(args) {
      return await trc().trace(args)
    },
  }),
  defineTool({
    name: 'perf_clean',
    description: dshDescription('perf_clean'),
    parameters: dshParameters('perf_clean'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderClean(v) }] },
    async execute(args) {
      return cleanEvidence({ dir: prf().evidenceDir(), confirm: args.confirm === true, what: args.what, keepDays: args.keepDays })
    },
  }),
  defineTool({
    name: 'perf_hotstacks',
    description: dshDescription('perf_hotstacks'),
    parameters: dshParameters('perf_hotstacks'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderHotstacks(v) }] },
    timeoutMs: 30 * 60 * 1000,
    async execute(args) {
      return await trc().hotstacks(args)
    },
  }),
]

// 渲染函数已抽到 ./lib/render.mjs（可离线单测；F-001 的回归测试钉在那里）。

// ---------------------------------------------------------------- Web 路由（仅回环）

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

const MIME = { '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }

function makeRoutes() {
  return [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        const method = req.method || 'GET'
        const rest = (req.url || '').split('?')[0].slice(API.length) || '/'

        if (method === 'GET' && rest === '/status') {
          writeJson(res, 200, {
            plugin: 'dsh-perf',
            evidenceDir: prf().evidenceDir(),
            dumpstackOk: existsSync(prf().config.dumpstack),
            procdumpOk: existsSync(prf().config.procdump),
            probeScriptOk: existsSync(join(prf().config.scriptsDir, 'perf-probe.ps1')),
          })
          return
        }
        if (method === 'GET' && rest === '/evidence') {
          writeJson(res, 200, { root: prf().evidenceDir(), dirs: prf().listEvidence(50) })
          return
        }
        const evMatch = rest.match(/^\/evidence\/([^/]+)$/)
        if (method === 'GET' && evMatch !== null) {
          const id = decodeURIComponent(evMatch[1])
          if (id.includes('..') || id.includes('\\')) { writeJson(res, 400, { error: 'bad id' }); return }
          const p = join(prf().evidenceDir(), id, 'report.json')
          if (!existsSync(p)) { writeJson(res, 404, { error: 'report.json not found' }); return }
          try { writeJson(res, 200, JSON.parse(readFileSync(p, 'utf8'))) } catch { writeJson(res, 500, { error: 'parse failed' }) }
          return
        }
        const fileMatch = rest.match(/^\/evidence\/([^/]+)\/files\/([^/]+)$/)
        if (method === 'GET' && fileMatch !== null) {
          const id = decodeURIComponent(fileMatch[1])
          const file = decodeURIComponent(fileMatch[2])
          if (id.includes('..') || id.includes('\\') || file.includes('..') || file.includes('\\') || file.includes('/')) { writeJson(res, 400, { error: 'bad path' }); return }
          const p = join(prf().evidenceDir(), id, file)
          if (!existsSync(p)) { writeJson(res, 404, { error: 'file not found' }); return }
          const ct = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
          res.writeHead(200, { 'content-type': ct, 'referrer-policy': 'no-referrer', 'content-length': statSync(p).size })
          res.end(readFileSync(p))
          return
        }
        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

export function apply(ctx) {
  ctx.effect(
    () => {
      const disposers = []
      for (const tool of tools()) disposers.push(ctx.tools.register(tool))
      const routeDisposers = makeRoutes().map((route) => ctx.webServer.register(route))
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-perf', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        for (const d of routeDisposers) d()
        disposeSection()
      }
    },
    'dsh-perf: tools+routes',
  )
}
