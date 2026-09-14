/**
 * dsh-postman — 「人会读到的东西」的纯函数层。
 *
 * 为什么单独成模块：这里的两个函数都是**有损投影**（从完整响应里挑字段给调用方看），
 * 而投影恰恰是最容易把关键事实丢掉的地方 —— 丢了以后没有任何报错，只有一个
 * 看起来很正常的默认视图。渲染/投影是契约的一部分（agent 只看得见这里给的东西），
 * 必须能离线单测；留在 index.js 里就等于不可测（index.js 依赖宿主的
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
  const head = `${value.status} ${value.statusText ?? ''} · ${Math.round(value.durationMs)}ms · ${value.size} bytes`
  let tail = ''
  if (value.redirected === true) {
    tail = `\n⚠ 本次是**跳转后的响应**：请求 ${value.requestedUrl ?? '?'} → 实际 ${value.finalUrl ?? '?'}` +
      '（status/headers/body 都属于最终地址，中间的 301/302 不在结果里）'
  } else if (value.redirected !== false) {
    tail = '\n（跳转信息未回报：无法判断这次响应是不是跳转后的结果）'
  }
  return [{ type: 'text', text: head + tail }]
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
    error: r.ok === false ? r.error ?? '' : '',
    // PM-03：这是**有损投影**（白名单），根因修好后 finalUrl 也到不了这里 ——
    // 历史列表若不标出「这条其实是跳转后的响应」，翻历史的人会照着干净 200 下结论。
    ...(r.redirected === true ? { redirected: true, finalUrl: r.finalUrl ?? '' } : {}),
  }
}
