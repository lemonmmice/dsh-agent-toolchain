import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import vm from 'node:vm'

process.env.DSH_TEST = '1'
process.env.DSH_NO_ENV_FALLBACK = '1'
const calls = []
let launchResult = { ok: true, started: true }
const driver = {
  launch: async args => { calls.push({ kind: 'launch', args }); return { ...launchResult } },
  drive: async args => { calls.push({ kind: 'drive', args }); return { ok: true, action: 'shot', path: 'fixture.png', w: 200, h: 100 } },
  secretFocusNow: async () => { calls.push({ kind: 'sensitivity' }); return { secret: false, unknown: false } },
}
const vision = {
  describeImage: async () => { calls.push({ kind: 'describe' }); return { ok: true, text: 'fixture application ready', model: 'fixture' } },
}
globalThis.__launchOptionalDriver = driver
globalThis.__launchOptionalVision = vision
const loader = `
export async function resolve(specifier, context, nextResolve) {
  let source;
  if (specifier === '@deepseek-ai/dsh-tools') source = 'export const defineTool = tool => tool';
  if (specifier.endsWith('/lib/driver.mjs')) source = 'export const makeDriver = () => globalThis.__launchOptionalDriver';
  if (specifier.endsWith('/lib/vision.mjs')) source = 'export const makeVision = () => globalThis.__launchOptionalVision; export const UI_STATE_PROMPT = "fixture"';
  if (source) return {url:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),shortCircuit:true};
  return nextResolve(specifier, context);
}`
register('data:text/javascript;base64,' + Buffer.from(loader).toString('base64'))

const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const launchStart = source.indexOf("server.tool(\n  'ui_launch'")
const launchEnd = source.indexOf("\nserver.tool(", launchStart + 1)
assert.ok(launchStart >= 0 && launchEnd > launchStart)
const visionStart = source.indexOf('async function attachVision(')
const visionEnd = source.indexOf('\n// ---------------------------------------------------------------- perf', visionStart)
assert.ok(visionStart > launchEnd && visionEnd > visionStart)
const visionSource = source.slice(visionStart, visionEnd).replace("await import('../plugins/dsh-ui-drive/lib/vision.mjs')", 'visionModule')
let mcpLaunch
vm.runInNewContext(visionSource + '\n' + source.slice(launchStart, launchEnd), {
  drv: () => driver,
  visionModule: { makeVision: () => vision, UI_STATE_PROMPT: 'fixture' },
  server: { tool: (name, _description, _shape, handler) => { assert.equal(name, 'ui_launch'); mcpLaunch = handler } },
  mcpDescription: () => '', mcpShape: () => ({}), jtext: value => value, attachInlineImage: value => value,
})

const plugin = await import('../plugins/dsh-ui-drive/index.js')
let dshLaunch
plugin.apply({
  effect: action => action(),
  tools: { register: tool => { if (tool.name === 'ui_launch') dshLaunch = tool.execute; return () => {} } },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
})
assert.equal(typeof dshLaunch, 'function')

try {
  for (const [surface, launch] of [['MCP', mcpLaunch], ['DSH', dshLaunch]]) {
    for (const [args, screenshots, descriptions] of [[{}, 0, 0], [{ includeScreenshot: true }, 1, 0], [{ describe: true }, 1, 1]]) {
      calls.length = 0
      const result = await launch(args)
      assert.equal(result.readiness, 'window-ready', surface)
      assert.equal(calls.filter(call => call.kind === 'launch').length, 1, surface)
      assert.equal(calls.filter(call => call.kind === 'drive').length, screenshots, surface)
      assert.equal(calls.filter(call => call.kind === 'describe').length, descriptions, surface)
      assert.equal(calls.filter(call => call.kind === 'sensitivity').length, descriptions, surface)
      if (screenshots) assert.equal(result.uiState.screenshot, 'fixture.png', surface)
      else assert.equal(result.uiState, undefined, surface)
      if (descriptions) assert.equal(result.uiState.description, 'fixture application ready', surface)
    }
    launchResult = { ok: false, started: true }
    calls.length = 0
    const partial = await launch({ includeScreenshot: true, describe: true })
    assert.equal(partial.readiness, 'spawned', surface)
    assert.equal(calls.length, 1, 'partial launch must not inspect an unrelated window')
    launchResult = { ok: true, started: true }
  }
  console.log('PASS ui_launch MCP handler/DSH execute: default no screenshot/vision, screenshot only, explicit describe, partial readiness')
} finally {
  delete globalThis.__launchOptionalDriver
  delete globalThis.__launchOptionalVision
}
