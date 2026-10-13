import { parentPort } from 'node:worker_threads'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createDiagnostics } from './diagnostics.mjs'

const cache = new Map()
const versionOf = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
parentPort.on('message', async ({ id, path }) => {
  try {
    const before = await stat(path, { bigint: true })
    const version = versionOf(before)
    const cached = cache.get(path)
    if (cached?.dataVersion === version) {
      parentPort.postMessage({ id, value: { ...cached, cacheHit: true, bytesRead: 0 } })
      return
    }
    const started = performance.now()
    const parser = createDiagnostics()
    const stream = createReadStream(path, { encoding: 'utf8' })
    let remainder = ''
    try {
      for await (const chunk of stream) {
        const lines = (remainder + chunk).split('\n')
        remainder = lines.pop()
        for (const line of lines) parser.line(line.endsWith('\r') ? line.slice(0, -1) : line)
      }
      parser.line(remainder)
    } finally { stream.destroy() }
    const after = await stat(path, { bigint: true })
    const changed = versionOf(after) !== version
    const value = { ...parser.result(), dataVersion: version, cacheHit: false, bytesRead: Number(before.size), parseMs: +(performance.now() - started).toFixed(2), incomplete: changed, ...(changed ? { errorCode: 'LOG_CHANGED_DURING_READ', note: '日志在解析期间发生变化；结果不完整，请重新查询。' } : {}) }
    if (!changed && value.errors.length + value.warnings.length <= 10000) {
      cache.delete(path)
      cache.set(path, value)
      if (cache.size > 4) cache.delete(cache.keys().next().value)
    }
    parentPort.postMessage({ id, value })
  } catch (error) { parentPort.postMessage({ id, error: { message: error.message, code: error.code ?? 'LOG_READ_FAILED', incomplete: true } }) }
})
