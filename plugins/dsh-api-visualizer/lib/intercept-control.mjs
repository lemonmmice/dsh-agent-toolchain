/**
 * capture_rules / capture_intercept / capture_netsim 三个工具的**唯一**实现（动作分派 + 摘要）。
 *
 * 为什么单独成模块：同一组工具在两面都有（DSH 面 api_capture_* 直接调宿主里的代理对象；MCP 面在另一个进程，
 * 只能走宿主的回环路由）。动作语义若写两份，迟早一边改了另一边没改（本仓反复抓到的一类错）。
 * 这里只依赖注入的 `api`（传输层），两面各给一个适配器：
 *   api = { getRules, setRules, ruleOp, getRule, quickRule, exportRules, importRules,
 *           interceptStatus, interceptStart, interceptStop, suggest, getNetsim, setNetsim }
 * 每个方法返回 Promise<object>；失败统一是 { ok:false, error, code? }（code 见 explainRuleError）。
 *   exportRules({ path?, overwrite? }) → { ok, path, count, bytes }（宿主把规则信封写成 .json 文件）
 *   importRules({ path? | data?, mode }) → { imported, skipped, mode, warnings, total, enabled, revision, rules }
 *     （path = 宿主去读的 .json 文件；data = 信封 / 规则数组 / 它们的 JSON 文本；全有或全无）
 *
 * 输出约定（两面共用）：
 *   · `summary` 永远是返回对象的**第一个键**：MCP 客户端按长度截断时丢的是末尾，最该留下的就是这句人话；
 *     DSH 面只渲染 summary（所以 summary 自己要够用）。
 *   · 规则只回**紧凑投影**（projectRule：响应体只给字节数 + 160 字预览，不回编译后的 ops）。
 *     一条规则的完整内容只走 action=get，响应体也封顶 20000 字符并明说截断。
 *     （旧实现每次 list/add/enable 都把所有规则的完整 mock 正文回给 agent：一条 1MB 的"原响应"规则就能把上下文冲掉。）
 *   · 提示里点名的工具按**面**取名（DSH 面 api_capture_*，MCP 面 capture_*）：照着抄就能调通。
 */

// ------------------------------------------------------------------ 两面的工具名

const DSH_NAMES = Object.freeze({
  capture_rules: 'api_capture_rules',
  capture_intercept: 'api_capture_intercept',
  capture_netsim: 'api_capture_netsim',
  capture_query: 'api_capture_query',
  capture_start: 'api_capture_start',
  capture_status: 'api_capture_status',
  capture_stop: 'api_capture_stop',
})

const normFace = (face) => (String(face ?? '').trim().toLowerCase() === 'dsh' ? 'dsh' : 'mcp')

/** 逻辑名（= MCP 面名，如 capture_rules）→ 该面真实的工具名。ui_* 等两面同名的原样返回。 */
export function faceToolName(logical, face = 'mcp') {
  return normFace(face) === 'dsh' && Object.hasOwn(DSH_NAMES, logical) ? DSH_NAMES[logical] : logical
}

// ------------------------------------------------------------------ 小工具

const RULE_TYPES = ['mock', 'map-local', 'map-remote', 'rewrite', 'delay', 'hang', 'block', 'rewrite-status']
const URL_TYPES = ['path', 'contains', 'glob', 'regex']
/** 只有"变慢"可以不写匹配条件（作用于全部请求）；其余动作必须指定 URL/域名/方法，或显式 matchAll:true。 */
const CATCH_ALL_OK = new Set(['delay'])
const PREVIEW_CHARS = 160
const GET_BODY_CAP = 20000
const LIST_LINES_MAX = 80
const NETSIM_FIELDS = ['enabled', 'preset', 'requestDelayMs', 'responseDelayMs', 'jitterMs', 'downKbps', 'upKbps', 'hosts', 'urlFilter', 'scope']
const NETSIM_SCOPES = ['all', 'intercept', 'proxy']

/** 顶层写错位置的字段 → 它该在的位置（C13：顶层 url 会被当成"匹配全部"的规则放到最前）。 */
const MISPLACED = {
  url: 'match.url',
  urlType: 'match.urlType',
  method: 'match.method',
  host: 'match.host',
  type: 'action.type',
  body: 'action.body',
  status: 'action.status',
  file: 'action.file',
  target: 'action.target',
  script: 'action.script',
  headers: 'action.headers',
  charset: 'action.charset',
  latencyMs: 'action.latencyMs',
  responseDelayMs: 'action.responseDelayMs',
  jitterMs: 'action.jitterMs',
  throttleKbps: 'action.throttleKbps',
}
const SHAPE_HINT = '规则必须是嵌套结构：{"name":"空列表","match":{"url":"/api/list","urlType":"path","method":"GET","host":"api.example.com"},"action":{"type":"mock","status":200,"body":"[]"}}' +
  '（match 里 url/urlType/method/host 按需写；action.type 可选 ' + RULE_TYPES.join(' / ') + '）'

/** 规则导出 / 导入（export / import）。 */
const RULES_FORMAT = 'dsh-api-visualizer/rules'
const FILTERS_FORMAT = 'dsh-api-visualizer/filters'
const IMPORT_MODES = ['merge', 'replace']
/** 导入摘要里最多列出多少条导入的规则 / 多少条告警（数组本身是完整的）。 */
const IMPORT_LIST_MAX = 20
const IMPORT_WARN_MAX = 30
const importShapeHint = (T) => `要的是 ${T('capture_rules')} action=export 导出的规则文件（{"format":"${RULES_FORMAT}","version":1,…,"rules":[…]}），或规则对象的数组 [{"name":…,"match":{…},"action":{…}}, …]`

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const oneLine = (v) => str(v).replace(/\s+/g, ' ').trim()
const given = (v) => v !== undefined && v !== null
const byteLen = (s) => Buffer.byteLength(s, 'utf8')
const errText = (e) => (e instanceof Error ? e.message : String(e))

/** 截到 max 个 UTF-16 单元以内（含末尾省略号），不劈开代理对。 */
function clip(v, max) {
  const t = str(v)
  if (t.length <= max) return t
  return cutAt(t, max - 1) + '…'
}

/** 前 n 个 UTF-16 单元（末尾是高代理项就退一位，不留半个字符）。 */
function cutAt(t, n) {
  let end = Math.max(0, n)
  if (end > 0 && end < t.length) {
    const c = t.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end--
  }
  return t.slice(0, end)
}

/** 改写脚本的有效行数（空行、# 注释不算）。 */
function scriptLineCount(script) {
  return str(script).split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length
}

/**
 * 组装返回值：summary 恒为**第一个键**，其后 ok，再其后各部分的字段（undefined 丢掉；
 * 后面的部分不会覆盖 summary / ok）。
 */
function out(summary, ok, ...parts) {
  const o = { summary, ok }
  for (const p of parts) {
    if (!isObj(p)) continue
    for (const [k, v] of Object.entries(p)) {
      if (k === 'summary' || k === 'ok' || v === undefined) continue
      o[k] = v
    }
  }
  return o
}

/** 失败返回不带规则正文（rules/rule 可能是整表的 mock 正文）。 */
const DROP_ON_FAIL = new Set(['summary', 'ok', 'error', 'rules', 'rule'])

