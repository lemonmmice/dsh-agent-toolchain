import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeFreshness, staleCodeInfo } from './code-freshness.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-freshness-cache-'))
try {
  writeFileSync(join(root, 'runtime.mjs'), 'export const value = 1')
  const stampFile = join(root, 'deploy.json')
  const options = { cacheMs: 1000, stampFile }
  const initial = codeFreshness(root, options)
  assert.equal(initial.source, 'scan')
  const cached = codeFreshness(root, options)
  assert.equal(cached.source, 'cache')
  assert.equal(cached.observedAt, initial.observedAt)
  assert.throws(() => codeFreshness(root, { ...options, processStartMs: NaN }), TypeError)
  writeFileSync(stampFile, JSON.stringify({ at: new Date(Date.now() + 5000).toISOString() }))
  const deployed = codeFreshness(root, options)
  assert.equal(deployed.source, 'scan')
  assert.equal(deployed.stale, true)
  assert.ok(staleCodeInfo(root, options).codeFreshnessSnapshot)
  console.log('PASS code freshness cache: age, immediate deploy invalidation, invalid clock rejection')
} finally {
  rmSync(root, { recursive: true, force: true })
}
