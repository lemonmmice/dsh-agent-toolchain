/**
 * dsh-postman — host-side connection proxy.
 *
 * Bridges the browser to a host-opened WebSocket (with custom handshake
 * headers, which the browser WebSocket API cannot set) or a raw TCP/TLS
 * socket (which the browser cannot open at all). Host→browser events are
 * delivered by cursor-based long-poll (GET /conn/poll); browser→host sends
 * go through POST /conn/send. `ws` is resolved from the host install — no
 * new dependency, no dsh source changes.
 *
 * Event shape (per connection, monotonic `seq`):
 *   { seq, type:'open' }
 *   { seq, type:'message', binary, data, text?, truncated?, size? }
 *   { seq, type:'close', code, reason }
 *   { seq, type:'error', message }
 */

import net from 'node:net'
import tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

const MAX_CONNS = 32
const MAX_EVENTS = 3000 // ring buffer per connection
const MAX_MSG_BYTES = 256 * 1024 // per inbound frame kept/forwarded
const MAX_SEND_BYTES = 1024 * 1024 // per outbound send
const POLL_WAIT_MS = 20000 // long-poll hang
const IDLE_MS = 5 * 60 * 1000 // reap live-but-idle connections

function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Clamp an inbound buffer; returns { buf, truncated, size }. */
function capBuf(buf) {
  if (buf.length > MAX_MSG_BYTES) return { buf: buf.subarray(0, MAX_MSG_BYTES), truncated: true, size: buf.length }
  return { buf, truncated: false, size: buf.length }
}

