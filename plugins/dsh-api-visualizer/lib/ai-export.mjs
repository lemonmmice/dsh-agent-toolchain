/**
 * 「AI 分析包」：把一批捕获记录整理成一份 Markdown 摘要，交给大模型分析（纯函数，无 I/O）。
 *
 * 为什么不直接给 HAR / JSON：模型读原始导出要先自己做汇总，大正文、二进制转储和重复的噪音请求头会把上下文冲掉。
 * 这里先给概况与汇总表，再按时间先后给每条请求的明细（#1…#N），汇总里的"最慢 / 错误"列表用编号引用明细。
 *
 * 约定：
 *   · 时间一律是本机时间（文件头写明时区）；明细标题里是 HH:MM:SS.mmm。
 *   · JSON 正文无损美化：大整数（订单号、时间戳）和 1.50 这类写法保持原文（parseJsonLossless + JSON.rawJSON）；
 *     运行环境没有 JSON.rawJSON 时不美化，原样输出（宁可难看也不改数字）。
 *   · 每个正文最多导出 bodyLimit 字节（按**实际写出的文本**的 UTF-8 字节数判断：美化后放不下就给原文，原文也放不下才截断，
 *     并写明原长）；bodyLimit=0 不导出正文。只有原文不超过 2×bodyLimit 才美化（大正文反正要截，不为前 N 字节去美化整份）。
 *   · 捕获时就存成 hex / base64 转储的二进制正文只写大小，不倒出内容；引擎没存正文（空串）但记了大小的写明"未保存正文"。
 *   · redact=true 时遮盖：敏感请求头 / 响应头（名单 + 名字里带 token / auth / session / secret / cookie 等词的头）、
 *     URL 里的敏感查询参数（请求地址、Referer / Location / Origin 等 URL 型头的值，含 # 片段里的同名参数）、表单正文里的同名字段
 *     （值写成 ***）；JSON 正文与其它头不处理。默认不脱敏。
 *   · 记录里来的文字（方法、域名、来源、参数名、头名…）写在代码块之外时先单行化，并转义行首的 Markdown 标记，
 *     导入的记录造不出假的小节 / 列表 / 表格行。
 *   · buildAiDigestAsync 与 buildAiDigest 输出完全相同，只是每约 100 条记录、以及格式化大正文之前让出一次事件循环（宿主里用）。
 */

import { parseJsonLossless } from './rewrite-rules.mjs'

/** 每个正文默认导出的字节数。 */
export const AI_BODY_LIMIT_DEFAULT = 4096
/** 每个正文最多导出的字节数（1 MB）。 */
export const AI_BODY_LIMIT_MAX = 1024 * 1024
/** 默认标题。 */
export const AI_DEFAULT_TITLE = '接口捕获 AI 分析包'

const HAS_RAW_JSON = typeof JSON.rawJSON === 'function'

/** 代理 / 实时引擎在正文超过上限时追加的截断标记（与引擎一致）。 */
const CAPTURE_TRUNCATED_MARK = '…(截断)'
/** 存储层单字段上限（lib/capture-store.mjs 的 MAX_FIELD_BYTES）：到了这个长度说明落库时被截过。 */
const STORE_FIELD_CAP = 2 * 1024 * 1024
/** 二进制正文落库成 'hex:' + 前 64 KB。 */
const HEX_DUMP_CAP_BYTES = 64 * 1024

const HEX_BODY = /^hex:[0-9a-f]*$/i
const BASE64_BODY = /^base64:([^;\s]*);([A-Za-z0-9+/=]*)$/

/** 请求头里对分析没用的噪音（不导出）。 */
const NOISE_REQ_HEADERS = new Set(['date', 'connection', 'accept-encoding', 'accept-language', 'user-agent', 'cache-control', 'pragma', 'host', 'content-length'])
/** 响应头只导出这几个（外加 x-* ）。 */
const KEEP_RES_HEADERS = new Set(['content-type', 'content-encoding', 'set-cookie', 'location'])
/** redact=true 时遮盖的请求 / 响应头（与面板导出的「脱敏」同一份名单）。 */
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-token', 'access-token', 'token'])
/** redact=true 时遮盖的查询参数（名称不区分大小写）。 */
const SENSITIVE_QUERY = new Set(['token', 'usertoken', 'connectiontoken', 'access_token', 'refresh_token', 'password', 'secret', 'apikey', 'api_key', 'sign', 'sig'])
/** 名单之外，名字里带这些词（按 - _ . 分段）的头也整值遮盖：x-auth-token、x-access-token、x-session-token…… */
const SENSITIVE_HEADER_WORD = /(?:^|[-_.])(?:[a-z0-9]*token|auth|authorization|session(?:id)?|secret|password|passwd|cookie|api[-_]?key|signature|sign|sig)(?=$|[-_.])/i
/** 值是 URL 的头：redact 时遮盖其中的敏感查询参数（不整值遮盖，地址本身对分析有用）。 */
const URL_HEADERS = new Set(['referer', 'location', 'origin', 'content-location', 'refresh'])
const MASK = '***'
/** 记录数到这个整数倍时让出一次事件循环（buildAiDigestAsync）。 */
const YIELD_EVERY_RECORDS = 100
/** 正文超过这么多字符时，格式化之前单独让出一次。 */
const YIELD_BODY_CHARS = 64 * 1024
/** 嵌套超过这么深的 JSON 不美化（缩进随深度平方增长：几 KB 的深层数组能美化出几 MB）。 */
const PRETTY_MAX_DEPTH = 64
const BACKSLASH = String.fromCharCode(92)

