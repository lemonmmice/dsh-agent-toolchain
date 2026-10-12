export function createCaptureStatusCache({ fetchStatus, now = Date.now, maxAgeMs = 2000 }) {
  let value = null
  let observedAt = null
  let checkedAt = null
  let pending = null
  let error = null
  let generation = 0
  const snapshot = () => ({
    value: structuredClone(value),
    observedAt,
    ageMs: observedAt === null ? null : now() - observedAt,
    refreshing: pending !== null,
    source: observedAt === null ? 'unknown' : 'host-cache',
    error,
  })
  function refresh() {
    if (pending) {
      if (pending.generation === generation) return pending.promise
      return pending.promise.then(() => refresh())
    }
    const requestGeneration = generation
    const requestStartedAt = now()
    const promise = Promise.resolve().then(fetchStatus).then(result => {
      if (!result || typeof result.running !== 'boolean') throw new Error('invalid capture status response')
      if (requestGeneration === generation) {
        value = structuredClone(result)
        observedAt = requestStartedAt
        error = null
      }
    }).catch(failure => {
      if (requestGeneration === generation) {
        value = null
        observedAt = null
        error = 'capture status unavailable'
      }
    }).finally(() => {
      if (requestGeneration === generation) checkedAt = now()
      pending = null
    })
    pending = { generation: requestGeneration, promise }
    return promise
  }
  return {
    async get({ fresh = false } = {}) {
      if (fresh) await refresh()
      else if (checkedAt === null || now() - checkedAt >= maxAgeMs) refresh()
      return snapshot()
    },
    invalidate() { generation++; checkedAt = null; value = null; observedAt = null; error = null },
  }
}
