/**
 * 「改写」规则（Fiddler FiddlerScript / Charles Rewrite 的轻量版）：在**真实响应**上做定点修改，
 * 其余字段保持服务端原样 —— 比整包 mock 更适合"看客户端怎么渲染某种数据"。
 *
 * 脚本是逐行指令（# 或 // 开头为注释），编译成 ops 后存进规则；引擎按顺序执行：
 *
 *   set data.list = []          响应 JSON：设置字段（值按 JSON 解析，大整数 / 1.50 这类写法原样保留；解析不了就当字符串）
 *   del data.banner             响应 JSON：删除字段 / 数组元素
 *   replace 涨停 => 跌停         响应文本：全部替换，**永远按字面量**（replace /api/old/ => /api/new/ 换的就是这段路径）
 *   regex /\d+\.\d+/g => 0      响应文本：正则替换（/正则/标志；标志可用 d g i m s u v y，没写 g 自动补上；
 *                               正则中间的 / 写成 \/；新内容里可用 $1 / $& 引用匹配）
 *   status 500                  改响应状态码
 *   header X-Mock: 1            设响应头；header -Cache-Control 删响应头
 *   req.header Name: value      设请求头；req.header -Cookie 删请求头
 *   req.query key = value       设查询参数（新值做 URL 编码）；req.query -key 删查询参数
 *   req.set a.b = 1 / req.del a / req.replace x => y / req.regex /x/ => y   对请求体做同样的事
 *
 * 编译时就校验并报错（带行号，原样回给用户）：正则能否编译；头名是不是合法 HTTP token、头值是否只含 Latin-1 且没有
 * 换行 —— 否则要到流量里 res.writeHead 才抛错，客户端只会一直等到自己超时。
 * req.query 只动命中的那个参数，其余参数逐字节保持原样（GBK 编码的值、没有 = 的开关参数、原来的转义写法都不变）。
 *
 * JSON 路径：a.b[0].c、a["x.y"]、可选 $. 前缀。
 *
 * 正文编解码（文件末尾 decodeBody / encodeBody）：只有"解码后能原样编码回去"的正文才允许改，保证没改的字段逐字节不变。
 */

import { validateHeaderName, validateHeaderValue } from 'node:http'
import * as nodeBuffer from 'node:buffer'

/**
 * 无损 JSON：大整数（订单号/时间戳等超过 2^53 的数字）和 "1.50" 这类写法在 parse→stringify 后保持原文。
 * 依赖 JSON.parse 的 source 访问 + JSON.rawJSON（Node 21+）；没有就退回普通 JSON.parse。
 */
const HAS_RAW_JSON = typeof JSON.rawJSON === 'function' && typeof JSON.isRawJSON === 'function'
const isRawJson = (v) => HAS_RAW_JSON && v !== null && typeof v === 'object' && JSON.isRawJSON(v)
export function parseJsonLossless(text) {
  if (!HAS_RAW_JSON) return JSON.parse(text)
  return JSON.parse(text, (_key, value, ctx) => (
    typeof value === 'number' && ctx !== undefined && typeof ctx.source === 'string' && ctx.source !== String(value)
      ? JSON.rawJSON(ctx.source)
      : value
  ))
}

const PATH_TOKEN = /\s*(?:\.?([A-Za-z_$一-龥][\w$一-龥-]*)|\[\s*(\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\])/y

/**
 * 不允许出现在 JSON 路径里的键：沿 __proto__ / constructor / prototype 走下去会改到宿主进程的 Object.prototype
 * （导入的规则文件里一句 set __proto__.x = 1 就能污染整个进程）。编译时报错，执行时也拒绝（老规则文件里存的 ops）。
 */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// 只认字符串 / 数字段：别的类型（规则文件里手写的 [["__proto__"]] 之类）当属性键时会被转成字符串，一律按不安全处理
const isUnsafeKey = (k) => typeof k !== 'number' && (typeof k !== 'string' || UNSAFE_PATH_KEYS.has(k))
const unsafePathKey = (keys) => {
  const i = keys.findIndex(isUnsafeKey)
  return i < 0 ? undefined : (typeof keys[i] === 'string' ? keys[i] : typeof keys[i])
}

/** "a.b[0]['c']" → ['a','b',0,'c']；非法（含 __proto__ / constructor / prototype 段）返回 null。 */
export function parseJsonPath(expr) {
  const keys = tokenizeJsonPath(expr)
  return keys === null || unsafePathKey(keys) !== undefined ? null : keys
}

function tokenizeJsonPath(expr) {
  let s = String(expr ?? '').trim()
  if (s.startsWith('$')) s = s.slice(1)
  if (s.startsWith('.')) s = s.slice(1)
  if (s === '') return []
  const out = []
  PATH_TOKEN.lastIndex = 0
  let pos = 0
  while (pos < s.length) {
    PATH_TOKEN.lastIndex = pos
    const m = PATH_TOKEN.exec(s)
    if (m === null || m.index !== pos) return null
    if (m[1] !== undefined) out.push(m[1])
    else if (m[2] !== undefined) out.push(Number(m[2]))
    else if (m[3] !== undefined) out.push(m[3].replace(/\\(.)/g, '$1'))
    else out.push(m[4].replace(/\\(.)/g, '$1'))
    pos = PATH_TOKEN.lastIndex
  }
  return out
}

/** 按路径设值（中间缺的对象/数组自动补）；返回是否改动。 */
export function jsonSet(root, keys, value) {
  if (keys.length === 0) return { root: value, changed: true }
  if (unsafePathKey(keys) !== undefined) return { root, changed: false }
  let cur = root
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const nextIsIndex = typeof keys[i + 1] === 'number'
    if (cur === null || typeof cur !== 'object') return { root, changed: false }
    // 只沿自有属性往下走，绝不顺着原型链（继承来的 toString 之类当不存在，补成新对象）
    const child = Object.hasOwn(cur, k) ? cur[k] : undefined
    if (child === null || typeof child !== 'object' || isRawJson(child)) cur[k] = nextIsIndex ? [] : {}
    cur = cur[k]
  }
  if (cur === null || typeof cur !== 'object' || isRawJson(cur)) return { root, changed: false }
  cur[keys[keys.length - 1]] = value
  return { root, changed: true }
}

