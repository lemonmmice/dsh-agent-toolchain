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
