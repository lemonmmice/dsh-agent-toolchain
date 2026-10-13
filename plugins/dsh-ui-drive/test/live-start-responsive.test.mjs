import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLive } from '../lib/live.mjs'

const directory = mkdtempSync(join(tmpdir(), 'live-start-responsive-'))
let release
let captures = 0
let hold = new Promise(resolve => { release = resolve })
const driver = {
  completenessInfo: () => ({ skipped: 0 }),
  async drive(args) {
    if (args.action === 'state-live') { await hold; return { ok: true, window: 'fixture', secretFocused: false, count: 0, lines: [] } }
    captures++
    const path = join(directory, args.label + '.png')
    writeFileSync(path, 'fixture frame')
    return { ok: true, path, w: 1, h: 1, state: 'visible' }
  },
}
const live = makeLive({ driver, dir: directory, intervalMs: 60000 })
try {
  const starting = live.start()
  const accepted = await Promise.race([starting, new Promise(resolve => setTimeout(() => resolve(null), 100))])
  if (!accepted) { release(); await starting; live.stop(); assert.fail('start waits for first state/capture instead of accepting promptly') }
  assert.equal(accepted.live.state, 'starting')
  assert.equal(accepted.frame, null)
  assert.equal(accepted.live.frameCount, 0)
  assert.equal(live.stop().live.state, 'stopped')
  release()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(live.status().frame, null)
  assert.equal(captures, 0)
  hold = Promise.resolve()
  const restarted = await live.start()
  assert.equal(restarted.live.state, 'starting')
  const first = await live.wait({ timeoutMs: 2000 })
  assert.equal(first.changed, true)
  assert.equal(first.snapshot.live.state, 'running')
  assert.equal(first.snapshot.live.frameCount, 1)
  live.stop()
  assert.equal(JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8')).live.state, 'stopped')
  console.log('PASS: live start acceptance, delayed first frame, stop-before-frame and restart generation')
} finally { release(); live.stop(); rmSync(directory, { recursive: true, force: true }) }
