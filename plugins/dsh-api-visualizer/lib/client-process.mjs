/**
 * 客户端进程归因：本插件接受的一条 TCP 连接，是本机哪个进程发起的？
 *
 * 原理：本机回环连接的两端在 TCP 表里各占一行。我们这边的 socket 是「本地 = 我们的监听地址，远端 = 客户端」，
 * 客户端那一行正好反过来 ——「本地 = 我们 socket 的远端，外部 = 我们 socket 的本地」，那一行的 PID 就是发起进程。
 * 整张表用 `netstat -ano -p TCP` 取（只解析数字形状的数据行：表头和状态列随系统语言本地化），
 * PID → 映像名用 `tasklist /FO CSV /NH`（输出是控制台代码页，用 decodeConsole 解，名字可以是中文）。
 *
 * 双栈（DualMode）socket 连 IPv4 地址时，Windows 把这条连接列在 **IPv4 表**里、地址是普通的 a.b.c.d（实测），
 * 所以 `::ffff:a.b.c.d` 一律按 a.b.c.d 查 IPv4 表；IPv6 表（-p TCPv6）只在真有 IPv6 端点待查时才跑。
 *
 * 代价控制（它紧挨着流量热路径）：
 *   · 一个去抖窗口（默认 15ms）内的全部查询共用**一次** netstat；任何时刻最多一个 netstat 在跑；
 *     两次 netstat 的启动至少相隔 minIntervalMs（默认 250ms）—— 新连接一直涌进来时最多每秒 4 次，不会把 CPU 耗在起进程上。
 *   · tasklist 只在出现**没见过的 PID**（或名字快照超过 pidTtlMs）时才跑，并发的需求合并成一次。
 *   · 结果（含"查过、确实不在表里"）按连接四元组缓存 10 分钟 / 最多 5000 条：同一条 keep-alive 连接上的后续请求直接命中。
 *   · netstat 起不来 / 5s 超时 / 输出认不出 ⇒ 这一批返回 null，之后 2s 内不再起 netstat（tasklist 同理）。
 * 永不抛错、永不让调用方等：lookup 返回的 Promise 只会 resolve（`{ pid, name }` 或 null）。只在 Windows 上工作，其它平台一律 null。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { decodeConsole } from '../../../lib/env-fallback.mjs'

/** 查询结果（含"确实找不到"）按连接四元组缓存这么久。 */
const CACHE_TTL_MS = 10 * 60 * 1000
/** 缓存条目上限（超出按最久未用淘汰），也是同时待查的上限。 */
const MAX_KEYS = 5000
/** netstat / tasklist 失败后的退避时长。 */
const FAILURE_BACKOFF_MS = 2000
/** 单次 netstat / tasklist 的超时。 */
const RUN_TIMEOUT_MS = 5000
/** 相邻两次 netstat 启动的最小间隔（连接持续涌入时限制起进程的频率）。 */
const MIN_RUN_INTERVAL_MS = 250
/** 输出上限：连接 / 进程很多的机器上 netstat 能有几 MB。 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const TIMED_OUT = Symbol('timed-out')

function messageOf(e) {
  return e instanceof Error ? e.message : String(e)
}

/** 合法的 IPv4 点分串 → 去掉前导零后的规范形式；不是 IPv4 返回 null。 */
function ipv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (m === null) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return null
  return parts.join('.')
}

/** IPv6 文本 → 8 组 4 位十六进制的全长形式；解析不了返回 null。末尾内嵌的 IPv4（::ffff:1.2.3.4）先换成两组。 */
function expandIpv6(s) {
  let text = s
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const four = ipv4(tail)
    if (four === null) return null
    const [a, b, c, d] = four.split('.').map(Number)
    text = text.slice(0, lastColon + 1) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  let groups = head
  if (halves.length === 2) {
    const rest = halves[1] === '' ? [] : halves[1].split(':')
    const fill = 8 - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...rest]
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => g.padStart(4, '0')).join(':')
}

/**
 * 地址规范化（我们的 socket 与 netstat 两边写法不同也要对得上）：小写、去方括号与 %zone、
 * IPv4 映射地址（::ffff:a.b.c.d 及其十六进制写法）≡ a.b.c.d、IPv6 展开成全长形式。
 */
