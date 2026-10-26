import { join } from 'node:path'
import { homedir } from 'node:os'
import { envOr } from './env-fallback.mjs'
import { createRecommendedRuntime } from '../plugins/dsh-build/recommended-runtime.mjs'

export function makeRecommendedTools(options = {}) {
  const profileDir = options.profileDir || envOr('DSH_DEV_PROFILE_DIR') || envOr('DSH_PROFILE_DIR') || join(envOr('DSH_HOME') || join(homedir(), '.dsh'), 'profiles', 'web')
  let runtime
  async function call(method, args, context) {
    try {
      context?.signal?.throwIfAborted()
      runtime ??= createRecommendedRuntime({ ...options, profileDir })
      return { ok: true, ...await runtime[method](args, context?.signal) }
    } catch (error) {
      return { ok: false, errorCode: error.code || 'DEV_ADDON_FAILED', error: error.message }
    }
  }
  return {
    docsSearch: (args, context) => call('docsSearch', args, context),
    docsRead: (args, context) => call('docsRead', args, context),
    vision: (args, context) => call('vision', args, context),
    precheck: (args, context) => call('precheck', args, context),
    close: async () => runtime?.close(),
  }
}
