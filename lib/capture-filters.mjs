/**
 * 抓包记录的自定义过滤器（Fiddler 式「条件构造器」）：字段 / 比较方式定义、校验、编译成谓词、
 * 一句话描述、命名过滤器的存储与导入导出。
 *
 * 同一份实现给三处用：宿主插件（面板路由与 DSH 工具）、MCP server、查询 worker 线程。
 * 依赖只允许 Node 内置模块与 ./env-fallback.mjs（而且只有 realtimeProcessName() 会调用它），
 * 这样 worker 线程 import 本文件时不会带进宿主专用的东西。
 *
 *   Filter    = { id, name, mode: 'all' | 'any', conditions: Condition[], createdAt, updatedAt }
 *   Condition = { id, enabled, field, op, value, caseSensitive, header? }
 *
 * 匹配语义（与 capture-store.mjs 的 F-046 同一个原则：未知不能证明满足条件）：
 *   · 停用的条件不参与；没有启用条件的过滤器匹配全部。mode 'all' = 全部成立，'any' = 至少一条成立。
 *   · 文本比较默认不区分大小写（ECMAScript 正则 i 标志的大小写折叠，预编译，不逐条转小写）；正则默认带 i 标志、
 *     从不带 u 标志（用户会直接贴 .NET / Fiddler 风格的正则）。缺失的文本字段按 '' 比较，
 *     所以「不包含 / 不等于 / 不匹配正则」在字段缺失时成立，「包含」不成立。值本身可以是 ''（普通字符串语义）。
 *   · 数字比较要求记录里的值是有限数字，否则该条件不成立。文本比较也可用于数字字段（比较 String(值)）。
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envOr } from './env-fallback.mjs'

const MAX_NAME = 80
const MAX_CONDITIONS = 50
const MAX_VALUE = 2000
const MAX_REGEX = 1000
const MAX_HEADER_NAME = 200
const MAX_FILTERS = 200
const MAX_ID = 128

/** 命名过滤器存放在捕获库目录下的这个文件里：{ version: 1, filters: Filter[] }。 */
export const FILTERS_FILE = 'capture-filters.json'
/** exportFilters() 信封的 format 字段。 */
export const FILTERS_FORMAT = 'dsh-api-visualizer/filters'
/** 校验用的上限（面板可以拿来提示用户）。 */
export const FILTER_LIMITS = Object.freeze({
  name: MAX_NAME, conditions: MAX_CONDITIONS, value: MAX_VALUE, regex: MAX_REGEX, header: MAX_HEADER_NAME, filters: MAX_FILTERS,
})

const EMPTY_DESCRIPTION = '（无条件，匹配全部）'
/** RFC 9110 token：合法的 HTTP 头名。 */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const freezeAll = (list) => Object.freeze(list.map((item) => Object.freeze(item.kinds ? { ...item, kinds: Object.freeze(item.kinds) } : { ...item })))

/** 可过滤的字段（顺序即面板下拉框的顺序）。kind 决定可用的比较方式；header:true 的字段可以再填一个头名。 */
export const FILTER_FIELDS = freezeAll([
  { id: 'url', label: 'URL', kind: 'text', hint: '完整 URL（协议、域名、路径与查询参数）' },
  { id: 'host', label: '域名', kind: 'text', hint: '主机名，小写，不含端口' },
  { id: 'path', label: '路径', kind: 'text', hint: 'URL 的路径部分，不含查询参数' },
  { id: 'query', label: '查询参数', kind: 'text', hint: '? 后面的查询串（不含 ?，不解码）' },
  { id: 'method', label: '方法', kind: 'text', hint: 'GET / POST …' },
  { id: 'status', label: '状态码', kind: 'number', hint: 'HTTP 状态码；没有响应的记录为空' },
  { id: 'process', label: '进程', kind: 'text', hint: '发起请求的进程名（不含 .exe）；实时捕获的记录按配置的客户端进程名（DSH_UI_PROC_NAME）算' },
  { id: 'channel', label: '捕获渠道', kind: 'text', hint: 'realtime（实时捕获）/ intercept（透明拦截）/ local-proxy（本地代理）/ import（导入）/ agent（工具写入），或记录自带的其他来源' },
  { id: 'contentType', label: 'Content-Type', kind: 'text', hint: '响应的 Content-Type' },
  { id: 'durationMs', label: '耗时 ms', kind: 'number', hint: '总耗时，毫秒' },
  { id: 'bytesRes', label: '响应大小', kind: 'number', hint: '响应体字节数' },
  { id: 'bytesReq', label: '请求大小', kind: 'number', hint: '请求体字节数' },
  { id: 'pid', label: '进程 PID', kind: 'number', hint: '发起请求的进程 PID' },
  { id: 'reqHeader', label: '请求头', kind: 'text', header: true, hint: '填了头名就比较这个请求头的值；不填就比较全部请求头（每行一个「名称: 值」）' },
  { id: 'resHeader', label: '响应头', kind: 'text', header: true, hint: '填了头名就比较这个响应头的值；不填就比较全部响应头（每行一个「名称: 值」）' },
  { id: 'reqBody', label: '请求体', kind: 'text', hint: '请求体文本' },
  { id: 'resBody', label: '响应体', kind: 'text', hint: '响应体文本' },
  { id: 'note', label: '备注', kind: 'text', hint: '记录的备注' },
  { id: 'caller', label: '调用方', kind: 'text', hint: '调用方归因：ViewModel、View、接口方法、触发方式、调用栈' },
  { id: 'tag', label: '标签', kind: 'text', hint: '记录的标签' },
])

/**
 * 比较方式。kinds = 它属于哪类比较：文本比较 ['text']、数字比较 ['number']、有值 / 为空两类都算。
 * 另外**文本比较也能用在数字字段上**（比较 String(值)），所以「能不能用」看 opAllowed()，不只看 kinds。
 */
export const FILTER_OPS = freezeAll([
  { id: 'contains', label: '包含', kinds: ['text'], needsValue: true },
  { id: 'notContains', label: '不包含', kinds: ['text'], needsValue: true },
  { id: 'equals', label: '等于', kinds: ['text'], needsValue: true },
  { id: 'notEquals', label: '不等于', kinds: ['text'], needsValue: true },
  { id: 'startsWith', label: '开头是', kinds: ['text'], needsValue: true },
  { id: 'endsWith', label: '结尾是', kinds: ['text'], needsValue: true },
  { id: 'regex', label: '匹配正则', kinds: ['text'], needsValue: true },
  { id: 'notRegex', label: '不匹配正则', kinds: ['text'], needsValue: true },
  { id: 'eq', label: '=', kinds: ['number'], needsValue: true },
  { id: 'ne', label: '≠', kinds: ['number'], needsValue: true },
  { id: 'gt', label: '>', kinds: ['number'], needsValue: true },
  { id: 'gte', label: '≥', kinds: ['number'], needsValue: true },
  { id: 'lt', label: '<', kinds: ['number'], needsValue: true },
  { id: 'lte', label: '≤', kinds: ['number'], needsValue: true },
  { id: 'exists', label: '有值', kinds: ['text', 'number'], needsValue: false },
  { id: 'notExists', label: '为空', kinds: ['text', 'number'], needsValue: false },
])

const FIELD_BY_ID = new Map(FILTER_FIELDS.map((field) => [field.id, field]))
const OP_BY_ID = new Map(FILTER_OPS.map((op) => [op.id, op]))
const TEXT_OPS = new Set(['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'regex', 'notRegex'])
const NUMBER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])
const FIELD_IDS = FILTER_FIELDS.map((field) => field.id).join('、')

// 宽松识别（agent 手写条件时常见的写法）：字段 / 比较方式的 id 不区分大小写，也认面板上的中文标签。
const FIELD_ALIASES = new Map()
for (const field of FILTER_FIELDS) {
  FIELD_ALIASES.set(field.id.toLowerCase(), field)
  FIELD_ALIASES.set(field.label.toLowerCase(), field)
}
const OP_ALIASES = new Map()
for (const op of FILTER_OPS) {
  OP_ALIASES.set(op.id.toLowerCase(), op.id)
  OP_ALIASES.set(op.label.toLowerCase(), op.id)
}
OP_ALIASES.set('>=', 'gte')
OP_ALIASES.set('<=', 'lte')
// 「=」「!=」这类符号按字段类型解析：文本字段 → equals / notEquals，数字字段 → eq / ne。
const EQUAL_SYMBOLS = new Set(['=', '==', '==='])
const NOT_EQUAL_SYMBOLS = new Set(['≠', '!=', '!==', '<>'])

function resolveField(raw) {
  if (typeof raw !== 'string') return null
  return FIELD_ALIASES.get(raw.trim().toLowerCase()) ?? null
}

