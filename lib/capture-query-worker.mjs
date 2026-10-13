import { parentPort, workerData } from 'node:worker_threads'
import { queryPage, getCaptureStorage, readRetention } from './capture-store.mjs'

process.env.DSH_API_CAPTURE_STORE = workerData.directory
parentPort.on('message', message => {
  try {
    const storage = getCaptureStorage()
    const records = storage.candidateRecords(message.filter)
    const revision = storage.revision
    const summary = storage.summary()
    const page = queryPage(message.filter, records, true, { maxLimit: message.maxLimit, legacyCursor: message.legacyCursor })
    const retention = readRetention(summary)
    if (storage.revision !== revision || !storage.native.isFresh()) throw Object.assign(new Error('Capture store changed during query'), { code: 'CAPTURE_STORE_CHANGED', incomplete: true })
    parentPort.postMessage({ id: message.id, value: { page, summary, retention, complete: true, scannedRecords: records.length } })
  } catch (error) { parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code, incomplete: true } }) }
})
