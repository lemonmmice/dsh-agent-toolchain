/**
 * dsh-api-visualizer — local HTTP(S) MITM proxy engine (Fiddler-style).
 *
 * Captures HTTP traffic from ANY process that points its proxy at this
 * engine (or via the Windows system-proxy toggle). Plain HTTP is recorded
 * as-is; HTTPS goes through CONNECT + on-the-fly per-host certificates
 * signed by a locally generated root CA (user imports the CA once).
 *
 * Corporate-network friendly: when an upstream proxy is configured (the
 * default is read from the current WinINET settings), every connection —
 * including CONNECT tunnels — is chained through it, so proxied apps keep
 * their normal network reachability.
 *
 * Records flow through `onRecord` (same shape as the realtime capture
 * engine; source='proxy'). No dsh source changes.
 */

import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { decodeConsole } from '../../../lib/env-fallback.mjs'
// F02：代理路径复用与实时捕获**同一个有界解码器**（gzip 多成员总预算 + deflate/br 的 maxOutputLength），
//   原先这里直接 zlib.gunzipSync/inflateSync/... 无 maxOutputLength，解压炸弹会卡主线程 / 爆内存。
import { decodeContent } from './capture-engine.mjs'
import {
  applyHostsBlock, hostsBlockState, defaultHostsPath, validRedirectHost, caTrustState, safetyTaskState, MAX_HOSTS,
  readHostsText, hostsConflicts, resolveNoHostsFile, PROBE_SNI, PROBE_PATH, PROBE_HEADER, safetyLogPathFor, CA_ISSUER_CN,
} from './hosts-redirect.mjs'
import {
  compileRewriteScript, applyOps, charsetOf, isTextual, decodeBody, encodeBody, codecFor, emptyAllArrays, parseJsonLossless,
  validateHeader,
} from './rewrite-rules.mjs'
import { createProcessResolver } from './client-process.mjs'

const require = createRequire(import.meta.url)

/**
 * node-forge **按需加载**（F-037 派生）。
 *
 * 原来这里是模块顶层的 `const forge = require('node-forge')` ⇒ 任何 node 进程只要 `import`
 * 本模块，就必须能解析到 node-forge，否则**整个模块加载失败**。
 * 而仓库里 node-forge 只装在**部署副本**的 node_modules 下 ⇒ 仓库自己的校验**根本 import 不进来**
 *   （实测：插件目录里没有其它模块 import proxy-engine.mjs）。
 * 后果不是"少测一点"：`setSystemProxy()` 这条**会写用户注册表**的路径**一条校验都没有**，
 *   F-037（拿不可信备份去覆盖真实设置）就活在上面 —— 这是它能活到 r34 的直接原因。
 * 改成按需加载后，本模块在没有 node-forge 的环境里也能被 import（只有真正要用 CA 时才需要它），
 *   于是仓库校验可以直接覆盖代理引擎的逻辑路径。
 */
let _forge = null
function forgeLib() {
  if (_forge === null) _forge = require('node-forge')
  return _forge
}

/**
 * ⚠ 这里用 **Proxy 惰性转发**，而不是"在每个用到的地方写 `const forge = forgeLib()`"。
 *
 * 为什么（我第一版就是这么写错的，被真机验收当场抓住）：我数出全模块有 18 处 `forge.…`，
 * 以为它们都在 `ensureCa()` / `hostCert()` / `exportCaDer()` 三个函数里，就往那三处各插了一行。
 * 实际还有**第四处** —— `handleConnect()` 里 `tls.createSecureContext({ key: forge.pki… })`。
 * 那处没有 `forge` 绑定 ⇒ 每次 HTTPS 解密都抛 `ReferenceError` ⇒ **CONNECT 被重置**。
 * 症状是 `verify-proxy-live.mjs` 从 **47/47 掉到 43/47**（D 段全红、`counters.mitm=0`）——
 * 幸好那条真机验收一直在跑，是它把这次回归当场抓出来的。
 *
 * 教训：**"我以为只有 N 处"不能靠数数，要靠不依赖位置的改法。**
 * 用 Proxy 转发后，所有既有 `forge.xxx` 调用点**一行都不用改**，也就不存在"漏了第 4 处"。
 */
const forge = new Proxy({}, {
  get(_target, prop) {
    const real = forgeLib()
    const v = real[prop]
    return typeof v === 'function' ? v.bind(real) : v
  },
})

/**
 * 执行 `reg.exe` 并返回**原始 Buffer**（解码统一在 `readSystemProxy` 里做一次，见那里的注释）。
 * 与 `lib/env-fallback.mjs` 的 `defaultExec` 同构 —— 同一个问题只允许有一份实现。
 */
function defaultRegExec(args) {
  return execFileSync('reg.exe', args, {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  })
}


/** Per-field body cap for stored records (2MB). */
const BODY_CAP = 2 * 1024 * 1024
/** Stop buffering a body beyond this (still streams to the client). */
const BUFFER_CAP = 50 * 1024 * 1024
/** Abort an idle streaming response instead of retaining it forever. */
const STREAM_IDLE_TIMEOUT = 120000
/** Do not write a progress update for every tiny response chunk. */
const STREAM_UPDATE_MS = 250

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
])

function stripHopByHop(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(String(k).toLowerCase())) continue
    out[k] = v
  }
  return out
}

/** Headers that must be dropped when rebuilding a WebSocket request head. */
const WS_DROP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'proxy-authenticate'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

/** Glob (* wildcard only) → anchored case-insensitive regexp. R7-09：'?' 是字面量（查询串分隔符），不是正则量词。 */
function globToRegExp(pattern) {
  const esc = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${esc}$`, 'i')
}

/** URL 去掉查询串与尾部斜杠，小写比较（'path' 匹配：同一接口不同参数算同一条）。 */
function urlPathKey(u) {
  return String(u ?? '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase()
}

/** 绝对 URL 的路径部分（不含查询串）；解析不了返回 null。 */
function pathnameOf(u) {
  try {
    return new URL(String(u ?? '')).pathname
  } catch {
    return null
  }
}

/**
 * 'path' 匹配：模式是完整 URL 时比「源站 + 路径」；模式以 / 开头时只比路径（任意主机）——
 * 面板上这个选项就叫「接口路径」，用户自然会只填 /api/xxx（C22：原来只认完整 URL，填路径的规则永远不命中）。
 */
function pathMatches(reqUrl, pattern) {
  const p = String(pattern ?? '').trim()
  if (p.startsWith('/')) {
    const reqPath = pathnameOf(reqUrl)
    return reqPath !== null && urlPathKey(reqPath) === urlPathKey(p)
  }
  return canonicalUrlKey(reqUrl) === canonicalUrlKey(p)
}

/** R7-10：完整 URL 先经 new URL 归一（去掉显式默认端口 :443 / :80、主机小写），再按 urlPathKey 比；解析不了按原文。 */
function canonicalUrlKey(u) {
  try {
    const x = new URL(String(u ?? ''))
    return urlPathKey(`${x.protocol}//${x.host}${x.pathname}`)
  } catch {
    return urlPathKey(u)
  }
}

/**
 * AutoResponder rule match. Rule shape:
 * { id, enabled, name, quick?, matchAll?, match: { method?, host?, url?, urlType? ('path'|'contains'|'glob'|'regex') },
 *   action: { type: 'mock'|'map-local'|'map-remote'|'rewrite'|'delay'|'hang'|'block'|'rewrite-status',
 *             latencyMs?, responseDelayMs?, jitterMs?, throttleKbps?, status?, headers?, body?, charset?, file?, target?,
 *             script?, ops? }, hits }
 */
function matchRule(rule, req) {
  if (rule === null || rule === undefined || rule.enabled === false) return false
  const m = rule.match ?? {}
  if (m.method && String(m.method).toUpperCase() !== String(req.method).toUpperCase()) return false
  if (m.host && String(m.host).trim() !== '' && String(req.host).toLowerCase() !== String(m.host).trim().toLowerCase()) return false
  const pattern = String(m.url ?? '').trim()
  if (pattern === '') return true
  const type = m.urlType ?? 'contains'
  if (type === 'path') return pathMatches(req.url, pattern)
  if (type === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(req.url)
    } catch {
      return false
    }
  }
  if (type === 'glob') return globToRegExp(pattern).test(req.url)
  return String(req.url).toLowerCase().includes(pattern.toLowerCase())
}

/**
 * Minimal WebSocket frame splitter (RFC 6455).
 * One instance per direction; `feed` appends raw bytes and returns parsed frames.
 * For masked directions pass mask=true (client→server). Text payloads are decoded
 * (utf-8) and fragmented messages are reassembled; a close frame reports its code.
 */
class WsFrameParser {
  constructor({ masked, onText = () => {} } = {}) {
    this.masked = masked === true
    this.carry = Buffer.alloc(0)
    this.frames = [] // {op, len, fin, text?}
    this.textBuf = ''
    this.fragmentOp = null
    this.closeCode = null
    this.closeReason = ''
    this.msgCount = 0
    this.frameCount = 0
    this.onText = onText
  }

  /** Parse as many frames as possible; returns true when nothing malformed was seen. */
  feed(chunk) {
    this.carry = Buffer.concat([this.carry, chunk])
    while (true) {
      const buf = this.carry
      if (buf.length < 2) return true
      const b0 = buf[0]
      const fin = (b0 & 0x80) !== 0
      const op = b0 & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return true
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return true
        const big = buf.readBigUInt64BE(2)
        if (big > 0x7fffffffffffffffn) {
          this.carry = Buffer.alloc(0) // absurd length — drop
          return false
        }
        len = Number(big)
        offset = 10
      }
      let maskKey = null
      if (masked) {
        if (buf.length < offset + 4) return true
        maskKey = buf.subarray(offset, offset + 4)
        offset += 4
      }
      if (len > 16 * 1024 * 1024) {
        this.carry = Buffer.alloc(0) // refuse to buffer giant frames
        return false
      }
      if (buf.length < offset + len) return true
      let payload = buf.subarray(offset, offset + len)
      this.carry = buf.subarray(offset + len)
      if (maskKey !== null) {
        const out = Buffer.alloc(payload.length)
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3]
        payload = out
      }
      this.frameCount++
      const rec = { op, len, fin }
      const isText = op === 1 || (op === 0 && this.fragmentOp === 1)
      if (isText) {
        const text = payload.toString('utf8')
        this.textBuf += text
        if (op === 1) this.msgCount++
        if (this.textBuf.length > 2 * 1024 * 1024) this.textBuf = this.textBuf.slice(0, 2 * 1024 * 1024)
        rec.text = text.length > 4000 ? text.slice(0, 4000) + '…' : text
      } else if (op === 8) {
        if (payload.length >= 2) {
          this.closeCode = payload.readUInt16BE(0)
          try {
            this.closeReason = payload.subarray(2).toString('utf8').slice(0, 120)
          } catch {
            this.closeReason = ''
          }
        }
      }
      if (this.frames.length < 300) this.frames.push(rec)
      if (!fin && (op === 1 || op === 2)) this.fragmentOp = op
      if (fin && isText) {
        this.onText(this.textBuf)
        this.textBuf = ''
      }
      if (fin && (op === 0 || op === 1 || op === 2)) this.fragmentOp = null
    }
  }
}

/** Decode a raw body for storage: gzip/deflate/br, charset-aware (GBK etc.), image=base64, binary=hex, capped. */
function bodyForStore(rawBuf, encoding, contentType) {
  if (rawBuf.length === 0) return ''
  let buf = rawBuf
  const enc = String(encoding ?? '').toLowerCase()
  if (enc.includes('gzip') || enc.includes('deflate') || enc.includes('br')) {
    // F02：走共享有界解码器；解不开 / 超出解码预算一律返回 ''（与原"undecodable 压缩流"语义一致），
    //   绝不把未完整解出的字节当正文落库。
    const decoded = decodeContent(buf, enc)
    if (decoded === null) return ''
    buf = decoded
  }
  const ct = String(contentType ?? '').toLowerCase()
  if (ct.includes('image/')) {
    if (buf.length <= 1.5 * 1024 * 1024) {
      const mime = ct.split(';')[0].trim()
      return `base64:${mime};${buf.toString('base64')}`
    }
    return ''
  }
  let charset = null
  const cm = /charset=["']?([\w-]+)/i.exec(contentType ?? '')
  if (cm !== null) charset = cm[1].toLowerCase()
  let text
  try {
    text = new TextDecoder(charset ?? 'utf-8').decode(buf)
  } catch {
    text = buf.toString('utf8')
  }
  let control = 0
  for (let i = 0; i < Math.min(text.length, 512); i++) {
    const c = text.charCodeAt(i)
    if (c < 9 || (c > 13 && c < 32)) control++
  }
  if (control > 16 && !text.startsWith('{') && !text.startsWith('[')) {
    const cap = Math.min(buf.length, 64 * 1024)
    return 'hex:' + buf.subarray(0, cap).toString('hex')
  }
  if (text.length > BODY_CAP) text = text.slice(0, BODY_CAP) + '…(截断)'
  return text
}

/**
 * Read WinINET proxy settings (HKCU).
 *
 * F-037（2026-09-12 r34，读代码查出 —— 这条**会写坏用户的机器设置**）：
 *   原实现分三次 `reg query /v <name>`，全部包在**同一个** try/catch 里，
 *   任何一步失败都 `catch {}` 后返回默认值 `{enable:false, server:'', override:''}` ——
 *   也就是把"**没读到**"和"**读到就是没有**"压成了同一个返回值。
 *   而它唯一的消费者 `setSystemProxy()` 拿这个返回值当**备份**：
 *     · 备份记成"用户没开代理" ⇒ 恢复时写 `ProxyEnable=0` ⇒
 *       **把用户真实的"代理开着"改成"关着"**，并且这份错备份还会 `sysproxy-backup.json` 落盘持久化；
 *     · 更短的一条路：**从没备份过就调 `setSystemProxy(false)`**，原实现走 `backup === null`
 *       分支直接写 `ProxyEnable=0` —— "我们没动过它，却把它关了"。
 *   本机实测：用户当前 `ProxyEnable=1`、`ProxyServer=127.0.0.1:6518`（他自己的代理）。
 *   所以这不是理论问题，是"一条命中就会关掉用户代理"的路径。
 *
 * 现在的做法：
 *   ① **一次** `reg query <key>`（不按 /v 逐个查）⇒ "值不存在"与"reg 失败"不再混淆：
 *      整键查到了 ⇒ 缺哪个值就是**真的没设**（`ok:true`）；整键都查不到 ⇒ `ok:false`。
 *   ② 返回 **`ok`** 明说这次读是否可信；**部分失败不再丢弃已经读到的值**。
 *   ③ 用**共享的 OEM 解码**读 stdout（`decodeConsole`）—— `reg.exe` 输出是控制台码页，
 *      按 UTF-8 硬解会把 `ProxyOverride` 里可能的中文绕过条目弄成 U+FFFD，
 *      而那串值**会被原样写回注册表**（见 F-036，同一个根因，后果更重：直接改坏用户设置）。
 */
export function readSystemProxy(options = {}) {
  const run = options.exec || defaultRegExec
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  let text = null
  try {
    text = run(['query', KEY])
  } catch {
    text = null
  }
  // 与 `lib/env-fallback.mjs` 的 `readRegistryEnv` **同一契约**：exec 可以直接给 Buffer，
  // Buffer 必须走 OEM 解码（`String(buf)` 等于按 UTF-8 硬解，中文值必坏）。
  if (Buffer.isBuffer(text)) text = decodeConsole(text)
  if (text === null || text === undefined) {
    // ★ 读不到就是**读不到** —— 绝不伪装成"默认值"。调用方必须据此拒绝写注册表。
    return {
      ok: false, enable: false, server: '', override: '',
      reason: 'reg-query-failed',
      detail: '整键 reg query 失败（reg.exe 不可用 / 权限 / 编码异常）—— 本次读**不可信**，不得据此备份或恢复',
    }
  }
  const readOne = (name, re) => {
    const m = re.exec(text)
    return m === null ? null : m[1].trim()
  }
  const enableRaw = readOne('ProxyEnable', /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+)/m)
  const server = readOne('ProxyServer', /^\s*ProxyServer\s+REG_SZ\s+(.*)$/m)
  const override = readOne('ProxyOverride', /^\s*ProxyOverride\s+REG_SZ\s+(.*)$/m)
  return {
    ok: true,
    enable: enableRaw !== null && Number.parseInt(enableRaw, 16) === 1,
    server: server === null ? '' : server,
    override: override === null ? '' : override,
    // 值不存在 ≠ 读失败：整键已读到，所以缺项就是"真的没设"。
    present: { enable: enableRaw !== null, server: server !== null, override: override !== null },
  }
}

function writeSystemProxy({ enable, server, override }) {
  const reg = (args) => {
    return new Promise((resolve) => {
      execFile('reg.exe', args, { encoding: 'utf8' }, (error, stdout) => {
        resolve(error === null ? stdout : null)
      })
    })
  }
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  if (server !== '' && server !== undefined) {
    return reg(['add', key, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']).then(async () => {
      await reg(['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable ? '1' : '0', '/f'])
      if (override !== undefined && override !== '') {
        await reg(['add', key, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f'])
      }
      return true
    })
  }
  return reg(['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable ? '1' : '0', '/f']).then(() => true)
}

/** Notify WinINET of the settings change (InternetSetOption 39 + 37). */
function refreshWinInet() {
  return new Promise((resolve) => {
    const ps = [
      "Add-Type @'",
      'using System; using System.Runtime.InteropServices;',
      'public class WinInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }',
      "'@",
      '[WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
      '[WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
    ].join('\n')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 }, (error) => {
      resolve(error === null)
    })
  })
}

/**
 * Parse an upstream proxy spec into { host, port, auth }.
 * Accepts `http://127.0.0.1:6518`, bare `host:port`, `user:pass@host:port`
 * (auth → preemptive Basic header), and WinINET's per-protocol form
 * `http=host:80;https=host:443;socks=host:1080`. We chain a single upstream,
 * so the segmented form prefers the https segment (covers CONNECT tunnels +
 * most captured traffic), then http, then socks, then whatever's first.
 */
function parseUpstream(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null
  let s = spec.trim()
  if (s.includes('=')) {
    const segs = {}
    for (const part of s.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      const scheme = part.slice(0, eq).trim().toLowerCase()
      const val = part.slice(eq + 1).trim()
      if (scheme !== '' && val !== '') segs[scheme] = val
    }
    s = segs.https || segs.http || segs.socks || Object.values(segs)[0] || ''
    if (s === '') return null
  }
  if (!s.includes('://')) s = 'http://' + s
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  const host = u.hostname || '127.0.0.1'
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  let auth = null
  if (u.username !== '') {
    // 上游代理凭据（企业代理常需 407 认证）→ 预置 Basic 头，绝不落日志。
    const user = decodeURIComponent(u.username)
    const pass = decodeURIComponent(u.password)
    auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  }
  return { host, port, auth }
}

/**
 * 上游 TLS 校验用的根证书集：Node 自带 + Windows 系统存储 + NODE_EXTRA_CA_CERTS（C35）。
 * 用 tls.getCACertificates 显式合并，结论不依赖宿主进程有没有继承 NODE_USE_SYSTEM_CA。
 */
let upstreamCaCache = null
function upstreamCa() {
  if (upstreamCaCache !== null) return upstreamCaCache || undefined
  const list = []
  if (typeof tls.getCACertificates === 'function') {
    for (const type of ['bundled', 'system', 'extra']) {
      try { list.push(...tls.getCACertificates(type)) } catch { /* 该类型不支持 */ }
    }
  }
  upstreamCaCache = list.length > 0 ? [...new Set(list)] : false
  return upstreamCaCache || undefined
}

/** 缺中间证书这一类：Windows（.NET 客户端）会按 AIA 自动补链，Node/OpenSSL 不会 ⇒ 多半不是攻击，只是链不全。 */
const INCOMPLETE_CHAIN_ERRORS = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

/** 多个候选地址时，每个地址的连接超时（只有一个地址时交给系统，不人为截断）。 */
const PINNED_CONNECT_TIMEOUT_MS = 4000

/**
 * 按固定 IP 列表依次连（C30）：前面的连不上（拒绝 / 超时 / 不可达）就换下一个，并通过 pin.fail 让它冷却；
 * 与 .NET ServicePoint 直连时「同一次连接里逐个地址尝试」的行为对齐。
 */
function connectPinned({ port, pin }, cb) {
  const ips = Array.isArray(pin.ips) ? pin.ips : []
  let i = 0
  const tryNext = (lastError) => {
    if (i >= ips.length) {
      cb(lastError ?? Object.assign(new Error('没有可用的上游地址'), { code: 'EAPVNOADDR' }))
      return
    }
    const ip = ips[i++]
    const last = i >= ips.length
    const s = net.connect(port, ip)
    let timer = null
    let settled = false
    const onConnect = () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      s.removeListener('error', onError)
      if (typeof pin.ok === 'function') pin.ok(ip)
      cb(null, s, ip)
    }
    const onError = (e) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      s.removeListener('connect', onConnect)
      s.on('error', () => {}) // 销毁后的迟到错误不许变成未捕获异常
      s.destroy()
      if (typeof pin.fail === 'function') pin.fail(ip, e)
      tryNext(e)
    }
    s.once('connect', onConnect)
    s.once('error', onError)
    if (!last) {
      timer = setTimeout(() => onError(Object.assign(new Error(`连接 ${ip}:${port} 超时（${PINNED_CONNECT_TIMEOUT_MS}ms），换下一个地址`), { code: 'ETIMEDOUT' })), PINNED_CONNECT_TIMEOUT_MS)
    }
  }
  tryNext(null)
}

/**
 * 按名字连时的环路保护：域名在 hosts 里被我们指向拦截监听地址、而又拿不到固定 IP 时，
 * 直连会连回自己的监听（请求在本机兜圈子，直到连接数耗尽）。宁可报错，也不能自己打自己。
 */
function guardedLookup(isForbidden) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err)
        return
      }
      const loop = (ip) => Object.assign(new Error(`${hostname} 解析到了透明拦截自己的监听地址 ${ip}（hosts 段落还在而拿不到真实 IP）——直连会形成环路，已拒绝`), { code: 'EAPVLOOP' })
      if (Array.isArray(address)) {
        const ok = address.filter((a) => !isForbidden(a.address))
        if (ok.length === 0 && address.length > 0) {
          callback(loop(address[0].address))
          return
        }
        callback(null, ok)
        return
      }
      if (isForbidden(address)) {
        callback(loop(address))
        return
      }
      callback(null, address, family)
    })
  }
}

/**
 * Open (and optionally TLS-wrap) a connection to host:port, chaining through the upstream proxy when set.
 *
 * `pinned(host)`（可选）：透明拦截期间，被重定向的域名在 hosts 里指向本机 —— 这时**绝不能**再按名字解析
 * （会解析回自己，形成环路）。pinned 返回 `{ ips, ok(ip), fail(ip, err) }`：启用拦截前解析到的真实 IP（健康的排前面），
 * 直连时按 IP 逐个尝试、TLS 的 SNI 仍是原域名；返回 null = 照常按名字解析（此时 `guard(ip)` 拦住解析回拦截地址的环路）。
 * `verify`：null = 不校验上游证书（正向代理的既有行为）；'warn' = 校验但只把结论挂在 socket.__apvTls 上；
 * 'strict' = 校验失败直接拒绝（C35）。
 */