export function normalizeAddress(addr) {
  let s = String(addr ?? '').trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (s === '') return ''
  const four = ipv4(s)
  if (four !== null) return four
  if (!s.includes(':')) return s
  const full = expandIpv6(s)
  if (full === null) return s
  if (full.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const hi = Number.parseInt(full.slice(30, 34), 16)
    const lo = Number.parseInt(full.slice(35, 39), 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return full
}

function validPort(p) {
  const n = typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : p
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 我们这边 socket 的四元组 → 缓存 / 匹配用的键（从我们的角度：本地|本地端口|远端|远端端口）。
 * 不完整返回 null；`v6` = 这条要查 IPv6 表。
 */
export function endpointKey(endpoints) {
  if (endpoints === null || typeof endpoints !== 'object') return null
  const la = normalizeAddress(endpoints.localAddress)
  const ra = normalizeAddress(endpoints.remoteAddress)
  const lp = validPort(endpoints.localPort)
  const rp = validPort(endpoints.remotePort)
  if (la === '' || ra === '' || lp === null || rp === null) return null
  return { key: `${la}|${lp}|${ra}|${rp}`, v6: la.includes(':') || ra.includes(':') }
}

/** netstat 的端点列：`1.2.3.4:80` / `[::1]:80` / `[fe80::1%12]:80`。端口 0（监听行的外部地址）返回 port 0。 */
function parseNetstatEndpoint(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:\s[\]]+):(\d+)$/.exec(s)
  if (m === null) return null
  const addr = normalizeAddress(m[1])
  const port = Number(m[2])
  if (addr === '' || !Number.isInteger(port) || port < 0 || port > 65535) return null
  return { addr, port }
}

/** 数据行：`TCP  本地  外部  状态  PID`。状态列可能被本地化（甚至含空格），只认首尾的数字形状。 */
const NETSTAT_ROW_RE = /^\s*TCP\s+(\S+)\s+(\S+)\s+(?:.*?\s+)?(\d+)\s*$/i

/**
 * 解析 `netstat -ano -p TCP|TCPv6` 的输出。表头是本地化的（中文系统上是 GBK 的"活动连接 / 协议 本地地址…"），
 * 只解析形状对得上的数据行。返回 `{ rows: Map<键, pid>, count }`：键按**发起方那一行**换算成"我们这边 socket"的视角
 * （我们的本地 = 这一行的外部地址，我们的远端 = 这一行的本地地址）；count = 认出的数据行总数（含监听行）。
 * 同一个键出现多次时以 PID 非 0 的为准（TIME_WAIT 行的 PID 是 0）。
 */
export function parseNetstat(text) {
  const rows = new Map()
  let count = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = NETSTAT_ROW_RE.exec(line)
    if (m === null) continue
    const local = parseNetstatEndpoint(m[1])
    const foreign = parseNetstatEndpoint(m[2])
    const pid = Number(m[3])
    if (local === null || foreign === null || !Number.isSafeInteger(pid)) continue
    count++
    if (local.port === 0 || foreign.port === 0) continue // 监听行：没有对端
    const key = `${foreign.addr}|${foreign.port}|${local.addr}|${local.port}`
    const prev = rows.get(key)
    if (prev === undefined || (prev === 0 && pid > 0)) rows.set(key, pid)
  }
  return { rows, count }
}

/** 一行 CSV（字段可带引号、引号内 "" 转义、名字里可以有逗号）。 */
function parseCsvLine(line) {
  const out = []
  let i = 0
  const n = line.length
  while (i <= n) {
    if (line[i] === '"') {
      let j = i + 1
      let s = ''
      while (j < n) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') { s += '"'; j += 2; continue }
          j++
          break
        }
        s += line[j++]
      }
      out.push(s)
      i = j
      while (i < n && line[i] !== ',') i++
      i++
    } else {
      let j = line.indexOf(',', i)
      if (j < 0) j = n
      out.push(line.slice(i, j))
      i = j + 1
    }
  }
  return out
}

/** 映像名去掉 .exe（大小写不敏感）。 */
function imageName(raw) {
  return String(raw ?? '').trim().replace(/\.exe$/i, '')
}