/** 失败：summary 第一、ok:false、error 是给人看的那句；extra 里的 hint 也写进 summary（DSH 面只看 summary）。 */
function fail(error, extra = null) {
  const o = { summary: '✗ ' + error, ok: false, error }
  if (isObj(extra)) {
    if (typeof extra.hint === 'string' && extra.hint.trim() !== '') o.summary += '\n' + extra.hint.trim()
    for (const [k, v] of Object.entries(extra)) {
      if (DROP_ON_FAIL.has(k) || v === undefined || Object.hasOwn(o, k)) continue
      o[k] = v
    }
  }
  return o
}

/**
 * api 调用结果是不是失败：null/非对象、ok:false；没写 ok 时，只有"带 error 字符串、又没有任何正常结果字段
 * （payloadKeys）"才算失败 —— 进程内适配层直接回引擎对象（不带 ok），正常结果里也可能有叫 error 的字段。
 */
function failed(r, payloadKeys = []) {
  if (!isObj(r)) return true
  if (r.ok === false) return true
  if (r.ok === true) return false
  if (typeof r.error !== 'string' || r.error.trim() === '') return false
  return !payloadKeys.some((k) => Object.hasOwn(r, k))
}

/** 成功结果里传输层的噪音字段（MCP 面回环路由会带 httpStatus）。 */
function stripTransport(r) {
  if (!isObj(r)) return {}
  const { httpStatus: _h, ...rest } = r
  return rest
}

const rawError = (r, fallback) => (isObj(r) && typeof r.error === 'string' && r.error.trim() !== '' ? r.error.trim() : fallback)

/** 宿主的通用 404（路由不存在）：多半是宿主还在跑旧版插件（宿主不热加载）。 */
const isMissingRoute = (r) => isObj(r) && r.httpStatus === 404 && !given(r.code) && /^not found$/i.test(rawError(r, ''))

/** 报错里点名的文件：宿主回的 path 优先（它是规范化后的真实路径），其次是调用方给的。 */
const pathOf = (r, requested) => {
  const p = isObj(r) && typeof r.path === 'string' && r.path.trim() !== '' ? r.path.trim() : str(requested).trim()
  return p !== '' ? p : '（未给出路径）'
}

/**
 * 把引擎 / 路由的错误码翻成能照着做的中文（RULE_INVALID / RULE_NOT_FOUND / RULES_CONFLICT / BODY_TOO_LARGE，
 * 以及规则导出 / 导入的 IMPORT_INVALID / IMPORT_FILE_NOT_FOUND / EXPORT_EXISTS / EXPORT_PATH_INVALID）。
 * 原始报错保留在 detail 里。
 */
function explainRuleError(r, fallback, T, { id, op, path } = {}) {
  const raw = rawError(r, fallback)
  const code = isObj(r) && typeof r.code === 'string' && r.code !== '' ? r.code : undefined
  const listHint = `先 ${T('capture_rules')} action=list 看当前的 id`
  const tool = T('capture_rules')
  let msg = raw
  if (isMissingRoute(r)) {
    msg = `宿主没有这个接口（HTTP 404 ${raw}）：DSH 宿主多半还在跑旧版插件（宿主不热加载插件代码），重启 DSH 宿主后再试`
  } else if (code === 'RULE_NOT_FOUND' || (code === undefined && isObj(r) && r.httpStatus === 404 && ['get', 'remove', 'enable', 'disable'].includes(op))) {
    msg = `没有 id=${id ?? '?'} 的规则（可能已被删除，或规则列表被面板 / 另一个会话改过）：${listHint}`
  } else if (code === 'RULE_INVALID') {
    msg = op === 'mock' ? `一键规则没加上：${raw}`
      : op === 'import' ? `导入的文件里有规则不合法，整份都没有导入（宿主全有或全无）：${raw}`
        : `规则不合法，宿主拒收：${raw}`
  } else if (code === 'RULES_CONFLICT') {
    msg = op === 'import'
      ? `规则列表在导入过程中被别处改过（面板或另一个会话），这次导入没有写入：再执行一次 ${tool} action=import`
      : `规则列表在读取之后被别处改过（面板或另一个会话），这次改动没有写入：${listHint}，再重做这一步`
  } else if (code === 'BODY_TOO_LARGE') {
    msg = op === 'import'
      ? `导入内容太大，宿主拒收：把规则文件存成本地 .json，改用 ${tool} action=import path=<文件的绝对路径>（由宿主直接读文件）`
      : '请求体太大，宿主拒收：大的响应体改用 Map Local（action.type=map-local，action.file 指向本地文件的绝对路径）'
  } else if (code === 'IMPORT_INVALID') {
    // 宿主把"内容不对"和"路径不对"（相对路径、不是 .json、文件太大）都报成 IMPORT_INVALID：开头只说被拒，原因照抄宿主的
    msg = `导入被宿主拒绝，一条都没有导入：${raw}。` +
      (str(path).trim() !== '' ? 'path 要写宿主所在机器上 .json 文件的绝对路径；' : '') + importShapeHint(T)
  } else if (code === 'IMPORT_FILE_NOT_FOUND') {
    msg = `宿主读不到要导入的文件 ${pathOf(r, path)}，一条都没有导入：path 要写宿主所在机器上已存在的 .json 文件的绝对路径` +
      '（也可以不写 path，把文件内容直接放进 ruleJson）'
  } else if (code === 'EXPORT_EXISTS') {
    // 没给 path 时是默认位置按时间戳起名撞上了已有文件：overwrite 管不到默认位置，别让人去加它
    msg = str(path).trim() === ''
      ? `默认导出位置已有同名文件 ${pathOf(r, path)}，没有覆盖：过一秒再导出一次，或给一个 path`
      : `导出目标 ${pathOf(r, path)} 已存在，没有覆盖：确实要覆盖就加 overwrite=true，或换一个 path（不写 path 就按时间戳新建文件）`
  } else if (code === 'EXPORT_PATH_INVALID') {
    msg = op === 'import'
      ? `要导入的文件路径不合法：${raw}。path 要写绝对路径、以 .json 结尾`
      : `导出路径不合法：${raw}。path 要写绝对路径、以 .json 结尾，所在目录必须已经存在（不写 path 就导出到捕获库目录下的 exports/）`
  }
  return fail(msg, {
    code,
    ...(msg !== raw ? { detail: raw } : {}),
    httpStatus: isObj(r) ? r.httpStatus : undefined,
    hint: isObj(r) ? r.hint : undefined,
    revision: isObj(r) ? r.revision : undefined,
    // 导出 / 导入失败时点名的文件（宿主回的规范化路径优先）
    path: (op === 'export' || op === 'import') && (isObj(r) && typeof r.path === 'string' && r.path !== '' ? true : str(path).trim() !== '')
      ? pathOf(r, path)
      : undefined,
  })
}

/** 适配层缺方法（插件与宿主 / MCP 版本不一致）：说清楚，而不是抛 "x is not a function"。 */
function missing(api, ...names) {
  const lack = names.filter((n) => !api || typeof api[n] !== 'function')
  return lack.length === 0 ? null : fail(`传输层缺少 ${lack.join(' / ')}（插件代码与宿主 / MCP 服务版本不一致？重启 DSH 宿主与 MCP 服务后再试）`)
}

// ------------------------------------------------------------------ 规则：投影与摘要

/**
 * 紧凑投影（C10）：每条规则只回识别与判断所需的字段 —— 响应体只给 UTF-8 字节数 + 至多 160 字预览，
 * 改写脚本只给行数，响应头只给个数；编译后的 ops 一律不回。完整内容走 action=get。
 */
