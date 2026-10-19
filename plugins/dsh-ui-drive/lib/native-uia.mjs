import { spawn } from 'node:child_process'
import { nativeExecutable } from '../../../lib/native-runtime.mjs'
import { envOr } from '../../../lib/env-fallback.mjs'
import { taskSignal } from '../../../lib/task-context.mjs'
import { loadControlPolicy } from './control-policy.mjs'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const EFFECT_ACTIONS = new Set(['click', 'setvalue', 'doubleclick', 'scroll'])
const READ_ACTIONS = new Set(['state', 'state-live', 'read', 'find', 'windows'])

export function supportsNativeUia(args) {
  if (envOr('DSH_UI_BACKEND') !== 'rust') return false
  if (![...READ_ACTIONS, ...EFFECT_ACTIONS].includes(args.action)) return false
  if (EFFECT_ACTIONS.has(args.action) && (envOr('DSH_UI_DENY_RE') || envOr('DSH_UI_ALLOW_LOCKED') || loadControlPolicy().state !== 'unconfigured')) return false
  if (['match', 'inAid', 'inName', 'waitFor', 'targetRef', 'expectedRect', 'expectedWindowHandle', 'mods', 'keys'].some(key => args[key] != null && args[key] !== '' && args[key] !== false)) return false
  if (typeof args.value === 'string' && args.value.includes('${cred:')) return false
  return !args.visualFallback && !args.ascii && !args.focus && !args.double && !args.button
}

function isEffect(args) {
  return EFFECT_ACTIONS.has(args.action)
}

function terminate(child) {
  if (!child || child.killed) return
  try { child.kill() } catch { /* process may already have exited */ }
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* best effort */ }
  }
}

export function createNativeUiaSession() {
  let child = null
  let closed = false
  let sequence = 0
  let buffer = Buffer.alloc(0)
  let queue = Promise.resolve()
  const pending = new Map()

  function failPending(error) {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  function stop(reason) {
    const current = child
    child = null
    buffer = Buffer.alloc(0)
    if (current) {
      failPending(Object.assign(new Error('Rust UIA worker stopped' + (reason ? ': ' + reason : '')), { unknown: true }))
      terminate(current)
    }
  }

  function start() {
    if (closed) throw new Error('Rust UIA session is closed')
    if (child && !child.killed) return child
    const executable = nativeExecutable()
    const current = spawn(executable, ['--uia-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child = current
    current.stdout.on('data', chunk => {
      if (child !== current) return
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      if (buffer.length > MAX_OUTPUT_BYTES) {
        stop('output exceeded 8 MiB')
        return
      }
      let newline
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        buffer = buffer.subarray(newline + 1)
        if (!line.trim()) continue
        let response
        try { response = JSON.parse(line) } catch {
          stop('invalid response')
          return
        }
        const entry = pending.get(response.id)
        if (!entry) continue
        pending.delete(response.id)
        if (response.error) entry.reject(new Error(String(response.error.message || response.error)))
        else entry.resolve(response.result)
      }
    })
    current.stderr.on('data', () => {})
    current.on('error', error => {
      if (child === current) {
        child = null
        failPending(error)
      }
    })
    current.on('close', () => {
      if (child === current) {
        child = null
        failPending(Object.assign(new Error('Rust UIA worker exited'), { unknown: true }))
      }
    })
    return current
  }

  function requestOne(args) {
    const signal = taskSignal()
    if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, notExecuted: true, error: 'UIA request cancelled before dispatch' })
    const timeoutMs = Math.max(1, Math.min(Number(args.timeoutMs) || 15000, 90000))
    const id = ++sequence
    let current
    try { current = start() } catch (error) { return Promise.reject(error) }
    return new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        pending.delete(id)
        resolve(result)
      }
      const cancel = () => {
        finish({ ok: false, cancelled: true, unknown: isEffect(args), error: 'UIA request cancelled; no action was replayed' })
        stop('request cancelled')
      }
      const timer = setTimeout(() => {
        finish({ ok: false, timeout: true, unknown: isEffect(args), error: 'UIA worker timed out; no action was replayed' })
        stop('request timeout')
      }, timeoutMs)
      pending.set(id, { resolve: finish, reject: error => finish({ ok: false, notExecuted: !isEffect(args), unknown: isEffect(args), error: error.message }) })
      signal?.addEventListener('abort', cancel, { once: true })
      try { current.stdin.write(JSON.stringify({ id, args }) + '\n') }
      catch (error) { finish({ ok: false, unknown: isEffect(args), error: error.message }); stop('stdin write failed') }
    })
  }

  function request(args) {
    const operation = queue.then(() => requestOne(args))
    queue = operation.catch(() => {})
    return operation
  }

  return {
    request,
    close() { closed = true; stop('closed') },
    restart() { closed = false; stop('restarted') },
    status() { return { alive: Boolean(child && !child.killed), queued: pending.size } },
  }
}

export async function runNativeUia(args, { session } = {}) {
  const own = !session
  const active = session || createNativeUiaSession()
  try {
    const result = await active.request(args)
    return { ...result, backend: 'rust' }
  } catch (error) {
    return { ok: false, notExecuted: !isEffect(args), unknown: isEffect(args), error: error.message, backend: 'rust' }
  } finally {
    if (own) active.close()
  }
}
