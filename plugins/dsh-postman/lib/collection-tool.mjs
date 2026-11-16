/**
 * dsh-postman — agent 工具的**唯一实现**：DSH 面（index.js 的 defineTool）与 MCP 面（mcp/server.mjs）
 * 都调这里，两面行为不会漂移。
 *
 *   http_collection(action=list|get|run|save|env)：读写面板里的集合 / 环境，并跑集合运行器；
 *   prepareAdhocRequest：给 http_request 做 {{变量}} 替换（用当前环境或指定环境 + 全局变量）。
 */
import {
  WorkspaceError, activeEnvironment, addItem, createCollection, createEnvironment, findCollection, findEnvironment, findItem,
  itemPathText, loadWorkspace, mutateWorkspace, normalizeAsserts, normalizeExtract, normalizeVariables, setActiveEnvironment,
  storeDir, updateItem, walkItems, workspaceFile,
} from './workspace.mjs'
import { runCollection } from './runner.mjs'
import { hasPlaceholders, newTrack, resolveString, scopesFromWorkspace } from './variables.mjs'

const LIST_CAP = 300
const RESULT_CAP = 200

function fail(error) {
  if (error instanceof WorkspaceError) return { ok: false, errorCode: error.code, error: error.message }
  throw error
}

/** 环境参数：省略 = 当前环境；'none' / '无' = 不用环境；'globals' 只在 env 动作里表示全局变量。 */
function envRef(value) {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim()
  if (v === '') return undefined
  if (v === 'none' || v === '无') return null
  return v
}

export async function collectionTool(args = {}, { dir = storeDir(), signal, send } = {}) {
  try {
    switch (args.action) {
      case 'list':
        return listAction(dir, args)
      case 'get':
        return getAction(dir, args)
      case 'run':
        return await runAction(dir, args, { signal, send })
      case 'save':
        return saveAction(dir, args)
      case 'env':
        return envAction(dir, args)
      default:
        return { ok: false, errorCode: 'INVALID', error: 'action 只能是 list / get / run / save / env' }
    }
  } catch (error) {
    return fail(error)
  }
}

function listAction(dir, args) {
  const { workspace: ws, warning } = loadWorkspace(dir)
  const cols = args.collection ? [findCollection(ws, args.collection)] : ws.collections
  let listed = 0
  let truncated = false
  const collections = cols.map((col) => {
    const requests = []
    const folders = []
    for (const e of walkItems(col)) {
      if (e.item.type === 'folder') {
        folders.push(itemPathText(e))
        continue
      }
      if (listed >= LIST_CAP) {
        truncated = true
        continue
      }
      listed += 1
      requests.push({
        id: e.item.id,
        name: e.item.name,
        ...(e.path.length > 0 ? { folder: e.path.join(' / ') } : {}),
        mode: e.item.request.mode,
        method: e.item.request.method,
        url: e.item.request.url,
        asserts: e.item.asserts.filter((a) => a.enabled !== false).length,
        extract: e.item.extract.filter((x) => x.enabled !== false).length,
      })
    }
    return { id: col.id, name: col.name, variables: col.variables.filter((v) => v.enabled).map((v) => v.key), folders, requests }
  })
  const active = activeEnvironment(ws)
  return {
    ok: true,
    storePath: workspaceFile(dir),
    ...(warning ? { warning } : {}),
    activeEnvironment: active ? { id: active.id, name: active.name } : null,
    environments: ws.environments.map((e) => ({ id: e.id, name: e.name, active: e.id === ws.activeEnvironmentId, variables: e.variables.filter((v) => v.enabled).map((v) => v.key) })),
    globals: ws.globals.filter((v) => v.enabled).map((v) => v.key),
    collections,
    ...(truncated ? { truncated: true, note: `请求太多，只列了前 ${LIST_CAP} 个；用 collection 参数缩小范围` } : {}),
  }
}

function getAction(dir, args) {
  const ws = loadWorkspace(dir).workspace
  const col = findCollection(ws, args.collection)
  const e = findItem(col, args.request, 'request')
  return {
    ok: true,
    collection: { id: col.id, name: col.name },
    item: { id: e.item.id, name: e.item.name, path: itemPathText(e), request: e.item.request, asserts: e.item.asserts, extract: e.item.extract },
  }
}

