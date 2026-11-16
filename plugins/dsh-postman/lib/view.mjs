/**
 * dsh-postman — 「人会读到的东西」的纯函数层。
 *
 * 为什么单独成模块：这里的两个函数都是**有损投影**（从完整响应里挑字段给调用方看），
 * 而投影恰恰是最容易把关键事实丢掉的地方 —— 丢了以后没有任何报错，只有一个
 * 看起来很正常的默认视图。渲染/投影是契约的一部分（agent 只看得见这里给的东西），
 * 必须能离线离线验证；留在 index.js 里就等于不可测（index.js 依赖宿主的
 * `@deepseek-ai/dsh-tools`，普通 node 进程 import 不到）。
 *
 * PM-03（2026-09-11 真机确证，Claude 独立复现 11/11）：
 * fetch 默认跟随跳转，于是「302 → 登录页的 200」与「你请求的那个接口的 200」在旧视图里
 * **逐字符相同**。根因在 http.mjs 补了 requestedUrl/finalUrl/redirected 之后，
 * 这里的两个投影若不显式透出，默认视图仍然是那个自信的假 200 —— 而且历史列表更危险：
 * 翻历史的人看的是列表，列表不标就等于没有。
 */

/**
 * 单次请求的默认视图（http_request 工具）。
 *  - redirected === true  → 醒目提示「这是跳转后的响应」，并给出 请求→实际 两个地址；
 *  - redirected === false → 结论明确，不刷噪音；
 *  - 字段缺失（老记录/别的消费方）→ 明说「未回报」，不冒充"没有跳转"。
 */
export function renderHttp(_args, value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: `request failed: ${(value && value.error) || 'unknown error'}` }]
  }
  const head = `${value.status} ${value.statusText ?? ''} · ${Math.round(value.durationMs)}ms · ${value.sizeExact === false ? '≥' : ''}${value.size} bytes`
  let tail = ''
  if (value.redirected === true) {
    tail = `\n⚠ 本次是**跳转后的响应**：请求 ${value.requestedUrl ?? '?'} → 实际 ${value.finalUrl ?? '?'}` +
      '（status/headers/body 都属于最终地址，中间的 301/302 不在结果里）'
  } else if (value.redirected !== false) {
    tail = '\n（跳转信息未回报：无法判断这次响应是不是跳转后的结果）'
  }
  if (value.truncated === true) tail += '\n⚠ ' + (value.truncationNote || '响应体已截断。')
  return [{ type: 'text', text: head + tail + renderHttpVariables(value) }]
}

/** http_request 带了 {{变量}} 时补一行：用了哪个环境、哪些变量没找到。 */
export function renderHttpVariables(value) {
  const v = value && value.variables
  if (!v || typeof v !== 'object') return ''
  const env = v.environment ? `环境「${v.environment}」` : '无环境'
  const miss = Array.isArray(v.unresolved) && v.unresolved.length > 0 ? `；⚠ 没找到：${v.unresolved.join(', ')}（按原样发出）` : ''
  return `\n变量：${env}，替换了 ${Array.isArray(v.applied) ? v.applied.length : 0} 个${miss}`
}

const OUTCOME_LABEL = { pass: '全部通过', fail: '有失败', incomplete: '没跑完', unchecked: '没有断言' }

/** http_collection 的默认视图。 */
export function renderCollectionTool(args, value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: `http_collection 失败：${(value && value.error) || 'unknown error'}` }]
  }
  const action = args && args.action
  if (action === 'run') {
    const s = value.summary || {}
    const head = `运行「${value.target?.name ?? ''}」${value.environment ? `（环境 ${value.environment.name}）` : '（无环境）'}：` +
      `${OUTCOME_LABEL[value.outcome] ?? value.outcome} · 通过 ${s.passed} / 失败 ${s.failed} / 出错 ${s.errored} / 未设断言 ${s.unchecked}` +
      (s.skipped ? ` / 跳过 ${s.skipped}` : '') + (s.notRun ? ` / 未执行 ${s.notRun}` : '') + ` · ${Math.round(value.durationMs ?? 0)}ms`
    const bad = (value.results || []).filter((r) => r.verdict === 'fail' || r.verdict === 'error').slice(0, 5).map((r) =>
      `  ✗ 第 ${r.iteration} 轮「${r.name}」` + (r.error ? `：${r.error}` : `：${(r.failedAsserts || []).map((a) => `${a.desc}（实际 ${a.actual}${a.error ? '，' + a.error : ''}）`).join('；')}`))
    const notes = (value.notes || []).map((n) => '  · ' + n)
    return [{ type: 'text', text: [head, ...bad, ...notes].join('\n') }]
  }
  if (action === 'list') {
    const n = (value.collections || []).reduce((sum, c) => sum + c.requests.length, 0)
    return [{ type: 'text', text: `集合 ${(value.collections || []).length} 个 · 请求 ${n} 个 · 当前环境 ${value.activeEnvironment ? value.activeEnvironment.name : '无'}` }]
  }
  if (action === 'get') {
    const i = value.item || {}
    return [{ type: 'text', text: `${i.path}：${i.request?.method ?? ''} ${i.request?.url ?? ''} · 断言 ${(i.asserts || []).length} 条 · 提取 ${(i.extract || []).length} 条` }]
  }
  if (action === 'save') {
    return [{ type: 'text', text: `${value.action === 'created' ? '已新建' : '已更新'}「${value.item?.path ?? ''}」（集合 ${value.collection?.name ?? ''}${value.collection?.created ? '，新建的集合' : ''}）` }]
  }
  if (action === 'env') {
    const count = Object.keys(value.variables || {}).length
    const who = value.scope === 'globals' ? '全局变量' : value.environment ? `环境「${value.environment.name}」` : '（没有选中的环境）'
    return [{ type: 'text', text: `${who}：${count} 个变量` + (Array.isArray(value.changed) && value.changed.length > 0 ? ` · 写入 ${value.changed.join(', ')}` : '') }]
  }
  return [{ type: 'text', text: 'ok' }]
}

/**
 * 历史列表的轻量投影（无 body/headers）。
 * 跳转信息必须一起投出来：列表是有损的，而**看列表的人不会去看详情**。
 */
export function toListItem(rec) {
  const r = (rec && rec.response) || {}
  return {
    id: rec.id,
    ts: rec.ts,
    method: rec.request?.method ?? 'GET',
    url: rec.request?.url ?? '',
    ok: r.ok === true,
    status: Number.isInteger(r.status) ? r.status : null,
    durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
    size: Number.isInteger(r.size) ? r.size : null,
    ...(r.sizeExact === false ? { sizeExact: false } : {}),
    ...(r.truncated === true ? { truncated: true } : {}),
    error: r.ok === false ? r.error ?? '' : '',
    // PM-03：这是**有损投影**（白名单），根因修好后 finalUrl 也到不了这里 ——
    // 历史列表若不标出「这条其实是跳转后的响应」，翻历史的人会照着干净 200 下结论。
    ...(r.redirected === true ? { redirected: true, finalUrl: r.finalUrl ?? '' } : {}),
  }
}
