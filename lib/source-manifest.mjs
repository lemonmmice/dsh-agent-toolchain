import { createHash, randomUUID } from 'node:crypto'
import { lstat, readlink, readFile, writeFile, mkdir, rename, unlink, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runVerificationProcess } from './verify/process.mjs'

export const SOURCE_MANIFEST_ALGORITHM = 'sha256-git-file-hashes-v2'
const stampOf = value => value ? [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':') : 'missing'
const hashOf = value => createHash('sha256').update(value).digest('hex')

export async function sourceManifestIdentity(repoRoot, { signal, concurrency = 16, timeoutMs = 30000, cacheDir = join(homedir(), '.dsh-agent-toolchain', 'source-manifests'), forceFull = false } = {}) {
  const started = performance.now()
  const deadline = Date.now() + timeoutMs
  const metrics = { filesScanned: 0, filesHashed: 0, bytesRead: 0, filesReused: 0, cacheHit: false }
  const check = () => {
    if (signal?.aborted) throw new Error('aborted')
    if (Date.now() >= deadline) throw new Error('source-read-timeout')
  }
  const statOf = async path => {
    try { return await lstat(path, { bigint: true }) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const list = async () => {
    check()
    const result = await runVerificationProcess('git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal, maxBytes: 8 * 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()) })
    if (result.code !== 0 || result.truncated) throw new Error('source-query-failed')
    return [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
  }
  try {
    const root = await realpath(repoRoot)
    const file = join(cacheDir, hashOf(root) + '.json')
    let previous = null, cacheReason = forceFull ? 'forced-full' : 'missing'
    if (!forceFull) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'))
        if (saved.version === 2 && saved.root === root && Array.isArray(saved.entries)) { previous = new Map(saved.entries); cacheReason = 'identity-check' }
        else cacheReason = 'unsupported-manifest'
      } catch (error) { if (error.code !== 'ENOENT') cacheReason = 'unreadable-manifest' }
    }
    const paths = await list()
    const entries = new Map()
    const width = Math.max(1, Math.min(32, Math.floor(Number(concurrency)) || 16))
    const prepare = async path => {
      check()
      const fullPath = join(root, path)
      const before = await statOf(fullPath)
      const stamp = stampOf(before)
      metrics.filesScanned++
      const cached = previous?.get(path)
      if (cached?.stamp === stamp && /^[a-f0-9]{64}$/.test(cached.hash) && ['file', 'link', 'missing'].includes(cached.type)) {
        entries.set(path, cached)
        metrics.filesReused++
        return
      }
      let hash, type
      if (!before) { type = 'missing'; hash = hashOf('missing') }
      else if (before.isSymbolicLink()) { type = 'link'; hash = hashOf(await readlink(fullPath)) }
      else if (before.isFile()) {
        type = 'file'
        const descriptor = await open(fullPath, 'r')
        try {
          if (stampOf(await descriptor.stat({ bigint: true })) !== stamp) throw new Error('source-changed-while-reading')
          const digest = createHash('sha256')
          let bytes = 0
          for await (const chunk of descriptor.createReadStream({ autoClose: false, signal })) { check(); digest.update(chunk); bytes += chunk.length }
          if (BigInt(bytes) !== before.size || stampOf(await descriptor.stat({ bigint: true })) !== stamp) throw new Error('source-changed-while-reading')
          hash = digest.digest('hex')
          metrics.bytesRead += bytes
          metrics.filesHashed++
        } finally { await descriptor.close() }
      } else throw new Error('unsupported-source-entry')
      if (stampOf(await statOf(fullPath)) !== stamp) throw new Error('source-changed-while-reading')
      entries.set(path, { stamp, hash, type })
    }
    for (let offset = 0; offset < paths.length; offset += width) {
      const settled = await Promise.allSettled(paths.slice(offset, offset + width).map(prepare))
      const failed = settled.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    }
    for (let offset = 0; offset < paths.length; offset += width) {
      check()
      const current = await Promise.all(paths.slice(offset, offset + width).map(async path => stampOf(await statOf(join(root, path))) === entries.get(path).stamp))
      if (current.some(matches => !matches)) throw new Error('source-changed-while-reading')
    }
    if (JSON.stringify(await list()) !== JSON.stringify(paths)) throw new Error('source-changed-while-reading')
    const digest = createHash('sha256')
    for (const path of paths) { const entry = entries.get(path); digest.update(path + '\0' + entry.type + ':' + entry.hash + '\0') }
    const revision = digest.digest('hex')
    const manifest = { version: 2, root, revision, entries: paths.map(path => [path, entries.get(path)]) }
    const temporary = file + '.' + randomUUID() + '.tmp'
    let cacheWriteError = null
    try { await mkdir(cacheDir, { recursive: true }); await writeFile(temporary, JSON.stringify(manifest)); await rename(temporary, file) }
    catch (error) {
      cacheWriteError = error.code || error.message
      try { await unlink(temporary) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') cacheWriteError += '; ' + cleanupError.message }
    }
    return { available: true, algorithm: SOURCE_MANIFEST_ALGORITHM, digest: revision, revision, fileCount: paths.length,
      completeness: 'complete', validation: 'file-id-size-mtime-ctime-and-git-listing', ...metrics, cacheHit: metrics.filesReused > 0,
      cacheReason, cacheWriteError, hashMs: +(performance.now() - started).toFixed(2) }
  } catch (error) { return { available: false, reason: signal?.aborted ? 'aborted' : error.message, completeness: 'incomplete', ...metrics } }
}