function resolveOp(raw, field) {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (EQUAL_SYMBOLS.has(key)) return field?.kind === 'number' ? 'eq' : 'equals'
  if (NOT_EQUAL_SYMBOLS.has(key)) return field?.kind === 'number' ? 'ne' : 'notEquals'
  return OP_ALIASES.get(key.toLowerCase()) ?? null
}

/** 这个比较方式能不能用在这个字段上：kinds 对得上，或者文本比较用在数字字段上。 */
function opAllowed(op, field) {
  return op.kinds.includes(field.kind) || (field.kind === 'number' && op.kinds.includes('text'))
}

function opIdsFor(field) {
  return FILTER_OPS.filter((op) => opAllowed(op, field)).map((op) => op.id).join('、')
}

// ---------------------------------------------------------------- 小工具

function filterError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra)
}
const invalid = (message, extra) => filterError('FILTER_INVALID', message, extra)

function codePointLength(text) {
  let length = 0
  for (const _ of text) length++
  return length
}

function clip(text, max, ellipsis = '…') {
  if (text.length <= max) return text
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('') + ellipsis
}

/** 报错信息里引用用户输入：单行、截短。 */
function shown(value) {
  if (value === undefined || value === null || value === '') return '（空）'
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'object') { try { text = JSON.stringify(value) } catch { text = String(value) } }
  else text = String(value)
  return clip(text.replace(/[\r\n]+/g, ' '), 60)
}

const isFalse = (value) => value === false || value === 0 || (typeof value === 'string' && value.trim().toLowerCase() === 'false')
const isTrue = (value) => value === true || value === 1 || (typeof value === 'string' && value.trim().toLowerCase() === 'true')

function cleanId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  return text !== '' && text.length <= MAX_ID && !CONTROL_CHARS.test(text) ? text : ''
}

/** 名称：控制字符（换行、制表符…）换成空格，再去首尾空白；中间的空格原样保留。 */
function cleanName(raw) {
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

const nameKey = (name) => name.toLowerCase()

function timeOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 进程名统一成「不带目录、不带 .exe」。 */
function cleanProcessName(value) {
  if (typeof value !== 'string') return ''
  const base = value.trim().split(/[\\/]/).pop() ?? ''
  return base.replace(/\.exe$/i, '').trim()
}

// ---------------------------------------------------------------- 正则

/**
 * 正则：默认带 i（caseSensitive 时不带），从不带 u。
 * 开头的 .NET 内联选项组（Fiddler 规则里常见的 `(?i)` / `(?insx)`）JS 不认，这里翻译成标志：
 * i/m/s 对应同名标志，n（显式捕获）对 test() 没有影响；x 只在正则里没有空白和 # 时接受（那时它本来就不起作用）。
 * 合法的 JS 正则不可能以 `(?i)` 这种组开头，所以这个翻译不会改变任何本来就合法的正则。
 */
const INLINE_OPTIONS = /^\(\?([imnsx]+)\)/
const BACKSLASH = '\\'

/** 结尾是不是一个（没被转义的）`\z` / `\Z`：是就返回那个字母，否则 null。 */
function trailingAnchor(source) {
  const last = source[source.length - 1]
  if ((last !== 'z' && last !== 'Z') || source[source.length - 2] !== BACKSLASH) return null
  let run = 0
  for (let i = source.length - 2; i >= 0 && source[i] === BACKSLASH; i--) run++
  return run % 2 === 1 ? last : null
}

/**
 * 用户写的正则 → { source, flags }（不编译）。
 *   · 开头的 .NET 内联选项组翻译成标志（见上）。
 *   · .NET 的 \A（输入开头）写在开头、\z / \Z（输入结尾 / 结尾的换行之前）写在结尾时翻译成 JS 的锚点
 *     （带 m 标志时 ^ $ 是行首行尾，改用等价的环视）；不翻译的话不带 u 标志时它们会被悄悄当成字母 A / z / Z。
 *     写在别处的由 scanRegex 拒绝。
 */
function regexParts(pattern, caseSensitive) {
  let source = pattern
  const flags = new Set(caseSensitive ? [] : ['i'])
  const inline = INLINE_OPTIONS.exec(source)
  if (inline !== null) {
    source = source.slice(inline[0].length)
    const options = inline[1]
    if (options.includes('x') && /[\s#]/.test(source)) {
      throw new Error('不支持 (?x) 选项下的空白和 # 注释：请去掉正则里的空白 / 注释，或去掉开头的 x 选项')
    }
    for (const option of options) if (option === 'i' || option === 'm' || option === 's') flags.add(option)
  }
  const multiline = flags.has('m')
  if (source.startsWith(BACKSLASH + 'A')) source = (multiline ? '(?<![\\s\\S])' : '^') + source.slice(2)
  const tail = trailingAnchor(source)
  if (tail === 'z') source = source.slice(0, -2) + (multiline ? '(?![\\s\\S])' : '$')
  else if (tail === 'Z') source = source.slice(0, -2) + (multiline ? '(?=\\n?(?![\\s\\S]))' : '(?=\\n?$)')
  return { source, flags: [...flags].join('') }
}

function buildRegex(pattern, caseSensitive) {
  const { source, flags } = regexParts(pattern, caseSensitive)
  return new RegExp(source, flags)
}

/** 量词 `*` `+` `?` `{n}` `{n,}` `{n,m}`（可带懒惰的 `?`）→ { end, unbounded }；不是量词 → null。不带 u 标志时不成形的 `{` 是普通字符。 */
const BRACE_QUANTIFIER = /\{(\d+)(,(\d*))?\}/y
function readQuantifier(source, index) {
  const char = source[index]
  let end
  let unbounded
  if (char === '*' || char === '+') { end = index + 1; unbounded = true }
  else if (char === '?') { end = index + 1; unbounded = false }
  else if (char === '{') {
    BRACE_QUANTIFIER.lastIndex = index
    const match = BRACE_QUANTIFIER.exec(source)
    if (match === null) return null
    end = index + match[0].length
    unbounded = match[2] !== undefined && match[3] === ''
  } else return null
  if (source[end] === '?') end++
  return { end, unbounded }
}

/**
 * 扫一遍（已能编译的）正则源码，返回 { unsupported, nested }：
 *   unsupported  JS 不认、不带 u 标志时会被悄悄当成普通字母的 .NET 写法的说明（\p{…} / \P{…}；不在开头的 \A、不在结尾的 \z / \Z），没有为 null。
 *   nested       第一个「组里有无上限的重复（+ * {n,}），组本身又跟着无上限的重复」的写法，如 (a+)+、(\w+\s?)+$、(x*)*、(.*a){20,}；
 *                匹配不上时回溯次数随文本长度成倍增长（一条几十个字符的记录就能算上几十秒），没有为 null。
 */
function scanRegex(source) {
  const stack = [{ start: 0, unbounded: false }]
  let unsupported = null
  let nested = null
  const length = source.length
  const noteEscape = (letter, inClass, at) => {
    if (unsupported !== null) return
    if (letter === 'p' || letter === 'P') {
      unsupported = `不支持 ${BACKSLASH}${letter}{…}（Unicode 类别 / 区块）：不带 u 标志时它只是普通字母 ${letter}。请改用字符集，例如中文写 [一-龥]、英文字母写 [A-Za-z]`
    } else if (!inClass && (letter === 'A' || letter === 'z' || letter === 'Z')) {
      unsupported = `${BACKSLASH}${letter} 只能写在正则的${letter === 'A' ? '开头' : '结尾'}（会换成 ${letter === 'A' ? '^' : '$'}）；写在第 ${at + 1} 个字符处 JS 会把它当成普通字母 ${letter}`
    }
  }
  const afterAtom = (index) => {
    const quantifier = readQuantifier(source, index)
    if (quantifier === null) return index
    if (quantifier.unbounded) stack[stack.length - 1].unbounded = true
    return quantifier.end
  }
  let i = 0
  while (i < length) {
    const char = source[i]
    if (char === BACKSLASH) {
      noteEscape(source[i + 1], false, i)
      i = afterAtom(i + 2)
    } else if (char === '[') {
      let j = i + 1
      while (j < length && source[j] !== ']') {
        if (source[j] === BACKSLASH) { noteEscape(source[j + 1], true, j); j += 2 } else j++
      }
      i = afterAtom(j + 1)
    } else if (char === '(') {
      stack.push({ start: i, unbounded: false })
      let j = i + 1
      if (source[j] === '?') {
        j++
        if (source[j] === '<' && source[j + 1] !== '=' && source[j + 1] !== '!') { const close = source.indexOf('>', j); j = close < 0 ? length : close + 1 }
        else j += source[j] === '<' ? 2 : 1
      }
      i = j
    } else if (char === ')') {
      const group = stack.length > 1 ? stack.pop() : null
      const quantifier = readQuantifier(source, i + 1)
      const parent = stack[stack.length - 1]
      if (group !== null) {
        if (nested === null && quantifier !== null && quantifier.unbounded && group.unbounded) nested = source.slice(group.start, quantifier.end)
        if (group.unbounded || (quantifier !== null && quantifier.unbounded)) parent.unbounded = true
      }
      i = quantifier === null ? i + 1 : quantifier.end
    } else {
      i = afterAtom(i + 1)
    }
  }
  return { unsupported, nested }
}

// ---------------------------------------------------------------- 校验

function resolveMode(raw) {
  if (raw === undefined || raw === null || raw === '') return 'all'
  const mode = String(raw).trim().toLowerCase()
  if (mode === 'all' || mode === 'and') return 'all'
  if (mode === 'any' || mode === 'or') return 'any'
  throw invalid(`匹配方式只能是 all（满足全部条件）或 any（满足任一条件），收到「${shown(raw)}」`)
}

function conditionValueText(raw, fail) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw fail('值必须是有限数字')
    return String(raw)
  }
  if (typeof raw === 'boolean') return String(raw)
  throw fail('值 value 必须是文本或数字')
}