export function projectRule(r) {
  if (!isObj(r)) return r
  const a = isObj(r.action) ? r.action : {}
  const m = isObj(r.match) ? r.match : {}
  const action = { type: a.type }
  if (Number.isInteger(a.status)) action.status = a.status
  for (const k of ['latencyMs', 'responseDelayMs', 'jitterMs', 'throttleKbps']) {
    if (Number(a[k]) > 0) action[k] = Number(a[k])
  }
  if (typeof a.file === 'string' && a.file !== '') action.file = a.file
  if (typeof a.target === 'string' && a.target !== '') action.target = a.target
  if (typeof a.charset === 'string' && a.charset !== '') action.charset = a.charset
  const headerCount = isObj(a.headers) ? Object.keys(a.headers).length : Array.isArray(a.headers) ? a.headers.length : 0
  if (headerCount > 0) action.headerCount = headerCount
  if (typeof a.body === 'string' && (a.body !== '' || a.type === 'mock')) {
    action.bodyBytes = byteLen(a.body)
    if (a.body !== '') action.bodyPreview = clip(a.body, PREVIEW_CHARS)
  }
  if (typeof a.script === 'string' && a.script.trim() !== '') action.scriptLines = scriptLineCount(a.script)
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled !== false,
    quick: r.quick === true,
    matchAll: r.matchAll === true,
    match: { method: str(m.method), host: str(m.host), url: str(m.url), urlType: str(m.urlType) || 'contains' },
    action,
    hits: Number(r.hits) || 0,
  }
}

function matchText(r) {
  const m = isObj(r.match) ? r.match : {}
  const url = str(m.url)
  const host = str(m.host)
  const where = url === '' && host === ''
    ? (r.matchAll === true ? '(全部请求 · matchAll)' : '(全部)')
    : `${host !== '' ? host + ' ' : ''}${url !== '' ? url : '(该域名全部)'}`
  return `${str(m.method) || '*'} ${where} (${str(m.urlType) || 'contains'})`
}

function ruleLine(r) {
  if (!isObj(r)) return '(无)'
  const a = isObj(r.action) ? r.action : {}
  const body = typeof a.body === 'string' ? a.body : ''
  const what = a.type === 'mock' ? `mock ${a.status ?? 200}${body !== '' ? ` · ${clip(oneLine(body), 41)}` : ' · 空响应体'}`
    : a.type === 'map-local' ? `Map Local ← ${a.file}`
      : a.type === 'map-remote' ? `Map Remote → ${a.target}`
        : a.type === 'rewrite' ? `改写 ${scriptLineCount(a.script) || (Array.isArray(a.ops) ? a.ops.length : 0)} 条指令`
          : a.type === 'hang' ? `挂起 ${Number(a.latencyMs) > 0 ? Math.round(Number(a.latencyMs) / 1000) + 's' : '（默认时长）'}`
            : a.type === 'block' ? '阻断'
              : a.type === 'rewrite-status' ? `改状态码 ${a.status}`
                : a.type === 'delay' ? '延迟'
                  : `未知动作 ${a.type}`
  const lat = [
    Number(a.latencyMs) > 0 && a.type !== 'hang' ? `请求延迟 ${a.latencyMs}ms` : '',
    Number(a.responseDelayMs) > 0 ? `回包延迟 ${a.responseDelayMs}ms` : '',
    Number(a.jitterMs) > 0 ? `±${a.jitterMs}ms` : '',
    Number(a.throttleKbps) > 0 ? `限速 ${a.throttleKbps}KB/s` : '',
  ].filter(Boolean).join(' ')
  return `${r.enabled === false ? '○' : '●'} [${r.id}] ${clip(oneLine(r.name), 80)}${r.quick === true ? '（一键）' : ''} | ${matchText(r)} → ${what}${lat ? ' · ' + lat : ''} | 命中 ${Number(r.hits) || 0}`
}

/** 规则清单的人话版（一条一行；超过 80 条只列前 80 条）。 */
export function rulesSummary(data) {
  const rules = Array.isArray(data?.rules) ? data.rules : []
  if (rules.length === 0) return '当前没有规则。'
  const shown = rules.slice(0, LIST_LINES_MAX)
  return `规则 ${rules.length} 条（启用 ${rules.filter((r) => isObj(r) && r.enabled !== false).length}；排在前面的先匹配）：\n` +
    shown.map(ruleLine).join('\n') +
    (rules.length > shown.length ? `\n…另有 ${rules.length - shown.length} 条未列出` : '')
}

function rulesPayload(r) {
  const rules = Array.isArray(r.rules) ? r.rules : []
  return {
    total: Number.isInteger(r.total) ? r.total : rules.length,
    enabled: Number.isInteger(r.enabled) ? r.enabled : rules.filter((x) => isObj(x) && x.enabled !== false).length,
    revision: r.revision,
    rules: rules.map(projectRule),
  }
}

/** action=get：完整规则，响应体封顶 GET_BODY_CAP 字符（截断时明说）。 */
function capRuleBody(rule) {
  const a = isObj(rule.action) ? rule.action : null
  const body = a !== null && typeof a.body === 'string' ? a.body : null
  if (body === null || body.length <= GET_BODY_CAP) return { rule, truncated: false, bodyChars: body === null ? 0 : body.length }
  const shown = cutAt(body, GET_BODY_CAP)
  return {
    rule: { ...rule, action: { ...a, body: shown } },
    truncated: true,
    bodyChars: body.length,
    note: `action.body 已截断：共 ${body.length} 字符（${byteLen(body)} 字节），这里只回前 ${shown.length} 字符；规则本身没有被改动`,
  }
}

function ruleDetail(rule, capped, face) {
  const a = isObj(rule.action) ? rule.action : {}
  const lines = [ruleLine(rule)]
  lines.push(`匹配：${matchText(rule)}${rule.matchAll === true ? ' · matchAll' : ''}`)
  const fields = ['status', 'latencyMs', 'responseDelayMs', 'jitterMs', 'throttleKbps', 'charset', 'file', 'target']
    .filter((k) => given(a[k]) && a[k] !== '' && !(typeof a[k] === 'number' && a[k] === 0 && k !== 'status'))
    .map((k) => `${k}=${a[k]}`)
  lines.push(`动作：${a.type ?? '?'}${fields.length > 0 ? ' · ' + fields.join(' · ') : ''}`)
  if (isObj(a.headers) && Object.keys(a.headers).length > 0) {
    lines.push(`响应头（${Object.keys(a.headers).length} 个）：` + Object.entries(a.headers).map(([k, v]) => `${k}: ${clip(oneLine(v), 200)}`).join('；'))
  }
  if (typeof a.script === 'string' && a.script.trim() !== '') lines.push('改写脚本：\n' + a.script.split(/\r?\n/).map((l) => '  ' + l).join('\n'))
  const body = isObj(capped.rule.action) && typeof capped.rule.action.body === 'string' ? capped.rule.action.body : ''
  if (body !== '' || a.type === 'mock') {
    // DSH 面只渲染 summary ⇒ 正文必须写进来；MCP 面整份 JSON 都在，正文就只放 rule.action.body 一处，不重复两遍。
    if (face === 'dsh') lines.push(`响应体（共 ${capped.bodyChars} 字符）：` + (body === '' ? '（空）' : '\n' + body))
    else lines.push(`响应体：共 ${capped.bodyChars} 字符，见 rule.action.body`)
  }
  if (capped.truncated) lines.push('⚠ ' + capped.note)
  return lines.join('\n')
}

