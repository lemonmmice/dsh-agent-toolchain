import { spawn } from 'node:child_process'
import { taskSignal } from './task-context.mjs'

export function attachProcessCancellation(child, signal = taskSignal()) {
  if (!signal) return () => {}
  const abort = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
      killer.unref()
    } else child.kill('SIGKILL')
  }
  const cleanup = () => signal.removeEventListener('abort', abort)
  child.once('close', cleanup)
  child.once('error', cleanup)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return cleanup
}

export function checkTaskCancellation() { taskSignal()?.throwIfAborted() }
