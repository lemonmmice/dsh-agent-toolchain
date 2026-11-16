/**
 * dsh-postman — 集合 / 环境 / 全局变量的**宿主侧文件存储**（`<store>/workspace.json`）。
 *
 * 为什么不再放浏览器 localStorage：
 *   · agent 拿不到 —— `http_request` / `http_collection` 跑在宿主或 MCP 进程里，读不到浏览器存储；
 *   · 不耐久 —— 清浏览器数据就没了，`localhost` 与 `127.0.0.1` 打开还是两份；
 *   · 不能导出、不能给别人。
 * DSH 宿主与 MCP 进程解析出的是同一个目录（见 storeDir），所以两边看到同一份集合和环境。
 *
 * 并发：两个进程都可能写（面板保存 / agent 保存 / 运行时提取变量）。每次写 = 拿锁 → 读最新 →
 * 改 → 原子替换（先写临时文件再 rename），并把上一版留成 workspace.json.bak。改动都是按条目的
 * 细粒度操作，所以不会出现「整份覆盖掉对方刚存的东西」。
 *
 * 只依赖 node 内置模块：插件宿主与 MCP 进程都直接 import 这里。
 */
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export const WORKSPACE_VERSION = 1
export const EXPORT_FORMAT = 'dsh-postman/collection'

/** 上限：防止误操作把文件撑爆（这些都是本机调试数据，给得很宽）。 */
export const LIMITS = Object.freeze({
  collections: 200,
  itemsPerCollection: 3000,
  environments: 100,
  variables: 1000,
  nameLength: 200,
  keyLength: 200,
  valueLength: 256 * 1024,
  urlLength: 16 * 1024,
  headers: 200,
  bodyLength: 2 * 1024 * 1024,
  checks: 100,
  depth: 10,
  fileBytes: 64 * 1024 * 1024,
})

export class WorkspaceError extends Error {
  /** code: NOT_FOUND | INVALID | AMBIGUOUS | BUSY | LIMIT | CORRUPT */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    Object.assign(this, extra)
  }
  get status() {
    return { NOT_FOUND: 404, INVALID: 400, AMBIGUOUS: 409, BUSY: 503, LIMIT: 413, CORRUPT: 500 }[this.code] ?? 500
  }
}

/**
 * 存储目录。与历史库（history.jsonl）同一个目录：DSH_POSTMAN_STORE → $DSH_HOME/postman → ~/.dsh/postman。
 * 空字符串按未设置处理（旧实现用 `??`，DSH_HOME='' 时会落到相对路径）。
 */
export function storeDir() {
  if (process.env.DSH_POSTMAN_STORE) return process.env.DSH_POSTMAN_STORE
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'postman')
}

export function workspaceFile(dir = storeDir()) {
  return join(dir, 'workspace.json')
}

// ------------------------------------------------------------------ normalization

const METHOD_RE = /^[A-Za-z]{1,20}$/
/** 变量名：不含空白和花括号、不以 $ 开头（$ 开头留给 {{$guid}} 这类动态变量）。 */
export const VAR_KEY_RE = /^[^{}\s$][^{}\s]*$/

function str(value, max, label) {
  if (value === undefined || value === null) return ''
  const s = typeof value === 'string' ? value : String(value)
  if (s.length > max) throw new WorkspaceError('LIMIT', `${label}太长（${s.length} 字符，上限 ${max}）`)
  return s
}

function cleanName(value, fallback, label = '名称') {
  const s = str(value, LIMITS.nameLength * 4, label).trim().replace(/\s+/g, ' ')
  if (s.length > LIMITS.nameLength) throw new WorkspaceError('LIMIT', `${label}太长（上限 ${LIMITS.nameLength} 字符）`)
  return s === '' ? fallback : s
}

function newId() {
  return randomUUID()
}

/** 变量列表：接受 [{key,value,enabled}] 或 {key: value}。保序；非法变量名直接报错（引用不到的变量存着也没用）。 */
export function normalizeVariables(input, label = '变量') {
  const list = Array.isArray(input)
    ? input
    : input !== null && typeof input === 'object'
      ? Object.entries(input).map(([key, value]) => ({ key, value }))
      : []
  if (list.length > LIMITS.variables) throw new WorkspaceError('LIMIT', `${label}太多（上限 ${LIMITS.variables} 个）`)
  const out = []
  const bad = []
  for (const v of list) {
    if (v === null || typeof v !== 'object') continue
    const key = str(v.key, LIMITS.keyLength, '变量名').trim()
    if (key === '') continue
    if (!VAR_KEY_RE.test(key)) {
      bad.push(key)
      continue
    }
    out.push({ key, value: str(v.value, LIMITS.valueLength, `变量 ${key} 的值`), enabled: v.enabled !== false })
  }
  if (bad.length > 0) {
    throw new WorkspaceError('INVALID', `${label}名不合法：${bad.slice(0, 5).join('、')}（不能含空白或花括号，不能以 $ 开头）`)
  }
  return out
}