/** 捕获渠道的中文说明（渠道 id 与过滤器的「捕获渠道」字段一致）。 */
const CHANNEL_LABELS = Object.freeze({
  realtime: '实时日志',
  intercept: '透明拦截',
  'local-proxy': '本地代理',
  import: '导入',
  agent: 'agent 追加',
  etw: 'ETW',
})

const SUMMARY_ROWS_MAX = 80
const HOSTS_LISTED_MAX = 15
const SLOWEST_COUNT = 10
const ERRORS_LISTED_MAX = 50
const HEADER_VALUE_MAX = 2048
const QUERY_VALUE_MAX = 2000
const NOTE_MAX = 500
const HEADING_URL_MAX = 300
const STACK_FRAMES_MAX = 6

// ------------------------------------------------------------------ 小工具

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const pad2 = (n) => String(n).padStart(2, '0')
const pad3 = (n) => String(n).padStart(3, '0')

/** 单行化：换行 / 制表符写成可见的转义，免得一个值把 Markdown 列表撑断。 */
function inline(v) {
  return str(v).replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t')
}

/**
 * 写在行首（或列表项开头）的记录文字：单行化，再转义开头的 Markdown 块标记（# > - + * = | ~ < ` 和 "1." / "1)"），
 * 免得导入的记录里一个参数名 / 头名变成标题、引用、列表或表格行。
 */