/** 一键规则能不能被命中（C9）：以宿主按 URL 算出的 reach 为准；旧宿主没有 reach 时退回粗粒度字段并明说。 */
function reachNote(r, url, T) {
  const reach = isObj(r.reach) ? r.reach : null
  if (reach === null) {
    if (r.takesEffect === false) return `⚠ 现在本地代理和透明拦截都没开 ⇒ 规则**暂不生效**。客户端若强制直连，先 ${T('capture_intercept')} action=start（hosts 重定向）。`
    if (r.interceptActive === true) return `透明拦截在线（宿主版本较旧，判断不了这个域名在不在拦截名单里：用 ${T('capture_intercept')} action=status 核对）。`
    if (r.takesEffect === true) return '本地代理在线：经过代理的请求会命中这条规则（强制直连的客户端不经过它）。'
    return ''
  }
  let host = str(reach.host)
  if (host === '') {
    try { host = new URL(url).hostname } catch { host = '' }
  }
  const note = oneLine(reach.note)
  const lines = [reach.takesEffect === false
    ? '⚠ 规则**暂时打不到**：' + (note || '没有任何经过本插件的入口能拿到这个 URL 的请求')
    : (note || '规则现在能被命中')]
  const hostArg = host !== '' ? host : '<接口域名>'
  if (reach.intercept === 'not-listed') {
    lines.push(`要让强制直连的客户端也命中：把 ${hostArg} 加进透明拦截名单 —— ${T('capture_intercept')} action=start hosts="<当前名单> ${hostArg}"（start 写的是**完整名单**、会替换旧名单；当前名单看 ${T('capture_intercept')} action=status）`)
  } else if (reach.intercept === 'draining') {
    lines.push(`透明拦截正在排空（期间不套规则）：要继续拦截就重新 ${T('capture_intercept')} action=start`)
  } else if (reach.intercept === 'off' && reach.viaIntercept !== true) {
    lines.push(`客户端若强制直连（不走代理），先 ${T('capture_intercept')} action=start hosts="${hostArg}"`)
  }
  return lines.join('\n')
}

/** add 的输入校验（C13）：形状写错的规则以前会变成"匹配全部"的 mock、排在最前，把登录/会话/行情全改掉。 */
function validateRuleInput(rule) {
  const misplaced = Object.keys(MISPLACED).filter((k) => Object.hasOwn(rule, k))
  if (misplaced.length > 0) {
    return `ruleJson 顶层不能有 ${misplaced.join(' / ')}（应分别写在 ${misplaced.map((k) => MISPLACED[k]).join(' / ')}）。` + SHAPE_HINT
  }
  if (!isObj(rule.match)) return 'ruleJson 缺少 match 对象。' + SHAPE_HINT
  if (!isObj(rule.action)) return 'ruleJson 缺少 action 对象。' + SHAPE_HINT
  const type = rule.action.type
  if (typeof type !== 'string' || type.trim() === '') return `action.type 必填（${RULE_TYPES.join(' / ')}）。` + SHAPE_HINT
  if (!RULE_TYPES.includes(type)) return `不认识的 action.type=${type}（只能是 ${RULE_TYPES.join(' / ')}）`
  for (const k of ['url', 'host', 'method', 'urlType']) {
    if (given(rule.match[k]) && typeof rule.match[k] !== 'string') return `match.${k} 要是字符串`
  }
  if (typeof rule.match.urlType === 'string' && rule.match.urlType !== '' && !URL_TYPES.includes(rule.match.urlType)) {
    return `match.urlType 只能是 ${URL_TYPES.join(' / ')}（path=接口路径忽略查询串 / contains=子串 / glob=通配 * / regex=正则）`
  }
  for (const k of ['enabled', 'matchAll']) {
    if (given(rule[k]) && typeof rule[k] !== 'boolean') return `${k} 要是 true / false（不是字符串）`
  }
  if (given(rule.action.status)) {
    const st = Number(rule.action.status)
    if (!Number.isInteger(st) || st < 100 || st > 599) return 'action.status 要是 100–599 的整数'
  } else if (type === 'rewrite-status') {
    return 'rewrite-status 规则需要 action.status（100–599）'
  }
  for (const k of ['latencyMs', 'responseDelayMs', 'jitterMs', 'throttleKbps']) {
    if (given(rule.action[k]) && !(Number.isFinite(Number(rule.action[k])) && Number(rule.action[k]) >= 0)) return `action.${k} 要是 ≥0 的数字（毫秒；throttleKbps 是 KB/s）`
  }
  const scoped = ['url', 'host', 'method'].some((k) => typeof rule.match[k] === 'string' && rule.match[k].trim() !== '')
  if (!scoped && !CATCH_ALL_OK.has(type) && rule.matchAll !== true) {
    return `这条 ${type} 规则没写 match.url / match.host / match.method ⇒ 会命中**所有**请求（登录、会话、行情全都会被改）。` +
      '确实要这样就显式加 "matchAll": true；否则在 match 里写上接口地址。' + SHAPE_HINT
  }
  return null
}

// ------------------------------------------------------------------ 规则导出 / 导入

/** 可选的文件路径参数：没给 / 空白 = 没给（value undefined）；给了别的类型 = error。 */
function optPath(v) {
  if (!given(v)) return { value: undefined }
  if (typeof v !== 'string') return { error: 'path 要是文件路径字符串（绝对路径，以 .json 结尾）' }
  const t = v.trim()
  return { value: t === '' ? undefined : t }
}

/**
 * action=import 的 ruleJson：本地只校验"能不能当规则文件用"，为的是早、准地报错；
 * 交给宿主的是**原文**（字符串照传字符串，只去掉开头的 BOM）—— 宿主是唯一的解析者，这里不做二次序列化。
 * 返回 { data }（data undefined = 没给）或 { error }（fail() 的结果）。
 */
function importData(raw, T) {
  let value = raw
  let data = raw
  if (typeof raw === 'string') {
    const text = raw.replace(/^\uFEFF/, '')
    if (text.trim() === '') return { data: undefined }
    try {
      value = JSON.parse(text)
    } catch (e) {
      return { error: fail(`ruleJson 不是合法 JSON：${errText(e)}。${importShapeHint(T)}`, { code: 'IMPORT_INVALID' }) }
    }
    data = text
  } else if (!given(raw)) {
    return { data: undefined }
  }
  if (Array.isArray(value) || (isObj(value) && Array.isArray(value.rules))) return { data }
  if (isObj(value) && (value.format === FILTERS_FORMAT || Array.isArray(value.filters))) {
    return { error: fail(`这是过滤器文件（面板「过滤器」导出的），不是规则文件：过滤器在面板「过滤器」对话框里导入。${importShapeHint(T)}`, { code: 'IMPORT_INVALID' }) }
  }
  if (isObj(value) && (isObj(value.match) || isObj(value.action))) {
    return { error: fail(`ruleJson 是**一条**规则，不是规则文件：单条规则用 ${T('capture_rules')} action=add ruleJson=…；要按导入处理就包成数组 [ … ]`, { code: 'IMPORT_INVALID' }) }
  }
  return { error: fail(`ruleJson 不是规则文件。${importShapeHint(T)}`, { code: 'IMPORT_INVALID' }) }
}

/** 导入告警（引擎给的是字符串，如「第 2 条「名称」：Map Local 文件不存在：…」；对象也认）。 */
function warningText(w) {
  const t = typeof w === 'string' ? w : isObj(w) ? str(w.message ?? w.warning ?? w.text ?? JSON.stringify(w)) : str(w)
  return clip(oneLine(t).replace(/^⚠\s*/, ''), 500)
}

