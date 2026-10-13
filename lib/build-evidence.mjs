import { createHash } from 'node:crypto'
import { lstat, readlink, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { runVerificationProcess } from './verify/process.mjs'
import { sourceManifestIdentity, SOURCE_MANIFEST_ALGORITHM } from './source-manifest.mjs'

const sourceStamp = stat => stat ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'missing'

export async function sourceIdentity(repoRoot, { signal, concurrency = 16, timeoutMs = 30000, algorithm = 'sha256-git-files-v1', forceFull = false, cacheDir } = {}) {
  if (algorithm === SOURCE_MANIFEST_ALGORITHM) return sourceManifestIdentity(repoRoot, { signal, concurrency, timeoutMs, forceFull, cacheDir })
  if (algorithm !== 'sha256-git-files-v1') return { available: false, reason: 'unsupported-source-algorithm', completeness: 'incomplete' }
  const started = performance.now()
  const deadline = Date.now() + timeoutMs
  const metrics = { filesScanned: 0, filesHashed: 0, bytesRead: 0, cacheHit: false }
  const check = () => {
    if (signal?.aborted) throw new Error('aborted')
    if (Date.now() > deadline) throw new Error('source-read-timeout')
  }
  const listed = await runVerificationProcess('git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal, maxBytes: 8 * 1024 * 1024 })
  if (listed.code !== 0) return { available: false, reason: listed.aborted ? 'aborted' : listed.timedOut ? 'source-query-timeout' : 'source-query-failed', completeness: 'incomplete', ...metrics }
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()
  const digest = createHash('sha256')
  const width = Math.max(1, Math.min(32, Math.floor(Number(concurrency)) || 16))
  const stamps = new Map()
  const readStat = async fullPath => {
    try { return await lstat(fullPath, { bigint: true }) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const prepare = async path => {
    check()
    const fullPath = join(repoRoot, path)
    const stat = await readStat(fullPath)
    metrics.filesScanned++
    stamps.set(path, sourceStamp(stat))
    if (!stat) return { path, type: 'missing' }
    if (stat.isSymbolicLink()) return { path, type: 'link', target: await readlink(fullPath) }
    if (!stat.isFile()) throw new Error('unsupported-source-entry')
    let bytes = null
    if (stat.size <= 65536n) {
      const file = await open(fullPath, 'r')
      try {
        if (sourceStamp(await file.stat({ bigint: true })) !== sourceStamp(stat)) throw new Error('source-changed-while-reading')
        const buffer = Buffer.alloc(Number(stat.size) + 1)
        let length = 0
        while (length < buffer.length) {
          check()
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length !== Number(stat.size)) throw new Error('source-changed-while-reading')
        bytes = buffer.subarray(0, length)
      } finally { await file.close() }
    }
    check()
    return { path, type: 'file', size: stat.size, bytes }
  }
  try {
    for (let offset = 0; offset < paths.length; offset += width) {
      const settled = await Promise.allSettled(paths.slice(offset, offset + width).map(prepare))
      const rejected = settled.find(entry => entry.status === 'rejected')
      if (rejected) throw rejected.reason
      for (const { value: entry } of settled) {
        check()
        digest.update(entry.path + '\0')
        if (entry.type === 'link') digest.update('link:' + entry.target)
        else if (entry.type === 'missing') digest.update('missing')
        else {
          digest.update('file:' + entry.size + '\0')
          if (entry.bytes) {
            digest.update(entry.bytes)
            metrics.bytesRead += entry.bytes.length
          } else {
            for await (const chunk of createReadStream(join(repoRoot, entry.path), { signal })) {
              check()
              digest.update(chunk)
              metrics.bytesRead += chunk.length
            }
          }
          metrics.filesHashed++
        }
        digest.update('\0')
      }
    }
    for (let offset = 0; offset < paths.length; offset += width) {
      check()
      const results = await Promise.allSettled(paths.slice(offset, offset + width).map(async path => {
        if (sourceStamp(await readStat(join(repoRoot, path))) !== stamps.get(path)) throw new Error('source-changed-while-reading')
      }))
      const rejected = results.find(entry => entry.status === 'rejected')
      if (rejected) throw rejected.reason
    }
    check()
    const after = await runVerificationProcess('git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal, maxBytes: 8 * 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()) })
    check()
    if (after.code !== 0) throw new Error('source-query-failed')
    if (JSON.stringify([...new Set(after.stdout.split('\0').filter(Boolean))].sort()) !== JSON.stringify(paths)) throw new Error('source-changed-while-reading')
    const hash = digest.digest('hex')
    return { available: true, algorithm: 'sha256-git-files-v1', digest: hash, revision: hash, fileCount: paths.length, completeness: 'complete', ...metrics, hashMs: +(performance.now() - started).toFixed(2) }
  } catch (error) {
    const reason = signal?.aborted ? 'aborted' : ['aborted', 'source-read-timeout', 'source-changed-while-reading', 'unsupported-source-entry', 'source-query-failed'].includes(error.message) ? error.message : 'source-read-failed'
    return { available: false, reason, error: error.message, completeness: 'incomplete', ...metrics }
  }
}

export async function fileDigest(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