function lead(v) {
  const t = inline(v)
  const m = /^(\s*)(?:([#>+*=|~<`-])|(\d+)([.)]))/.exec(t)
  if (m === null) return t
  if (m[2] !== undefined) return `${m[1]}\\${t.slice(m[1].length)}`
  return `${m[1]}${m[3]}\\${t.slice(m[1].length + m[3].length)}`
}

/** 截到 max 个字符以内（不劈开代理对），超出时写明原长。 */
function capChars(text, max) {
  const t = str(text)
  if (t.length <= max) return t
  let end = max
  const c = t.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${t.slice(0, end)}…（截断，原长 ${t.length} 字符）`
}

/** 表格单元格：去换行、转义竖线。 */
function cell(v) {
  return inline(v).replace(/\|/g, '\\|')
}

/** 行内代码；内容本身带反引号时用更长的定界符。 */
function code(v) {
  const t = inline(v)
  let longest = 0
  for (const m of t.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(longest + 1)
  return longest > 0 ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`
}

/** 代码块定界符：比正文里最长的一串反引号多一个，至少三个。 */
function fenceFor(text) {
  let longest = 0
  for (const m of str(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function clockOf(ts) {
  if (!finite(ts)) return '时间未知'
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function dateTimeOf(ts) {
  if (!finite(ts)) return '时间未知'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockOf(ts)}`
}

function utcOffsetOf(ts) {
  const off = -new Date(finite(ts) ? ts : 0).getTimezoneOffset()
  const a = Math.abs(off)
  return `UTC${off >= 0 ? '+' : '-'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
}

function spanText(ms) {
  if (!finite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  if (m < 60) return `${m} 分 ${totalSec % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

function bytesText(n) {
  if (!finite(n)) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const msText = (n) => (finite(n) ? String(Math.round(n)) : '—')
const statusText = (s) => (Number.isInteger(s) ? String(s) : '无状态码')
const isError = (r) => !Number.isInteger(r.status) || r.status >= 400

/** 一个 UTF-8 字节上限内的前缀（不劈开多字节字符）。 */
function cutUtf8(text, maxBytes) {
  // 每个字符至少 1 字节：只编码前 maxBytes+1 个字符就够判断（大正文不整份转 Buffer）
  const buf = Buffer.from(text.length > maxBytes + 1 ? text.slice(0, maxBytes + 1) : text, 'utf8')
  if (buf.length <= maxBytes && text.length <= maxBytes + 1) return text
  let end = Math.max(0, Math.min(maxBytes, buf.length))
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

// ------------------------------------------------------------------ 记录字段

/** URL 拆成 域名 / 路径 / 原始查询串（查询串取原文，不经 WHATWG 重新编码）。 */
function urlParts(url) {
  const s = str(url)
  const noHash = s.split('#')[0]
  const qi = noHash.indexOf('?')
  const search = qi >= 0 ? noHash.slice(qi + 1) : ''
  let host = ''
  let path = ''
  try {
    const u = new URL(s)
    host = u.hostname.toLowerCase()
    path = u.pathname || '/'
  } catch {
    const before = qi >= 0 ? noHash.slice(0, qi) : noHash
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i.exec(before)
    if (m !== null) {
      host = m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase()
      path = m[2] || '/'
    } else {
      path = before || '/'
    }
  }
  return { host, path, search }
}

/** 捕获渠道：与过滤器的「捕获渠道」字段同一口径。 */
function channelOf(r) {
  return r.source === 'proxy' ? (r.process === 'intercept' ? 'intercept' : 'local-proxy') : str(r.source)
}

const channelLabel = (ch) => (ch === '' ? '（未知）' : Object.hasOwn(CHANNEL_LABELS, ch) ? `${ch}（${CHANNEL_LABELS[ch]}）` : inline(ch))

/** 发起请求的进程名：记录自带的优先；实时日志记录没有时用配置的客户端进程名。 */
function processOf(r, realtimeProcess) {
  if (typeof r.clientProcess === 'string' && r.clientProcess !== '') return r.clientProcess
  if (r.source === 'realtime' && realtimeProcess !== '') return realtimeProcess
  return ''
}

function headerGet(headers, name) {
  if (!isObj(headers)) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

function contentTypeOf(headers, fallback) {
  const v = headerGet(headers, 'content-type')
  const first = Array.isArray(v) ? v.find((x) => typeof x === 'string' && x.trim() !== '') : v
  if (typeof first === 'string' && first.trim() !== '') return first
  return typeof fallback === 'string' ? fallback : ''
}

function decodeQueryPart(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s // 非 UTF-8 的百分号编码（GBK 等）或残缺转义：原样保留
  }
}

/** 查询串 → [{ name, value | null }]（value 为 null 表示没有 '='）。 */
function queryPairs(search) {
  if (search === '') return []
  const out = []
  for (const part of search.split('&')) {
    if (part === '') continue
    const i = part.indexOf('=')
    out.push(i < 0 ? { name: decodeQueryPart(part), value: null } : { name: decodeQueryPart(part.slice(0, i)), value: decodeQueryPart(part.slice(i + 1)) })
  }
  return out
}

const isSensitiveQuery = (name) => SENSITIVE_QUERY.has(str(name).toLowerCase())

/** 查询串 / 表单正文里敏感参数的值换成 ***（其余字节原样不动）。 */
function redactQueryText(text) {
  return str(text).split('&').map((part) => {
    const i = part.indexOf('=')
    const rawName = i < 0 ? part : part.slice(0, i)
    return isSensitiveQuery(decodeQueryPart(rawName)) ? `${rawName}=${MASK}` : part
  }).join('&')
}

/**
 * 一段含 URL 的文字（请求地址、Referer / Location 等头的值）：遮盖 user:pass@、查询串与 # 片段里的敏感参数。
 * 片段既可能是 `#access_token=…&state=…`，也可能是单页应用的 `#/detail?usertoken=…`：两种都按查询串处理。
 */
function redactUrlText(text) {
  const s = str(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/gi, (_, scheme) => `${scheme}${MASK}@`)
  const hashAt = s.indexOf('#')
  const main = hashAt >= 0 ? s.slice(0, hashAt) : s
  const qi = main.indexOf('?')
  let out = qi >= 0 ? main.slice(0, qi + 1) + redactQueryText(main.slice(qi + 1)) : main
  if (hashAt >= 0) {
    const frag = s.slice(hashAt + 1)
    const fq = frag.indexOf('?')
    out += '#' + (fq >= 0 ? frag.slice(0, fq + 1) + redactQueryText(frag.slice(fq + 1)) : redactQueryText(frag))
  }
  return out
}

/** 标题里的 URL：redact 时遮盖敏感查询参数（含 # 片段）与 user:pass@。 */
function displayUrl(url, redact) {
  return capChars(redact ? redactUrlText(url) : str(url), HEADING_URL_MAX)
}

function callerText(c) {
  if (!isObj(c)) return ''
  const who = str(c.viewModel || c.view)
  const parts = []
  if (who !== '') parts.push(who)
  if (str(c.apiMethod) !== '' && c.apiMethod !== who) parts.push(str(c.apiMethod))
  let s = parts.join(' ← ')
  if (str(c.trigger) !== '') s += `${s === '' ? '' : ' '}（触发：${str(c.trigger)}）`
  return capChars(inline(s), NOTE_MAX)
}

function stackText(c) {
  if (!isObj(c) || !Array.isArray(c.stack)) return ''
  const frames = c.stack.filter((f) => typeof f === 'string' && f.trim() !== '').map((f) => capChars(inline(f.trim()), 200))
  if (frames.length === 0) return ''
  return frames.slice(0, STACK_FRAMES_MAX).join(' ← ') + (frames.length > STACK_FRAMES_MAX ? ` ← …（共 ${frames.length} 层）` : '')
}

// ------------------------------------------------------------------ 明细里的头与正文

/** 头的列表行；数组值（如多个 Set-Cookie）每个值一行。 */
function headerLines(headers, keep, redact) {
  const lines = []
  if (!isObj(headers)) return lines
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!keep(lower)) continue
    const values = Array.isArray(value) ? value : [value]
    const masked = redact && (SENSITIVE_HEADERS.has(lower) || SENSITIVE_HEADER_WORD.test(lower))
    for (const v of values) {
      if (v === undefined || v === null) continue
      let text = str(v)
      if (redact && !masked && (URL_HEADERS.has(lower) || /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(text))) text = redactUrlText(text)
      const shown = masked ? MASK : capChars(inline(text), HEADER_VALUE_MAX)
      lines.push(`- ${lead(name)}: ${shown}`)
    }
  }
  return lines
}

const keepReqHeader = (lower) => !NOISE_REQ_HEADERS.has(lower)
const keepResHeader = (lower) => KEEP_RES_HEADERS.has(lower) || lower.startsWith('x-')

/**
 * 美化前的一遍扫描：括号嵌套是否超过 max 层（字符串里的括号不算），以及同一个对象里有没有重复的键
 * （JSON.parse 只留最后一个值：美化后的文本会丢掉前面的值，不再是"无损"）。键按解码后的字符串比较。
 */
function scanJson(src, max) {
  const stack = [] // 对象 = 已见过的键；数组 = null
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    if (c === 0x22) {
      let j = i + 1
      while (j < src.length && src.charCodeAt(j) !== 0x22) j += src.charCodeAt(j) === 0x5c ? 2 : 1
      const top = stack[stack.length - 1]
      if (top instanceof Set) {
        let k = j + 1
        while (k < src.length && (src.charCodeAt(k) === 0x20 || src.charCodeAt(k) === 0x09 || src.charCodeAt(k) === 0x0a || src.charCodeAt(k) === 0x0d)) k++
        if (src.charCodeAt(k) === 0x3a) {
          let key
          const raw = src.slice(i + 1, j)
          // 没有转义的键直接比原文；有转义的解码后再比（同一个字母的转义写法与直接写法是同一个键）
          if (raw.indexOf(BACKSLASH) < 0) key = raw
          else try { key = JSON.parse(src.slice(i, j + 1)) } catch { key = raw }
          if (top.has(key)) return { deep: false, duplicate: true }
          top.add(key)
        }
      }
      i = j
    } else if (c === 0x7b || c === 0x5b) {
      stack.push(c === 0x7b ? new Set() : null)
      if (stack.length > max) return { deep: true, duplicate: false }
    } else if (c === 0x7d || c === 0x5d) stack.pop()
  }
  return { deep: false, duplicate: false }
}

/**
 * JSON 正文的无损美化 → { pretty, duplicate }：pretty 为 null 表示不美化（不是 JSON、环境不支持无损、嵌套太深，
 * 或有重复的键 —— 这时 duplicate=true，原样导出才不丢值）。
 */
function prettyJson(text, contentType) {
  const none = { pretty: null, duplicate: false }
  if (!HAS_RAW_JSON) return none
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!/json/i.test(contentType) && !/^\s*[[{]/.test(src)) return none
  const shape = scanJson(src, PRETTY_MAX_DEPTH)
  if (shape.deep) return none
  let parsed
  try {
    parsed = parseJsonLossless(src)
  } catch {
    return none
  }
  if (shape.duplicate) return { pretty: null, duplicate: true }
  try {
    return { pretty: JSON.stringify(parsed, null, 2), duplicate: false }
  } catch {
    return none
  }
}

/**
 * 一个正文写进 lines；返回 true 表示按 bodyLimit 截断了（真丢了字节才算）。
 * which = 'req' | 'res'：请求正文缺失 / 为空时不写（GET 没有正文是常态）；响应正文写明"未记录" / "（空）"。
 * 正文是空串但记录里的大小（bytes）大于 0 ⇒ 引擎没存（超过保存上限 / 解不了压缩），写明"未保存正文"，不说"（空）"。
 */
function renderBody(lines, which, body, { contentType, bodyLimit, redact, bytes }) {
  const label = which === 'req' ? '请求体' : '响应体'
  if (typeof body !== 'string') {
    if (which === 'res') lines.push('', `${label}：未记录`)
    return false
  }
  if (body === '') {
    if (finite(bytes) && bytes > 0) lines.push('', `${label}：（未保存正文，大小 ${Math.round(bytes)} 字节：捕获时超过保存上限或没能解码）`)
    else if (which === 'res') lines.push('', `${label}：（空）`)
    return false
  }
  if (HEX_BODY.test(body)) {
    const n = Math.floor((body.length - 4) / 2)
    lines.push('', `${label}：二进制，${n} 字节，已省略${n >= HEX_DUMP_CAP_BYTES ? '（捕获时只存了前 64 KB）' : ''}`)
    return false
  }
  const b64 = BASE64_BODY.exec(body)
  if (b64 !== null) {
    const data = b64[2]
    const n = Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0))
    lines.push('', `${label}：二进制${b64[1] !== '' ? `（${b64[1]}）` : ''}，${n} 字节，已省略`)
    return false
  }
  const capturedCut = body.endsWith(CAPTURE_TRUNCATED_MARK) || body.length >= STORE_FIELD_CAP
  let source = body
  if (redact && /application\/x-www-form-urlencoded/i.test(contentType)) source = redactQueryText(body)
  const origBytes = Buffer.byteLength(body, 'utf8')
  const srcBytes = source === body ? origBytes : Buffer.byteLength(source, 'utf8')
  // 截断按实际写出的文本判断：美化后放得下给美化的；放不下但原文放得下给原文（不丢字节）；都放不下才截
  const pj = srcBytes <= bodyLimit * 2 ? prettyJson(source, contentType) : null
  const pretty = pj === null ? null : pj.pretty
  const duplicate = pj !== null && pj.duplicate
  const prettyFits = pretty !== null && Buffer.byteLength(pretty, 'utf8') <= bodyLimit
  const raw = !prettyFits && srcBytes <= bodyLimit
  const shown = prettyFits || (pretty !== null && !raw) ? pretty : source
  const cut = !prettyFits && !raw
  // 没试着解析（原文超过 2×bodyLimit）的按 Content-Type 认；试过没解析成的就是文本
  const json = pretty !== null || duplicate || (srcBytes > bodyLimit * 2 && /json/i.test(contentType))
  const kind = json ? 'JSON' : '文本'
  const how = duplicate ? '，原样（有重复的键，美化会丢掉前面的值）' : raw && pretty !== null ? '，原样（美化后超过上限）' : ''
  lines.push('', `${label}（${kind}，${origBytes} 字节${cut ? `，只导出前 ${bodyLimit} 字节${duplicate ? how : ''}` : how}${capturedCut ? '，捕获时已截断' : ''}）：`)
  const text = cut ? `${cutUtf8(shown, bodyLimit)}\n…（截断，原长 ${origBytes} 字节）` : shown
  const fence = fenceFor(text)
  lines.push(`${fence}${json ? 'json' : 'text'}`, text, fence)
  return cut
}

// ------------------------------------------------------------------ 汇总

function nearestRank(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

function countBy(list, keyOf) {
  const map = new Map()
  for (const item of list) {
    const k = keyOf(item)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

function statusClassLine(records) {
  const order = ['1xx', '2xx', '3xx', '4xx', '5xx']
  const counts = new Map()
  for (const r of records) {
    const k = Number.isInteger(r.status) ? `${Math.floor(r.status / 100)}xx` : '无状态码'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = a === '无状态码' ? 99 : order.includes(a) ? order.indexOf(a) : 50
    const ib = b === '无状态码' ? 99 : order.includes(b) ? order.indexOf(b) : 50
    return ia - ib || (a < b ? -1 : a > b ? 1 : 0)
  })
  return keys.map((k) => `${k} ${counts.get(k)}`).join(' · ')
}

function endpointRows(entries) {
  const byKey = new Map()
  for (const e of entries) {
    const key = `${e.r.method} ${e.parts.path}`
    let row = byKey.get(key)
    if (row === undefined) {
      row = { key, count: 0, errors: 0, durations: [], bytes: [] }
      byKey.set(key, row)
    }
    row.count++
    if (isError(e.r)) row.errors++
    if (finite(e.r.durationMs)) row.durations.push(e.r.durationMs)
    if (finite(e.r.bytesRes)) row.bytes.push(e.r.bytesRes)
  }
  const rows = [...byKey.values()]
  for (const row of rows) row.durations.sort((a, b) => a - b)
  rows.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return rows
}

const avgOf = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)

/** 明细之前那几节里引用一条请求的写法：#N · 方法 路径 · 状态 · 耗时。 */
function refLine(e) {
  return `#${e.n} · ${inline(e.r.method)} ${code(capChars(e.parts.path, 200))} · ${statusText(e.r.status)} · ${finite(e.r.durationMs) ? `${Math.round(e.r.durationMs)} ms` : '耗时未知'}${e.parts.host !== '' ? ` · ${inline(e.parts.host)}` : ''}`
}

// ------------------------------------------------------------------ 过滤条件的人话

const FLAG_PARAMS = Object.freeze({
  flag: '只看已标记的记录',
  errors: '只看错误（状态码 ≥ 400）',
  noNoise: '隐藏静态资源 / 心跳请求',
})

/**
 * 面板快捷过滤栏的参数（GET /records 同名参数）→ 一条中文描述的数组；没有生效的条件时返回空数组。
 * params：URLSearchParams 或普通对象（布尔开关取 '1' / true）。conditions / filterId 不在这里描述（由调用方用 describeFilter 写）。
 */
export function describeQueryParams(params) {
  const get = (key) => {
    if (params instanceof URLSearchParams) return params.get(key)
    if (!isObj(params) || params[key] === undefined || params[key] === null) return null
    return params[key] === true ? '1' : params[key] === false ? '' : String(params[key])
  }
  const val = (key) => str(get(key)).trim()
  const parts = []
  const q = val('q')
  if (q !== '') parts.push(val('regex') === '1' ? `URL / 备注匹配正则 /${q}/i` : `URL / 备注包含 "${q}"`)
  const method = val('method').toUpperCase()
  if (method !== '' && method !== 'ALL') parts.push(`方法 = ${method}`)
  const status = val('status')
  if (status !== '') parts.push(`状态码 = ${status}`)
  const source = val('source')
  if (source !== '' && source !== 'all') parts.push(`来源 = ${source}`)
  const host = val('host')
  if (host !== '') parts.push(`域名 = ${host.split(',').map((h) => h.trim()).filter((h) => h !== '').join(' 或 ')}`)
  const ct = val('contentType')
  if (ct !== '') parts.push(`Content-Type 包含 ${ct.split(',').map((c) => c.trim()).filter((c) => c !== '').join(' 或 ')}`)
  const num = (key) => {
    const raw = val(key)
    const n = raw === '' ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const minDur = num('minDurationMs')
  if (minDur !== null) parts.push(`耗时 ≥ ${minDur} ms`)
  const minBytes = num('minBytes')
  if (minBytes !== null) parts.push(`响应 ≥ ${minBytes} 字节`)
  const maxBytes = num('maxBytes')
  if (maxBytes !== null) parts.push(`响应 ≤ ${maxBytes} 字节`)
  const fromTs = num('fromTs')
  if (fromTs !== null) parts.push(`时间 ≥ ${dateTimeOf(fromTs)}`)
  const toTs = num('toTs')
  if (toTs !== null) parts.push(`时间 ≤ ${dateTimeOf(toTs)}`)
  for (const [key, label] of [['sessionId', '会话'], ['traceId', 'traceId'], ['runId', 'runId']]) {
    const v = val(key)
    if (v !== '') parts.push(`${label} = ${v}`)
  }
  const bodyQ = val('bodyQ')
  if (bodyQ !== '') parts.push(`正文 / 头包含 "${bodyQ}"`)
  const caller = val('caller')
  if (caller !== '') parts.push(`调用方包含 "${caller}"`)
  for (const [key, label] of Object.entries(FLAG_PARAMS)) if (val(key) === '1') parts.push(label)
  return parts.map((p) => inline(p))
}

// ------------------------------------------------------------------ 入口

/**
 * 记录（任意顺序，通常是查询返回的新→旧）→ { markdown, truncatedBodies }。
 *   title          标题（默认「接口捕获 AI 分析包」）
 *   filterText     过滤条件的描述，多条用换行分隔（空 = 没有过滤）
 *   totalMatched   本次条件共匹配多少条（大于导出条数时写明"只导出了最新 N 条"）
 *   generatedAt    生成时间（epoch 毫秒，默认现在）
 *   bodyLimit      每个正文最多导出的字节数（默认 4096，0 = 不导出正文，最大 1 MB）
 *   redact         遮盖敏感请求头 / 查询参数（默认 false）
 *   realtimeProcess 实时日志记录没有进程名时用的客户端进程名（可选）
 */
function* digestSteps(records, {
  title,
  filterText,
  totalMatched,
  generatedAt,
  bodyLimit = AI_BODY_LIMIT_DEFAULT,
  redact = false,
  realtimeProcess = '',
} = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => isObj(r))
  const limitRaw = Number(bodyLimit)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 0), AI_BODY_LIMIT_MAX) : AI_BODY_LIMIT_DEFAULT
  const doRedact = redact === true
  const rtProcess = str(realtimeProcess).trim()
  const at = finite(generatedAt) ? generatedAt : (generatedAt instanceof Date && finite(generatedAt.getTime()) ? generatedAt.getTime() : Date.now())
  const heading = inline(str(title).trim()) || AI_DEFAULT_TITLE

  // 时间先后（ts 升序，同一毫秒按 id），编号从 1 开始；没有时间的排在最后
  const entries = list
    .map((r, i) => ({ r, i, ts: finite(r.ts) ? r.ts : (finite(Number(r.ts)) && r.ts !== null && r.ts !== '' ? Number(r.ts) : null) }))
    .sort((a, b) => {
      if (a.ts === null || b.ts === null) return a.ts === null && b.ts === null ? a.i - b.i : a.ts === null ? 1 : -1
      const ida = str(a.r.id)
      const idb = str(b.r.id)
      return a.ts - b.ts || (ida < idb ? -1 : ida > idb ? 1 : a.i - b.i)
    })
    .map((e, k) => ({ ...e, n: k + 1, parts: urlParts(e.r.url) }))

  // ---- 明细（先算：概况里要写截断了几个正文）
  let truncatedBodies = 0
  const detail = []
  for (const e of entries) {
    if (e.n % YIELD_EVERY_RECORDS === 0) yield
    const r = e.r
    const dur = finite(r.durationMs) ? `${Math.round(r.durationMs)} ms` : '耗时未知'
    detail.push('', `### #${e.n} ${inline(r.method)} ${code(displayUrl(r.url, doRedact))} → ${statusText(r.status)} · ${dur} · ${clockOf(e.ts)}`, '')
    const proc = processOf(r, rtProcess)
    const pid = Number.isInteger(r.clientPid) && r.clientPid >= 0 ? `（PID ${r.clientPid}）` : ''
    detail.push(`- 域名：${e.parts.host !== '' ? inline(e.parts.host) : '（无）'}`)
    detail.push(`- 进程：${proc !== '' ? inline(proc) + pid : `未知${pid}`}`)
    detail.push(`- 渠道：${channelLabel(channelOf(r))}`)
    if (typeof r.note === 'string' && r.note.trim() !== '') detail.push(`- 备注：${capChars(inline(r.note), NOTE_MAX)}`)
    const who = callerText(r.caller)
    if (who !== '') detail.push(`- 调用方：${who}`)
    const stack = stackText(r.caller)
    if (stack !== '') detail.push(`- 调用链：${stack}`)
    if (typeof r.ruleId === 'string' && r.ruleId !== '') detail.push(`- 命中规则：${inline(r.ruleId)}`)
    if (typeof r.tag === 'string' && r.tag !== '') detail.push(`- 标签：${capChars(inline(r.tag), NOTE_MAX)}`)
    if (r.flag === true || r.flag === 1) detail.push('- 已标记')
    const timing = []
    const ttfb = finite(r.firstByteMs) ? r.firstByteMs : (finite(r.ttfbMs) ? r.ttfbMs : null)
    if (ttfb !== null) timing.push(`首字节 ${Math.round(ttfb)} ms`)
    if (finite(r.connectMs)) timing.push(`建连 ${Math.round(r.connectMs)} ms`)
    if (finite(r.tlsMs)) timing.push(`TLS ${Math.round(r.tlsMs)} ms`)
    if (timing.length > 0) detail.push(`- 时序：${timing.join(' · ')}`)
    const sizes = []
    if (finite(r.bytesReq)) sizes.push(`请求 ${bytesText(r.bytesReq)}`)
    if (finite(r.bytesRes)) sizes.push(`响应 ${bytesText(r.bytesRes)}`)
    if (sizes.length > 0) detail.push(`- 大小：${sizes.join(' · ')}`)
    if (r.complete === false) detail.push('- 未完成（流中断或仍在进行）')
    if (isObj(r.ws)) {
      const ws = []
      if (finite(r.ws.msgCount)) ws.push(`消息 ${r.ws.msgCount} 条`)
      if (finite(r.ws.frameCount)) ws.push(`帧 ${r.ws.frameCount} 个`)
      if (r.ws.closeCode !== undefined && r.ws.closeCode !== null) ws.push(`关闭码 ${inline(r.ws.closeCode)}`)
      detail.push(`- WebSocket：${ws.length > 0 ? ws.join(' · ') : '有帧记录'}（帧内容不导出）`)
    }

    const query = queryPairs(e.parts.search)
    if (query.length > 0) {
      detail.push('', '查询参数：')
      for (const p of query) {
        const value = p.value === null ? '（无值）' : doRedact && isSensitiveQuery(p.name) ? MASK : (p.value === '' ? '（空）' : capChars(inline(p.value), QUERY_VALUE_MAX))
        detail.push(`- ${lead(p.name)} = ${value}`)
      }
    }
    const reqHeaders = headerLines(r.reqHeaders, keepReqHeader, doRedact)
    if (reqHeaders.length > 0) detail.push('', '请求头：', ...reqHeaders)
    if (limit > 0 && typeof r.reqBody === 'string' && r.reqBody.length > YIELD_BODY_CHARS) yield
    if (limit > 0 && renderBody(detail, 'req', r.reqBody, { contentType: contentTypeOf(r.reqHeaders, ''), bodyLimit: limit, redact: doRedact, bytes: r.bytesReq })) truncatedBodies++
    const resHeaders = headerLines(r.resHeaders, keepResHeader, doRedact)
    if (resHeaders.length > 0) detail.push('', '响应头：', ...resHeaders)
    if (limit > 0 && typeof r.resBody === 'string' && r.resBody.length > YIELD_BODY_CHARS) yield
    if (limit > 0 && renderBody(detail, 'res', r.resBody, { contentType: contentTypeOf(r.resHeaders, r.contentType), bodyLimit: limit, redact: doRedact, bytes: r.bytesRes })) truncatedBodies++
  }

  // ---- 概况
  const out = [`# ${heading}`, '']
  out.push(`> 本文件由接口捕获面板导出，供 AI 分析客户端的接口调用。时间均为本机时间（${utcOffsetOf(at)}）。`)
  out.push('> 结构：概况 → 接口汇总 → 最慢的请求 → 错误请求 → 请求明细（按时间先后编号 #1…#N，前面几节用编号引用明细）。', '')
  out.push('## 概况', '')
  out.push(`- 生成时间：${dateTimeOf(at)}`)
  const filterLines = str(filterText).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (filterLines.length === 0) out.push('- 过滤条件：无（库内全部记录）')
  else if (filterLines.length === 1) out.push(`- 过滤条件：${inline(filterLines[0])}`)
  else out.push('- 过滤条件：', ...filterLines.map((l) => `  - ${lead(l)}`))
  const matched = Number(totalMatched)
  const capped = Number.isFinite(matched) && matched > entries.length
  out.push(capped
    ? `- 记录数：只导出了最新 ${entries.length} 条，共匹配 ${Math.floor(matched)} 条（明细按时间先后排列）`
    : `- 记录数：${entries.length} 条`)
  if (entries.length === 0) {
    out.push('', '没有符合条件的记录。', '')
    return { markdown: out.join('\n'), truncatedBodies: 0 }
  }
  const times = entries.map((e) => e.ts).filter((t) => t !== null)
  if (times.length > 0) {
    const first = Math.min(...times)
    const last = Math.max(...times)
    out.push(`- 时间范围：${dateTimeOf(first)} → ${dateTimeOf(last)}（跨度 ${spanText(last - first)}）`)
  }
  out.push(`- 渠道：${countBy(entries, (e) => channelOf(e.r)).map(([k, n]) => `${channelLabel(k)} ${n}`).join(' · ')}`)
  out.push(`- 进程：${countBy(entries, (e) => processOf(e.r, rtProcess)).map(([k, n]) => `${k === '' ? '（未知）' : inline(k)} ${n}`).join(' · ')}`)
  const hosts = countBy(entries, (e) => e.parts.host)
  const hostsShown = hosts.slice(0, HOSTS_LISTED_MAX).map(([k, n]) => `${k === '' ? '（无域名）' : inline(k)} ${n}`)
  const hostsRest = hosts.slice(HOSTS_LISTED_MAX)
  out.push(`- 域名（${hosts.length} 个）：${hostsShown.join(' · ')}${hostsRest.length > 0 ? ` · 其余 ${hostsRest.length} 个共 ${hostsRest.reduce((a, [, n]) => a + n, 0)} 条` : ''}`)
  out.push(`- 状态码：${statusClassLine(entries.map((e) => e.r))}`)
  yield
  out.push(limit > 0
    ? `- 正文：每个正文最多导出 ${limit} 字节，超出的截断并写明原长（本次截断 ${truncatedBodies} 个）；二进制正文只写大小`
    : '- 正文：未导出（只有请求头 / 响应头）')
  out.push(doRedact
    ? '- 脱敏：已遮盖（值写成 ***）认证类请求头 / 响应头（Authorization、Cookie、Set-Cookie 等名单，以及名字带 token / auth / session / secret / cookie / key 等词的头）、URL 里的敏感查询参数（请求地址与 Referer / Location / Origin 等 URL 型头的值，含 # 片段）、表单正文里的同名字段；JSON 正文和其它头、备注、调用链未处理'
    : '- 脱敏：未脱敏（请求头、查询参数按原样导出）')

  // ---- 接口汇总
  const rows = endpointRows(entries)
  out.push('', `## 接口汇总（按 方法 + 路径 聚合，共 ${rows.length} 个接口）`, '')
  out.push('| 接口 | 次数 | 错误 | 平均 ms | P95 ms | 最大 ms | 平均响应大小 |', '|---|---:|---:|---:|---:|---:|---:|')
  for (const row of rows.slice(0, SUMMARY_ROWS_MAX)) {
    out.push(`| ${cell(capChars(row.key, 200))} | ${row.count} | ${row.errors} | ${msText(avgOf(row.durations))} | ${msText(nearestRank(row.durations, 0.95))} | ${msText(row.durations.length > 0 ? row.durations[row.durations.length - 1] : null)} | ${bytesText(avgOf(row.bytes))} |`)
  }
  if (rows.length > SUMMARY_ROWS_MAX) {
    const rest = rows.slice(SUMMARY_ROWS_MAX)
    out.push('', `其余 ${rest.length} 个接口（共 ${rest.reduce((a, r) => a + r.count, 0)} 次请求）未列出。`)
  }
  out.push('', '错误 = 状态码 ≥ 400 或没有状态码；P95 按最近秩法计算；"—" 表示没有该数据。')

  // ---- 最慢的请求
  const timed = entries.filter((e) => finite(e.r.durationMs)).sort((a, b) => b.r.durationMs - a.r.durationMs || a.n - b.n)
  out.push('', `## 最慢的 ${Math.min(SLOWEST_COUNT, timed.length)} 个请求`, '')
  if (timed.length === 0) out.push('（这些记录都没有耗时数据）')
  else timed.slice(0, SLOWEST_COUNT).forEach((e, k) => out.push(`${k + 1}. ${refLine(e)}`))

  // ---- 错误请求
  const errors = entries.filter((e) => isError(e.r))
  out.push('', `## 错误请求（状态码 ≥ 400 或没有状态码，共 ${errors.length} 条）`, '')
  if (errors.length === 0) out.push('（没有错误请求）')
  else {
    for (const e of errors.slice(0, ERRORS_LISTED_MAX)) out.push(`- ${refLine(e)}`)
    if (errors.length > ERRORS_LISTED_MAX) out.push(`- …另有 ${errors.length - ERRORS_LISTED_MAX} 条，见请求明细`)
  }

  // ---- 明细
  out.push('', `## 请求明细（${entries.length} 条，按时间先后）`)
  out.push(...detail)
  out.push('')
  return { markdown: out.join('\n'), truncatedBodies }
}

/** 同步生成（参数见上）；宿主里一次导出成千上万条时用 buildAiDigestAsync，别堵住事件循环。 */
export function buildAiDigest(records, options) {
  const it = digestSteps(records, options)
  let step = it.next()
  while (!step.done) step = it.next()
  return step.value
}

/**
 * 与 buildAiDigest 输出完全相同的异步版本：每约 100 条记录、以及格式化大正文之前让出一次事件循环（setImmediate），
 * 同进程里的代理 / 拦截流量和其它路由不会被一次大导出卡住几秒。
 */
export async function buildAiDigestAsync(records, options) {
  const it = digestSteps(records, options)
  let step = it.next()
  while (!step.done) {
    await new Promise((resolve) => setImmediate(resolve))
    step = it.next()
  }
  return step.value
}
