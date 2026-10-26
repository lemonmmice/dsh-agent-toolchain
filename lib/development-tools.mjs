import { join } from 'node:path'
import { homedir } from 'node:os'
import { envOr } from './env-fallback.mjs'
import { createDevelopmentRuntime } from '../plugins/dsh-build/development-runtime.mjs'

export function makeDevelopmentTools(options = {}) {
  const profileDir = options.profileDir || envOr('DSH_DEV_PROFILE_DIR') || envOr('DSH_PROFILE_DIR') || join(envOr('DSH_HOME') || join(homedir(), '.dsh'), 'profiles', 'web')
  let runtime
  let pending = 0
  let tail = Promise.resolve()
  let closed = false
  async function invoke(method, args = {}, context = {}) {
    if (closed) return { ok: false, errorCode: 'DEV_CLOSED', error: 'Development tools are closed' }
    if (pending >= 16) return { ok: false, errorCode: 'DEV_BUSY', error: 'Development tool queue is full', retryable: true }
    pending++
    const operation = tail.then(async () => {
      try {
        context.signal?.throwIfAborted()
        runtime ??= createDevelopmentRuntime({ profileDir, ...options })
        return { ok: true, ...await runtime[method](args, context.signal) }
      } catch (error) {
        return { ok: false, state: error.code === 'DEV_DEPENDENCY_MISSING' ? 'unconfigured' : 'failed', errorCode: error.code || 'DEV_FAILED', error: error.message }
      }
    })
    tail = operation.then(() => undefined)
    try { return await operation } finally { pending-- }
  }
  return {
    status: (args, context) => invoke('status', args, context),
    csharp: (args, context) => invoke('csharp', args, context),
    logs: (args, context) => invoke('logs', args, context),
    skills: (args, context) => invoke('skills', args, context),
    read: (args, context) => invoke('read', args, context),
    edit: (args, context) => invoke('edit', args, context),
    async close() {
      closed = true
      await tail
      await runtime?.close()
    },
  }
}