/** 按路径删除（数组元素用 splice，保持数组连续）；返回是否改动。 */
export function jsonDelete(root, keys) {
  if (keys.length === 0) return { root: null, changed: true }
  if (unsafePathKey(keys) !== undefined) return { root, changed: false }
  let cur = root
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, keys[i])) return { root, changed: false }
    cur = cur[keys[i]]
  }
  if (cur === null || typeof cur !== 'object' || isRawJson(cur)) return { root, changed: false }
  const last = keys[keys.length - 1]
  if (Array.isArray(cur) && typeof last === 'number') {
    if (last >= cur.length) return { root, changed: false }
    cur.splice(last, 1)
    return { root, changed: true }
  }
  if (!Object.hasOwn(cur, last)) return { root, changed: false }
  delete cur[last]
  return { root, changed: true }
}

/** 把 JSON 里所有数组清空（保留外壳字段 code/message 等）——"成功但没有数据"的空态。 */
export function emptyAllArrays(value) {
  if (isRawJson(value)) return value
  if (Array.isArray(value)) return []
  if (value !== null && typeof value === 'object') {
    const out = {}
    // 定义成自有属性：JSON 里合法的 "__proto__" 键用赋值会改掉 out 的原型（键也就丢了）
    for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value: emptyAllArrays(v), enumerable: true, writable: true, configurable: true })
    return out
  }
  return value
}

// ----------------------------------------------------------------- HTTP 头校验

const HEADER_NAME_HINT = "只能用字母、数字和 !#$%&'*+-.^_`|~，不能有空格、冒号、中文等字符"

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0')
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 头值里第一个让 Node 拒绝写出的字符（与 http.validateHeaderValue 同一规则：只允许 Tab、0x20–0x7E、0x80–0xFF）。 */
function badHeaderValueReason(v) {
  for (const ch of v) {
    const cp = ch.codePointAt(0)
    if (cp === 0x09 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0x80 && cp <= 0xff)) continue
    if (cp === 0x0a || cp === 0x0d) return '含有换行符（头的值不能换行）'
    if (cp > 0xff) return `含有 "${ch}"（U+${hex4(cp)}）这类超出 Latin-1 的字符——头的值只能放 Latin-1 文本，中文等请先做 URL 编码`
    return `含有控制字符 U+${hex4(cp)}`
  }
  return '含有不允许的字符'
}

/**
 * HTTP 头名 / 值校验（编译改写脚本、保存 mock / Map Local 的头、断点改头时用）：合法返回 null，否则返回一句中文原因。
 * 规则与 Node 真正写头时一致（http.validateHeaderName / validateHeaderValue），错在保存时报，
 * 而不是到流量里 res.writeHead 抛 ERR_INVALID_CHAR / ERR_INVALID_HTTP_TOKEN、客户端一直等到超时。
 * value 可以是字符串、数字（布尔）或它们的数组（数组 = 同名头写多行，如 Set-Cookie）；null / 对象不行。
 * @param {string} name
 * @param {unknown} value
 * @param {{ label?: string }} [opts]  label 只影响措辞（默认 "HTTP 头"；编译脚本时用 "响应头" / "请求头"）
 * @returns {string|null}
 */
export function validateHeader(name, value, { label = 'HTTP 头' } = {}) {
  if (typeof name !== 'string' || name.trim() === '') return `${label}名为空`
  try {
    validateHeaderName(name)
  } catch {
    return `${label}名 "${clip(name)}" 不合法：${HEADER_NAME_HINT}`
  }
  const values = Array.isArray(value) ? value : [value]
  for (const v of values) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return `${label} ${name} 的值必须是字符串或数字`
    const s = String(v)
    try {
      validateHeaderValue(name, s)
    } catch {
      return `${label} ${name} 的值不合法：${badHeaderValueReason(s)}`
    }
  }
  return null
}

// ----------------------------------------------------------------- 编译

/**
 * set 的值 → JSON 源文本：能按 JSON 解析就保留原文（执行时无损解析，大整数 / 1.50 不丢精度），解析不了就当字符串。
 * 存源文本而不是解析结果：规则文件是按普通 JSON.parse 读回来的，解析结果里的大整数读回时会被四舍五入，原文不会。
 */
function valueJsonOf(text) {
  const t = String(text ?? '').trim()
  if (t === '') return '""'
  try {
    parseJsonLossless(t)
    return t
  } catch {
    return JSON.stringify(t)
  }
}

/** replace / req.replace：永远按字面量查找（第一个 => 之前是查找内容，之后是新内容）。 */
function parseReplace(rest, lineNo, cmd) {
  const idx = rest.indexOf('=>')
  if (idx < 0) throw new Error(`第 ${lineNo} 行：${cmd} 需要 "旧 => 新"`)
  const find = rest.slice(0, idx).trim()
  const replace = rest.slice(idx + 2).trim()
  if (find === '') throw new Error(`第 ${lineNo} 行：${cmd} 的查找内容为空`)
  return { find, regex: false, replace }
}

/**
 * regex / req.regex："/正则/标志 => 新内容"。正则在第一个未转义、不在 [...] 里的 / 处结束，
 * 所以正则里可以写 \/、[/] 和 =>。标志校验后自动补 g（全部替换）。
 */
function parseRegex(rest, lineNo, cmd) {
  const r = rest.trim()
  const usage = `第 ${lineNo} 行：${cmd} 写法是 "${cmd} /正则/标志 => 新内容"`
  if (!r.startsWith('/')) throw new Error(usage)
  let end = -1
  let inClass = false
  for (let i = 1; i < r.length; i++) {
    const ch = r[i]
    if (ch === '\\') { i++; continue }
    if (inClass) { if (ch === ']') inClass = false; continue }
    if (ch === '[') { inClass = true; continue }
    if (ch === '/') { end = i; break }
  }
  if (end < 0) throw new Error(`${usage}（正则缺少结尾的 /）`)
  const pattern = r.slice(1, end)
  if (pattern === '') throw new Error(`第 ${lineNo} 行：${cmd} 的正则为空`)
  const m = /^([A-Za-z]*)\s*=>/.exec(r.slice(end + 1))
  if (m === null) throw new Error(`${usage}（结尾的 / 后面只能跟标志再写 =>；正则中间的 / 要写成 \\/）`)
  let flags = m[1]
  if (!/^[dgimsuvy]*$/.test(flags)) throw new Error(`第 ${lineNo} 行：正则标志 "${flags}" 无效（可用 d g i m s u v y；正则中间的 / 要写成 \\/）`)
  if (!flags.includes('g')) flags += 'g'
  try {
    new RegExp(pattern, flags) // 编译期校验
  } catch (e) {
    throw new Error(`第 ${lineNo} 行：正则无效 ${e instanceof Error ? e.message : e}`)
  }
  return { find: pattern, flags, regex: true, replace: r.slice(end + 1 + m[0].length).trim() }
}

