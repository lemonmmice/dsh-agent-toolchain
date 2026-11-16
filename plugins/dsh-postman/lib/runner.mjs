/**
 * dsh-postman — 执行一次请求（模板 → 发送 → 断言 → 提取）与集合运行器。
 *
 * 集合运行器 = Postman Collection Runner 的最小可用版：按集合/文件夹的顺序逐个发 HTTP 请求，
 * 可迭代多轮、每轮取数据文件（CSV / JSON 数组）的一行做 {{变量}}，请求之间可留间隔、可失败即停；
 * 每个请求的断言给出通过/失败，提取的变量立即对后面的请求生效（按 scope 落到环境 / 集合 / 全局，
 * 或只在本次运行里有效）。报告另存到 <store>/runs/。
 *
 * 只跑 HTTP(S)（含 GraphQL）。WebSocket / TCP / gRPC 条目记为 skipped，不假装跑过。
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sendRequest } from './http.mjs'
import {
  WorkspaceError, activeEnvironment, findCollection, findEnvironment, findItem, mutateWorkspace, normalizeAsserts,
  normalizeExtract, normalizeTemplate, readWorkspace, storeDir, upsertVariable, variablesToMap, walkItems,
} from './workspace.mjs'
import { buildHttpRequest, makeScopes, resolveString } from './variables.mjs'
import { evaluateAsserts, evaluateExtract, verdictOf } from './checks.mjs'

export const RUN_LIMITS = Object.freeze({
  iterations: 100,
  requests: 1000,
  delayMs: 60000,
  totalMs: 30 * 60 * 1000,
  dataRows: 1000,
  previewChars: 2000,
  keepReports: 30,
})

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.round(n), lo), hi)
}

// ------------------------------------------------------------------ data file

/** CSV（首行表头，支持双引号转义）或 JSON 对象数组 → 行数组（值都转成字符串）。 */
export function parseRunData(input) {
  if (input === undefined || input === null) return []
  if (Array.isArray(input)) {
    if (input.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      throw new WorkspaceError('INVALID', '数据要是对象数组，例如 [{"id":"1"},{"id":"2"}]')
    }
    checkRows(input.length)
    return input.map(rowOf)
  }
  const text = String(input).replace(/^﻿/, '').trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    let rows
    try {
      rows = JSON.parse(text)
    } catch (error) {
      throw new WorkspaceError('INVALID', `数据不是合法的 JSON 数组：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(rows) || rows.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      throw new WorkspaceError('INVALID', '数据要是对象数组，例如 [{"id":"1"},{"id":"2"}]')
    }
    checkRows(rows.length)
    return rows.map(rowOf)
  }
  const table = parseCsv(text)
  if (table.length < 2) throw new WorkspaceError('INVALID', 'CSV 至少要有一行表头和一行数据')
  const head = table[0].map((h) => h.trim())
  if (head.some((h) => h === '')) throw new WorkspaceError('INVALID', 'CSV 表头里有空列名')
  const rows = table.slice(1).filter((r) => r.some((c) => c !== ''))
  checkRows(rows.length)
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

function checkRows(n) {
  if (n > RUN_LIMITS.dataRows) throw new WorkspaceError('LIMIT', `数据最多 ${RUN_LIMITS.dataRows} 行`)
  return n
}

function rowOf(r) {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]))
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  rows.push(row)
  return rows
}

// ------------------------------------------------------------------ one request

/**
 * 跑一个模板：组装 → 发送 → 断言 → 提取（不落盘；落盘交给调用方，因为单发和运行器的落点不同）。
 * 返回 { verdict, resolved?, applied, unresolved, response, asserts, extract, error?, skipped? }。
 */
export async function executeTemplate({ template, scopes, asserts, extract, timeoutMs, signal, send = sendRequest }) {
  const t = normalizeTemplate(template)
  if (t.mode !== 'http') {
    return { verdict: 'skipped', skipped: `${t.mode.toUpperCase()} 请求不在运行器里执行（只跑 HTTP/HTTPS）`, applied: [], unresolved: [], asserts: [], extract: [] }
  }
  let built
  try {
    built = buildHttpRequest(t, scopes)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { verdict: 'error', error: message, response: { ok: false, error: message }, applied: [], unresolved: [], asserts: [], extract: [] }
  }
  const response = await send({ ...built.request, timeoutMs, signal })
  // 断言期望值里的 {{变量}} 用同一条作用域链替换（例如数据驱动时断言 page = {{page}}）
  const ctx = { response, resolve: (s) => resolveString(s, scopes) }
  const assertResults = evaluateAsserts(asserts ?? [], ctx)
  const extractResults = evaluateExtract(extract ?? [], ctx)
  return {
    verdict: verdictOf(response, assertResults),
    resolved: built.request,
    applied: built.applied,
    unresolved: built.unresolved,
    response,
    asserts: assertResults,
    extract: extractResults,
  }
}

/**
 * 把提取结果写进工作区（scope = runtime 的跳过）。一次请求的全部提取合成一次写入。
 * target：{ environmentId?, collectionId? }。返回每条的落点 [{ index, savedTo }]。
 */
export function persistExtracted(dir, extractResults, target = {}) {
  const todo = extractResults.filter((x) => x.ok && x.scope !== 'runtime')
  if (todo.length === 0) return []
  const { result } = mutateWorkspace(dir, (ws) => todo.map((x) => ({
    index: x.index,
    savedTo: upsertVariable(ws, { scope: x.scope, environmentId: target.environmentId, collectionId: target.collectionId }, x.var, x.value),
  })))
  return result
}

// ------------------------------------------------------------------ plan + run

/**
 * 运行计划：解析出要跑的请求（深度优先顺序）、环境、数据行、迭代次数。引用错了在这里就抛。
 *   collection 必填；folder / request 二选一可选（都不给 = 整个集合）。
 *   environment：undefined = 当前环境；null / '' = 不用环境。
 */
export function planRun(ws, opts = {}) {
  const col = findCollection(ws, opts.collection)
  let entries
  let target
  if (opts.request) {
    const e = findItem(col, opts.request, 'request')
    entries = [e]
    target = { type: 'request', id: e.item.id, name: e.item.name, path: [...e.path, e.item.name].join(' / ') }
  } else if (opts.folder) {
    const f = findItem(col, opts.folder, 'folder')
    const all = [...walkItems(col)]
    const inside = new Set()
    const mark = (item) => {
      inside.add(item.id)
      if (item.type === 'folder') item.items.forEach(mark)
    }
    mark(f.item)
    entries = all.filter((e) => e.item.type === 'request' && inside.has(e.item.id))
    target = { type: 'folder', id: f.item.id, name: f.item.name, path: [...f.path, f.item.name].join(' / ') }
  } else {
    entries = [...walkItems(col)].filter((e) => e.item.type === 'request')
    target = { type: 'collection', id: col.id, name: col.name, path: '' }
  }
  if (entries.length === 0) throw new WorkspaceError('INVALID', `「${target.name}」里没有请求可跑`)
  let env = null
  if (opts.environment === undefined) env = activeEnvironment(ws)
  else if (opts.environment !== null && opts.environment !== '') env = findEnvironment(ws, opts.environment)
  const rows = parseRunData(opts.data)
  const iterations = clampInt(opts.iterations, 1, RUN_LIMITS.iterations, rows.length > 0 ? Math.min(rows.length, RUN_LIMITS.iterations) : 1)
  const total = entries.length * iterations
  if (total > RUN_LIMITS.requests) throw new WorkspaceError('LIMIT', `一次最多跑 ${RUN_LIMITS.requests} 个请求（现在是 ${entries.length} 个 × ${iterations} 轮）`)
  return { workspace: ws, collection: col, entries, target, environment: env, rows, iterations, total }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function preview(text) {
  const s = typeof text === 'string' ? text : ''
  return s.length > RUN_LIMITS.previewChars ? s.slice(0, RUN_LIMITS.previewChars) + `…（共 ${s.length} 字符）` : s
}

function short(v, max = 200) {
  const s = String(v ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 执行计划。onResult(entry, progress) 每跑完一个请求回调一次（面板进度用）。
 * 返回报告（不含响应体全文；失败/出错的请求带响应体预览）。
 */
export async function executeRun(plan, opts = {}) {
  const dir = opts.dir ?? storeDir()
  const send = opts.send ?? sendRequest
  const signal = opts.signal
  const delayMs = clampInt(opts.delayMs, 0, RUN_LIMITS.delayMs, 0)
  const timeoutMs = opts.timeoutMs
  const persist = opts.persistVariables !== false
  const stopOnFailure = opts.stopOnFailure === true
  const runId = opts.runId ?? randomUUID()
  const started = Date.now()
  const { collection: col, entries, environment: env, rows, iterations } = plan
  const ws = plan.workspace
  const maps = {
    runtime: new Map(),
    environment: env ? variablesToMap(env.variables) : new Map(),
    collection: variablesToMap(col.variables),
    globals: variablesToMap(ws.globals),
  }
  const results = []
  const notes = []
  let stopped = false
  let cancelled = false
  let timedOut = false
  let done = 0

  outer: for (let it = 0; it < iterations; it++) {
    const row = rows.length > 0 ? rows[it % rows.length] : undefined
    for (let k = 0; k < entries.length; k++) {
      if (signal?.aborted) {
        cancelled = true
        break outer
      }
      if (Date.now() - started > RUN_LIMITS.totalMs) {
        timedOut = true
        break outer
      }
      const { item, path } = entries[k]
      const scopes = makeScopes({ runtime: maps.runtime, data: row, environment: maps.environment, collection: maps.collection, globals: maps.globals })
      let exec
      try {
        exec = await executeTemplate({ template: item.request, scopes, asserts: item.asserts, extract: item.extract, timeoutMs, signal, send })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exec = { verdict: 'error', error: message, response: { ok: false, error: message }, applied: [], unresolved: [], asserts: [], extract: [] }
      }
      // 提取：先在内存里生效（后面的请求马上能用），再按 scope 落盘。
      // environment scope 而当前没选环境时落到全局变量 —— 与 upsertVariable 的落点一致。
      const extracted = exec.extract.map((x) => {
        if (x.ok) {
          const key = x.scope === 'runtime' ? 'runtime' : x.scope === 'collection' ? 'collection' : x.scope === 'globals' || !env ? 'globals' : 'environment'
          maps[key].set(x.var, x.value)
        }
        return { var: x.var, scope: x.scope, ok: x.ok, ...(x.ok ? { value: short(x.value) } : { error: x.error }) }
      })
      if (persist && exec.extract.some((x) => x.ok && x.scope !== 'runtime')) {
        try {
          const saved = persistExtracted(dir, exec.extract, { environmentId: env?.id, collectionId: col.id })
          for (const s of saved) {
            const at = exec.extract.findIndex((x) => x.index === s.index)
            if (at >= 0) extracted[at].savedTo = s.savedTo
          }
        } catch (error) {
          notes.push(`第 ${it + 1} 轮「${item.name}」提取的变量没能写进工作区：${error instanceof Error ? error.message : String(error)}（本次运行内仍然生效）`)
        }
      }
      const response = exec.response ?? null
      const entry = {
        iteration: it + 1,
        id: item.id,
        name: item.name,
        path: path.join(' / '),
        method: exec.resolved?.method ?? item.request.method,
        url: exec.resolved?.url ?? item.request.url,
        status: response && response.ok === true ? response.status : null,
        durationMs: response && Number.isFinite(response.durationMs) ? response.durationMs : null,
        size: response && Number.isInteger(response.size) ? response.size : null,
        verdict: exec.verdict,
        asserts: exec.asserts.map((a) => ({ desc: a.desc, pass: a.pass, actual: a.actual, ...(a.error ? { error: a.error } : {}) })),
        extract: extracted,
        ...(exec.unresolved.length > 0 ? { unresolved: exec.unresolved } : {}),
        ...(exec.skipped ? { skipped: exec.skipped } : {}),
        ...(exec.verdict === 'error' ? { error: exec.error ?? response?.error ?? '请求失败' } : {}),
        ...(response?.redirected === true ? { redirected: true, finalUrl: response.finalUrl } : {}),
        ...((exec.verdict === 'fail' || exec.verdict === 'error') && response?.ok === true ? { bodyPreview: preview(response.body) } : {}),
      }
      results.push(entry)
      done += 1
      try {
        opts.onResult?.(entry, { done, total: plan.total })
      } catch {
        /* 进度回调出错不影响运行 */
      }
      if (stopOnFailure && (exec.verdict === 'fail' || exec.verdict === 'error')) {
        stopped = true
        break outer
      }
      const last = it === iterations - 1 && k === entries.length - 1
      if (delayMs > 0 && !last) await sleep(delayMs, signal)
    }
  }

  const count = (v) => results.filter((r) => r.verdict === v).length
  const assertsAll = results.flatMap((r) => r.asserts)
  const summary = {
    total: plan.total,
    executed: results.length,
    passed: count('pass'),
    failed: count('fail'),
    errored: count('error'),
    unchecked: count('unchecked'),
    skipped: count('skipped'),
    notRun: plan.total - results.length,
    asserts: { passed: assertsAll.filter((a) => a.pass).length, failed: assertsAll.filter((a) => !a.pass).length },
  }
  if (summary.unchecked > 0) notes.push(`${summary.unchecked} 个请求没有设断言：只说明拿到了响应，不代表结果正确`)
  if (stopped) notes.push('遇到失败已按「失败即停」停止，后面的请求没有跑')
  if (cancelled) notes.push('运行被手动停止，后面的请求没有跑')
  if (timedOut) notes.push(`运行超过 ${RUN_LIMITS.totalMs / 60000} 分钟上限，后面的请求没有跑`)
  if (!persist && results.some((r) => r.extract.some((x) => x.ok && x.scope !== 'runtime'))) {
    notes.push('本次没有把提取的变量写回工作区（persistVariables=false），只在运行内有效')
  }
  const finished = Date.now()
  // outcome 刻意不叫 verdict：MCP 面把 verdict==='fail' 标成工具出错，而断言没过是「跑完了、结论是失败」
  const outcome = summary.failed > 0 || summary.errored > 0 ? 'fail'
    : summary.executed < summary.total ? 'incomplete'
      : summary.passed === 0 ? 'unchecked'
        : 'pass'
  const report = {
    ok: true,
    runId,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    collection: { id: col.id, name: col.name },
    target: plan.target,
    environment: env ? { id: env.id, name: env.name } : null,
    iterations,
    dataRows: rows.length,
    summary,
    outcome,
    // 全部跑完、没有失败/出错、并且至少有一个请求真的被断言检查过
    allPassed: outcome === 'pass',
    stopped,
    cancelled,
    timedOut,
    notes,
    results,
  }
  report.reportPath = saveReport(dir, report)
  return report
}

/** 一步到位：读工作区 → 计划 → 执行。 */
export async function runCollection(opts = {}) {
  const dir = opts.dir ?? storeDir()
  const plan = planRun(readWorkspace(dir), opts)
  return executeRun(plan, { ...opts, dir })
}

function saveReport(dir, report) {
  try {
    const runsDir = join(dir, 'runs')
    mkdirSync(runsDir, { recursive: true })
    const stamp = report.startedAt.replace(/[:.]/g, '-').slice(0, 19)
    const slug = String(report.target.name || 'run').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
    const file = join(runsDir, `${stamp}-${slug}-${report.runId.slice(0, 8)}.json`)
    writeFileSync(file, JSON.stringify(report, null, 1) + '\n', 'utf8')
    const all = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort()
    for (const old of all.slice(0, Math.max(all.length - RUN_LIMITS.keepReports, 0))) {
      try {
        unlinkSync(join(runsDir, old))
      } catch {
        /* ignore */
      }
    }
    return file
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ in-process registry (panel progress)

/**
 * 面板用的运行登记：start 立即返回 runId，前端轮询 get(runId, since) 拿增量结果。
 * 只留最近 maxRuns 次（报告本身已经落盘）。
 */
export function createRunRegistry({ dir, send, maxRuns = 10 } = {}) {
  const runs = new Map()
  const resolveDir = () => (typeof dir === 'function' ? dir() : dir ?? storeDir())
  return {
    start(opts = {}) {
      const d = resolveDir()
      const plan = planRun(readWorkspace(d), opts)
      const id = randomUUID()
      const controller = new AbortController()
      const run = {
        id,
        state: 'running',
        startedAt: Date.now(),
        total: plan.total,
        done: 0,
        target: plan.target,
        collection: { id: plan.collection.id, name: plan.collection.name },
        environment: plan.environment ? { id: plan.environment.id, name: plan.environment.name } : null,
        iterations: plan.iterations,
        results: [],
        report: null,
        error: null,
        controller,
      }
      runs.set(id, run)
      while (runs.size > maxRuns) {
        const oldest = [...runs.values()].find((r) => r.state !== 'running')
        if (!oldest) break
        runs.delete(oldest.id)
      }
      executeRun(plan, {
        ...opts,
        dir: d,
        send,
        runId: id,
        signal: controller.signal,
        onResult: (entry, progress) => {
          run.results.push(entry)
          run.done = progress.done
        },
      }).then(
        (report) => {
          run.report = report
          run.state = report.cancelled ? 'cancelled' : 'done'
        },
        (error) => {
          run.error = error instanceof Error ? error.message : String(error)
          run.state = 'error'
        },
      )
      return { id, total: plan.total, iterations: plan.iterations, target: plan.target, environment: run.environment }
    },
    get(id, since = 0) {
      const run = runs.get(id)
      if (!run) return null
      const from = Math.max(0, Math.min(Number(since) || 0, run.results.length))
      const { report } = run
      return {
        id: run.id,
        state: run.state,
        startedAt: run.startedAt,
        done: run.done,
        total: run.total,
        target: run.target,
        collection: run.collection,
        environment: run.environment,
        iterations: run.iterations,
        from,
        results: run.results.slice(from),
        ...(report ? { summary: report.summary, outcome: report.outcome, allPassed: report.allPassed, notes: report.notes, reportPath: report.reportPath, durationMs: report.durationMs, stopped: report.stopped, cancelled: report.cancelled } : {}),
        ...(run.error ? { error: run.error } : {}),
      }
    },
    stop(id) {
      const run = runs.get(id)
      if (!run) return false
      run.controller.abort()
      return true
    },
    list() {
      return [...runs.values()].map((r) => ({ id: r.id, state: r.state, startedAt: r.startedAt, done: r.done, total: r.total, target: r.target }))
    },
    dispose() {
      for (const r of runs.values()) r.controller.abort()
    },
  }
}

export { normalizeAsserts, normalizeExtract }
