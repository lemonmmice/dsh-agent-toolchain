/**
 * dsh-postman — host half.
 *
 * A Postman-style HTTP client for the DSH Web GUI. The browser half renders a
 * 「接口调试」 sidebar entry + request/response panel; this host half performs
 * the actual HTTP request server-side (so there is no browser CORS wall),
 * persists a JSONL history, owns the workspace (collections / environments /
 * globals in <store>/workspace.json), runs collections, mounts the
 * /api/dsh-postman route family (loopback-only), and registers the
 * http_request + http_collection agent tools plus a system-prompt announcement.
 * Everything rides official DSH packages — no dsh source changes.
 *
 * History record shape (one JSON object per line):
 *   { id, ts,
 *     request:  { method, url, headers, body },
 *     response: { ok:true,  status, statusText, durationMs, size, truncated,
 *                 contentType, headers, body }
 *             | { ok:false, error, durationMs } }
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在 defineTool 的 name）。
import { dshParameters, dshDescription } from '../../../lib/tool-registry.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProxyManager } from './proxy.mjs'
import { listMethods as grpcListMethods, unaryCall as grpcUnaryCall } from './grpc.mjs'
import { sendRequest, normalizeHeaders, MAX_RESP_BYTES } from './http.mjs'
import { renderHttp, renderCollectionTool, toListItem } from './view.mjs'
import {
  ASSERT_OPS, ASSERT_SOURCES, EXTRACT_SCOPES, EXTRACT_SOURCES, WorkspaceError, addItem, createCollection, createEnvironment, deleteCollection, deleteEnvironment, deleteItem,
  exportCollection, importCollection, importLegacy, loadWorkspace, mutateWorkspace, normalizeAsserts, normalizeExtract,
  setActiveEnvironment, setGlobals, storeDir, variablesFromPayload, updateCollection, updateEnvironment, updateItem, workspaceFile,
} from './workspace.mjs'
import { buildHttpRequest, scopesFromWorkspace } from './variables.mjs'
import { createRunRegistry, executeTemplate, persistExtracted } from './runner.mjs'
import { collectionTool, prepareAdhocRequest } from './collection-tool.mjs'

/** Stable cordis plugin name. */
export const name = 'postman'

/** Services required before the API surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Route family prefix. */
const API = '/api/dsh-postman'

/** History cap: keep the newest records (rotation trims the head). */
const MAX_HISTORY = 2000
/** Cap on the JSON compose payload accepted by POST /send. */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 141

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-postman 插件（DSH Web GUI 的接口调试面板，类 Postman）：侧边栏「接口调试」入口，可视化构造并发送 HTTP 请求。' +
  '能力：面板里选方法 / 填 URL / 加请求头 / 写 body，点发送后由宿主进程服务端发起请求（绕过浏览器 CORS），展示状态码 / 耗时 / 大小 / 响应头 / 响应体（自动美化 JSON）；' +
  '历史存本地 JSONL 库（history.jsonl，追加写入，上限 2000 条），点击可回填复用。' +
  '集合（可分文件夹）、多套环境、全局变量存在宿主侧 workspace.json（与面板共用）；请求可挂声明式断言（状态码 / JSON 路径 / 响应头 / 响应体 / 耗时）和变量提取（从响应 JSON 路径 / 响应头取值写回环境，用来串「登录拿 token → 调后面的接口」）；集合运行器按顺序批量跑并出通过/失败报告。' +
  'agent 可用 http_request 工具直接发请求（url 必填；method 省略时按 GET，headers/body/timeoutMs 可选；URL/头/体里用双花括号包住的变量名按当前环境替换，environment 可指定环境），返回状态码 / 响应头 / 响应体，并同样计入面板历史；' +
  '用 http_collection 读写集合与环境、跑集合（action=list/get/run/save/env）：改完代码要回归一组接口时 action=run。' +
  '限制：响应体保留上限 2MB（超出截断）；目标 URL 任意（本机开发调试工具），控制接口仅限本机回环。' +
  '面板 URL 用 ws:// 或 wss:// 开头会切到 WebSocket 客户端（浏览器直连：连接/断开、实时消息日志、发消息、可选子协议）；http_request 工具本身仅 HTTP/HTTPS；集合运行器只跑 HTTP(S)。' +
  '用户提到「接口调试 / 发请求 / 调接口 / postman / 接口测试 / 集合 / 环境变量 / 跑一遍接口 / WebSocket」时即指本插件，请据此协作。'