function tunnelConnect({ upstream, host, port, secure, pinned = null, guard = null, verify = null }, cb, timing = null) {
  let done = false
  const fail = (error) => {
    if (done) return
    done = true
    cb(error)
  }
  const markConnect = () => {
    if (timing !== null && timing.connectMs === null) timing.connectMs = Date.now() - timing.t0
  }
  const wrapTls = (socket) => {
    markConnect()
    if (!secure) {
      done = true
      cb(null, socket)
      return
    }
    const tlsStarted = Date.now()
    const ca = verify ? upstreamCa() : undefined
    const t = tls.connect({
      socket,
      servername: host,
      rejectUnauthorized: false, // 结论由下面按 verify 模式处理；正向代理沿用 capture-first 的既有行为（见 README）
      ...(ca !== undefined ? { ca } : {}),
    })
    t.once('secureConnect', () => {
      if (timing !== null) timing.tlsMs = Date.now() - tlsStarted
      if (done) {
        t.destroy()
        return
      }
      if (verify) {
        const error = t.authorized === true ? null : String(t.authorizationError ?? 'unknown')
        t.__apvTls = { authorized: error === null, error, incompleteChain: error !== null && INCOMPLETE_CHAIN_ERRORS.has(error) }
        if (verify === 'strict' && error !== null) {
          t.destroy()
          fail(Object.assign(new Error(`上游证书校验失败（${error}），严格模式下已拒绝`), { code: 'EAPVUPSTREAMTLS' }))
          return
        }
      }
      done = true
      cb(null, t)
    })
    t.once('error', fail)
  }
  const connectDirect = () => {
    const pin = typeof pinned === 'function' ? pinned(host) : null
    if (pin !== null && pin !== undefined && Array.isArray(pin.ips) && pin.ips.length > 0) {
      connectPinned({ port, pin }, (error, s) => {
        if (error) fail(error)
        else {
          s.once('error', fail)
          wrapTls(s)
        }
      })
      return
    }
    const s = net.connect(typeof guard === 'function' ? { port, host, lookup: guardedLookup(guard) } : { port, host })
    s.once('connect', () => wrapTls(s))
    s.once('error', fail)
  }
  if (upstream === null || upstream === undefined) {
    connectDirect()
    return
  }
  const s = net.connect(upstream.port, upstream.host)
  s.once('connect', () => {
    let connectReq = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n`
    if (upstream.auth) connectReq += `Proxy-Authorization: ${upstream.auth}\r\n`
    connectReq += '\r\n'
    s.write(connectReq)
    let buf = ''
    const onData = (d) => {
      buf += d.toString('latin1')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      s.removeListener('data', onData)
      const head = buf.slice(0, idx)
      const statusLine = head.split('\r\n')[0]
      const status = Number.parseInt(statusLine.split(' ')[1], 10)
      if (status === 200) {
        markConnect()
        wrapTls(s)
      } else if (status === 407) {
        // 企业代理要求认证。已带凭据仍 407 = 账号密码不对；未带 = 需要在上游
        // 地址用 user:pass@host:port 提供。Basic 预置即可；NTLM/Negotiate 多握
        // 手暂不支持，把 scheme 透传到错误里方便定位。
        s.destroy()
        const schemeM = /Proxy-Authenticate:\s*(\S+)/i.exec(buf)
        const scheme = schemeM !== null ? schemeM[1] : ''
        fail(new Error(upstream.auth
          ? `上游代理认证失败(407)，请检查代理账号密码`
          : `上游代理需要认证(407${scheme !== '' ? ' ' + scheme : ''})，请用 user:pass@host:port 提供凭据`))
      } else {
        s.destroy()
        fail(new Error(`upstream CONNECT failed: ${statusLine}`))
      }
    }
    s.on('data', onData)
  })
  s.once('error', fail)
}

/**
 * 空闲上游连接的保留时长（C34）：服务端的 keep-alive 常见只有几秒，留得比它久，
 * 下一次复用就可能撞上对端刚发出的 FIN（ECONNRESET / socket hang up）。服务端给了 Keep-Alive: timeout=N 时 Node 会取更小值。
 */
const AGENT_FREE_SOCKET_MS = 4000

/** Plain-HTTP agent whose connections are chained through the upstream proxy. */
class ForwardAgent extends http.Agent {
  constructor({ upstream, pinned = null, guard = null }) {
    super({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: AGENT_FREE_SOCKET_MS })
    this.upstream = upstream
    this.pinned = pinned
    this.guard = guard
  }

  createConnection(options, cb) {
    tunnelConnect({ upstream: this.upstream, host: options.host, port: options.port, secure: false, pinned: this.pinned, guard: this.guard }, cb, options.__timing ?? null)
  }
}

/** HTTPS agent: upstream-chained CONNECT + TLS inside createConnection (protocol must be https:). */
class SecureForwardAgent extends https.Agent {
  constructor({ upstream, pinned = null, guard = null, verify = null }) {
    super({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: AGENT_FREE_SOCKET_MS })
    this.upstream = upstream
    this.pinned = pinned
    this.guard = guard
    this.verify = verify
  }

  createConnection(options, cb) {
    tunnelConnect({ upstream: this.upstream, host: options.host, port: options.port, secure: true, pinned: this.pinned, guard: this.guard, verify: this.verify }, cb, options.__timing ?? null)
  }
}
/** 透明拦截默认监听地址：一个不常用的回环地址，避开 127.0.0.1 上已有的 80/443 服务。 */
export const DEFAULT_INTERCEPT_IP = '127.77.0.1'
/**
 * 透明拦截监听的 TLS 兼容面：.NET Framework 4.5.2 默认只开 SSL3|TLS1.0，客户端要等某个静态构造执行后才追加 TLS1.1/1.2
 * ⇒ 早于它发出的请求只会提供 TLS1.0。Node 默认最低 TLS1.2（OpenSSL 3 还要 SECLEVEL=0 才肯用 1.0 的套件），
 * 不放宽的话这些请求经拦截后会握手失败，而直连真实服务器时是好的 —— 正是"抓包把客户端搞坏"的那种回归。
 * 只用于本机回环上的拦截监听；我们连真实服务器那一侧仍按 Node 默认（TLS1.2+）。
 */
const INTERCEPT_TLS_COMPAT = { minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' }
/**
 * TLS 端口上收到的不是 TLS（C32）：安全网探针现在走完整 TLS 握手（SNI = PROBE_SNI）并单独计数，
 * 所以这两种错误只可能来自真实流量 —— 明文 HTTP 打到了 TLS 端口（该写 http://host:port），
 * 或裸 TCP 协议打到了 TLS 端口（该写 tcp://host:port）。都要告警，不能再当成探针吞掉。
 */
const PLAIN_HTTP_ON_TLS = 'ERR_SSL_HTTP_REQUEST'
const NON_TLS_ON_TLS = 'ERR_SSL_WRONG_VERSION_NUMBER'
/** 停用拦截后的排空期：.NET ServicePoint 会把解析结果缓存 120s（DnsRefreshTimeout），排空期要盖住它。 */
const INTERCEPT_DRAIN_MS = 150000
/** 改写 / 响应断点需要整包缓冲；超过这个大小就不改，原样流式下发。 */
const REWRITE_CAP = 32 * 1024 * 1024
/** 代理侧"刚拦到过"的请求记忆窗口（与实时日志的同一请求去重）。 */
const DEDUPE_WINDOW_MS = 15000
/** 挂起（模拟超时）的默认时长：要比 HttpWebRequest 默认 Timeout（100s）长，客户端才会走它自己的超时分支（C26）。 */
const HANG_DEFAULT_MS = 120000
/** 上游地址连不上后的冷却时间：冷却期内排到候选列表最后（C30）。 */
const PIN_COOLDOWN_MS = 60000
/** 关闭拦截监听时等连接自然收尾的上限；到点强制断开，绝不让停用/卸载无限期挂住（C2）。 */
const CLOSE_GRACE_MS = 2000
/** 流式响应（SSE / multipart 推送）永远不结束：不能整包缓冲去做改写或响应断点（C20）。 */
const STREAMING_CONTENT_RE = /text\/event-stream|multipart\/x-mixed-replace/i

const MAP_LOCAL_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

const RULE_TYPES = ['mock', 'map-local', 'map-remote', 'rewrite', 'delay', 'hang', 'block', 'rewrite-status']
const URL_TYPES = ['path', 'contains', 'glob', 'regex']
/** 只有"变慢"可以作用于全部请求；其余动作必须指定 URL/主机/方法，或显式 matchAll（C13：形状写错的规则曾变成全局 mock）。 */
const CATCH_ALL_OK = new Set(['delay'])
/** 单条 mock 响应体上限（规则存在 JSON 文件里、整表随面板/工具往返）。 */
const MOCK_BODY_CAP = 8 * 1024 * 1024

/** 一键 mock 的预设（UI / 工具共用）。slow / timeout 的时长可由调用方的 latencyMs 覆盖。 */
export const QUICK_PRESETS = {
  'empty-object': { type: 'mock', status: 200, body: '{}', label: '空对象 {}' },
  'empty-array': { type: 'mock', status: 200, body: '[]', label: '空数组 []' },
  'empty-lists': { type: 'mock', status: 200, needsOriginal: true, label: '保留外壳、清空所有数组' },
  original: { type: 'mock', status: 200, needsOriginal: true, label: '原响应（可再编辑）' },
  'error-500': { type: 'mock', status: 500, body: '{"code":500,"message":"mock error"}', label: 'HTTP 500' },
  'not-found': { type: 'mock', status: 404, body: '', label: 'HTTP 404' },
  slow: { type: 'delay', latencyMs: 3000, label: '延迟后正常返回' },
  timeout: { type: 'hang', latencyMs: HANG_DEFAULT_MS, label: '挂起不回包（客户端自己超时，最长 2 分钟）' },
  reset: { type: 'block', label: '立即断开连接（网络错误）' },
  body: { type: 'mock', status: 200, label: '自定义响应体' },
}

/**
 * 全局弱网预设（对标 Fiddler「Rules → Performance → Simulate Modem Speeds」）。
 * 数值单位：延迟 ms；带宽 KB/s（Fiddler 的 trickle-delay 是 ms/KB：300ms/KB ≈ 3.3KB/s，150ms/KB ≈ 6.7KB/s）。
 */
export const NETSIM_PRESETS = {
  off: { label: '关闭', values: { requestDelayMs: 0, responseDelayMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0 } },
  modem: { label: 'Fiddler 调制解调器（上行 300ms/KB · 下行 150ms/KB）', values: { requestDelayMs: 0, responseDelayMs: 0, jitterMs: 0, downKbps: 6.7, upKbps: 3.3 } },
  '2g': { label: '2G（延迟 650±200ms · 下行 31KB/s）', values: { requestDelayMs: 650, responseDelayMs: 0, jitterMs: 200, downKbps: 31, upKbps: 6 } },
  '3g': { label: '3G（延迟 300±100ms · 下行 94KB/s）', values: { requestDelayMs: 300, responseDelayMs: 0, jitterMs: 100, downKbps: 94, upKbps: 31 } },
  'weak-4g': { label: '弱 4G（延迟 150±80ms · 下行 500KB/s）', values: { requestDelayMs: 150, responseDelayMs: 0, jitterMs: 80, downKbps: 500, upKbps: 200 } },
  'high-latency': { label: '高延迟（2000±500ms，带宽不限）', values: { requestDelayMs: 2000, responseDelayMs: 0, jitterMs: 500, downKbps: 0, upKbps: 0 } },
  'slow-api': { label: '接口处理慢（回包前等 3s，带宽不限）', values: { requestDelayMs: 0, responseDelayMs: 3000, jitterMs: 0, downKbps: 0, upKbps: 0 } },
}

const NETSIM_DEFAULT = { enabled: false, requestDelayMs: 0, responseDelayMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, hosts: '', urlFilter: '', scope: 'all' }

/** 读落盘的弱网参数；开关永远从"关"开始。 */
function loadNetsim(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...NETSIM_DEFAULT, ...saved, enabled: false }
  } catch {
    return { ...NETSIM_DEFAULT }
  }
}

/** base ± jitter（下限 0）。 */
function jittered(base, jitter) {
  const b = Math.max(0, Number(base) || 0)
  const j = Math.max(0, Number(jitter) || 0)
  if (j === 0) return b
  return Math.max(0, Math.round(b + (Math.random() * 2 - 1) * j))
}

function minPositive(...vals) {
  const v = vals.map(Number).filter((x) => Number.isFinite(x) && x > 0)
  return v.length > 0 ? Math.min(...v) : 0
}

/**
 * 写出响应体并等到真正写完（C28）：客户端中途断开 ⇒ 返回 false，调用方把记录标成未完成。
 * kbps>0 时按 100ms 一片限速；写入遵守背压（write 返回 false 就等 drain）。
 */
function sendBody(res, buf, kbps = 0) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (v) => {
      if (settled) return
      settled = true
      res.removeListener('finish', onFinish)
      res.removeListener('close', onClose)
      resolve(v)
    }
    const onFinish = () => settle(true)
    const onClose = () => settle(res.writableFinished === true)
    res.once('finish', onFinish)
    res.once('close', onClose)
    if (res.destroyed) {
      settle(false)
      return
    }
    const bps = Math.max(0, Number(kbps) || 0) * 1024
    if (bps <= 0 || buf.length === 0) {
      try { res.end(buf) } catch { settle(false) }
      return
    }
    const slice = Math.max(256, Math.floor(bps / 10))
    let off = 0
    const pump = () => {
      if (settled) return
      if (res.destroyed) {
        settle(false)
        return
      }
      if (off >= buf.length) {
        try { res.end() } catch { settle(false) }
        return
      }
      const chunk = buf.subarray(off, off + slice)
      off += chunk.length
      let ok
      try { ok = res.write(chunk) } catch { settle(false); return }
      const next = () => setTimeout(pump, Math.min(10000, (chunk.length / bps) * 1000))
      if (ok) next()
      else res.once('drain', next)
    }
    pump()
  })
}

/**
 * 写响应头前逐个校验（C6）：非法的头名/头值（中文、空格、换行…）会让 writeHead 抛异常 ——
 * 原来异常被当成"客户端已断开"吞掉、res 也没结束 ⇒ 客户端一直等到它自己的超时。
 * 现在：丢掉非法头并记下来；万一 writeHead 仍然失败（例如状态码非法），头还没发出就回 500 说明原因，否则断开。
 */
function safeWriteHead(res, status, headers) {
  const clean = {}
  const dropped = []
  for (const [k, v] of Object.entries(headers ?? {})) {
    const values = Array.isArray(v) ? v.map(String) : [String(v ?? '')]
    let ok = true
    try {
      http.validateHeaderName(k)
      for (const one of values) http.validateHeaderValue(k, one)
    } catch {
      ok = false
    }
    if (ok) clean[k] = Array.isArray(v) ? values : values[0]
    else dropped.push(k)
  }
  try {
    res.writeHead(status, clean)
    return { ok: true, dropped }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-api-visualizer: 响应头写出失败：' + msg)
      } else {
        res.destroy()
      }
    } catch {
      try { res.destroy() } catch { /* gone */ }
    }
    return { ok: false, dropped, error: msg }
  }
}

function delayNote({ pre = 0, post = 0, kbps = 0, sim = null } = {}) {
  const parts = []
  if (pre > 0) parts.push(`请求延迟 ${pre}ms`)
  if (post > 0) parts.push(`回包延迟 ${post}ms`)
  if (kbps > 0) parts.push(`限速 ${kbps}KB/s`)
  if (sim !== null && sim !== undefined) parts.push('含全局弱网')
  return parts.length > 0 ? ' · ' + parts.join('，') : ''
}

/**
 * Windows 正在用的 IPv4 DNS 服务器（c-ares 兜底解析用）。
 * C36：并发调用共享同一次 PowerShell（in-flight 复用）；失败或空结果**不缓存**，下次再查。
 */
let dnsServersCache = null
let dnsServersInflight = null
function windowsDnsServers() {
  if (dnsServersCache !== null && Date.now() - dnsServersCache.at < 10 * 60 * 1000) return Promise.resolve(dnsServersCache.list)
  if (dnsServersInflight !== null) return dnsServersInflight
  dnsServersInflight = new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve([]); return }
    const ps = "Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { $_.ServerAddresses } | Select-Object -Unique"
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
      const list = error === null
        ? String(stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+(\.\d+){3}$/.test(s) && !s.startsWith('127.'))
        : []
      if (list.length > 0) dnsServersCache = { at: Date.now(), list }
      resolve(list)
    })
  }).finally(() => { dnsServersInflight = null })
  return dnsServersInflight
}

function isLoopbackIp(ip) {
  return /^127\./.test(ip) || ip === '0.0.0.0' || ip === '::1' || ip === '::'
}

/** c-ares 兜底（不读 hosts，但也不认 NRPT / 分网卡 DNS —— 只在 Windows DNS 客户端查询失败时用）。 */
async function resolveViaCares(host) {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 })
  const servers = await windowsDnsServers()
  if (servers.length > 0) resolver.setServers(servers)
  const recs = await resolver.resolve4(host, { ttl: true })
  const ips = recs.map((r) => r.address).filter((ip) => !isLoopbackIp(ip))
  if (ips.length === 0) throw new Error('只解析到回环地址')
  const ttl = Math.min(...recs.map((r) => Number(r.ttl) || 0))
  return { ips, ttlMs: Math.max(60, Math.min(ttl || 300, 3600)) * 1000, via: servers.length > 0 ? `c-ares ${servers[0]}` : 'c-ares' }
}

/**
 * 批量解析真实上游 IP（C31 / C36）。
 *   · `before-redirect`：hosts 里还没有我们的段落 ⇒ dns.lookup，与客户端同一条解析路径（连用户自己的 hosts 条目都一致）；
 *   · `after-redirect`：hosts 已指向本机，必须绕开 hosts —— 一次 PowerShell `Resolve-DnsName -NoHostsFile` 查全部名字
 *     （走 Windows DNS 客户端：认 NRPT / VPN 分流 / 网卡顺序，并带 TTL），个别失败的再用 c-ares 兜底。
 * 返回 Map<host, { ips, ttlMs, via } | { error }>。
 */
async function defaultResolveBatch(hosts, { phase = 'after-redirect' } = {}) {
  const out = new Map()
  const list = [...new Set(hosts)]
  if (phase === 'before-redirect') {
    await Promise.all(list.map(async (host) => {
      try {
        const all = await dns.promises.lookup(host, { all: true, family: 4 })
        const ips = all.map((a) => a.address).filter((ip) => !isLoopbackIp(ip))
        if (ips.length > 0) {
          out.set(host, { ips, ttlMs: 5 * 60 * 1000, via: 'system' })
          return
        }
      } catch {
        // 落到下面的 after-redirect 路径
      }
    }))
  }
  const rest = list.filter((h) => !out.has(h))
  if (rest.length === 0) return out
  let viaWindows = new Map()
  if (process.platform === 'win32') {
    try { viaWindows = await resolveNoHostsFile(rest, { timeoutMs: 20000 }) } catch { viaWindows = new Map() }
  }
  await Promise.all(rest.map(async (host) => {
    const w = viaWindows.get(host)
    const wIps = w && Array.isArray(w.ips) ? w.ips.filter((ip) => !isLoopbackIp(ip)) : []
    if (w && !w.error && wIps.length > 0) {
      out.set(host, { ips: wIps, ttlMs: Math.max(60000, Number(w.ttlMs) || 300000), via: 'windows-dns' })
      return
    }
    try {
      out.set(host, await resolveViaCares(host))
    } catch (e) {
      out.set(host, { error: (w && w.error ? `Windows DNS: ${w.error}；` : '') + `c-ares: ${e instanceof Error ? e.message : String(e)}` })
    }
  }))
  return out
}

/**
 * 拦截列表解析：'host' → 443(https)+80(http)；'https://host:8443' / 'http://host:8090' / 'host:8443'(按 https)；
 * 'tcp://host:9000' = 原样 TCP 透传（不解析、不记录）—— hosts 重定向对一个域名的**所有端口**生效，
 * 这个域名上若还有非 HTTP 的端口（行情推送长连接之类），不列出来就会连不上。
 * 返回 { hosts: Map<host, [{port, secure, mode}]>, ports: Map<port, mode>, errors[] }；mode = 'https'|'http'|'tcp'。
 */
export function parseInterceptList(list) {
  const hosts = new Map()
  const ports = new Map()
  const tcpOwner = new Map() // tcp 端口 → 域名（裸 TCP 没有 SNI/Host 头，一个端口只能对应一个域名）
  const errors = []
  const items = (Array.isArray(list) ? list : String(list ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean)
  for (const item of items) {
    let host
    let entries
    if (/^[a-z]+:\/\//i.test(item)) {
      let u
      try { u = new URL(item) } catch { errors.push(`无法解析: ${item}`); continue }
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'tcp:') { errors.push(`只支持 http / https / tcp: ${item}`); continue }
      host = u.hostname.toLowerCase()
      if (u.protocol === 'tcp:') {
        if (u.port === '') { errors.push(`tcp:// 必须写端口: ${item}`); continue }
        entries = [{ port: Number(u.port), secure: false, mode: 'tcp' }]
      } else {
        const secure = u.protocol === 'https:'
        entries = [{ port: u.port ? Number(u.port) : (secure ? 443 : 80), secure, mode: secure ? 'https' : 'http' }]
      }
    } else {
      const m = /^([^:/]+)(?::(\d+))?$/.exec(item)
      if (m === null) { errors.push(`无法解析: ${item}`); continue }
      host = m[1].toLowerCase()
      entries = m[2]
        ? [{ port: Number(m[2]), secure: Number(m[2]) !== 80, mode: Number(m[2]) !== 80 ? 'https' : 'http' }]
        : [{ port: 443, secure: true, mode: 'https' }, { port: 80, secure: false, mode: 'http' }]
    }
    if (!validRedirectHost(host)) { errors.push(`不是可重定向的域名（IP/localhost/单段名不行）: ${item}`); continue }
    const list2 = hosts.get(host) ?? []
    for (const e of entries) {
      if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) { errors.push(`端口无效: ${item}`); continue }
      const prev = ports.get(e.port)
      if (prev !== undefined && prev !== e.mode) { errors.push(`端口 ${e.port} 同时被当成 ${prev} 和 ${e.mode}: ${item}`); continue }
      if (e.mode === 'tcp' && tcpOwner.has(e.port) && tcpOwner.get(e.port) !== host) {
        errors.push(`tcp 端口 ${e.port} 已给了 ${tcpOwner.get(e.port)}（裸 TCP 分不出域名，一个端口只能对应一个）: ${item}`)
        continue
      }
      if (e.mode === 'tcp') tcpOwner.set(e.port, host)
      ports.set(e.port, e.mode)
      if (!list2.some((x) => x.port === e.port)) list2.push(e)
    }
    if (list2.length > 0) hosts.set(host, list2)
  }
  return { hosts, ports, errors }
}

/**
 * 某域名的拦截端口 → 写进 hosts 段落的 `# apv-entry` 规格串（C4）。
 * 恢复时只按段落里的规格重建监听，不再依赖可能缺失/过期的状态文件，也不会把 tcp:// 或非默认端口退化成 443+80。
 */
function specsFor(host, entries) {
  const set = entries.map((e) => `${e.mode}:${e.port}`).sort().join(',')
  if (set === 'http:80,https:443') return [host]
  return entries.map((e) => `${e.mode}://${host}:${e.port}`)
}

/** 与实时日志对齐用的 URL 归一（解码、去 #实例号 后缀）。 */
function dedupeKey(method, url) {
  let u = String(url ?? '')
  try { u = decodeURIComponent(u) } catch { /* keep raw */ }
  return `${String(method ?? '').toUpperCase()} ${u.replace(/#.*$/, '')}`
}

/** Map Remote：target 只有源站（无路径）= 换主机保留路径；带路径 = 整条替换（查询串缺省沿用原请求）。 */
function mapRemoteTarget(spec, cur) {
  let u
  try { u = new URL(String(spec ?? '').trim()) } catch { return { ok: false, error: `目标不是合法 URL: ${spec}` } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `目标只支持 http/https: ${spec}` }
  const secure = u.protocol === 'https:'
  const port = u.port ? Number(u.port) : (secure ? 443 : 80)
  let p = cur.path
  if (u.pathname !== '/' || u.search !== '') {
    const qi = cur.path.indexOf('?')
    p = u.pathname + (u.search !== '' ? u.search : (qi >= 0 ? cur.path.slice(qi) : ''))
  }
  return { ok: true, target: { secure, host: u.hostname, port, path: p }, label: `${u.protocol}//${u.host}${p}` }
}

/**
 * R6-03：按安全网的身份探测法问一次 ip:port 上是不是本插件的拦截监听 —— https：TLS 握手（SNI = PROBE_SNI，接受任何证书），
 * 证书颁发者 CN 恰好是本插件根证书才算；http：GET PROBE_PATH，应答头里有 PROBE_HEADER: 1 才算。连不上 / 超时 / 不像 ⇒ false。
 */
function probeInterceptListener(ip, { port, mode }, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let sock = null
    let done = false
    let timer = null
    const finish = (v) => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      try { if (sock !== null) sock.destroy() } catch { /* ignore */ }
      resolve(v)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    try {
      if (mode === 'https') {
        sock = tls.connect({ host: ip, port, servername: PROBE_SNI, rejectUnauthorized: false, minVersion: 'TLSv1', maxVersion: 'TLSv1.2', ciphers: 'DEFAULT:@SECLEVEL=0' })
        sock.once('secureConnect', () => {
          const cert = sock.getPeerCertificate()
          const cn = cert && cert.issuer ? cert.issuer.CN : undefined
          finish((Array.isArray(cn) ? cn : [cn]).includes(CA_ISSUER_CN))
        })
      } else {
        sock = net.connect({ host: ip, port })
        let head = ''
        sock.setEncoding('latin1')
        sock.once('connect', () => sock.write(`GET ${PROBE_PATH} HTTP/1.1\r\nHost: ${PROBE_SNI}\r\nConnection: close\r\n\r\n`))
        sock.on('data', (d) => {
          head += d
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) { if (head.length > 16384) finish(false); return }
          const lines = head.slice(0, end).split('\r\n')
          finish(/^HTTP\/1\.[01] \d{3}/.test(lines[0]) && lines.slice(1).some((l) => {
            const k = l.indexOf(':')
            return k > 0 && l.slice(0, k).trim().toLowerCase() === PROBE_HEADER.toLowerCase() && l.slice(k + 1).trim() === '1'
          }))
        })
      }
      sock.once('error', () => finish(false))
      sock.once('close', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

/** R7-06：响应头里某个名字（不分大小写）的实际键；没有返回 null。 */
function headerKeyCI(headers, name) {
  const lower = String(name).toLowerCase()
  return Object.keys(headers).find((k) => k.toLowerCase() === lower) ?? null
}

/** R7-06：默认头与规则头按名字**不分大小写**合并 —— 同名只留规则那一个（否则 writeHead 会发出两个 Content-Type）。 */
function mergeHeadersCI(defaults, overrides) {
  const out = {}
  const over = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}
  for (const [k, v] of Object.entries(defaults)) out[k] = v
  for (const [k, v] of Object.entries(over)) {
    const prev = headerKeyCI(out, k)
    if (prev !== null) delete out[prev]
    out[k] = v
  }
  return out
}

const RULES_RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RULES_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))

/**
 * R7-08：原子写（同目录临时文件写完 fsync 再 rename 覆盖）—— 宿主在写到一半时被杀 / 关机，原文件仍是完整的旧版本。
 * Windows 上目标被杀毒 / 索引短暂占用时 rename 会 EPERM / EBUSY：退避重试几次。失败时删掉临时文件、原文件不变。
 */
function writeFileAtomicSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  let fd = null
  try {
    fd = fs.openSync(temp, 'wx')
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    for (let attempt = 1; ; attempt++) {
      try { fs.renameSync(temp, file); break } catch (e) {
        if (process.platform !== 'win32' || !RULES_RENAME_RETRY.has(e && e.code) || attempt >= 5) throw e
        Atomics.wait(RULES_SLEEP_CELL, 0, 0, 10 * attempt)
      }
    }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(temp) } catch { /* ignore */ }
    throw e
  }
}

/** 带 `.code` 的错误（路由据此映射 400/404/409）。 */
function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

/** 规则修订号：每次规则集变化 +1；前缀是进程启动时刻，宿主重启后不会与旧值撞车。 */
const RULES_EPOCH = Date.now().toString(36)

/** 规则导出文件的格式标识与版本（导入时据此认文件）。 */
const RULES_EXPORT_FORMAT = 'dsh-api-visualizer/rules'
const RULES_EXPORT_VERSION = 1
/** 替换导入时沿用文件里的规则 id 的条件：id 会进面板的 DOM 属性和路由参数，来路不明的字符一律换新 id。 */
const SAFE_RULE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** 等进程归因结果的记录最多登记这么多条（挤出去的那条退回按 complete / durationMs 判断要不要补发）。 */
const ATTRIBUTION_WAIT_MAX = 5000

/**
 * 我们接受的这条连接的四元组（进程归因用）。CONNECT 隧道里的 TLSSocket 带着 `__apvRaw`（原始 TCP socket），按原始 socket 查；
 * 结果缓存在原始 socket 的 `__apvEp` 上 —— socket 销毁后地址就读不到了，所以接受连接时先读好。读不全返回 null。
 */
function socketEndpoints(sock) {
  if (sock === null || sock === undefined || typeof sock !== 'object') return null
  const raw = sock.__apvRaw !== null && typeof sock.__apvRaw === 'object' ? sock.__apvRaw : sock
  if (raw.__apvEp !== undefined) return raw.__apvEp
  let ep = null
  try {
    const { localAddress, localPort, remoteAddress, remotePort } = raw
    if (typeof localAddress === 'string' && localAddress !== '' && typeof remoteAddress === 'string' && remoteAddress !== '' &&
      Number.isInteger(localPort) && Number.isInteger(remotePort)) {
      ep = { localAddress, localPort, remoteAddress, remotePort }
    }
  } catch {
    ep = null
  }
  if (ep !== null) raw.__apvEp = ep
  return ep
}

/** 把解析器的结果写到记录上（clientPid / clientProcess = 映像名，不含 .exe）；写了任何一个返回 true。 */
function applyClientProcess(record, found) {
  if (found === null || found === undefined || typeof found !== 'object') return false
  let changed = false
  if (Number.isInteger(found.pid) && found.pid >= 0) {
    record.clientPid = found.pid
    changed = true
  }
  if (typeof found.name === 'string' && found.name.trim() !== '') {
    record.clientProcess = found.name.trim().slice(0, 260)
    changed = true
  }
  return changed
}

/** 键排好序的 JSON：比较两条规则是否"完全相同"时不受键顺序影响。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
  }
  const s = JSON.stringify(v)
  return s === undefined ? 'null' : s
}

/** 规则的内容签名：matchAll + match + action（不含编译出的 ops；名称、开关、命中数不算）。 */
function ruleSignature(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return 'invalid:' + canonicalJson(rule)
  const a = rule.action !== null && typeof rule.action === 'object' && !Array.isArray(rule.action) ? rule.action : {}
  const { ops: _ops, ...action } = a
  return canonicalJson({ matchAll: rule.matchAll === true, match: rule.match ?? {}, action })
}

/**
 * R3-01：修复前保存的改写规则里 `replace /p/f => x` 按**正则**执行（存下的 op 带 regex:true），现在的编译器把 replace
 * 当字面量。导出时把这样的行改写成 `regex /p/f => x`（req./res. 前缀照留），导入后语义不变；没有这样的行返回 null。
 * 旧语法允许正则里出现裸的 /，新语法以第一个未转义、不在 [...] 里的 / 结尾 ⇒ 这些 / 补上转义。
 */
function legacyRegexScript(script, ops) {
  if (typeof script !== 'string' || !Array.isArray(ops) || !ops.some((o) => o !== null && typeof o === 'object' && o.op === 'replace' && o.regex === true)) return null
  const BS = String.fromCharCode(92)
  const escapeSlashes = (p) => {
    let out = ''
    let inClass = false
    for (let i = 0; i < p.length; i++) {
      const ch = p[i]
      if (ch === BS) { out += ch + (p[i + 1] ?? ''); i++; continue }
      if (inClass) { if (ch === ']') inClass = false; out += ch; continue }
      if (ch === '[') { inClass = true; out += ch; continue }
      out += ch === '/' ? BS + '/' : ch
    }
    return out
  }
  const eol = script.includes('\r\n') ? '\r\n' : '\n'
  let changed = false
  const lines = script.split(/\r?\n/).map((raw) => {
    const line = raw.trim()
    const sp = line.search(/\s/)
    if (sp < 0) return raw
    const head = line.slice(0, sp).toLowerCase()
    const prefix = head.startsWith('req.') ? 'req.' : head.startsWith('res.') ? 'res.' : ''
    if (head.slice(prefix.length) !== 'replace') return raw
    const rest = line.slice(sp + 1)
    const idx = rest.indexOf('=>')
    if (idx < 0) return raw
    const m = /^\/(.+)\/([a-z]*)$/.exec(rest.slice(0, idx).trim())
    if (m === null || !ops.some((o) => o !== null && typeof o === 'object' && o.op === 'replace' && o.regex === true && o.find === m[1])) return raw
    changed = true
    return `${prefix}regex /${escapeSlashes(m[1])}/${m[2]} => ${rest.slice(idx + 2).trim()}`
  })
  return changed ? lines.join(eol) : null
}

/** 规则在报错里的称呼（与 normalizeRule 的缺省名一致）。 */
function ruleLabel(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return '未命名规则'
  return String(raw.name ?? '').trim() || '未命名规则'
}