function parseHeader(rest, lineNo, phase) {
  const label = phase === 'req' ? '请求头' : '响应头'
  const r = rest.trim()
  if (r.startsWith('-')) {
    const name = r.slice(1).trim()
    if (name === '') throw new Error(`第 ${lineNo} 行：header - 后要给头名`)
    const err = validateHeader(name, '', { label })
    if (err !== null) throw new Error(`第 ${lineNo} 行：${err}`)
    return { op: 'header-remove', name }
  }
  const idx = r.indexOf(':')
  if (idx <= 0) throw new Error(`第 ${lineNo} 行：header 写法是 "Name: value" 或 "-Name"`)
  const name = r.slice(0, idx).trim()
  const value = r.slice(idx + 1).trim()
  const err = validateHeader(name, value, { label })
  if (err !== null) throw new Error(`第 ${lineNo} 行：${err}`)
  return { op: 'header-set', name, value }
}

/** 编译用：语法错返回 null（由调用方报"路径无效"）；含 __proto__ / constructor / prototype 直接抛带行号的错。 */
function compilePath(pathText, lineNo) {
  const keys = tokenizeJsonPath(pathText)
  const bad = keys === null ? undefined : unsafePathKey(keys)
  if (bad !== undefined) throw new Error(`第 ${lineNo} 行：JSON 路径不能含 "${bad}"（__proto__ / constructor / prototype 会改到宿主进程的对象原型）："${String(pathText).trim()}"`)
  return keys
}

function parseAssign(rest, lineNo, what) {
  const idx = rest.indexOf('=')
  const pathText = idx < 0 ? '' : rest.slice(0, idx).trim()
  if (idx < 0 || pathText === '') throw new Error(`第 ${lineNo} 行：${what} 写法是 "路径 = 值"`)
  const keys = compilePath(pathText, lineNo)
  if (keys === null) throw new Error(`第 ${lineNo} 行：JSON 路径无效 "${pathText}"`)
  const valueJson = valueJsonOf(rest.slice(idx + 1))
  // value 只给展示 / 旧版本用（大整数在这里可能已被四舍五入），执行一律用 valueJson
  return { path: keys, value: JSON.parse(valueJson), valueJson }
}

/**
 * 编译改写脚本 → ops。语法错误抛 Error（带行号），由调用方原样回给用户。
 * op: { phase:'req'|'res', op, path?, value?, valueJson?, find?, replace?, regex?, flags?, name? }
 * （regex 指令也编成 op:'replace'，靠 regex:true 区分，与旧规则文件里存的 op 兼容。）
 */
export function compileRewriteScript(script) {
  const ops = []
  const lines = String(script ?? '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('//')) return
    const sp = line.search(/\s/)
    const head = (sp < 0 ? line : line.slice(0, sp)).toLowerCase()
    const rest = sp < 0 ? '' : line.slice(sp + 1)
    const phase = head.startsWith('req.') ? 'req' : 'res'
    const cmd = head.startsWith('req.') ? head.slice(4) : head.startsWith('res.') ? head.slice(4) : head
    switch (cmd) {
      case 'set': {
        const a = parseAssign(rest, lineNo, head)
        ops.push({ phase, op: 'json-set', path: a.path, value: a.value, valueJson: a.valueJson })
        break
      }
      case 'del':
      case 'delete': {
        const keys = compilePath(rest, lineNo)
        if (keys === null || keys.length === 0) throw new Error(`第 ${lineNo} 行：del 需要 JSON 路径`)
        ops.push({ phase, op: 'json-delete', path: keys })
        break
      }
      case 'replace':
        ops.push({ phase, op: 'replace', ...parseReplace(rest, lineNo, head) })
        break
      case 'regex':
        ops.push({ phase, op: 'replace', ...parseRegex(rest, lineNo, head) })
        break
      case 'status': {
        if (phase === 'req') throw new Error(`第 ${lineNo} 行：请求没有状态码`)
        const n = Number(rest.trim())
        if (!Number.isInteger(n) || n < 100 || n > 599) throw new Error(`第 ${lineNo} 行：状态码要在 100–599 之间`)
        ops.push({ phase, op: 'status', value: n })
        break
      }
      case 'header':
        ops.push({ phase, ...parseHeader(rest, lineNo, phase) })
        break
      case 'query': {
        if (phase !== 'req') throw new Error(`第 ${lineNo} 行：query 只能用在请求上（req.query）`)
        const r = rest.trim()
        if (r.startsWith('-')) {
          const name = r.slice(1).trim()
          if (name === '') throw new Error(`第 ${lineNo} 行：req.query - 后要给参数名`)
          ops.push({ phase, op: 'query-remove', name })
        } else {
          const idx = r.indexOf('=')
          if (idx <= 0) throw new Error(`第 ${lineNo} 行：req.query 写法是 "key = value" 或 "-key"`)
          ops.push({ phase, op: 'query-set', name: r.slice(0, idx).trim(), value: r.slice(idx + 1).trim() })
        }
        break
      }
      default:
        throw new Error(`第 ${lineNo} 行：不认识的指令 "${head}"（可用 set / del / replace / regex / status / header / req.header / req.query / req.set / req.del / req.replace / req.regex）`)
    }
  })
  return ops
}

// ----------------------------------------------------------------- 执行

function headerKey(headers, name) {
  const want = String(name).toLowerCase()
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return k
  return null
}

function applyTextOp(text, op) {
  if (op.regex) return text.replace(new RegExp(op.find, op.flags), op.replace)
  return text.split(op.find).join(op.replace)
}