const storeFile = () => join(storeDir(), 'history.jsonl')

/** Parse the JSONL store into records (newest last). */
function readAll() {
  const file = storeFile()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // skip malformed lines (manual edits, concurrent writers)
    }
  }
  return out
}

/** Append one record; rotate when over the cap. Returns the new total. */
function appendHistory(rec) {
  mkdirSync(storeDir(), { recursive: true })
  const file = storeFile()
  appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  let all = readAll()
  if (all.length > MAX_HISTORY) {
    all = all.slice(all.length - MAX_HISTORY)
    writeFileSync(file, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
  return all.length
}

/** Drop every record. */
function clearHistory() {
  const all = readAll()
  const file = storeFile()
  if (existsSync(file)) writeFileSync(file, '', 'utf8')
  return { cleared: all.length }
}

/** Store API, exported for external callers. */
export { storeDir, storeFile, readAll, appendHistory, clearHistory }

/** Build a history record from a request spec + its response. */
function recordFor(spec, response) {
  return {
    id: randomUUID(),
    ts: Date.now(),
    request: {
      method: (typeof spec.method === 'string' && spec.method.trim() !== '' ? spec.method.trim() : 'GET').toUpperCase(),
      url: typeof spec.url === 'string' ? spec.url : '',
      headers: normalizeHeaders(spec.headers),
      body: typeof spec.body === 'string' ? spec.body.slice(0, MAX_RESP_BYTES) : '',
    },
    response,
  }
}

/** Light list projection (no bodies/headers) for the history table. */
// toListItem 已移到 lib/view.mjs（有损投影必须能离线离线验证，PM-03 教训）

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
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** WorkspaceError → HTTP status + { error, code }；其它异常 → 500。 */
function writeError(res, error) {
  if (error instanceof WorkspaceError) {
    writeJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
}

/** 工作区快照（面板每次改完都整份刷新：几十 KB 量级，省一次往返）。 */
function workspaceView() {
  const { workspace, warning } = loadWorkspace(storeDir())
  return { workspace, storePath: workspaceFile(storeDir()), ...(warning ? { warning } : {}) }
}

/** 跑一次改动并回整份工作区。 */
function mutateAndView(res, fn) {
  try {
    const { workspace, result } = mutateWorkspace(storeDir(), fn)
    writeJson(res, 200, { ok: true, result: result ?? null, workspace, storePath: workspaceFile(storeDir()) })
  } catch (error) {
    writeError(res, error)
  }
}

/**
 * 面板「发送」（resolve:true）：模板 + 当前环境 / 集合变量 → 发送 → 断言 → 提取（落盘）→ 记历史。
 * environmentId：省略 = 当前环境，null = 不用环境；collectionId：载入自集合的请求才带。
 */
async function sendTemplate(spec) {
  const dir = storeDir()
  const { workspace: ws, warning } = loadWorkspace(dir)
  const notes = []
  if (warning) notes.push(warning)
  let collection = spec.collectionId || undefined
  if (collection !== undefined && !ws.collections.some((c) => c.id === collection)) {
    notes.push('这个请求原来所在的集合已经不在了，本次不带集合变量')
    collection = undefined
  }
  let envRef = spec.environmentId === undefined ? undefined : spec.environmentId === null || spec.environmentId === '' ? null : spec.environmentId
  if (typeof envRef === 'string' && !ws.environments.some((e) => e.id === envRef)) {
    notes.push('选中的环境已经不在了，本次改用当前环境')
    envRef = undefined
  }
  const { scopes, environment } = scopesFromWorkspace(ws, { environment: envRef, collection })
  const asserts = normalizeAsserts(spec.asserts)
  const extract = normalizeExtract(spec.extract)
  const exec = await executeTemplate({ template: spec.template, scopes, asserts, extract, timeoutMs: spec.timeoutMs })
  if (exec.skipped) throw new WorkspaceError('INVALID', exec.skipped)
  let saved = []
  let revision
  if (exec.extract.some((x) => x.ok && x.scope !== 'runtime')) {
    try {
      saved = persistExtracted(dir, exec.extract, { environmentId: environment?.id, collectionId: collection })
      revision = true
    } catch (error) {
      notes.push('提取的变量没能写进工作区：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const extracted = exec.extract.map((x) => {
    const s = saved.find((y) => y.index === x.index)
    return { ...x, ...(s ? { savedTo: s.savedTo } : {}) }
  })
  const sent = exec.resolved ?? { method: 'GET', url: '', headers: {}, body: '' }
  let total = null
  const rec = recordFor(sent, exec.response)
  try {
    total = appendHistory(rec)
  } catch {
    // history is best-effort
  }
  return {
    id: rec.id,
    ts: rec.ts,
    total,
    response: exec.response,
    resolved: exec.resolved ?? null,
    applied: exec.applied,
    unresolved: exec.unresolved,
    environment,
    checks: { verdict: exec.verdict, asserts: exec.asserts, extract: extracted },
    ...(revision ? { workspaceChanged: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  }
}

/** Build the route family. */
function makeRoutes(proxy, runs) {
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
        const params = url.searchParams
        const body = async (max = MAX_JSON_BODY_BYTES) => {
          try {
            return await readJsonBody(req, max)
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return undefined
          }
        }
        let m

        // GET / — probe
        if (method === 'GET' && (rest === '' || rest === '/')) {
          writeJson(res, 200, { name: 'dsh-postman', api: API, ok: true, features: ['workspace', 'runs', 'checks'] })
          return
        }

        // POST /send — perform a request, log it, return the response
        //   原始模式（接口捕获的「重放」用）：{ method, url, headers?, body?, timeoutMs? }，原样发出
        //   模板模式（面板用）：{ resolve:true, template, collectionId?, environmentId?, asserts?, extract?, timeoutMs? }
        if (method === 'POST' && rest === '/send') {
          const spec = await body()
          if (spec === undefined) return
          if (spec !== null && typeof spec === 'object' && spec.resolve === true) {
            if (spec.template === null || typeof spec.template !== 'object') {
              writeJson(res, 400, { error: 'expected { resolve:true, template:{...} }' })
              return
            }
            try {
              writeJson(res, 200, await sendTemplate(spec))
            } catch (error) {
              writeError(res, error)
            }
            return
          }
          if (spec === null || typeof spec !== 'object' || typeof spec.url !== 'string' || spec.url.trim() === '') {
            writeJson(res, 400, { error: 'expected { method, url, headers?, body?, timeoutMs? }' })
            return
          }
          const response = await sendRequest(spec)
          let total = null
          const rec = recordFor(spec, response)
          try {
            total = appendHistory(rec)
          } catch {
            // history is best-effort; still return the response
          }
          writeJson(res, 200, { id: rec.id, ts: rec.ts, total, response })
          return
        }

        // POST /resolve { template, collectionId?, environmentId? } — 只替换变量不发送（复制 cURL 用）
        if (method === 'POST' && rest === '/resolve') {
          const spec = await body()
          if (spec === undefined) return
          try {
            const { workspace: ws } = loadWorkspace(storeDir())
            const collection = spec.collectionId && ws.collections.some((c) => c.id === spec.collectionId) ? spec.collectionId : undefined
            const envRef = spec.environmentId === undefined ? undefined : spec.environmentId || null
            const { scopes, environment } = scopesFromWorkspace(ws, { environment: envRef, collection })
            const built = buildHttpRequest(spec.template ?? {}, scopes)
            writeJson(res, 200, { ok: true, ...built, environment })
          } catch (error) {
            writeError(res, error)
          }
          return
        }

        // GET /history?limit&q — light list, newest first
        if (method === 'GET' && rest === '/history') {
          const all = readAll()
          const q = (params.get('q') ?? '').trim().toLowerCase()
          const methodFilter = (params.get('method') ?? '').toUpperCase()
          const limit = Math.min(Number(params.get('limit') ?? 100) || 100, 1000)
          let items = all
          if (q !== '') items = items.filter((r) => (r.request?.url ?? '').toLowerCase().includes(q))
          if (methodFilter !== '' && methodFilter !== 'ALL') items = items.filter((r) => (r.request?.method ?? '') === methodFilter)
          const total = items.length
          items = items.slice(Math.max(items.length - limit, 0)).reverse().map(toListItem)
          writeJson(res, 200, { total, items })
          return
        }

        // GET /history/{id} — full record (request + response)
        const idMatch = rest.match(/^\/history\/([^/]+)$/)
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

        // DELETE /history — clear the store
        if (method === 'DELETE' && rest === '/history') {
          writeJson(res, 200, clearHistory())
          return
        }

        // ---- workspace：集合 / 文件夹 / 请求 / 环境 / 全局变量（宿主侧 workspace.json）
        if (method === 'GET' && rest === '/workspace') {
          try {
            writeJson(res, 200, { ok: true, ...workspaceView() })
          } catch (error) {
            writeError(res, error)
          }
          return
        }
        // POST /workspace/legacy-import { collections, envText } — 旧版面板 localStorage 数据搬家（只搬一次）
        if (method === 'POST' && rest === '/workspace/legacy-import') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => importLegacy(ws, b))
          return
        }
        if (method === 'POST' && rest === '/collections') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => createCollection(ws, b))
          return
        }
        if (method === 'POST' && rest === '/collections/import') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => importCollection(ws, b.data ?? b))
          return
        }
        if ((m = rest.match(/^\/collections\/([^/]+)\/export$/)) && method === 'GET') {
          try {
            writeJson(res, 200, exportCollection(loadWorkspace(storeDir()).workspace, decodeURIComponent(m[1])))
          } catch (error) {
            writeError(res, error)
          }
          return
        }
        if ((m = rest.match(/^\/collections\/([^/]+)\/items$/)) && method === 'POST') {
          const b = await body()
          if (b === undefined) return
          const cid = decodeURIComponent(m[1])
          mutateAndView(res, (ws) => addItem(ws, cid, b))
          return
        }
        if ((m = rest.match(/^\/collections\/([^/]+)\/items\/([^/]+)$/))) {
          const cid = decodeURIComponent(m[1])
          const iid = decodeURIComponent(m[2])
          if (method === 'PATCH') {
            const b = await body()
            if (b === undefined) return
            mutateAndView(res, (ws) => updateItem(ws, cid, iid, b))
            return
          }
          if (method === 'DELETE') {
            mutateAndView(res, (ws) => deleteItem(ws, cid, iid))
            return
          }
        }
        if ((m = rest.match(/^\/collections\/([^/]+)$/))) {
          const cid = decodeURIComponent(m[1])
          if (method === 'PATCH') {
            const b = await body()
            if (b === undefined) return
            mutateAndView(res, (ws) => updateCollection(ws, cid, b))
            return
          }
          if (method === 'DELETE') {
            mutateAndView(res, (ws) => deleteCollection(ws, cid))
            return
          }
        }
        if (method === 'POST' && rest === '/environments') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => createEnvironment(ws, b))
          return
        }
        if (method === 'POST' && rest === '/environments/active') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => setActiveEnvironment(ws, b.id ?? null))
          return
        }
        if ((m = rest.match(/^\/environments\/([^/]+)$/))) {
          const eid = decodeURIComponent(m[1])
          if (method === 'PATCH') {
            const b = await body()
            if (b === undefined) return
            mutateAndView(res, (ws) => updateEnvironment(ws, eid, b))
            return
          }
          if (method === 'DELETE') {
            mutateAndView(res, (ws) => deleteEnvironment(ws, eid))
            return
          }
        }
        if (method === 'PUT' && rest === '/globals') {
          const b = await body()
          if (b === undefined) return
          mutateAndView(res, (ws) => setGlobals(ws, variablesFromPayload(b, '全局变量')))
          return
        }

        // ---- 集合运行器（面板用：启动后轮询增量结果）
        // POST /runs { collectionId, folderId?, requestId?, environmentId?, iterations?, data?, delayMs?, stopOnFailure?, timeoutMs? }
        if (method === 'POST' && rest === '/runs') {
          const b = await body()
          if (b === undefined) return
          try {
            const started = runs.start({
              collection: b.collectionId,
              folder: b.folderId || undefined,
              request: b.requestId || undefined,
              environment: b.environmentId === undefined ? undefined : b.environmentId || null,
              iterations: b.iterations,
              data: b.data,
              delayMs: b.delayMs,
              stopOnFailure: b.stopOnFailure === true,
              timeoutMs: b.timeoutMs,
              persistVariables: b.persistVariables !== false,
            })
            writeJson(res, 200, { ok: true, ...started })
          } catch (error) {
            writeError(res, error)
          }
          return
        }
        if (method === 'GET' && rest === '/runs') {
          writeJson(res, 200, { ok: true, runs: runs.list() })
          return
        }
        if ((m = rest.match(/^\/runs\/([^/]+)$/)) && method === 'GET') {
          const r = runs.get(decodeURIComponent(m[1]), params.get('since') ?? 0)
          if (r === null) writeJson(res, 404, { error: 'run not found' })
          else writeJson(res, 200, { ok: true, ...r })
          return
        }
        if ((m = rest.match(/^\/runs\/([^/]+)\/stop$/)) && method === 'POST') {
          writeJson(res, runs.stop(decodeURIComponent(m[1])) ? 200 : 404, { ok: true })
          return
        }

        // ---- connection proxy: header-auth WebSocket / raw TCP (browser can't do either) ----
        // POST /conn/open { kind:'ws'|'tcp', url?, host?, port?, tls?, headers?, subprotocols? } -> { id, kind }
        if (method === 'POST' && rest === '/conn/open') {
          const b = await body(256 * 1024)
          if (b === undefined) return
          try {
            const c = proxy.open(b ?? {})
            writeJson(res, 200, { id: c.id, kind: c.kind })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // GET /conn/poll?id&cursor — cursor-based long-poll of connection events
        if (method === 'GET' && rest === '/conn/poll') {
          const result = await proxy.poll(params.get('id') ?? '', params.get('cursor') ?? '0')
          if (result.notfound === true) {
            writeJson(res, 404, { error: 'no such connection' })
            return
          }
          writeJson(res, 200, result)
          return
        }

        // POST /conn/send { id, data, encoding? } — encoding 'base64' for binary, else utf8 text
        if (method === 'POST' && rest === '/conn/send') {
          const b = await body(2 * 1024 * 1024)
          if (b === undefined) return
          try {
            proxy.send(b.id, b.data, b.encoding)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /conn/close { id }
        if (method === 'POST' && rest === '/conn/close') {
          let b
          try {
            b = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            b = {}
          }
          proxy.close(b.id)
          writeJson(res, 200, { ok: true })
          return
        }

        // GET /conn/status
        if (method === 'GET' && rest === '/conn/status') {
          writeJson(res, 200, proxy.status())
          return
        }

        // ---- gRPC (vendored @grpc/grpc-js + @grpc/proto-loader) ----
        // POST /grpc/methods { proto } — list services/methods from a .proto
        if (method === 'POST' && rest === '/grpc/methods') {
          const b = await body(4 * 1024 * 1024)
          if (b === undefined) return
          try {
            writeJson(res, 200, await grpcListMethods(b.proto))
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /grpc/call { proto, target, service, method, request, metadata?, tls?, deadlineMs? }
        if (method === 'POST' && rest === '/grpc/call') {
          const b = await body()
          if (b === undefined) return
          const result = await grpcUnaryCall({
            protoText: b.proto,
            target: b.target,
            service: b.service,
            method: b.method,
            request: b.request,
            metadata: b.metadata,
            tls: b.tls,
            deadlineMs: b.deadlineMs,
          })
          writeJson(res, 200, result)
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

const HEADERS_PARAM = { type: 'object', additionalProperties: true, description: 'Request headers as a name→value map.' }

/** The http_request agent tool: send an HTTP request server-side. */
function httpRequestTool() {
  return defineTool({
    name: 'http_request',
    // W1：description + 简单参数走注册表；headers（复杂 object）保持内联原样（hybrid）。
    description: dshDescription('http_request'),
    parameters: {
      ...dshParameters('http_request'),
      headers: HEADERS_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'integer' },
          statusText: { type: 'string' },
          durationMs: { type: 'number' },
          size: { type: 'integer' },
          sizeExact: { type: 'boolean' },
          retainedBytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          truncationNote: { type: 'string' },
          cancelled: { type: 'boolean' },
          contentType: { type: 'string' },
          headers: { type: 'object', additionalProperties: true },
          body: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string' },
          // PM-03：跳转诚实性字段（schema 里不声明，读 schema 的调用方就不知道它们存在）
          requestedUrl: { type: 'string' },
          finalUrl: { type: 'string' },
          redirected: { type: 'boolean' },
          redirectNote: { type: 'string' },
          // {{变量}} 替换的结果（URL/头/体里有占位符时才出现）
          variables: { type: 'object', additionalProperties: true },
        },
      },
      render: renderHttp,
    },
    async execute(args) {
      let prep
      try {
        prep = prepareAdhocRequest(args)
      } catch (error) {
        if (error instanceof WorkspaceError) return { ok: false, errorCode: error.code, error: error.message }
        throw error
      }
      const response = await sendRequest({ ...prep.spec, timeoutMs: args.timeoutMs })
      try {
        appendHistory(recordFor(prep.spec, response))
      } catch {
        // history is best-effort
      }
      return prep.variables ? { ...response, variables: prep.variables } : response
    },
  })
}

const CHECK_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ASSERT_SOURCES, description: '断言对象：status 状态码 / json 响应 JSON 的某个路径 / header 响应头 / body 响应体文本 / duration 耗时(ms)' },
    path: { type: 'string', description: 'json：路径如 data.list[0].code、data.list.length（空 = 整个响应体）；header：响应头名' },
    op: { type: 'string', enum: ASSERT_OPS, description: '比较方式；in 的期望值写逗号分隔列表，type 的期望值写 string/number/boolean/object/array/null' },
    value: { type: 'string', description: '期望值（exists/notExists/empty/notEmpty 不用写）。能解析成 JSON 时按值比，0 与 "0" 不加引号时视为相等' },
    enabled: { type: 'boolean', description: 'false = 暂时停用' },
  },
}

const EXTRACT_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    var: { type: 'string', description: '写入的变量名' },
    source: { type: 'string', enum: EXTRACT_SOURCES, description: '取值来源：json 路径 / 响应头 / 响应体正则（取第 1 个分组）/ 状态码' },
    path: { type: 'string', description: 'json 路径、响应头名或正则' },
    scope: { type: 'string', enum: EXTRACT_SCOPES, description: '写到哪：environment（默认，当前环境；没选环境时写全局）/ collection / globals / runtime（只在本次运行内有效）' },
    enabled: { type: 'boolean', description: 'false = 暂时停用' },
  },
}