/**
 * 导入结果：只回条数、告警与导入规则的 id —— **不回规则正文**（一份规则文件可能带几十条 MB 级的 mock）。
 * 合并时导入的规则按文件顺序插在最前，替换时整张表就是导入的那份 ⇒ 两种情况下都是表头的前 imported 条。
 */
function importResult(r, requestedMode, tool) {
  const mode = IMPORT_MODES.includes(r.mode) ? r.mode : requestedMode
  const rules = Array.isArray(r.rules) ? r.rules : null
  const imported = Number.isInteger(r.imported) ? r.imported : null
  const skipped = Number.isInteger(r.skipped) ? r.skipped : null
  const total = Number.isInteger(r.total) ? r.total : rules !== null ? rules.length : null
  const enabled = Number.isInteger(r.enabled) ? r.enabled : rules !== null ? rules.filter((x) => isObj(x) && x.enabled !== false).length : null
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).map(warningText).filter((w) => w !== '')
  const head = rules !== null && imported !== null ? rules.slice(0, Math.min(imported, rules.length)).filter(isObj) : null
  const now = total !== null ? `现在共 ${total} 条${enabled !== null ? `（启用 ${enabled}）` : ''}` : ''
  const skippedText = skipped > 0 ? `，跳过 ${skipped} 条与现有规则完全相同的` : ''
  const lines = []
  if (mode === 'replace') {
    lines.push(`已用导入的 ${imported ?? '?'} 条规则替换整张规则表（原有规则已全部清空）${skippedText}${now ? '；' + now : ''}。`)
  } else if (imported === 0) {
    lines.push((skipped > 0 ? `没有导入新规则：${skipped} 条都与现有规则完全相同（已跳过）` : '没有导入任何规则：文件里没有规则') + (now ? '；' + now : '') + '。')
  } else {
    lines.push(`已导入 ${imported ?? '?'} 条规则（合并：加在最前，先匹配先生效）${skippedText}${now ? '；' + now : ''}。`)
  }
  if (warnings.length > 0) {
    lines.push(`⚠ ${warnings.length} 条告警（规则已导入，但下面这些现在用不了，需要你处理）：`)
    for (const w of warnings.slice(0, IMPORT_WARN_MAX)) lines.push('  ⚠ ' + w)
    if (warnings.length > IMPORT_WARN_MAX) lines.push(`  …另有 ${warnings.length - IMPORT_WARN_MAX} 条告警（完整列表在 warnings）`)
  }
  if (head !== null && head.length > 0) {
    lines.push(mode === 'replace' ? '导入后的规则：' : '导入的规则（排在最前）：')
    for (const x of head.slice(0, IMPORT_LIST_MAX)) lines.push(ruleLine(x))
    if (head.length > IMPORT_LIST_MAX) lines.push(`…另有 ${head.length - IMPORT_LIST_MAX} 条未列出`)
  }
  if (imported !== 0) lines.push(`看全部：${tool} action=list；删掉某条：${tool} action=remove id=…`)
  return out(lines.join('\n'), true, {
    mode,
    imported: imported ?? undefined,
    skipped: skipped ?? undefined,
    total: total ?? undefined,
    enabled: enabled ?? undefined,
    revision: r.revision,
    warnings,
    importedIds: head !== null ? head.map((x) => x.id).filter((id) => typeof id === 'string' && id !== '') : undefined,
  })
}

// ------------------------------------------------------------------ capture_rules

