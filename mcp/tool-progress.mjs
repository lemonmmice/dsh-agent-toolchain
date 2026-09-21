export function makeToolProgress({ intervalMs = 2000, now = () => performance.now() } = {}) {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 2000
  return {
    wrap(name, handler) {
      return async (args, extra) => {
        const token = extra?._meta?.progressToken
        if ((typeof token !== 'string' && typeof token !== 'number') || typeof extra?.sendNotification !== 'function') {
          return handler(args, extra)
        }
        const started = now()
        let progress = -1
        let sending = false
        let disconnected = false
        let pendingState = null
        const notify = (state) => {
          if (disconnected || extra.signal?.aborted) return
          if (sending) {
            if (state === 'completed' || state === 'failed') pendingState = state
            return
          }
          const elapsedMs = Math.max(0, Math.round(now() - started))
          progress = Math.max(progress + 1, elapsedMs)
          sending = true
          try {
            Promise.resolve(extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress, message: `${name}: ${state} (${elapsedMs} ms elapsed)` },
            })).then(() => {
              sending = false
              if (pendingState) {
                const terminalState = pendingState
                pendingState = null
                notify(terminalState)
              }
            }, () => { sending = false; disconnected = true; pendingState = null })
          } catch {
            sending = false
            disconnected = true
          }
        }
        notify('started')
        const timer = setInterval(() => notify('running'), interval)
        timer.unref?.()
        const stop = () => clearInterval(timer)
        extra.signal?.addEventListener('abort', stop, { once: true })
        try {
          const result = await handler(args, extra)
          notify(result?.isError === true ? 'failed' : 'completed')
          return result
        } catch (error) {
          notify('failed')
          throw error
        } finally {
          stop()
          extra.signal?.removeEventListener('abort', stop)
        }
      }
    },
  }
}