function compactResult(r) {
  const failed = r.asserts.filter((a) => !a.pass)
  return {
    iteration: r.iteration,
    name: r.name,
    ...(r.path ? { folder: r.path } : {}),
    method: r.method,
    url: r.url,
    status: r.status,
    durationMs: r.durationMs,
    verdict: r.verdict,
    asserts: `${r.asserts.length - failed.length}/${r.asserts.length}`,
    ...(failed.length > 0 ? { failedAsserts: failed } : {}),
    ...(r.extract.length > 0 ? { extract: r.extract } : {}),
    ...(r.unresolved ? { unresolved: r.unresolved } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.skipped ? { skipped: r.skipped } : {}),
    ...(r.redirected ? { redirected: true, finalUrl: r.finalUrl } : {}),
    ...(r.bodyPreview !== undefined ? { bodyPreview: r.bodyPreview } : {}),
  }
}

async function runAction(dir, args, { signal, send }) {
  if (!args.collection) return { ok: false, errorCode: 'INVALID', error: 'run 要给 collection（集合名或 id）' }
  const report = await runCollection({
    dir,
    collection: args.collection,
    folder: args.folder || undefined,
    request: args.request || undefined,
    environment: envRef(args.environment),
    iterations: args.iterations,
    data: args.data,
    delayMs: args.delayMs,
    stopOnFailure: args.stopOnFailure === true,
    timeoutMs: args.timeoutMs,
    persistVariables: args.persistVariables !== false,
    signal,
    send,
  })
  const results = report.results.slice(0, RESULT_CAP).map(compactResult)
  return {
    ok: true,
    outcome: report.outcome,
    allPassed: report.allPassed,
    summary: report.summary,
    collection: report.collection,
    target: report.target,
    environment: report.environment,
    iterations: report.iterations,
    durationMs: report.durationMs,
    ...(report.notes.length > 0 ? { notes: report.notes } : {}),
    results,
    ...(report.results.length > RESULT_CAP ? { truncated: true, truncationNote: `结果太多，只列了前 ${RESULT_CAP} 条；完整报告见 reportPath` } : {}),
    reportPath: report.reportPath,
  }
}

/** 找或建「a / b / c」这条文件夹路径，返回最后一层的 id（空路径 = 集合根，返回 null）。 */
function ensureFolder(ws, col, folderPath) {
  const parts = String(folderPath ?? '').split('/').map((p) => p.trim()).filter(Boolean)
  let parentId = null
  let items = col.items
  for (const name of parts) {
    let folder = items.find((x) => x.type === 'folder' && x.name === name)
    if (!folder) folder = addItem(ws, col.id, { parentId, type: 'folder', name })
    parentId = folder.id
    items = folder.items
  }
  return { parentId, items }
}

function saveAction(dir, args) {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (name === '') return { ok: false, errorCode: 'INVALID', error: 'save 要给 name（请求名）' }
  if (!args.collection) return { ok: false, errorCode: 'INVALID', error: 'save 要给 collection（集合名或 id；不存在会新建）' }
  if (typeof args.url !== 'string' || args.url.trim() === '') return { ok: false, errorCode: 'INVALID', error: 'save 要给 url' }
  // 先校验，免得拿锁后才发现参数不对
  const asserts = args.asserts === undefined ? undefined : normalizeAsserts(args.asserts)
  const extract = args.extract === undefined ? undefined : normalizeExtract(args.extract)
  const request = { method: args.method || 'GET', url: args.url, headers: args.headers ?? {}, body: args.body ?? '' }
  const { workspace, result } = mutateWorkspace(dir, (ws) => {
    let col
    let createdCollection = false
    try {
      col = findCollection(ws, args.collection)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'NOT_FOUND') throw error
      col = createCollection(ws, { name: args.collection })
      createdCollection = true
    }
    const { parentId, items } = ensureFolder(ws, col, args.folder)
    const existing = items.find((x) => x.type === 'request' && x.name === name)
    if (existing) {
      const patch = { request: { ...existing.request, ...request } }
      if (asserts !== undefined) patch.asserts = asserts
      if (extract !== undefined) patch.extract = extract
      updateItem(ws, col.id, existing.id, patch)
      return { action: 'updated', col, id: existing.id, createdCollection }
    }
    const item = addItem(ws, col.id, { parentId, type: 'request', name, request, asserts: asserts ?? [], extract: extract ?? [] })
    return { action: 'created', col, id: item.id, createdCollection }
  })
  const col = workspace.collections.find((c) => c.id === result.col.id)
  const entry = [...walkItems(col)].find((e) => e.item.id === result.id)
  return {
    ok: true,
    action: result.action,
    collection: { id: col.id, name: col.name, ...(result.createdCollection ? { created: true } : {}) },
    item: { id: result.id, name, path: itemPathText(entry), asserts: entry.item.asserts.length, extract: entry.item.extract.length },
  }
}