/** set 要写入的值：新规则从 valueJson 无损解析（每次都是新对象）；旧规则文件里只有 value。 */
function setValueOf(op) {
  if (typeof op.valueJson === 'string') return parseJsonLossless(op.valueJson)
  try {
    return structuredClone(op.value)
  } catch {
    return op.value
  }
}

/** 宽松的百分号解码（只用来比较参数名）：+ 当空格；整段解不开（如 GBK 的 %D6%D0）就按连续的 %XX 分段解，解不开的段原样保留。 */
function looseDecode(s) {
  const t = s.replace(/\+/g, ' ')
  if (!t.includes('%')) return t
  try {
    return decodeURIComponent(t)
  } catch {
    return t.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
  }
}

/**
 * 在原始查询串上逐个参数改：按 & 切开，参数名解码后比较（解不开就比原文），只改 / 删命中的参数，
 * 其余参数逐字节保持原样（GBK 编码的值、没有 = 的开关参数、原来的转义写法都不动），#片段原样保留。
 * set：改第一个同名参数的值并去掉后面的同名参数，没有就追加到末尾；新值用 encodeURIComponent 编码。
 * remove：删掉全部同名参数。返回 { path, hit }；没有实际改动时 path 就是原串。
 */
function editQuery(pathAndQuery, op) {
  const hashAt = pathAndQuery.indexOf('#')
  const fragment = hashAt < 0 ? '' : pathAndQuery.slice(hashAt)
  const head = hashAt < 0 ? pathAndQuery : pathAndQuery.slice(0, hashAt)
  const qAt = head.indexOf('?')
  const base = qAt < 0 ? head : head.slice(0, qAt)
  const query = qAt < 0 ? '' : head.slice(qAt + 1)
  const name = String(op.name ?? '')
  const value = String(op.value ?? '')
  const out = []
  let hit = false
  let changed = false
  for (const pair of query === '' ? [] : query.split('&')) {
    const eq = pair.indexOf('=')
    const rawName = eq < 0 ? pair : pair.slice(0, eq)
    if (pair === '' || !(rawName === name || looseDecode(rawName) === name)) { out.push(pair); continue }
    if (op.op === 'query-remove' || hit) { hit = true; changed = true; continue }
    hit = true
    const next = `${rawName}=${encodeURIComponent(value)}`
    if (next !== pair) changed = true
    out.push(next)
  }
  if (op.op === 'query-set' && !hit) {
    out.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    changed = true
  }
  if (!changed) return { path: pathAndQuery, hit }
  const qs = out.join('&')
  return { path: (qs === '' ? base : `${base}?${qs}`) + fragment, hit }
}

const LOOKS_LIKE_REGEX = /^\/.+\/[a-z]*$/

/**
 * 对一个报文（请求或响应）执行同 phase 的 ops。
 * @param {object[]} ops
 * @param {{ headers: object, bodyText: string|null, status?: number, path?: string }} msg  bodyText=null 表示二进制/不可解码（跳过正文类 op）
 * @returns {{ headers, bodyText, status, path, bodyChanged, notes: string[] }}
 */
export function applyOps(ops, msg) {
  const headers = { ...(msg.headers ?? {}) }
  let bodyText = msg.bodyText
  let status = msg.status
  let pathAndQuery = msg.path
  let bodyChanged = false
  const notes = []
  let json
  let jsonState = 'unparsed' // unparsed | ok | bad
  let jsonDirty = false
  let jsonBom = ''
  const ensureJson = () => {
    if (jsonState !== 'unparsed') return jsonState === 'ok'
    if (typeof bodyText !== 'string') { jsonState = 'bad'; return false }
    // 带 BOM 的正文（decodeBody 会把 U+FEFF 留在文本里，好逐字节还原）：解析时去掉，写回时再带上
    jsonBom = bodyText.charCodeAt(0) === 0xfeff ? '\uFEFF' : ''
    try {
      json = parseJsonLossless(jsonBom === '' ? bodyText : bodyText.slice(1))
      jsonState = 'ok'
    } catch {
      jsonState = 'bad'
    }
    return jsonState === 'ok'
  }
  // 只有 JSON 真被改过才重新序列化：没命中的 set / del 不该把原文的空白、\u 转义等写法改掉
  const flushJson = () => {
    if (jsonState === 'ok' && jsonDirty) bodyText = jsonBom + JSON.stringify(json)
    jsonState = 'unparsed'
    jsonDirty = false
  }
  for (const op of ops) {
    switch (op.op) {
      case 'json-set':
      case 'json-delete': {
        const what = op.op === 'json-set' ? 'set' : 'del'
        if (!Array.isArray(op.path)) { notes.push(`${what} 跳过：JSON 路径无效`); break }
        if (unsafePathKey(op.path) !== undefined) { notes.push(`${what} 跳过：JSON 路径不能含 __proto__ / constructor / prototype`); break }
        if (!ensureJson()) { notes.push(`${what} 跳过：正文不是 JSON`); break }
        let r
        if (op.op === 'json-set') {
          let value
          try {
            value = setValueOf(op)
          } catch {
            notes.push(`set 跳过：值不是合法 JSON：${op.path.join('.')}`)
            break
          }
          r = jsonSet(json, op.path, value)
        } else {
          r = jsonDelete(json, op.path)
        }
        json = r.root
        if (r.changed) { bodyChanged = true; jsonDirty = true } else notes.push(`${what} 未命中：${op.path.join('.')}`)
        break
      }
      case 'replace': {
        flushJson()
        const what = op.regex ? 'regex' : 'replace'
        if (typeof bodyText !== 'string') { notes.push(`${what} 跳过：正文不是文本`); break }
        let next
        try {
          next = applyTextOp(bodyText, op)
        } catch (e) {
          notes.push(`${what} 跳过：${e instanceof Error ? e.message : e}`)
          break
        }
        if (next !== bodyText) {
          bodyText = next
          bodyChanged = true
        } else if (op.regex) {
          notes.push(`regex 未命中：/${op.find}/${op.flags ?? ''}`)
        } else {
          const hint = LOOKS_LIKE_REGEX.test(op.find) ? '（replace 只按字面量匹配；要用正则请写 regex /…/ => …）' : ''
          notes.push(`replace 未命中：${op.find}${hint}`)
        }
        break
      }
      case 'status':
        status = op.value
        break
      case 'header-set': {
        // 编译时已校验；这里再挡一次旧规则文件里存下的非法头，免得 writeHead / http.request 抛错
        const err = validateHeader(op.name, op.value, { label: op.phase === 'req' ? '请求头' : '响应头' })
        if (err !== null) { notes.push(`header 跳过：${err}`); break }
        const k = headerKey(headers, op.name)
        if (k !== null) delete headers[k]
        headers[op.name] = op.value
        break
      }
      case 'header-remove': {
        const k = headerKey(headers, op.name)
        if (k !== null) delete headers[k]
        break
      }
      case 'query-set':
      case 'query-remove': {
        if (typeof pathAndQuery !== 'string') break
        const r = editQuery(pathAndQuery, op)
        pathAndQuery = r.path
        if (op.op === 'query-remove' && !r.hit) notes.push(`req.query 未命中：-${op.name}`)
        break
      }
      default:
        break
    }
  }
  flushJson()
  return { headers, bodyText, status, path: pathAndQuery, bodyChanged, notes }
}