/** 启用的变量 → Map（后出现的同名变量覆盖前面的，与编辑器里「下面一行赢」一致）。 */
export function variablesToMap(list) {
  const map = new Map()
  for (const v of list ?? []) if (v.enabled !== false && typeof v.key === 'string') map.set(v.key, v.value ?? '')
  return map
}

/** 文本编辑格式：每行 KEY=VALUE；`# KEY=VALUE` 表示停用的变量；其余以 # 开头的行是注释。 */
export function variablesToText(list) {
  return (list ?? []).map((v) => (v.enabled === false ? '# ' : '') + v.key + '=' + (v.value ?? '')).join('\n')
}

/** 请求体里的变量：{ variablesText: 'K=V
…' }（编辑框原文，宿主解析）或 { variables: [...] / {k:v} }。 */
export function variablesFromPayload(payload, label) {
  if (payload && typeof payload.variablesText === 'string') return textToVariables(payload.variablesText)
  return normalizeVariables(payload ? payload.variables : [], label)
}

export function textToVariables(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    let enabled = true
    if (line.startsWith('#')) {
      line = line.slice(1).trim()
      const i = line.indexOf('=')
      // 「# KEY=VALUE」且 KEY 合法 → 停用的变量；否则是注释，丢弃
      if (i <= 0 || !VAR_KEY_RE.test(line.slice(0, i).trim())) continue
      enabled = false
    }
    const i = line.indexOf('=')
    if (i <= 0) throw new WorkspaceError('INVALID', `这一行不是 KEY=VALUE：${raw.trim().slice(0, 80)}`)
    out.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim(), enabled })
  }
  return normalizeVariables(out)
}

function normalizeHeaders(input) {
  const out = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  const entries = Object.entries(input)
  if (entries.length > LIMITS.headers) throw new WorkspaceError('LIMIT', `请求头太多（上限 ${LIMITS.headers} 个）`)
  for (const [k, v] of entries) {
    const key = String(k).trim()
    if (key === '' || v === undefined || v === null) continue
    out[key] = str(Array.isArray(v) ? v.join(', ') : v, LIMITS.valueLength, `请求头 ${key}`)
  }
  return out
}

