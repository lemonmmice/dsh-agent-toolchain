import { spawn } from 'node:child_process'

export function runVerificationProcess(command, args = [], { cwd, shell = false, timeoutMs = 30000, signal, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', aborted: true })
      return
    }
    let child
    let settled = false
    let timer
    let stdout = ''
    let stderr = ''
    let bytes = 0
    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ code: null, stdout, stderr, ...extra })
    }
    const stop = (extra) => {
      if (settled) return
      if (child?.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => child.kill())
          killer.unref()
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') }
        }
      }
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      child?.unref()
      finish(extra)
    }
    const abort = () => stop({ aborted: true })
    try {
      child = spawn(command, args, { cwd, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ error: error.message })
      return
    }
    const collect = (stream, chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) { stop({ outputLimitExceeded: true }); return }
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))
    child.on('error', (error) => finish({ error: error.message }))
    child.on('close', (code) => finish({ code }))
    const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 600000) : 30000
    timer = setTimeout(() => stop({ timedOut: true }), limit)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
