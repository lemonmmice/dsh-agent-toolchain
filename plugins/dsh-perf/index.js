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

export const name = 'dsh-perf'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 146
const API = '/api/dsh-perf'

const GUIDANCE =
  '本机已安装 dsh-perf 插件（DSH 的性能剖析面板）：与 hang-inspector（卡死分析）互补，覆盖 UI「卡顿」（500ms~数秒阻塞）与内存泄漏初筛。' +
  '工具：perf_probe(seconds, thresholdMs, capture=log|shot|dump) 循环给目标客户端主窗口发消息实测响应耗时（空闲毫秒级、UI 忙则同步挂起），统计 P50/P95/P99 并记录每次超过阈值的卡顿事件，capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿抓全 dump；' +
  'perf_report 读最近一次监测报告；perf_dump(note) 按需 procdump 抓全 dump 并自动 DumpStack(ClrMD) 分析（UI 线程栈 + 锁热点线程）；' +
  'perf_analyze(dumpPath) 对已有 dump 重分析；perf_heap(dumpPath, topN) 托管堆类型统计 Top N（对象数/总大小，内存泄漏初筛）。' +
  '分工：偶发 500ms~2s 卡顿用 perf_probe/dump；完全无响应用 hang-inspector 的卡死流程；怀疑内存涨用 perf_dump + perf_heap 对比两次 dump。' +
  '注意：dump 文件较大（数百 MB，在 ~/.dsh-agent-toolchain/perf-evidence），分析完可让用户确认后删除；procdump 挂起进程几秒，用户界面会短暂冻结。' +
  '证据目录默认 ~/.dsh-agent-toolchain/perf-evidence（DSH_PERF_EVIDENCE_DIR 可覆盖），源码根由 DSH_PERF_SRC_ROOT 指定。' +
  '用户提到「性能剖析 / 卡顿分析 / 内存泄漏 / 抓 dump 分析 / 性能证据」时即指本插件，请据此协作。'

let perf = null
function prf() {
  if (!perf) {
    perf = makePerf({
      scriptsDir: join(import.meta.dirname, 'scripts'),
      procName: process.env.DSH_UI_PROC_NAME || '',
      windowName: process.env.DSH_UI_WINDOW_NAME || '',
      evidenceDir: process.env.DSH_PERF_EVIDENCE_DIR || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      srcRoot: process.env.DSH_PERF_SRC_ROOT || '',
    })
  }
  return perf
}

const OBJECT = { type: 'object', additionalProperties: true }

const tools = () => [
  defineTool({
    name: 'perf_probe',
    description: 'UI 卡顿监测：循环测客户端主窗口消息响应耗时（空闲毫秒级、UI 忙则同步挂起），统计 P50/P95/P99，记录每次超过阈值的卡顿事件（时间/耗时），capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿自动抓全 dump。返回报告 JSON 与证据目录。Triggers: 卡顿分析 / 测卡顿 / 性能监测 / UI stutter.',
    parameters: {
      seconds: { type: 'number', description: '监测时长秒数，默认 60（建议用户操作复现卡顿的操作场景）' },
      thresholdMs: { type: 'number', description: '卡顿判定阈值毫秒，默认 500' },
      capture: { type: 'string', description: 'log（默认，只记录）| shot（卡顿时截图）| dump（首次卡顿抓全 dump，数百 MB）' },
      intervalMs: { type: 'number', description: '采样间隔毫秒，默认 300' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderProbe(v) }] },
    timeoutMs: 62 * 60 * 1000,
    async execute(args) {
      return await prf().probe(args)
    },
  }),
  defineTool({
    name: 'perf_report',
    description: '读最近一次 perf_probe 的监测报告（P50/P95/P99/卡顿事件列表）。Triggers: 上次卡顿结果 / 性能报告.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.hasRun ? renderProbe(v) : '还没有监测记录' }] },
    async execute() {
      return prf().report()
    },
  }),
  defineTool({
    name: 'perf_dump',
    description: '抓当前客户端进程的全 dump（procdump -ma，会挂起进程几秒）并自动分析：UI 线程托管栈 + 锁热点线程 Top 5。用于卡顿/无响应/内存问题的现场取证。Triggers: 抓 dump / 抓内存快照 / dump 分析.',
    parameters: {
      note: { type: 'string', description: '场景备注（写入证据目录 note.txt）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('dump: ' + v.dumpPath + '（' + (v.sizeBytes / 1024 / 1024).toFixed(0) + 'MB，' + (v.durationMs / 1000).toFixed(1) + 's）\n' + renderAnalysis(v.analysis)) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().dump(args)
    },
  }),
  defineTool({
    name: 'perf_analyze',
    description: '对已有 dump 文件跑 DumpStack(ClrMD) 分析：UI 线程栈 + 锁热点线程。Triggers: 分析 dump / 重新分析 dump.',
    parameters: {
      dumpPath: { type: 'string', required: true, description: 'dump 文件绝对路径' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? renderAnalysis(v) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().analyzeDump(args.dumpPath)
    },
  }),
  defineTool({
    name: 'perf_heap',
    description: '托管堆类型统计 Top N（对象数/总字节），内存泄漏初筛——两次 dump 对比同一类型的对象数增长即泄漏嫌疑。Triggers: 堆统计 / 内存泄漏 / heap stats.',
    parameters: {
      dumpPath: { type: 'string', required: true, description: 'dump 文件绝对路径' },
      topN: { type: 'number', description: 'Top N 类型，默认 30' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('堆对象总数 ' + v.totalObjects + ' / ' + (v.totalSizeBytes / 1024 / 1024).toFixed(1) + 'MB，Top 类型（按占用）：\n' + (v.top || []).slice(0, 15).map((t) => t.type + ' x' + t.count + ' = ' + (t.sizeBytes / 1024 / 1024).toFixed(1) + 'MB').join('\n')) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().heapStats(args.dumpPath, args.topN)
    },
  }),
]

function renderProbe(v) {
  if (!v.ok) return '监测失败：' + (v.error || '未知错误')
  return '监测 ' + v.durationSec + 's：' + v.samples + ' 样本，P50=' + v.p50Ms + 'ms P95=' + v.p95Ms + 'ms P99=' + v.p99Ms + 'ms max=' + v.maxMs + 'ms，卡顿事件 ' + v.stutterCount + ' 次（阈值 ' + v.thresholdMs + 'ms）' +
    (v.stutters && v.stutters.length > 0 ? '\n卡顿明细：' + v.stutters.slice(0, 10).map((s) => s.at + ' ' + s.ms + 'ms' + (s.shot ? ' [shot:' + s.shot + ']' : '') + (s.dump ? ' [dump:' + s.dump + ']' : '')).join('，') : '') +
    '\n证据目录：' + v.evidenceDir
}

function renderAnalysis(a) {
  if (!a || !a.ok) return ''
  const lines = ['线程数 ' + a.threadCount + (a.uiThread ? '，UI 线程(mid=' + a.uiThread.managedId + ') 栈：\n' + a.uiThread.stack.join('\n') : '，未识别出 UI 线程')]
  if (a.topLockThreads && a.topLockThreads.length > 0) {
    lines.push('锁热点线程 Top ' + a.topLockThreads.length + '：')
    for (const t of a.topLockThreads) {
      if (!t.lockCount) continue
      lines.push('  [mid=' + t.managedId + ' locks=' + t.lockCount + (t.uiLikely ? ' UI' : '') + ']\n    ' + t.stack.slice(0, 8).join('\n    '))
    }
  }
  return lines.join('\n')
}

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