async function runRules(a, api, T, face) {
  const action = str(a.action).trim() || 'list'
  const rulesTool = T('capture_rules')

  if (action === 'list') {
    const lack = missing(api, 'getRules')
    if (lack) return lack
    const r = await api.getRules()
    if (failed(r, ['rules'])) return explainRuleError(r, '读规则失败', T, { op: 'list' })
    const p = rulesPayload(r)
    const tail = p.rules.length > 0 ? `\n看某条的完整内容（响应体 / 脚本 / 响应头）：${rulesTool} action=get id=…；删除：${rulesTool} action=remove id=…` : ''
    return out(rulesSummary(r) + tail, true, p)
  }

  if (action === 'export') {
    const p = optPath(a.path)
    if (p.error !== undefined) return fail(p.error)
    if (given(a.overwrite) && typeof a.overwrite !== 'boolean') return fail('overwrite 要是 true / false')
    const lack = missing(api, 'exportRules')
    if (lack) return lack
    const r = await api.exportRules({ path: p.value, overwrite: a.overwrite === true })
    if (failed(r, ['path', 'count'])) return explainRuleError(r, '导出规则失败', T, { op: 'export', path: p.value })
    const path = str(r.path).trim()
    const count = Number(r.count)
    const bytes = Number(r.bytes)
    const summary = `已导出 ${Number.isInteger(count) ? count : '?'} 条规则 → ${path !== '' ? path : '（宿主没回路径）'}` +
      (Number.isFinite(bytes) && bytes > 0 ? `（${bytes} 字节）` : '') +
      `\n这份文件可以在另一台机器 / 另一位同事那里用 ${rulesTool} action=import path=… 导入（合并或替换）。`
    // 完整信封在宿主给的 path 里：这里只回路径与统计（一份规则文件可能有几十条 MB 级的 mock）
    return out(summary, true, {
      path: path !== '' ? path : undefined,
      count: Number.isInteger(count) ? count : undefined,
      bytes: Number.isFinite(bytes) ? bytes : undefined,
      overwrite: a.overwrite === true,
    })
  }

  if (action === 'get') {
    const id = str(a.id).trim()
    if (id === '') return fail(`action=get 需要 id（先 ${rulesTool} action=list 看 id）`)
    const lack = missing(api, 'getRule')
    if (lack) return lack
    const r = await api.getRule(id)
    const notFound = () => fail(`没有 id=${id} 的规则（可能已被删除，或规则列表被面板 / 另一个会话改过）：先 ${rulesTool} action=list 看当前的 id`, { code: 'RULE_NOT_FOUND' })
    if (r === null || r === undefined) return notFound()
    if (failed(r, ['rule', 'action'])) return explainRuleError(r, '读规则失败', T, { id, op: 'get' })
    // 两种传输层形状都认：路由回 { rule }，进程内可能直接回规则对象
    const rule = Object.hasOwn(r, 'rule') ? (isObj(r.rule) ? r.rule : null) : (isObj(r.action) ? r : null)
    if (rule === null) return notFound()
    const capped = capRuleBody(rule)
    return out(ruleDetail(rule, capped, face), true, { rule: capped.rule, truncated: capped.truncated, note: capped.note })
  }

  if (action === 'mock') {
    const url = str(a.url).trim()
    if (url === '') return fail('action=mock 需要 url（完整接口地址 https://host/path，查询串会被忽略）')
    const req = { url, method: typeof a.method === 'string' ? a.method.trim() : '' }
    const hasBody = typeof a.body === 'string'
    req.preset = typeof a.preset === 'string' && a.preset.trim() !== '' ? a.preset.trim() : (hasBody ? 'body' : 'empty-object')
    if (hasBody) req.body = a.body
    if (given(a.status)) {
      const st = Number(a.status)
      if (!Number.isInteger(st) || st < 100 || st > 599) return fail('status 要是 100–599 的整数')
      req.status = st
    }
    if (given(a.latencyMs)) {
      const ms = Number(a.latencyMs)
      if (!Number.isFinite(ms) || ms < 0) return fail('latencyMs 要是 ≥0 的毫秒数')
      if (ms > 0) req.latencyMs = ms
    }
    const lack = missing(api, 'quickRule')
    if (lack) return lack
    const r = await api.quickRule(req)
    if (failed(r, ['rule', 'rules'])) return explainRuleError(r, 'mock 失败', T, { op: 'mock' })
    const rule = isObj(r.rule) ? r.rule : null
    const reach = isObj(r.reach) ? r.reach : undefined
    const note = reachNote(r, url, T)
    const summary = `${r.replaced === true ? '已替换' : '已添加'}一键规则：${ruleLine(rule)}` +
      (note ? '\n' + note : '') +
      (rule !== null && given(rule.id) ? `\n还原：${rulesTool} action=remove id=${rule.id}` : '')
    return out(summary, true, {
      replaced: r.replaced === true,
      rule: rule !== null ? projectRule(rule) : null,
      reach,
      takesEffect: reach !== undefined ? reach.takesEffect : r.takesEffect,
      total: r.total,
      enabled: r.enabled,
      revision: r.revision,
    })
  }

  if (action === 'add') {
    let rule
    if (isObj(a.ruleJson)) {
      rule = a.ruleJson
    } else {
      const text = str(a.ruleJson).trim()
      if (text === '') return fail('action=add 需要 ruleJson（一条规则的 JSON 字符串）。' + SHAPE_HINT)
      try {
        rule = JSON.parse(text)
      } catch (e) {
        return fail('ruleJson 不是合法 JSON：' + errText(e) + '。' + SHAPE_HINT)
      }
    }
    if (!isObj(rule)) return fail('ruleJson 要是**一条**规则对象（不是数组 / 字符串 / 数字）。' + SHAPE_HINT)
    const bad = validateRuleInput(rule)
    if (bad !== null) return fail(bad, { code: 'RULE_INVALID' })
    const lack = missing(api, 'ruleOp')
    if (lack) return lack
    // 新规则一律由宿主发新 id、命中数从 0 开始：从 action=get 抄来的规则若带着原 id，会和原规则撞 id（之后按 id 删/停用删错条）
    const { id: _id, hits: _hits, ...fresh } = rule
    const r = await api.ruleOp({ op: 'add', rule: fresh })
    if (failed(r, ['rule', 'rules'])) return explainRuleError(r, '添加规则失败', T, { op: 'add' })
    const p = rulesPayload(r)
    const added = isObj(r.rule) ? r.rule : (Array.isArray(r.rules) && isObj(r.rules[0]) ? r.rules[0] : null)
    const summary = `已添加（放在最前，先匹配先生效）：${ruleLine(added)}` +
      (added !== null && given(added.id) ? `\n还原：${rulesTool} action=remove id=${added.id}` : '') +
      '\n' + rulesSummary(r)
    return out(summary, true, { changed: r.changed !== false, rule: added !== null ? projectRule(added) : undefined }, p)
  }

  if (action === 'remove' || action === 'enable' || action === 'disable') {
    const id = str(a.id).trim()
    if (id === '') return fail(`action=${action} 需要 id（先 ${rulesTool} action=list 看 id）`)
    const lack = missing(api, 'ruleOp')
    if (lack) return lack
    const r = await api.ruleOp({ op: action, id })
    if (failed(r, ['rule', 'rules'])) return explainRuleError(r, '改规则失败', T, { id, op: action })
    const verb = { remove: '删除', enable: '启用', disable: '停用' }[action]
    const target = isObj(r.rule) ? r.rule : null
    const head = r.changed === false
      ? `规则 id=${id} 本来就是${verb}状态，没有改动。`
      : action === 'remove'
        ? `已删除 id=${id}${target !== null ? '：' + ruleLine(target) : '。'}`
        : `已${verb}：${target !== null ? ruleLine(target) : 'id=' + id}`
    return out(head + '\n' + rulesSummary(r), true, { changed: r.changed !== false, rule: target !== null ? projectRule(target) : undefined }, rulesPayload(r))
  }

  if (action === 'clear') {
    const lack = missing(api, 'ruleOp')
    if (lack) return lack
    const r = await api.ruleOp({ op: 'clear' })
    if (failed(r, ['rules'])) return explainRuleError(r, '清空规则失败', T, { op: 'clear' })
    return out(r.changed === false ? '本来就没有规则，没有改动。' : '已清空全部规则。', true, { changed: r.changed !== false }, rulesPayload(r))
  }

  if (action === 'import') {
    const p = optPath(a.path)
    if (p.error !== undefined) return fail(p.error)
    if (given(a.mode) && typeof a.mode !== 'string') return fail(`mode 要是字符串：${IMPORT_MODES.join(' / ')}`)
    const mode = str(a.mode).trim() || 'merge'
    if (!IMPORT_MODES.includes(mode)) return fail(`mode 只能是 ${IMPORT_MODES.join(' / ')}（merge=合并：导入的规则加在最前，与现有规则完全相同的跳过；replace=用导入的规则替换整张表）`)
    const parsed = importData(a.ruleJson, T)
    if (parsed.error !== undefined) return parsed.error
    if (p.value !== undefined && parsed.data !== undefined) {
      return fail('path 和 ruleJson 只能给一个：path=让宿主去读的规则文件（.json 的绝对路径），ruleJson=规则文件的内容本身')
    }
    if (p.value === undefined && parsed.data === undefined) {
      return fail(`action=import 需要 path（宿主机器上规则文件 .json 的绝对路径）或 ruleJson（规则文件的内容）。${importShapeHint(T)}`)
    }
    const lack = missing(api, 'importRules')
    if (lack) return lack
    // 不传 baseRevision：导入总是落在宿主当时的规则表上（合并只加不删；替换本来就是"以导入的为准"）
    const r = await api.importRules(p.value !== undefined ? { path: p.value, mode } : { data: parsed.data, mode })
    if (failed(r, ['imported', 'skipped', 'rules'])) return explainRuleError(r, '导入规则失败', T, { op: 'import', path: p.value })
    return importResult(r, mode, rulesTool)
  }

  return fail(`不认识的 action=${action}（可选：list / get / export / import / mock / add / remove / enable / disable / clear）`)
}

// ------------------------------------------------------------------ capture_intercept

const SAFETY_NET_TEXT = {
  registered: '已注册',
  unregistered: '已注销',
  absent: '不存在',
  skipped: '未处理',
  failed: '**注册失败**',
  unknown: '状态未知',
}

/** 上游证书校验的告警（per-host upstreamTls；字符串或 { warning|error|message } 都认）。 */
function upstreamTlsText(u) {
  if (typeof u === 'string') return oneLine(u)
  if (isObj(u)) return oneLine(u.warning ?? u.error ?? u.message ?? u.reason ?? '')
  return ''
}