// ----------------------------------------------------------------- 文本编解码
//
// 改正文的前提是 字节 → 文本 → 改 → 字节 之后，**没改的部分逐字节不变**。所以：
//   decodeBody 只接受无损往返（encode(decode(buf)) 与 buf 逐字节相同），否则 ok:false —— 宁可不改，也不把没动的字段改坏；
//   encodeBody 遇到目标编码表示不了的字符：JSON 正文写成 \uXXXX 转义（星位字符写成代理对，JSON 语义不变），其它正文直接失败。
// 选编码：正文以 BOM 开头时以 BOM 为准（.NET 的 StreamReader / HttpContent 读正文也是 BOM 优先）；其次 Content-Type 的 charset；
// 没声明（或声明了不认识的）就猜：合法 UTF-8 → utf-8，否则 GB18030、GBK 里往返无损的那个。
//   - iso-8859-1 / latin1 / us-ascii 按真正的逐字节 latin1（TextDecoder 把这些标签当 windows-1252，0x80–0x9F 会改写不回去）；
//   - utf-8 保留 BOM（ignoreBOM：U+FEFF 留在文本里，写回时原样带上）；
//   - gb18030 支持四字节形式（BMP 的四字节区 + U+10000 以上），gbk 只有单/双字节，€ 按 GBK/CP936 写成 0x80；
//   - 其它 WHATWG 编码（windows-125x / iso-8859-x / big5 / shift_jis / euc-kr …）用从解码器反推的通用表。
// 编码表都从 TextDecoder 反推（与解码器天然一致），第一次用到才建、建好缓存在模块里，之后是 O(1) 查表：
//   GBK/GB18030 双字节表 23940 项、GB18030 四字节 BMP 表 39420 项，各一次批量解码，合计约 5–10 ms；
//   通用双字节表（big5 / shift_jis / euc-kr / euc-jp）逐对反推约 15 ms，单字节表 < 1 ms。

const isUtf8 = typeof nodeBuffer.isUtf8 === 'function'
  ? nodeBuffer.isUtf8
  : (buf) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf)
        return true
      } catch {
        return false
      }
    }
const isAscii = typeof nodeBuffer.isAscii === 'function'
  ? nodeBuffer.isAscii
  : (buf) => {
      for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) return false
      return true
    }
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g')
const isWellFormed = typeof String.prototype.isWellFormed === 'function' ? (s) => s.isWellFormed() : (s) => !LONE_SURROGATE.test(s)

function toBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (typeof buf === 'string') return Buffer.from(buf, 'utf8')
  return Buffer.alloc(0)
}

/** JSON 转义：BMP 写成 \uXXXX，星位字符写成代理对。 */
function jsonEscape(cp) {
  if (cp < 0x10000) return `\\u${hex4(cp).toLowerCase()}`
  const v = cp - 0x10000
  return `\\u${hex4(0xd800 + (v >> 10)).toLowerCase()}\\u${hex4(0xdc00 + (v & 0x3ff)).toLowerCase()}`
}

function unencodableReason(cp, codecName) {
  if (cp >= 0xd800 && cp <= 0xdfff) return `含有不成对的代理项 U+${hex4(cp)}，无法用 ${codecName} 编码`
  return `字符 "${String.fromCodePoint(cp)}"（U+${hex4(cp)}）无法用 ${codecName} 编码`
}

/** 可增长的字节缓冲（避免大正文按数字数组攒字节）。 */
class ByteSink {
  constructor(size) {
    this.buf = Buffer.allocUnsafe(Math.max(64, size))
    this.len = 0
  }

  reserve(n) {
    if (this.len + n <= this.buf.length) return
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.len + n))
    this.buf.copy(next, 0, 0, this.len)
    this.buf = next
  }

  byte(b) {
    this.reserve(1)
    this.buf[this.len++] = b
  }

  pair(a, b) {
    this.reserve(2)
    this.buf[this.len++] = a
    this.buf[this.len++] = b
  }

  quad(a, b, c, d) {
    this.reserve(4)
    this.buf[this.len++] = a
    this.buf[this.len++] = b
    this.buf[this.len++] = c
    this.buf[this.len++] = d
  }

  ascii(s) {
    this.reserve(s.length)
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i)
  }

  result() {
    return this.len === this.buf.length ? this.buf : Buffer.from(this.buf.subarray(0, this.len))
  }
}

/** 按码点逐个编码；mapCp(cp, sink) 返回 false 表示这个字符在目标编码里表示不了。 */
function encodeByCodePoint(text, codecName, mapCp, json) {
  const sink = new ByteSink(text.length + 16)
  let escaped = 0
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    if (mapCp(cp, sink)) continue
    if (!json) return { ok: false, reason: unencodableReason(cp, codecName) }
    sink.ascii(jsonEscape(cp))
    escaped++
  }
  return { ok: true, buf: sink.result(), escaped }
}

/** decode 再 encode，与原字节逐字节相同才算无损。 */
function roundTrip(buf, decode, encode) {
  const text = decode(buf)
  const r = encode(text, false)
  return r.ok && r.buf.equals(buf) ? text : null
}