export function createProxyManager() {
  const conns = new Map()

  function emit(c, type, extra) {
    c.seq += 1
    c.events.push({ seq: c.seq, type, ...(extra || {}) })
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS)
    c.lastActivity = Date.now()
    const waiters = c.waiters.splice(0)
    for (const w of waiters) w()
  }

  function newConn(kind) {
    if (conns.size >= MAX_CONNS) throw new Error(`too many connections (max ${MAX_CONNS})`)
    const c = { id: randomUUID(), kind, sock: null, ws: null, seq: 0, events: [], waiters: [], closed: false, lastActivity: Date.now() }
    conns.set(c.id, c)
    return c
  }

  /** Open a WebSocket with optional custom handshake headers / subprotocols. */
  function openWs(spec) {
    const c = newConn('ws')
    const url = String(spec.url || '')
    const opts = {}
    if (spec.headers !== null && typeof spec.headers === 'object') opts.headers = spec.headers
    let protocols
    if (Array.isArray(spec.subprotocols)) protocols = spec.subprotocols
    else if (typeof spec.subprotocols === 'string' && spec.subprotocols.trim() !== '') {
      protocols = spec.subprotocols
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    }
    let ws
    try {
      ws = protocols !== undefined ? new WebSocket(url, protocols, opts) : new WebSocket(url, opts)
    } catch (err) {
      emit(c, 'error', { message: errMsg(err) })
      emit(c, 'close', { code: 1006, reason: 'open failed' })
      c.closed = true
      return c
    }
    c.ws = ws
    ws.binaryType = 'nodebuffer'
    ws.on('open', () => emit(c, 'open', {}))
    ws.on('message', (data, isBinary) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const { buf, truncated, size } = capBuf(raw)
      const msg = isBinary ? { binary: true, data: buf.toString('base64') } : { binary: false, data: buf.toString('utf8') }
      if (truncated) {
        msg.truncated = true
        msg.size = size
      }
      emit(c, 'message', msg)
    })
    ws.on('close', (code, reason) => {
      c.closed = true
      emit(c, 'close', { code, reason: reason ? Buffer.from(reason).toString('utf8') : '' })
    })
    ws.on('error', (err) => emit(c, 'error', { message: errMsg(err) }))
    return c
  }

  /** Open a raw TCP (or TLS) socket. */
  function openTcp(spec) {
    const c = newConn('tcp')
    const host = String(spec.host || '')
    const port = Number(spec.port)
    if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      emit(c, 'error', { message: 'invalid host/port' })
      emit(c, 'close', { code: 1006, reason: 'bad target' })
      c.closed = true
      return c
    }
    const useTls = spec.tls === true
    const onConnect = () => emit(c, 'open', {})
    let sock
    try {
      sock = useTls
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: spec.rejectUnauthorized !== false }, onConnect)
        : net.connect({ host, port }, onConnect)
    } catch (err) {
      emit(c, 'error', { message: errMsg(err) })
      emit(c, 'close', { code: 1006, reason: 'open failed' })
      c.closed = true
      return c
    }
    c.sock = sock
    sock.setNoDelay(true)
    sock.on('data', (raw) => {
      const { buf, truncated, size } = capBuf(raw)
      const msg = { binary: true, data: buf.toString('base64'), text: buf.toString('utf8') }
      if (truncated) {
        msg.truncated = true
        msg.size = size
      }
      emit(c, 'message', msg)
    })
    sock.on('close', () => {
      c.closed = true
      emit(c, 'close', { code: 1000, reason: '' })
    })
    sock.on('error', (err) => emit(c, 'error', { message: errMsg(err) }))
    return c
  }

  function open(spec) {
    const s = spec || {}
    return s.kind === 'tcp' ? openTcp(s) : openWs(s)
  }

  function send(id, data, encoding) {
    const c = conns.get(id)
    if (c === undefined) throw new Error('no such connection')
    if (c.closed) throw new Error('connection closed')
    const payload = encoding === 'base64' ? Buffer.from(String(data || ''), 'base64') : String(data ?? '')
    const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
    if (size > MAX_SEND_BYTES) throw new Error(`payload too large (> ${MAX_SEND_BYTES} bytes)`)
    if (c.kind === 'ws') {
      if (c.ws === null || c.ws.readyState !== WebSocket.OPEN) throw new Error('ws not open')
      c.ws.send(payload)
    } else {
      if (c.sock === null || c.sock.destroyed) throw new Error('tcp not open')
      c.sock.write(payload)
    }
    c.lastActivity = Date.now()
    return { ok: true }
  }

  function closeConn(c, code, reason) {
    if (c === undefined) return
    try {
      if (c.kind === 'ws' && c.ws !== null) c.ws.close(code || 1000, reason || '')
      else if (c.sock !== null) c.sock.destroy()
    } catch {
      // ignore
    }
  }
  function close(id) {
    closeConn(conns.get(id), 1000, 'client closed')
    return { ok: true }
  }

  /** Long-poll: events with seq > cursor; waits up to POLL_WAIT_MS if none yet. */
  function poll(id, cursor) {
    return new Promise((resolve) => {
      const c = conns.get(id)
      if (c === undefined) {
        resolve({ notfound: true })
        return
      }
      const cur = Number(cursor) || 0
      const collect = () => c.events.filter((e) => e.seq > cur)
      const immediate = collect()
      if (immediate.length > 0 || c.closed) {
        resolve({ events: immediate, cursor: c.seq, closed: c.closed })
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ events: collect(), cursor: c.seq, closed: c.closed })
      }
      const timer = setTimeout(finish, POLL_WAIT_MS)
      if (timer.unref) timer.unref()
      c.waiters.push(finish)
    })
  }

  function status() {
    const list = []
    for (const [, c] of conns) list.push({ id: c.id, kind: c.kind, closed: c.closed, events: c.seq })
    return { count: conns.size, max: MAX_CONNS, conns: list }
  }

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const [id, c] of conns) {
      if (c.closed && now - c.lastActivity > 30000) conns.delete(id)
      else if (!c.closed && now - c.lastActivity > IDLE_MS) closeConn(c, 4000, 'idle timeout')
    }
  }, 30000)
  if (reaper.unref) reaper.unref()

  function dispose() {
    clearInterval(reaper)
    for (const [, c] of conns) closeConn(c, 1001, 'shutdown')
    conns.clear()
  }

  return { open, send, close, poll, status, dispose }
}
