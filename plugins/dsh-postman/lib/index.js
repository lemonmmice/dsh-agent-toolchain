/**
 * dsh-postman — host half.
 *
 * A Postman-style HTTP client for the DSH Web GUI. The browser half renders a
 * 「接口调试」 sidebar entry + request/response panel; this host half performs
 * the actual HTTP request server-side (so there is no browser CORS wall),
 * persists a JSONL history, mounts the /api/dsh-postman route family
 * (loopback-only), and registers the http_request agent tool plus a
 * system-prompt announcement. Everything rides official DSH packages — no dsh
 * source changes.
 *
 * History record shape (one JSON object per line):
 *   { id, ts,
 *     request:  { method, url, headers, body },
 *     response: { ok:true,  status, statusText, durationMs, size, truncated,
 *                 contentType, headers, body }
 *             | { ok:false, error, durationMs } }
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createProxyManager } from './proxy.mjs'
import { listMethods as grpcListMethods, unaryCall as grpcUnaryCall } from './grpc.mjs'

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
/** Cap on the response body we keep/return/display (larger gets truncated). */
const MAX_RESP_BYTES = 2 * 1024 * 1024
/** Default / max per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 120000

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 141

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE =
  '本机已安装 dsh-postman 插件（DSH Web GUI 的接口调试面板，类 Postman）：侧边栏「接口调试」入口，可视化构造并发送 HTTP 请求。' +
  '能力：面板里选方法 / 填 URL / 加请求头 / 写 body，点发送后由宿主进程服务端发起请求（绕过浏览器 CORS），展示状态码 / 耗时 / 大小 / 响应头 / 响应体（自动美化 JSON）；' +
  '历史存本地 JSONL 库（history.jsonl，追加写入，上限 2000 条），点击可回填复用。' +
  'agent 可用 http_request 工具直接发请求（method/url 必填，headers/body/timeoutMs 可选），返回状态码 / 响应头 / 响应体，并同样计入面板历史。' +
  '限制：响应体保留上限 2MB（超出截断）；目标 URL 任意（本机开发调试工具），控制接口仅限本机回环。' +
  '面板 URL 用 ws:// 或 wss:// 开头会切到 WebSocket 客户端（浏览器直连：连接/断开、实时消息日志、发消息、可选子协议）；http_request 工具本身仅 HTTP/HTTPS。' +
  '用户提到「接口调试 / 发请求 / 调接口 / postman / 接口测试 / WebSocket」时即指本插件，请据此协作。'

/** Primary store location (env override, then DSH_HOME, then home). */
function storeDir() {
  if (process.env.DSH_POSTMAN_STORE) return process.env.DSH_POSTMAN_STORE
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'postman')
}
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

/** Store API, exported for tests / external callers. */
export { storeDir, storeFile, readAll, appendHistory, clearHistory }

/** Whether a method may carry a request body. */
function bodyAllowed(method) {
  return method !== 'GET' && method !== 'HEAD'
}

/** Clamp a caller-supplied timeout into the allowed band. */
function clampTimeout(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(ms), 1), MAX_TIMEOUT_MS)
}

/** Coerce a headers object into a flat name→string map, dropping empties. */
function normalizeHeaders(headers) {
  const out = {}
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key !== 'string' || key.trim() === '') continue
      if (value === undefined || value === null) continue
      out[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
  return out
}

/**
 * Perform one HTTP request server-side and shape the result.
 * A non-2xx status is still ok:true (a response arrived); ok:false is reserved
 * for transport failures (invalid URL, DNS, connection, timeout).
 * @param spec - { method, url, headers, body, timeoutMs }
 */
