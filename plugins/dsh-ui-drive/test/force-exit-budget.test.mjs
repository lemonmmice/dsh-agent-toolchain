import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/driver.mjs', import.meta.url), 'utf8')
const start = source.indexOf('  async function killClientInstances() {')
const end = source.indexOf('\n  async function launch(', start)
assert.ok(start >= 0 && end > start)
const makeKill = new Function('c', 'clientInstances', 'execFile', 'isPidAlive', 'sleep', 'Date', 'process', 'envOr',
  source.slice(start, end) + '\nreturn killClientInstances')
let clock = 0
let alive = true
let kills = 0
const kill = makeKill(
  { clientExe: '' }, () => [{ pid: 42, path: 'fixture.exe' }],
  (file, args, options, callback) => { kills++; clock += options.timeout; alive = false; callback(null, '', '') },
  () => alive,
  async () => { clock += 150 }, { now: () => clock },
  { env: { DSH_UI_KILL_WAIT_MS: '1000' } }, () => '1000',
)
const result = await kill()
assert.equal(kills, 1, 'the kill operation can use the entire exit budget')
assert.equal(alive, false, 'the target exited during the last retry')
assert.equal(result.killed, true, 'the reported state must include the final kill attempt')
assert.deepEqual(result.remaining, [])
clock = 0
const deniedKill = makeKill(
  { clientExe: '' }, () => [{ pid: 43, path: 'fixture.exe' }],
  (file, args, options, callback) => { clock += options.timeout; callback(new Error('taskkill timed out'), '', Buffer.alloc(0)) },
  () => true, async () => {}, { now: () => clock }, { env: {} }, () => '1000',
)
const denied = await deniedKill()
assert.equal(denied.killed, false)
assert.deepEqual(denied.remaining, [43])
assert.match(denied.killErrors[0], /taskkill timed out/)
console.log('PASS force exit budget: final kill crossing the deadline uses a fresh exit observation')
