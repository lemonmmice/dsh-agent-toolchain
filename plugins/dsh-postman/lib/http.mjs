/**
 * dsh-agent-toolchain / dsh-postman — framework-free HTTP core.
 *
 * Performs one HTTP request server-side and shapes the result. Shared by the
 * DSH plugin (index.js) and the MCP server (mcp/tools/http-tool.mjs); imports
 * nothing outside node built-ins.
 */

/** Cap on the response body we keep/return (larger gets truncated). */
export const MAX_RESP_BYTES = 2 * 1024 * 1024
/** Default / max per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_TIMEOUT_MS = 120000

/** Whether a method may carry a request body. */
export function bodyAllowed(method) {
  return method !== 'GET' && method !== 'HEAD'
}

/** Clamp a caller-supplied timeout into the allowed band. */
export function clampTimeout(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(ms), 1), MAX_TIMEOUT_MS)
}

/** Coerce a headers object into a flat name→string map, dropping empties. */
export function normalizeHeaders(headers) {
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
export async function sendRequest(spec) {
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
    // PM-03（2026-09-11 真机确证，Claude 独立复现 11/11）：
    // fetch 默认 redirect:'follow'，302 → 别的 200 会被**当成你请求的那个接口的 200** ——
    // status/headers/body 全是跳转目标的，而"发生过跳转"这件事在结果里一个痕迹都没有。
    // 安全面更糟：跳转目标可能是登录页或攻击者可控的主机，而调用方以为自己打的是自己的 API。
    // 修法取「忠实最小」：把 fetch 已经算好的 res.url / res.redirected 如实带出来，
    // 不做 manual 跟随链（那是更大的一步，且会改变既有行为）。
    // 注意这三个字段必须放在**数据层**：MCP 面是 JSON.stringify(整个对象)、没有单行渲染，
    // 只在渲染层补一句"↪ 跳转"只对 DSH 面有效（F-021 就是这么踩的）。
    const finalUrl = typeof res.url === 'string' && res.url !== '' ? res.url : url
    const redirected = res.redirected === true
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
      requestedUrl: url,
      finalUrl,
      redirected,
      ...(redirected
        ? {
            redirectNote:
              `响应来自跳转后的地址：请求 ${url} → 实际 ${finalUrl}` +
              '（fetch 自动跟随了 301/302/303/307/308，中间的跳转与各跳状态**不在本次结果里**；' +
              'status/headers/body 全部属于最终地址）',
          }
        : {}),
    }
  } catch (error) {
    const durationMs = Date.now() - started
    const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? `timeout after ${timeoutMs}ms` : describeFetchError(error),
      durationMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 fetch 的失败**说到能指导下一步**（2026-09-11：本地回环重定向循环实测的教训）。
 *
 * Node 的 fetch 在这种情况只抛一句 `fetch failed`，真正的原因在 `error.cause` 里
 * （`redirect count exceeded` / `ENOTFOUND` / `ECONNREFUSED` / 证书错误…）。
 * 只报 "fetch failed" 的话，agent **无法区分**「重定向死循环」「域名解析不了」「连接被拒」「TLS 失败」——
 * 而这四种的下一步动作完全不同（改 URL / 查 DNS / 起服务 / 装证书）。
 */
export function describeFetchError(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  const parts = [error.message || String(error)]
  if (cause && typeof cause === 'object') {
    const code = cause.code || cause.errno || ''
    const msg = cause.message || String(cause)
    const known = {
      UND_ERR_TOO_MANY_REDIRECTS: '重定向次数超限（疑似重定向循环）—— 该地址在反复 3xx，请检查它的 Location 指向自己或互指',
      ENOTFOUND: '域名解析失败（DNS 找不到主机）',
      ECONNREFUSED: '连接被拒绝（目标端口没有服务在监听）',
      ECONNRESET: '连接被对端重置',
      ETIMEDOUT: 'TCP 连接超时',
      CERT_HAS_EXPIRED: 'TLS 证书已过期',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 自签证书不被信任',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链校验失败',
    }
    const hint = known[code] || known[String(code).toUpperCase()] || ''
    if (/redirect/i.test(msg) && !hint) parts.push('原因：' + msg + '（疑似重定向循环）')
    else if (hint) parts.push('原因：' + hint + (code ? ' [' + code + ']' : ''))
    else parts.push('原因：' + msg + (code ? ' [' + code + ']' : ''))
  }
  return parts.join(' —— ')
}
