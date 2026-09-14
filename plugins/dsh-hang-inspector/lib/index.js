/**
 * dsh-hang-inspector — host half.
 *
 * Serves the ui-drive hang-loop evidence packs for the 「卡死分析」 panel:
 * pack list, per-pack text evidence (summary / process-info / net-trace tail /
 * probe + procdump logs) and the frozen screenshot. Loopback-only; packs can
 * be deleted via DELETE routes.
 *
 * One-click workflow (「启动监测」 in the panel):
 *   POST /run            → spawn hang-loop.ps1 (main-window responsiveness monitor;
 *                          the user drives the client; hang detection collects evidence)
 *   GET  /run            → run status + log tail
 *   POST /run/stop       → taskkill the run tree
 *   POST /packs/{id}/analyze → run DumpStack (ClrMD) on frozen.dmp, map the
 *   GET  /packs/{id}/analysis → analysis.json (diagnosis + project source code)
 * hang thread's stack to source files under SRC_ROOT and write analysis.json.
 *
 * This file is transport only — every capability lives in lib/hang.mjs, which
 * the MCP server (mcp/server.mjs hang_* tools) and the unit tests share.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeHangInspector } from './hang.mjs'
// 渲染层单独成模块：它是 agent 唯一看得见的契约，必须能离线单测（见 lib/render.mjs 顶部说明）。
import { renderStatus, renderRun, renderStop, renderPacks, renderPack, renderAnalyze, renderDelete } from './render.mjs'

export const name = 'hang-inspector'

// F-003（2026-09-11 实测确证）：这里过去是 `['webServer', 'systemPrompt']` ——
// **没有 'tools'**，也没有任何 defineTool。后果：卡死诊断在 DSH 侧**只有面板按钮、没有 agent 工具**，
// 工具面只存在于 MCP（mcp/server.mjs 的 hang_* 7 个工具）。
// 而用户的核心要求恰恰是"报卡死时能用工具快速拿到代码证据"——DSH 侧的 agent 却够不到。
// 现在两面工具同名同参同语义（E4），下面这组定义就是 MCP 那组的对齐副本。
export const inject = ['webServer', 'systemPrompt', 'tools']

/** Route family prefix. */
const API = '/api/dsh-hang-inspector'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 142

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-hang-inspector 插件（DSH Web GUI 的卡死分析面板 + **agent 工具**）：' +
  '工具面 hang_status（监测状态，只读）/ hang_run（启动卡死监测，**绝不自动点击**，由用户复现卡死）/ hang_stop / ' +
  'hang_packs（列证据包）/ hang_pack(id)（读全文证据）/ hang_analyze(id)（ClrMD 分析托管线程栈并映射到项目源码）/ ' +
  'hang_delete(id|all, confirm=true)（本地删除，不可恢复）。' +
  '**典型用法：用户报卡死 → hang_run → 用户复现 → hang_packs 看新包 → hang_analyze(id) 拿到线程栈与源码位置。**' +
  '同一套能力在侧边栏「卡死分析」面板上也有按钮版（「启动监测」），两条路径等价。' +
  '证据包内容：冻结截图 / 概要时间线 / 进程信息 / net-trace 尾部 / 探针与 procdump 日志 / 完整 dump。' +
  '证据目录默认 ~/.dsh-agent-toolchain/hang-evidence（环境变量 DSH_HANG_EVIDENCE_DIR 可覆盖）；' +
  '项目源码根目录由 DSH_HANG_SRC_ROOT 指定 —— **未配置时 hang_analyze 只能给到「模块!类型.方法」，不是代码级证据**。' +
  '面板可删除单个证据包或清空全部（本地删除，不可恢复）。' +
  '用户提到「卡死分析 / 压测证据 / 看 dump / 卡死证据 / 堆栈分析」时即指本插件，请据此协作。'

/** Read one request body as JSON (bounded). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-api-visualizer's fence). */
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
}

const OBJECT = { type: 'object', additionalProperties: true }

/**
 * Agent 工具面（与 mcp/server.mjs 的 hang_* 一一对应，E4：两面同名同参同语义）。
 *
 * 描述刻意区分「只读」与「有副作用」：card 死诊断的默认路径是**只读**的
 * （status / packs / pack / analyze），只有 run/stop 会起停进程、delete 会删文件。
 * 这样 agent 可以在不改变被测应用状态的前提下完成取证。
 */
