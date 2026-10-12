import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_UI_PROC_NAME = 'dsh-isolated-not-running'
const statusModule = await import('./toolchain-status.mjs')
const query = statusModule.toolchainStatusAsync || statusModule.buildToolchainStatus
const started = performance.now()
const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 10))
const first = await query()
const heartbeatMs = await heartbeat
const cacheStarted = performance.now()
const second = await query()
const cachedMs = performance.now() - cacheStarted
console.log(JSON.stringify({ heartbeatMs, cachedMs, source: second.source }))
assert.ok(heartbeatMs < 200)
assert.equal(first.observedAt, second.observedAt)
assert.equal(second.source, 'cache')
assert.ok(cachedMs < 100)
assert.ok(second.ageMs >= 0)
console.log('PASS toolchain diagnostic runs off event loop and cache has age')
