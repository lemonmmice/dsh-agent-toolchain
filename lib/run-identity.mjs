import { createHash, randomUUID } from 'node:crypto'

export function sanitizeRunId(runId) {
  const normalized = String(runId ?? '').replace(/[^\w.-]+/g, '_')
  return normalized.length <= 80 ? normalized : normalized.slice(0, 63) + '-' + createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function newRunId(prefix = 'auto') {
  return prefix + '-' + randomUUID()
}