/** The http_collection agent tool: read/write collections & environments, run collections. */
function httpCollectionTool() {
  return defineTool({
    name: 'http_collection',
    description: dshDescription('http_collection'),
    parameters: {
      ...dshParameters('http_collection'),
      headers: HEADERS_PARAM,
      asserts: { type: 'array', items: CHECK_ITEM, description: 'save：这个请求的断言（省略 = 保留原有的）' },
      extract: { type: 'array', items: EXTRACT_ITEM, description: 'save：这个请求的变量提取（省略 = 保留原有的）' },
      variables: { type: 'object', additionalProperties: true, description: 'env：要写入的变量 {名: 值}（合并，不删别的变量）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: renderCollectionTool,
    },
    async execute(args) {
      return collectionTool(args, { dir: storeDir() })
    },
  })
}

/**
 * Mount the routes, tool, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 */
export function apply(ctx) {
  const proxy = createProxyManager()
  const runs = createRunRegistry({ dir: () => storeDir() })
  const routes = makeRoutes(proxy, runs)
  const disposeRoutes = ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-postman: routes',
  )
  const disposeTool = ctx.effect(() => ctx.tools.register(httpRequestTool()), 'dsh-postman: tools')
  const disposeCollectionTool = ctx.effect(() => ctx.tools.register(httpCollectionTool()), 'dsh-postman: collection tool')
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:postman',
    order: SECTION_ORDER,
    text: GUIDANCE,
    // 按字面量注入：宿主默认把双花括号当提示词变量解析，名字不合规会让整轮失败（见 scripts/check.mjs）
    interpolate: false,
  })
  ctx.effect(
    () => () => {
      disposeRoutes()
      disposeTool()
      disposeCollectionTool()
      disposeSection()
      proxy.dispose()
      runs.dispose()
    },
    'dsh-postman: teardown',
  )
}

/** For local harnesses: the route family without a DSH host. */
export { makeRoutes, createProxyManager, createRunRegistry }