/** 导入内容 → 规则数组：导出信封 / 规则数组 / 二者的 JSON 文本；别的一律 IMPORT_INVALID。 */
function rulesFromImport(input) {
  let data = input
  if (typeof data === 'string') {
    const text = (data.charCodeAt(0) === 0xfeff ? data.slice(1) : data).trim() // 去掉文件开头的 BOM
    if (text === '') throw codedError('IMPORT_INVALID', '导入的内容是空的')
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw codedError('IMPORT_INVALID', `导入的内容不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    const fmt = data.format
    if (fmt !== undefined && fmt !== RULES_EXPORT_FORMAT) {
      if (fmt === 'dsh-api-visualizer/filters') throw codedError('IMPORT_INVALID', '这是过滤器的导出文件，不是规则 —— 请到「过滤器」里导入')
      throw codedError('IMPORT_INVALID', `文件格式是 ${JSON.stringify(fmt)}，不是规则导出文件（${RULES_EXPORT_FORMAT}）`)
    }
    if (data.version !== undefined && Number(data.version) !== RULES_EXPORT_VERSION) {
      throw codedError('IMPORT_INVALID', `规则导出文件的版本 ${JSON.stringify(data.version)} 不受支持（只认 ${RULES_EXPORT_VERSION}）`)
    }
    if (Array.isArray(data.rules)) return data.rules
    if (fmt === RULES_EXPORT_FORMAT) throw codedError('IMPORT_INVALID', '规则导出文件里缺少 rules 数组')
  }
  throw codedError('IMPORT_INVALID', `导入的内容不是规则导出文件：需要 {"format":"${RULES_EXPORT_FORMAT}","rules":[…]} 或规则数组`)
}

export { matchRule, WsFrameParser, mapRemoteTarget, sendBody, safeWriteHead, specsFor, pathMatches }
export class ProxyEngine {
  constructor({
    certDir, port = 8899, upstream = undefined, onRecord = () => {}, regWriter = null, winInetRefresh = null, sysProxyReader = null,
    // 透明拦截的注入口（测试用临时 hosts / 假解析器 / 假安全网；生产用默认值）
    hostsPath = null, hostsApplier = null, resolveUpstream = null, resolveUpstreamBatch = null, allowLoopbackUpstream = false,
    safetyLogPath = null,
    // 进程归因（谁发起的连接）：测试注入假解析器；false / null = 关闭
    processResolver = undefined,
  } = {}) {
    this.certDir = certDir
    this.port = port
    this.upstream = upstream // {host,port} | null(=direct) | undefined(=auto: read system proxy)
    // 所有记录都经过这里：透明拦截的记录完成时要更新去重表里的"完成时刻"（C18）
    this.userOnRecord = typeof onRecord === 'function' ? onRecord : () => {}
    this.onRecord = (rec) => {
      if (rec !== null && rec !== undefined && rec.process === 'intercept' && rec.complete === true) this.noteInterceptedEnd(rec)
      // 还在等进程归因的记录：记下"已经发出过"，查到后要用同一个 id 补发一次
      if (rec !== null && rec !== undefined && this.attrWaiting !== undefined && this.attrWaiting.size > 0) {
        const w = this.attrWaiting.get(rec.id)
        if (w !== undefined) w.emitted = true
      }
      this.userOnRecord(rec)
    }
    // F-037：注册表**写**与 WinINet 刷新的注入口。
    //   为什么要开口子：`setSystemProxy()` 是**会改用户机器设置**的路径，而它的 bug 恰恰是
    //   "备份不可信时仍然写"，所以必须能用注入在**不碰真实注册表**的前提下测出这个行为。
    //   （原来这两个都是模块级自由函数，校验无从拦截 ⇒ 这条路径**一条校验都没有**，
    //    这也是它能活到 r34 的原因之一。）
    this.regWriter = typeof regWriter === 'function' ? regWriter : writeSystemProxy
    this.winInetRefresh = typeof winInetRefresh === 'function' ? winInetRefresh : refreshWinInet
    this.readSysProxy = typeof sysProxyReader === 'function' ? sysProxyReader : readSystemProxy
    this.server = null
    this.counters = { requests: 0, mitm: 0, errors: 0, ws: 0, rulesHits: 0, rulesMocks: 0 }
    this.ca = null
    this.hostCerts = new Map()
    this.agents = null
    this.secureAgents = null
    this.backupSystemProxy = null
    this.rulesFile = path.join(path.dirname(certDir), 'proxy-rules.json')
    this.rulesCache = { key: '', rules: [] }
    this.rulesFlushTimer = null
    // 规则集修订号（C12）：面板 / 工具据此发现"别人改过"，整表写入可带 baseRevision 做乐观并发
    this.rulesSeq = 0
    this.rulesLoadWarning = null // R7-08：{ at, pending, backup, message } —— 规则文件损坏（已改名留底 / 改名失败待重试）
    this.lastError = null
    // 请求断点：默认关闭；enabled=false 时 bpMatch 立即返回 false，对正常流零影响。
    // phase: request（转发前改请求）| response（回包前改响应）| both
    this.breakpoints = { enabled: false, urlFilter: '', methodFilter: '', phase: 'request' }
    this.paused = new Map() // id -> { id, phase, data, resolve, timer, createdAt }
    this._pauseSeq = 0
    // ---- 透明拦截（hosts 重定向 + 反向代理）
    this.hostsPath = hostsPath || defaultHostsPath()
    this.hostsApplier = typeof hostsApplier === 'function' ? hostsApplier : applyHostsBlock
    // 解析器：测试注入的是逐个域名的 resolveUpstream；生产默认用批量版（一次 PowerShell 查全部，C36）
    this.resolveUpstream = typeof resolveUpstream === 'function' ? resolveUpstream : null
    this.resolveUpstreamBatch = typeof resolveUpstreamBatch === 'function'
      ? resolveUpstreamBatch
      : (this.resolveUpstream === null ? defaultResolveBatch : null)
    this.allowLoopbackUpstream = allowLoopbackUpstream === true
    // { ip, entries, hosts:Map, pins:Map, servers:Map<port,server>, sockets:Set, agents, counters, draining, ... }
    // 固定 IP（pins）属于**这一次**拦截状态本身（C2）：旧状态延迟收尾时绝不能清掉新状态的 pin。
    this.redirect = null
    this.secureContexts = new Map()
    this.interceptNotes = new Map() // dedupeKey -> [{ id, start, end }]（与实时日志去重，C18）
    this.interceptNoteById = new Map() // proxy record id -> note
    this.interceptStateFile = path.join(path.dirname(certDir), 'intercept-state.json')
    // 安全网日志由 SYSTEM 计划任务写：只能放在 hosts 所在目录（管理员可写、普通用户只读），放在用户可写目录会被
    // junction / 符号链接劫持去改写系统文件。传别的目录会被 hosts-redirect 忽略；这里只在测试时覆盖。
    this.safetyLogPath = safetyLogPath || null
    this.interceptEvent = null // 最近一次值得告诉用户的事件（安全网关闭了拦截 / 恢复失败…）
    // R6-03：恢复时发现 hosts 段落正由**另一个**实例服务（身份探测有应答）⇒ { at, ip, probe }；本实例没接管、没碰段落
    this.foreignOwner = null
    this.pinnedLookup = (host) => this.pinFor(host)
    // 环路保护：按名字直连时，凡解析到"当前拦截监听地址"的一律拒绝
    this.loopGuard = (ip) => this.isInterceptAddress(ip)
    this.caTrustCache = null
    // 透明拦截的启停 / 恢复 / 收尾串行执行（C14）：任何一步都不会和另一步的 await 交错
    this.redirectChain = Promise.resolve()
    // hosts 里被我们指向本机的地址（含宿主重启后段落还在、监听未起的情形）：环路保护要认得它们
    this.interceptIpsInHosts = new Set()
    // ---- 全局延时 / 弱网（参数落盘、开关不落盘）
    this.netsimFile = path.join(path.dirname(certDir), 'netsim.json')
    this.netsim = loadNetsim(this.netsimFile)
    // ---- 进程归因：记录上的 clientProcess / clientPid（netstat 查连接属主；见 client-process.mjs）
    //   不传 = 默认解析器；传 false / null = 关闭；注入的对象至少要有 lookup（peek / stats 可选）
    this.processResolver = processResolver === false || processResolver === null
      ? null
      : (typeof processResolver === 'object' && typeof processResolver.lookup === 'function' ? processResolver : createProcessResolver())
    this.attrWaiting = new Map() // record id -> { emitted, evicted }：查询还没回来的记录
  }

  // ------------------------------------------------------------ 进程归因（clientProcess / clientPid）

  /** 接受连接时就开始查发起进程（结果按连接四元组缓存，这条连接上的请求直接命中）。不阻塞、不抛。 */
  startProcessLookup(sock) {
    if (this.processResolver === null) return
    const ep = socketEndpoints(sock)
    if (ep === null) return
    try {
      const p = this.processResolver.lookup(ep, { fresh: true })
      if (p !== null && p !== undefined && typeof p.then === 'function') p.then(null, () => {})
    } catch {
      // 归因失败不影响连接本身
    }
  }

  /**
   * 给记录挂上发起进程：缓存里已知就同步写上；否则查到后写到**活记录**上 ——
   * 查询回来之前记录已经发出过（mock 立刻回包、流式响应的首条、WS 的 101…）就用同一个 id 再发一次（库里按 id 覆盖）。
   * 绝不等待：请求照常往下走。
   */
  attributeRecord(record, sock) {
    if (this.processResolver === null) return
    const ep = socketEndpoints(sock)
    if (ep === null) return
    let known
    try { known = typeof this.processResolver.peek === 'function' ? this.processResolver.peek(ep) : undefined } catch { known = undefined }
    if (known !== undefined) {
      applyClientProcess(record, known)
      return
    }
    let p
    try { p = this.processResolver.lookup(ep) } catch { p = null }
    if (p === null || p === undefined || typeof p.then !== 'function') return
    const waiting = { emitted: false, evicted: false }
    if (this.attrWaiting.size >= ATTRIBUTION_WAIT_MAX) {
      const oldestId = this.attrWaiting.keys().next().value
      const oldest = this.attrWaiting.get(oldestId)
      if (oldest !== undefined) oldest.evicted = true
      this.attrWaiting.delete(oldestId)
    }
    this.attrWaiting.set(record.id, waiting)
    const forget = () => {
      if (this.attrWaiting.get(record.id) === waiting) this.attrWaiting.delete(record.id)
    }
    p.then((found) => {
      forget()
      try {
        if (!applyClientProcess(record, found)) return
        const note = this.interceptNoteById.get(record.id)
        if (note !== undefined && typeof record.clientProcess === 'string') note.clientProcess = record.clientProcess // R2-04
        // 被挤出登记表的那条不知道发没发过：按"已经终结"的迹象判断
        const emitted = waiting.emitted || (waiting.evicted && (record.complete === true || record.durationMs !== undefined))
        if (emitted) {
          // R2-01：只补发归因字段 —— 库里那一行此时可能已被用户标记 / 打标签 / 加注或删除，整条覆盖会冲掉这些、让删掉的记录又冒出来。
          // 宿主按 attributionPatch 合并进队列里 / 库里同 id 的那条；两处都没有就丢弃
          const patch = { id: record.id, attributionPatch: true }
          if (record.clientProcess !== undefined) patch.clientProcess = record.clientProcess
          if (record.clientPid !== undefined) patch.clientPid = record.clientPid
          this.onRecord(patch)
        }
      } catch {
        // 补发失败只是少了归因，不能变成未处理的 rejection
      }
    }, forget)
  }

  /** 状态里的进程归因计数（解析器没给就是 0）。 */
  processLookupStats() {
    let s = null
    try {
      s = this.processResolver !== null && typeof this.processResolver.stats === 'function' ? this.processResolver.stats() : null
    } catch {
      s = null
    }
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    return { ok: n(s?.ok), miss: n(s?.miss), errors: n(s?.errors), pending: n(s?.pending) }
  }

  // ------------------------------------------------------------ AutoResponder

  rulesFileKey() {
    try {
      const st = fs.statSync(this.rulesFile)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return 'missing'
    }
  }

  loadRules() {
    const key = this.rulesFileKey()
    if (this.rulesCache.key === key || this.rulesCache.key === 'dirty') return this.rulesCache.rules
    let rules = []
    let cacheKey = key
    if (key !== 'missing') {
      let problem = null
      try {
        const parsed = JSON.parse(fs.readFileSync(this.rulesFile, 'utf8'))
        if (Array.isArray(parsed)) rules = parsed
        else problem = '内容不是规则数组'
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e)
      }
      if (problem !== null) {
        // R7-08：读不出来 ≠ 没有规则 —— 原字节改名留底，下一次写盘才不会把用户的整套规则覆盖掉
        this.quarantineRulesFile(problem)
        cacheKey = this.rulesFileKey()
      } else if (this.rulesLoadWarning !== null && this.rulesLoadWarning.pending === true) {
        this.rulesLoadWarning = null // 之前改名没成功、现在文件又能读了
      }
    }
    this.rulesCache = { key: cacheKey, rules }
    // 文件被外部改过（或首次加载）：修订号也要变，面板 / 工具才知道该重新拉
    this.rulesSeq++
    return rules
  }

  /**
   * R7-08：规则文件读不出 / 不是规则数组 ⇒ 原样改名为 proxy-rules.json.corrupt-<时间>（同一目录）留底，并在
   * getRules / status 里给出警告。改名也失败（文件被占用）⇒ 记为 pending：写规则前会再试，仍不成就拒绝写（绝不覆盖）。
   */
  quarantineRulesFile(problem) {
    const backup = `${this.rulesFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    let moved = false
    try {
      fs.renameSync(this.rulesFile, backup)
      moved = true
    } catch { /* 下一次写盘前再试 */ }
    const why = String(problem).slice(0, 160)
    this.rulesLoadWarning = moved
      ? { at: Date.now(), pending: false, backup, problem: why, message: `规则文件损坏、读不出规则（${why}）：原文件已原样改名保存为 ${path.basename(backup)}（同一目录），现在按空规则表运行 —— 修好后可用「导入」恢复。` }
      : { at: Date.now(), pending: true, backup: null, problem: why, message: `规则文件损坏、读不出规则（${why}），改名留底也失败了：在它被保存好之前不会写入规则文件。` }
  }

  /** R7-08：写规则文件之前，损坏的原文件必须已经改名留底；做不到就抛错（不覆盖）。 */
  ensureRulesWritable() {
    if (this.rulesLoadWarning === null || this.rulesLoadWarning.pending !== true) return
    if (fs.existsSync(this.rulesFile)) this.quarantineRulesFile(this.rulesLoadWarning.problem)
    else this.rulesLoadWarning = { ...this.rulesLoadWarning, pending: false }
    if (this.rulesLoadWarning.pending === true) throw codedError('RULES_FILE_DAMAGED', this.rulesLoadWarning.message)
  }

  /** 规则集修订号：每次规则集变化都会变，宿主重启后也不会与旧值相同（C12）。 */
  rulesRevision() {
    this.loadRules()
    return `${RULES_EPOCH}:${this.rulesSeq}`
  }

  getRules() {
    const rules = this.loadRules()
    return {
      file: this.rulesFile,
      total: rules.length,
      enabled: rules.filter((r) => r.enabled !== false).length,
      revision: this.rulesRevision(),
      // R7-08：规则文件损坏时这里给出原因与留底文件，而不是悄悄显示 0 条
      warning: this.rulesLoadWarning !== null ? this.rulesLoadWarning.message : null,
      backup: this.rulesLoadWarning !== null ? this.rulesLoadWarning.backup : null,
      rules: rules.map((r) => ({ ...r, hits: r.hits ?? 0 })),
    }
  }

  getRule(id) {
    const r = this.loadRules().find((x) => x.id === id)
    return r === undefined ? null : { ...r, hits: r.hits ?? 0 }
  }

  /** 唯一的写规则入口：写盘、刷缓存、修订号 +1（命中计数的落盘不走这里，不改修订号）。 */
  writeRules(rules) {
    if (this.rulesFlushTimer !== null) {
      clearTimeout(this.rulesFlushTimer)
      this.rulesFlushTimer = null
    }
    this.ensureRulesWritable()
    writeFileAtomicSync(this.rulesFile, JSON.stringify(rules, null, 2))
    this.rulesCache = { key: this.rulesFileKey(), rules }
    this.rulesSeq++
  }

  /**
   * 规范化并**校验**一条规则；不合法抛 `.code = 'RULE_INVALID'` 的错误，带规则名，原样回给用户。
   * 为什么在写入时校验：规则是在**流量热路径**上执行的，到那时才发现问题，用户只会看到"规则没生效"——
   * 或者更糟（C13）：形状写错的规则曾被静默当成「匹配全部请求的 mock」，把登录、行情接口一起替换掉。
   */
  normalizeRule(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw codedError('RULE_INVALID', '规则必须是对象')
    const name = String(raw.name ?? '').trim() || '未命名规则'
    const bad = (msg) => codedError('RULE_INVALID', `规则「${name}」：${msg}`)
    const a = raw.action !== null && typeof raw.action === 'object' && !Array.isArray(raw.action) ? raw.action : null
    if (a === null) throw bad('缺少 action 对象（形如 {"type":"mock","body":"[]"}）')
    const type = a.type
    if (!RULE_TYPES.includes(type)) throw bad(`action.type 必须是 ${RULE_TYPES.join(' / ')} 之一（收到 ${JSON.stringify(type)}）`)
    const m = raw.match !== null && typeof raw.match === 'object' && !Array.isArray(raw.match) ? raw.match : {}
    const match = {
      method: String(m.method ?? '').trim().toUpperCase(),
      host: String(m.host ?? '').trim(),
      url: String(m.url ?? '').trim(),
      urlType: 'contains',
    }
    if (m.urlType !== undefined && m.urlType !== null && m.urlType !== '') {
      if (!URL_TYPES.includes(m.urlType)) throw bad(`match.urlType 必须是 ${URL_TYPES.join(' / ')} 之一`)
      match.urlType = m.urlType
    } else if (m.regex === true) {
      match.urlType = 'regex'
    }
    if (match.urlType === 'regex' && match.url !== '') {
      try { new RegExp(match.url, 'i') } catch (e) { throw bad(`URL 正则无效：${e instanceof Error ? e.message : e}`) }
    }
    const matchAll = raw.matchAll === true
    if (match.url === '' && match.host === '' && match.method === '' && !matchAll && !CATCH_ALL_OK.has(type)) {
      throw bad('没有写 URL / 主机 / 方法 ⇒ 会匹配**全部**请求（登录、行情都会被替换）。确实要这样请加 "matchAll": true')
    }
    const num = (v, max) => Math.max(0, Math.min(Number(v) || 0, max))
    let status
    if (a.status !== undefined && a.status !== null && a.status !== '') {
      const s = Number(a.status)
      if (!Number.isInteger(s) || s < 100 || s > 599) throw bad(`状态码要在 100–599 之间（收到 ${a.status}）`)
      status = s
    } else if (type === 'mock' || type === 'map-local') {
      status = 200
    }
    if (type === 'rewrite-status' && status === undefined) throw bad('重写状态码需要 status')
    const headers = {}
    if (a.headers !== undefined && a.headers !== null) {
      if (typeof a.headers !== 'object' || Array.isArray(a.headers)) throw bad('action.headers 必须是对象')
      for (const [k, v] of Object.entries(a.headers)) {
        const err = validateHeader(k, String(v ?? ''))
        if (err) throw bad(`响应头 ${k}：${err}`)
        headers[k] = String(v ?? '')
      }
    }
    const action = {
      type,
      // 请求延迟（转发前 / 本地回包前等待；hang 时 = 挂起时长）、回包延迟（拿到响应后再等）、抖动（±）、下行限速
      latencyMs: type === 'hang' && !(Number(a.latencyMs) > 0) ? HANG_DEFAULT_MS : num(a.latencyMs, 600000),
      responseDelayMs: num(a.responseDelayMs, 600000),
      jitterMs: num(a.jitterMs, 600000),
      throttleKbps: num(a.throttleKbps, 102400),
      ...(status !== undefined ? { status } : {}),
      headers,
      body: typeof a.body === 'string' ? a.body : '',
    }
    if (Buffer.byteLength(action.body, 'utf8') > MOCK_BODY_CAP) throw bad(`mock 响应体超过 ${MOCK_BODY_CAP / 1048576}MB；大文件请用 Map Local`)
    if (a.charset !== undefined && a.charset !== null && a.charset !== '') {
      const codec = codecFor(String(a.charset))
      if (!codec) throw bad(`不支持的响应编码 ${a.charset}`)
      if (type === 'mock' && action.body !== '') {
        const ct = String(headers['content-type'] ?? headers['Content-Type'] ?? 'application/json')
        const enc = encodeBody(action.body, codec, { json: /json/i.test(ct) })
        if (!enc.ok) throw bad(`响应体无法用 ${a.charset} 编码：${enc.reason}`)
      }
      action.charset = String(a.charset).toLowerCase()
    }
    if (type === 'map-local') {
      const file = String(a.file ?? '').trim()
      if (file === '' || !path.isAbsolute(file)) throw bad('Map Local 需要本地文件的绝对路径')
      action.file = file
    }
    if (type === 'map-remote') {
      const target = String(a.target ?? '').trim()
      const t = mapRemoteTarget(target, { path: '/' })
      if (!t.ok) throw bad(t.error)
      action.target = target
    }
    if (type === 'rewrite') {
      const script = typeof a.script === 'string' ? a.script : ''
      let ops
      try {
        ops = compileRewriteScript(script)
      } catch (e) {
        throw bad(`改写脚本：${e instanceof Error ? e.message : String(e)}`)
      }
      if (ops.length === 0) throw bad('改写脚本里没有任何指令')
      action.script = script
      action.ops = ops
    }
    return {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
      enabled: raw.enabled !== false,
      name,
      ...(raw.quick === true ? { quick: true } : {}),
      ...(matchAll ? { matchAll: true } : {}),
      match,
      action,
      hits: Number(raw.hits) > 0 ? Number(raw.hits) : 0,
    }
  }

  /**
   * 整表替换（兼容旧调用；面板与工具改用 ruleOp）。`baseRevision` 给了且已过期 ⇒ `RULES_CONFLICT`，
   * 不会拿一份旧快照覆盖掉别处刚加的规则（C12）。已有规则的命中计数以服务端为准。
   */
  setRules(list, { baseRevision } = {}) {
    if (baseRevision !== undefined && baseRevision !== null && baseRevision !== '' && baseRevision !== this.rulesRevision()) {
      throw codedError('RULES_CONFLICT', '规则已被其它地方（面板 / 工具）改过，这份是旧快照 —— 请刷新后再改', { revision: this.rulesRevision() })
    }
    const current = new Map(this.loadRules().map((r) => [r.id, r]))
    const rules = (Array.isArray(list) ? list : []).map((raw) => {
      const n = this.normalizeRule(raw)
      const prev = current.get(n.id)
      if (prev !== undefined) n.hits = Number(prev.hits) || 0
      return n
    })
    this.writeRules(rules)
    return this.getRules()
  }

  /**
   * 单条规则操作（C3 / C12）：面板与工具改一条就只动一条，不再整表往返（整表里可能有 MB 级的 mock 正文，
   * 也会拿旧快照覆盖掉别处刚加的规则）。ops：add / update / remove / enable / disable / clear / removeQuick。
   */
  ruleOp({ op, id, rule, url, method } = {}) {
    const rules = this.loadRules().slice()
    const indexOf = () => {
      const i = rules.findIndex((r) => r.id === id)
      if (i < 0) throw codedError('RULE_NOT_FOUND', `没有 id=${id} 的规则（可能已被删除）`)
      return i
    }
    let changed = 0
    let touched = null
    switch (op) {
      case 'add': {
        const n = this.normalizeRule(rule ?? {})
        if (rules.some((r) => r.id === n.id)) n.id = randomUUID()
        n.hits = 0
        rules.unshift(n)
        touched = n.id
        changed = 1
        break
      }
      case 'update': {
        const i = indexOf()
        const n = this.normalizeRule({ ...(rule ?? {}), id: rules[i].id })
        n.hits = Number(rules[i].hits) || 0
        rules[i] = n
        touched = n.id
        changed = 1
        break
      }
      case 'remove': {
        rules.splice(indexOf(), 1)
        changed = 1
        break
      }
      case 'enable':
      case 'disable': {
        const i = indexOf()
        const want = op === 'enable'
        if ((rules[i].enabled !== false) !== want) {
          rules[i] = { ...rules[i], enabled: want }
          changed = 1
        }
        touched = rules[i].id
        break
      }
      case 'clear': {
        changed = rules.length
        rules.length = 0
        break
      }
      case 'removeQuick': {
        const key = String(url ?? '').split('#')[0].split('?')[0]
        if (key === '') throw codedError('RULE_INVALID', 'removeQuick 需要 url')
        const want = String(method ?? '').toUpperCase()
        for (let i = rules.length - 1; i >= 0; i--) {
          const r = rules[i]
          if (r.quick !== true || r.match?.urlType !== 'path' || urlPathKey(r.match.url) !== urlPathKey(key)) continue
          const rm = String(r.match.method ?? '').toUpperCase()
          // 方法为空的一键规则覆盖该路径的所有方法（C27）
          if (want === '' || rm === '' || rm === want) {
            rules.splice(i, 1)
            changed++
          }
        }
        break
      }
      default:
        throw codedError('RULE_INVALID', `未知的规则操作 ${op}（可用 add / update / remove / enable / disable / clear / removeQuick）`)
    }
    if (changed > 0) this.writeRules(rules)
    const out = this.getRules()
    return { ...out, changed, ...(touched !== null ? { rule: out.rules.find((r) => r.id === touched) ?? null } : {}) }
  }

  /**
   * 导出规则（备份 / 发给同事）：信封 `{ format, version, exportedAt, count, rules }`。
   * 不带命中计数（hits 是这台机器的运行数据），也不带编译出的改写指令（action.ops —— 导入时按 action.script 重新编译）。
   */
  exportRules() {
    const rules = []
    for (const r of this.loadRules()) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) continue
      const a = r.action !== null && typeof r.action === 'object' && !Array.isArray(r.action) ? r.action : {}
      const { ops: _ops, ...action } = a
      const legacy = action.type === 'rewrite' ? legacyRegexScript(a.script, a.ops) : null // R3-01
      if (legacy !== null) action.script = legacy
      rules.push(JSON.parse(JSON.stringify({
        id: r.id,
        name: typeof r.name === 'string' ? r.name : String(r.name ?? ''),
        enabled: r.enabled !== false,
        ...(r.quick === true ? { quick: true } : {}),
        ...(r.matchAll === true ? { matchAll: true } : {}),
        match: r.match !== null && typeof r.match === 'object' ? r.match : {},
        action,
      })))
    }
    return { format: RULES_EXPORT_FORMAT, version: RULES_EXPORT_VERSION, exportedAt: new Date().toISOString(), count: rules.length, rules }
  }

  /**
   * 导入规则（导出信封 / 规则数组 / 二者的 JSON 文本）。全有或全无：先逐条过 normalizeRule，任何一条不合法整份都不导入
   * （`RULE_INVALID`「第 N 条（名称）：…」，规则表一点不动）；内容都合法之后，`baseRevision` 过期报 `RULES_CONFLICT`（同 setRules）。
   *   merge（默认）：新 id、命中数清零；与现有规则（或本次已收下的）内容完全相同的跳过（签名 = matchAll + match + action，不含 ops），
   *     其余按文件顺序插到**最前面** —— 规则按顺序取第一条命中，导入的 mock 这样才会生效。
   *   replace：规则表变成导入的这份（id 合法且不重复就沿用，否则换新；命中数清零）。
   * Map Local 指向的文件不存在只告警、照样导入（文件可能稍后才放上去）。
   */
  importRules(input, { mode = 'merge', baseRevision } = {}) {
    const m = mode === undefined || mode === null || mode === '' ? 'merge' : mode
    if (m !== 'merge' && m !== 'replace') {
      throw codedError('IMPORT_INVALID', `mode 只能是 merge（合并）或 replace（替换），收到 ${JSON.stringify(mode)}`)
    }
    const list = rulesFromImport(input)
    const normalized = list.map((raw, i) => {
      try {
        // R3-06：与「新增规则」同一口径 —— enabled / matchAll 给了就必须是布尔值（"false"、0 不能悄悄变成"启用"）
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const k of ['enabled', 'matchAll']) {
            if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'boolean') {
              throw codedError('RULE_INVALID', `${k} 要是 true / false（不是字符串 / 数字；收到 ${JSON.stringify(raw[k]).slice(0, 40)}）`)
            }
          }
        }
        return this.normalizeRule(raw)
      } catch (e) {
        const label = ruleLabel(raw)
        const msg = e instanceof Error ? e.message : String(e)
        const prefix = `规则「${label}」：`
        throw codedError('RULE_INVALID', `第 ${i + 1} 条（${label}）：${msg.startsWith(prefix) ? msg.slice(prefix.length) : msg}`, { index: i + 1, ruleName: label })
      }
    })
    // 内容先校验完（文件本身的问题与规则表的新旧无关），再做乐观并发检查
    if (baseRevision !== undefined && baseRevision !== null && baseRevision !== '' && baseRevision !== this.rulesRevision()) {
      throw codedError('RULES_CONFLICT', '规则已被其它地方（面板 / 工具）改过，这份是旧快照 —— 请刷新后再导入', { revision: this.rulesRevision() })
    }
    const current = this.loadRules()
    const added = [] // [文件里的下标, 规则]
    let skipped = 0
    let next
    if (m === 'merge') {
      // R3-02：只有**启用着**的同内容规则才算"已经有了"；停用的那条不会应答，导入的这条要照样插到最前面才会生效
      const seen = new Set(current.filter((r) => r === null || typeof r !== 'object' || r.enabled !== false).map((r) => {
        try { return ruleSignature(this.normalizeRule(r)) } catch { return ruleSignature(r) }
      }))
      normalized.forEach((n, i) => {
        const sig = ruleSignature(n)
        if (seen.has(sig)) {
          skipped++
          return
        }
        seen.add(sig)
        n.id = randomUUID()
        n.hits = 0
        added.push([i, n])
      })
      next = [...added.map(([, n]) => n), ...current]
    } else {
      const ids = new Set()
      next = normalized.map((n, i) => {
        const want = list[i].id
        n.id = typeof want === 'string' && SAFE_RULE_ID_RE.test(want) && !ids.has(want) ? want : randomUUID()
        ids.add(n.id)
        n.hits = 0
        added.push([i, n])
        return n
      })
    }
    const warnings = []
    for (const [i, n] of added) {
      if (n.action.type !== 'map-local') continue
      let st = null
      try { st = fs.statSync(n.action.file) } catch { st = null }
      if (st === null) warnings.push(`第 ${i + 1} 条「${n.name}」：Map Local 文件不存在：${n.action.file}`)
      else if (!st.isFile()) warnings.push(`第 ${i + 1} 条「${n.name}」：Map Local 路径不是文件：${n.action.file}`)
    }
    if (m === 'replace' || added.length > 0) this.writeRules(next)
    return { ...this.getRules(), imported: added.length, skipped, mode: m, warnings }
  }

  /**
   * 这条 URL 的规则此刻能不能被命中（C9）：只看"有没有前门开着"是不够的 ——
   * 强制直连的客户端只会经过透明拦截，而透明拦截只接管名单里的域名 + 端口，排空期内也不套规则。
   */
  ruleReach(url) {
    let host = ''
    let port = null
    let scheme = ''
    try {
      const u = new URL(String(url ?? ''))
      host = u.hostname.toLowerCase()
      scheme = u.protocol.replace(':', '')
      port = u.port ? Number(u.port) : (scheme === 'https' ? 443 : 80)
    } catch {
      host = ''
    }
    const viaProxy = this.server !== null
    const r = this.redirect
    let intercept = 'off'
    if (r !== null) {
      if (r.draining) intercept = 'draining'
      else if (host !== '' && r.hosts.has(host) && r.hosts.get(host).some((e) => e.port === port && e.mode === scheme)) intercept = 'active'
      else intercept = 'not-listed'
    }
    const viaIntercept = intercept === 'active'
    let note
    if (viaIntercept) note = `透明拦截正在接管 ${host}:${port}：客户端下一次请求这个接口就会命中（刷新对应页面即可）。`
    else if (intercept === 'draining') note = '透明拦截已停用、正在排空：排空期内规则一律不生效。' + (viaProxy ? '（本地代理在运行，只有走代理的程序会命中）' : '')
    else if (intercept === 'not-listed') note = `${host || '这个地址'}${port ? ':' + port : ''} 不在透明拦截名单里：强制直连的客户端碰不到这条规则，把它加进拦截名单即可。` + (viaProxy ? '（本地代理在运行，走代理的程序会命中）' : '')
    else if (viaProxy) note = `只有本地代理在运行：走代理的程序会命中；强制直连的客户端要先对 ${host || '该域名'} 开透明拦截。`
    else note = '本地代理和透明拦截都没开：这条规则暂时不会被任何请求命中。'
    return { host, port, viaProxy, viaIntercept, intercept, takesEffect: viaIntercept || viaProxy, note }
  }

  /**
   * 一键 mock：按「方法 + 接口路径（忽略查询串）」插一条规则到最前面；同一接口已有一键规则就**替换**它。
   * `original`（'original' / 'empty-lists' 预设要用）= `{ body, contentType, truncated, encoding }`：该接口最近一次的真实响应。
   */
  quickRule({ url, method = '', preset = 'empty-object', body, status, latencyMs, original = null, name } = {}) {
    const p = QUICK_PRESETS[preset]
    if (p === undefined) throw codedError('RULE_INVALID', `未知预设 ${preset}（可用: ${Object.keys(QUICK_PRESETS).join(' / ')}）`)
    const pathKey = String(url ?? '').split('#')[0].split('?')[0]
    if (!/^https?:\/\/[^/]+/i.test(pathKey)) throw codedError('RULE_INVALID', 'url 需要是完整地址（https://host/path）')
    let mockBody = typeof body === 'string' ? body : p.body ?? ''
    const headers = {}
    let charset = null
    if (p.needsOriginal) {
      const o = original !== null && typeof original === 'object' ? original : null
      // 「原响应 → 编辑后生效」（C38）：显式给了正文 ⇒ 正文用编辑后的，原响应只用来沿用 Content-Type / 编码；
      // 原响应找不到 / 不可用也照样生效（按 JSON · UTF-8 回）
      const edited = preset === 'original' && typeof body === 'string'
      if (!edited) {
        if (o === null || typeof o.body !== 'string' || o.body === '') {
          throw codedError('RULE_INVALID', '这个预设需要该接口的原响应：先让客户端请求一次该接口（或改用 preset=body 直接给响应体）')
        }
        // C25：捕获库里的正文可能是截断的、或二进制被存成 hex/base64 —— 拿它当 mock 只会给客户端一份残缺/错乱的数据
        if (o.encoding) throw codedError('RULE_INVALID', `原响应是二进制（捕获库里存成了 ${o.encoding}），不能当文本 mock；请用 Map Local 指向原文件`)
        if (o.truncated) throw codedError('RULE_INVALID', '原响应在捕获库里被截断了（超过单条上限），拿它 mock 会是残缺数据；请用 Map Local 指向完整文件')
      }
      if (o !== null && !o.encoding && typeof o.contentType === 'string' && o.contentType !== '') {
        headers['content-type'] = o.contentType
        const cs = charsetOf(o.contentType)
        if (cs !== null && cs !== 'utf-8' && codecFor(cs)) charset = cs // 原样用原编码回给客户端（它可能写死了 GBK 解码）
      }
      if (preset === 'empty-lists') {
        let parsed
        try { parsed = parseJsonLossless(o.body) } catch { throw codedError('RULE_INVALID', '原响应不是 JSON，没法"清空数组"') }
        mockBody = JSON.stringify(emptyAllArrays(parsed))
      } else {
        mockBody = edited ? body : o.body
      }
    }
    const short = pathKey.replace(/^https?:\/\/[^/]+/i, '').split('/').filter(Boolean).slice(-2).join('/') || pathKey
    const lat = Number(latencyMs) > 0 ? Math.min(Number(latencyMs), 600000) : (p.latencyMs ?? 0)
    const label = p.type === 'delay' ? `延迟 ${lat / 1000}s 后正常返回` : p.type === 'hang' ? `挂起 ${lat / 1000}s 不回包` : p.label
    const m = String(method ?? '').toUpperCase()
    const raw = {
      enabled: true,
      quick: true,
      name: name || `${label} · ${short}`,
      match: { method: m, host: '', url: pathKey, urlType: 'path' },
      action: {
        type: p.type,
        ...(Number.isInteger(status) ? { status } : (p.status !== undefined ? { status: p.status } : {})),
        // mock 的 latencyMs 也生效（"延迟 N 秒返回空数据"）；delay/hang 用预设或调用方给的时长
        latencyMs: lat,
        body: p.type === 'mock' ? mockBody : '',
        headers,
        ...(charset !== null ? { charset } : {}),
      },
    }
    const rule = this.normalizeRule(raw)
    const rules = this.loadRules().slice()
    // C27：方法为空的新规则替换该路径的全部一键规则；指定方法的只替换同方法的
    const same = (r) => r.quick === true && r.match?.urlType === 'path' && urlPathKey(r.match.url) === urlPathKey(pathKey) &&
      (m === '' || String(r.match.method ?? '').toUpperCase() === m)
    let replaced = false
    for (let i = rules.length - 1; i >= 0; i--) {
      if (!same(rules[i])) continue
      if (!replaced) rule.id = rules[i].id
      replaced = true
      rules.splice(i, 1)
    }
    rules.unshift(rule)
    this.writeRules(rules)
    const out = this.getRules()
    return { ...out, rule: out.rules[0], replaced, reach: this.ruleReach(pathKey) }
  }

  /** First matching enabled rule for a request, or null. */
  matchRule(req) {
    for (const rule of this.loadRules()) {
      if (rule.enabled === false) continue
      if (matchRule(rule, req)) return rule
    }
    return null
  }

  bumpRule(rule) {
    if (rule === null || rule.id === undefined) return
    rule.hits = (rule.hits ?? 0) + 1
    if (this.rulesFlushTimer === null) {
      this.rulesFlushTimer = setTimeout(() => {
        this.rulesFlushTimer = null
        try {
          this.ensureRulesWritable()
          writeFileAtomicSync(this.rulesFile, JSON.stringify(this.rulesCache.rules, null, 2))
          this.rulesCache = { key: this.rulesFileKey(), rules: this.rulesCache.rules }
        } catch {
          // best effort hit persistence
        }
      }, 500)
    }
    this.rulesCache = { key: 'dirty', rules: this.rulesCache.rules }
  }

  /** Emit a terminal record when forwarding fails before streamResponse can do it. */
  recordForwardError(record, started, error, note) {
    if (record.complete === true) return
    if (!Number.isInteger(record.status)) record.status = 502
    record.complete = true
    record.durationMs = Date.now() - started
    const detail = error instanceof Error ? error.message : String(error)
    record.note = `${note} · 代理错误: ${detail.slice(0, 180)}`
    this.onRecord({ ...record })
  }

  /**
   * 本地回包（mock / Map Local 共用）：
   *   规则请求延迟（latencyMs ± jitterMs）+ 回包延迟（responseDelayMs）+ 全局弱网回包延迟 之后才发响应头，
   *   正文按 min(规则限速, 全局下行限速) 分片写出 —— 客户端感受到的就是"接口慢"，不是"连接慢"。
   */
  async respondLocal({ record, rule, res, started, sim, status, headers, buf, storedBody, note }) {
    const action = rule.action
    const pre = jittered(action.latencyMs, action.jitterMs)
    const post = (Number(action.responseDelayMs) || 0) + (sim !== null ? sim.responseDelayMs : 0)
    if (pre + post > 0) await sleep(pre + post)
    const kbps = minPositive(action.throttleKbps, sim !== null ? sim.downKbps : 0)
    record.status = status
    record.resHeaders = headers
    const ctKey = headerKeyCI(headers, 'content-type')
    record.contentType = ctKey !== null ? String(headers[ctKey] ?? '') : ''
    record.resBody = storedBody
    record.bytesRes = buf.length
    record.streaming = false
    record.firstByteMs = Date.now() - started
    record.ttfbMs = record.firstByteMs
    record.ruleId = rule.id
    record.note = note + delayNote({ pre, post, kbps, sim })
    this.counters.rulesMocks++
    const head = safeWriteHead(res, status, headers)
    if (head.dropped.length > 0) record.note += ` · 丢弃非法响应头 ${head.dropped.join(', ')}`
    if (!head.ok) {
      record.complete = false
      record.status = 500
      record.note += ` · 响应头写出失败：${head.error}`
    } else {
      const delivered = await sendBody(res, buf, kbps)
      record.complete = delivered
      if (!delivered) record.note += ' · 客户端已断开（未收完）'
    }
    record.durationMs = Date.now() - started
    this.onRecord({ ...record })
  }

  /** Serve a mocked response (AutoResponder 'mock' action). */
  async applyMock(record, rule, res, { started = Date.now(), sim = null } = {}) {
    const action = rule.action
    const status = Number.isInteger(action.status) ? action.status : 200
    const headers = mergeHeadersCI({ 'content-type': 'application/json; charset=utf-8' }, action.headers)
    const body = typeof action.body === 'string' ? action.body : ''
    let buf = Buffer.from(body, 'utf8')
    if (action.charset && body !== '') {
      // 原响应是 GBK 等编码时，按同一编码回给客户端（它很可能写死了解码方式）
      const codec = codecFor(action.charset)
      const ctKey = headerKeyCI(headers, 'content-type') ?? 'content-type'
      const enc = codec ? encodeBody(body, codec, { json: /json/i.test(String(headers[ctKey] ?? '')) }) : { ok: false }
      if (enc.ok) buf = enc.buf
      else headers[ctKey] = String(headers[ctKey] ?? 'application/json').replace(/charset=["']?[\w-]+["']?/i, 'charset=utf-8')
    }
    await this.respondLocal({ record, rule, res, started, sim, status, headers, buf, storedBody: body, note: `规则 mock: ${rule.name}` })
  }

  /** Map Local：用本地文件当响应（每次请求重新读盘 ⇒ 在编辑器里改文件，客户端刷新即见）。 */
  async applyMapLocal(record, rule, res, { started = Date.now(), sim = null } = {}) {
    const action = rule.action
    let buf = null
    let readError = null
    try {
      buf = await fs.promises.readFile(action.file)
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e)
    }
    const ext = path.extname(String(action.file)).toLowerCase()
    const status = readError !== null ? 404 : (Number.isInteger(action.status) ? action.status : 200)
    const headers = mergeHeadersCI({ 'content-type': MAP_LOCAL_TYPES[ext] ?? 'application/octet-stream' }, action.headers)
    const out = readError !== null ? Buffer.from(`Map Local 读取失败: ${readError}`, 'utf8') : buf
    if (readError !== null) {
      const k = headerKeyCI(headers, 'content-type')
      if (k !== null) delete headers[k]
      headers['content-type'] = 'text/plain; charset=utf-8'
    }
    await this.respondLocal({
      record, rule, res, started, sim, status, headers, buf: out,
      storedBody: bodyForStore(out, '', headers[headerKeyCI(headers, 'content-type') ?? 'content-type']),
      note: readError !== null ? `规则 Map Local 失败: ${rule.name} · ${readError.slice(0, 120)}` : `规则 Map Local: ${rule.name} ← ${action.file}`,
    })
  }

  /**
   * 挂起（模拟接口超时）：收下请求、一直不回包，直到 holdMs 到点或**客户端自己放弃**（它的 Timeout 触发），再断开。
   * 与"阻断"的区别：阻断是立刻断开（客户端马上报网络错误）；挂起让客户端走它自己的超时分支（转圈、超时提示）。
   * 默认挂 120s：比 HttpWebRequest 默认的 100s Timeout 长，客户端才会真的走到超时分支（C26）。
   */
  async applyHang(record, rule, res, { started = Date.now() } = {}) {
    const holdMs = Math.max(1000, Math.min(Number(rule.action.latencyMs) || HANG_DEFAULT_MS, 600000))
    record.status = 0
    record.complete = false
    record.ruleId = rule.id
    record.note = `规则挂起: ${rule.name}（${Math.round(holdMs / 1000)}s 内不回包）`
    this.onRecord({ ...record })
    const clientGaveUp = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), holdMs)
      res.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    record.complete = true
    record.durationMs = Date.now() - started
    record.note = `规则挂起: ${rule.name} · ` + (clientGaveUp ? `客户端在 ${record.durationMs}ms 后自己放弃（超时生效）` : `挂满 ${Math.round(holdMs / 1000)}s 后断开`)
    this.onRecord({ ...record })
    try { res.destroy() } catch { /* already closed */ }
  }

  // ----------------------------------------------------------- 全局延时 / 弱网（Fiddler「Simulate Modem Speeds」）

  getNetsim() {
    return { ...this.netsim, presets: NETSIM_PRESETS }
  }

  /** 更新全局弱网设置；参数（不含开关）落盘，宿主重启后开关一律回到"关"——忘了关会让整机抓到的接口全变慢。 */
  setNetsim(cfg) {
    const c = cfg !== null && typeof cfg === 'object' ? cfg : {}
    const next = { ...this.netsim }
    if (typeof c.preset === 'string' && NETSIM_PRESETS[c.preset] !== undefined) Object.assign(next, NETSIM_PRESETS[c.preset].values)
    const num = (v, max) => Math.max(0, Math.min(Number(v) || 0, max))
    for (const k of ['requestDelayMs', 'responseDelayMs', 'jitterMs']) if (c[k] !== undefined) next[k] = num(c[k], 600000)
    for (const k of ['downKbps', 'upKbps']) if (c[k] !== undefined) next[k] = num(c[k], 1024 * 1024)
    if (typeof c.hosts === 'string') next.hosts = c.hosts.trim()
    if (typeof c.urlFilter === 'string') next.urlFilter = c.urlFilter.trim()
    if (['all', 'intercept', 'proxy'].includes(c.scope)) next.scope = c.scope
    if (typeof c.enabled === 'boolean') next.enabled = c.enabled
    if (typeof c.preset === 'string' && c.enabled === undefined && NETSIM_PRESETS[c.preset] !== undefined) next.enabled = c.preset !== 'off'
    this.netsim = next
    try {
      const { enabled: _ignored, ...persist } = next
      fs.mkdirSync(path.dirname(this.netsimFile), { recursive: true })
      fs.writeFileSync(this.netsimFile, JSON.stringify(persist, null, 2), 'utf8')
    } catch {
      // best effort
    }
    return this.getNetsim()
  }

  /** 这条请求要不要套全局弱网：返回本次生效的数值（含抖动），不套返回 null。 */
  netsimFor({ host, url, via }) {
    const s = this.netsim
    if (s.enabled !== true) return null
    if (s.scope === 'intercept' && via !== 'intercept') return null
    if (s.scope === 'proxy' && via === 'intercept') return null
    if (s.hosts !== '') {
      const h = String(host ?? '').toLowerCase()
      const ok = s.hosts.split(/[\s,;]+/).filter(Boolean).some((p) => {
        const pat = p.toLowerCase()
        return pat.startsWith('*.') ? h === pat.slice(2) || h.endsWith(pat.slice(1)) : h === pat
      })
      if (!ok) return null
    }
    if (s.urlFilter !== '' && !String(url ?? '').toLowerCase().includes(s.urlFilter.toLowerCase())) return null
    if (s.requestDelayMs === 0 && s.responseDelayMs === 0 && s.downKbps === 0 && s.upKbps === 0 && s.jitterMs === 0) return null
    return {
      requestDelayMs: jittered(s.requestDelayMs, s.jitterMs),
      responseDelayMs: s.responseDelayMs,
      downKbps: s.downKbps,
      upKbps: s.upKbps,
    }
  }

  // ----------------------------------------------------------- 请求断点
  /** 断点匹配：仅在启用时按 阶段 / 方法 / URL(子串) 过滤命中。 */
  bpMatch(method, url, phase = 'request') {
    if (!this.breakpoints.enabled) return false
    const want = this.breakpoints.phase ?? 'request'
    if (want !== 'both' && want !== phase) return false
    const mf = this.breakpoints.methodFilter
    if (mf !== '' && mf !== String(method).toUpperCase()) return false
    const uf = this.breakpoints.urlFilter
    if (uf !== '' && !String(url).toLowerCase().includes(uf.toLowerCase())) return false
    return true
  }

  /** 挂起一个请求断点，返回用户决定；120s 超时自动放行，避免忘记处理卡死客户端 socket。 */
  waitBreakpoint(phase, data, res = null) {
    return new Promise((resolve) => {
      const id = `bp_${this._pauseSeq++}`
      const timer = setTimeout(() => {
        if (this.paused.has(id)) { this.paused.delete(id); resolve({ action: 'continue', edits: null, timedOut: true }) }
      }, 120000)
      // R7-04：记下这条请求的响应对象 —— 列表里据此标出"客户端已经放弃"（放行时调用方也不会再转发）
      this.paused.set(id, { id, phase, data, resolve, timer, createdAt: Date.now(), res })
    })
  }

  /** 断点配置 + 当前挂起（等待处理）的请求列表。 */
  getBreakpoints() {
    const paused = []
    for (const p of this.paused.values()) {
      paused.push({
        id: p.id, phase: p.phase, createdAt: p.createdAt, method: p.data.method, url: p.data.url,
        clientGone: p.res !== null && p.res !== undefined && p.res.destroyed === true,
        reqHeaders: p.data.reqHeaders ?? {}, reqBody: p.data.reqBody ?? '',
        ...(p.phase === 'response'
          ? { status: p.data.status, resHeaders: p.data.resHeaders ?? {}, resBody: p.data.resBody ?? '', editable: p.data.editable !== false, note: p.data.note ?? '' }
          : {}),
      })
    }
    return { config: { ...this.breakpoints }, paused }
  }

  setBreakpoints(cfg) {
    if (cfg !== null && typeof cfg === 'object') {
      if (typeof cfg.enabled === 'boolean') this.breakpoints.enabled = cfg.enabled
      if (typeof cfg.urlFilter === 'string') this.breakpoints.urlFilter = cfg.urlFilter.trim()
      if (typeof cfg.methodFilter === 'string') this.breakpoints.methodFilter = cfg.methodFilter.trim().toUpperCase()
      if (['request', 'response', 'both'].includes(cfg.phase)) this.breakpoints.phase = cfg.phase
    }
    if (!this.breakpoints.enabled) { for (const id of [...this.paused.keys()]) this.releaseBreakpoint(id, 'continue', null) } // 关闭即全部放行
    return this.getBreakpoints()
  }

  /**
   * 放行 / 丢弃一个挂起的断点。编辑内容先校验（C6）：非法头名 / 头值（中文、换行、空格）、越界状态码、非法方法
   * 会让后面的 writeHead / http.request 抛异常 —— 那时客户端已经在等了。校验失败抛 `BP_EDIT_INVALID`，
   * 断点**保持挂起**，用户改对了再放行。
   */
  releaseBreakpoint(id, action, edits) {
    const p = this.paused.get(id)
    if (p === undefined) return false
    if (action !== 'drop' && edits !== null && edits !== undefined) {
      if (typeof edits !== 'object' || Array.isArray(edits)) throw codedError('BP_EDIT_INVALID', '编辑内容必须是对象')
      const checkHeaders = (h, label) => {
        if (h === undefined || h === null) return
        if (typeof h !== 'object' || Array.isArray(h)) throw codedError('BP_EDIT_INVALID', `${label}必须是 JSON 对象`)
        for (const [k, v] of Object.entries(h)) {
          for (const one of Array.isArray(v) ? v : [v]) {
            const err = validateHeader(k, String(one ?? ''))
            if (err) throw codedError('BP_EDIT_INVALID', `${label} ${k}：${err}`)
          }
        }
      }
      if (p.phase === 'response') {
        if (edits.status !== undefined && edits.status !== null && edits.status !== '') {
          const s = Number(edits.status)
          if (!Number.isInteger(s) || s < 100 || s > 599) throw codedError('BP_EDIT_INVALID', `状态码要在 100–599 之间（收到 ${edits.status}）`)
        }
        checkHeaders(edits.resHeaders, '响应头')
        if (edits.resBody !== undefined && typeof edits.resBody !== 'string') throw codedError('BP_EDIT_INVALID', '响应体必须是字符串')
      } else {
        if (edits.method !== undefined && edits.method !== '' && !/^[A-Za-z]+$/.test(String(edits.method))) {
          throw codedError('BP_EDIT_INVALID', `方法名只能是字母（收到 ${edits.method}）`)
        }
        checkHeaders(edits.reqHeaders, '请求头')
        if (edits.reqBody !== undefined && typeof edits.reqBody !== 'string') throw codedError('BP_EDIT_INVALID', '请求体必须是字符串')
      }
    }
    this.paused.delete(id)
    if (p.timer !== null) clearTimeout(p.timer)
    p.resolve({ action: action === 'drop' ? 'drop' : 'continue', edits: edits ?? null })
    return true
  }

  /** 请求阶段断点：挂起 → 用户改 方法/头/体 放行，或丢弃。返回 { dropped } 或 { dropped:false, method, headers, body }。 */
  async applyRequestBreakpoint({ record, res, started, method, headers, reqBuf }) {
    const decision = await this.waitBreakpoint('request', {
      method, url: record.url,
      reqHeaders: record.reqHeaders ?? stripHopByHop(headers),
      reqBody: record.reqBody ?? '',
    }, res)
    if (decision.action === 'drop') {
      record.status = 0
      record.note = '断点丢弃(请求)'
      record.complete = true
      record.durationMs = Date.now() - started
      this.onRecord({ ...record })
      try { res.destroy() } catch { /* client gone */ }
      return { dropped: true }
    }
    let outMethod = method
    let outHeaders = headers
    let outBody = reqBuf
    const e = decision.edits
    if (e !== null && typeof e === 'object') {
      if (typeof e.method === 'string' && e.method !== '') { outMethod = e.method.toUpperCase(); record.method = outMethod }
      if (e.reqHeaders !== null && typeof e.reqHeaders === 'object') {
        outHeaders = { ...e.reqHeaders } // req.headers 键为小写；forward 内部会再 stripHopByHop
        record.reqHeaders = stripHopByHop(e.reqHeaders)
      }
      if (typeof e.reqBody === 'string') {
        outBody = Buffer.from(e.reqBody, 'utf8')
        record.reqBody = e.reqBody
        outHeaders = { ...outHeaders }
        outHeaders['content-length'] = String(outBody.length) // 同步长度，避免与旧 content-length 不符
      }
    }
    // R7-11：断点说明只**追加**在规则 / 来源说明后面（由调用方拼），不再顶掉「Map Remote → 测试环境」之类的去向
    const note = decision.timedOut ? '断点超时放行' : (e !== null ? '断点放行(请求已改)' : '断点放行')
    return { dropped: false, method: outMethod, headers: outHeaders, body: outBody, note }
  }

  ensureCa() {
    if (this.ca !== null) return this.ca
    fs.mkdirSync(this.certDir, { recursive: true })
    const keyFile = path.join(this.certDir, 'ca-key.pem')
    const certFile = path.join(this.certDir, 'ca-cert.pem')
    if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
      try {
        this.ca = {
          key: forge.pki.privateKeyFromPem(fs.readFileSync(keyFile, 'utf8')),
          cert: forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8')),
        }
        return this.ca
      } catch {
        this.ca = null
      }
    }
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01' + Math.floor(Math.random() * 0xffffffff).toString(16)
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)
    const attrs = [{ name: 'commonName', value: 'dsh-api-visualizer Local CA' }, { name: 'organizationName', value: 'dsh-api-visualizer' }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
      { name: 'subjectKeyIdentifier' },
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    fs.writeFileSync(keyFile, forge.pki.privateKeyToPem(keys.privateKey), 'utf8')
    fs.writeFileSync(certFile, forge.pki.certificateToPem(cert), 'utf8')
    this.ca = { key: keys.privateKey, cert }
    return this.ca
  }

  hostCert(host) {
    const cached = this.hostCerts.get(host)
    if (cached !== undefined) return cached
    const ca = this.ensureCa()
    const certFile = path.join(this.certDir, 'hosts', `${host.replace(/[^A-Za-z0-9._-]/g, '_')}.pem`)
    let key = null
    let cert = null
    try {
      if (fs.existsSync(certFile)) {
        const pem = fs.readFileSync(certFile, 'utf8')
        cert = forge.pki.certificateFromPem(pem)
        const keyMatch = /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/.exec(pem)
        if (keyMatch !== null) key = forge.pki.privateKeyFromPem(keyMatch[0])
        // 缓存的证书必须①由**当前**根证书签发（根证书重新生成过的话旧缓存全是坏链）②带 AKI（见下方签发处的说明）
        let valid = false
        try { valid = ca.cert.verify(cert) === true } catch { valid = false }
        if (!valid || cert.getExtension('authorityKeyIdentifier') === null || cert.validity.notAfter.getTime() < Date.now() + 86400000) {
          key = null
          cert = null
        }
      }
    } catch {
      key = null
      cert = null
    }
    if (key === null || cert === null) {
      const keys = forge.pki.rsa.generateKeyPair(2048)
      cert = forge.pki.createCertificate()
      cert.publicKey = keys.publicKey
      cert.serialNumber = '01' + Math.floor(Math.random() * 0xffffffff).toString(16)
      cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
      cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000)
      cert.setSubject([{ name: 'commonName', value: host }])
      cert.setIssuer(ca.cert.subject.attributes)
      // AKI（颁发者密钥标识）：没有它时 Windows 只按**名字**找颁发者 —— 证书存储里若还留着旧的同名
      // 「dsh-api-visualizer Local CA」（本机实测有两张），就会挑错颁发者 ⇒ 签名校验失败（CERT_SIGNATURE_FAILURE），
      // 即使当前根证书已经装进信任区也一样。带上 AKI 后按密钥匹配，旧证书不再干扰。
      const skiExt = ca.cert.getExtension('subjectKeyIdentifier')
      const caKeyId = skiExt !== null && typeof skiExt.subjectKeyIdentifier === 'string' && skiExt.subjectKeyIdentifier !== ''
        ? forge.util.hexToBytes(skiExt.subjectKeyIdentifier)
        : ca.cert.generateSubjectKeyIdentifier().getBytes()
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
        { name: 'authorityKeyIdentifier', keyIdentifier: caKeyId },
      ])
      cert.sign(ca.key, forge.md.sha256.create())
      key = keys.privateKey
      try {
        fs.mkdirSync(path.join(this.certDir, 'hosts'), { recursive: true })
        fs.writeFileSync(certFile, forge.pki.privateKeyToPem(key) + forge.pki.certificateToPem(cert), 'utf8')
      } catch {
        // disk cache is best-effort
      }
    }
    const pair = { key, cert }
    this.hostCerts.set(host, pair)
    return pair
  }

    /**
   * Forward one request through the (optional upstream-chained) agent; attaches connect/tls timing to `record`.
   * `intercept=true`：透明拦截来的请求走拦截自己的直连 agent（按启用前解析的真实 IP 连），不走系统代理。
   *
   * C34：keep-alive 复用的空闲连接可能刚被服务端关掉（FIN 还在路上）—— 请求写出去后立刻 ECONNRESET / socket hang up，
   * 一个响应字节都没收到。直连时 .NET 会自己重发一次；经代理时原来直接回 502。现在：**复用的连接**在**收到响应前**
   * 出这类错误就换新连接重发（正文已整包缓冲，最多 2 次）。
   * C35：上游 TLS 校验结论（tunnelConnect 挂在 socket.__apvTls 上）随结果返回，由调用方记进记录 / 状态。
   */
  forward({ secure, host, port, pathname, method, headers, body, record, intercept = false }) {
    const mod = secure ? https : http
    const clean = stripHopByHop(headers)
    // Host 头：非默认端口必须带端口（原实现只写 host，Map Remote 到非默认端口时会错）
    clean.host = port === (secure ? 443 : 80) ? host : `${host}:${port}`
    const useIntercept = intercept === true && this.redirect !== null
    const agent = useIntercept
      ? (secure ? this.redirect.agents.https : this.redirect.agents.http)
      : (secure ? this.secureAgents : this.agents)
    if (agent === null || agent === undefined) return Promise.reject(new Error('代理 agent 未就绪（引擎已停止？）'))
    const stale = (e) => {
      const code = e && e.code ? String(e.code) : ''
      return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || /socket hang up/i.test(String(e && e.message))
    }
    const attempt = (n) => new Promise((resolve, reject) => {
      const timing = { t0: Date.now(), connectMs: null, tlsMs: null }
      let responded = false
      const req = mod.request({
        host,
        port,
        path: pathname,
        method,
        headers: clean,
        agent,
        __timing: timing,
      }, (res) => {
        responded = true
        if (record !== undefined) {
          if (timing.connectMs !== null) record.connectMs = timing.connectMs
          if (timing.tlsMs !== null) record.tlsMs = timing.tlsMs
          if (n > 0) record.upstreamRetries = n
        }
        const tlsInfo = res.socket && res.socket.__apvTls ? res.socket.__apvTls : null
        resolve({ res, status: res.statusCode, headers: res.headers, timing, tls: tlsInfo })
      })
      req.setTimeout(STREAM_IDLE_TIMEOUT, () => req.destroy(new Error('upstream request timeout')))
      req.once('error', (error) => {
        if (!responded && req.reusedSocket === true && n < 2 && stale(error)) {
          resolve(attempt(n + 1))
          return
        }
        reject(error)
      })
      if (body !== undefined && body.length > 0) req.write(body)
      req.end()
    })
    return attempt(0)
  }

  /**
   * Forward a response while publishing a provisional record and final stream metrics.
   * `prefix`：已经从上游读到、还没发给客户端的数据块（整包缓冲超限时接着流式下发用，C21）。
   * 背压：客户端读得比上游慢时暂停读上游（res.write 返回 false ⇒ 等 drain），宿主内存不会被一个慢客户端撑爆。
   */
  streamResponse({ record, fwd, res, started, note, rule = null, throttleKbps = 0, prefix = null }) {
    const fh = stripHopByHop(fwd.headers)
    record.status = fwd.status
    record.resHeaders = fh
    record.contentType = String(fwd.headers['content-type'] ?? '')
    record.firstByteMs = Date.now() - started
    record.ttfbMs = record.firstByteMs
    record.bytesRes = 0
    record.chunkCount = 0
    record.complete = false
    record.streaming = String(fwd.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream') || fwd.headers['content-length'] === undefined
    record.note = note
    // AutoResponder: rewrite-status overrides what the client actually sees
    if (rule !== null && rule.action?.type === 'rewrite-status' && Number.isInteger(rule.action.status)) {
      record.status = rule.action.status
      record.note = `${note} · 规则重写状态: ${rule.name}`
    }
    // R7-05：客户端在请求延迟 / 弱网 / 回包延迟期间已经放弃 ⇒ 它的 'close' 早就发过了，下面登记的监听永远等不到；
    // 不再往死连接里写，记为未完成（否则面板会把恰恰"超时了"的请求显示成 200 完成）
    if (res.destroyed || res.writableEnded || (res.socket !== null && res.socket !== undefined && res.socket.destroyed)) {
      try { fwd.res.destroy() } catch { /* ignore */ }
      record.complete = false
      record.durationMs = Date.now() - started
      record.note += ' · 客户端已断开（未收完）'
      this.onRecord({ ...record })
      return
    }
    const head = safeWriteHead(res, record.status ?? fwd.status, fh)
    if (head.dropped.length > 0) record.note += ` · 丢弃非法响应头 ${head.dropped.join(', ')}`
    if (!head.ok) {
      try { fwd.res.destroy() } catch { /* ignore */ }
      record.complete = false
      record.status = 500
      record.durationMs = Date.now() - started
      record.note += ` · 响应头写出失败：${head.error}`
      this.onRecord({ ...record })
      return
    }
    this.onRecord({ ...record })
    const resChunks = []
    let bufferedBytes = 0
    let lastUpdate = Date.now()
    let idleTimer = null
    let settled = false
    const throttleBps = Math.max(0, Number(throttleKbps) || 0) * 1024 // 带宽限速目标（字节/秒），0=不限
    let throttleT0 = null
    let sentBytes = 0
    let throttleHold = false
    let drainHold = false
    const maybeResume = () => {
      if (!settled && !throttleHold && !drainHold) {
        try { fwd.res.resume() } catch { /* socket gone */ }
      }
    }
    // R7-03：限速时按速率切片排队写（每片 ≈ 1/10 秒的量，按 sentBytes / throttleBps 的计划时刻发）——
    // 原来是"整块先写出去、再暂停读上游"，一次就读到的响应（典型 JSON）全速发出，弱网对真实接口完全不起作用
    const pace = throttleBps > 0 ? { queue: [], timer: null, end: false, slice: Math.max(256, Math.floor(throttleBps / 10)) } : null
    const finish = (complete) => {
      if (settled) return
      settled = true
      if (idleTimer !== null) clearTimeout(idleTimer)
      if (pace !== null && pace.timer !== null) { clearTimeout(pace.timer); pace.timer = null }
      // R7-02：上游中途断开 / 出错 / 空闲超时 ⇒ 头已经发出，只能把客户端这条响应也断掉；正常结束（res.end）会让
      // chunked 客户端把截断的正文当成完整的，Content-Length 客户端则一直等缺的字节（最长 keepAliveTimeout）
      if (complete) {
        try { res.end() } catch { /* downstream already closed */ }
      } else {
        try { res.destroy() } catch { /* downstream already closed */ }
      }
      record.complete = complete
      record.durationMs = Date.now() - started
      const resText = bodyForStore(Buffer.concat(resChunks), fwd.headers['content-encoding'], fwd.headers['content-type'])
      if (resText !== '') record.resBody = resText
      if (!complete) record.note = `${record.note} · 流中断`
      this.onRecord({ ...record })
    }
    const armIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        try { fwd.res.destroy(new Error('stream idle timeout')) } catch { /* ignore */ }
        finish(false)
      }, STREAM_IDLE_TIMEOUT)
    }
    const onChunk = (chunk) => {
      if (settled) return
      armIdle()
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      record.bytesRes += buf.length
      record.chunkCount += 1
      if (pace !== null) {
        for (let off = 0; off < buf.length; off += pace.slice) pace.queue.push(buf.subarray(off, Math.min(buf.length, off + pace.slice)))
        throttleHold = true
        try { fwd.res.pause() } catch { /* socket gone */ }
        pump()
      } else {
        let ok = true
        try { ok = res.write(buf) } catch { finish(false); return }
        if (!ok && !drainHold) {
          drainHold = true
          fwd.res.pause()
          res.once('drain', () => { drainHold = false; maybeResume() })
        }
      }
      if (bufferedBytes < BUFFER_CAP) {
        const keep = Math.min(buf.length, BUFFER_CAP - bufferedBytes)
        if (keep > 0) resChunks.push(buf.subarray(0, keep))
        bufferedBytes += keep
      }
      if (Date.now() - lastUpdate >= STREAM_UPDATE_MS) {
        lastUpdate = Date.now()
        record.durationMs = Date.now() - started
        this.onRecord({ ...record })
      }
    }
    // R7-03：限速写出泵 —— 队列里有货时上游读取保持暂停；队列空了才恢复读，上游已结束则按计划时刻收尾
    const pump = () => {
      if (settled || pace === null || pace.timer !== null) return
      if (throttleT0 === null) throttleT0 = Date.now()
      const wait = throttleT0 + (sentBytes / throttleBps) * 1000 - Date.now()
      if (pace.queue.length === 0 && !pace.end) {
        throttleHold = false
        maybeResume()
        return
      }
      if (wait > 1) {
        pace.timer = setTimeout(() => { pace.timer = null; pump() }, Math.min(wait, 10000))
        return
      }
      if (pace.queue.length === 0) { finish(true); return }
      const part = pace.queue.shift()
      sentBytes += part.length
      armIdle() // 慢速下发本身不算"上游空闲"
      let ok = true
      try { ok = res.write(part) } catch { finish(false); return }
      if (ok) pump()
      else res.once('drain', () => pump())
    }
    armIdle()
    if (Array.isArray(prefix)) for (const c of prefix) onChunk(c)
    fwd.res.on('data', onChunk)
    fwd.res.once('end', () => {
      if (pace === null) { finish(true); return }
      pace.end = true
      pump()
    })
    fwd.res.once('aborted', () => finish(false))
    fwd.res.once('error', () => finish(false))
    res.once('close', () => {
      if (!settled && !res.writableEnded) {
        try { fwd.res.destroy() } catch { /* ignore */ }
        finish(false)
      }
    })
    maybeResume()
  }

  /** 正向代理（明文 HTTP，absolute-form URL）。 */
  async handlePlain(req, res) {
    let u
    try {
      u = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('bad request url')
      return
    }
    await this.processRequest({
      req, res,
      secure: u.protocol === 'https:',
      host: u.hostname,
      port: u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port),
      path: u.pathname + u.search,
      via: 'proxy',
      absoluteUrl: req.url,
    })
  }

  /** 正向代理 CONNECT 隧道里解密出来的 HTTPS 请求。 */
  async handleTunneledRequest(host, port, req, res) {
    await this.processRequest({ req, res, secure: true, host, port, path: req.url, via: 'proxy' })
  }

  /**
   * 读完请求体（缓冲有上限，超过的部分照常转发但不再留存）。
   * upKbps>0：按上行限速读（落后于目标速率就暂停读取，背压让客户端的上传变慢 —— Fiddler 的 request-trickle-delay）。
   */
  readRequestBody(req, upKbps = 0) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      let buffered = 0
      const bps = Math.max(0, Number(upKbps) || 0) * 1024
      const t0 = Date.now()
      req.on('data', (c) => {
        total += c.length
        if (buffered < BUFFER_CAP) {
          const keep = Math.min(c.length, BUFFER_CAP - buffered)
          if (keep > 0) chunks.push(c.subarray(0, keep))
          buffered += keep
        }
        if (bps > 0) {
          const deficit = (total / bps) * 1000 - (Date.now() - t0)
          if (deficit > 5) {
            req.pause()
            setTimeout(() => { try { req.resume() } catch { /* gone */ } }, Math.min(deficit, 10000))
          }
        }
      })
      req.once('end', () => resolve({ buf: Buffer.concat(chunks), total }))
      req.once('error', reject)
      req.once('aborted', () => reject(new Error('client aborted request')))
    })
  }

  /**
   * 三个入口（正向代理明文 / 正向代理 CONNECT 解密 / 透明拦截）共用的**唯一**请求流水线：
   * 读请求 → 规则（mock / Map Local / 阻断 / 延迟 / Map Remote / 改写）→ 请求断点 → 转发
   * →（需要改写或响应断点时整包缓冲，否则流式）回包。
   * 原来正向代理的两个入口各有一份几乎相同的实现；新增动作若只改一份，另一条路就悄悄不生效。
   */
  async processRequest({ req, res, secure, host, port, path: reqPath, via = 'proxy', absoluteUrl = null }) {
    const started = Date.now()
    const defaultPort = secure ? 443 : 80
    const url = absoluteUrl ?? `${secure ? 'https' : 'http'}://${host}${port === defaultPort ? '' : ':' + port}${reqPath}`
    const intercept = via === 'intercept'
    const draining = intercept && this.redirect !== null && this.redirect.draining === true
    const record = { id: randomUUID(), ts: started, source: 'proxy', process: intercept ? 'intercept' : 'local-proxy', method: req.method, url }
    this.attributeRecord(record, req.socket)
    const baseNote = intercept
      ? (draining ? '透明拦截·排空期透传' : (secure ? '透明拦截(HTTPS 解密)' : '透明拦截'))
      : (secure ? '本地代理捕获(HTTPS 解密)' : '本地代理捕获')
    this.counters.requests++
    if (secure && absoluteUrl === null) this.counters.mitm++
    if (intercept && this.redirect !== null) {
      this.redirect.counters.requests++
      this.redirect.hostHits.set(host, (this.redirect.hostHits.get(host) ?? 0) + 1)
      this.noteIntercepted(req.method, url, started, record.id, record.clientProcess ?? null)
    }
    try {
      // 全局弱网（排空期不套：用户已经点了"停用"）
      const sim = draining ? null : this.netsimFor({ host, url, via })
      const { buf: reqBuf, total: reqTotal } = await this.readRequestBody(req, sim !== null ? sim.upKbps : 0)
      record.bytesReq = reqTotal
      const reqText = bodyForStore(reqBuf, req.headers['content-encoding'], req.headers['content-type'])
      if (reqText !== '') record.reqBody = reqText
      if (Object.keys(stripHopByHop(req.headers)).length > 0) record.reqHeaders = stripHopByHop(req.headers)
      if (sim !== null && sim.requestDelayMs > 0) await sleep(sim.requestDelayMs)

      // 排空期只透传：用户已经点了"停用"，规则与断点不该再改客户端看到的数据
      const rule = draining ? null : this.matchRule({ method: req.method, url, host })
      let ruleNote = null
      let rulePre = 0
      let target = { secure, host, port, path: reqPath }
      let method = req.method
      let headers = req.headers
      let body = reqBuf
      let resOps = []
      if (rule !== null) {
        this.bumpRule(rule)
        this.counters.rulesHits++
        record.ruleId = rule.id
        const action = rule.action
        if (action.type === 'mock') {
          await this.applyMock(record, rule, res, { started, sim })
          return
        }
        if (action.type === 'map-local') {
          await this.applyMapLocal(record, rule, res, { started, sim })
          return
        }
        if (action.type === 'hang') {
          await this.applyHang(record, rule, res, { started })
          return
        }
        rulePre = jittered(action.latencyMs, action.jitterMs)
        if (action.type === 'block') {
          // 带延迟的阻断 = "等一会儿再断"（Fiddler 的 *delay + *drop）
          if (rulePre > 0) await sleep(rulePre)
          record.status = 0
          record.note = `规则阻断: ${rule.name}` + (rulePre > 0 ? `（${rulePre}ms 后断开）` : '')
          record.complete = true
          record.durationMs = Date.now() - started
          this.onRecord({ ...record })
          try { res.destroy() } catch { /* ignore */ }
          return
        }
        if (rulePre > 0) {
          await sleep(rulePre)
          ruleNote = `规则延迟: ${rule.name}`
        }
        if (action.type === 'map-remote') {
          const t = mapRemoteTarget(action.target, target)
          if (t.ok) {
            target = t.target
            ruleNote = `规则 Map Remote: ${rule.name} → ${t.label}`
          } else {
            ruleNote = `规则 Map Remote 未生效（${t.error}）`
          }
        }
        if (action.type === 'rewrite') {
          const ops = Array.isArray(action.ops) ? action.ops : []
          const reqOps = ops.filter((o) => o.phase === 'req')
          resOps = ops.filter((o) => o.phase === 'res')
          if (reqOps.length > 0) {
            const ct = String(req.headers['content-type'] ?? '')
            const reqEnc = String(req.headers['content-encoding'] ?? '').toLowerCase()
            // 正文只在能**无损**还原时才交给改写（C8）：解不准就跳过正文类指令，绝不把没改的字段一起写坏
            let dec = null
            if (reqBuf.length === 0) {
              const codec = codecFor(charsetOf(ct) ?? 'utf-8') ?? codecFor('utf-8')
              dec = { ok: true, text: '', codec }
            } else if ((reqEnc === '' || reqEnc === 'identity') && isTextual(ct, reqBuf)) {
              dec = decodeBody(reqBuf, ct)
            }
            const textOk = dec !== null && dec.ok === true
            const out = applyOps(reqOps, { headers, bodyText: textOk ? dec.text : null, path: target.path })
            headers = out.headers
            target = { ...target, path: out.path }
            const notes = [...out.notes]
            if (!textOk && reqBuf.length > 0 && reqOps.some((o) => /^(json-|replace|regex)/.test(String(o.op)))) {
              notes.push(dec !== null && dec.ok === false ? `请求体无法无损解码（${dec.reason}），正文类改写跳过` : '请求体不是文本或已压缩，正文类改写跳过')
            }
            if (out.bodyChanged && textOk) {
              const e = encodeBody(out.bodyText, dec.codec, { json: /json/i.test(ct) })
              if (e.ok) {
                body = e.buf
                headers = { ...headers, 'content-length': String(body.length) }
                record.reqBody = out.bodyText
                if (e.escaped > 0) notes.push(`${e.escaped} 个字符原编码表示不了，已写成 \\u 转义`)
              } else {
                notes.push(`改写后的请求体无法用原编码写回（${e.reason}），保留原请求体`)
              }
            }
            record.reqHeaders = stripHopByHop(headers)
            ruleNote = `规则改写(请求): ${rule.name}` + (notes.length > 0 ? ` · ${notes.join('；')}` : '')
          }
        }
      }

      let bp = { dropped: false, method, headers, body }
      if (!draining && this.bpMatch(method, url, 'request')) bp = await this.applyRequestBreakpoint({ record, res, started, method, headers, reqBuf: body })
      if (bp.dropped) return
      if (typeof bp.note === 'string' && bp.note !== '') ruleNote = `${ruleNote ?? baseNote} · ${bp.note}`
      // R7-05 / R7-04：请求延迟、弱网等待或请求断点期间客户端已经放弃 ⇒ 不再转发（下单之类的 POST 会被服务端照样执行，
      // 而客户端早已报失败、可能还会重试），记为未完成
      if (res.destroyed || (req.socket !== null && req.socket !== undefined && req.socket.destroyed)) {
        record.complete = false
        record.durationMs = Date.now() - started
        record.note = `${record.note ?? ruleNote ?? baseNote} · 客户端在等待期间已断开，未转发`
        this.onRecord({ ...record })
        return
      }
      const fwd = await this.forward({
        secure: target.secure,
        host: target.host,
        port: target.port,
        pathname: target.path,
        method: bp.method,
        headers: bp.headers,
        body: bp.body,
        record,
        intercept,
      })
      // 回包延迟（规则 + 全局）与下行限速（取更严的那个）
      const post = (rule !== null ? Number(rule.action.responseDelayMs) || 0 : 0) + (sim !== null ? sim.responseDelayMs : 0)
      const kbps = minPositive(rule !== null ? rule.action.throttleKbps : 0, sim !== null ? sim.downKbps : 0)
      let note = (record.note ?? ruleNote ?? baseNote) +
        delayNote({ pre: rulePre + (sim !== null ? sim.requestDelayMs : 0), post, kbps, sim })
      // C35：上游证书没通过校验 —— 直连时严格校验证书的请求会失败，经拦截却"成功"了，必须让人看得见
      if (fwd.tls !== null && fwd.tls !== undefined && fwd.tls.authorized === false) {
        record.upstreamTls = { authorized: false, error: fwd.tls.error, incompleteChain: fwd.tls.incompleteChain === true }
        note += ` · ⚠ 上游证书校验失败(${fwd.tls.error})` + (fwd.tls.incompleteChain ? '：多半只是服务端没发全证书链（Windows 会自动补链，Node 不会）' : '')
        if (intercept) this.noteUpstreamTls(target.host, fwd.tls)
      }
      const bpResponse = !draining && this.bpMatch(bp.method, url, 'response')
      if (resOps.length > 0 || bpResponse) {
        await this.respondBuffered({ record, fwd, res, started, note, ops: resOps, rule, breakpoint: bpResponse, throttleKbps: kbps, responseDelayMs: post })
        return
      }
      // 上游响应头已到、正文还在 socket 里：等待期间不挂 data 监听 ⇒ 背压留在上游，到点再流式下发
      if (post > 0) await sleep(post)
      this.streamResponse({ record, fwd, res, started, note, rule: rule?.action?.type === 'rewrite-status' ? rule : null, throttleKbps: kbps })
    } catch (error) {
      this.counters.errors++
      if (intercept && this.redirect !== null) this.redirect.counters.errors++
      this.recordForwardError(record, started, error, baseNote)
      if (secure) console.error('[proxy-engine] https forward error:', error instanceof Error ? error.message : String(error))
      try {
        if (!res.headersSent) {
          res.writeHead(502)
          res.end('proxy error')
        } else {
          res.end()
        }
      } catch {
        // ignore teardown races
      }
    }
  }

  /**
   * 整包缓冲回包：执行响应改写 ops、响应断点（挂起等用户改），再下发。
   * 正文没被改动时**原样**下发上游字节（保留 content-encoding）；改了就按原 charset 重编码、去掉压缩、重算长度。
   * 正文只在能**无损**还原时才允许改（C8）：编码解不准就只允许改状态码 / 响应头，不会把没动的字段一起写坏。
   * 不缓冲的情况：流式响应（SSE 等，C20）、声明超过 REWRITE_CAP 的；中途超限的把已读部分接上继续流式下发（C21）。
   * rewrite-status 规则在这里同样生效（C19：原来一开响应断点它就被忽略）。
   */
  async respondBuffered({ record, fwd, res, started, note, ops = [], rule = null, breakpoint = false, throttleKbps = 0, responseDelayMs = 0 }) {
    const statusRule = rule !== null && rule.action?.type === 'rewrite-status' && Number.isInteger(rule.action.status) ? rule : null
    const ct = String(fwd.headers['content-type'] ?? '')
    if (STREAMING_CONTENT_RE.test(ct)) {
      if (responseDelayMs > 0) await sleep(responseDelayMs)
      this.streamResponse({ record, fwd, res, started, note: `${note} · 流式响应（${ct.split(';')[0].trim()}）不支持响应断点 / 改写，已原样透传`, rule: statusRule, throttleKbps })
      return
    }
    const declared = Number(fwd.headers['content-length'])
    if (Number.isFinite(declared) && declared > REWRITE_CAP) {
      if (responseDelayMs > 0) await sleep(responseDelayMs)
      this.streamResponse({ record, fwd, res, started, note: `${note} · 响应过大(${Math.round(declared / 1048576)}MB)未改写`, rule: statusRule, throttleKbps })
      return
    }
    record.firstByteMs = Date.now() - started
    record.ttfbMs = record.firstByteMs
    const got = await new Promise((resolve) => {
      const chunks = []
      let total = 0
      let done = false
      const onData = (c) => {
        total += c.length
        chunks.push(c)
        if (total > REWRITE_CAP && !done) {
          done = true
          fwd.res.removeListener('data', onData)
          fwd.res.pause()
          resolve({ overflow: true, chunks, total })
        }
      }
      fwd.res.on('data', onData)
      fwd.res.once('end', () => { if (!done) { done = true; resolve({ overflow: false, buf: Buffer.concat(chunks), total }) } })
      fwd.res.once('error', (e) => { if (!done) { done = true; resolve({ error: e }) } })
      fwd.res.once('aborted', () => { if (!done) { done = true; resolve({ error: new Error('upstream aborted') }) } })
    })
    if (got.error) throw got.error
    if (got.overflow) {
      // 中途超限：已读的部分接上剩余部分，交给流式下发（有背压、有错误/断开处理，不改写）
      if (responseDelayMs > 0) await sleep(responseDelayMs)
      this.streamResponse({ record, fwd, res, started, note: `${note} · 响应超过 ${REWRITE_CAP / 1048576}MB，未改写`, rule: statusRule, throttleKbps, prefix: got.chunks })
      return
    }

    const raw = got.buf
    const enc = String(fwd.headers['content-encoding'] ?? '').toLowerCase()
    let decoded = raw
    let decodable = true
    if (enc !== '' && enc !== 'identity') {
      const d = decodeContent(raw, enc)
      if (d === null) decodable = false
      else decoded = d
    }
    const textual = decodable && isTextual(ct, decoded)
    const dec = textual ? decodeBody(decoded, ct) : null
    const textOk = dec !== null && dec.ok === true
    let status = statusRule !== null ? statusRule.action.status : fwd.status
    let headers = { ...stripHopByHop(fwd.headers) }
    let bodyText = textOk ? dec.text : null
    let bodyChanged = false
    const notes = []
    if (statusRule !== null) notes.push(`规则重写状态: ${statusRule.name}`)
    if (ops.length > 0) {
      const out = applyOps(ops, { headers, bodyText, status })
      status = out.status
      headers = out.headers
      if (out.bodyChanged) { bodyText = out.bodyText; bodyChanged = true }
      notes.push(...out.notes)
      if (!decodable) notes.push(`正文压缩格式 ${enc} 解不开，正文类改写跳过`)
      else if (textual && !textOk) notes.push(`正文无法无损解码（${dec.reason}），正文类改写跳过`)
    }
    if (breakpoint) {
      const decision = await this.waitBreakpoint('response', {
        method: record.method,
        url: record.url,
        status,
        resHeaders: headers,
        resBody: textOk
          ? (bodyText ?? '')
          : (textual ? `(正文编码无法无损还原：${dec.reason}；这次只能改状态码 / 响应头)` : `(非文本正文 ${raw.length} 字节，只能改状态码/响应头)`),
        editable: textOk,
        reqHeaders: record.reqHeaders ?? {},
      })
      if (decision.action === 'drop') {
        record.status = 0
        record.note = '断点丢弃(响应)'
        record.complete = true
        record.durationMs = Date.now() - started
        this.onRecord({ ...record })
        try { res.destroy() } catch { /* client gone */ }
        return
      }
      const e = decision.edits
      if (e !== null && typeof e === 'object') {
        const st = Number(e.status)
        if (Number.isInteger(st) && st >= 100 && st <= 599) status = st
        if (e.resHeaders !== null && typeof e.resHeaders === 'object') headers = stripHopByHop(e.resHeaders)
        if (textOk && typeof e.resBody === 'string' && e.resBody !== bodyText) { bodyText = e.resBody; bodyChanged = true }
        notes.push('响应断点已改')
      } else {
        notes.push(decision.timedOut ? '响应断点超时放行' : '响应断点放行')
      }
    }
    let outBuf = raw
    if (bodyChanged) {
      const ctNow = String(Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ct)
      const e2 = encodeBody(bodyText, dec.codec, { json: /json/i.test(ctNow) })
      if (e2.ok) {
        outBuf = e2.buf
        for (const k of Object.keys(headers)) {
          const lk = k.toLowerCase()
          if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') delete headers[k]
        }
        headers['content-length'] = String(outBuf.length)
        if (e2.escaped > 0) notes.push(`${e2.escaped} 个字符原编码表示不了，已写成 \\u 转义`)
      } else {
        notes.push(`改写后的正文无法用原编码写回（${e2.reason}），已回退为原响应正文`)
        bodyChanged = false
        bodyText = dec.text
      }
    }
    record.status = status
    record.resHeaders = headers
    record.contentType = String(Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ct)
    record.resBody = textOk ? (bodyText.length > BODY_CAP ? bodyText.slice(0, BODY_CAP) + '…(截断)' : bodyText) : bodyForStore(raw, enc, ct)
    record.bytesRes = outBuf.length
    record.streaming = false
    const tag = ops.length > 0 ? `规则改写(响应): ${rule?.name ?? ''}` : ''
    record.note = [note, tag, ...notes].filter(Boolean).join(' · ')
    if (responseDelayMs > 0) await sleep(responseDelayMs)
    if (res.destroyed) {
      record.complete = false
      record.note += ' · 客户端已断开'
    } else {
      record.firstByteMs = Date.now() - started
      record.ttfbMs = record.firstByteMs
      const head = safeWriteHead(res, status, headers)
      if (head.dropped.length > 0) record.note += ` · 丢弃非法响应头 ${head.dropped.join(', ')}`
      if (!head.ok) {
        record.complete = false
        record.status = 500
        record.note += ` · 响应头写出失败：${head.error}`
      } else {
        const delivered = await sendBody(res, outBuf, throttleKbps)
        record.complete = delivered
        if (!delivered) record.note += ' · 客户端已断开（未收完）'
      }
    }
    record.durationMs = Date.now() - started
    this.onRecord({ ...record })
  }

  handleConnect(req, clientSocket, head) {
    const target = String(req.url ?? '')
    const [hostPart, portPart] = target.split(':')
    const host = hostPart
    const port = Number(portPart) || 443
    if (!host || host === '') {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      clientSocket.destroy()
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-api-visualizer\r\n\r\n')
    try {
      const pair = this.hostCert(host)
      const secureContext = tls.createSecureContext({
        key: forge.pki.privateKeyToPem(pair.key),
        cert: forge.pki.certificateToPem(pair.cert),
      })
      const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext })
      tlsSocket.__apvRaw = clientSocket // 进程归因按原始 TCP 连接的四元组查
      tlsSocket.once('error', () => {
        this.counters.errors++
        tlsSocket.destroy()
      })
      const mini = http.createServer((req, res) => {
        this.handleTunneledRequest(host, port, req, res).catch(() => {})
      })
      mini.on('upgrade', (req, socket, head) => this.handleWsUpgrade(req, socket, head, { tunnel: true, host, port }))
      mini.on('clientError', () => {})
      mini.emit('connection', tlsSocket)
      if (head !== undefined && head.length > 0) tlsSocket.unshift(head)
    } catch (error) {
      this.counters.errors++
      clientSocket.destroy()
    }
  }

  /**
   * WebSocket capture: rebuild the upgrade request, tunnel it, and tap frames
   * in both directions (client frames are masked, server frames are not).
   * Records one entry per connection (method=WS) plus per-frame metadata.
   */
  handleWsUpgrade(req, socket, head, ctx = null) {
    const started = Date.now()
    // ctx：CONNECT 隧道 {tunnel,host,port}；透明拦截 {intercept,host,port,secure}（两者的 req.url 都是 origin-form）
    const originForm = ctx !== null && (ctx.tunnel === true || ctx.intercept === true)
    const intercept = ctx !== null && ctx.intercept === true
    const secure = ctx !== null && (ctx.secure ?? ctx.tunnel) === true
    let u
    try {
      u = new URL(req.url, originForm ? `${secure ? 'https' : 'http'}://${ctx.host}` : 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    const host = originForm ? ctx.host : u.hostname
    const port = originForm ? ctx.port : (u.port === '' ? 80 : Number(u.port))
    const defaultPort = secure ? 443 : 80
    const wsUrl = `${secure ? 'wss' : 'ws'}://${host}${port === defaultPort ? '' : ':' + port}${u.pathname}${u.search}`
    const record = {
      id: randomUUID(),
      ts: started,
      source: 'proxy',
      process: intercept ? 'intercept' : 'local-proxy',
      method: 'WS',
      url: wsUrl,
      ws: { frames: { c2s: [], s2c: [] }, closeCode: null, closeReason: '', frameCount: null, msgCount: null },
    }
    this.attributeRecord(record, socket)
    this.counters.requests++
    const reqHeaders = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (WS_DROP_HEADERS.has(String(k).toLowerCase())) continue
      reqHeaders[k] = v
    }
    record.reqHeaders = reqHeaders
    const headLines = [`${req.method} ${originForm ? u.pathname + u.search : (u.pathname || '/') + u.search} HTTP/1.1`]
    for (const [k, v] of Object.entries(reqHeaders)) headLines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    const headBuf = Buffer.from(headLines.join('\r\n') + '\r\n\r\n', 'latin1')

    const timing = { t0: started, connectMs: null, tlsMs: null }
    if (intercept && this.redirect !== null) this.redirect.counters.requests++
    // 透明拦截来的 WS 与 HTTP 一样直连真实 IP（不走系统代理）；正向代理沿用上游设置
    const wsUpstream = intercept ? (this.redirect !== null ? this.redirect.upstream : null) : this.upstream
    const wsVerify = intercept && this.redirect !== null ? this.redirect.tlsVerify : null
    let wsTlsWarn = ''
    tunnelConnect({ upstream: wsUpstream, host, port, secure, pinned: this.pinnedLookup, guard: this.loopGuard, verify: wsVerify }, (error, up) => {
      if (error !== null) {
        record.status = 502
        record.note = `WebSocket 连接失败: ${error instanceof Error ? error.message : String(error)}`
        record.complete = true
        this.onRecord({ ...record })
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        } catch {
          // ignore
        }
        socket.destroy()
        return
      }
      if (timing.connectMs !== null) record.connectMs = timing.connectMs
      if (timing.tlsMs !== null) record.tlsMs = timing.tlsMs
      // C35：上游证书没通过校验时，WS 记录与状态里都要看得见
      const upTls = up && up.__apvTls ? up.__apvTls : null
      if (upTls !== null && upTls.authorized === false) {
        record.upstreamTls = { authorized: false, error: upTls.error, incompleteChain: upTls.incompleteChain === true }
        wsTlsWarn = ` · ⚠ 上游证书校验失败(${upTls.error})`
        if (intercept) this.noteUpstreamTls(host, upTls)
      }
      up.write(headBuf)
      if (head !== undefined && head.length > 0) up.write(head)

      let reqText = ''
      let resText = ''
      const pushText = (into, t) => {
        if (t === '') return into
        into += t
        if (into.length > 2 * 1024 * 1024) into = into.slice(0, 2 * 1024 * 1024)
        return into
      }
      const c2sParser = new WsFrameParser({ masked: true, onText: (t) => { reqText = pushText(reqText, t) } })
      const s2cParser = new WsFrameParser({ masked: false, onText: (t) => { resText = pushText(resText, t) } })
      let bytesReq = 0
      let bytesRes = 0
      let provisionalSent = false
      let settled = false
      let upBuf = Buffer.alloc(0)

      /**
       * 2026-09-12（r28 真机验证暴露）：WS 的帧统计/文本**只在 finish() 里写**，而 finish() 只挂在
       * 'close'/'error' 上。偏偏 http server 交出来的 socket 是 `allowHalfOpen=true` ——
       * 对端 FIN 只会派发 **'end'**，**'close' 永不触发**。实测（probe-ws-stats.mjs）：
       * 客户端 destroy() 后 2.5 秒，`readableEnded=true` 而 `destroyed=false`，close 从没来过。
       * 后果正中用户场景（客户端用 WebSocket 收行情）：
       *   · 长连接**活着**的时候，面板上 msgCount 恒为 null、一个帧、一句报文都看不到；
       *   · 客户端断开后，记录永远停在 complete:false，socket 半开挂着（泄漏）。
       * 现在：① 显式处理 'end'（见下面 socket.once('end')）；② 存活期间按节流推**进行中**快照。
       * 节流取 1000ms（不是 streamResponse 的 250ms）——WS 是**长连接**，按 250ms 推会持续写盘。
       */
      const WS_PROGRESS_MS = 1000
      const WS_PROGRESS_TEXT_CAP = 2000
      let lastWsUpdate = started
      let wsPending = false
      let wsFlushTimer = null
      const wsFrameStats = () => ({
        chunkCount: c2sParser.frameCount + s2cParser.frameCount,
        frameCount: { c2s: c2sParser.frameCount, s2c: s2cParser.frameCount },
        msgCount: { c2s: c2sParser.msgCount, s2c: s2cParser.msgCount },
        // frames 列表在解析器里**封顶 300 条**（frameCount 仍在累加）—— 不标出来就是把
        // "被截断的样本"当成"总共就这些"。本仓反复修的正是这一类。
        framesTruncated: c2sParser.frames.length < c2sParser.frameCount
          || s2cParser.frames.length < s2cParser.frameCount,
      })
      const wsTail = (s) => (s.length > WS_PROGRESS_TEXT_CAP ? s.slice(-WS_PROGRESS_TEXT_CAP) : s)
      /** 真正发一次"进行中"快照（不发则已，发就用最新计数）。 */
      const emitWsProgressNow = () => {
        const now = Date.now()
        lastWsUpdate = now
        const f = wsFrameStats()
        record.durationMs = now - started
        record.bytesReq = bytesReq
        record.bytesRes = bytesRes
        record.chunkCount = f.chunkCount
        record.streaming = true
        record.ws.frameCount = f.frameCount
        record.ws.msgCount = f.msgCount
        record.ws.framesTruncated = f.framesTruncated
        // 正文只给**尾部**并明说，避免长连接按秒把 2MB 正文写进库
        if (reqText !== '') record.reqBody = wsTail(reqText)
        if (resText !== '') record.resBody = wsTail(resText)
        record.note = `WebSocket 捕获${wsTlsWarn} · **进行中** ${f.chunkCount} 帧` +
          ` (c2s ${f.frameCount.c2s} / s2c ${f.frameCount.s2c})` +
          (reqText.length > WS_PROGRESS_TEXT_CAP || resText.length > WS_PROGRESS_TEXT_CAP
            ? ` · 正文为尾部 ${WS_PROGRESS_TEXT_CAP} 字符（完整内容在连接结束时写入）` : '')
        this.onRecord({ ...record })
      }
      /**
       * 节流 + **补发**。
       *
       * Codex r29 证伪出的缺口：旧版只在"收到数据"时判断节流，被节流掉就**直接丢掉**了。
       * 于是"**收到首帧之后就安静下来**"的长连接（行情推送很常见）永远发不出统计 ——
       * 面板上 `msgCount` 一直是 `null`，而我在文档里写的是"存活期间每 1 秒推快照"⇒ 承诺过宽。
       * 现在：节流期间只记一个 pending 标记，并在节流窗口结束时**补发一次**（trailing flush）。
       * 代价可控：最多 1 次/秒，且**空闲时不会持续产生新快照**（没有 pending 就不发）。
       */
      const emitWsProgress = () => {
        if (settled || provisionalSent !== true) return
        const now = Date.now()
        const wait = WS_PROGRESS_MS - (now - lastWsUpdate)
        if (wait <= 0) {
          if (wsFlushTimer !== null) { clearTimeout(wsFlushTimer); wsFlushTimer = null }
          wsPending = false
          emitWsProgressNow()
          return
        }
        wsPending = true
        if (wsFlushTimer === null) {
          wsFlushTimer = setTimeout(() => {
            wsFlushTimer = null
            if (wsPending && !settled) { wsPending = false; emitWsProgressNow() }
          }, wait + 5)
          if (typeof wsFlushTimer.unref === 'function') wsFlushTimer.unref()
        }
      }

      // Node puts bytes received after the Upgrade headers in `head`.
      // They are already forwarded above, but must also enter capture metrics.
      if (head !== undefined && head.length > 0) {
        bytesReq += head.length
        c2sParser.feed(head)
      }

      const finish = (complete) => {
        if (settled) return
        settled = true
        // 收尾时把待补发的进度定时器清掉（否则会在快照已终结后再推一次中间态）
        if (wsFlushTimer !== null) { clearTimeout(wsFlushTimer); wsFlushTimer = null }
        wsPending = false
        try {
          up.destroy()
        } catch {
          // ignore
        }
        try {
          socket.destroy()
        } catch {
          // ignore
        }
        const closedCleanly = c2sParser.closeCode !== null || s2cParser.closeCode !== null
        record.complete = complete || closedCleanly
        record.durationMs = Date.now() - started
        record.bytesReq = bytesReq
        record.bytesRes = bytesRes
        record.chunkCount = c2sParser.frameCount + s2cParser.frameCount
        record.streaming = true
        record.ws.frames = { c2s: c2sParser.frames, s2c: s2cParser.frames }
        record.ws.closeCode = s2cParser.closeCode ?? c2sParser.closeCode
        record.ws.closeReason = s2cParser.closeReason || c2sParser.closeReason
        record.ws.frameCount = { c2s: c2sParser.frameCount, s2c: s2cParser.frameCount }
        record.ws.msgCount = { c2s: c2sParser.msgCount, s2c: s2cParser.msgCount }
        // frames 列表封顶 300 条而 frameCount 仍在累加 ⇒ 必须标明"这只是样本"
        record.ws.framesTruncated = c2sParser.frames.length < c2sParser.frameCount
          || s2cParser.frames.length < s2cParser.frameCount
        if (reqText !== '') record.reqBody = reqText
        if (resText !== '') record.resBody = resText
        record.note = `WebSocket 捕获${wsTlsWarn} · ${record.chunkCount} 帧 (c2s ${c2sParser.frameCount} / s2c ${s2cParser.frameCount})` +
          (record.ws.framesTruncated ? ' · 帧样本已截断（见 frameCount 为准）' : '') +
          (record.complete ? '' : ' · 连接中断')
        this.onRecord({ ...record })
      }
      const sendUp = (buf) => {
        try {
          up.write(buf)
          return true
        } catch {
          finish(false)
          return false
        }
      }
      const sendClient = (buf) => {
        try {
          socket.write(buf)
          return true
        } catch {
          finish(false)
          return false
        }
      }

      // client → server (masked frames)
      socket.on('data', (d) => {
        if (settled) return
        bytesReq += d.length
        c2sParser.feed(d)
        sendUp(d)
        emitWsProgress()
      })
      socket.once('close', () => finish(false))
      socket.once('error', () => finish(false))
      // ★ 关键：http server 的 socket 是 allowHalfOpen=true ⇒ 对端 FIN 只派发 'end'，**不会**派发
      //   'close'。只挂 'close' 时，客户端一断开，记录就永远停在 complete:false（实测见 emitWsProgress 注释）。
      socket.once('end', () => finish(false))

      // server → client (unmasked); first chunk carries the 101 head
      const onServerData = (d) => {
        if (settled) return
        s2cParser.feed(d)
        sendClient(d)
        emitWsProgress()
      }
      up.on('data', (d) => {
        if (settled) return
        bytesRes += d.length
        if (!provisionalSent) {
          upBuf = Buffer.concat([upBuf, d])
          const idx = upBuf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const headText = upBuf.subarray(0, idx).toString('latin1')
          const rest = upBuf.subarray(idx + 4)
          const lines = headText.split('\r\n')
          const status = Number.parseInt(lines[0].split(' ')[1], 10) || 101
          const resHeaders = {}
          for (const l of lines.slice(1)) {
            const m = /^([^:]+):\s?(.*)$/.exec(l)
            if (m !== null) resHeaders[m[1].toLowerCase()] = m[2]
          }
          record.status = status
          record.resHeaders = resHeaders
          record.contentType = String(resHeaders['content-type'] ?? '')
          record.firstByteMs = Date.now() - started
          record.ttfbMs = record.firstByteMs
          record.complete = false
          record.note = 'WebSocket 捕获' + wsTlsWarn
          this.onRecord({ ...record })
          this.counters.ws++
          provisionalSent = true
          if (!sendClient(upBuf.subarray(0, idx + 4))) return
          if (rest.length > 0) onServerData(rest)
          return
        }
        onServerData(d)
      })
      up.once('close', () => finish(true))
      up.once('error', () => finish(false))
    }, timing)
  }

  async start({ port = this.port, upstream } = {}) {
    if (this.server !== null) return this.status()
    this.port = port
    this.lastError = null
    this.startedAt = null
    this.counters = { requests: 0, mitm: 0, errors: 0, ws: 0, rulesHits: 0, rulesMocks: 0 }
    if (upstream === undefined || upstream === 'auto') {
      // not specified → re-read the system proxy on every start (never inherit the previous run's mode)
      const sys = readSystemProxy()
      this.upstream = sys.enable && sys.server !== '' ? parseUpstream(sys.server) : null
    } else {
      this.upstream = upstream === null || upstream === '' ? null : parseUpstream(upstream)
    }
    this.ensureCa()
    // pinned：透明拦截同时开着时，被重定向的域名直连真实 IP（按名字解析会解析回本机，形成环路）
    this.agents = new ForwardAgent({ upstream: this.upstream, pinned: this.pinnedLookup, guard: this.loopGuard })
    this.secureAgents = new SecureForwardAgent({ upstream: this.upstream, pinned: this.pinnedLookup, guard: this.loopGuard })
    const server = http.createServer((req, res) => {
      this.handlePlain(req, res).catch(() => {})
    })
    this.server = server
    server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head))
    server.on('connection', (sock) => this.startProcessLookup(sock)) // 进程归因：接受连接时就开始查（不阻塞）
    server.on('upgrade', (req, socket, head) => this.handleWsUpgrade(req, socket, head))
    server.on('clientError', (error, socket) => {
      this.counters.errors++
      socket.destroy()
    })
    server.on('error', (error) => {
      this.counters.errors++
      this.lastError = error instanceof Error ? error.message : String(error)
      if (this.server === server) {
        this.server = null
        this.startedAt = null
        if (this.agents != null) { this.agents.destroy(); this.agents = null }
        if (this.secureAgents != null) { this.secureAgents.destroy(); this.secureAgents = null }
      }
    })
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.removeListener('error', onStartError)
        this.startedAt = Date.now()
        resolve()
      }
      const onStartError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      server.once('listening', onListening)
      server.once('error', onStartError)
      server.listen(port, '127.0.0.1')
    })
    return this.status()
  }

  /**
   * Stop the proxy.
   *
   * F-018（AV-06，2026-09-11 审计确证）：旧实现只关监听 + 销毁 agent，**不碰 WinINET**。
   * 于是机器被留在「系统代理指向 127.0.0.1:8899，而那里已经没人应答」的状态 ——
   * 后果是**整机网络连接被拒**；而 `status()` 此时若引擎为 null 还会硬编码
   * `systemProxyActive:false`，等于"把用户的机器改坏，并宣称自己没动过"。
   * 现在：停止前若系统代理正指向本引擎，就**先把它还回备份值**，并把结果记进 lastRestore。
   *
   * 改为 async：恢复系统代理要走注册表写入 + WinINet 刷新，必须能被 await 到，
   * 否则进程一退，恢复动作就丢了。
   */
  async stop() {
    for (const id of [...this.paused.keys()]) this.releaseBreakpoint(id, 'continue', null) // 停代理前放行所有挂起
    if (this.rulesFlushTimer !== null) {
      clearTimeout(this.rulesFlushTimer)
      this.rulesFlushTimer = null
      if (this.rulesCache.key === 'dirty') {
        try {
          this.ensureRulesWritable()
          writeFileAtomicSync(this.rulesFile, JSON.stringify(this.rulesCache.rules, null, 2))
          this.rulesCache = { key: this.rulesFileKey(), rules: this.rulesCache.rules }
        } catch { /* best effort */ }
      }
    }
    // 关键顺序：**先还系统代理，再关监听**。反过来会出现"代理已关、系统还指着它"的窗口。
    let restore = null
    if (this.systemProxyEnabled()) {
      try {
        restore = await this.setSystemProxy(false)
      } catch (e) {
        restore = { error: e && e.message ? String(e.message) : String(e) }
        this.lastError = '停止时未能恢复系统代理：' + restore.error
      }
    }
    this.lastRestore = restore
    if (this.server !== null) {
      this.server.close()
      this.server = null
    }
    if (this.agents != null) {
      this.agents.destroy()
      this.agents = null
    }
    if (this.secureAgents != null) {
      this.secureAgents.destroy()
      this.secureAgents = null
    }
    this.startedAt = null
    return this.status()
  }

  // ------------------------------------------------------------ 透明拦截（hosts 重定向 + 反向代理）

  /**
   * 启停 / 恢复 / 收尾全部串行（C14）：原来 start 在等 hosts 写入（PowerShell，数秒）期间，排空定时器或并发的 stop
   * 可以把监听关掉，start 却照样写好 hosts 并返回 ok —— hosts 指向一个没人应答的地址。
   */
  serialize(fn) {
    const run = this.redirectChain.then(() => fn())
    this.redirectChain = run.catch(() => {})
    return run
  }

  /**
   * 被重定向域名的上游地址（C30）：返回 `{ ips, ok, fail }`，ips 按轮询起点转一位、冷却中的坏地址排到最后；
   * 不在名单里返回 null = 照常按名字解析。pin 属于当前这次拦截状态（C2），旧状态收尾不会动到它。
   */
  pinFor(host) {
    const r = this.redirect
    if (r === null || r.closed) return null
    const e = r.pins.get(String(host ?? '').toLowerCase())
    if (e === undefined || !Array.isArray(e.ips) || e.ips.length === 0) return null
    const now = Date.now()
    const start = e.idx % e.ips.length
    e.idx = (e.idx + 1) % 1000000
    const rotated = [...e.ips.slice(start), ...e.ips.slice(0, start)]
    const cooling = (ip) => (e.bad.get(ip) ?? 0) > now
    return {
      ips: [...rotated.filter((ip) => !cooling(ip)), ...rotated.filter(cooling)],
      ok: (ip) => { e.bad.delete(ip) },
      fail: (ip, err) => {
        e.bad.set(ip, Date.now() + PIN_COOLDOWN_MS)
        e.lastFailure = { ip, at: Date.now(), message: String(err && err.message ? err.message : err).slice(0, 160) }
      },
    }
  }

  /** 这个地址是不是拦截监听自己（环路保护用）。 */
  isInterceptAddress(ip) {
    if (this.redirect !== null && ip === this.redirect.ip) return true
    return this.interceptIpsInHosts.has(ip)
  }

  /** 批量解析（生产走一次 PowerShell 查全部；测试注入逐个解析器）。返回 Map<host, result | { error }>。 */
  async resolveMany(hosts, phase) {
    const out = new Map()
    if (hosts.length === 0) return out
    if (this.resolveUpstreamBatch !== null) {
      let m
      try {
        m = await this.resolveUpstreamBatch(hosts, { phase })
      } catch (e) {
        m = new Map(hosts.map((h) => [h, { error: e instanceof Error ? e.message : String(e) }]))
      }
      for (const h of hosts) out.set(h, (m instanceof Map ? m.get(h) : undefined) ?? { error: '解析器没有返回结果' })
      return out
    }
    await Promise.all(hosts.map(async (h) => {
      try {
        out.set(h, await this.resolveUpstream(h, { phase }))
      } catch (e) {
        out.set(h, { error: e instanceof Error ? e.message : String(e) })
      }
    }))
    return out
  }

  /** 解析结果 → pin（过滤掉回环地址：直接用会连回本机形成环路）。 */
  makePin(result, ownIp) {
    if (result === null || result === undefined || result.error) throw new Error(result && result.error ? result.error : '解析失败')
    const ips = (Array.isArray(result.ips) ? result.ips : [])
      .filter((ip) => net.isIP(ip) === 4 && ip !== ownIp && (this.allowLoopbackUpstream || !isLoopbackIp(ip)))
    if (ips.length === 0) throw new Error('解析结果为空或只有回环地址（直接用会连回本机形成环路）')
    const ttlMs = Number(result.ttlMs) > 0 ? Number(result.ttlMs) : 300000
    return { ips, ttlMs, via: result.via ?? '', idx: 0, bad: new Map(), expiresAt: Date.now() + ttlMs, error: null, resolvedAt: Date.now() }
  }

  /** 拦截期间的 TLS 证书（按 SNI 域名签发，复用正向代理的根证书与磁盘缓存）。 */
  secureContextFor(name) {
    const host = String(name ?? '').toLowerCase()
    const hit = this.secureContexts.get(host)
    if (hit !== undefined) return hit
    const pair = this.hostCert(host)
    const ctx = tls.createSecureContext({ key: forge.pki.privateKeyToPem(pair.key), cert: forge.pki.certificateToPem(pair.cert), ...INTERCEPT_TLS_COMPAT })
    this.secureContexts.set(host, ctx)
    return ctx
  }

  /** 根证书 SHA-1 指纹（Windows 证书存储按它索引）。 */
  caThumbprint() {
    if (this._caThumb !== undefined) return this._caThumb
    try {
      const ca = this.ensureCa()
      const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes(), 'binary')
      this._caThumb = createHash('sha1').update(der).digest('hex').toUpperCase()
    } catch {
      this._caThumb = null
    }
    return this._caThumb
  }

  /** 请求属于名单里的哪个域名（SNI 优先，其次 Host 头）；都不在返回 null。退役中的域名（E3）仍有 pin，照常接住。 */
  interceptHostOf(req, secure) {
    const r = this.redirect
    if (r === null || r.closed) return null
    const sni = secure && req.socket !== undefined && typeof req.socket.servername === 'string' ? req.socket.servername.toLowerCase() : ''
    const hh = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    for (const h of [sni, hh]) {
      if (h !== '' && (r.hosts.has(h) || r.pins.has(h))) return h
    }
    return null
  }

  newInterceptState(ip, upstream, tlsVerify) {
    return {
      ip,
      upstream: upstream === null || upstream === undefined || upstream === '' ? null : parseUpstream(upstream),
      tlsVerify,
      entries: [],
      hosts: new Map(),
      pins: new Map(),
      servers: new Map(),
      sockets: new Set(),
      agents: {
        http: new ForwardAgent({ upstream: null, pinned: this.pinnedLookup, guard: this.loopGuard }),
        https: new SecureForwardAgent({ upstream: null, pinned: this.pinnedLookup, guard: this.loopGuard, verify: tlsVerify }),
      },
      counters: {
        requests: 0, errors: 0, tlsErrors: 0, tlsNoRequest: 0, tlsAborted: 0, probes: 0,
        plainHttpOnTls: 0, nonTlsOnTls: 0, dedupedRealtime: 0, tcpConnections: 0,
      },
      hostHits: new Map(),
      upstreamTls: new Map(), // host -> { at, error, incompleteChain, count }
      lastTlsError: null,
      lastProtocolError: null,
      lastError: null,
      draining: false,
      drainUntil: null,
      drainTimer: null,
      drainIdle: null,
      refreshTimer: null,
      refreshing: false,
      retireTimers: new Set(),
      closed: false,
      startedAt: Date.now(),
      hostsResult: null,
      probe: null, // R6-01：安全网任务当前注册的探测口 { port, mode }（未知 = null）
    }
  }

  /** 拦截链路上某个域名的上游证书没通过校验（C35）。 */
  noteUpstreamTls(host, info) {
    const r = this.redirect
    if (r === null || info === null || info === undefined) return
    const prev = r.upstreamTls.get(host)
    r.upstreamTls.set(host, { at: Date.now(), error: info.error, incompleteChain: info.incompleteChain === true, count: (prev ? prev.count : 0) + 1 })
  }

  /** 接受的原始连接都登记在案（C2）：关闭拦截时逐个断开，不依赖 server.close 等它们自然结束。 */
  trackSocket(r, sock) {
    r.sockets.add(sock)
    sock.once('close', () => r.sockets.delete(sock))
  }

  /** 在 ip:port 上起一个反向代理监听（https 按 SNI 出证书；http 明文）。 */
  listenIntercept(r, port, secure, defaultHost) {
    const onRequest = (req, res) => {
      if (req.socket !== undefined && req.socket !== null) req.socket.__apvUsed = true
      // 安全网的 HTTP 探针：回一个标记头证明"这是我们的监听"（C29），不记录、不计入请求
      const hostHeader = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
      if (req.url === PROBE_PATH && hostHeader === PROBE_SNI) {
        r.counters.probes++
        res.writeHead(200, { [PROBE_HEADER]: '1', 'content-type': 'text/plain', connection: 'close' })
        res.end('ok')
        return
      }
      const host = this.interceptHostOf(req, secure)
      if (host === null) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-api-visualizer: 这个域名不在透明拦截名单里')
        return
      }
      this.processRequest({ req, res, secure, host, port, path: req.url, via: 'intercept' }).catch(() => {})
    }
    let server
    if (secure) {
      const pair = this.hostCert(defaultHost)
      server = https.createServer({
        key: forge.pki.privateKeyToPem(pair.key),
        cert: forge.pki.certificateToPem(pair.cert),
        ...INTERCEPT_TLS_COMPAT,
        SNICallback: (name, cb) => {
          // 探针的 SNI 用默认证书（颁发者同样是本插件的根证书）：不为它单独签发
          if (String(name ?? '').toLowerCase() === PROBE_SNI) { cb(null); return }
          try { cb(null, this.secureContextFor(name)) } catch (e) { cb(e) }
        },
      }, onRequest)
      server.on('tlsClientError', (err) => {
        const code = err && err.code ? String(err.code) : ''
        const message = String(err && err.message ? err.message : err).slice(0, 200)
        // C32：探针现在走完整握手、单独计数；这两种错误只会来自真实流量，必须告警
        if (code === PLAIN_HTTP_ON_TLS) {
          r.counters.plainHttpOnTls++
          r.lastProtocolError = { at: Date.now(), port, kind: 'plain-http', message: `明文 HTTP 打到了 TLS 端口 ${port}：这个端口应写成 http://域名:${port}` }
          return
        }
        if (code === NON_TLS_ON_TLS) {
          r.counters.nonTlsOnTls++
          r.lastProtocolError = { at: Date.now(), port, kind: 'non-tls', message: `非 TLS 的数据打到了 TLS 端口 ${port}：多半是裸 TCP 协议，应写成 tcp://域名:${port}` }
          return
        }
        if (code === 'ECONNRESET') { r.counters.tlsAborted++; return } // 握手前就断开（端口扫描 / 连上即走），与证书无关
        r.counters.tlsErrors++
        r.lastTlsError = { at: Date.now(), message }
      })
      // .NET 的证书校验在 TLS 握手**完成之后**才做（Schannel 手动校验）：拒绝证书时握手是成功的，
      // 客户端随后直接断开、一个请求都不发 ⇒ tlsClientError 根本不会触发。用"握手完成却没发请求"来识别。
      server.on('secureConnection', (sock) => {
        // C2：TLS 层的 socket 也要登记 —— 只断开底层 TCP socket 时，TLSSocket 不会收到关闭，server.close 会一直等它
        this.trackSocket(r, sock)
        if (String(sock.servername ?? '').toLowerCase() === PROBE_SNI) {
          sock.__apvUsed = true
          r.counters.probes++
          return
        }
        sock.__apvUsed = false
        sock.once('close', () => {
          if (sock.__apvUsed === true) return
          r.counters.tlsNoRequest++
          r.lastTlsError = {
            at: Date.now(),
            host: typeof sock.servername === 'string' ? sock.servername : '',
            message: '握手完成但客户端一个请求都没发就断开了（多半是它不信任本插件签发的证书）',
          }
        })
      })
    } else {
      server = http.createServer(onRequest)
    }
    server.on('connection', (sock) => this.trackSocket(r, sock))
    server.on('connection', (sock) => this.startProcessLookup(sock)) // 进程归因：接受连接时就开始查（不阻塞）
    // 比 .NET ServicePoint 的空闲回收（100s）更长：让客户端先关空闲连接，避开"服务端刚关、客户端正好复用"的竞态
    server.keepAliveTimeout = 120000
    server.headersTimeout = 125000
    server.requestTimeout = 0
    server.on('upgrade', (req, socket, head) => {
      if (req.socket !== undefined && req.socket !== null) req.socket.__apvUsed = true // C33：WS 升级也是"发了请求"
      const host = this.interceptHostOf(req, secure)
      if (host === null) { socket.destroy(); return }
      this.handleWsUpgrade(req, socket, head, { intercept: true, host, port, secure })
    })
    server.on('clientError', (_err, socket) => {
      try { socket.destroy() } catch { /* ignore */ }
    })
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e)
      server.once('error', onError)
      server.listen(port, r.ip, () => {
        server.removeListener('error', onError)
        server.on('error', (e) => { r.lastError = e instanceof Error ? e.message : String(e) })
        r.servers.set(port, { server, secure, mode: secure ? 'https' : 'http' })
        resolve()
      })
    })
  }

  /** tcp://host:port：原样双向转发到该域名的真实 IP（不解析、不记录、不套规则），只为不把它连坏。 */
  listenTcpPassthrough(r, port, host) {
    const server = net.createServer((client) => {
      this.trackSocket(r, client)
      r.counters.tcpConnections++
      const pin = this.pinFor(host)
      if (pin === null) { client.destroy(); return }
      client.pause()
      client.once('error', () => client.destroy())
      connectPinned({ port, pin }, (error, up) => {
        if (error || client.destroyed) {
          if (up) up.destroy()
          client.destroy()
          return
        }
        this.trackSocket(r, up)
        const kill = () => { client.destroy(); up.destroy() }
        up.once('error', kill)
        client.once('error', kill)
        up.once('close', () => client.destroy())
        client.once('close', () => up.destroy())
        client.pipe(up)
        up.pipe(client)
        client.resume()
      })
    })
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e)
      server.once('error', onError)
      server.listen(port, r.ip, () => {
        server.removeListener('error', onError)
        server.on('error', (e) => { r.lastError = e instanceof Error ? e.message : String(e) })
        r.servers.set(port, { server, secure: false, mode: 'tcp', host })
        resolve()
      })
    })
  }

  readInterceptState() {
    try {
      return JSON.parse(fs.readFileSync(this.interceptStateFile, 'utf8'))
    } catch {
      return null
    }
  }

  writeInterceptState(patch) {
    try {
      const prev = this.readInterceptState() ?? {}
      fs.mkdirSync(path.dirname(this.interceptStateFile), { recursive: true })
      fs.writeFileSync(this.interceptStateFile, JSON.stringify({ ...prev, ...patch, updatedAt: Date.now() }, null, 2), 'utf8')
    } catch {
      // best effort：状态文件只用于宿主重启后的恢复（段落里的规格才是权威，C4）
    }
  }

  pinnedSnapshot(r = this.redirect) {
    const out = {}
    if (r !== null && r !== undefined) for (const [h, e] of r.pins) out[h] = e.ips
    return out
  }

  /** 当前名单 → hosts 段落里的规格串（C4）。 */
  blockSpecs(r) {
    return [...r.hosts].flatMap(([h, es]) => specsFor(h, es))
  }

  /**
   * 安全网探测口：优先 TLS，其次明文 HTTP，绝不选 tcp 透传口（探针会被原样转发给真实服务器）。
   * R6-01：只从**已提交名单**（r.hosts）需要、且正在监听的端口里选 —— 只为排空而暂留的旧端口 E3 退役时会关掉，
   * 安全网探测它会把一个健康的段落删掉。
   */
  probeFor(r) {
    const served = (mode) => {
      for (const es of r.hosts.values()) {
        for (const e of es) {
          if (e.mode !== mode) continue
          const s = r.servers.get(e.port)
          if (s !== undefined && s.mode === mode) return e.port
        }
      }
      return null
    }
    const tlsPort = served('https')
    if (tlsPort !== null) return { port: tlsPort, mode: 'https' }
    const httpPort = served('http')
    return httpPort !== null ? { port: httpPort, mode: 'http' } : null
  }

  /** R6-01：已注册的安全网探测口此刻是否还有本状态的监听在应答（模式也要对得上）。 */
  probeServed(r, probe) {
    if (r === null || r === undefined || probe === null || probe === undefined || typeof probe !== 'object') return false
    const s = r.servers.get(Number(probe.port))
    return s !== undefined && s.mode === probe.mode && s.server.listening === true
  }

  /**
   * R6-01：按当前已提交名单重新注册安全网（探测口换成名单里正在监听的端口）。只在 hosts 段落确实是我们这份时才做；
   * allowWithoutSafetyNet —— 注册没确认也绝不因此撤掉段落（旧任务仍在，最坏也只是它照旧按旧口探测）。
   */
  async reregisterSafetyNet(r, why) {
    const probe = this.probeFor(r)
    if (probe === null) return { ok: false, error: '名单里没有可探测的 http / https 端口' }
    // 段落不在（被停用 / 安全网 / 手工删掉了）或不是指向本状态的地址 ⇒ 不注册（注册会把段落写回去）
    const block = hostsBlockState(this.hostsPath)
    if (!block.found || (block.ip !== null && block.ip !== r.ip)) return { ok: false, error: 'hosts 段落不在或不是本次拦截的地址' }
    const res = await this.hostsApplier({
      ip: r.ip, hosts: [...r.hosts.keys()], specs: this.blockSpecs(r), hostsPath: this.hostsPath,
      safetyNet: 'register', probe, allowWithoutSafetyNet: true, ...(this.safetyLogPath ? { logPath: this.safetyLogPath } : {}),
    })
    const registered = res !== null && typeof res === 'object' && res.ok === true
    if (registered) {
      r.probe = probe
      r.hostsResult = res
      this.writeInterceptState({ probe })
    } else {
      this.interceptEvent = {
        at: Date.now(), level: 'warn',
        message: `安全网计划任务没能按新的探测口重新注册（${why}）：${res && res.error ? res.error : (res && res.safetyNet) || '结果未知'}` +
          ' —— 旧任务探测的端口已不在监听，它下次运行（≤5 分钟）可能会撤掉 hosts 段落；必要时停用后重新启用一次。',
      }
    }
    return { ok: registered, probe, result: res }
  }

  /**
   * R6-03：段落里要探测的端口（与安全网一样只问 http / https，绝不问 tcp 透传口）——
   * 状态文件记下的已注册探测口排第一，然后是段落规格里其它的 https、http 端口（最多 8 个）。
   */
  blockProbes(list, saved) {
    const out = []
    const add = (port, mode) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || (mode !== 'https' && mode !== 'http')) return
      if (!out.some((p) => p.port === port)) out.push({ port, mode })
    }
    if (saved !== null && typeof saved === 'object' && saved.probe !== null && typeof saved.probe === 'object') add(Number(saved.probe.port), saved.probe.mode)
    const parsed = parseInterceptList(list)
    for (const mode of ['https', 'http']) for (const es of parsed.hosts.values()) for (const e of es) if (e.mode === mode) add(e.port, mode)
    return out.slice(0, 8)
  }

  /** R6-03：并行问一轮；任何一个端口按身份探测应答 ⇒ 返回它（{port, mode}），否则 null。 */
  async blockAnswer(ip, probes) {
    const res = await Promise.all(probes.map((p) => probeInterceptListener(ip, p).then((ok) => (ok ? p : null))))
    return res.find((p) => p !== null) ?? null
  }

  /**
   * 启用（或更新名单）。顺序是硬约束：解析真实 IP → 起监听 → **最后**才写 hosts。
   * 反过来（先写 hosts 再起监听）会出现"客户端已被指向本机、而本机还没人应答"的窗口。
   */
  startRedirect(args = {}) {
    return this.serialize(() => this.startRedirectNow(args))
  }

  async startRedirectNow({
    hosts, ip = DEFAULT_INTERCEPT_IP, applyHosts = true, recovering = false, upstream = null, pinnedSeed = null,
    strictUpstreamTls = undefined, allowWithoutSafetyNet = false,
  } = {}) {
    if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(ip))) return { ok: false, error: '监听地址必须是回环地址 127.x.x.x' }
    const parsed = parseInterceptList(hosts)
    if (parsed.hosts.size === 0) return { ok: false, error: parsed.errors.join('；') || '没有可拦截的域名', errors: parsed.errors }
    if (parsed.hosts.size > MAX_HOSTS) return { ok: false, error: `一次最多拦截 ${MAX_HOSTS} 个域名（当前 ${parsed.hosts.size}）` }
    const existing = this.redirect !== null && !this.redirect.closed ? this.redirect : null
    if (existing !== null && existing.ip !== ip) return { ok: false, error: `拦截已在 ${existing.ip} 上运行；先停用再换地址` }
    const warnings = [...parsed.errors]

    // E1：hosts 里**我们段落之外**已有同名条目 ⇒ Windows 取第一条，我们的段落对它不生效（客户端照样直连）
    const hostsNow = readHostsText(this.hostsPath)
    if (hostsNow.ok) {
      for (const c of hostsConflicts(hostsNow.text, [...parsed.hosts.keys()])) {
        if (!parsed.hosts.has(c.host)) continue
        parsed.hosts.delete(c.host)
        warnings.push(`${c.host} 在 hosts 第 ${c.line} 行已被指向 ${c.ip}（本插件段落之外）：Windows 只认第一条，透明拦截对它不会生效 —— 已跳过；要拦截请先删掉那一行`)
      }
      if (parsed.hosts.size === 0) return { ok: false, error: warnings.join('；') }
    }

    // 排空中的旧状态被重新启用：**先**取消它的收尾定时器（在第一个 await 之前，C14）
    let resumeDrainMs = 0
    if (existing !== null && existing.draining) {
      resumeDrainMs = Math.max(0, (existing.drainUntil ?? Date.now()) - Date.now())
      if (existing.drainTimer !== null) { clearTimeout(existing.drainTimer); existing.drainTimer = null }
      if (existing.drainIdle !== null) { clearInterval(existing.drainIdle); existing.drainIdle = null }
    }
    const rearmDrain = () => {
      if (existing !== null && existing.draining && resumeDrainMs >= 0) this.armDrain(existing, resumeDrainMs)
    }

    // ① 真实上游 IP：hosts 里还没指向本机的域名用系统解析（与客户端同路径），已指向本机的绕开 hosts 问 DNS
    const blockNow = hostsBlockState(this.hostsPath)
    const inBlock = new Set(blockNow.entries.map((e) => e.host))
    const resolved = new Map()
    const failed = []
    const need = { 'before-redirect': [], 'after-redirect': [] }
    for (const h of parsed.hosts.keys()) {
      const pin = existing !== null ? existing.pins.get(h) : undefined
      if (pin !== undefined && pin.ips.length > 0 && !recovering) { resolved.set(h, pin); continue }
      need[inBlock.has(h) ? 'after-redirect' : 'before-redirect'].push(h)
    }
    const ownIp = ip
    for (const phase of ['before-redirect', 'after-redirect']) {
      const results = await this.resolveMany(need[phase], phase)
      for (const h of need[phase]) {
        try {
          resolved.set(h, this.makePin(results.get(h), ownIp))
        } catch (e) {
          const seed = pinnedSeed !== null && typeof pinnedSeed === 'object' ? pinnedSeed[h] : undefined
          const msg = e instanceof Error ? e.message : String(e)
          if (Array.isArray(seed) && seed.length > 0) {
            resolved.set(h, { ips: seed, ttlMs: 60000, via: '上次保存', idx: 0, bad: new Map(), expiresAt: Date.now() + 60000, error: msg, resolvedAt: null })
          } else {
            failed.push({ host: h, error: msg })
          }
        }
      }
    }
    if (resolved.size === 0) {
      rearmDrain()
      return { ok: false, error: '所有域名都解析不到真实地址：' + failed.map((f) => `${f.host}(${f.error})`).join('；'), failed, warnings }
    }

    // ② 证书（forge 生成 RSA 是同步的 ⇒ 启用时一次生成完，别等流量来了再卡事件循环）
    this.ensureCa()
    const tlsHosts = [...parsed.hosts].filter(([h, es]) => resolved.has(h) && es.some((e) => e.mode === 'https')).map(([h]) => h)
    for (const h of tlsHosts) this.secureContextFor(h)

    // ③ 监听
    const r = existing ?? this.newInterceptState(ip, upstream, strictUpstreamTls === true ? 'strict' : 'warn')
    const wasNew = existing === null
    // 已在运行时：显式 true / false 切换上游校验方式；没给 = 保持现状（工具只在用户给了时才传）
    const wantVerify = strictUpstreamTls === true ? 'strict' : strictUpstreamTls === false ? 'warn' : null
    if (!wasNew && wantVerify !== null && r.tlsVerify !== wantVerify) {
      // 换一个新的 https agent；旧 agent 只关空闲连接，进行中的请求照常走完（之后空闲超时自然关闭）
      const old = r.agents.https
      r.tlsVerify = wantVerify
      r.agents.https = new SecureForwardAgent({ upstream: null, pinned: this.pinnedLookup, guard: this.loopGuard, verify: wantVerify })
      for (const list of Object.values(old.freeSockets ?? {})) for (const s of list) { try { s.destroy() } catch { /* ignore */ } }
    }
    const portsNeeded = new Map() // port → { mode, host }（host 只对 tcp 有意义：裸 TCP 透传的目标域名）
    for (const [h, es] of parsed.hosts) {
      if (!resolved.has(h)) continue
      for (const e of es) portsNeeded.set(e.port, { mode: e.mode, host: h })
    }
    if (![...portsNeeded.values()].some((p) => p.mode !== 'tcp')) {
      rearmDrain()
      return { ok: false, error: 'tcp:// 透传只是补充：名单里至少要有一个 http / https 端口（安全网要靠它探测监听是否还在）', warnings }
    }
    const opened = []
    const closeOpened = () => {
      for (const p of opened) {
        try { r.servers.get(p).server.close() } catch { /* ignore */ }
        r.servers.delete(p)
      }
    }
    for (const [port, needPort] of portsNeeded) {
      const cur = r.servers.get(port)
      if (cur !== undefined) {
        if (cur.mode !== needPort.mode || (needPort.mode === 'tcp' && cur.host !== needPort.host)) {
          closeOpened()
          if (wasNew) await this.closeStateNow(r)
          else rearmDrain()
          return { ok: false, error: cur.mode !== needPort.mode ? `端口 ${port} 已按 ${cur.mode} 监听，不能再当 ${needPort.mode}` : `tcp 端口 ${port} 已透传给 ${cur.host}，不能再给 ${needPort.host}`, warnings }
        }
        continue
      }
      try {
        if (needPort.mode === 'tcp') await this.listenTcpPassthrough(r, port, needPort.host)
        else await this.listenIntercept(r, port, needPort.mode === 'https', tlsHosts[0] ?? [...resolved.keys()][0])
        opened.push(port)
      } catch (e) {
        closeOpened()
        if (wasNew) await this.closeStateNow(r)
        else rearmDrain()
        const code = e && e.code ? e.code : ''
        return {
          ok: false,
          code,
          error: `无法监听 ${ip}:${port}（${code || (e instanceof Error ? e.message : e)}）` +
            // R6-03：恢复时 hosts 本来就没动（段落已在）；别写"hosts 未改动"，后面的撤回提示会与它自相矛盾
            (code === 'EADDRINUSE' || code === 'EACCES' ? ' —— 端口被别的程序独占（IIS / http.sys / 其它代理？）' + (recovering ? '' : '；hosts 未改动') : (recovering ? '' : ' —— hosts 未改动')),
          warnings,
        }
      }
    }

    // ④ 提交名单与上游（失败时能回到旧名单）
    const prevHosts = r.hosts
    const prevEntries = r.entries
    const prevPins = new Map(r.pins)
    for (const [h, v] of resolved) r.pins.set(h, v)
    r.hosts = new Map([...parsed.hosts].filter(([h]) => resolved.has(h)))
    r.entries = Array.isArray(hosts) ? hosts.map(String) : String(hosts).split(/[\s,;]+/).filter(Boolean)
    this.redirect = r
    const rollbackCommit = async () => {
      if (wasNew) {
        await this.closeStateNow(r)
      } else {
        r.hosts = prevHosts
        r.entries = prevEntries
        r.pins = prevPins
        closeOpened()
        rearmDrain()
      }
    }

    // ⑤ 最后才改 hosts（恢复监听时段落本来就在，不动它）
    let hostsResult = null
    let keptError = null // R6-05
    if (applyHosts) {
      const probe = this.probeFor(r)
      hostsResult = await this.hostsApplier({
        ip, hosts: [...r.hosts.keys()], specs: this.blockSpecs(r), hostsPath: this.hostsPath,
        safetyNet: 'register', probe, allowWithoutSafetyNet: allowWithoutSafetyNet === true, ...(this.safetyLogPath ? { logPath: this.safetyLogPath } : {}),
      })
      // R6-05：写失败、而它自己的回滚也没成（rolledBack !== true）、hosts 里的段落正是这次要写的那份 ⇒ 客户端此刻就被指向这里：
      // 监听必须留着（关掉 = 这些域名全部 ECONNREFUSED，而且可能没有安全网）。按已生效提交，同时把错误报回去
      if (!hostsResult.ok) {
        const b = hostsResult.rolledBack === true ? null : hostsBlockState(this.hostsPath)
        const want = new Set(r.hosts.keys())
        const blockHosts = b !== null && b.found ? new Set(b.entries.map((e) => e.host)) : null
        const ours = blockHosts !== null && (b.ip === null || b.ip === ip) && blockHosts.size === want.size && [...want].every((h) => blockHosts.has(h))
        if (!ours) {
          await rollbackCommit()
          return { ok: false, error: '写 hosts 失败：' + hostsResult.error, hostsResult, failed, warnings }
        }
        keptError = '写 hosts 失败：' + hostsResult.error + ' —— 但 hosts 段落已经在、撤回也没成功：拦截监听保持运行（安全网未确认），要还原请点「停用拦截」。'
      }
      r.hostsResult = hostsResult
      r.probe = hostsResult.ok ? probe : null
      this.interceptIpsInHosts.add(ip)
      // C14：hosts 写完之后再确认一次 —— 监听必须还在（中途被关掉就把段落撤回，绝不留下指向死地址的 hosts）
      const alive = this.redirect === r && !r.closed && [...r.servers.values()].every(({ server }) => server.listening === true)
      if (!alive) {
        const undo = await this.hostsApplier({ ip, hosts: [], hostsPath: this.hostsPath, safetyNet: 'unregister' })
        if (undo.ok) this.interceptIpsInHosts.delete(ip)
        await rollbackCommit()
        return { ok: false, error: '写 hosts 期间拦截监听被关闭了，已撤回 hosts 段落' + (undo.ok ? '' : `（撤回失败：${undo.error}，请手工删除）`), warnings }
      }
    } else if (blockNow.found) {
      this.interceptIpsInHosts.add(blockNow.ip ?? ip)
    }
    r.draining = false
    r.drainUntil = null
    if (r.refreshTimer === null) {
      r.refreshTimer = setInterval(() => { this.refreshPinned().catch(() => {}) }, 30000)
      if (typeof r.refreshTimer.unref === 'function') r.refreshTimer.unref()
    }
    // E3：名单里去掉的域名 —— 已经连上来的连接（客户端 DNS 缓存约 2 分钟）继续服务，排空期过后再退役
    if (!wasNew) {
      const removed = [...prevHosts.keys()].filter((h) => !r.hosts.has(h))
      if (removed.length > 0) this.scheduleRetire(r, removed)
    }
    this.caTrustCache = null // C37：启停之后状态必须重新查
    this.interceptEvent = recovering
      ? { at: Date.now(), level: 'info', message: '宿主重启后已按 hosts 段落恢复透明拦截监听' }
      : null
    this.foreignOwner = null // R6-03：本实例已接管
    this.writeInterceptState({
      active: true, ip, entries: r.entries, specs: this.blockSpecs(r), pinned: this.pinnedSnapshot(r), startedAt: r.startedAt,
      strictUpstreamTls: r.tlsVerify === 'strict',
      ...(r.probe !== null ? { probe: r.probe } : {}),
    })
    if (hostsResult !== null && Array.isArray(hostsResult.warnings)) warnings.push(...hostsResult.warnings)
    if (failed.length > 0) warnings.push('以下域名解析失败、未拦截：' + failed.map((f) => `${f.host}(${f.error})`).join('；'))
    if (keptError !== null) {
      this.interceptEvent = { at: Date.now(), level: 'error', message: keptError }
      return { ok: false, kept: true, error: keptError, hostsResult, ...this.redirectStatus(), failed, warnings }
    }
    return { ok: true, ...this.redirectStatus(), failed, warnings, hostsMethod: hostsResult !== null ? hostsResult.method : 'unchanged' }
  }

  /**
   * E3：从名单移除的域名在排空期后退役（删 pin、关只为它们开的端口）。
   * R6-06：退役排进 serialize() 执行 —— 只按**已提交**的名单算（进行中的更新要么已提交、要么已回滚），
   * 绝不关当前名单还需要的端口。R6-01：要关的端口正是安全网注册的探测口 ⇒ 先按新名单重新注册，注册不成就留着它。
   */
  scheduleRetire(r, removedHosts) {
    const t = setTimeout(() => {
      r.retireTimers.delete(t)
      this.serialize(async () => {
        if (r.closed) return
        for (const h of removedHosts) if (!r.hosts.has(h)) r.pins.delete(h)
        const stillNeeded = new Set([...r.hosts.values()].flatMap((es) => es.map((e) => e.port)))
        let keepProbe = false
        const probe = r.probe
        if (probe !== null && !stillNeeded.has(Number(probe.port)) && r.servers.has(Number(probe.port)) &&
          this.redirect === r && !r.draining) {
          const re = await this.reregisterSafetyNet(r, '名单更新后旧探测口退役')
          if (r.closed) return
          keepProbe = re.ok !== true
        }
        for (const [port, s] of [...r.servers]) {
          if (stillNeeded.has(port)) continue
          if (keepProbe && probe !== null && port === Number(probe.port)) continue
          try { s.server.close() } catch { /* ignore */ }
          r.servers.delete(port)
        }
      }).catch(() => {})
    }, INTERCEPT_DRAIN_MS)
    if (typeof t.unref === 'function') t.unref()
    r.retireTimers.add(t)
  }

  /** 后台刷新过期的上游 IP（失败保留旧值，只记错误）+ 清理去重表。中途状态变了就放弃写入（C2）。 */
  async refreshPinned() {
    this.pruneInterceptNotes()
    const r = this.redirect
    if (r === null || r.closed || r.refreshing) return
    const now = Date.now()
    const due = [...r.pins].filter(([, e]) => e.expiresAt <= now).map(([h]) => h)
    if (due.length === 0) return
    r.refreshing = true
    try {
      const results = await this.resolveMany(due, 'after-redirect')
      if (this.redirect !== r || r.closed) return
      let changed = false
      for (const h of due) {
        const e = r.pins.get(h)
        if (e === undefined) continue
        try {
          const next = this.makePin(results.get(h), r.ip)
          r.pins.set(h, { ...next, idx: e.idx, bad: e.bad })
          changed = true
        } catch (err) {
          e.error = err instanceof Error ? err.message : String(err)
          e.expiresAt = Date.now() + 60000
        }
      }
      if (changed) this.writeInterceptState({ pinned: this.pinnedSnapshot(r) })
    } finally {
      r.refreshing = false
    }
  }

  /** 进入排空：继续透传已经连上来的请求、定期踢掉空闲连接，到点再关监听。 */
  armDrain(r, ms) {
    r.draining = true
    r.drainUntil = Date.now() + ms
    if (r.drainIdle === null) {
      r.drainIdle = setInterval(() => {
        for (const { server } of r.servers.values()) {
          try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections() } catch { /* older node */ }
        }
      }, 5000)
      if (typeof r.drainIdle.unref === 'function') r.drainIdle.unref()
    }
    if (r.drainTimer !== null) clearTimeout(r.drainTimer)
    r.drainTimer = setTimeout(() => {
      r.drainTimer = null
      // 排队执行：只在"这次排空"仍然成立时才关（中途被重新启用就什么都不做）
      this.serialize(async () => {
        if (this.redirect === r && r.draining && !r.closed) await this.closeStateNow(r)
      }).catch(() => {})
    }, ms)
    if (typeof r.drainTimer.unref === 'function') r.drainTimer.unref()
  }

  /**
   * 停用：先还原 hosts（失败就**不关监听** —— 段落还在时关监听等于让客户端连不上），
   * 然后进入排空期：继续透传已经连上来的请求、定期踢掉空闲连接，到点再关监听。
   */
  stopRedirect(args = {}) {
    return this.serialize(() => this.stopRedirectNow(args))
  }

  async stopRedirectNow({ graceMs = INTERCEPT_DRAIN_MS, force = false } = {}) {
    const block = hostsBlockState(this.hostsPath)
    const r = this.redirect !== null && !this.redirect.closed ? this.redirect : null
    let removal = null
    if (block.found || r !== null) {
      const ip = r !== null ? r.ip : (block.ip ?? DEFAULT_INTERCEPT_IP)
      removal = await this.hostsApplier({ ip, hosts: [], hostsPath: this.hostsPath, safetyNet: 'unregister' })
      if (!removal.ok && force !== true) {
        return { ok: false, error: '还原 hosts 失败：' + removal.error + '（拦截仍然生效；为避免客户端连不上，监听保持不动）', removal, ...this.redirectStatus() }
      }
      if (removal.ok) {
        this.interceptIpsInHosts.delete(ip)
        if (block.ip) this.interceptIpsInHosts.delete(block.ip)
        // 段落已还原、安全网任务已注销：排空期的状态（safetyNet）要报这次注销的结果，不能还报开启时那次「已注册」
        if (r !== null) r.hostsResult = removal
      }
    }
    this.caTrustCache = null // C37
    this.writeInterceptState({ active: false, stoppedAt: Date.now(), ...(removal !== null && removal.ok ? { probe: null } : {}) })
    this.interceptEvent = null
    this.foreignOwner = null
    if (r === null) return { ok: true, removal, ...this.redirectStatus() }
    const ms = Math.max(0, Math.min(Number.isFinite(Number(graceMs)) ? Number(graceMs) : INTERCEPT_DRAIN_MS, 600000))
    if (ms === 0) {
      await this.closeStateNow(r)
      return { ok: true, removal, ...this.redirectStatus() }
    }
    this.armDrain(r, ms)
    return { ok: true, removal, ...this.redirectStatus() }
  }

  /** 关掉当前拦截监听与 agent（不碰 hosts）。插件卸载/重载时也走这里：段落留着，下次启动按段落恢复。 */
  closeRedirect() {
    return this.serialize(() => this.closeStateNow(this.redirect))
  }

  /**
   * 关闭一个拦截状态（C2）：同步清理 agent / 定时器，逐个断开登记过的连接（含 WebSocket 升级连接与 tcp 透传两端），
   * 再等监听关闭——最多 CLOSE_GRACE_MS。原来 server.close 的回调要等所有连接结束，有一条长连接就永远不回来，
   * 后面的清理（含清 pin）被无限推迟，还会在之后误清掉**新**状态的 pin。
   */
  async closeStateNow(r) {
    if (r === null || r === undefined || r.closed) return
    r.closed = true
    if (this.redirect === r) this.redirect = null
    if (r.drainTimer !== null) clearTimeout(r.drainTimer)
    if (r.drainIdle !== null) clearInterval(r.drainIdle)
    if (r.refreshTimer !== null) clearInterval(r.refreshTimer)
    for (const t of r.retireTimers) clearTimeout(t)
    r.retireTimers.clear()
    r.drainTimer = null
    r.drainIdle = null
    r.refreshTimer = null
    try { r.agents.http.destroy() } catch { /* ignore */ }
    try { r.agents.https.destroy() } catch { /* ignore */ }
    const closing = [...r.servers.values()].map(({ server }) => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* ignore */ }
    }))
    for (const s of [...r.sockets]) {
      try { s.destroy() } catch { /* ignore */ }
    }
    r.sockets.clear()
    await Promise.race([Promise.all(closing), sleep(CLOSE_GRACE_MS)])
  }

  /**
   * 宿主启动时调用：hosts 段落在 ⇒ 客户端此刻正被指向本机，**必须马上**把监听恢复起来；
   * 段落不在但状态文件说"开着" ⇒ 被安全网/重启/手工清掉了，记一条事件告诉用户。
   * C4：按段落里的 `# apv-entry` 规格重建（tcp:// 与非默认端口都保留）；旧格式段落才退回状态文件 / 裸域名。
   * U45：端口还被上一个实例占着（插件重载时旧实例正在收尾）就退避重试，最多 ~10s。
   * 有域名恢复不了（解析失败、也没有上次的 IP）⇒ 改写段落把它们剔除（否则客户端连这些域名会一直失败）。
   */
  recoverRedirect(opts = {}) {
    return this.serialize(() => this.recoverRedirectNow(opts))
  }

  async recoverRedirectNow({ retryMs = 10000 } = {}) {
    const block = hostsBlockState(this.hostsPath)
    const saved = this.readInterceptState()
    this.foreignOwner = null
    if (!block.found) {
      if (saved !== null && saved.active === true) {
        this.writeInterceptState({ active: false, endedAt: Date.now(), endedBy: 'block-missing' })
        this.interceptEvent = {
          at: Date.now(), level: 'warn',
          message: '上次的透明拦截已结束：hosts 段落不在了（重启过电脑 / 安全网检测到监听不在 / 被手工删除）。需要的话重新启用。',
        }
      }
      return { recovered: false, reason: 'no-block' }
    }
    if (block.ip) this.interceptIpsInHosts.add(block.ip)
    const blockHosts = [...new Set(block.entries.map((e) => e.host))]
    let list
    let degraded = false
    if (Array.isArray(block.specs) && block.specs.length > 0) {
      list = block.specs
    } else {
      const savedSpecs = saved !== null && Array.isArray(saved.specs) ? saved.specs : null
      const covers = savedSpecs !== null && (() => {
        const set = new Set([...parseInterceptList(savedSpecs).hosts.keys()])
        return set.size === blockHosts.length && blockHosts.every((h) => set.has(h))
      })()
      list = covers ? savedSpecs : blockHosts
      degraded = !covers
    }
    const ip = block.ip ?? (saved !== null && saved.ip ? saved.ip : DEFAULT_INTERCEPT_IP)
    const deadline = Date.now() + Math.max(0, retryMs)
    let r
    for (let attempt = 0; ; attempt++) {
      r = await this.startRedirectNow({
        hosts: list, ip, applyHosts: false, recovering: true,
        pinnedSeed: saved !== null ? saved.pinned : null,
        strictUpstreamTls: saved !== null && saved.strictUpstreamTls === true,
      })
      if (r.ok || r.code !== 'EADDRINUSE' || Date.now() >= deadline) break
      await sleep(Math.min(2000, 250 * 2 ** attempt))
    }
    if (!r.ok) {
      // R6-03：撤段落之前先确认它真的没人服务 —— 另一个实例（第二个宿主进程 / 重载时还没关完的上一实例）占着端口时
      // listen 只会 EADDRINUSE。按安全网的身份探测法隔几百毫秒问两次：任一次有应答 ⇒ hosts 段落和安全网任务都不碰，只报告。
      const probes = this.blockProbes(list, saved)
      let owner = await this.blockAnswer(ip, probes)
      if (owner === null) {
        await sleep(300)
        owner = await this.blockAnswer(ip, probes)
      }
      if (owner !== null) {
        this.foreignOwner = { at: Date.now(), ip, probe: owner, hosts: blockHosts.length }
        const message = `hosts 段落正由另一个实例服务（${ip} 上的 ${owner.mode}:${owner.port} 按安全网的身份探测应答了）：` +
          '本实例没有接管监听，hosts 段落和安全网计划任务都保持不动。要在这里管理拦截，先在那个实例里停用（或关掉它），再在这里点「启用」。'
        this.interceptEvent = { at: Date.now(), level: 'warn', message }
        return { recovered: false, reason: 'foreign-owner', foreignOwner: true, code: r.code, error: message }
      }
      // 一个都恢复不了：段落指着一个没人应答的地址 —— 撤掉它，比让客户端一直连不上强
      const undo = await this.hostsApplier({ ip, hosts: [], hostsPath: this.hostsPath, safetyNet: 'unregister' })
      if (undo.ok) this.interceptIpsInHosts.delete(ip)
      this.interceptEvent = {
        at: Date.now(), level: 'error',
        message: '⚠ 恢复透明拦截监听失败：' + r.error + (undo.ok
          ? ' —— 已撤回 hosts 段落，客户端恢复直连。'
          : ' —— 撤回 hosts 段落也失败了（' + undo.error + '）：客户端会连不上这些域名，请在面板点「停用拦截」或手工删除段落。'),
      }
      return { recovered: false, ...r }
    }
    const servedHosts = [...this.redirect.hosts.keys()]
    const lost = blockHosts.filter((h) => !this.redirect.hosts.has(h))
    const rec = this.redirect
    if (lost.length > 0) {
      const probe = this.probeFor(this.redirect)
      const rewrite = await this.hostsApplier({
        ip, hosts: servedHosts, specs: this.blockSpecs(this.redirect), hostsPath: this.hostsPath, safetyNet: 'register', probe,
        ...(this.safetyLogPath ? { logPath: this.safetyLogPath } : {}),
      })
      if (rewrite.ok) {
        rec.probe = probe
        this.writeInterceptState({ probe })
      }
      this.interceptEvent = {
        at: Date.now(), level: 'warn',
        message: `宿主重启后已恢复透明拦截，但 ${lost.join('、')} 恢复不了（解析不到真实地址）` +
          (rewrite.ok ? '，已从 hosts 段落里剔除，这些域名恢复直连。' : `；剔除失败（${rewrite.error}），客户端连这些域名会失败。`),
      }
    } else {
      if (degraded) {
        this.interceptEvent = {
          at: Date.now(), level: 'warn',
          message: '宿主重启后已恢复透明拦截，但旧格式的 hosts 段落没有端口规格，已按 443 + 80 恢复；用到其它端口或 tcp:// 的话请重新启用一次。',
        }
      }
      // R6-01：安全网任务注册的探测口必须有人应答（旧端口只在上次排空期里开着，重启后不会再开）；
      // 不知道 / 没在监听 ⇒ 按恢复出来的名单重新注册（与启用同一条 hostsApplier 路径）
      const sp = saved !== null && saved.probe !== null && typeof saved.probe === 'object' ? { port: Number(saved.probe.port), mode: saved.probe.mode } : null
      if (sp !== null && this.probeServed(rec, sp)) {
        rec.probe = sp
      } else {
        await this.reregisterSafetyNet(rec, sp === null ? '宿主重启后不知道安全网任务的探测口' : `宿主重启后旧探测口 ${sp.mode}:${sp.port} 没有监听`)
      }
    }
    return { recovered: true, ...r }
  }

  /** 记下"代理刚拦到过这条请求"（同一请求实时日志稍后也会写一条，用于去重，C18）。 */
  noteIntercepted(method, url, start, id, clientProcess = null) {
    const key = dedupeKey(method, url)
    const arr = this.interceptNotes.get(key) ?? []
    // R2-04：发起进程（归因已知就记下；查询稍后回来时 attributeRecord 补上）—— 去重时不把别的进程的请求认领给客户端
    const note = { id, key, start, end: null, clientProcess: typeof clientProcess === 'string' && clientProcess !== '' ? clientProcess : null }
    arr.push(note)
    if (arr.length > 50) {
      for (const old of arr.splice(0, arr.length - 50)) this.interceptNoteById.delete(old.id)
    }
    this.interceptNotes.set(key, arr)
    if (typeof id === 'string') this.interceptNoteById.set(id, note)
    if (this.interceptNoteById.size > 5000) this.pruneInterceptNotes()
  }

  /** 透明拦截的记录完成时补上完成时刻（去重按"时间段重叠"比，不再拿到达时刻比完成时刻）。 */
  noteInterceptedEnd(rec) {
    const n = this.interceptNoteById.get(rec.id)
    if (n !== undefined && n.end === null) n.end = Date.now()
  }

  pruneInterceptNotes(now = Date.now()) {
    for (const [key, arr] of this.interceptNotes) {
      const keep = arr.filter((n) => (n.end !== null ? now - n.end <= DEDUPE_WINDOW_MS * 2 : now - n.start <= 15 * 60 * 1000))
      for (const n of arr) if (!keep.includes(n)) this.interceptNoteById.delete(n.id)
      if (keep.length === 0) this.interceptNotes.delete(key)
      else this.interceptNotes.set(key, keep)
    }
  }

  /**
   * 实时日志（System.Net trace）里的这条记录，是否就是代理拦到的那一条？是就"认领"掉（一对一），返回 `{ proxyRecordId }`。
   * C18：按**时间段重叠**判断（客户端发出 ≤ 代理收到 ≤ 代理回完 ≤ 客户端读完），并挑最贴近的那条，而不是窗口里最老的 ——
   * 被断点挂住 / 限速很久的请求不再重复出现，切换窗口期的直连请求也不会被错认。
   */
  claimInterceptedDuplicate(rec, { processName = null } = {}) {
    if (rec === null || rec === undefined || rec.source !== 'realtime' || this.interceptNotes.size === 0) return null
    const arr = this.interceptNotes.get(dedupeKey(rec.method, rec.url))
    if (arr === undefined || arr.length === 0) return null
    // R2-04：实时日志只记配置的客户端进程；代理那条已归因到**别的**进程（CefSharp 子进程 / 浏览器）⇒ 不是同一条请求。
    // 任一边不知道进程时照旧只按时间段配对
    const procKey = (s) => String(s).trim().toLowerCase().replace(/\.exe$/, '')
    const want = typeof processName === 'string' && processName.trim() !== '' ? procKey(processName) : null
    const now = Date.now()
    const recEnd = Number(rec.ts) || now
    const recStart = recEnd - (Number(rec.durationMs) > 0 ? Number(rec.durationMs) : 0)
    let best = -1
    let bestScore = Infinity
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i]
      if (want !== null && typeof n.clientProcess === 'string' && n.clientProcess !== '' && procKey(n.clientProcess) !== want) continue
      const nEnd = n.end ?? now
      if (recEnd < n.start - 2000 || recStart > nEnd + DEDUPE_WINDOW_MS) continue
      const score = Math.abs(n.start - recStart) + Math.abs(nEnd - recEnd) / 2
      if (score < bestScore) { bestScore = score; best = i }
    }
    if (best < 0) return null
    const [n] = arr.splice(best, 1)
    if (arr.length === 0) this.interceptNotes.delete(n.key)
    this.interceptNoteById.delete(n.id)
    if (this.redirect !== null) this.redirect.counters.dedupedRealtime++
    return { proxyRecordId: n.id }
  }

  /** 透明拦截状态（同步部分；证书信任 / 安全网任务这类要起进程查的放 redirectStatusDeep）。 */
  redirectStatus() {
    const r = this.redirect !== null && !this.redirect.closed ? this.redirect : null
    const block = hostsBlockState(this.hostsPath)
    const hosts = r === null ? [] : [...r.hosts].map(([h, entries]) => {
      const p = r.pins.get(h)
      const tlsWarn = r.upstreamTls.get(h)
      return {
        host: h,
        ports: entries.map((e) => `${e.mode ?? (e.secure ? 'https' : 'http')}:${e.port}`),
        upstream: p !== undefined ? p.ips : [],
        via: p !== undefined ? p.via : '',
        requests: r.hostHits.get(h) ?? 0,
        error: p !== undefined ? p.error : null,
        lastFailure: p !== undefined && p.lastFailure ? p.lastFailure : null,
        upstreamTls: tlsWarn ?? null,
      }
    })
    const warnings = []
    // R6-03：段落由另一个实例服务着 —— 不是"没人在听"，别催用户停用（停用会把那个实例的拦截一起撤掉）
    const foreign = r === null && block.found && this.foreignOwner !== null ? this.foreignOwner : null
    if (foreign !== null) {
      warnings.push(`hosts 段落正由另一个实例服务（${foreign.ip} 上的 ${foreign.probe.mode}:${foreign.probe.port} 有本插件的监听应答）—— 本实例没有接管，也没有改动 hosts / 安全网任务；在这里点「停用拦截」会把那个实例的拦截一起撤掉。`)
    } else if (block.found && r === null) {
      warnings.push('⚠ hosts 仍把 ' + block.entries.length + ' 个域名指向 ' + (block.ip ?? '本机') + '，但拦截监听没有在跑 —— 客户端此刻连不上这些域名！点「停用拦截」还原 hosts，或「启用」恢复监听。')
    }
    if (r !== null && !r.draining && !block.found) {
      warnings.push('hosts 段落不在了（被安全网或手工删除）—— 客户端已不再经过拦截；需要的话重新启用。')
    }
    if (r !== null && r.counters.tlsErrors + r.counters.tlsNoRequest > 0) {
      const last = r.lastTlsError
      warnings.push(`有 ${r.counters.tlsErrors + r.counters.tlsNoRequest} 条 TLS 连接被客户端放弃（握手失败 ${r.counters.tlsErrors} / 握手后不发请求 ${r.counters.tlsNoRequest}；最近：${last !== null ? (last.host ? last.host + ' · ' : '') + last.message : '-'}）—— 多半是根证书未被信任：严格校验证书的请求会失败，点「安装根证书」后重启客户端。`)
    }
    if (r !== null && r.counters.plainHttpOnTls + r.counters.nonTlsOnTls > 0 && r.lastProtocolError !== null) {
      warnings.push(`有 ${r.counters.plainHttpOnTls + r.counters.nonTlsOnTls} 条连接的协议与端口不符（${r.lastProtocolError.message}）。`)
    }
    if (r !== null) {
      for (const [h, w] of r.upstreamTls) {
        warnings.push(`${h} 的上游证书没通过校验（${w.error}，${w.count} 次）` +
          (w.incompleteChain ? '：多半只是服务端没发全证书链（Windows 会自动补链，Node 不会）。' : '：直连时严格校验证书的请求会失败，经拦截却成功了 —— 要与直连一致请用 strictUpstreamTls 启用。'))
      }
      for (const h of hosts) {
        if (h.lastFailure && Date.now() - h.lastFailure.at < 10 * 60 * 1000) warnings.push(`${h.host} 的上游地址 ${h.lastFailure.ip} 连接失败（${h.lastFailure.message}），已暂时换用其它地址。`)
      }
    }
    return {
      active: r !== null && !r.draining && block.found,
      listening: r !== null,
      draining: r !== null && r.draining === true,
      drainUntil: r !== null ? r.drainUntil : null,
      foreignOwner: foreign,
      ip: r !== null ? r.ip : (block.ip ?? DEFAULT_INTERCEPT_IP),
      ports: r === null ? [] : [...r.servers].map(([port, s]) => ({ port, secure: s.secure, mode: s.mode })),
      hosts,
      entries: r !== null ? r.entries : [],
      strictUpstreamTls: r !== null ? r.tlsVerify === 'strict' : false,
      hostsFile: {
        path: this.hostsPath, readable: block.readable, blockPresent: block.found, entries: block.entries.length,
        specs: Array.isArray(block.specs) ? block.specs : [], error: block.error ?? null,
      },
      counters: r !== null ? { ...r.counters } : null,
      lastTlsError: r !== null ? r.lastTlsError : null,
      lastProtocolError: r !== null ? r.lastProtocolError : null,
      lastError: r !== null ? r.lastError : null,
      startedAt: r !== null ? r.startedAt : null,
      safetyNet: r !== null && r.hostsResult !== null ? (r.hostsResult.safetyNet ?? (r.hostsResult.result ? r.hostsResult.result.task : null)) : null,
      // 安全网（SYSTEM 任务）的决策日志：每次运行追加一行（alive / removed / keep: 原因），排查"拦截被自动关掉"看这里
      safetyNetLog: r !== null && r.hostsResult !== null && typeof r.hostsResult.safetyLogPath === 'string'
        ? r.hostsResult.safetyLogPath
        : safetyLogPathFor(this.hostsPath, this.safetyLogPath ?? ''),
      event: this.interceptEvent,
      caThumbprint: this.caThumbprint(),
      warnings,
    }
  }

  /** 完整状态：外加根证书是否被信任、安全网任务是否在（各起一次 PowerShell，结果缓存 30s；启停 / 装证书后作废，C37）。 */
  async redirectStatusDeep({ fresh = false } = {}) {
    const base = this.redirectStatus()
    const now = Date.now()
    if (fresh || this.caTrustCache === null || now - this.caTrustCache.at > 30000) {
      const [trust, task] = await Promise.all([caTrustState(base.caThumbprint), safetyTaskState()])
      this.caTrustCache = { at: now, trust, task }
    }
    const { trust, task } = this.caTrustCache
    const caTrusted = trust.currentUser === true || trust.localMachine === true ? true : (trust.currentUser === false && trust.localMachine === false ? false : null)
    const warnings = [...base.warnings]
    if (caTrusted === false) {
      warnings.push('根证书没有被 Windows 信任：总是放行证书的请求能抓到，但严格校验证书的请求（如量化接口）会握手失败。点「安装根证书」导入后重启客户端。')
    }
    if (base.active && task === false) warnings.push('安全网计划任务不存在：宿主异常退出时 hosts 段落不会被自动清理（需要手工删）。')
    return { ...base, caTrusted, caTrust: trust, safetyTaskPresent: task, warnings }
  }

  /**
   * 卸载/重载插件：**先**关拦截监听（hosts 段落保留，由下次 recoverRedirect 接管），再停正向代理（U45）。
   * 反过来的话，停正向代理要还原系统代理（reg.exe + PowerShell，数秒），新实例早已开始恢复、撞上端口占用。
   */
  async shutdown() {
    // R6-04 / U45：两件事同时开始，谁也不排进 serialize 队列（那里可能正有几秒到几十秒的拦截启动 / 停用 / UAC）：
    //   ① 直接关拦截监听（closeStateNow 幂等、先标记已关）—— 同进程重载时新实例能马上拿到端口；
    //   ② stop() —— 第一步就还原系统代理；宿主接着可能立刻 process.exit，这一步等不起。
    const closing = this.closeStateNow(this.redirect)
    const stopping = this.stop()
    await Promise.allSettled([closing, stopping])
  }

  status() {
    const rules = this.getRules()
    return {
      running: this.server !== null,
      port: this.port,
      upstream: this.upstream === null || this.upstream === undefined ? null : `${this.upstream.host}:${this.upstream.port}`,
      caPath: path.join(this.certDir, 'ca-cert.pem'),
      caReady: this.ca !== null || fs.existsSync(path.join(this.certDir, 'ca-cert.pem')),
      systemProxyActive: this.systemProxyEnabled(),
      counters: { ...this.counters },
      startedAt: this.startedAt ?? null,
      error: this.lastError,
      // revision：面板据此发现"规则被别处改过"并重新拉取（C12）
      rules: { total: rules.total, enabled: rules.enabled, revision: rules.revision, warning: rules.warning },
      breakpoints: { enabled: this.breakpoints.enabled, phase: this.breakpoints.phase, paused: this.paused.size },
      // 全局弱网摘要：工具栏指示灯据此刷新（C43：原来只在面板自己保存后才变，agent 开的弱网界面上看不见）
      netsim: { enabled: this.netsim.enabled === true, summary: this.netsimSummary() },
      // 进程归因（netstat 查连接属主）：ok 查到 / miss 表里没有（连接已关等）/ errors 查询失败 / pending 正在查
      processLookups: this.processLookupStats(),
      // 工具栏只要一个摘要；完整状态走 GET /proxy/intercept/status
      intercept: this.redirect === null || this.redirect.closed
        ? { listening: false, active: false, ...(this.foreignOwner !== null ? { foreignOwner: true } : {}) }
        : {
            listening: true, active: !this.redirect.draining, draining: this.redirect.draining, ip: this.redirect.ip,
            hosts: this.redirect.hosts.size, requests: this.redirect.counters.requests,
            tlsErrors: this.redirect.counters.tlsErrors + this.redirect.counters.tlsNoRequest,
          },
    }
  }

  /** 全局弱网的一句话摘要（工具栏 / 状态用）。 */
  netsimSummary() {
    const n = this.netsim
    const parts = [
      n.requestDelayMs > 0 ? `请求延迟 ${n.requestDelayMs}ms${n.jitterMs > 0 ? '±' + n.jitterMs : ''}` : '',
      n.responseDelayMs > 0 ? `回包延迟 ${n.responseDelayMs}ms` : '',
      n.downKbps > 0 ? `下行 ${n.downKbps}KB/s` : '',
      n.upKbps > 0 ? `上行 ${n.upKbps}KB/s` : '',
    ].filter(Boolean)
    return parts.join('，')
  }

  systemProxyEnabled() {
    const sys = readSystemProxy()
    return sys.enable && sys.server.includes(String(this.port))
  }

  /** Export the CA cert as DER for Windows import. */
  exportCaDer() {
    const ca = this.ensureCa()
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes()
    const file = path.join(this.certDir, 'ca-cert.der')
    fs.writeFileSync(file, Buffer.from(der, 'binary'))
    return file
  }

  /**
   * Import the CA into CurrentUser\Root (no admin required).
   *
   * F-019（AV-05，2026-09-11 审计确证）：旧判据是
   *     `const ok = error === null || /成功|already|CertUtil/.test(stdout ?? '')`
   * —— `CertUtil` 是 certutil 自己打在 stdout 里的**模块名，永远存在**
   * （例如 "CertUtil: -addstore 命令成功完成。"，失败时也会打 "CertUtil: -addstore 命令 FAILED."）。
   * 于是 `/CertUtil/` 恒真 → **任何失败都被回成 ok:true**，面板随即向用户宣布
   * "根证书已导入本机信任"，而实际上没有导入 —— 后续所有 HTTPS 解密都会失败，
   * 而用户被告知证书没问题（这类"装了但其实没装"最难排查）。
   *
   * 现在：**以退出码为准**（error === null 即 exit 0 = 真成功），
   * 只有明确说"已存在"才在非 0 退出码下算成功；并把退出码与原始输出一并回给调用方。
   */
  installCa() {
    this.caTrustCache = null // C37：装完证书后信任状态必须重新查
    return new Promise((resolve) => {
      const der = this.exportCaDer()
      execFile('certutil.exe', ['-user', '-addstore', 'Root', der], { encoding: 'utf8' }, (error, stdout, stderr) => {
        const text = String(stdout ?? '') + '\n' + String(stderr ?? '')
        const already = /already|已存在|已经存在|in the store/i.test(text)
        const ok = error === null || already
        this.caTrustCache = null
        resolve({
          ok,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          alreadyInstalled: already,
          output: text.trim().slice(0, 600),
          derPath: der,
          hint: ok ? undefined
            : '证书**没有**导入成功：请检查 certutil 是否存在/被拦截，或手动导入 ' + der +
              '。未导入时 HTTPS 解密会失败（明文 HTTP 仍可抓）。',
        })
      })
    })
  }

  /** Point (or restore) the WinINET system proxy at this engine. */
  async setSystemProxy(enable) {
    if (enable) {
      if (this.server === null) throw new Error('proxy not running')
      if (this.backupSystemProxy === null) {
        const snapshot = this.readSysProxy()
        // ★ F-037：**读不到就不许备份**。原实现无论读没读到都往下走，把"默认值"存成备份，
        //   于是恢复时会把 ProxyEnable 写成 0 —— 关掉用户真实的代理。
        //   宁可拒绝启用（用户自己还能改回来），也不能拿一份假备份去覆盖真实设置。
        if (snapshot.ok !== true) {
          return {
            enabled: false, refused: true, reason: 'backup-unreadable',
            error: '读不到当前系统代理设置（' + String(snapshot.reason || 'unknown') + '）⇒ **拒绝启用**：' +
              '没有可信备份时改动系统代理，恢复阶段会写坏你自己的代理设置。' +
              '请先确认 reg.exe 可用（或手工把 ProxyEnable/ProxyServer 记下来）再试。',
            detail: snapshot.detail || '',
          }
        }
        this.backupSystemProxy = snapshot
        const backupFile = path.join(this.certDir, 'sysproxy-backup.json')
        try {
          if (!fs.existsSync(backupFile)) {
            fs.writeFileSync(backupFile, JSON.stringify(this.backupSystemProxy), 'utf8')
          } else {
            const fromDisk = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
            // 磁盘上的旧备份若本身就是"读失败"的产物，不许拿它当备份（否则会一直错下去）
            if (fromDisk && fromDisk.ok === false) {
              fs.writeFileSync(backupFile, JSON.stringify(this.backupSystemProxy), 'utf8')
            } else {
              this.backupSystemProxy = fromDisk
            }
          }
        } catch {
          // best-effort
        }
      }
      const override = this.backupSystemProxy.override || '<local>'
      await this.regWriter({ enable: true, server: `127.0.0.1:${this.port}`, override })
      await this.winInetRefresh()
      return { enabled: true, server: `127.0.0.1:${this.port}`, backup: this.backupSystemProxy }
    }
    const backupFile = path.join(this.certDir, 'sysproxy-backup.json')
    let backup = this.backupSystemProxy
    if (backup === null) {
      try {
        if (fs.existsSync(backupFile)) backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
      } catch {
        backup = null
      }
    }
    // ★ F-037：**没有备份就不许"恢复"**。原实现在 backup===null 时写 `ProxyEnable=0` ——
    //   也就是"我们从没动过它，却把它关了"（本机用户当前 ProxyEnable=1，这一条会直接生效）。
    //   正确动作是**什么都不做**并如实说明：我们没有它原来的值，所以没法替它恢复。
    if (backup === null || backup.ok === false) {
      return {
        enabled: false, restored: null, refused: true, reason: 'no-backup',
        error: '没有可信的系统代理备份 ⇒ **未做任何修改**（原实现会在这里把 ProxyEnable 写成 0，' +
          '等于关掉一个我们从没开过的代理）。如果系统代理现在指向本工具，请手工改回来。',
        current: this.readSysProxy(),
      }
    }
    await this.regWriter({ enable: backup.enable, server: backup.server, override: backup.override || '' })
    await this.winInetRefresh()
    return { enabled: false, restored: backup }
  }
}
