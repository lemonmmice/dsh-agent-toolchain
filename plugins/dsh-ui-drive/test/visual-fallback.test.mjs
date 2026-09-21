import assert from 'node:assert/strict'
import { executeVisualFallback } from '../lib/visual-fallback.mjs'

const frame = (overrides = {}) => ({
  ok: true, state: 'visible', path: 'frame.png', w: 1200, h: 800,
  captureMethod: 'print', coordinateSpace: 'window', physicalPixels: true,
  windowHandle: 77, pid: 1234, frameHash: 'frame-a',
  rect: { x: 10, y: 20, w: 1200, h: 800 }, ...overrides,
})
const baseArgs = { allowSideEffects: true, visualFallback: true, name: '删除', visualMinConfidence: 0.8, procId: 1234 }

async function run({ action = 'click', result = { ok: false, notFound: true, error: '未找到目标控件' }, args = {}, frames = [frame(), frame()], states = [{ ok: true, secretFocused: false, secret: false, desktopState: 'unlocked' }, { ok: true, secretFocused: false, secret: false, desktopState: 'unlocked' }], located = { ok: true, x: 120, y: 240, confidence: 0.91 }, clickResult = { ok: true, action: 'clickat' }, throwOnClick = false } = {}) {
  const calls = []
  const drive = async request => {
    calls.push(request)
    if (request.action === 'state-live') return states.length > 1 ? states.shift() : states[0]
    if (request.action === 'capture') return frames.length > 1 ? frames.shift() : frames[0]
    if (request.action === 'clickat') {
      if (throwOnClick) throw new Error('transport failed')
      return clickResult
    }
    throw new Error('unexpected action ' + request.action)
  }
  const vision = { locateImage: async (...received) => { calls.push({ action: 'vision', received }); return located } }
  const output = await executeVisualFallback({ action, result, args: { ...baseArgs, ...args }, drive, vision })
  return { output, calls }
}

const success = await run()
assert.equal(success.output.ok, true)
assert.equal(success.output.action, 'click')
assert.equal(success.output.fallbackFrom, '未找到目标控件')
assert.equal(success.output.visualFallback.source, 'vision-coordinate')
assert.equal(success.calls.at(-1).action, 'clickat')
assert.deepEqual(success.calls.at(-1).expectedRect, frame().rect)
assert.equal(success.calls.at(-1).expectedWindowHandle, 77)
const double = await run({ action: 'doubleclick' })
assert.equal(double.output.action, 'doubleclick')
assert.equal(double.calls.at(-1).double, true)

for (const blocked of [
  { action: 'setvalue' },
  { result: { ok: false, notFound: false, error: '未找到目标控件' } },
  { result: { ok: false, notFound: true, unknown: true } },
  { result: { ok: false, notFound: true, timeout: true } },
  { result: { ok: false, notFound: true, policyCode: 'locked_desktop' } },
  { args: { allowSideEffects: false } },
  { args: { index: 1 } },
  { args: { inAid: 'container' } },
  { args: { inName: 'container' } },
  { args: { match: '删除' } },
  { args: { secret: true } },
  { args: { name: '' } },
  { states: [{ ok: true, unknown: true }] },
  { states: [{ ok: true, secretFocused: true }] },
  { states: [{ ok: true, secretFocused: false }, { ok: true, secretFocused: true }] },
  { frames: [frame({ captureMethod: 'screen' }), frame()] },
  { frames: [frame({ physicalPixels: false }), frame()] },
  { frames: [frame({ coordinateSpace: 'client' }), frame()] },
  { frames: [frame({ frameHash: '' }), frame()] },
  { frames: [frame({ rect: { x: 10, y: 20, w: 1600, h: 1067 } }), frame()] },
  { frames: [frame({ windowHandle: 88 }), frame()] },
  { frames: [frame(), frame({ frameHash: 'frame-b' })] },
  { frames: [frame(), frame({ rect: { x: 11, y: 20, w: 1200, h: 800 } })] },
  { frames: [frame(), frame({ w: 1201, rect: { x: 10, y: 20, w: 1201, h: 800 } })] },
  { located: { ok: true, x: 120, y: 240, confidence: 0.79 } },
  { located: { ok: true, x: 1200, y: 240, confidence: 0.99 } },
  { located: { ok: true, x: 120, y: 800, confidence: 0.99 } },
  { located: { ok: true, x: -1, y: 240, confidence: 0.99 } },
]) {
  const { output, calls } = await run(blocked)
  assert.equal(output.ok, false)
  if (output.visualFallback) assert.equal(output.visualFallback.blocked, true)
  assert.equal(calls.some(call => call.action === 'clickat'), false)
}

const clickUnknown = await run({ clickResult: { ok: false, unknown: true, error: 'timeout' } })
assert.equal(clickUnknown.output.unknown, true)
assert.equal(clickUnknown.output.error, 'timeout')
assert.equal(clickUnknown.output.visualFallback.attempted, true)
assert.equal(clickUnknown.calls.filter(call => call.action === 'clickat').length, 1)
const clickThrew = await run({ throwOnClick: true })
assert.equal(clickThrew.output.unknown, true)
assert.equal(clickThrew.calls.filter(call => call.action === 'clickat').length, 1)
assert.match(clickThrew.output.error, /未重试/)
const clickMissing = await run({ clickResult: null })
assert.equal(clickMissing.output.unknown, true)
assert.equal(clickMissing.calls.filter(call => call.action === 'clickat').length, 1)
console.log('PASS visual fallback: fail-closed scope/sensitivity/capture/frame/DPI gates and click-once semantics')
