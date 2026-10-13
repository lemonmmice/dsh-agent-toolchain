import { parentPort, workerData } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { stat, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { KvMemory } from './kv.mjs'
import { VectorStore } from './store.mjs'

const kv = new KvMemory(join(workerData.dataDir, 'kv'))
const vectors = new VectorStore(join(workerData.dataDir, 'vectors'), workerData.project)
let cachedMetadata = null
async function identity(file) {
  try {
    const value = await stat(file, { bigint: true })
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function vectorMetadata() {
  const before = await identity(vectors.file)
  if (before === null) return { count: 0, cacheHit: false, source: 'missing', bytesRead: 0 }
  const metadataPath = vectors.file + '.metadata.json'
  if (!cachedMetadata) {
    try { cachedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  if (cachedMetadata?.version === 1 && cachedMetadata.identity === before && Number.isSafeInteger(cachedMetadata.count) && cachedMetadata.count >= 0) {
    return { count: cachedMetadata.count, cacheHit: true, source: 'metadata', bytesRead: 0 }
  }
  const rows = new Set()
  const input = createReadStream(vectors.file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      if (typeof row.id !== 'string') throw new TypeError('Memory row id must be a string')
      rows.add(row.id)
    }
  } finally { lines.close(); input.destroy() }
  if (before !== await identity(vectors.file)) throw Object.assign(new Error('Vector index changed during metadata scan'), { code: 'MEMORY_STORE_CHANGED', incomplete: true })
  cachedMetadata = { version: 1, identity: before, count: rows.size }
  const temporary = metadataPath + '.' + randomUUID() + '.tmp'
  let metadataWriteError = null
  try { await writeFile(temporary, JSON.stringify(cachedMetadata)); await rename(temporary, metadataPath) }
  catch (error) {
    metadataWriteError = error.code || error.message
    try { await unlink(temporary) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') metadataWriteError += '; ' + cleanupError.message }
  }
  return { count: rows.size, cacheHit: false, source: 'scan', bytesRead: input.bytesRead, metadataWriteError }
}
parentPort.on('message', async message => {
  try {
    let value
    if (message.action === 'status') {
      const metadata = await vectorMetadata()
      value = { ...kv.stats(), chunks: metadata.count, vectorMetadata: metadata }
    } else if (message.action === 'recall') {
      const row = kv.get(message.key, message.scope)
      value = row ? { ...row, expired: Boolean(row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) } : null
    } else if (message.action === 'search') {
      value = vectors.search(message.vector, message.limit).map(({ vector, ...row }) => row)
    } else throw new Error('Unknown memory read operation')
    parentPort.postMessage({ id: message.id, value })
  } catch (error) { parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code, incomplete: true } }) }
})