export function interceptSummary(s) {
  if (!isObj(s)) return '拿不到透明拦截状态'
  const c = isObj(s.counters) ? s.counters : {}
  const n = (k) => Number(c[k]) || 0
  const lines = []
  if (s.listening !== true) {
    lines.push(`透明拦截：未开启（监听地址 ${s.ip ?? '-'}）`)
  } else if (s.draining === true) {
    lines.push(`透明拦截：**排空中**（hosts 已还原，${s.drainUntil ? Math.max(0, Math.round((s.drainUntil - Date.now()) / 1000)) + 's 后' : '稍后'}关监听；期间客户端已有连接照常透传、不套规则）`)
  } else {
    const ports = (Array.isArray(s.ports) ? s.ports : []).map((p) => `${p.port}${p.mode === 'tcp' ? '(TCP透传)' : p.secure ? '(TLS)' : ''}`).join(' ')
    const head = s.active === false ? '透明拦截：监听在，但 hosts 段落不在 ⇒ 客户端**没有**经过拦截' : '透明拦截：● 生效中'
    lines.push(`${head} · ${s.ip} · 端口 ${ports || '-'} · 已拦 ${n('requests')} 次${n('probes') > 0 ? ` · 安全网探测 ${n('probes')} 次` : ''}`)
  }
  for (const h of Array.isArray(s.hosts) ? s.hosts : []) {
    if (!isObj(h)) continue
    const tls = upstreamTlsText(h.upstreamTls)
    lines.push(`  ${h.host} [${(h.ports ?? []).join(',')}] → ${(h.upstream ?? []).join(',') || '?'}${h.via ? ` (${h.via})` : ''} · ${Number(h.requests) || 0} 次` +
      `${h.error ? ` · 上游解析告警: ${oneLine(h.error)}` : ''}${tls ? ` · 上游证书告警: ${tls}` : ''}`)
  }
  const mismatch = [
    n('plainHttpOnTls') > 0 ? `明文 HTTP 打到 TLS 端口 ${n('plainHttpOnTls')} 次（那个端口要写成 http://域名:端口）` : '',
    n('nonTlsOnTls') > 0 ? `非 TLS 的数据打到 TLS 端口 ${n('nonTlsOnTls')} 次（TCP 长连接端口要写成 tcp://域名:端口 原样透传）` : '',
  ].filter(Boolean)
  if (mismatch.length > 0) lines.push('⚠ 协议对不上：' + mismatch.join('；'))
  if (typeof s.strictUpstreamTls === 'boolean' && s.listening === true) {
    lines.push(s.strictUpstreamTls ? '上游证书：严格校验（校验不过就拒绝转发，客户端收到 502）' : '上游证书：校验不过只告警、照常转发')
  }
  if (isObj(s.hostsFile)) lines.push(`hosts：${s.hostsFile.blockPresent ? `本插件段落在（${s.hostsFile.entries} 条）` : '无本插件段落'} · ${s.hostsFile.path}`)
  if (s.caTrusted === true) lines.push('根证书：已被 Windows 信任')
  else if (s.caTrusted === false) lines.push('根证书：**未被信任**（严格校验证书的请求会失败）')
  else if (s.caTrusted === null && s.listening === true) lines.push('根证书：信任状态查不到（未知 ≠ 已信任）')
  if (s.safetyTaskPresent === true) lines.push('安全网计划任务：在（重启电脑 / 本插件监听不在时自动清理 hosts；探测会核对监听身份）')
  else if (s.safetyTaskPresent === false && s.listening === true) lines.push('安全网计划任务：**不在**')
  else if (s.safetyTaskPresent === null && s.listening === true) lines.push('安全网计划任务：状态查不到（未知 ≠ 在）')
  else if (s.safetyTaskPresent === undefined && typeof s.safetyNet === 'string' && s.safetyNet !== '') {
    lines.push('安全网计划任务：' + (SAFETY_NET_TEXT[s.safetyNet] ?? s.safetyNet))
  }
  if (typeof s.lastError === 'string' && s.lastError !== '') lines.push('监听错误：' + oneLine(s.lastError))
  if (isObj(s.event) && s.event.message) lines.push('事件：' + s.event.message)
  for (const w of Array.isArray(s.warnings) ? s.warnings : []) lines.push('⚠ ' + String(w).replace(/^⚠\s*/, ''))
  return lines.join('\n')
}

const SUGGEST_CMD_MAX = 20

function suggestLine(i) {
  const s = isObj(i.sources) ? i.sources : null
  const src = s === null ? '' : [
    Number(s.realtime) > 0 ? `实时 ${s.realtime}` : '',
    Number(s.proxy) > 0 ? `代理 ${s.proxy}` : '',
    Number(s.other) > 0 ? `其它 ${s.other}` : '',
  ].filter(Boolean).join(' / ')
  return `  ${i.host}  ${Number(i.count) || 0} 次${src ? `（${src}）` : ''}  [${(Array.isArray(i.ports) ? i.ports : []).join(',')}]`
}

async function runIntercept(a, api, T) {
  const action = str(a.action).trim() || 'status'
  const tool = T('capture_intercept')

  if (action === 'status') {
    const lack = missing(api, 'interceptStatus')
    if (lack) return lack
    // 永远现查：刚 start / install-ca 之后读 30s 缓存会报"安全网任务不存在 / 根证书未信任"的假警报（C37）
    const s = await api.interceptStatus({ fresh: true })
    if (failed(s, ['listening', 'active', 'hosts', 'ip'])) return fail(rawError(s, '查透明拦截状态失败'), s)
    return out(interceptSummary(s), true, stripTransport(s))
  }

  if (action === 'suggest') {
    const lack = missing(api, 'suggest')
    if (lack) return lack
    const r = await api.suggest()
    if (failed(r, ['items'])) return fail(rawError(r, '取候选域名失败'), r)
    const items = (Array.isArray(r.items) ? r.items : []).filter((i) => isObj(i) && typeof i.host === 'string' && i.host !== '')
    // C41：现成的 start 命令**只**用客户端自己（实时日志）访问过的域名；别的进程的域名只列出来，不给命令 ——
    // hosts 重定向是整机生效的，把浏览器流量里的域名整批塞进去会把无关网站一起改掉。
    const client = items.filter((i) => i.fromClient === true)
    const others = items.filter((i) => i.fromClient !== true)
    const hostsArg = client.slice(0, SUGGEST_CMD_MAX)
      .flatMap((i) => (Array.isArray(i.entries) && i.entries.length > 0 ? i.entries : [i.host])).join(' ')
    const otherBlock = (head) => `${head}\n` + others.slice(0, 15).map(suggestLine).join('\n') +
      (others.length > 15 ? `\n  …另有 ${others.length - 15} 个` : '')
    let summary
    if (items.length === 0) {
      summary = `捕获库里还没有可用的域名记录：先 ${T('capture_start')} 开实时捕获、让客户端跑一会儿，再 ${tool} action=suggest；或者直接把客户端的接口域名传给 ${tool} action=start。`
    } else if (client.length > 0) {
      summary = `客户端自己访问过的域名（实时日志）${client.length} 个：\n` + client.slice(0, 25).map(suggestLine).join('\n') +
        `\n直接用：${tool} action=start hosts="${hostsArg}"` + (client.length > SUGGEST_CMD_MAX ? `（只取了前 ${SUGGEST_CMD_MAX} 个）` : '') +
        (others.length > 0
          ? '\n' + otherBlock(`另有 ${others.length} 个域名来自其它进程（经本地代理 / 系统代理抓到，不一定是客户端的；hosts 改的是整机，别整批加进名单）：`)
          : '')
    } else {
      summary = otherBlock(`捕获库里没有客户端自己的流量（实时日志里一条都没有）⇒ 不给现成的启用命令。下面 ${others.length} 个域名来自其它进程（经本地代理 / 系统代理抓到，多半是浏览器等）；hosts 重定向对整机生效，别整批加进名单：`) +
        `\n要拿到客户端的域名：先 ${T('capture_start')} 开实时捕获并让客户端跑一会儿，再 ${tool} action=suggest；或只挑你确认属于客户端的域名传给 ${tool} action=start。`
    }
    return out(summary, true, { hosts: hostsArg, clientCount: client.length, otherCount: others.length, items })
  }

  if (action === 'start') {
    const hosts = (Array.isArray(a.hosts) ? a.hosts.map(str).join(' ') : str(a.hosts)).trim()
    if (hosts === '') return fail(`action=start 需要 hosts（空格/逗号分隔；不知道填什么先 ${tool} action=suggest）`)
    const req = { hosts }
    if (given(a.strictUpstreamTls)) {
      if (typeof a.strictUpstreamTls !== 'boolean') return fail('strictUpstreamTls 要是 true / false')
      req.strictUpstreamTls = a.strictUpstreamTls
    }
    const lack = missing(api, 'interceptStart')
    if (lack) return lack
    const r = await api.interceptStart(req)
    if (r === null || typeof r !== 'object' || r.ok !== true) return fail(rawError(r, '启用透明拦截失败'), r)
    const tail = [
      '下一步：**重启客户端**立即生效（不重启则等它的连接池/DNS 缓存自然轮换，约 2 分钟）。',
      `然后用 ${T('capture_rules')} action=mock 改接口返回；根证书是否被信任、安全网任务在不在：${tool} action=status；停用：${tool} action=stop。`,
    ]
    return out(interceptSummary(r) + '\n' + tail.join('\n'), true, stripTransport(r))
  }

  if (action === 'stop') {
    const req = {}
    if (given(a.graceSeconds)) {
      const sec = Number(a.graceSeconds)
      if (!Number.isFinite(sec) || sec < 0) return fail('graceSeconds 要是 ≥0 的秒数（0 = 立即关监听）')
      req.graceMs = sec * 1000
    }
    const lack = missing(api, 'interceptStop')
    if (lack) return lack
    const r = await api.interceptStop(req)
    if (r === null || typeof r !== 'object' || r.ok !== true) return fail(rawError(r, '停用透明拦截失败'), r)
    const nothing = Object.hasOwn(r, 'removal') && r.removal === null && r.listening !== true
    return out((nothing ? '透明拦截本来就没有开启（hosts 里也没有本插件段落），无需还原。\n' : 'hosts 已还原。\n') + interceptSummary(r), true, stripTransport(r))
  }

  return fail(`不认识的 action=${action}（可选：status / suggest / start / stop）`)
}