const tools = (hang) => [
  defineTool({
    name: 'hang_status',
    description: '卡死监测状态（只读）：监测进程是否在跑、pid/退出码、日志尾部。证据包用 hang_packs 列。Triggers: 卡死监测在跑吗 / hang status.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderStatus(v) }] },
    timeoutMs: 30 * 1000,
    async execute() {
      const r = hang.runStatus() || {}
      return { ...r, evidenceDir: hang.packsDir() }
    },
  }),
  defineTool({
    name: 'hang_run',
    description: '启动卡死**监测**（不是"抓一次现场"）。分两种情形：**客户端此刻已经卡死** → 先 `perf_dump` 把现场固定下来（进程一旦被重启，现场就没了）；**卡死不定期复现** → 用本工具挂监测、让用户照常操作。只监视目标客户端**主窗口响应性，绝不自动点击** —— 让用户按平常方式操作复现卡死，检测到无响应时自动收集证据包（冻结截图/时间线/进程信息/net-trace 尾部/探针与 procdump 日志/完整 dump）。立即返回，随后用 hang_status / hang_packs 轮询。maxSeconds>0 时自动停止（0=不限，用 hang_stop 结束）。Triggers: 抓卡死 / 启动卡死监测 / hang.',
    parameters: {
      maxSeconds: { type: 'number', description: '多少秒后自动停止（0=不限，最大 86400），默认 0' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderRun(v) }] },
    timeoutMs: 60 * 1000,
    async execute(args) {
      return await hang.startRun({ maxSeconds: args?.maxSeconds ?? 0 })
    },
  }),
  defineTool({
    name: 'hang_stop',
    description: '停止卡死监测（结束其进程树）。**已收集的证据包会保留**。Triggers: 停卡死监测 / hang stop.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderStop(v) }] },
    timeoutMs: 60 * 1000,
    async execute() {
      return await hang.stopRun()
    },
  }),
  defineTool({
    name: 'hang_packs',
    description: '**列表**（只给元信息，不给正文；读正文用 hang_pack）。列出已收集的卡死证据包（新的在前）：id、时间、文件清单、dump 大小、是否有冻结截图、分析状态、summary 首行。读全文证据用 hang_pack，跑分析用 hang_analyze。**注意年龄**：几小时前的包不能用来解释刚发生的卡死。Triggers: 卡死证据包 / 有哪些 dump / hang packs.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderPacks(v, { now: Date.now() }) }] },
    timeoutMs: 30 * 1000,
    async execute() {
      const items = hang.listPacks()
      return { total: items.length, evidenceDir: hang.packsDir(), items }
    },
  }),
  defineTool({
    name: 'hang_pack',
    description: '读**一个**卡死证据包的全文证据（**单体**：先 hang_packs 拿 id，再读它；本工具不吃路径、只吃 id）：summary / process-info / net-trace 尾部 / 探针与 procdump 日志（各截断 512KB）+ 文件清单 + 缓存的 analysis.json。冻结截图是包目录里的 frozen-screen.png，需要看图时把该路径交给视觉工具。Triggers: 看卡死证据 / 证据包内容 / hang pack.',
    parameters: {
      id: { type: 'string', required: true, description: '证据包 id（来自 hang_packs）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderPack(v) }] },
    timeoutMs: 60 * 1000,
    async execute(args) {
      const detail = hang.packDetail(args?.id)
      if (detail === null) return { ok: false, error: 'pack not found: ' + args?.id }
      return detail
    },
  }),
  defineTool({
    name: 'hang_analyze',
    description: '对证据包的 frozen.dmp 跑 ClrMD(DumpStack) 分析：托管线程栈、嫌疑/UI 线程、诊断结论，并把嫌疑方法映射到项目源码（DSH_HANG_SRC_ROOT）。这是"到底哪一行代码卡住了"的答案。**已完成的分析会被复用**（不重算），除非传 refresh=true —— 只有在你刚改了 DSH_HANG_SRC_ROOT 或证据包变了才需要重算（重算会用**当前**配置覆盖旧结果，配置更差时会把好结果顶掉）。wait=true（默认）阻塞到分析完成并返回报告；wait=false 立即返回、稍后用 hang_packs 看状态。Triggers: 分析卡死 / 卡死线程栈 / 映射源码 / hang analyze.',
    parameters: {
      id: { type: 'string', required: true, description: '证据包 id（来自 hang_packs，必须含 frozen.dmp）' },
      wait: { type: 'boolean', description: '是否等分析完成，默认 true' },
      waitMs: { type: 'number', description: 'wait=true 时最长等待毫秒，默认 300000' },
      refresh: { type: 'boolean', description: '已缓存完成结果时是否强制重算（改了 DSH_HANG_SRC_ROOT 后用）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderAnalyze(v) }] },
    timeoutMs: 12 * 60 * 1000,
    async execute(args) {
      return await hang.analyze(args?.id, { wait: args?.wait !== false, waitMs: args?.waitMs ?? 300000, refresh: args?.refresh === true })
    },
  }),
  defineTool({
    name: 'hang_delete',
    description: '删除卡死证据包（**本地删除、不可恢复**；dump 有数百 MB）。**必须显式 confirm=true**。给 id 删一个，或 all=true 清空全部。Triggers: 删证据包 / 清空卡死证据 / hang delete.',
    parameters: {
      id: { type: 'string', description: '要删除的证据包 id' },
      all: { type: 'boolean', description: 'true = 清空证据目录里全部证据包' },
      confirm: { type: 'boolean', required: true, description: '必须为 true —— 删除不可恢复' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDelete(v) }] },
    timeoutMs: 60 * 1000,
    async execute(args) {
      if (args?.confirm !== true) {
        return { blocked: '已阻止：hang_delete 不可恢复。请先向用户确认，再带 confirm=true 重发。' }
      }
      if (args?.all === true) return { deleted: hang.removeAllPacks(), all: true }
      if (typeof args?.id === 'string' && args.id !== '') {
        const ok = hang.removePack(args.id)
        return ok ? { deleted: args.id } : { ok: false, error: 'pack not found: ' + args.id }
      }
      return { blocked: '没有要删的目标：请传 id=<包 id> 或 all=true。' }
    },
  }),
]

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Build the route family. */
function makeRoutes(hang) {
  return [
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

        // GET / — probe
        if (method === 'GET' && (rest === '' || rest === '/')) {
          writeJson(res, 200, { name: 'dsh-hang-inspector', api: API, ok: true, evidenceDir: hang.packsDir() })
          return
        }

        // GET /packs — pack list (no text bodies, keep it light)
        if (method === 'GET' && rest === '/packs') {
          const items = hang.listPacks()
          writeJson(res, 200, { total: items.length, items })
          return
        }

        // GET /packs/{id}/screenshot — frozen screen PNG
        const shotMatch = rest.match(/^\/packs\/([^/]+)\/screenshot$/)
        if (method === 'GET' && shotMatch !== null) {
          const id = decodeURIComponent(shotMatch[1])
          const detail = hang.packDetail(id)
          const file = detail === null ? null : join(detail.dir, 'frozen-screen.png')
          if (file === null || !existsSync(file)) {
            writeJson(res, 404, { error: 'screenshot not found' })
            return
          }
          const buf = readFileSync(file)
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': buf.length,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end(buf)
          return
        }

        // GET /packs/{id} — full text evidence + file list
        const packMatch = rest.match(/^\/packs\/([^/]+)$/)
        if (method === 'GET' && packMatch !== null) {
          const detail = hang.packDetail(decodeURIComponent(packMatch[1]))
          if (detail === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          writeJson(res, 200, detail)
          return
        }

        // DELETE /packs — clear every evidence pack
        if (method === 'DELETE' && rest === '/packs') {
          writeJson(res, 200, { deleted: hang.removeAllPacks() })
          return
        }

        // DELETE /packs/{id} — delete one evidence pack
        const delMatch = rest.match(/^\/packs\/([^/]+)$/)
        if (method === 'DELETE' && delMatch !== null) {
          const id = decodeURIComponent(delMatch[1])
          if (!hang.removePack(id)) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          writeJson(res, 200, { deleted: id })
          return
        }

        // ---- hang monitor run (「启动监测」) ----

        // GET /run — run status + log tail
        if (method === 'GET' && rest === '/run') {
          writeJson(res, 200, hang.runStatus())
          return
        }

        // POST /run — start the hang monitor (no auto-clicking; user drives the client)
        if (method === 'POST' && rest === '/run') {
          let body = {}
          try {
            body = await readBody(req, 64 * 1024)
          } catch {
            // treat unparsable body as {}
          }
          const r = hang.startRun({ maxSeconds: body.maxSeconds })
          if (r.ok !== true) {
            writeJson(res, r.error === '监测已在运行' ? 409 : 500, r)
            return
          }
          writeJson(res, 202, r)
          return
        }

        // POST /run/stop — kill the run tree
        if (method === 'POST' && rest === '/run/stop') {
          writeJson(res, 202, hang.stopRun())
          return
        }

        // ---- dump analysis ----

        // GET /packs/{id}/analysis — cached analysis.json (or none)
        const analysisMatch = rest.match(/^\/packs\/([^/]+)\/analysis$/)
        if (method === 'GET' && analysisMatch !== null) {
          const out = hang.readAnalysis(decodeURIComponent(analysisMatch[1]))
          if (out === null) {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          writeJson(res, 200, out)
          return
        }

        // POST /packs/{id}/analyze — (re)run the stack analysis
        const analyzeMatch = rest.match(/^\/packs\/([^/]+)\/analyze$/)
        if (method === 'POST' && analyzeMatch !== null) {
          const r = await hang.analyze(decodeURIComponent(analyzeMatch[1]))
          if (r.ok === false && r.error === 'pack not found') {
            writeJson(res, 404, { error: 'pack not found' })
            return
          }
          writeJson(res, 202, r)
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

/**
 * Mount the routes and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 */
export function apply(ctx) {
  const hang = makeHangInspector({})
  const routes = makeRoutes(hang)
  // 工具面：与 MCP 的 hang_* 一致（F-003）。注册失败必须能看见，不能静默缺席。
  const disposeTools = ctx.effect(
    () => {
      const disposers = tools(hang).map((tool) => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-hang-inspector: tools',
  )
  const disposeRoutes = ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-hang-inspector: routes',
  )
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:hang-inspector',
    order: SECTION_ORDER,
    text: GUIDANCE,
  })
  ctx.effect(
    () => () => {
      disposeTools()
      disposeRoutes()
      disposeSection()
    },
    'dsh-hang-inspector: teardown',
  )
}