/**
 * @typedef {object} Codec
 * @property {string} name  规范名：utf-8 / utf-16le / utf-16be / iso-8859-1 / gbk / gb18030 / 其它 WHATWG 名（windows-1252、shift_jis …）
 * @property {(buf: Buffer) => string} decode  普通解码（可能有损：坏字节变 U+FFFD）
 * @property {(buf: Buffer) => (string|null)} decodeLossless  无损解码：往返不一致返回 null
 * @property {(text: string, json: boolean) => ({ ok: true, buf: Buffer, escaped: number }|{ ok: false, reason: string })} encode
 */

let utf8Decoder = null
const UTF8 = Object.freeze({
  name: 'utf-8',
  decode: (buf) => (utf8Decoder ??= new TextDecoder('utf-8', { ignoreBOM: true })).decode(buf),
  // 合法 UTF-8 ⇔ 往返无损（BOM 以 U+FEFF 留在文本里）
  decodeLossless: (buf) => (isUtf8(buf) ? UTF8.decode(buf) : null),
  encode(text, json) {
    if (isWellFormed(text)) return { ok: true, buf: Buffer.from(text, 'utf8'), escaped: 0 }
    // UTF-8 写不出的只有不成对的代理项
    if (!json) return { ok: false, reason: unencodableReason(LONE_SURROGATE.exec(text)[0].charCodeAt(0), 'utf-8') }
    let escaped = 0
    const fixed = text.replace(LONE_SURROGATES, (s) => { escaped++; return jsonEscape(s.charCodeAt(0)) })
    return { ok: true, buf: Buffer.from(fixed, 'utf8'), escaped }
  },
})

function utf16Codec(name, bigEndian) {
  let dec = null
  const toBytes = (text) => {
    const b = Buffer.from(text, 'utf16le')
    return bigEndian ? b.swap16() : b
  }
  const codec = {
    name,
    decode: (buf) => (dec ??= new TextDecoder(name, { ignoreBOM: true })).decode(buf),
    decodeLossless: (buf) => roundTrip(buf, codec.decode, codec.encode),
    encode: (text) => ({ ok: true, buf: toBytes(text), escaped: 0 }),
  }
  return Object.freeze(codec)
}
const UTF16LE = utf16Codec('utf-16le', false)
const UTF16BE = utf16Codec('utf-16be', true)

const NON_LATIN1 = /[^\x00-\xff]/
const latin1Map = (cp, sink) => {
  if (cp > 0xff) return false
  sink.byte(cp)
  return true
}
const LATIN1 = Object.freeze({
  name: 'iso-8859-1',
  decode: (buf) => buf.toString('latin1'),
  decodeLossless: (buf) => buf.toString('latin1'), // 256 个字节与 U+0000–U+00FF 一一对应，永远无损
  encode(text, json) {
    if (!NON_LATIN1.test(text)) return { ok: true, buf: Buffer.from(text, 'latin1'), escaped: 0 }
    return encodeByCodePoint(text, 'iso-8859-1', latin1Map, json)
  },
})

// GB18030 指针：双字节 23940 个（lead 0x81–0xFE × trail 0x40–0xFE，跳过 0x7F）；
// 四字节 b1 0x81–0xFE、b2 0x30–0x39、b3 0x81–0xFE、b4 0x30–0x39，指针 0–39419 是 BMP 区（81 30 81 30 … 84 31 A4 39），
// 189000 起是 U+10000–U+10FFFF（指针 = 189000 + 码点 − 0x10000）。
const GB_BMP_POINTERS = 39420
const GB_ASTRAL_BASE = 189000

let gbTables = null
/** 码点 → 双字节（lead<<8 | trail）/ 四字节 BMP 指针 + 1；0 = 没有。第一次用到才建（约 5–10 ms）。 */
function gbTablesGet() {
  if (gbTables !== null) return gbTables
  const two = new Uint16Array(0x10000)
  const four = new Uint16Array(0x10000)
  const pairs = new Uint8Array(23940 * 2)
  let n = 0
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      pairs[n++] = lead
      pairs[n++] = trail
    }
  }
  // 同一码点有多种写法时取第一个（指针最小的），与 WHATWG 编码器的 index pointer 一致
  decodeEach(pairs, 2, (i, cp) => { if (two[cp] === 0) two[cp] = (pairs[i * 2] << 8) | pairs[i * 2 + 1] })
  const quads = new Uint8Array(GB_BMP_POINTERS * 4)
  for (let p = 0; p < GB_BMP_POINTERS; p++) quads.set(gbPointerBytes(p), p * 4)
  // 双字节能表示的码点仍写双字节（WHATWG：先查双字节索引，查不到才用四字节区）
  decodeEach(quads, 4, (p, cp) => { if (two[cp] === 0 && four[cp] === 0) four[cp] = p + 1 })
  gbTables = { two, four }
  return gbTables
}

function gbPointerBytes(pointer) {
  let p = pointer
  const b4 = p % 10
  p = (p - b4) / 10
  const b3 = p % 126
  p = (p - b3) / 126
  const b2 = p % 10
  const b1 = (p - b2) / 10
  return [0x81 + b1, 0x30 + b2, 0x81 + b3, 0x30 + b4]
}

/**
 * seq 是一串等宽的完整 GB18030 序列：一次批量解码（fatal，出错就整体抛），每个序列应正好解成一个 BMP 字符；
 * 对不上（解码器行为异常）才退回逐个解码。回调 (序号, 码点)，ASCII / 代理项不进表。
 */
function decodeEach(seq, width, put) {
  const count = seq.length / width
  const accept = (i, cp) => { if (cp >= 0x80 && (cp < 0xd800 || cp > 0xdfff)) put(i, cp) }
  let text = null
  try {
    text = new TextDecoder('gb18030', { fatal: true }).decode(seq)
  } catch {
    text = null
  }
  if (text !== null && text.length === count) {
    for (let i = 0; i < count; i++) accept(i, text.charCodeAt(i))
    return
  }
  const dec = new TextDecoder('gb18030', { fatal: true })
  for (let i = 0; i < count; i++) {
    let s
    try {
      s = dec.decode(seq.subarray(i * width, (i + 1) * width))
    } catch {
      continue
    }
    if (s.length === 1) accept(i, s.charCodeAt(0))
  }
}