function envAction(dir, args) {
  const ref = typeof args.environment === 'string' ? args.environment.trim() : ''
  const vars = args.variables !== undefined && args.variables !== null ? normalizeVariables(args.variables) : null
  const isGlobals = ref === 'globals' || ref === '全局' || ref === '全局变量'
  if (vars === null && args.activate !== true) {
    // 只读
    const ws = loadWorkspace(dir).workspace
    if (isGlobals) return { ok: true, scope: 'globals', variables: Object.fromEntries(ws.globals.filter((v) => v.enabled).map((v) => [v.key, v.value])) }
    const env = ref === '' ? activeEnvironment(ws) : findEnvironment(ws, ref)
    if (!env) return { ok: true, environment: null, note: '当前没有选中的环境', environments: ws.environments.map((e) => e.name) }
    return { ok: true, environment: { id: env.id, name: env.name, active: env.id === ws.activeEnvironmentId }, variables: Object.fromEntries(env.variables.filter((v) => v.enabled).map((v) => [v.key, v.value])) }
  }
  const { workspace, result } = mutateWorkspace(dir, (ws) => {
    const upsert = (list) => {
      const changed = []
      for (const v of vars ?? []) {
        const hit = list.find((x) => x.key === v.key)
        if (hit) {
          hit.value = v.value
          hit.enabled = v.enabled
        } else list.push(v)
        changed.push(v.key)
      }
      return changed
    }
    if (isGlobals) return { scope: 'globals', changed: upsert(ws.globals) }
    let env
    let created = false
    if (ref === '') env = activeEnvironment(ws)
    else {
      try {
        env = findEnvironment(ws, ref)
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'NOT_FOUND' || vars === null) throw error
        env = null
      }
    }
    if (!env) {
      env = createEnvironment(ws, { name: ref || '默认环境' })
      created = true
    }
    const changed = upsert(env.variables)
    let activated = false
    if (args.activate === true || (created && ws.activeEnvironmentId === null)) {
      setActiveEnvironment(ws, env.id)
      activated = true
    }
    return { scope: 'environment', id: env.id, changed, created, activated }
  })
  if (result.scope === 'globals') {
    return { ok: true, scope: 'globals', changed: result.changed, variables: Object.fromEntries(workspace.globals.filter((v) => v.enabled).map((v) => [v.key, v.value])) }
  }
  const env = workspace.environments.find((e) => e.id === result.id)
  return {
    ok: true,
    environment: { id: env.id, name: env.name, active: env.id === workspace.activeEnvironmentId },
    changed: result.changed,
    ...(result.created ? { created: true } : {}),
    ...(result.activated ? { activated: true } : {}),
    variables: Object.fromEntries(env.variables.filter((v) => v.enabled).map((v) => [v.key, v.value])),
  }
}

/**
 * http_request 的 {{变量}} 替换。没有占位符时原样返回（不读工作区）。
 * environment：省略 = 当前环境；'none' = 不用环境（只用全局变量和动态变量）；其余 = 环境名或 id。
 * 返回 { spec, variables? }；环境找不到时抛 WorkspaceError（调用方转成 ok:false）。
 */
export function prepareAdhocRequest(args = {}, { dir = storeDir() } = {}) {
  const spec = { method: args.method, url: args.url, headers: args.headers, body: args.body }
  if (!hasPlaceholders(spec.url, spec.body, spec.headers)) return { spec }
  const { workspace: ws, warning } = loadWorkspace(dir)
  const { scopes, environment } = scopesFromWorkspace(ws, { environment: envRef(args.environment) })
  const track = newTrack()
  const R = (s) => (typeof s === 'string' ? resolveString(s, scopes, track) : s)
  let headers = spec.headers
  if (headers !== null && typeof headers === 'object') {
    headers = {}
    for (const [k, v] of Object.entries(spec.headers)) headers[R(k)] = R(String(v ?? ''))
  }
  return {
    spec: { method: spec.method, url: R(spec.url), headers, body: R(spec.body) },
    variables: {
      environment: environment ? environment.name : null,
      applied: [...track.applied],
      unresolved: [...track.unresolved],
      ...(warning ? { warning } : {}),
      ...(track.unresolved.size > 0 ? { note: `这些变量没找到，按原样发出：${[...track.unresolved].join(', ')}` } : {}),
    },
  }
}
