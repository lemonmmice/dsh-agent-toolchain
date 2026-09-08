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
import { makeHangInspector } from './hang.mjs'

export const name = 'hang-inspector'

export const inject = ['webServer', 'systemPrompt']

/** Route family prefix. */
const API = '/api/dsh-hang-inspector'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 142

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-hang-inspector 插件（DSH Web GUI 的卡死分析面板）：侧边栏「卡死分析」入口，提供一键卡死诊断工作流——面板「启动监测」按钮拉起 hang-loop 主窗口响应监测（不自动点击，用户自行操作客户端），检测到客户端卡死后自动收集证据包（冻结截图 / 概要时间线 / 进程信息 / net-trace 尾部 / 探针与 procdump 日志 / 完整 dump），并可自动分析 dump 中的托管线程栈、定位卡死线程并映射到项目源码展示代码问题。证据目录默认 ~/.dsh-agent-toolchain/hang-evidence（环境变量 DSH_HANG_EVIDENCE_DIR 可覆盖）；项目源码根目录由 DSH_HANG_SRC_ROOT 指定。' +
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
      disposeRoutes()
      disposeSection()
    },
    'dsh-hang-inspector: teardown',
  )
}
