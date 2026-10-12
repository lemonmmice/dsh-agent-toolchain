import assert from 'node:assert/strict'
import { createCaptureStatusCache } from './capture-status-cache.mjs'

let finish
let calls = 0
let instant = 1000
const cache = createCaptureStatusCache({ fetchStatus: () => { calls++; return new Promise(resolve => { finish = resolve }) }, now: () => instant })
const initial = await cache.get()
assert.equal(initial.source, 'unknown')
assert.equal(initial.refreshing, true)
assert.equal(initial.value, null)
await cache.get()
assert.equal(calls, 1)
finish({ running: true })
await cache.get({ fresh: true })
instant += 50
const cached = await cache.get()
assert.equal(cached.value.running, true)
assert.equal(cached.ageMs, 50)
assert.equal(cached.source, 'host-cache')
instant += 3000
const stale = await cache.get()
assert.equal(stale.ageMs, 3050)
assert.equal(stale.refreshing, true)
assert.equal(calls, 2)
finish({ running: false })
const fresh = await cache.get({ fresh: true })
assert.equal(fresh.value.running, false)
assert.equal(fresh.ageMs, 0)
const failed = createCaptureStatusCache({ fetchStatus: async () => { throw new Error('host unavailable') } })
assert.equal((await failed.get({ fresh: true })).source, 'unknown')
const mutable = createCaptureStatusCache({ fetchStatus: () => Promise.resolve({ running: true }), now: () => 1 })
const firstValue = await mutable.get({ fresh: true })
firstValue.value.running = false
assert.equal((await mutable.get()).value.running, true)
let finishOld
let invalidatedCalls = 0
const invalidated = createCaptureStatusCache({ fetchStatus: () => {
  invalidatedCalls++
  return invalidatedCalls === 1 ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve({ running: false })
} })
await invalidated.get()
invalidated.invalidate()
const afterMutation = invalidated.get({ fresh: true })
finishOld({ running: true })
assert.equal((await afterMutation).value.running, false)
assert.equal(invalidatedCalls, 2)
let responseTime = 1000
let releaseDelayed
const delayed = createCaptureStatusCache({ now: () => responseTime, fetchStatus: () => new Promise(resolve => { releaseDelayed = resolve }) })
await delayed.get()
responseTime = 3900
releaseDelayed({ running: true })
const delayedResult = await delayed.get({ fresh: true })
assert.equal(delayedResult.observedAt, 1000)
assert.equal(delayedResult.ageMs, 2900)
console.log('PASS capture status cache returns unknown immediately, single-flights refresh, reports age')