function gbkMap(tables) {
  return (cp, sink) => {
    if (cp < 0x80) { sink.byte(cp); return true }
    if (cp === 0x20ac) { sink.byte(0x80); return true } // GBK/CP936 的 € 是单字节 0x80（WHATWG gbk 编码器同）
    if (cp > 0xffff) return false
    const v = tables.two[cp]
    if (v === 0) return false
    sink.pair(v >> 8, v & 0xff)
    return true
  }
}

function gb18030Map(tables) {
  return (cp, sink) => {
    if (cp < 0x80) { sink.byte(cp); return true }
    let pointer
    if (cp <= 0xffff) {
      const v = tables.two[cp]
      if (v !== 0) { sink.pair(v >> 8, v & 0xff); return true }
      const p = tables.four[cp]
      if (p === 0) return false // 不成对的代理项、少数没有映射的私用区码点（如 U+E5E5）
      pointer = p - 1
    } else {
      pointer = GB_ASTRAL_BASE + (cp - 0x10000)
    }
    const [a, b, c, d] = gbPointerBytes(pointer)
    sink.quad(a, b, c, d)
    return true
  }
}

function gbCodec(name) {
  let dec = null
  let map = null
  const codec = {
    name,
    // WHATWG 里 gbk 与 gb18030 共用同一个解码器（也认四字节序列），区别只在编码器
    decode: (buf) => (dec ??= new TextDecoder('gb18030')).decode(buf),
    decodeLossless: (buf) => (isAscii(buf) ? buf.toString('latin1') : roundTrip(buf, codec.decode, codec.encode)),
    encode(text, json) {
      map ??= name === 'gbk' ? gbkMap(gbTablesGet()) : gb18030Map(gbTablesGet())
      return encodeByCodePoint(text, name, map, json)
    },
  }
  return Object.freeze(codec)
}
const GBK = gbCodec('gbk')
const GB18030 = gbCodec('gb18030')

// 其它 WHATWG 编码：单字节表逐字节反推；这几个双字节编码再逐对（lead 0x80–0xFF × trail 0x40–0xFF）反推。
// euc-jp 的三字节序列（0x8F 开头）、iso-2022-jp 的转义序列不在表里 —— 含这些的正文往返不一致，decodeBody 会拒绝。
const DOUBLE_BYTE = new Set(['big5', 'shift_jis', 'euc-kr', 'euc-jp'])

/** 码点 → 字节：值 0–0xFF 是单字节，≥ 0x8000 是双字节（lead<<8 | trail）；BMP 用定长数组（-1 = 没有），星位用 Map。 */
function buildGenericTable(dec, doubleByte) {
  const bmp = new Int32Array(0x10000).fill(-1)
  const astral = new Map()
  const put = (s, v) => {
    if (s.length === 0) return
    const cp = s.codePointAt(0)
    if (s.length !== (cp > 0xffff ? 2 : 1) || cp === 0xfffd || (cp >= 0xd800 && cp <= 0xdfff)) return
    if (cp > 0xffff) { if (!astral.has(cp)) astral.set(cp, v) } else if (bmp[cp] < 0) bmp[cp] = v
  }
  for (let b = 0; b < 0x100; b++) put(dec.decode(Uint8Array.of(b)), b)
  if (doubleByte) {
    for (let lead = 0x80; lead <= 0xff; lead++) {
      for (let trail = 0x40; trail <= 0xff; trail++) put(dec.decode(Uint8Array.of(lead, trail)), (lead << 8) | trail)
    }
  }
  return { bmp, astral }
}

const genericCodecs = new Map()
function genericCodec(encoding) {
  const cached = genericCodecs.get(encoding)
  if (cached !== undefined) return cached
  const dec = new TextDecoder(encoding)
  let table = null
  const map = (cp, sink) => {
    const v = cp > 0xffff ? (table.astral.get(cp) ?? -1) : table.bmp[cp]
    if (v < 0) return false
    if (v > 0xff) sink.pair(v >> 8, v & 0xff)
    else sink.byte(v)
    return true
  }
  const codec = Object.freeze({
    name: encoding,
    decode: (buf) => dec.decode(buf),
    decodeLossless: (buf) => roundTrip(buf, codec.decode, codec.encode),
    encode(text, json) {
      table ??= buildGenericTable(dec, DOUBLE_BYTE.has(encoding))
      return encodeByCodePoint(text, encoding, map, json)
    },
  })
  genericCodecs.set(encoding, codec)
  return codec
}