// ------------------------------------------------------------------ capture_netsim

export function netsimSummary(n) {
  if (!isObj(n)) return '拿不到弱网设置'
  const parts = [
    n.requestDelayMs > 0 ? `请求延迟 ${n.requestDelayMs}ms${n.jitterMs > 0 ? `±${n.jitterMs}` : ''}` : '',
    n.responseDelayMs > 0 ? `回包延迟 ${n.responseDelayMs}ms` : '',
    n.downKbps > 0 ? `下行 ${n.downKbps}KB/s` : '',
    n.upKbps > 0 ? `上行 ${n.upKbps}KB/s` : '',
  ].filter(Boolean)
  const scope = [n.scope && n.scope !== 'all' ? `范围=${n.scope}` : '', n.hosts ? `域名=${n.hosts}` : '', n.urlFilter ? `URL含=${n.urlFilter}` : ''].filter(Boolean).join(' ')
  return `全局弱网：${n.enabled ? '● 开' : '○ 关'} · ${parts.join('，') || '（未设任何延迟/限速）'}${scope ? ' · ' + scope : ''}`
}

/** 设置字段的类型校验：类型不对的值引擎会悄悄忽略（"设了但没生效"），在这里就拒掉。 */
function netsimFieldError(k, v) {
  if (k === 'enabled') return typeof v === 'boolean' ? null : 'enabled 要是 true / false'
  if (k === 'preset' || k === 'hosts' || k === 'urlFilter') return typeof v === 'string' ? null : `${k} 要是字符串`
  if (k === 'scope') return NETSIM_SCOPES.includes(v) ? null : `scope 只能是 ${NETSIM_SCOPES.join(' / ')}`
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? null : `${k} 要是 ≥0 的数字`
}

async function runNetsim(a, api, T) {
  const fields = NETSIM_FIELDS.filter((k) => given(a[k]))
  const explicit = str(a.action).trim()
  // C42：没有默认 action。没写 action 时按给没给设置字段推断；显式 get 又带了设置字段 = 调用方以为在改，直接报错
  const action = explicit !== '' ? explicit : (fields.length > 0 ? 'set' : 'get')
  const inferred = explicit === ''

  if (action === 'get') {
    if (fields.length > 0) {
      return fail(`action=get 只查看、不改任何设置，但你给了 ${fields.join(' / ')} —— 这次什么都没改。要修改请用 action=set（或者不写 action：给了设置字段就按 set 处理）。`)
    }
    const lack = missing(api, 'getNetsim')
    if (lack) return lack
    const n = await api.getNetsim()
    if (failed(n, ['enabled', 'presets'])) return fail(rawError(n, '读弱网设置失败'), n)
    const presets = isObj(n.presets) ? Object.entries(n.presets).map(([k, v]) => `${k}=${isObj(v) ? v.label : v}`).join('；') : ''
    return out(netsimSummary(n) + (presets ? '\n预设：' + presets : '') + `\n修改：${T('capture_netsim')} action=set preset=… 或给具体的延迟 / 限速字段`, true, stripTransport(n))
  }

  if (action !== 'set') return fail(`不认识的 action=${action}（可选：get / set；也可以不写，按给没给设置字段推断）`)
  if (fields.length === 0) return fail(`action=set 至少要给一个设置字段：${NETSIM_FIELDS.join(' / ')}`)
  for (const k of fields) {
    const bad = netsimFieldError(k, a[k])
    if (bad !== null) return fail(bad)
  }
  const cfg = Object.fromEntries(fields.map((k) => [k, a[k]]))
  const lack = missing(api, 'setNetsim')
  if (lack) return lack
  const n = await api.setNetsim(cfg)
  if (failed(n, ['enabled', 'presets'])) return fail(rawError(n, '写弱网设置失败'), n)
  const unknownPreset = typeof cfg.preset === 'string' && isObj(n.presets) && !Object.hasOwn(n.presets, cfg.preset)
  const summary = (inferred ? `（没写 action：按给出的 ${fields.join(' / ')} 当 action=set）\n` : '') +
    '已更新。' + netsimSummary(n) +
    (unknownPreset ? `\n⚠ 没有叫 ${cfg.preset} 的预设，预设没有套用（可选：${Object.keys(n.presets).join(' / ')}）` : '')
  return out(summary, true, inferred ? { inferredAction: 'set' } : {}, stripTransport(n))
}

// ------------------------------------------------------------------ 入口

/**
 * 入口：tool = 逻辑名（capture_rules / capture_intercept / capture_netsim；也认 DSH 面的 api_ 前缀名）。
 * options.face = 'dsh' | 'mcp'（默认 'mcp'；没传而 tool 带 api_ 前缀时按 'dsh'）决定提示里写哪一面的工具名。
 */
export async function runInterceptTool(tool, args, api, options = {}) {
  const name = str(tool).replace(/^api_/, '')
  const face = isObj(options) ? options.face : undefined
  const f = given(face) ? normFace(face) : (str(tool).startsWith('api_') ? 'dsh' : 'mcp')
  const T = (logical) => faceToolName(logical, f)
  const a = isObj(args) ? args : {}
  if (!isObj(api)) return fail('没有传输层（api）')
  try {
    if (name === 'capture_rules') return await runRules(a, api, T, f)
    if (name === 'capture_intercept') return await runIntercept(a, api, T)
    if (name === 'capture_netsim') return await runNetsim(a, api, T)
    return fail(`未知工具 ${tool}`)
  } catch (e) {
    return fail(errText(e))
  }
}
