/**
 * dsh-postman — 声明式断言与变量提取的求值（规格与校验在 workspace.mjs）。
 *
 * 不跑用户脚本：断言是「来源 + 路径 + 比较方式 + 期望值」四元组，提取是「来源 + 路径 → 变量」。
 * 好处是安全（宿主里不执行任意 JS）、可存盘、agent 也能直接读写。
 *
 * JSON 路径写法：`data.list[0].code`、`$.data.total`、`data["a.b"]`、`list[-1]`（最后一个）、
 * `data.list.length`（数组/字符串长度）；空路径或 `$` 表示整个响应体。
 */
import { JSON_TYPES } from './workspace.mjs'

// ------------------------------------------------------------------ JSON path

/** 解析路径为段数组（字符串键或整数下标）。不合法时抛 Error。 */
export function parsePath(path) {
  let s = String(path ?? '').trim()
  if (s === '' || s === '$') return []
  if (s.startsWith('$')) s = s.slice(1)
  const segs = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '.') {
      i += 1
      continue
    }
    if (c === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) throw new Error(`路径里的 [ 没有闭合：${path}`)
      const inner = s.slice(i + 1, close).trim()
      if (/^-?\d+$/.test(inner)) segs.push(Number(inner))
      else if (/^(['"]).*\1$/.test(inner)) segs.push(inner.slice(1, -1))
      else if (inner === '') throw new Error(`路径里有空的 []：${path}`)
      else segs.push(inner)
      i = close + 1
      continue
    }
    let j = i
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j += 1
    segs.push(s.slice(i, j))
    i = j
  }
  return segs
}

/** 取值：{ found, value }。`length` 段在数组/字符串上取长度（对象自己有 length 字段时取字段）。 */
export function getPath(root, path) {
  const segs = Array.isArray(path) ? path : parsePath(path)
  let cur = root
  for (const seg of segs) {
    if (cur === null || cur === undefined) return { found: false }
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return { found: false }
      const idx = seg < 0 ? cur.length + seg : seg
      if (idx < 0 || idx >= cur.length) return { found: false }
      cur = cur[idx]
      continue
    }
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      const idx = Number(seg)
      if (idx >= cur.length) return { found: false }
      cur = cur[idx]
      continue
    }
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length
      continue
    }
    if (typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg]
      continue
    }
    return { found: false }
  }
  return { found: true, value: cur }
}

// ------------------------------------------------------------------ helpers

const OP_LABEL = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  contains: '包含', notContains: '不包含', regex: '匹配', exists: '存在', notExists: '不存在',
  empty: '为空', notEmpty: '非空', type: '类型是', in: '属于',
}