function detectMode(url) {
  const u = String(url ?? '').trim()
  if (/^wss?:\/\//i.test(u)) return 'ws'
  if (/^tcp:\/\//i.test(u)) return 'tcp'
  if (/^grpc:\/\//i.test(u)) return 'grpc'
  return 'http'
}

/** 请求模板（面板编辑器里的那一份，含 {{变量}} 原样）。只保留认识的字段。 */
export function normalizeTemplate(input) {
  const t = input !== null && typeof input === 'object' ? input : {}
  const url = str(t.url, LIMITS.urlLength, 'URL')
  const mode = ['http', 'ws', 'tcp', 'grpc'].includes(t.mode) ? t.mode : detectMode(url)
  const method = typeof t.method === 'string' && METHOD_RE.test(t.method.trim()) ? t.method.trim().toUpperCase() : 'GET'
  const a = t.auth !== null && typeof t.auth === 'object' ? t.auth : {}
  const authType = ['none', 'bearer', 'basic'].includes(a.type) ? a.type : 'none'
  return {
    mode,
    method,
    url,
    headers: normalizeHeaders(t.headers),
    body: str(t.body, LIMITS.bodyLength, '请求体'),
    bodyMode: t.bodyMode === 'graphql' ? 'graphql' : 'raw',
    gqlQuery: str(t.gqlQuery, LIMITS.bodyLength, 'GraphQL Query'),
    gqlVars: str(t.gqlVars, LIMITS.bodyLength, 'GraphQL Variables'),
    auth: {
      type: authType,
      token: str(a.token, LIMITS.valueLength, 'Token'),
      user: str(a.user, LIMITS.valueLength, '用户名'),
      pass: str(a.pass, LIMITS.valueLength, '密码'),
    },
    grpcProto: str(t.grpcProto, LIMITS.bodyLength, 'proto'),
    grpcReq: str(t.grpcReq, LIMITS.bodyLength, 'gRPC 请求'),
    grpcSvc: str(t.grpcSvc, LIMITS.nameLength, 'gRPC 服务'),
    grpcMethod: str(t.grpcMethod, LIMITS.nameLength, 'gRPC 方法'),
    grpcTls: t.grpcTls === true,
  }
}

// ---- 断言 / 提取的声明式规格（求值在 checks.mjs）

export const ASSERT_SOURCES = ['status', 'json', 'header', 'body', 'duration']
export const ASSERT_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'regex', 'exists', 'notExists', 'empty', 'notEmpty', 'type', 'in']
/** 每种来源允许的比较方式。 */
export const OPS_BY_SOURCE = Object.freeze({
  status: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'],
  duration: ['lt', 'lte', 'gt', 'gte'],
  header: ['exists', 'notExists', 'eq', 'ne', 'contains', 'notContains', 'regex'],
  body: ['contains', 'notContains', 'regex', 'eq', 'ne', 'empty', 'notEmpty'],
  json: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'regex', 'exists', 'notExists', 'empty', 'notEmpty', 'type', 'in'],
})
/** 不需要期望值的比较方式。 */
export const VALUELESS_OPS = new Set(['exists', 'notExists', 'empty', 'notEmpty'])
export const JSON_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null']

export const EXTRACT_SOURCES = ['json', 'header', 'body', 'status']
export const EXTRACT_SCOPES = ['environment', 'collection', 'globals', 'runtime']

function checkRegex(pattern, label) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
  } catch (error) {
    throw new WorkspaceError('INVALID', `${label}不是合法的正则：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function normalizeAsserts(input) {
  const list = Array.isArray(input) ? input : []
  if (list.length > LIMITS.checks) throw new WorkspaceError('LIMIT', `断言太多（上限 ${LIMITS.checks} 条）`)
  return list.filter((a) => a !== null && typeof a === 'object').map((a, i) => {
    const n = i + 1
    const source = ASSERT_SOURCES.includes(a.source) ? a.source : null
    if (source === null) throw new WorkspaceError('INVALID', `第 ${n} 条断言的来源不认识：${a.source}（可选 ${ASSERT_SOURCES.join('/')}）`)
    const op = typeof a.op === 'string' ? a.op : ''
    if (!OPS_BY_SOURCE[source].includes(op)) {
      throw new WorkspaceError('INVALID', `第 ${n} 条断言：${source} 不支持比较方式 ${op || '(空)'}（可选 ${OPS_BY_SOURCE[source].join('/')}）`)
    }
    const path = str(a.path, 2000, '断言路径').trim()
    const value = str(a.value, LIMITS.valueLength, '断言期望值')
    if (source === 'json' && path === '') {
      // 空路径 = 整个响应体（$），允许
    }
    if (source === 'header' && path === '') throw new WorkspaceError('INVALID', `第 ${n} 条断言：要写响应头名`)
    if (!VALUELESS_OPS.has(op) && value.trim() === '' && op !== 'eq' && op !== 'ne') {
      throw new WorkspaceError('INVALID', `第 ${n} 条断言：比较方式 ${op} 需要期望值`)
    }
    // 期望值里可以写 {{变量}}（求值时替换），这种值在保存时没法校验类型/数字
    const templated = value.includes('{{')
    if (op === 'regex' && !templated) checkRegex(value, `第 ${n} 条断言的期望值`)
    if (op === 'type' && !templated && !JSON_TYPES.includes(value.trim())) {
      throw new WorkspaceError('INVALID', `第 ${n} 条断言：类型只能是 ${JSON_TYPES.join('/')}`)
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && !templated && !Number.isFinite(Number(value))) {
      throw new WorkspaceError('INVALID', `第 ${n} 条断言：比较方式 ${op} 的期望值要是数字`)
    }
    return { enabled: a.enabled !== false, source, path, op, value }
  })
}

export function normalizeExtract(input) {
  const list = Array.isArray(input) ? input : []
  if (list.length > LIMITS.checks) throw new WorkspaceError('LIMIT', `变量提取太多（上限 ${LIMITS.checks} 条）`)
  return list.filter((x) => x !== null && typeof x === 'object').map((x, i) => {
    const n = i + 1
    const key = str(x.var, LIMITS.keyLength, '变量名').trim()
    if (!VAR_KEY_RE.test(key)) throw new WorkspaceError('INVALID', `第 ${n} 条提取：变量名「${key}」不合法（不能为空、含空白或花括号，不能以 $ 开头）`)
    const source = EXTRACT_SOURCES.includes(x.source) ? x.source : null
    if (source === null) throw new WorkspaceError('INVALID', `第 ${n} 条提取的来源不认识：${x.source}（可选 ${EXTRACT_SOURCES.join('/')}）`)
    const path = str(x.path, 2000, '提取路径').trim()
    if (source === 'header' && path === '') throw new WorkspaceError('INVALID', `第 ${n} 条提取：要写响应头名`)
    if (source === 'body') {
      if (path === '') throw new WorkspaceError('INVALID', `第 ${n} 条提取：从响应体提取要写正则（取第 1 个分组）`)
      checkRegex(path, `第 ${n} 条提取的正则`)
    }
    const scope = EXTRACT_SCOPES.includes(x.scope) ? x.scope : 'environment'
    return { enabled: x.enabled !== false, var: key, source, path, scope }
  })
}

function normalizeItem(input, depth, counter) {
  if (input === null || typeof input !== 'object') return null
  counter.n += 1
  if (counter.n > LIMITS.itemsPerCollection) throw new WorkspaceError('LIMIT', `一个集合最多 ${LIMITS.itemsPerCollection} 个条目`)
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : newId()
  if (input.type === 'folder') {
    if (depth >= LIMITS.depth) throw new WorkspaceError('LIMIT', `文件夹最多嵌套 ${LIMITS.depth} 层`)
    return {
      type: 'folder',
      id,
      name: cleanName(input.name, '新文件夹', '文件夹名'),
      items: (Array.isArray(input.items) ? input.items : []).map((c) => normalizeItem(c, depth + 1, counter)).filter(Boolean),
    }
  }
  return {
    type: 'request',
    id,
    name: cleanName(input.name, '未命名请求', '请求名'),
    request: normalizeTemplate(input.request),
    asserts: normalizeAsserts(input.asserts),
    extract: normalizeExtract(input.extract),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
  }
}

function normalizeCollection(input) {
  const c = input !== null && typeof input === 'object' ? input : {}
  const counter = { n: 0 }
  return {
    id: typeof c.id === 'string' && c.id !== '' ? c.id : newId(),
    name: cleanName(c.name, '未命名集合', '集合名'),
    variables: normalizeVariables(c.variables, '集合变量'),
    items: (Array.isArray(c.items) ? c.items : []).map((i) => normalizeItem(i, 0, counter)).filter(Boolean),
    createdAt: Number.isFinite(c.createdAt) ? c.createdAt : Date.now(),
    updatedAt: Number.isFinite(c.updatedAt) ? c.updatedAt : Date.now(),
  }
}

function normalizeEnvironment(input) {
  const e = input !== null && typeof input === 'object' ? input : {}
  return {
    id: typeof e.id === 'string' && e.id !== '' ? e.id : newId(),
    name: cleanName(e.name, '未命名环境', '环境名'),
    variables: normalizeVariables(e.variables, '环境变量'),
  }
}

export function emptyWorkspace() {
  return {
    version: WORKSPACE_VERSION,
    revision: 0,
    updatedAt: 0,
    globals: [],
    activeEnvironmentId: null,
    environments: [],
    collections: [],
  }
}

export function normalizeWorkspace(input) {
  const w = input !== null && typeof input === 'object' ? input : {}
  const environments = (Array.isArray(w.environments) ? w.environments : []).map(normalizeEnvironment)
  const collections = (Array.isArray(w.collections) ? w.collections : []).map(normalizeCollection)
  if (environments.length > LIMITS.environments) throw new WorkspaceError('LIMIT', `环境最多 ${LIMITS.environments} 个`)
  if (collections.length > LIMITS.collections) throw new WorkspaceError('LIMIT', `集合最多 ${LIMITS.collections} 个`)
  const active = typeof w.activeEnvironmentId === 'string' && environments.some((e) => e.id === w.activeEnvironmentId) ? w.activeEnvironmentId : null
  return {
    version: WORKSPACE_VERSION,
    revision: Number.isInteger(w.revision) && w.revision >= 0 ? w.revision : 0,
    updatedAt: Number.isFinite(w.updatedAt) ? w.updatedAt : 0,
    globals: normalizeVariables(w.globals, '全局变量'),
    activeEnvironmentId: active,
    environments,
    collections,
    ...(Number.isFinite(w.legacyImportedAt) ? { legacyImportedAt: w.legacyImportedAt } : {}),
    ...(Array.isArray(w.legacyImports) ? { legacyImports: w.legacyImports.filter((s) => typeof s === 'string').slice(-50) } : {}),
  }
}

// ------------------------------------------------------------------ persistence

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 跨进程互斥：O_EXCL 建锁文件；超过 15 秒没动的锁视为上一个进程崩溃留下的，直接接管。 */
function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'workspace.lock')
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15000) {
          unlinkSync(lock)
          continue
        }
      } catch {
        continue // 锁刚被释放
      }
      if (Date.now() > deadline) throw new WorkspaceError('BUSY', '工作区文件正被另一个进程写入（等锁超时 5 秒），稍后重试')
      sleepSync(20)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      /* 已被接管 */
    }
  }
}

function writeAtomic(file, text, { backup = true } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${newId().slice(0, 8)}`
  writeFileSync(tmp, text, 'utf8')
  // 主文件坏了的时候不备份它：.bak 此时是唯一好的上一版，不能被坏文件顶掉
  if (backup && existsSync(file)) {
    try {
      copyFileSync(file, file + '.bak')
    } catch {
      /* 备份失败不挡写入 */
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      // Windows：别的进程正好在读这个文件时 rename 会 EPERM/EBUSY，稍等重试
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try {
          unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        throw error
      }
      sleepSync(25)
    }
  }
}

function parseFile(file) {
  const text = readFileSync(file, 'utf8')
  return normalizeWorkspace(JSON.parse(text))
}

/**
 * 读工作区。文件不存在 = 空工作区。主文件坏了就用 .bak，并把坏文件另存成 .corrupt-<时间> —— 绝不悄悄当成空的覆盖掉。
 * 返回 { workspace, warning? }。
 */
export function loadWorkspace(dir = storeDir()) {
  const file = workspaceFile(dir)
  if (!existsSync(file)) return { workspace: emptyWorkspace() }
  try {
    return { workspace: parseFile(file) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const bak = file + '.bak'
    if (existsSync(bak)) {
      try {
        const workspace = parseFile(bak)
        return { workspace, warning: `workspace.json 读不了（${reason}），已改用上一版备份 workspace.json.bak；下次保存时会把坏文件另存为 .corrupt-*` , corrupt: true }
      } catch {
        /* fall through */
      }
    }
    throw new WorkspaceError('CORRUPT', `workspace.json 读不了：${reason}。文件保留在 ${file}，请修好或删掉后重试`)
  }
}

export function readWorkspace(dir = storeDir()) {
  return loadWorkspace(dir).workspace
}

/**
 * 改工作区：拿锁 → 读最新 → mutate(ws) → 校验 → 写回。mutate 的返回值原样返回（作为 result）。
 * mutate 里抛 WorkspaceError 时什么都不写。
 */
export function mutateWorkspace(dir, mutate) {
  return withLock(dir, () => {
    const loaded = loadWorkspace(dir)
    const file = workspaceFile(dir)
    if (loaded.corrupt === true && existsSync(file)) {
      try {
        copyFileSync(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      } catch {
        /* ignore */
      }
    }
    const ws = loaded.workspace
    const result = mutate(ws)
    const next = normalizeWorkspace(ws)
    next.revision = (loaded.workspace.revision ?? 0) + 1
    next.updatedAt = Date.now()
    const text = JSON.stringify(next, null, 1) + '\n'
    if (Buffer.byteLength(text) > LIMITS.fileBytes) throw new WorkspaceError('LIMIT', `工作区文件会超过 ${LIMITS.fileBytes / 1024 / 1024}MB，已拒绝写入`)
    writeAtomic(file, text, { backup: loaded.corrupt !== true })
    return { workspace: next, result }
  })
}

// ------------------------------------------------------------------ lookup

function byRef(list, ref, label, nameOf = (x) => x.name) {
  const r = typeof ref === 'string' ? ref.trim() : ''
  if (r === '') throw new WorkspaceError('INVALID', `没给${label}（写名称或 id）`)
  const byId = list.find((x) => x.id === r)
  if (byId) return byId
  let hits = list.filter((x) => nameOf(x) === r)
  if (hits.length === 0) hits = list.filter((x) => nameOf(x).toLowerCase() === r.toLowerCase())
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new WorkspaceError('AMBIGUOUS', `有 ${hits.length} 个${label}都叫「${r}」，请改用 id：${hits.map((h) => h.id).join(', ')}`)
  throw new WorkspaceError('NOT_FOUND', `找不到${label}「${r}」`)
}

export function findCollection(ws, ref) {
  return byRef(ws.collections, ref, '集合')
}

export function findEnvironment(ws, ref) {
  return byRef(ws.environments, ref, '环境')
}

/** 深度优先遍历集合里的条目：{ item, parent(文件夹或 null), path(上级文件夹名数组), depth }。 */
export function* walkItems(collection) {
  function* rec(items, parent, path, depth) {
    for (const item of items) {
      yield { item, parent, path, depth }
      if (item.type === 'folder') yield* rec(item.items, item, [...path, item.name], depth + 1)
    }
  }
  yield* rec(collection.items, null, [], 0)
}

/** 条目的完整路径文本，如「登录 / 获取 token」。 */
export function itemPathText(entry) {
  return [...entry.path, entry.item.name].join(' / ')
}

/**
 * 按 id、名字或「文件夹/子文件夹/名字」路径找条目。type 可限定 'request' / 'folder'。
 * 返回 walkItems 的那条 entry。
 */
export function findItem(collection, ref, type) {
  const r = typeof ref === 'string' ? ref.trim() : ''
  if (r === '') throw new WorkspaceError('INVALID', `没给${type === 'folder' ? '文件夹' : type === 'request' ? '请求' : '条目'}（写名称、路径或 id）`)
  const all = [...walkItems(collection)].filter((e) => type === undefined || e.item.type === type)
  const byId = all.find((e) => e.item.id === r)
  if (byId) return byId
  const norm = (s) => s.split('/').map((p) => p.trim()).filter(Boolean).join('/')
  const target = norm(r)
  let hits = all.filter((e) => norm([...e.path, e.item.name].join('/')) === target || e.item.name === r)
  if (hits.length === 0) hits = all.filter((e) => norm([...e.path, e.item.name].join('/')).toLowerCase() === target.toLowerCase() || e.item.name.toLowerCase() === r.toLowerCase())
  if (hits.length === 1) return hits[0]
  const label = type === 'folder' ? '文件夹' : type === 'request' ? '请求' : '条目'
  if (hits.length > 1) throw new WorkspaceError('AMBIGUOUS', `集合「${collection.name}」里有 ${hits.length} 个${label}叫「${r}」，请写完整路径或 id：${hits.map((h) => itemPathText(h)).join('；')}`)
  throw new WorkspaceError('NOT_FOUND', `集合「${collection.name}」里找不到${label}「${r}」`)
}

function itemsOf(collection, parentId) {
  if (parentId === undefined || parentId === null || parentId === '') return collection.items
  const entry = [...walkItems(collection)].find((e) => e.item.id === parentId)
  if (!entry || entry.item.type !== 'folder') throw new WorkspaceError('NOT_FOUND', `集合「${collection.name}」里找不到文件夹 ${parentId}`)
  return entry.item.items
}

function removeFromTree(items, id) {
  const i = items.findIndex((x) => x.id === id)
  if (i >= 0) return items.splice(i, 1)[0]
  for (const x of items) {
    if (x.type === 'folder') {
      const hit = removeFromTree(x.items, id)
      if (hit) return hit
    }
  }
  return null
}

function containsId(item, id) {
  if (item.id === id) return true
  return item.type === 'folder' && item.items.some((c) => containsId(c, id))
}

// ------------------------------------------------------------------ mutations (pure: act on a ws object)

function uniqueName(existing, wanted) {
  if (!existing.includes(wanted)) return wanted
  for (let n = 2; ; n++) {
    const candidate = `${wanted} (${n})`
    if (!existing.includes(candidate)) return candidate
  }
}

export function createCollection(ws, { name, variables } = {}) {
  if (ws.collections.length >= LIMITS.collections) throw new WorkspaceError('LIMIT', `集合最多 ${LIMITS.collections} 个`)
  const col = normalizeCollection({ name: uniqueName(ws.collections.map((c) => c.name), cleanName(name, '新集合', '集合名')), variables, items: [] })
  ws.collections.push(col)
  return col
}

export function updateCollection(ws, collectionId, patch = {}) {
  const col = findCollection(ws, collectionId)
  if (patch.name !== undefined) col.name = cleanName(patch.name, col.name, '集合名')
  if (patch.variables !== undefined || patch.variablesText !== undefined) col.variables = variablesFromPayload(patch, '集合变量')
  col.updatedAt = Date.now()
  return col
}

export function deleteCollection(ws, collectionId) {
  const col = findCollection(ws, collectionId)
  ws.collections = ws.collections.filter((c) => c !== col)
  return { id: col.id, name: col.name }
}

/** 加条目（type 'folder' | 'request'）到 parentId 文件夹（空 = 集合根）。 */
export function addItem(ws, collectionId, spec = {}) {
  const col = findCollection(ws, collectionId)
  const items = itemsOf(col, spec.parentId)
  const item = normalizeItem(
    spec.type === 'folder'
      ? { type: 'folder', name: spec.name, items: [] }
      : { type: 'request', name: spec.name, request: spec.request, asserts: spec.asserts, extract: spec.extract },
    0,
    { n: [...walkItems(col)].length },
  )
  if (spec.type !== 'folder') item.updatedAt = Date.now()
  items.push(item)
  col.updatedAt = Date.now()
  return item
}

export function updateItem(ws, collectionId, itemId, patch = {}) {
  const col = findCollection(ws, collectionId)
  const entry = [...walkItems(col)].find((e) => e.item.id === itemId)
  if (!entry) throw new WorkspaceError('NOT_FOUND', `集合「${col.name}」里找不到条目 ${itemId}`)
  const item = entry.item
  if (patch.name !== undefined) item.name = cleanName(patch.name, item.name, item.type === 'folder' ? '文件夹名' : '请求名')
  if (item.type === 'request') {
    if (patch.request !== undefined) item.request = normalizeTemplate(patch.request)
    if (patch.asserts !== undefined) item.asserts = normalizeAsserts(patch.asserts)
    if (patch.extract !== undefined) item.extract = normalizeExtract(patch.extract)
    item.updatedAt = Date.now()
  }
  if (patch.parentId !== undefined) moveItem(ws, col.id, item.id, { parentId: patch.parentId })
  col.updatedAt = Date.now()
  return item
}

export function deleteItem(ws, collectionId, itemId) {
  const col = findCollection(ws, collectionId)
  const removed = removeFromTree(col.items, itemId)
  if (!removed) throw new WorkspaceError('NOT_FOUND', `集合「${col.name}」里找不到条目 ${itemId}`)
  col.updatedAt = Date.now()
  return { id: removed.id, name: removed.name, type: removed.type }
}

export function moveItem(ws, collectionId, itemId, { parentId, index } = {}) {
  const col = findCollection(ws, collectionId)
  const entry = [...walkItems(col)].find((e) => e.item.id === itemId)
  if (!entry) throw new WorkspaceError('NOT_FOUND', `集合「${col.name}」里找不到条目 ${itemId}`)
  if (parentId && containsId(entry.item, parentId)) throw new WorkspaceError('INVALID', '不能把文件夹移进它自己里面')
  const target = itemsOf(col, parentId) // 先确认目标存在，再摘
  removeFromTree(col.items, itemId)
  const at = Number.isInteger(index) && index >= 0 && index <= target.length ? index : target.length
  target.splice(at, 0, entry.item)
  col.updatedAt = Date.now()
  return entry.item
}

export function createEnvironment(ws, { name, variables, variablesText } = {}) {
  if (ws.environments.length >= LIMITS.environments) throw new WorkspaceError('LIMIT', `环境最多 ${LIMITS.environments} 个`)
  const env = normalizeEnvironment({ name: uniqueName(ws.environments.map((e) => e.name), cleanName(name, '新环境', '环境名')), variables: variablesFromPayload({ variables, variablesText }, '环境变量') })
  ws.environments.push(env)
  return env
}

export function updateEnvironment(ws, environmentId, patch = {}) {
  const env = findEnvironment(ws, environmentId)
  if (patch.name !== undefined) {
    const wanted = cleanName(patch.name, env.name, '环境名')
    if (ws.environments.some((e) => e !== env && e.name === wanted)) throw new WorkspaceError('INVALID', `已经有叫「${wanted}」的环境了`)
    env.name = wanted
  }
  if (patch.variables !== undefined || patch.variablesText !== undefined) env.variables = variablesFromPayload(patch, '环境变量')
  return env
}

export function deleteEnvironment(ws, environmentId) {
  const env = findEnvironment(ws, environmentId)
  ws.environments = ws.environments.filter((e) => e !== env)
  if (ws.activeEnvironmentId === env.id) ws.activeEnvironmentId = null
  return { id: env.id, name: env.name }
}

export function setActiveEnvironment(ws, environmentId) {
  if (environmentId === null || environmentId === undefined || environmentId === '') {
    ws.activeEnvironmentId = null
    return null
  }
  const env = findEnvironment(ws, environmentId)
  ws.activeEnvironmentId = env.id
  return env
}

export function setGlobals(ws, variables) {
  ws.globals = normalizeVariables(variables, '全局变量')
  return ws.globals
}

/** 当前环境（没选就是 null）。 */
export function activeEnvironment(ws) {
  return ws.environments.find((e) => e.id === ws.activeEnvironmentId) ?? null
}

/**
 * 写一个变量（提取结果落盘用）：已有同名的就改值并启用，没有就追加。
 * target：{ scope: 'environment'|'collection'|'globals', environmentId?, collectionId? }。
 * 环境 scope 却没有环境时落到全局变量，返回实际写到的 scope。
 */
export function upsertVariable(ws, target, key, value) {
  if (!VAR_KEY_RE.test(key)) throw new WorkspaceError('INVALID', `变量名「${key}」不合法`)
  let list
  let scope = target.scope
  if (scope === 'collection') {
    const col = findCollection(ws, target.collectionId)
    list = col.variables
  } else if (scope === 'environment') {
    const env = target.environmentId ? ws.environments.find((e) => e.id === target.environmentId) : activeEnvironment(ws)
    if (env) list = env.variables
    else {
      scope = 'globals'
      list = ws.globals
    }
  } else {
    scope = 'globals'
    list = ws.globals
  }
  const v = str(value, LIMITS.valueLength, `变量 ${key} 的值`)
  const hit = list.find((x) => x.key === key)
  if (hit) {
    hit.value = v
    hit.enabled = true
  } else {
    if (list.length >= LIMITS.variables) throw new WorkspaceError('LIMIT', `变量太多（上限 ${LIMITS.variables} 个）`)
    list.push({ key, value: v, enabled: true })
  }
  return scope
}

// ------------------------------------------------------------------ legacy import / export / import

/**
 * 把旧版面板存在浏览器 localStorage 的数据搬进来：
 *   collections：[{ id, name, requests: [{ id, name, ...编辑器字段 }] }]
 *   envText：旧「环境变量」弹窗里的 KEY=VALUE 文本
 * 每个浏览器源（localhost 与 127.0.0.1 是两份 localStorage）各搬一次：同样的内容按指纹去重，不会搬两遍。
 */
export function importLegacy(ws, payload = {}) {
  const collectionsIn = Array.isArray(payload.collections) ? payload.collections : []
  const envTextIn = typeof payload.envText === 'string' ? payload.envText : ''
  const fingerprint = createHash('sha256').update(JSON.stringify({ c: collectionsIn, e: envTextIn })).digest('hex').slice(0, 16)
  const seen = Array.isArray(ws.legacyImports) ? ws.legacyImports : []
  if (seen.includes(fingerprint)) return { skipped: true, reason: 'already-imported' }
  const out = { collections: 0, requests: 0, environment: null, skipped: false }
  for (const c of collectionsIn) {
    if (c === null || typeof c !== 'object') continue
    const requests = (Array.isArray(c.requests) ? c.requests : []).filter((r) => r !== null && typeof r === 'object')
    const col = normalizeCollection({
      name: uniqueName(ws.collections.map((x) => x.name), cleanName(c.name, '旧集合', '集合名')),
      items: requests.map((r) => ({ type: 'request', name: r.name, request: r })),
    })
    ws.collections.push(col)
    out.collections += 1
    out.requests += col.items.length
  }
  if (envTextIn.trim() !== '') {
    let variables
    try {
      variables = textToVariables(envTextIn)
    } catch {
      // 旧文本里有不合法的行：逐行宽松解析，保住能用的
      variables = []
      for (const line of envTextIn.split(/\r?\n/)) {
        const t = line.trim()
        const i = t.indexOf('=')
        if (t === '' || t.startsWith('#') || i <= 0) continue
        const key = t.slice(0, i).trim()
        if (VAR_KEY_RE.test(key)) variables.push({ key, value: t.slice(i + 1).trim(), enabled: true })
      }
    }
    if (variables.length > 0) {
      const env = createEnvironment(ws, { name: '默认环境', variables })
      if (ws.activeEnvironmentId === null) ws.activeEnvironmentId = env.id
      out.environment = { id: env.id, name: env.name, variables: env.variables.length }
    }
  }
  ws.legacyImports = [...seen, fingerprint].slice(-50)
  ws.legacyImportedAt = Date.now()
  return out
}

function stripIds(item) {
  if (item.type === 'folder') return { type: 'folder', name: item.name, items: item.items.map(stripIds) }
  return { type: 'request', name: item.name, request: item.request, asserts: item.asserts, extract: item.extract }
}

/** 导出一个集合（本插件自己的格式；条目 id 不导出，导入时重新生成）。 */
export function exportCollection(ws, collectionId) {
  const col = findCollection(ws, collectionId)
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    collection: { name: col.name, variables: col.variables, items: col.items.map(stripIds) },
  }
}

/** 导入导出文件；同名集合自动改名「xx (2)」，不覆盖已有的。 */
export function importCollection(ws, data) {
  const doc = typeof data === 'string' ? safeJson(data) : data
  if (doc === null || typeof doc !== 'object') throw new WorkspaceError('INVALID', '导入内容不是 JSON 对象')
  if (doc.format !== EXPORT_FORMAT || doc.collection === null || typeof doc.collection !== 'object') {
    const hint = doc.info && doc.item ? '（看起来是 Postman 导出的集合，这个格式还不支持）' : ''
    throw new WorkspaceError('INVALID', `不是本插件导出的集合文件（format 应为 ${EXPORT_FORMAT}）${hint}`)
  }
  if (ws.collections.length >= LIMITS.collections) throw new WorkspaceError('LIMIT', `集合最多 ${LIMITS.collections} 个`)
  const dropIds = (item) => (item && typeof item === 'object'
    ? item.type === 'folder'
      ? { ...item, id: undefined, items: (Array.isArray(item.items) ? item.items : []).map(dropIds) }
      : { ...item, id: undefined }
    : item)
  const col = normalizeCollection({
    name: uniqueName(ws.collections.map((c) => c.name), cleanName(doc.collection.name, '导入的集合', '集合名')),
    variables: doc.collection.variables,
    items: (Array.isArray(doc.collection.items) ? doc.collection.items : []).map(dropIds),
  })
  ws.collections.push(col)
  return col
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new WorkspaceError('INVALID', `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}