// 认得的键。别的键（拼错的、大小写不对的 Field / Conditions、rules…）一律 FILTER_INVALID：
// 悄悄丢掉它们会把「只删 h1 的记录」变成「匹配全部」（DELETE /records?filtered=1 会清空整个库）。值为 undefined 的键当没写。
const FILTER_KEYS = ['name', 'mode', 'conditions', 'id', 'createdAt', 'updatedAt']
const CONDITION_KEYS = ['field', 'op', 'value', 'enabled', 'caseSensitive', 'header', 'id']

function unknownKeys(raw, allowed) {
  const problems = []
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key) || raw[key] === undefined) continue
    const known = allowed.find((name) => name.toLowerCase() === key.toLowerCase())
    problems.push(known === undefined ? `「${shown(key)}」` : `「${shown(key)}」应写作「${known}」`)
  }
  return problems.length === 0 ? null : `不认识的键：${problems.join('、')}（只能用 ${allowed.join('、')}；键名区分大小写）`
}

function normalizeCondition(raw, index, seenIds) {
  const fail = (message) => invalid(`第 ${index + 1} 个条件：${message}`, { conditionIndex: index })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('必须是 { field, op, value } 形式的对象')
  const unknown = unknownKeys(raw, CONDITION_KEYS)
  if (unknown !== null) throw fail(unknown)
  if (raw.field === undefined || raw.field === null || raw.field === '') throw fail(`缺少字段 field（可用：${FIELD_IDS}）`)
  const field = resolveField(raw.field)
  if (field === null) throw fail(`未知字段「${shown(raw.field)}」（可用：${FIELD_IDS}）`)
  if (raw.op === undefined || raw.op === null || raw.op === '') throw fail(`缺少比较方式 op（「${field.label}」可用：${opIdsFor(field)}）`)
  const opId = resolveOp(raw.op, field)
  if (opId === null) throw fail(`未知比较方式「${shown(raw.op)}」（「${field.label}」可用：${opIdsFor(field)}）`)
  const op = OP_BY_ID.get(opId)
  if (!opAllowed(op, field)) {
    throw fail(`「${field.label}」是${field.kind === 'number' ? '数字' : '文本'}字段，不能用「${op.label}」（可用：${opIdsFor(field)}）`)
  }
  const caseSensitive = TEXT_OPS.has(opId) && isTrue(raw.caseSensitive)
  // 需要值的比较方式必须带 value 键（漏写多半是写错了）；显式的 '' 是合法的文本值，按普通字符串语义比较
  // （包含 '' 恒成立、等于 '' 即为空），面板新加的空条件行因此不会被判成不合法。
  if (op.needsValue && (raw.value === undefined || raw.value === null)) throw fail(`「${field.label} ${op.label}」缺少值 value`)
  let value = conditionValueText(raw.value, fail)
  if (!op.needsValue) {
    value = ''
  } else if (NUMBER_OPS.has(opId)) {
    value = value.trim()
    if (value === '') throw fail(`「${field.label} ${op.label}」后面要填一个数字`)
    if (!Number.isFinite(Number(value))) throw fail(`「${field.label}」要和数字比较，「${shown(value)}」不是数字`)
  }
  const length = codePointLength(value)
  if (length > MAX_VALUE) throw fail(`值过长（${length} 个字符，上限 ${MAX_VALUE}）`)
  if (opId === 'regex' || opId === 'notRegex') {
    if (length > MAX_REGEX) throw fail(`正则过长（${length} 个字符，上限 ${MAX_REGEX}）`)
    let parts
    try { parts = regexParts(value, caseSensitive); new RegExp(parts.source, parts.flags) } catch (error) { throw fail(`正则无效：${error.message}`) }
    const scan = scanRegex(parts.source)
    if (scan.unsupported !== null) throw fail(`正则无效：${scan.unsupported}`)
    if (scan.nested !== null) {
      throw fail(`正则可能灾难性回溯（嵌套重复）：${shown(scan.nested)} 是「重复里面又套着重复」，遇到匹配不上的长文本时要算很久，会卡住查询。` +
        '请去掉其中一层重复，例如把 (\\w+\\s?)+ 改成 [\\w\\s]+，把 (a+)+ 改成 a+')
    }
  }
  let header = ''
  if (field.header && raw.header !== undefined && raw.header !== null) {
    if (typeof raw.header !== 'string') throw fail('header（头名）必须是文本')
    header = raw.header.trim()
    const headerLength = codePointLength(header)
    if (headerLength > MAX_HEADER_NAME) throw fail(`头名过长（${headerLength} 个字符，上限 ${MAX_HEADER_NAME}）`)
    if (header !== '' && !HEADER_TOKEN.test(header)) throw fail(`头名「${shown(header)}」不合法（只能包含字母、数字和 !#$%&'*+-.^_\`|~）`)
  }
  let id = cleanId(raw.id)
  if (id === '' || seenIds.has(id)) id = randomUUID()
  seenIds.add(id)
  const condition = { id, enabled: !isFalse(raw.enabled), field: field.id, op: opId, value, caseSensitive }
  if (header !== '') condition.header = header
  return condition
}

/**
 * 校验并返回规范化的副本（不改动入参）；不合法时抛 Error，code = 'FILTER_INVALID'，
 * message 用中文点名第几个条件（`第 2 个条件：正则无效：…`），并带 conditionIndex（从 0 数）。
 * 缺的 id 用 randomUUID 生成；mode 缺省 'all'；createdAt / updatedAt 缺省为当前时间。
 * requireName=false（临时条件）时名称可以为空，过长的名称会被截短而不是报错。
 */
export function normalizeFilter(raw, { requireName = true } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('过滤器必须是对象：{ name, mode, conditions: [ … ] }')
  const looksLikeCondition = (raw.conditions === undefined || raw.conditions === null) && (raw.field !== undefined || raw.op !== undefined)
  // 把单个条件当成过滤器传进来时不能悄悄变成「匹配全部」。
  if (looksLikeCondition) throw invalid('缺少 conditions 数组（这个对象看起来是单个条件，请写成 { conditions: [ … ] }）')
  const unknown = unknownKeys(raw, FILTER_KEYS)
  if (unknown !== null) throw invalid(`过滤器里${unknown}；条件要放在 conditions 数组里`)
  let name = cleanName(raw.name)
  const nameLength = codePointLength(name)
  if (requireName && nameLength === 0) throw invalid('过滤器名称不能为空')
  if (nameLength > MAX_NAME) {
    if (requireName) throw invalid(`过滤器名称最长 ${MAX_NAME} 个字符（现在 ${nameLength} 个）`)
    name = clip(name, MAX_NAME, '')
  }
  const mode = resolveMode(raw.mode)
  const list = raw.conditions
  // 没有 conditions 数组的对象（{}、{ mode: 'all' }、只有名称的）也不能当成「匹配全部」：不过滤就不传，要匹配全部就明写 conditions: []。
  if (list === undefined || list === null) throw invalid('缺少 conditions 数组：过滤器要写成 { mode, conditions: [ { field, op, value }, … ] }（要匹配全部请明写 conditions: []）')
  if (!Array.isArray(list)) throw invalid('conditions 必须是数组')
  if (list.length > MAX_CONDITIONS) throw invalid(`条件最多 ${MAX_CONDITIONS} 个（现在 ${list.length} 个）`)
  const seenIds = new Set()
  const conditions = list.map((condition, index) => normalizeCondition(condition, index, seenIds))
  const createdAt = timeOr(raw.createdAt, Date.now())
  const updatedAt = timeOr(raw.updatedAt, createdAt)
  return { id: cleanId(raw.id) || randomUUID(), name, mode, conditions, createdAt, updatedAt }
}

