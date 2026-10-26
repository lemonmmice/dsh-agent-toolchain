import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDevelopmentTools } from './development-tools.mjs'

const directory = await mkdtemp(join(tmpdir(), 'dsh-dev-tools-'))
const workspace = join(directory, 'workspace')
await mkdir(workspace)
const target = join(workspace, 'sample.txt')
await writeFile(target, 'unchanged')
const outside = join(directory, 'outside.txt')
await writeFile(outside, 'outside')
const tools = makeDevelopmentTools({ profileDir: join(directory, 'missing-profile') })
try {
  const status = await tools.status()
  assert.equal(status.ok, true)
  assert.equal(status.state, 'unconfigured')
  assert.equal(status.backends.length, 4)
  assert.ok(status.backends.every(backend => !backend.available))
  assert.equal(status.runtimeVerified, false)
  const missing = await tools.skills({ query: 'msbuild' })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, 'DEV_DEPENDENCY_MISSING')
  const denied = await tools.edit({ repoRoot: workspace, file: target, oldText: 'unchanged', newText: 'modified' })
  assert.equal(denied.errorCode, 'DEV_WRITE_NOT_ALLOWED')
  assert.equal(await readFile(target, 'utf8'), 'unchanged')
  const stale = await tools.edit({ repoRoot: workspace, file: target, oldText: 'unchanged', newText: 'modified', expectedHash: '0'.repeat(64), allowWrite: true })
  assert.equal(stale.errorCode, 'DEV_STALE_FILE')
  assert.equal(await readFile(target, 'utf8'), 'unchanged')
  const escaped = await tools.read({ repoRoot: workspace, file: outside })
  assert.equal(escaped.errorCode, 'DEV_PATH_OUTSIDE_ROOT')
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled before dispatch'))
  const result = await tools.read({ repoRoot: workspace, file: target }, { signal: cancelled.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /cancelled before dispatch/)
  await tools.close()
  assert.equal((await tools.status()).errorCode, 'DEV_CLOSED')
  console.log('PASS: development tools missing dependencies, write consent, stale hash, workspace boundary and cancellation')
} finally {
  await tools.close()
  await rm(directory, { recursive: true, force: true })
}