/** 解析 `tasklist /FO CSV /NH`：`"映像名","PID","会话名","会话#","内存"`。返回 Map<pid, 名字（不含 .exe）>。 */
export function parseTasklist(text) {
  const out = new Map()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line.startsWith('"')) continue
    const f = parseCsvLine(line)
    if (f.length < 2) continue
    const pidText = String(f[1]).trim()
    if (!/^\d+$/.test(pidText)) continue
    const pid = Number(pidText)
    const name = imageName(f[0])
    if (Number.isSafeInteger(pid) && name !== '') out.set(pid, name)
  }
  return out
}

/**
 * 系统目录下的可执行文件（不走 PATH 搜索，免得被同名程序顶替）；拿不到系统目录、或那里没有这个文件
 * （SystemRoot 被改写过之类）时退回裸名 —— 否则归因会一直失败、悄无声息。
 */
function systemExe(name) {
  const root = process.env.SystemRoot || process.env.windir || ''
  if (root === '') return name
  const full = path.win32.join(root, 'System32', name)
  try {
    return fs.existsSync(full) ? full : name
  } catch {
    return name
  }
}

/** 默认执行器：execFile（不弹窗口、5s 超时、原始 Buffer —— 解码交给调用方）。永不 reject。 */
function defaultRunner(timeoutMs) {
  return (file, args) => new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          ...(error ? { error: error.killed ? `超时（${timeoutMs}ms）被终止` : messageOf(error) } : {}),
        })
      })
    } catch (e) {
      resolve({ stdout: Buffer.alloc(0), code: -1, error: messageOf(e) })
    }
  })
}

function stdoutText(stdout, decode) {
  if (typeof stdout === 'string') return stdout
  if (Buffer.isBuffer(stdout)) return decode(stdout)
  if (stdout instanceof Uint8Array) return decode(Buffer.from(stdout))
  return ''
}

/**
 * 进程解析器。
 *   lookup(endpoints[, { fresh }]) → Promise<{ pid, name } | null>   永不 reject；`fresh:true` = 新接受的连接（丢掉同一四元组的旧缓存）
 *   peek(endpoints) → { pid, name } | null | undefined                 只看缓存：undefined = 还不知道（没查过 / 正在查）
 *   stats() → { ok, miss, missClosed, errors, pending, cacheHits, cached, netstatRuns, tasklistRuns, supported, lastError, backoffUntil, namesBackoffUntil }
 *     lookup 得到 null 之后 peek 也是 null ⇒ 确实不在表里（连接已关），peek 是 undefined ⇒ 查询失败（没缓存）。
 * endpoints = 我们接受的那条 socket 的 { localAddress, localPort, remoteAddress, remotePort }。
 * `run(file, args) → Promise<{ stdout: Buffer|string, code }>` 可注入（测试）；默认 execFile。
 */
