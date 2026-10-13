import { resolve } from 'node:path'
import { createWorkerService } from './worker-service.mjs'
import { storeDir } from './capture-store.mjs'

let service = null
let selectedDirectory = null
export async function queryCaptureAsync(filter = {}, directory = storeDir(), { maxLimit = 500, legacyCursor = false } = {}) {
  directory = resolve(directory)
  if (directory !== selectedDirectory) {
    service?.close()
    service = createWorkerService(new URL('./capture-query-worker.mjs', import.meta.url), { workerData: { directory } })
    selectedDirectory = directory
  }
  const { value, timing } = await service.call({ maxLimit, legacyCursor, filter: {
    q: filter.q, method: filter.method, source: filter.source, status: filter.status,
    flag: filter.flag, host: filter.host, contentType: filter.contentType,
    minDurationMs: filter.minDurationMs, minBytes: filter.minBytes, maxBytes: filter.maxBytes,
    fromTs: filter.fromTs, toTs: filter.toTs, sessionId: filter.sessionId,
    traceId: filter.traceId, runId: filter.runId, errors: filter.errors,
    noNoise: filter.noNoise, bodyQ: filter.bodyQ, caller: filter.caller,
    limit: filter.limit, offset: filter.offset, includeBody: filter.includeBody, cursor: filter.cursor, regex: filter.regex,
  } })
  return { ...value, timing }
}
export function closeCaptureQueries() { service?.close(); service = null; selectedDirectory = null }
