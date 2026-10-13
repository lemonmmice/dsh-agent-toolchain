import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function withFileTransaction(file, action) {
  const lock = file + '.lock'
  const token = process.pid + '-' + randomUUID() + '.json'
  const candidate = lock + '-' + token
  const busy = () => Object.assign(new Error('File transaction is busy; no changes were made'), {
    code: 'FILE_TRANSACTION_BUSY', retryable: true, retryAfterMs: 25, writesApplied: false,
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(candidate)
  fs.writeFileSync(path.join(candidate, token), JSON.stringify({ pid: process.pid }))
  let acquired = false
  let asynchronous = false
  const release = () => {
    if (acquired) fs.renameSync(lock, candidate)
    try { fs.unlinkSync(path.join(candidate, token)); fs.rmdirSync(candidate) }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(candidate, lock)
        acquired = true
        break
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error
        if (!fs.existsSync(lock)) continue
        let owners
        try { owners = fs.readdirSync(lock) } catch (readError) { if (readError.code === 'ENOENT') continue; throw busy() }
        if (owners.length !== 1 || !/^\d+-[\da-f-]+\.json$/.test(owners[0])) throw busy()
        const ownerFile = path.join(lock, owners[0])
        const ownerPid = Number(owners[0].split('-')[0])
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw busy()
        try { process.kill(ownerPid, 0); throw busy() }
        catch (probeError) { if (probeError.code !== 'ESRCH') throw busy() }
        const recoveryToken = process.pid + '-' + randomUUID() + '.json'
        const recovered = lock + '-recovered-' + recoveryToken
        try {
          fs.renameSync(ownerFile, path.join(lock, recoveryToken))
          fs.renameSync(lock, recovered)
          fs.unlinkSync(path.join(recovered, recoveryToken))
          fs.rmdirSync(recovered)
        }
        catch (cleanupError) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError.code)) throw cleanupError
        }
      }
    }
    if (!acquired) throw busy()
    const result = action()
    if (result && typeof result.then === 'function') {
      asynchronous = true
      return Promise.resolve(result).finally(release)
    }
    return result
  } finally {
    if (!asynchronous) release()
  }
}
