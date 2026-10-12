import { createReadStream } from 'node:fs'
import { parseClrEvents } from './clr-events.mjs'

export async function readClrEvents(xmlPath, { pid = null, maxBytes, maxEventBytes = 4 * 1024 * 1024, maxEvents = 1000000, maxRetainedBytes = 64 * 1024 * 1024 } = {}) {
  const events = []
  const processIds = new Set()
  let originalParsedEvents = 0
  let bytes = 0
  let pending = ''
  let retainedBytes = 0
  for await (const chunk of createReadStream(xmlPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    bytes += Buffer.byteLength(chunk)
    if (Number.isFinite(maxBytes) && bytes > maxBytes) throw new Error('XML 实际大小超过读取上限')
    pending += chunk
    while (true) {
      const start = pending.search(/<Event\b/)
      if (start < 0) { pending = pending.slice(-16); break }
      if (start > 0) pending = pending.slice(start)
      const end = pending.indexOf('</Event>')
      if (end < 0) {
        if (Buffer.byteLength(pending) > maxEventBytes) throw new Error('单条 XML 事件超过读取上限')
        break
      }
      const block = pending.slice(0, end + 8)
      pending = pending.slice(end + 8)
      if (Buffer.byteLength(block) > maxEventBytes) throw new Error('单条 XML 事件超过读取上限')
      for (const event of parseClrEvents(block)) {
        originalParsedEvents++
        if (event.processId != null) processIds.add(event.processId)
        if (pid != null && event.processId !== pid) continue
        if (events.length >= maxEvents) throw new Error('CLR 事件数超过分析上限')
        retainedBytes += Buffer.byteLength(event.block)
        if (retainedBytes > maxRetainedBytes) throw new Error('CLR 事件内存预算超过上限，请指定 PID 或缩短采集')
        events.push(event)
      }
    }
  }
  if (/<Event\b/.test(pending)) throw new Error('XML 事件不完整')
  return { events, originalParsedEvents, availableProcessIds: [...processIds].sort((left, right) => left - right) }
}