// 键名大小写写错（Field / Op）的单个条件也按条件处理：这样报错会落在条件上（「Field」应写作「field」），而不是变成过滤器。
const hasKeyLike = (value, key) => Object.keys(value).some((name) => name.toLowerCase() === key && value[name] !== undefined)
const isBareCondition = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  !hasKeyLike(value, 'conditions') && (hasKeyLike(value, 'field') || hasKeyLike(value, 'op'))

/**
 * 「一个过滤器 / 过滤器数组 / 它们的 JSON 字符串」→ { items, multiple }；null 表示没有条件。
 * 也接受 agent 常见的简写：单个条件对象、条件数组（都按「满足全部」包成一个过滤器）。
 */
function coerceFilterInput(input) {
  if (input === undefined || input === null) return null
  let value = input
  if (typeof value === 'string') {
    const text = value.trim().replace(/^\uFEFF/, '')
    if (text === '') return null
    try { value = JSON.parse(text) } catch (error) { throw invalid(`conditions 不是合法的 JSON：${error.message}`) }
    if (value === null) return null
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isBareCondition)) return { items: [{ mode: 'all', conditions: value }], multiple: false }
    return { items: value.map((item) => isBareCondition(item) ? { mode: 'all', conditions: [item] } : item), multiple: true }
  }
  if (isBareCondition(value)) return { items: [{ mode: 'all', conditions: [value] }], multiple: false }
  return { items: [value], multiple: false }
}

function prefixFilterError(error, index, raw) {
  if (error?.code !== 'FILTER_INVALID') return error
  const name = typeof raw === 'object' && raw !== null ? cleanName(raw.name) : ''
  error.message = `第 ${index + 1} 个过滤器${name !== '' ? `（${clip(name, 40)}）` : ''}：${error.message}`
  error.filterIndex = index
  return error
}

/** 规范化一组临时条件；空 → null。数组输入的报错带「第 N 个过滤器」。 */
function normalizeFilterInput(input) {
  const coerced = coerceFilterInput(input)
  if (coerced === null) return null
  const { items, multiple } = coerced
  if (items.length > MAX_FILTERS) throw invalid(`一次最多组合 ${MAX_FILTERS} 个过滤器（现在 ${items.length} 个）`)
  const list = items.map((item, index) => {
    try { return normalizeFilter(item, { requireName: false }) } catch (error) { throw multiple ? prefixFilterError(error, index, item) : error }
  })
  return list.length === 0 ? null : list
}

// ---------------------------------------------------------------- 取值

const EMPTY_RECORD = Object.freeze({})
const NO_FIELDS = Object.freeze([])

function textOf(value) {
  if (typeof value === 'string') return value
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

// URL 拆分：路径 / 查询串按 RFC 3986 附录 B 的正则从原文拆；域名优先 WHATWG（与 capture-store 的 host 快捷过滤同一口径），解析不了再用正则拆出的。
// 结果按「记录对象 + url 字符串」缓存：同一条记录被多个条件 / 多次查询使用时只解析一次，
// url 被换掉时缓存自动失效（WeakMap 不会拖住记录的回收）。
const URI_PATTERN = /^(?:[A-Za-z][A-Za-z\d+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/
const parseUrl = typeof URL.parse === 'function'
  ? (text) => URL.parse(text)
  : (text) => { try { return new URL(text) } catch { return null } }
const URL_PARTS = new WeakMap()

function parseUrlParts(url) {
  if (url === '') return { url, host: '', path: '', query: '' }
  // 路径与查询串取存下来的原文（列表里显示的就是它）：WHATWG 序列化会把 " ' 空格 { } 和中文转成 %XX，
  // 照着列表写的条件就对不上了。只有域名用 WHATWG 的结果（小写、去端口，与 capture-store 的 host 快捷过滤同一口径）。
  const match = URI_PATTERN.exec(url)
  const parsed = parseUrl(url)
  if (parsed !== null) {
    const path = match?.[2] ?? ''
    // 没写路径的 http(s)://host 按 WHATWG 记成 '/'（请求行里就是 /）
    return { url, host: parsed.hostname.toLowerCase(), path: path === '' ? parsed.pathname : path, query: match?.[3] ?? '' }
  }
  let host = match?.[1] ?? ''
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close >= 0) host = host.slice(0, close + 1)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon >= 0 && /^\d*$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  }
  return { url, host: host.toLowerCase(), path: match?.[2] ?? '', query: match?.[3] ?? '' }
}

function urlParts(record) {
  const url = typeof record.url === 'string' ? record.url : ''
  const cached = URL_PARTS.get(record)
  if (cached !== undefined && cached.url === url) return cached
  const parts = parseUrlParts(url)
  URL_PARTS.set(record, parts)
  return parts
}

function headerValueText(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    let out = null
    for (const item of value) {
      const text = headerValueText(item)
      if (text !== null) out = out === null ? text : `${out}, ${text}`
    }
    return out ?? ''
  }
  if (typeof value === 'object') { try { return JSON.stringify(value) } catch { return '' } }
  return String(value)
}

/** lowerName 非空：该头的值（头名不区分大小写，多值用 ', ' 连接）；为空：全部头，每行「名称: 值」。 */
function headersText(headers, lowerName) {
  if (typeof headers !== 'object' || headers === null) return ''
  let out = ''
  let found = false
  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) continue
    if (lowerName !== '' && (key.length !== lowerName.length || key.toLowerCase() !== lowerName)) continue
    const text = headerValueText(headers[key])
    if (text === null) continue
    if (lowerName === '') out = found ? `${out}\n${key}: ${text}` : `${key}: ${text}`
    else out = found ? `${out}, ${text}` : text
    found = true
  }
  return out
}

function contentTypeOf(record) {
  const header = headersText(record.resHeaders, 'content-type')
  if (header !== '') return header
  return typeof record.contentType === 'string' ? record.contentType : ''
}

/** 与 queryRecords 的 caller 过滤同一份文本：viewModel、view、apiMethod、trigger、调用栈各行。 */
function callerText(record) {
  const caller = record.caller
  if (typeof caller !== 'object' || caller === null) return ''
  let out = ''
  const add = (value) => { if (value) out = out === '' ? String(value) : `${out}\n${String(value)}` }
  add(caller.viewModel)
  add(caller.view)
  add(caller.apiMethod)
  add(caller.trigger)
  if (Array.isArray(caller.stack)) for (const line of caller.stack) add(line)
  return out
}

function channelOf(record) {
  if (record.source === 'proxy') return record.process === 'intercept' ? 'intercept' : 'local-proxy'
  return String(record.source ?? '')
}

function processOf(record, realtimeProcess) {
  const name = record.clientProcess
  if (typeof name === 'string' && name !== '') return name
  return record.source === 'realtime' ? realtimeProcess : ''
}

/** 文本字段的取值函数（缺失 → ''）。 */
function textAccessor(fieldId, lowerHeader, realtimeProcess) {
  switch (fieldId) {
    case 'url': return (record) => typeof record.url === 'string' ? record.url : ''
    case 'host': return (record) => urlParts(record).host
    case 'path': return (record) => urlParts(record).path
    case 'query': return (record) => urlParts(record).query
    case 'method': return (record) => textOf(record.method)
    case 'process': return (record) => processOf(record, realtimeProcess)
    case 'channel': return channelOf
    case 'contentType': return contentTypeOf
    case 'reqHeader': return (record) => headersText(record.reqHeaders, lowerHeader)
    case 'resHeader': return (record) => headersText(record.resHeaders, lowerHeader)
    case 'reqBody': return (record) => textOf(record.reqBody)
    case 'resBody': return (record) => textOf(record.resBody)
    case 'note': return (record) => textOf(record.note)
    case 'caller': return callerText
    case 'tag': return (record) => textOf(record.tag)
    default: return () => ''
  }
}

/** 数字字段的取值函数（缺失或不是有限数字 → undefined）。 */
function numberAccessor(fieldId) {
  switch (fieldId) {
    case 'status': return (record) => numberOf(record.status)
    case 'durationMs': return (record) => numberOf(record.durationMs)
    case 'bytesRes': return (record) => numberOf(record.bytesRes)
    case 'bytesReq': return (record) => numberOf(record.bytesReq)
    case 'pid': return (record) => numberOf(record.clientPid)
    default: return () => undefined
  }
}