const aliasesOf = (target, labels) => labels.map((l) => [l, target])
const CHARSET_ALIASES = new Map([
  ...aliasesOf('utf-8', ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8']),
  ...aliasesOf('gbk', ['gbk', 'gb2312', 'cp936', 'ms936', 'x-mswin-936', 'x-gbk', 'windows-936', 'csgb2312', 'chinese', 'csiso58gb231280', 'gb_2312', 'gb_2312-80', 'iso-ir-58', 'euc-cn']),
  ['gb18030', 'gb18030'],
  ...aliasesOf('iso-8859-1', ['iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'latin1', 'l1', 'iso-ir-100', 'csisolatin1', 'ibm819', 'cp819',
    'us-ascii', 'ascii', 'ansi_x3.4-1968', 'iso-ir-6', 'iso646-us', 'csascii', 'cp367', 'ibm367']),
  ...aliasesOf('windows-1252', ['windows-1252', 'cp1252', 'x-cp1252']),
  ...aliasesOf('utf-16le', ['utf-16', 'utf-16le', 'ucs-2', 'unicode', 'unicodefeff', 'iso-10646-ucs-2', 'csunicode']),
  ...aliasesOf('utf-16be', ['utf-16be', 'unicodefffe']),
])

const normalizeCharset = (label) => {
  const l = String(label).trim().toLowerCase()
  return CHARSET_ALIASES.get(l) ?? l
}

const CHARSET_PARAM = /(?:^|[;\s])charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,"']+))/i

/**
 * Content-Type → 规范化的 charset 标签；**没声明返回 null**（由 decodeBody 去猜）。
 * utf8 → utf-8；gb2312 / cp936 / x-gbk / windows-936 / csgb2312 … → gbk；gb18030 单列；
 * latin1 / iso-8859-1 / iso8859-1 / l1 / us-ascii / ascii … → iso-8859-1（真正的逐字节 latin1）；cp1252 → windows-1252；
 * utf-16 / utf-16le → utf-16le；utf-16be；其它标签原样（小写）。
 */
export function charsetOf(contentType) {
  const m = CHARSET_PARAM.exec(String(contentType ?? ''))
  if (m === null) return null
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  return raw === '' ? null : normalizeCharset(raw)
}

function resolveCodec(label) {
  switch (label) {
    case 'utf-8': return UTF8
    case 'utf-16le': return UTF16LE
    case 'utf-16be': return UTF16BE
    case 'iso-8859-1': return LATIN1
    case 'gbk': return GBK
    case 'gb18030': return GB18030
    default: break
  }
  let encoding
  try {
    encoding = new TextDecoder(label).encoding // 不认识的标签 / replacement 编码会抛 RangeError
  } catch {
    return null
  }
  if (encoding === 'utf-8') return UTF8
  if (encoding === 'utf-16le') return UTF16LE
  if (encoding === 'utf-16be') return UTF16BE
  if (encoding === 'gbk') return GBK
  if (encoding === 'gb18030') return GB18030
  return genericCodec(encoding)
}

const codecCache = new Map()
/**
 * charset 标签（或 decodeBody 给的 codec）→ codec，供 encodeBody 用（例如按声明的 gbk 回 mock 正文）。
 * null / '' = 没声明 → utf-8；不支持的标签返回 null。
 * @returns {Codec|null}
 */
export function codecFor(charset) {
  if (charset === null || charset === undefined) return UTF8
  if (typeof charset === 'object' && typeof charset.encode === 'function' && typeof charset.decodeLossless === 'function') return charset
  const label = normalizeCharset(charset)
  if (label === '') return UTF8
  if (codecCache.has(label)) return codecCache.get(label)
  const codec = resolveCodec(label)
  if (codecCache.size < 64) codecCache.set(label, codec)
  return codec
}

function bomCodecOf(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return UTF8
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE
  return null
}

function decodeWithCharset(bytes, declared) {
  const declaredCodec = declared === null ? null : codecFor(declared)
  const candidates = []
  const bom = bomCodecOf(bytes)
  if (bom !== null) candidates.push(bom)
  if (declaredCodec !== null) candidates.push(declaredCodec)
  else candidates.push(UTF8, GB18030, GBK)
  const tried = new Set()
  for (const codec of candidates) {
    if (tried.has(codec)) continue
    tried.add(codec)
    const text = codec.decodeLossless(bytes)
    if (text !== null) return { ok: true, text, codec, declared, sniffed: codec !== declaredCodec }
  }
  let reason
  if (declaredCodec !== null) reason = `按 ${declaredCodec.name} 解码后无法原样编码回去（正文含该编码下无效或有多种写法的字节）`
  else if (declared !== null) reason = `不认识的字符集 ${declared}，按 UTF-8 / GB18030 / GBK 也都无法无损解码`
  else reason = '没声明 charset，正文既不是合法 UTF-8，也无法按 GB18030 / GBK 无损解码'
  return { ok: false, reason, declared }
}

/**
 * 正文字节 → 文本。**只有能原样编码回去时**才 ok:true（encode(decode(buf)) 与 buf 逐字节相同），
 * 这样改写后没动的字段一个字节都不变；拿 codec 交给 encodeBody 编回去。
 * 编码选择：BOM（EF BB BF / FF FE / FE FF）优先；其次 Content-Type 声明的 charset；
 * 没声明或声明了不认识的：合法 UTF-8 → utf-8，否则依次试 GB18030、GBK（都要求往返无损）。
 * @param {Buffer|Uint8Array} buf
 * @param {string} contentType
 * @returns {{ ok: true, text: string, codec: Codec, declared: string|null, sniffed: boolean }
 *   | { ok: false, reason: string, declared: string|null }}  sniffed=true 表示用的不是声明的编码（BOM / 猜测）
 */
export function decodeBody(buf, contentType) {
  return decodeWithCharset(toBuffer(buf), charsetOf(contentType))
}

/**
 * 文本 → 字节（codec 来自 decodeBody / codecFor，也可直接给 charset 标签；null = utf-8）。
 * 目标编码表示不了的字符：json:true 时写成 \uXXXX 转义（星位字符写成代理对），escaped = 转义的字符数；否则失败。
 * @returns {{ ok: true, buf: Buffer, escaped: number } | { ok: false, reason: string }}
 */
export function encodeBody(text, codec, { json = false } = {}) {
  const c = codecFor(codec)
  if (c === null) return { ok: false, reason: `不支持的字符集 ${String(codec)}` }
  return c.encode(typeof text === 'string' ? text : String(text ?? ''), json === true)
}

/** 是否按文本处理（JSON / text / xml / js / form）。 */
export function isTextual(contentType, buf) {
  const ct = String(contentType ?? '').toLowerCase()
  if (/json|text\/|xml|javascript|x-www-form-urlencoded|html/.test(ct)) return true
  if (ct !== '') return false
  // 没声明类型：看前 512 字节有没有控制字符
  const n = Math.min(buf.length, 512)
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0 || (c < 9) || (c > 13 && c < 32)) return false
  }
  return true
}

/** 旧接口（兼容）：按 charset 解码（null = utf-8），坏字节会变 U+FFFD，不保证无损 —— 新代码用 decodeBody。 */
export function decodeText(buf, charset) {
  return (codecFor(charset) ?? UTF8).decode(toBuffer(buf))
}

/** 旧接口（兼容）：按 charset 编回字节；编不了（或不支持的 charset）退回 utf-8 并返回实际编码 —— 新代码用 encodeBody。 */
export function encodeText(text, charset) {
  const s = String(text ?? '')
  const codec = codecFor(charset)
  if (codec !== null) {
    const r = codec.encode(s, false)
    if (r.ok) return { buf: r.buf, charset: codec.name }
  }
  return { buf: Buffer.from(s, 'utf8'), charset: 'utf-8' }
}
