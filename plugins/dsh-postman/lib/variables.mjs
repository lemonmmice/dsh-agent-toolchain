/**
 * dsh-postman — {{变量}} 解析与「请求模板 → 真正发出去的请求」组装。
 *
 * 面板发送、集合运行器、agent 的 http_request / http_collection 都走这里，口径只有一份：
 *   · 优先级（高 → 低）：运行中提取的临时变量 > 数据文件当前行 > 环境 > 集合变量 > 全局变量；
 *   · 变量值里还能引用别的变量（最多套 5 层，防循环）；
 *   · 动态变量每次取新值：{{$guid}} {{$randomUUID}} {{$timestamp}}（秒）{{$timestampMs}} {{$isoTimestamp}} {{$randomInt}}（0–1000）；
 *   · 找不到的变量**原样保留**并列进 unresolved —— 不悄悄替换成空串。
 *
 * 浏览器那半（client.js）在 WebSocket / gRPC 模式下还有一份极简替换（只认普通变量），改语义时两边一起看。
 */
import { randomUUID } from 'node:crypto'
import { WorkspaceError, activeEnvironment, findCollection, findEnvironment, normalizeTemplate, variablesToMap } from './workspace.mjs'

/** {{name}}：name 不含空白和花括号。 */
export const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g

const MAX_DEPTH = 5

export function dynamicValue(name) {
  switch (name) {
    case '$guid':
    case '$randomUUID':
      return randomUUID()
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000))
    case '$timestampMs':
      return String(Date.now())
    case '$isoTimestamp':
      return new Date().toISOString()
    case '$randomInt':
      return String(Math.floor(Math.random() * 1001))
    default:
      return undefined
  }
}

/**
 * 作用域链：数组里越靠前优先级越高。每层 { name, vars: Map }。
 */
export function makeScopes({ runtime, data, environment, collection, globals } = {}) {
  const toMap = (v) => (v instanceof Map ? v : v && typeof v === 'object' ? new Map(Object.entries(v).map(([k, x]) => [k, x === null || x === undefined ? '' : String(x)])) : new Map())
  return [
    { name: 'runtime', vars: toMap(runtime) },
    { name: 'data', vars: toMap(data) },
    { name: 'environment', vars: toMap(environment) },
    { name: 'collection', vars: toMap(collection) },
    { name: 'globals', vars: toMap(globals) },
  ]
}

function lookup(scopes, name) {
  for (const s of scopes) if (s.vars.has(name)) return { value: s.vars.get(name), scope: s.name }
  return undefined
}

/** 新的追踪器：applied 记命中的变量名，unresolved 记没找到的。 */
export function newTrack() {
  return { applied: new Set(), unresolved: new Set() }
}

export function resolveString(input, scopes, track = newTrack(), depth = 0) {
  if (typeof input !== 'string' || input.indexOf('{{') === -1) return input ?? ''
  return input.replace(VAR_PATTERN, (match, name) => {
    if (name.startsWith('$')) {
      const v = dynamicValue(name)
      if (v === undefined) {
        track.unresolved.add(name)
        return match
      }
      track.applied.add(name)
      return v
    }
    const hit = lookup(scopes, name)
    if (hit === undefined) {
      track.unresolved.add(name)
      return match
    }
    track.applied.add(name)
    const value = String(hit.value)
    return depth < MAX_DEPTH && value.indexOf('{{') !== -1 ? resolveString(value, scopes, track, depth + 1) : value
  })
}

function hasHeader(headers, name) {
  const n = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === n)
}

/** Authorization 头的值（none / bearer / basic）；凭据为空时不生成。 */
export function authHeaderValue(auth) {
  if (!auth || auth.type === 'none') return ''
  if (auth.type === 'bearer') return auth.token ? 'Bearer ' + auth.token : ''
  if (auth.type === 'basic') return auth.user || auth.pass ? 'Basic ' + Buffer.from(`${auth.user || ''}:${auth.pass || ''}`, 'utf8').toString('base64') : ''
  return ''
}

/**
 * 模板 → { request: {method,url,headers,body}, applied: [...], unresolved: [...] }。
 * 只管 HTTP（GraphQL 也是 HTTP POST）；WebSocket / TCP / gRPC 模板由调用方自己挡掉。
 */
export function buildHttpRequest(template, scopes) {
  const t = normalizeTemplate(template)
  const track = newTrack()
  const R = (s) => resolveString(s, scopes, track)
  // 按阅读顺序解析（URL → 请求头 → 鉴权 → 请求体），「没找到的变量」也按这个顺序列出
  const url = R(t.url).trim()
  const headers = {}
  for (const [k, v] of Object.entries(t.headers)) {
    const key = R(k).trim()
    if (key !== '') headers[key] = R(v)
  }
  const authVal = authHeaderValue({ type: t.auth.type, token: R(t.auth.token), user: R(t.auth.user), pass: R(t.auth.pass) })
  if (authVal !== '' && !hasHeader(headers, 'authorization')) headers.Authorization = authVal
  let method = t.method
  let body
  if (t.bodyMode === 'graphql') {
    let variables = {}
    const vt = R(t.gqlVars).trim()
    if (vt !== '') {
      try {
        variables = JSON.parse(vt)
      } catch (error) {
        throw new WorkspaceError('INVALID', `GraphQL Variables 替换变量后不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    body = JSON.stringify({ query: R(t.gqlQuery), variables })
    method = 'POST'
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
  } else {
    body = R(t.body)
  }
  return {
    request: { method, url, headers, body },
    applied: [...track.applied],
    unresolved: [...track.unresolved],
  }
}

/**
 * 从工作区拼出作用域链。
 *   environment：环境的名字/id；undefined = 当前环境；null 或 '' = 不用环境。
 *   collection：集合的名字/id（给了才带集合变量）。
 * 返回 { scopes, environment: {id,name}|null, collection: {id,name}|null }。
 */
export function scopesFromWorkspace(ws, { environment, collection, data, runtime } = {}) {
  let env = null
  if (environment === undefined) env = activeEnvironment(ws)
  else if (environment !== null && environment !== '') env = findEnvironment(ws, environment)
  const col = collection ? findCollection(ws, collection) : null
  return {
    scopes: makeScopes({
      runtime,
      data,
      environment: env ? variablesToMap(env.variables) : undefined,
      collection: col ? variablesToMap(col.variables) : undefined,
      globals: variablesToMap(ws.globals),
    }),
    environment: env ? { id: env.id, name: env.name } : null,
    collection: col ? { id: col.id, name: col.name } : null,
  }
}

/** 这几个字段里有没有 {{…}}（没有就不必读工作区）。 */
export function hasPlaceholders(...values) {
  return values.some((v) => {
    if (typeof v === 'string') return v.indexOf('{{') !== -1
    if (v !== null && typeof v === 'object') return Object.entries(v).some(([k, x]) => k.indexOf('{{') !== -1 || String(x ?? '').indexOf('{{') !== -1)
    return false
  })
}
