// 共享快照新鲜度：fresh/stale/unknown + ageMs 下限 + 无 TTL 不判 stale；破坏性动作绝不被展示快照授权。
import assert from 'node:assert/strict'
import { snapshotFreshness, canAuthorizeDestructiveAction } from './snapshot-freshness.mjs'

assert.equal(snapshotFreshness({ capturedAt: 1000, now: 1200, ttlMs: 300 }).state, 'fresh')
const stale = snapshotFreshness({ capturedAt: 1000, now: 1400, ttlMs: 300 })
assert.equal(stale.state, 'stale')
assert.equal(stale.ageMs, 400)

// 缺 capturedAt → unknown（不谎报有数据）
assert.equal(snapshotFreshness({ now: 1400, ttlMs: 300 }).state, 'unknown')
assert.equal(snapshotFreshness({ now: 1400, ttlMs: 300 }).ageMs, null)

// 时钟回拨 → ageMs 收敛到 0，不出负
assert.equal(snapshotFreshness({ capturedAt: 1000, now: 900, ttlMs: 300 }).ageMs, 0)

// 无 TTL（0 或缺省）→ 一律 fresh（调用方自行决定是否关心年龄）
assert.equal(snapshotFreshness({ capturedAt: 1000, now: 999999, ttlMs: 0 }).state, 'fresh')

// refreshing 透传（后台正在刷新）
assert.equal(snapshotFreshness({ capturedAt: 1000, now: 2000, ttlMs: 300, refreshing: true }).refreshing, true)

// 硬边界：展示用快照绝不授权破坏性动作
assert.equal(canAuthorizeDestructiveAction(), false)

console.log('PASS: snapshot freshness (fresh/stale/unknown, age floor, no-TTL fresh, display-only never authorizes)')