/**
 * 取记录某个字段的值（与匹配时用的是同一份取值逻辑）。
 * 文本字段缺失时返回 ''；数字字段缺失 / 不是有限数字时返回 undefined；未知字段返回 undefined。
 *   process：record.clientProcess；没有时，实时捕获（source='realtime'）的记录用 realtimeProcess；否则 ''。
 *   channel：proxy 记录按 record.process 分成 intercept / local-proxy，其他记录就是 source。
 *   请求头 / 响应头：给了 header 就取该头（名称不区分大小写），不给就是全部头「名称: 值」逐行拼接。
 */
export function fieldValue(record, field, { header = '', realtimeProcess = '' } = {}) {
  const definition = resolveField(field)
  if (definition === null) return undefined
  const target = typeof record === 'object' && record !== null ? record : EMPTY_RECORD
  if (definition.kind === 'number') return numberAccessor(definition.id)(target)
  const lowerHeader = definition.header && typeof header === 'string' ? header.trim().toLowerCase() : ''
  return textAccessor(definition.id, lowerHeader, cleanProcessName(realtimeProcess))(target)
}

// ---------------------------------------------------------------- 编译

// 估算代价：便宜的条件先算（结果与顺序无关，只影响短路有多早）。
const FIELD_COST = {
  method: 1, status: 1, channel: 1, process: 1, durationMs: 1, bytesRes: 1, bytesReq: 1, pid: 1, tag: 1,
  url: 2, note: 2, host: 3, path: 3, query: 3, contentType: 3, caller: 4, reqHeader: 4, resHeader: 4, reqBody: 8, resBody: 8,
}
const costOf = (condition) => (FIELD_COST[condition.field] ?? 5) + (condition.op === 'regex' || condition.op === 'notRegex' ? 2 : 0)

function compileCondition(condition, realtimeProcess) {
  const field = FIELD_BY_ID.get(condition.field)
  const op = condition.op
  if (field.kind === 'number') {
    const get = numberAccessor(field.id)
    if (op === 'exists') return (record) => get(record) !== undefined
    if (op === 'notExists') return (record) => get(record) === undefined
    if (NUMBER_OPS.has(op)) {
      const target = Number(condition.value)
      switch (op) {
        case 'eq': return (record) => { const value = get(record); return value !== undefined && value === target }
        case 'ne': return (record) => { const value = get(record); return value !== undefined && value !== target }
        case 'gt': return (record) => { const value = get(record); return value !== undefined && value > target }
        case 'gte': return (record) => { const value = get(record); return value !== undefined && value >= target }
        case 'lt': return (record) => { const value = get(record); return value !== undefined && value < target }
        default: return (record) => { const value = get(record); return value !== undefined && value <= target }
      }
    }
    // 文本比较用在数字字段上：比较 String(值)，缺失按 ''。
    return compileTextOp(op, condition, (record) => { const value = get(record); return value === undefined ? '' : String(value) })
  }
  const get = textAccessor(field.id, (condition.header ?? '').toLowerCase(), realtimeProcess)
  if (op === 'exists') return (record) => get(record) !== ''
  if (op === 'notExists') return (record) => get(record) === ''
  return compileTextOp(op, condition, get)
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function compileTextOp(op, condition, get) {
  if (op === 'regex' || op === 'notRegex') {
    const expression = buildRegex(condition.value, condition.caseSensitive)
    return op === 'regex' ? (record) => expression.test(get(record)) : (record) => !expression.test(get(record))
  }
  const needle = condition.value
  if (condition.caseSensitive) {
    switch (op) {
      case 'contains': return (record) => get(record).includes(needle)
      case 'notContains': return (record) => !get(record).includes(needle)
      case 'equals': return (record) => get(record) === needle
      case 'notEquals': return (record) => get(record) !== needle
      case 'startsWith': return (record) => get(record).startsWith(needle)
      default: return (record) => get(record).endsWith(needle)
    }
  }
  // 不区分大小写：预编译带 i 标志的字面量正则，求值时不再把整段文本转小写（响应体最大 2 MB，
  // 逐条 toLowerCase 会在每次查询里分配出与整个库一样大的临时字符串；实测 1 亿字符：转小写 210–420 ms，正则 12 ms）。
  // 不带 u 标志的 i 匹配逐个 UTF-16 单元折叠大小写，匹配长度恒等于 needle 长度，所以 endsWith 可以用粘性正则只试最后一个位置。
  const source = escapeRegex(needle)
  const length = needle.length
  switch (op) {
    case 'contains': { const expression = new RegExp(source, 'i'); return (record) => expression.test(get(record)) }
    case 'notContains': { const expression = new RegExp(source, 'i'); return (record) => !expression.test(get(record)) }
    case 'equals': {
      const expression = new RegExp(`^(?:${source})$`, 'i')
      return (record) => { const text = get(record); return text.length === length && expression.test(text) }
    }
    case 'notEquals': {
      const expression = new RegExp(`^(?:${source})$`, 'i')
      return (record) => { const text = get(record); return text.length !== length || !expression.test(text) }
    }
    case 'startsWith': { const expression = new RegExp(`^(?:${source})`, 'i'); return (record) => expression.test(get(record)) }
    default: {
      const expression = new RegExp(`(?:${source})$`, 'iy')
      return (record) => {
        const text = get(record)
        if (text.length < length) return false
        expression.lastIndex = text.length - length
        return expression.test(text)
      }
    }
  }
}

function compileOne(filter, realtimeProcess) {
  const active = filter.conditions.filter((condition) => condition.enabled)
  if (active.length === 0) return null
  const entries = active
    .map((condition, index) => ({
      index, cost: costOf(condition), field: condition.field,
      test: compileCondition(condition, realtimeProcess),
      // 数字比较的取值函数：用来判断「这条记录是不是因为缺这个字段才不满足」
      numberGet: NUMBER_OPS.has(condition.op) ? numberAccessor(condition.field) : null,
    }))
    .sort((first, second) => first.cost - second.cost || first.index - second.index)
  const tests = entries.map((entry) => entry.test)
  const count = tests.length
  const any = filter.mode === 'any'
  const test = any
    ? (record) => { for (let i = 0; i < count; i++) if (tests[i](record)) return true; return false }
    : (record) => { for (let i = 0; i < count; i++) if (!tests[i](record)) return false; return true }
  const numberEntries = entries.filter((entry) => entry.numberGet !== null)
  // blame(record)：对一条**不满足**本过滤器的记录，返回「只因缺了这些数字字段才不满足」的字段 id；
  // 有别的条件因为真实的值而不成立时返回 null（补上字段也匹配不了，不算「缺字段被排除」）。
  let blame = null
  if (numberEntries.length > 0) {
    blame = any
      ? (record) => {
          let fields = null
          for (const entry of numberEntries) if (entry.numberGet(record) === undefined) (fields ??= []).push(entry.field)
          return fields
        }
      : (record) => {
          let fields = null
          for (const entry of entries) {
            if (entry.numberGet !== null && entry.numberGet(record) === undefined) { (fields ??= []).push(entry.field); continue }
            if (!entry.test(record)) return null
          }
          return fields
        }
  }
  return { test, blame }
}

/**
 * 编译成谓词 `(record) => boolean`。入参：一个过滤器对象、过滤器数组（全部满足才算匹配）、
 * null / undefined（匹配全部）；也接受它们的 JSON 字符串和条件简写（见 coerceFilterInput）。
 * 先用 normalizeFilter(…, { requireName: false }) 校验，不合法抛 FILTER_INVALID（数组时点名第几个过滤器）。
 * 正则（含不区分大小写比较用的字面量正则）和数字都只在这里算一次；求值时不再分配（取值本身需要的除外）。
 * 便宜的条件先算（只影响短路，不影响结果）。
 * 选项 deadlineMs（可选）：绝对时刻（与 Date.now() 同单位）；过了这个时刻，谓词 / missingNumberFields 在下一次看钟时
 * 抛 Error（code 'FILTER_TOO_SLOW'，中文说明）。每 64 次调用看一次钟（第 1 次就看）；不给就不看钟。
 *
 * 返回的函数上挂着几个不可枚举的属性：
 *   filters              规范化后的过滤器数组（没有条件时为 []）
 *   matchesAll           true = 没有启用的条件，谓词恒为 true
 *   missingNumberFields  (record) => 字段 id 数组：一条不匹配的记录**只因**缺了这些数字字段（数字比较里未知不成立）
 *                        才被排除；有别的条件按真实的值不成立时为 []。queryRecords 用它按 F-046 的口径计 excludedNoField。
 */
export function compileFilter(filterOrList, { realtimeProcess = '', deadlineMs } = {}) {
  const list = normalizeFilterInput(filterOrList) ?? []
  const processName = cleanProcessName(realtimeProcess)
  const parts = []
  for (const filter of list) {
    const part = compileOne(filter, processName)
    if (part !== null) parts.push(part)
  }
  const count = parts.length
  // deadlineMs：绝对时刻（Date.now() 的毫秒数）。给了就每 64 次调用（谓词与 missingNumberFields 合计，从第 1 次起）看一次钟，
  // 过了时刻抛 FILTER_TOO_SLOW；没给就完全不看钟（与以前一样）。一次正则求值本身打断不了，所以嵌套重复在校验时就拒绝了。
  const deadline = typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && count > 0 ? deadlineMs : null
  let calls = 0
  const checkClock = () => {
    if ((calls++ & 63) === 0 && Date.now() > deadline) {
      throw filterError('FILTER_TOO_SLOW', '自定义过滤条件算得太慢，超过了时限，已停止：多半是正则太复杂或响应体很大。' +
        '请把正则写得更具体（少用 .* 和嵌套的重复），或先用域名 / 路径 / 方法等条件缩小范围再试')
    }
  }
  const evaluate = (record) => {
    const target = typeof record === 'object' && record !== null ? record : EMPTY_RECORD
    for (let i = 0; i < count; i++) if (!parts[i].test(target)) return false
    return true
  }
  const predicate = deadline === null ? evaluate : (record) => { checkClock(); return evaluate(record) }
  const missingNumberFields = (record) => {
    if (deadline !== null) checkClock()
    const target = typeof record === 'object' && record !== null ? record : EMPTY_RECORD
    let missing = null
    for (const part of parts) {
      if (part.test(target)) continue
      const fields = part.blame === null ? null : part.blame(target)
      if (fields === null) return NO_FIELDS
      for (const field of fields) (missing ??= new Set()).add(field)
    }
    return missing === null ? NO_FIELDS : [...missing]
  }
  Object.defineProperties(predicate, {
    filters: { value: list },
    matchesAll: { value: count === 0 },
    missingNumberFields: { value: missingNumberFields },
  })
  return predicate
}

const conditionSignature = (condition) =>
  [condition.enabled, condition.field, condition.op, condition.value, condition.caseSensitive, condition.header ?? '']
const contentKey = (filter) => JSON.stringify([filter.mode, filter.conditions.map(conditionSignature)])

/**
 * 条件的规范签名（JSON 字符串）：只看 mode 与各条件的内容，忽略 id / 名称 / 时间戳；
 * 单个过滤器与只含它的数组签名相同；没有条件时为 null。不合法时抛 FILTER_INVALID。
 * 用途：查询游标的 queryKey（resolveQueryConditions 每次都会给没有 id 的条件生成新的随机 id，
 * 直接哈希原始对象会让第 2 页永远对不上第 1 页的游标）。
 */
export function filterSignature(filterOrList) {
  const list = normalizeFilterInput(filterOrList)
  if (list === null) return null
  return JSON.stringify(list.map((filter) => [filter.mode, filter.conditions.map(conditionSignature)]))
}

// ---------------------------------------------------------------- 描述

function describeCondition(condition) {
  const field = resolveField(condition.field)
  const opId = resolveOp(condition.op, field)
  const op = opId === null ? null : OP_BY_ID.get(opId)
  const header = field?.header && typeof condition.header === 'string' && condition.header.trim() !== '' ? ` ${condition.header.trim()}` : ''
  const head = `${field !== null ? field.label : shown(condition.field)}${header} ${op ? op.label : shown(condition.op)}`
  if (op && !op.needsValue) return head
  const raw = condition.value === undefined || condition.value === null ? '' : String(condition.value)
  if (opId === 'regex' || opId === 'notRegex') {
    return `${head} /${clip(raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n'), 200)}/${isTrue(condition.caseSensitive) ? '' : 'i'}`
  }
  if (opId !== null && NUMBER_OPS.has(opId)) return `${head} ${clip(raw.trim(), 50)}`
  return `${head} ${JSON.stringify(clip(raw, 200))}${isTrue(condition.caseSensitive) ? '（区分大小写）' : ''}`
}

function describeOne(filter) {
  if (typeof filter !== 'object' || filter === null || !Array.isArray(filter.conditions)) return EMPTY_DESCRIPTION
  const active = filter.conditions.filter((condition) => typeof condition === 'object' && condition !== null && !isFalse(condition.enabled))
  if (active.length === 0) return EMPTY_DESCRIPTION
  const mode = String(filter.mode ?? '').trim().toLowerCase()
  return `${mode === 'any' || mode === 'or' ? '任一满足' : '全部满足'}：${active.map(describeCondition).join('；')}`
}

/**
 * 一行中文描述，例如 `全部满足：进程 匹配正则 /acme|CefSharp/i；URL 包含 "/api/"`。
 * 停用的条件不写；没有启用条件时为 `（无条件，匹配全部）`。不校验、不抛错（未知字段 / 比较方式原样写出）。
 * 传数组时逐个描述，用「；并且 」连接。
 */
export function describeFilter(filter) {
  if (Array.isArray(filter)) return filter.length === 0 ? EMPTY_DESCRIPTION : filter.map(describeOne).join('；并且 ')
  return describeOne(filter)
}

// ---------------------------------------------------------------- 存储

export function filtersPath(dir) { return join(dir, FILTERS_FILE) }

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows 上目标文件正被别的进程（杀毒、索引）短暂占用时 rename 会 EPERM / EBUSY：退避重试几次。 */
function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { renameSync(from, to); return } catch (error) {
      if (process.platform !== 'win32' || !RETRYABLE_RENAME.has(error.code) || attempt >= 5) throw error
      Atomics.wait(SLEEP_CELL, 0, 0, 10 * attempt)
    }
  }
}

