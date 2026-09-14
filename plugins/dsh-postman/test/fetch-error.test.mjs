// dsh-postman 单测：fetch 失败必须**说到能指导下一步**（2026-09-11 本地回环实测的教训）。
// Node 的 fetch 很多情况下只抛一句 `fetch failed`，真正原因在 `error.cause` 里；
// agent 看到 "fetch failed" 无法区分「重定向死循环 / DNS 失败 / 连接被拒 / TLS 失败」，而这四种下一步完全不同。
import { describeFetchError } from '../lib/http.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const withCause = (msg, cause) => {
  const e = new Error(msg)
  e.cause = cause
  return e
}

{
  const r = describeFetchError(withCause('fetch failed', { code: 'UND_ERR_TOO_MANY_REDIRECTS', message: 'redirect count exceeded' }))
  check('重定向超限：点名"疑似重定向循环"', /重定向/.test(r) && /循环/.test(r), r)
  check('重定向超限：带上原始 code（可核对）', /UND_ERR_TOO_MANY_REDIRECTS/.test(r), r)
}
{
  const r = describeFetchError(withCause('fetch failed', { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nope.invalid' }))
  check('DNS 失败：说"域名解析失败"', /域名解析失败/.test(r), r)
}
{
  const r = describeFetchError(withCause('fetch failed', { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }))
  check('连接被拒：说"目标端口没有服务在监听"', /连接被拒绝/.test(r) && /监听/.test(r), r)
}
{
  const r = describeFetchError(withCause('fetch failed', { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }))
  check('证书过期：说"TLS 证书已过期"', /证书已过期/.test(r), r)
}
{
  // 只有 message 没有 code：仍要把 message 带出来，并识别 redirect 字样
  const r = describeFetchError(withCause('fetch failed', { message: 'redirect count exceeded' }))
  check('无 code 但 message 含 redirect：提示疑似循环', /疑似重定向循环/.test(r), r)
}
{
  const r = describeFetchError(new Error('fetch failed'))
  check('没有任何 cause：至少原样保留 message（不编原因）', r === 'fetch failed', r)
  check('非 Error 输入不抛', describeFetchError('boom') === 'boom' && describeFetchError(null) === 'null', String(describeFetchError(null)))
}
{
  // 未知 code：必须把 code 与 message 都带出来，而不是吞掉
  const r = describeFetchError(withCause('fetch failed', { code: 'SOMETHING_NEW', message: 'weird thing happened' }))
  check('未知 code：原样带出 code 与 message', /SOMETHING_NEW/.test(r) && /weird thing happened/.test(r), r)
}

console.log(failures === 0 ? '\nPASS: dsh-postman fetch 失败原因说明' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