export function createProcessResolver({
  run = null, debounceMs = 15, pidTtlMs = 60000, now = Date.now,
  platform = process.platform, cacheTtlMs = CACHE_TTL_MS, maxKeys = MAX_KEYS, backoffMs = FAILURE_BACKOFF_MS, timeoutMs = RUN_TIMEOUT_MS,
  minIntervalMs = MIN_RUN_INTERVAL_MS,
} = {}) {
  const exec = typeof run === 'function' ? run : defaultRunner(timeoutMs)
  const supported = platform === 'win32'
  const NETSTAT = systemExe('netstat.exe')
  const TASKLIST = systemExe('tasklist.exe')
  /** 缓存 / 名字快照的有效期按 `now`（可注入，测试用来快进）。 */
  const t = () => {
    try {
      const v = Number(now())
      return Number.isFinite(v) ? v : Date.now()
    } catch {
      return Date.now()
    }
  }
  /** 调度（去抖、最小间隔、退避）与先后顺序用单调时钟：和真实的定时器同一把尺子，注入的 now 停住也不会空转。 */
  const mono = () => performance.now()

  const cache = new Map() // key -> { value: {pid,name}|null, at, ttl }（Map 插入序 = 最久未用在前）
  const pending = new Map() // key -> { key, v6, since, pid, resolve, promise }
  let timer = null
  let inflight = false
  let backoffUntil = Number.NEGATIVE_INFINITY // netstat 失败后的退避截止（单调时钟）
  let lastRunAt = Number.NEGATIVE_INFINITY // 上一次 netstat 开始的时刻（单调时钟）
  let names = new Map() // pid -> 名字
  let namesAt = Number.NEGATIVE_INFINITY // 名字快照**开始**抓取的时刻（单调时钟，比先后用）
  let namesClockAt = Number.NEGATIVE_INFINITY // 同一时刻按 now（算有效期用）
  let namesRun = null // { startedAt, clockAt, promise }
  let namesFailedUntil = Number.NEGATIVE_INFINITY // tasklist 失败后的退避截止（单调时钟）
  let lastError = null
  // missClosed：查的时候连接已经不在 TCP 表里（短连接在下一次 netstat 之前就关了）—— miss 里的这一部分，单独计数好让界面说明
  const counters = { ok: 0, miss: 0, missClosed: 0, errors: 0, cacheHits: 0, netstatRuns: 0, tasklistRuns: 0 }

  function cacheGet(key) {
    const e = cache.get(key)
    if (e === undefined) return undefined
    if (t() - e.at > e.ttl) {
      cache.delete(key)
      return undefined
    }
    // 当初 tasklist 失败只拿到了 PID：之后哪份名字快照里有它就补上（不必等这条缓存过期）
    if (e.value !== null && e.value.name === '' && e.value.pid !== 0 && e.value.pid !== 4 && names.has(e.value.pid)) {
      e.value = Object.freeze({ pid: e.value.pid, name: names.get(e.value.pid) })
      e.ttl = cacheTtlMs
    }
    cache.delete(key) // 挪到最新
    cache.set(key, e)
    return e.value
  }

  function remember(key, value, ttl = cacheTtlMs) {
    cache.delete(key)
    cache.set(key, { value, at: t(), ttl })
    while (cache.size > maxKeys) cache.delete(cache.keys().next().value)
  }

  function settle(e, value, kind, ttl = cacheTtlMs) {
    if (pending.get(e.key) === e) pending.delete(e.key)
    if (kind === 'ok') {
      counters.ok++
      remember(e.key, value, ttl)
    } else if (kind === 'miss') {
      counters.miss++
      remember(e.key, null)
    } else {
      counters.errors++ // 查询失败不缓存：下一次请求还会再查
    }
    try { e.resolve(value) } catch { /* 调用方的问题不影响别人 */ }
  }

  /** 还在等 netstat 的条目（已经查到 PID、只差名字的不算）。 */
  function waitingForTable() {
    const out = []
    for (const e of pending.values()) if (e.pid === undefined) out.push(e)
    return out
  }

  function schedule() {
    if (timer !== null || inflight) return
    if (waitingForTable().length === 0) return
    const m = mono()
    const delay = Math.max(debounceMs, backoffUntil - m, lastRunAt + minIntervalMs - m, 0)
    timer = setTimeout(() => {
      timer = null
      runOnce().catch(() => {})
    }, Math.ceil(delay))
  }

  /** 跑一次外部程序：超时兜底（注入的 run 不返回也不会卡住）、永不抛。 */
  async function safeRun(file, args) {
    const base = path.win32.basename(String(file))
    let guard = null
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => exec(file, args)),
        new Promise((resolve) => { guard = setTimeout(() => resolve(TIMED_OUT), timeoutMs + 1000) }),
      ])
      if (r === TIMED_OUT) return { ok: false, error: `${base} 超过 ${timeoutMs}ms 没有返回` }
      if (r === null || typeof r !== 'object') return { ok: false, error: `${base} 没有返回结果` }
      const code = r.code === undefined || r.code === null ? 0 : Number(r.code)
      if (code !== 0) return { ok: false, error: `${base} 退出码 ${String(r.code)}` + (r.error ? `：${String(r.error).slice(0, 200)}` : '') }
      return { ok: true, stdout: r.stdout }
    } catch (e) {
      return { ok: false, error: `${base} 运行失败：${messageOf(e).slice(0, 200)}` }
    } finally {
      if (guard !== null) clearTimeout(guard)
    }
  }

  /** 一张 TCP 表。IPv4 表一行都认不出 = 输出不对（至少有我们自己的监听行），算失败。 */
  async function netstat(args, requireRows) {
    counters.netstatRuns++
    const r = await safeRun(NETSTAT, args)
    if (!r.ok) return { error: r.error, rows: null }
    // 数据行全是 ASCII：按 latin1 取就够了（本地化的表头 / 状态列不需要解对）
    const parsed = parseNetstat(stdoutText(r.stdout, (b) => b.toString('latin1')))
    if (requireRows && parsed.count === 0) return { error: 'netstat 输出里没有可识别的连接行', rows: null }
    return { error: null, rows: parsed.rows }
  }

  /** 名字快照能不能直接用（不用为这个 PID 再跑 tasklist）。netstatAt = 看到这个 PID 的那次 netstat 的开始时刻（单调时钟）。 */
  function nameUsable(pid, netstatAt) {
    if (pid === 0 || pid === 4) return true
    if (namesFailedUntil > mono()) return true // tasklist 刚失败过：退避期内不再起，用手上有的（可能为空）
    if (t() - namesClockAt >= pidTtlMs) return false
    if (names.has(pid)) return true
    // 快照比看到这个 PID 的那次 netstat 还新、里面却没有它 ⇒ 进程已经退出，再跑也没用
    return namesAt >= netstatAt
  }

  function nameOf(pid) {
    if (pid === 0) return 'Idle'
    if (pid === 4) return 'System'
    return names.get(pid) ?? ''
  }

  /** 刷新 PID → 名字（合并并发需求）：等到一份**不早于 minStart** 开始抓取的快照（或失败）为止。 */
  function refreshNames(minStart) {
    if (namesFailedUntil > mono()) return Promise.resolve()
    if (namesRun !== null) {
      if (namesRun.startedAt >= minStart) return namesRun.promise
      return namesRun.promise.then(() => refreshNames(minStart))
    }
    const holder = { startedAt: mono(), clockAt: t(), promise: null }
    namesRun = holder
    holder.promise = (async () => {
      counters.tasklistRuns++
      const r = await safeRun(TASKLIST, ['/FO', 'CSV', '/NH'])
      const map = r.ok ? parseTasklist(stdoutText(r.stdout, decodeConsole)) : null
      if (map === null || map.size === 0) {
        namesFailedUntil = mono() + backoffMs
        lastError = r.ok ? 'tasklist 输出里没有可识别的进程行' : r.error
        return
      }
      names = map
      namesAt = holder.startedAt
      namesClockAt = holder.clockAt
    })().catch(() => {}).finally(() => {
      if (namesRun === holder) namesRun = null
    })
    return holder.promise
  }

  async function nameAndSettle(found, netstatAt) {
    try {
      if (found.some((e) => !nameUsable(e.pid, netstatAt))) await refreshNames(netstatAt)
    } catch {
      // 名字拿不到就只给 PID
    }
    for (const e of found) {
      if (pending.get(e.key) !== e) continue
      const name = nameOf(e.pid)
      // 名字是空的，原因是 tasklist 刚失败（退避中）⇒ 这份只有 PID 的答案只缓存到退避结束，之后的查询会再取名字
      const left = name === '' && e.pid !== 0 && e.pid !== 4 ? namesFailedUntil - mono() : 0
      settle(e, Object.freeze({ pid: e.pid, name }), 'ok', left > 0 ? Math.ceil(left) : cacheTtlMs)
    }
  }

  /**
   * 一轮：一次 netstat（有 IPv6 待查时再加一次 -p TCPv6）解决所有待查条目。
   *   · 在表里、PID 非 0 ⇒ 去取名字（不占着 netstat：下一轮可以同时开始）；
   *   · 不在表里且登记早于这轮开始 ⇒ 确实找不到（连接已经关了 / 只剩 PID 为 0 的 TIME_WAIT 行），记 miss 并缓存；
   *   · 这轮开始之后才登记、又不在表里 ⇒ 这张表可能早于那条连接，留给下一轮。
   * 失败 ⇒ 这轮覆盖的条目全部 null（不缓存），退避 backoffMs。
   */
  async function runOnce() {
    if (inflight) return
    const batch = waitingForTable()
    if (batch.length === 0) return
    const m = mono()
    if (backoffUntil > m || lastRunAt + minIntervalMs > m) {
      schedule()
      return
    }
    inflight = true
    const startedAt = m
    lastRunAt = startedAt
    const found = []
    try {
      const table = new Map()
      let failure = null
      if (batch.some((e) => !e.v6)) {
        const r = await netstat(['-ano', '-p', 'TCP'], true)
        if (r.error !== null) failure = r.error
        else for (const [k, v] of r.rows) table.set(k, v)
      }
      if (failure === null && batch.some((e) => e.v6)) {
        const r = await netstat(['-ano', '-p', 'TCPv6'], false)
        if (r.error !== null) failure = r.error
        else for (const [k, v] of r.rows) if (!table.has(k) || (table.get(k) === 0 && v > 0)) table.set(k, v)
      }
      if (failure !== null) {
        backoffUntil = mono() + backoffMs
        lastError = failure
        for (const e of batch) if (pending.get(e.key) === e && e.pid === undefined) settle(e, null, 'error')
      } else {
        for (const e of [...pending.values()]) {
          if (e.pid !== undefined) continue
          const pid = table.get(e.key)
          if (pid !== undefined && pid > 0) {
            e.pid = pid
            found.push(e)
          } else if (e.since <= startedAt) {
            counters.missClosed++
            settle(e, null, 'miss')
          }
        }
      }
    } catch (e) {
      backoffUntil = mono() + backoffMs
      lastError = messageOf(e)
      for (const x of batch) if (pending.get(x.key) === x && x.pid === undefined) settle(x, null, 'error')
    } finally {
      inflight = false
      schedule()
    }
    if (found.length > 0) await nameAndSettle(found, startedAt)
  }

  function lookup(endpoints, { fresh = false } = {}) {
    try {
      if (!supported) return Promise.resolve(null)
      const k = endpointKey(endpoints)
      if (k === null) {
        counters.miss++
        return Promise.resolve(null)
      }
      if (fresh === true) {
        // 新接受的连接：同一四元组的旧结果属于已经关掉的那条连接
        cache.delete(k.key)
      } else {
        const hit = cacheGet(k.key)
        if (hit !== undefined) {
          counters.cacheHits++
          return Promise.resolve(hit)
        }
      }
      const cur = pending.get(k.key)
      if (cur !== undefined) {
        if (fresh === true && cur.pid === undefined) cur.since = mono() // 必须由这之后开始的一轮来判定"找不到"
        return cur.promise
      }
      if (pending.size >= maxKeys) {
        counters.errors++
        return Promise.resolve(null)
      }
      let resolve
      const promise = new Promise((r) => { resolve = r })
      pending.set(k.key, { key: k.key, v6: k.v6, since: mono(), pid: undefined, resolve, promise })
      schedule()
      return promise
    } catch {
      return Promise.resolve(null)
    }
  }

  function peek(endpoints) {
    try {
      if (!supported) return null
      const k = endpointKey(endpoints)
      if (k === null) return null
      const hit = cacheGet(k.key)
      if (hit !== undefined) counters.cacheHits++
      return hit
    } catch {
      return undefined
    }
  }

  function stats() {
    const left = backoffUntil - mono()
    const namesLeft = namesFailedUntil - mono()
    return {
      ok: counters.ok,
      miss: counters.miss,
      missClosed: counters.missClosed,
      errors: counters.errors,
      pending: pending.size,
      cacheHits: counters.cacheHits,
      cached: cache.size,
      netstatRuns: counters.netstatRuns,
      tasklistRuns: counters.tasklistRuns,
      supported,
      lastError,
      // 退避截止（epoch ms）；不在退避期为 null
      backoffUntil: left > 0 ? Date.now() + Math.ceil(left) : null,
      // tasklist 失败后的退避截止（epoch ms；退避期内的答案只有 PID、没有名字）；不在退避期为 null
      namesBackoffUntil: namesLeft > 0 ? Date.now() + Math.ceil(namesLeft) : null,
    }
  }

  return { lookup, peek, stats }
}