async function sendRequest(spec) {
  const method = (typeof spec.method === 'string' && spec.method.trim() !== '' ? spec.method.trim() : 'GET').toUpperCase()
  const url = typeof spec.url === 'string' ? spec.url.trim() : ''
  const started = Date.now()

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: `invalid url: ${url === '' ? '(empty)' : url}`, durationMs: 0 }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${parsed.protocol}`, durationMs: 0 }
  }

  const headers = normalizeHeaders(spec.headers)
  const hasBody = bodyAllowed(method) && typeof spec.body === 'string' && spec.body !== ''
  const timeoutMs = clampTimeout(spec.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: hasBody ? spec.body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const durationMs = Date.now() - started
    const resHeaders = {}
    res.headers.forEach((value, key) => {
      resHeaders[key] = value
    })
    const size = buf.length
    const truncated = size > MAX_RESP_BYTES
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      durationMs,
      size,
      truncated,
      contentType: resHeaders['content-type'] ?? '',
      headers: resHeaders,
      body: buf.subarray(0, MAX_RESP_BYTES).toString('utf8'),
    }
  } catch (error) {
    const durationMs = Date.now() - started
    const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? `timeout after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
      durationMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

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
function toListItem(rec) {
  const r = rec.response ?? {}
  return {
    id: rec.id,
    ts: rec.ts,
    method: rec.request?.method ?? 'GET',
    url: rec.request?.url ?? '',
    ok: r.ok === true,
    status: Number.isInteger(r.status) ? r.status : null,
    durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
    size: Number.isInteger(r.size) ? r.size : null,
    error: r.ok === false ? r.error ?? '' : '',
  }
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Build the route family. */
function makeRoutes(proxy) {
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

        // GET / — probe
        if (method === 'GET' && (rest === '' || rest === '/')) {
          writeJson(res, 200, { name: 'dsh-postman', api: API, ok: true })
          return
        }

        // POST /send — perform a request, log it, return the response
        if (method === 'POST' && rest === '/send') {
          let spec
          try {
            spec = await readJsonBody(req, MAX_JSON_BODY_BYTES)
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
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

        // ---- connection proxy: header-auth WebSocket / raw TCP (browser can't do either) ----
        // POST /conn/open { kind:'ws'|'tcp', url?, host?, port?, tls?, headers?, subprotocols? } -> { id, kind }
        if (method === 'POST' && rest === '/conn/open') {
          let body
          try {
            body = (await readJsonBody(req, 256 * 1024)) ?? {}
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          try {
            const c = proxy.open(body)
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
          let body
          try {
            body = (await readJsonBody(req, 2 * 1024 * 1024)) ?? {}
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          try {
            proxy.send(body.id, body.data, body.encoding)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /conn/close { id }
        if (method === 'POST' && rest === '/conn/close') {
          let body
          try {
            body = (await readJsonBody(req, 64 * 1024)) ?? {}
          } catch {
            body = {}
          }
          proxy.close(body.id)
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
          let body
          try {
            body = (await readJsonBody(req, 4 * 1024 * 1024)) ?? {}
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          try {
            writeJson(res, 200, await grpcListMethods(body.proto))
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // POST /grpc/call { proto, target, service, method, request, metadata?, tls?, deadlineMs? }
        if (method === 'POST' && rest === '/grpc/call') {
          let body
          try {
            body = (await readJsonBody(req, 8 * 1024 * 1024)) ?? {}
          } catch (error) {
            writeJson(res, 400, { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          const result = await grpcUnaryCall({
            protoText: body.proto,
            target: body.target,
            service: body.service,
            method: body.method,
            request: body.request,
            metadata: body.metadata,
            tls: body.tls,
            deadlineMs: body.deadlineMs,
          })
          writeJson(res, 200, result)
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

/** The http_request agent tool: send an HTTP request server-side. */
function httpRequestTool() {
  return defineTool({
    name: 'http_request',
    description:
      'Send an HTTP request from the host (Postman-style, server-side so no browser CORS) and return the response ' +
      '(status / statusText / headers / body / duration). The call is also logged to the dsh-postman 「接口调试」 panel history. ' +
      'A non-2xx status is a normal result (ok:true); ok:false means the request could not be made (bad url / connection / timeout). ' +
      'Triggers: 发请求 / 调接口 / 接口测试 / http request / call an API.',
    parameters: {
      method: { type: 'string', required: true, description: 'HTTP method, e.g. GET/POST/PUT/DELETE/PATCH.' },
      url: { type: 'string', required: true, description: 'Absolute request URL (http/https).' },
      headers: { type: 'object', additionalProperties: true, description: 'Request headers as a name→value map.' },
      body: { type: 'string', description: 'Request body (ignored for GET/HEAD). For JSON, set content-type and pass a JSON string.' },
      timeoutMs: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
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
          truncated: { type: 'boolean' },
          contentType: { type: 'string' },
          headers: { type: 'object', additionalProperties: true },
          body: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `${value.status} ${value.statusText ?? ''} · ${Math.round(value.durationMs)}ms · ${value.size} bytes` }]
          : [{ type: 'text', text: `request failed: ${value.error}` }],
    },
    async execute(args) {
      const response = await sendRequest(args)
      try {
        appendHistory(recordFor(args, response))
      } catch {
        // history is best-effort
      }
      return response
    },
  })
}

/**
 * Mount the routes, tool, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 */
export function apply(ctx) {
  const proxy = createProxyManager()
  const routes = makeRoutes(proxy)
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
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:postman',
    order: SECTION_ORDER,
    text: GUIDANCE,
  })
  ctx.effect(
    () => () => {
      disposeRoutes()
      disposeTool()
      disposeSection()
      proxy.dispose()
    },
    'dsh-postman: teardown',
  )
}