function show(value, max = 200) {
  let s
  if (value === undefined) s = '(不存在)'
  else if (typeof value === 'string') s = JSON.stringify(value)
  else {
    try {
      s = JSON.stringify(value)
    } catch {
      s = String(value)
    }
  }
  return s.length > max ? s.slice(0, max) + '…' : s
}

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function isEmpty(v) {
  if (v === null || v === undefined || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

/**
 * 期望值的「宽松相等」：期望值能解析成 JSON 就按值比；不加引号时再退一步比字符串形式
 * （实际 "0" 对期望 0 算相等；写成 "0" 带引号才要求必须是字符串）。
 */
function looseEqual(actual, expectedText) {
  const t = String(expectedText ?? '')
  let parsed
  let isJson = false
  try {
    parsed = JSON.parse(t)
    isJson = true
  } catch {
    isJson = false
  }
  if (isJson && deepEqual(actual, parsed)) return true
  const quoted = /^\s*".*"\s*$/.test(t)
  if (quoted) return false
  if (actual !== null && typeof actual === 'object') return false
  return String(actual) === t.trim() || String(actual) === t
}

function textOf(v) {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function compareNumber(op, actual, expected) {
  const a = Number(actual)
  const b = Number(expected)
  if (!Number.isFinite(a)) return { pass: false, error: `实际值不是数字：${show(actual)}` }
  if (!Number.isFinite(b)) return { pass: false, error: `期望值不是数字：${expected}` }
  const pass = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
  return { pass }
}

function applyOp(op, actual, found, expected, missing = '路径不存在') {
  switch (op) {
    case 'exists':
      return { pass: found && actual !== undefined }
    case 'notExists':
      return { pass: !found }
    case 'empty':
      return found ? { pass: isEmpty(actual) } : { pass: false, error: missing }
    case 'notEmpty':
      return found ? { pass: !isEmpty(actual) } : { pass: false, error: missing }
  }
  if (!found) return { pass: false, error: missing }
  switch (op) {
    case 'eq':
      return { pass: looseEqual(actual, expected) }
    case 'ne':
      return { pass: !looseEqual(actual, expected) }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumber(op, actual, expected)
    case 'contains':
    case 'notContains': {
      let has
      if (Array.isArray(actual)) has = actual.some((x) => looseEqual(x, expected))
      else if (actual !== null && typeof actual === 'object') has = Object.prototype.hasOwnProperty.call(actual, expected)
      else has = textOf(actual).includes(expected)
      return { pass: op === 'contains' ? has : !has }
    }
    case 'regex':
      try {
        return { pass: new RegExp(expected).test(textOf(actual)) }
      } catch (error) {
        return { pass: false, error: '正则不合法：' + (error instanceof Error ? error.message : String(error)) }
      }
    case 'type': {
      const want = String(expected).trim()
      if (!JSON_TYPES.includes(want)) return { pass: false, error: `类型只能是 ${JSON_TYPES.join('/')}` }
      return { pass: typeOf(actual) === want }
    }
    case 'in': {
      const options = String(expected).split(',').map((x) => x.trim()).filter((x) => x !== '')
      return { pass: options.some((o) => looseEqual(actual, o)) }
    }
    default:
      return { pass: false, error: `不认识的比较方式 ${op}` }
  }
}

function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return { found: false }
  const n = String(name).toLowerCase()
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === n) return { found: true, value: String(v) }
  return { found: false }
}

/** 惰性解析 JSON 响应体（解析一次，所有断言共用）。 */
function jsonOf(ctx) {
  if (ctx.jsonState === undefined) {
    try {
      ctx.jsonState = { ok: true, value: JSON.parse(ctx.response?.body ?? '') }
    } catch (error) {
      ctx.jsonState = { ok: false, error: '响应体不是 JSON' + (ctx.response?.truncated ? '（已截断，可能被截在半中间）' : '') + '：' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  return ctx.jsonState
}

/** 断言的一句话描述，如「data.code = 0」「状态码 属于 200,201」。 */
export function describeAssert(a) {
  const op = OP_LABEL[a.op] ?? a.op
  const needsValue = !['exists', 'notExists', 'empty', 'notEmpty'].includes(a.op)
  const value = needsValue ? (a.source === 'duration' ? `${a.value}ms` : a.op === 'regex' ? `/${a.value}/` : a.value === '' ? '""' : a.value) : ''
  const subject = a.source === 'status' ? '状态码'
    : a.source === 'duration' ? '耗时'
      : a.source === 'header' ? `响应头 ${a.path}`
        : a.source === 'body' ? '响应体'
          : a.path === '' || a.path === '$' ? '$' : a.path
  return [subject, op, value].filter((x) => x !== '').join(' ')
}

// ------------------------------------------------------------------ evaluation

/**
 * 求值一组断言。ctx = { response, resolve? }（response 是 http.mjs 的结果；resolve 把期望值里的 {{变量}} 换掉）。
 * 返回 [{ index, desc, pass, actual, error? }]；停用的断言不返回。desc 里是替换后的期望值。
 */
export function evaluateAsserts(asserts, ctx) {
  const out = []
  const response = ctx.response ?? {}
  ;(asserts ?? []).forEach((spec, index) => {
    if (spec.enabled === false) return
    const a = typeof ctx.resolve === 'function' && typeof spec.value === 'string' && spec.value.includes('{{') ? { ...spec, value: ctx.resolve(spec.value) } : spec
    const desc = describeAssert(a)
    if (response.ok !== true) {
      out.push({ index, desc, pass: false, actual: '', error: '请求没有拿到响应：' + (response.error || '未知错误') })
      return
    }
    let found = true
    let actual
    let note
    if (a.source === 'status') actual = response.status
    else if (a.source === 'duration') actual = response.durationMs
    else if (a.source === 'header') {
      const h = headerValue(response.headers, a.path)
      found = h.found
      actual = h.value
    } else if (a.source === 'body') {
      actual = response.body ?? ''
      if (response.truncated) note = '响应体已截断，只对收到的部分求值'
    } else {
      const j = jsonOf(ctx)
      if (!j.ok) {
        out.push({ index, desc, pass: false, actual: '', error: j.error })
        return
      }
      try {
        const r = getPath(j.value, a.path)
        found = r.found
        actual = r.value
      } catch (error) {
        out.push({ index, desc, pass: false, actual: '', error: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    // status / duration / body 永远「存在」；header 用 exists/notExists 判断有没有这个头
    const missing = a.source === 'header' ? `响应里没有 ${a.path} 头` : `路径 ${a.path || '$'} 不存在`
    const r = applyOp(a.op, actual, found, a.value, missing)
    out.push({ index, desc, pass: r.pass === true, actual: found ? show(actual) : '(不存在)', ...(r.error ? { error: r.error } : {}), ...(note ? { note } : {}) })
  })
  return out
}

/**
 * 求值一组提取。返回 [{ index, var, scope, ok, value?, error? }]；停用的不返回。
 * 取到的值一律转成字符串（对象/数组转 JSON）。
 */
export function evaluateExtract(extract, ctx) {
  const out = []
  const response = ctx.response ?? {}
  ;(extract ?? []).forEach((x, index) => {
    if (x.enabled === false) return
    const base = { index, var: x.var, scope: x.scope }
    if (response.ok !== true) {
      out.push({ ...base, ok: false, error: '请求没有拿到响应' })
      return
    }
    if (x.source === 'status') {
      out.push({ ...base, ok: true, value: String(response.status) })
      return
    }
    if (x.source === 'header') {
      const h = headerValue(response.headers, x.path)
      out.push(h.found ? { ...base, ok: true, value: h.value } : { ...base, ok: false, error: `响应里没有 ${x.path} 头` })
      return
    }
    if (x.source === 'body') {
      let m
      try {
        m = new RegExp(x.path).exec(response.body ?? '')
      } catch (error) {
        out.push({ ...base, ok: false, error: '正则不合法：' + (error instanceof Error ? error.message : String(error)) })
        return
      }
      out.push(m ? { ...base, ok: true, value: m[1] !== undefined ? m[1] : m[0] } : { ...base, ok: false, error: `响应体里没匹配到 /${x.path}/` })
      return
    }
    const j = jsonOf(ctx)
    if (!j.ok) {
      out.push({ ...base, ok: false, error: j.error })
      return
    }
    let r
    try {
      r = getPath(j.value, x.path)
    } catch (error) {
      out.push({ ...base, ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!r.found || r.value === undefined) {
      out.push({ ...base, ok: false, error: `路径 ${x.path || '$'} 不存在` })
      return
    }
    out.push({ ...base, ok: true, value: typeof r.value === 'string' ? r.value : textOf(r.value) })
  })
  return out
}

/** 一次请求的结论：error（没拿到响应）/ fail / pass / unchecked（没有启用的断言）。 */
export function verdictOf(response, assertResults) {
  if (!response || response.ok !== true) return 'error'
  if (assertResults.length === 0) return 'unchecked'
  return assertResults.every((r) => r.pass) ? 'pass' : 'fail'
}
