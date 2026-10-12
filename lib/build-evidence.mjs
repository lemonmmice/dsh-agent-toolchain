import { createHash } from 'node:crypto'
import { lstat, readlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { runVerificationProcess } from './verify/process.mjs'

export async function sourceIdentity(repoRoot, { signal } = {}) {
  const listed = await runVerificationProcess('git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal, maxBytes: 8 * 1024 * 1024 })
  if (listed.code !== 0) return { available: false, reason: listed.timedOut ? 'source-query-timeout' : 'source-query-failed' }
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()
  const digest = createHash('sha256')
  const deadline = Date.now() + 30000
  try {
    for (const path of paths) {
      if (signal?.aborted) return { available: false, reason: 'aborted' }
      if (Date.now() > deadline) return { available: false, reason: 'source-read-timeout' }
      digest.update(path + '\0')
      try {
        const fullPath = join(repoRoot, path)
        const stat = await lstat(fullPath)
        if (stat.isSymbolicLink()) digest.update('link:' + await readlink(fullPath))
        else if (stat.isFile()) {
          digest.update('file:' + stat.size + '\0')
          for await (const chunk of createReadStream(fullPath, { signal })) {
            if (Date.now() > deadline) return { available: false, reason: 'source-read-timeout' }
            digest.update(chunk)
          }
          const after = await lstat(fullPath)
          if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) return { available: false, reason: 'source-changed-while-reading' }
        }
        else return { available: false, reason: 'unsupported-source-entry' }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        digest.update('missing')
      }
      digest.update('\0')
    }
    return { available: true, algorithm: 'sha256-git-files-v1', digest: digest.digest('hex'), fileCount: paths.length }
  } catch (error) {
    return { available: false, reason: 'source-read-failed', error: error.message }
  }
}

export async function fileDigest(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