/**
 * 原子写：同目录临时文件写完并 fsync，再 rename 覆盖；失败时删掉临时文件，原文件保持不变。
 * unchanged（可选）在 rename 之前调用：返回 false（目标文件在这期间被别人改了）就删掉临时文件、不覆盖，返回 false。
 */
function writeFileAtomic(file, text, unchanged = null) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  let fd = null
  try {
    fd = openSync(temp, 'wx')
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    if (unchanged !== null && !unchanged()) { unlinkSync(temp); return false }
    renameRetrying(temp, file)
    return true
  } catch (error) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已经在报错路径上 */ } }
    try { unlinkSync(temp) } catch { /* 临时文件可能根本没建出来 */ }
    throw error
  }
}

function notFound(message, filters) {
  const available = filters.map((filter) => filter.name)
  return filterError('FILTER_NOT_FOUND', message + (available.length > 0 ? `（已保存的过滤器：${available.join('、')}）` : '（还没有保存任何过滤器）'), { available })
}

/** 文件内容 → 过滤器条目数组（{ filters: [...] } 或数组）；不是合法 JSON / 结构不对 → null。 */
function storedList(text) {
  let data
  try { data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) } catch { return null }
  return Array.isArray(data) ? data : typeof data === 'object' && data !== null && Array.isArray(data.filters) ? data.filters : null
}

/** 读命名过滤器。文件不存在 / 损坏 → []，绝不抛；单个不合法的过滤器被跳过，重复的 id 换新。 */
export function loadFilters(dir) {
  let list
  try { list = storedList(readFileSync(filtersPath(dir), 'utf8')) } catch { return [] }
  if (list === null) return []
  const filters = []
  const ids = new Set()
  for (const raw of list) {
    if (filters.length >= MAX_FILTERS) break
    let filter
    try { filter = normalizeFilter(raw) } catch { continue }
    if (ids.has(filter.id)) filter.id = randomUUID()
    ids.add(filter.id)
    filters.push(filter)
  }
  return filters
}

/** 校验每一个、名称不区分大小写唯一、id 唯一、最多 200 个 → 规范化列表。 */
function checkedList(filters) {
  if (!Array.isArray(filters)) throw invalid('filters 必须是数组')
  if (filters.length > MAX_FILTERS) throw invalid(`过滤器最多 ${MAX_FILTERS} 个（现在 ${filters.length} 个）`)
  const list = filters.map((filter, index) => {
    try { return normalizeFilter(filter) } catch (error) { throw prefixFilterError(error, index, filter) }
  })
  const names = new Map()
  const ids = new Set()
  for (const filter of list) {
    const clash = names.get(nameKey(filter.name))
    if (clash !== undefined) throw filterError('FILTER_NAME_TAKEN', `过滤器名称重复：「${clash.name}」与「${filter.name}」（名称不区分大小写）`, { existingId: clash.id })
    if (ids.has(filter.id)) throw invalid(`过滤器 id 重复：${filter.id}`)
    names.set(nameKey(filter.name), filter)
    ids.add(filter.id)
  }
  return list
}

const storeText = (entries) => JSON.stringify({ version: 1, filters: entries }, null, 2) + '\n'

