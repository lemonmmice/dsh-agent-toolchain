import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { envOr, envWithPrefix } from './env-fallback.mjs'

let connection

export function nativeEnabled(domain) {
  if (domain === 'task' && process.env.DSH_RUNTIME_BRIDGE === '1') return false
  return (envOr('DSH_' + domain.toUpperCase() + '_BACKEND') || envOr('DSH_RUNTIME_BACKEND')) === 'rust'
}

export function nativeExecutable() {
  const executable = envOr('DSH_RUNTIME_EXE') || fileURLToPath(new URL(
    `../mcp/bin/${process.platform}-${process.arch}/dsh-toolchain${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
  if (!existsSync(executable)) throw new Error('Rust runtime is missing. Run npm run build:runtime or set DSH_RUNTIME_EXE.')
  return executable
}

function connect() {
  const executable = nativeExecutable()
  const legacy = envOr('DSH_LEGACY_MCP_SERVER') || fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
  const argumentsList = ['--adapter']
  if (existsSync(legacy) && process.env.DSH_RUNTIME_BRIDGE !== '1') argumentsList.push('--legacy-server', legacy)
  const child = spawn(executable, argumentsList, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...envWithPrefix('DSH_'), DSH_ENV_FILE: 'none', DSH_NODE_EXE: process.execPath } })
  const pending = new Map()
  let sequence = 0
  let closed = false
  const streams = [child, child.stdin, child.stdout, child.stderr]
  const keepAlive = active => { for (const stream of streams) stream[active ? 'ref' : 'unref']?.() }
  const fail = error => {
    if (closed) return
    closed = true
    for (const entry of pending.values()) entry.reject(Object.assign(new Error(error.message), { unknown: true }))
    pending.clear()
    if (connection?.child === child) connection = undefined
    keepAlive(false)
  }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let response
    try { response = JSON.parse(line) } catch { fail(new Error('Invalid Rust runtime response')); child.kill(); return }
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.error) entry.reject(new Error(response.error.message || 'Rust runtime request failed'))
    else entry.resolve(response.result)
    if (!pending.size) keepAlive(false)
  })
  child.stderr.on('data', () => {})
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.on('exit', () => fail(new Error('Rust runtime disconnected; no request was replayed')))
  keepAlive(false)
  return { child, close: () => {
    fail(new Error('Rust runtime closed'))
    child.stdin.end()
    const shutdown = setTimeout(() => child.kill(), 2000)
    shutdown.unref()
    child.once('exit', () => { clearTimeout(shutdown); lines.close() })
  },
    request(method, parameters, { signal, timeoutMs = 180000 } = {}) {
      if (closed) return Promise.reject(new Error('Rust runtime is closed'))
      if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request cancelled before dispatch'), { cancelled: true, notExecuted: true }))
      const id = ++sequence
      keepAlive(true)
      return new Promise((resolve, reject) => {
        const cancel = () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) + '\n')
        const timer = setTimeout(() => {
          cancel()
          pending.delete(id)
          finish(reject, Object.assign(new Error('Rust runtime response timed out; completion is unknown'), { unknown: true }))
          if (!pending.size) keepAlive(false)
        }, timeoutMs)
        const finish = (settle, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); settle(value) }
        pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) })
        signal?.addEventListener('abort', cancel, { once: true })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: parameters }) + '\n', error => { if (error) fail(error) })
      })
    } }
}

export function nativeCall(method, parameters, options) {
  if (!connection) connection = connect()
  return connection.request(method, parameters, options)
}

export function unwrapNativeResult(result) {
  const block = result?.content?.find(entry => entry.type === 'text')
  if (!block) throw new Error('Rust tool response has no JSON content')
  return JSON.parse(block.text)
}

export function closeNativeRuntime() {
  connection?.close()
  connection = undefined
}
