// dsh-postman PM-03 单测：跳转诚实性（真机确证 + Claude 独立复现 11/11）
//
// 背景：fetch 默认 redirect:'follow'，于是 `302 → 登录页的 200` 与 `你请求的那个接口的 200`
// 在旧结果与旧视图里**逐字符相同**：status=200、body 是跳转目标的、而"发生过跳转"一个字都没有。
// 安全面更糟：跳转目标可能是登录页或攻击者可控主机，调用方却以为自己打的是自己的 API。
//
// 本单测锁死三层（缺任何一层，"根因修好了"都不等于"人看得见"）：
//   1. 数据层 http.mjs：requestedUrl / finalUrl / redirected 必须如实回报（响应体确实来自最终地址）；
//   2. 默认视图 lib/view.mjs renderHttp：redirected=true 必须醒目提示，false 不刷噪音，
//      **字段缺失要明说"未回报"**（把"没回报"当成"没跳转"就是换个地方骗人）；
//   3. 有损投影 toListItem（历史列表）：跳转信息必须一起投出来 —— 看列表的人不会去看详情。
import { createServer } from 'node:http'
import { sendRequest } from '../lib/http.mjs'
import { renderHttp, toListItem } from '../lib/view.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ------------------------------------------------ 本地跳转链 /a → /b → /c(200)
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/a') {
    res.writeHead(302, { location: '/b' })
    res.end('REDIRECT A')
    return
  }
  if (url.pathname === '/b') {
    res.writeHead(302, { location: '/c' })
    res.end('REDIRECT B')
    return
  }
  if (url.pathname === '/c') {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-hop': 'c' })
    res.end('FINAL BODY @ /c')
    return
  }
  if (url.pathname === '/direct') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('DIRECT BODY')
    return
  }
  res.writeHead(404)
  res.end('nope')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  // ---------------------------------------------- 1. 数据层：跳转必须被如实回报
  const a = await sendRequest({ method: 'GET', url: `${base}/a` })
  check('跳转链请求 ok:true', a.ok === true, JSON.stringify(a).slice(0, 200))
  check('status 是最终跳的 200（不是 302）', a.status === 200, String(a.status))
  check('body 来自最终地址 /c（证明旧视图看到的是跳转目标的响应）', /FINAL BODY @ \/c/.test(a.body), String(a.body).slice(0, 80))
  check('redirected=true', a.redirected === true, String(a.redirected))
  check('finalUrl 指向 /c', String(a.finalUrl).endsWith('/c'), String(a.finalUrl))
  check('requestedUrl 是原始 /a（不自描述就没有对照）', String(a.requestedUrl).endsWith('/a'), String(a.requestedUrl))
  check('两个地址确实不同（finalUrl ≠ requestedUrl）', a.finalUrl !== a.requestedUrl, JSON.stringify({ f: a.finalUrl, r: a.requestedUrl }))
  check('redirectNote 说明中间跳转不在结果里', /不在本次结果里/.test(String(a.redirectNote)) && /自动跟随/.test(String(a.redirectNote)), String(a.redirectNote).slice(0, 160))

  const d = await sendRequest({ method: 'GET', url: `${base}/direct` })
  check('无跳转：redirected=false（不是 undefined）', d.redirected === false, String(d.redirected))
  check('无跳转：finalUrl === requestedUrl', d.finalUrl === d.requestedUrl && String(d.finalUrl).endsWith('/direct'), JSON.stringify({ f: d.finalUrl, r: d.requestedUrl }))
  check('无跳转：不带 redirectNote', d.redirectNote === undefined, String(d.redirectNote))

  // ---------------------------------------------- 2. 默认视图：跳转必须看得见
  const rA = renderHttp({}, a)[0].text
  check('render 印出 status/耗时/字节（原有内容不丢）', /^200 .*ms .*bytes/.test(rA), rA.slice(0, 120))
  check('render 对跳转给出醒目提示', /跳转后的响应/.test(rA) && /⚠/.test(rA), rA.slice(0, 300))
  check('render 同时印出请求地址与实际地址', rA.includes(a.requestedUrl) && rA.includes(a.finalUrl), rA.slice(0, 300))
  check('render 明说 body/headers 属于最终地址', /都属于最终地址/.test(rA), rA.slice(0, 300))

  const rD = renderHttp({}, d)[0].text
  check('render 无跳转时不刷噪音（不出现 ⚠/未回报）', !/⚠/.test(rD) && !/未回报/.test(rD), rD.slice(0, 200))

  const rUnknown = renderHttp({}, { ok: true, status: 200, statusText: 'OK', durationMs: 5, size: 3 })[0].text
  check('render 字段缺失时明说「未回报」，不冒充"没有跳转"', /未回报/.test(rUnknown), rUnknown.slice(0, 200))
  const rFail = renderHttp({}, { ok: false, error: 'boom' })[0].text
  check('render 失败分支不变', /request failed: boom/.test(rFail), rFail)

  // ---------------------------------------------- 3. 历史列表投影：跳转也要被投出来
  const recA = { id: '1', ts: 1, request: { method: 'GET', url: a.requestedUrl }, response: a }
  const recD = { id: '2', ts: 2, request: { method: 'GET', url: d.requestedUrl }, response: d }
  const liA = toListItem(recA)
  const liD = toListItem(recD)
  check('历史列表：跳转记录标出 redirected+finalUrl', liA.redirected === true && String(liA.finalUrl).endsWith('/c'), JSON.stringify(liA))
  check('历史列表：非跳转记录不加噪音字段', liD.redirected === undefined && liD.finalUrl === undefined, JSON.stringify(liD))
  check('历史列表：原有字段一个不少（有损投影不能再丢东西）', liA.id === '1' && liA.status === 200 && liA.method === 'GET' && liA.url === a.requestedUrl && liA.error === '', JSON.stringify(liA))
  check('历史列表：无跳转字段的老记录也不炸', (() => {
    try {
      const old = toListItem({ id: '3', ts: 3, request: { method: 'POST', url: 'http://x/y' }, response: { ok: true, status: 201, durationMs: 3, size: 1 } })
      return old.redirected === undefined && old.status === 201
    } catch { return false }
  })())
} finally {
  // 必须**等 server 真正关掉**再退出：`server.close(); process.exit()` 在本机 Node 上会撞
  // libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言 —— 断言输出在 PASS 之后，
  // 但进程退出码变成 1，于是"全绿"的测试在批量跑里被记成失败（实测踩到）。
  await new Promise((resolve) => server.close(resolve))
}

console.log(failures === 0 ? '\nPASS: dsh-postman PM-03 跳转诚实性（数据层 + 默认视图 + 历史投影）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