/** 整体写回（校验每一个、名称不区分大小写唯一、id 唯一、最多 200 个），原子写。返回写入的规范化列表。 */
export function saveFilters(dir, filters) {
  const list = checkedList(filters)
  writeFileAtomic(filtersPath(dir), storeText(list))
  return list
}

// ---------------------------------------------------------------- 写路径（读-改-写）
//
// 写路径不能拿 loadFilters 的宽松结果重建文件（R1-03）：那样文件坏了 / 有当前版本读不了的条目时，保存一次就把它们全丢了。
//   · 文件不存在 → 从空列表开始。读不了（权限、被占用…）→ FILTERS_UNREADABLE，什么都不写。
//   · 文件存在但不是合法的过滤器 JSON → 先原样改名为 capture-filters.json.corrupt-<时间戳>（不覆盖已有备份），再从空列表开始；
//     结果里带 corruptBackup（备份路径）和 warning，失败的写操作（如删除找不到）把这两样挂在错误上。
//   · 校验不过的条目（新版本的字段 / 比较方式、手改坏的）和超过 200 个之后的条目：不出现在列表里，但按原来的位置、
//     原来的 JSON 内容写回去（只是重新排版）；它们的名称仍算「已占用」，新建 / 导入时不会撞名。
// 并发（R1-04）：rename 之前再读一次文件，与开始时读到的内容不同（别的进程改过）就放弃这次、整体重做一次；
// 还不同 → FILTERS_CONFLICT，什么都不写。

/** 读文件原文；不存在 → null；别的读错误 → FILTERS_UNREADABLE。 */
function readStoreText(file) {
  try { return readFileSync(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw filterError('FILTERS_UNREADABLE', `读不了过滤器文件 ${FILTERS_FILE}（${error?.code ?? error?.message}）：为了不覆盖它，这次什么都没改，请检查权限或是否被别的程序占用后重试`)
  }
}

/** 把损坏的文件原样改名备份；返回备份路径（文件已经不在了 → null）。 */
function moveAside(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '')
  let target = `${file}.corrupt-${stamp}`
  for (let number = 2; existsSync(target); number++) target = `${file}.corrupt-${stamp}-${number}`
  try { renameRetrying(file, target) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw filterError('FILTERS_UNREADABLE', `过滤器文件 ${FILTERS_FILE} 已损坏（不是合法的过滤器 JSON），改名备份时失败（${error?.code ?? error?.message}）：这次什么都没改`)
  }
  return target
}

/** 写路径的严格读取 → { text, entries: [{ raw, filter | null }], visible: Filter[], reserved: Set<名称键>, backup }。 */
function readForWrite(file) {
  let text = readStoreText(file)
  let backup = null
  let list = text === null ? [] : storedList(text)
  if (list === null) { backup = moveAside(file); text = null; list = [] }
  const ids = new Set()
  const visible = []
  const reserved = new Set()
  const entries = list.map((raw) => {
    let filter = null
    if (visible.length < MAX_FILTERS) { try { filter = normalizeFilter(raw) } catch { filter = null } }
    if (filter === null) {
      const name = typeof raw === 'object' && raw !== null ? cleanName(raw.name) : ''
      if (name !== '') reserved.add(nameKey(name))
      return { raw, filter: null }
    }
    if (ids.has(filter.id)) filter.id = randomUUID()
    ids.add(filter.id)
    visible.push(filter)
    return { raw, filter }
  })
  return { text, entries, visible, reserved, backup }
}

/** 新的可见列表 + 原来的条目 → 要写的条目：原来的位置不变（改过的换成新版本、删掉的去掉、保留的原样），新加的接在末尾。 */
function withPreserved(entries, list) {
  const byId = new Map(list.map((filter) => [filter.id, filter]))
  const used = new Set()
  const out = []
  for (const entry of entries) {
    if (entry.filter === null) { out.push(entry.raw); continue }
    const current = byId.get(entry.filter.id)
    if (current !== undefined && !used.has(current.id)) { out.push(current); used.add(current.id) }
  }
  for (const filter of list) if (!used.has(filter.id)) out.push(filter)
  return out
}

function backupNote(backup) {
  return `过滤器文件已损坏（不是合法的过滤器 JSON），原文件已改名保存为 ${backup}`
}

/** 读-改-写：change(visible, reserved) → { next: 新的可见列表, result }。见上面的说明。 */
function mutateFilters(dir, change) {
  const file = filtersPath(dir)
  let backup = null
  for (let attempt = 1; ; attempt++) {
    const base = readForWrite(file)
    backup ??= base.backup
    let outcome
    try { outcome = change(base.visible, base.reserved) } catch (error) {
      if (backup !== null && error !== null && typeof error === 'object') {
        error.corruptBackup = backup
        if (typeof error.message === 'string') error.message += `（${backupNote(backup)}）`
      }
      throw error
    }
    const text = storeText(withPreserved(base.entries, checkedList(outcome.next)))
    const unchanged = () => { try { return readStoreText(file) === base.text } catch { return false } }
    if (writeFileAtomic(file, text, unchanged)) {
      const result = outcome.result
      if (backup !== null && result !== null && typeof result === 'object' && !Array.isArray(result)) {
        Object.assign(result, { corruptBackup: backup, warning: backupNote(backup) })
      }
      return result
    }
    if (attempt >= 2) {
      throw filterError('FILTERS_CONFLICT', `过滤器文件 ${FILTERS_FILE} 在保存过程中被别的进程改动了（多个宿主共用同一个捕获库目录？）：这次什么都没改，请重试`)
    }
  }
}

/**
 * 新建或更新一个命名过滤器。raw.id 是已有过滤器的 id → 更新（保留 createdAt，位置不变）；
 * 否则新建（追加在末尾；raw.id 给了就沿用）。名称不区分大小写唯一 → 否则 FILTER_NAME_TAKEN。
 * 返回 { filter, filters, created }（文件损坏被备份时另有 corruptBackup / warning）。
 */
export function upsertFilter(dir, raw) {
  const input = normalizeFilter(raw)
  const rawId = cleanId(raw.id)
  return mutateFilters(dir, (filters, reserved) => {
    const index = rawId === '' ? -1 : filters.findIndex((filter) => filter.id === rawId)
    const key = nameKey(input.name)
    const clash = filters.find((filter, position) => position !== index && nameKey(filter.name) === key)
    if (clash !== undefined) throw filterError('FILTER_NAME_TAKEN', `已有同名过滤器「${clash.name}」（名称不区分大小写）`, { existingId: clash.id })
    if (reserved.has(key)) throw filterError('FILTER_NAME_TAKEN', `已有同名过滤器「${input.name}」：文件里有一个当前版本读不了的同名过滤器（原样保留着，名称不区分大小写），请换个名称`)
    const now = Date.now()
    let filter
    let next
    if (index >= 0) {
      const previous = filters[index]
      filter = { ...input, id: previous.id, createdAt: previous.createdAt, updatedAt: Math.max(now, previous.updatedAt) }
      next = filters.map((item, position) => position === index ? filter : item)
    } else {
      if (filters.length >= MAX_FILTERS) throw invalid(`过滤器最多 ${MAX_FILTERS} 个，请先删掉不用的`)
      filter = { ...input, createdAt: now, updatedAt: now }
      next = [...filters, filter]
    }
    return { next, result: { filter, filters: next, created: index < 0 } }
  })
}

/** 按 id 删除；没有这个 id → FILTER_NOT_FOUND（带 available）。返回删除后的列表。 */
export function deleteFilter(dir, id) {
  const key = cleanId(id)
  return mutateFilters(dir, (filters) => {
    const index = key === '' ? -1 : filters.findIndex((filter) => filter.id === key)
    if (index < 0) throw notFound(`没有 id 为「${shown(id)}」的过滤器`, filters)
    const next = filters.filter((_, position) => position !== index)
    return { next, result: next }
  })
}

/** 依次按：id 完全相同 → 名称完全相同 → 名称不区分大小写；都没有返回 null。 */
export function findFilter(filters, nameOrId) {
  if (!Array.isArray(filters)) return null
  const raw = typeof nameOrId === 'number' && Number.isFinite(nameOrId) ? String(nameOrId) : typeof nameOrId === 'string' ? nameOrId : ''
  if (raw.trim() === '') return null
  const id = raw.trim()
  const name = cleanName(raw)
  const valid = filters.filter((filter) => typeof filter === 'object' && filter !== null)
  return valid.find((filter) => filter.id === raw || filter.id === id) ??
    valid.find((filter) => filter.name === name) ??
    valid.find((filter) => typeof filter.name === 'string' && nameKey(filter.name) === nameKey(name)) ??
    null
}

/** 导出信封：{ format, version: 1, exportedAt, filters }。 */
export function exportFilters(filters) {
  const list = (Array.isArray(filters) ? filters : []).map((filter, index) => {
    try { return normalizeFilter(filter) } catch (error) { throw prefixFilterError(error, index, filter) }
  })
  return { format: FILTERS_FORMAT, version: 1, exportedAt: new Date().toISOString(), filters: list }
}

const importInvalid = (message) => filterError('IMPORT_INVALID', message)

function importItems(input) {
  let data = input
  if (typeof data === 'string') {
    const text = data.trim().replace(/^\uFEFF/, '')
    if (text === '') throw importInvalid('导入内容为空')
    try { data = JSON.parse(text) } catch (error) { throw importInvalid(`导入内容不是合法的 JSON：${error.message}`) }
  }
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    if (typeof data.format === 'string' && data.format !== FILTERS_FORMAT) {
      throw importInvalid(`这不是过滤器导出文件（format 是「${shown(data.format)}」，需要「${FILTERS_FORMAT}」）`)
    }
    if (data.version !== undefined && Number(data.version) !== 1) throw importInvalid(`不支持的过滤器导出版本「${shown(data.version)}」（只支持 1）`)
    if (Array.isArray(data.filters)) return data.filters
    throw importInvalid('导入内容里没有 filters 数组')
  }
  throw importInvalid('导入内容必须是过滤器导出文件（{ format, version, filters }）或过滤器数组')
}

const SUFFIXED = /^(.*) \((\d+)\)$/
/** 「名称 (3)」→「名称」：导入时改名用的编号后缀不算名称本身。 */
const stemOf = (name) => { const match = SUFFIXED.exec(name); return match === null ? name : match[1] }

/** 名称的第一个空闲变体「名称 (2)」「名称 (3)」…（从去掉编号后缀的名称起算；超长时截短，保证不超过名称上限）。 */
function freeName(name, taken) {
  const stem = stemOf(name)
  for (let number = 2; ; number++) {
    const suffix = ` (${number})`
    const candidate = clip(stem, MAX_NAME - suffix.length, '').trimEnd() + suffix
    if (!taken.has(nameKey(candidate))) return candidate
  }
}

/**
 * 导入命名过滤器，全有或全无（任何一个不合法 → 什么都不写）。input = 导出信封 / 过滤器数组 / 它们的 JSON 字符串。
 *   merge（默认）：与已有过滤器「名称相同（不区分大小写）且内容相同（mode + 条件，忽略 id）」的跳过；
 *     名称相同内容不同的改名为「名称 (2)」「(3)」…（编号从去掉已有编号后缀的名称起算；某个已有的「名称 (k)」内容相同时
 *     同样跳过，重复导入同一个文件不会越积越多）；导入的过滤器一律换新 id。
 *   replace：列表变成导入的这一份（id 不冲突就沿用；文件内部重复的同样跳过 / 改名）。
 * 返回 { filters, imported, skipped, renamed: [{ from, to }], mode }（imported / skipped 是个数，renamed 是改名明细）。
 * 输入不合法 → IMPORT_INVALID；某个过滤器不合法 → FILTER_INVALID，message 点名「第 N 个过滤器」。
 */
export function importFilters(dir, input, { mode = 'merge' } = {}) {
  const how = String(mode ?? 'merge').trim().toLowerCase() || 'merge'
  if (how !== 'merge' && how !== 'replace') throw importInvalid(`导入方式只能是 merge（合并）或 replace（替换），收到「${shown(mode)}」`)
  const items = importItems(input)
  if (items.length > MAX_FILTERS) throw importInvalid(`一次最多导入 ${MAX_FILTERS} 个过滤器（文件里有 ${items.length} 个）`)
  const incoming = items.map((item, index) => {
    try { return normalizeFilter(item) } catch (error) { throw prefixFilterError(error, index, item) }
  })
  // existing = 当前可见的过滤器；reserved = 文件里原样保留的（当前版本读不了的）条目占用的名称：撞上就改名
  const merge = (existing, reserved) => {
    const result = [...existing]
    const byName = new Map(result.map((filter) => [nameKey(filter.name), filter]))
    for (const key of reserved) if (!byName.has(key)) byName.set(key, null)
    const ids = new Set(result.map((filter) => filter.id))
    let imported = 0
    let skipped = 0
    const renamed = []
    for (const filter of incoming) {
      const content = contentKey(filter)
      const clash = byName.get(nameKey(filter.name))
      let name = filter.name
      if (clash !== undefined) {
        // 同名（不区分大小写，编号后缀不算）且内容相同的已经有了 ⇒ 跳过；重复导入同一个文件不会越积越多
        const stem = stemOf(nameKey(filter.name))
        const sameContent = result.some((existing) => stemOf(nameKey(existing.name)) === stem && contentKey(existing) === content)
        if (sameContent) { skipped++; continue }
        name = freeName(filter.name, byName)
        renamed.push({ from: filter.name, to: name })
      }
      const id = how === 'merge' || ids.has(filter.id) ? randomUUID() : filter.id
      const entry = { ...filter, id, name }
      result.push(entry)
      byName.set(nameKey(name), entry)
      ids.add(id)
      imported++
    }
    if (result.length > MAX_FILTERS) throw importInvalid(`导入后共有 ${result.length} 个过滤器，超过上限 ${MAX_FILTERS}；请先删掉一些或改用替换`)
    return { next: result, result: { filters: result, imported, skipped, renamed, mode: how } }
  }
  // merge 是读-改-写（保留读不了的条目、损坏的文件先备份，见 mutateFilters）；replace 本来就是「列表变成导入的这一份」，直接整体写
  if (how === 'merge') return mutateFilters(dir, merge)
  const { next, result } = merge([], new Set())
  saveFilters(dir, next)
  return result
}

// ---------------------------------------------------------------- 查询入口

/**
 * 把查询参数里的 filter（已保存过滤器的名称或 id）与 conditions（过滤器对象 / 数组 / 它们的 JSON 字符串）
 * 解析成交给 queryRecords 的 conditions。两个都给时同时生效（AND，已保存的在前）。
 * 返回 { conditions: Filter[] | null, applied: [{ name, description }] }。
 *   filter 找不到 → FILTER_NOT_FOUND（.available = 已保存的名称）；conditions 不合法 → FILTER_INVALID。
 * dir 只在给了 filter 时需要；realtimeProcess 只为与调用方对称而接受（进程回退由 compileFilter 在查询时做）。
 */
export function resolveQueryConditions({ filter, conditions } = {}, { dir } = {}) {
  const list = []
  const applied = []
  if (filter !== undefined && filter !== null && typeof filter !== 'string' && typeof filter !== 'number') {
    throw invalid('filter 要填已保存过滤器的名称或 id；过滤器对象请用 conditions 传')
  }
  const key = filter === undefined || filter === null ? '' : String(filter).trim()
  if (key !== '') {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('resolveQueryConditions: dir is required to look up saved filters')
    const saved = loadFilters(dir)
    const found = findFilter(saved, key)
    if (found === null) throw notFound(`没有名称或 id 为「${shown(key)}」的已保存过滤器`, saved)
    list.push(found)
    applied.push({ name: found.name, description: describeFilter(found) })
  }
  const adhoc = normalizeFilterInput(conditions) ?? []
  const unnamed = adhoc.filter((item) => item.name === '').length
  let number = 0
  for (const item of adhoc) {
    list.push(item)
    const name = item.name !== '' ? item.name : unnamed > 1 ? `临时条件 ${++number}` : '临时条件'
    applied.push({ name, description: describeFilter(item) })
  }
  return { conditions: list.length > 0 ? list : null, applied }
}

const PROCESS_NAME_TTL_MS = 60000
let processNameCache = null

/**
 * 实时捕获记录所属的客户端进程名：DSH_UI_PROC_NAME（进程环境 → 注册表回退，见 env-fallback），
 * 去掉目录与 .exe；没配置时为 ''。结果缓存 60 秒（fresh=true 跳过本层缓存）；
 * 进程环境里的值一变（宿主载入配置文件、校验脚本改 process.env）就立即重算，不等 60 秒。
 * 注册表由 env-fallback 按进程缓存（它的约定：每个进程最多问一次注册表），这里不会周期性地同步 spawn reg.exe。
 */
export function realtimeProcessName({ fresh = false } = {}) {
  const now = Date.now()
  const direct = process.env.DSH_UI_PROC_NAME
  const cached = processNameCache
  if (!fresh && cached !== null && cached.direct === direct && now - cached.at < PROCESS_NAME_TTL_MS) return cached.value
  let value = ''
  try { value = cleanProcessName(String(envOr('DSH_UI_PROC_NAME') || '')) } catch { value = '' }
  processNameCache = { value, at: now, direct }
  return value
}
