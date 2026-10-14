/**
 * ui_launch 的**可选截图**契约（两面都测）。
 *
 * 2026-10-14 起（用户决定去掉远程视觉描述）：
 *   · 默认**截一张图**（includeScreenshot !== false）——返回 PNG 路径，看图由调用方 read_image；
 *   · `includeScreenshot: false` 才完全跳过（省一次截图，实测 ≈1.3s）；
 *   · **没有任何视觉模型调用**（旧契约里的 describe=true 已不存在，也不再需要敏感焦点门）；
 *   · 半成功（ok=false）时**不碰窗口**（截图要么失败、要么抓到别的进程）。
 *
 * 这里把 MCP handler 与 DSH execute 都抽出来跑，因为"两面各写一份、只测一面"正是本仓
 * 反复踩过的坑（描述/参数漂移）。
 */
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
  drive: async args => { calls.push({ kind: 'drive', args }); return { ok: true, action: 'shot', path: 'fixture.png', w: 200, h: 100, distinctColors: 512 } },
}
globalThis.__launchOptionalDriver = driver
const loader = `
export async function resolve(specifier, context, nextResolve) {
  let source;
  if (specifier === '@deepseek-ai/dsh-tools') source = 'export const defineTool = tool => tool';
  if (specifier.endsWith('/lib/driver.mjs')) source = 'export const makeDriver = () => globalThis.__launchOptionalDriver';
  if (source) return {url:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),shortCircuit:true};
  return nextResolve(specifier, context);
}`
register('data:text/javascript;base64,' + Buffer.from(loader).toString('base64'))

// 与生产同构的 shotState 替身：只记录"截了几次图"，并按 PS 侧返回 distinctColors 决定要不要重拍
const shotStateStub = async (driverArg, opts = {}) => {
  const maxRetries = opts.retries === undefined ? 2 : opts.retries
  for (let i = 0; i <= maxRetries; i++) {
    const s = await driverArg.drive({ action: 'shot', label: i === 0 ? opts.label : opts.label + '-retry' + i })
    if (!s || s.ok !== true) return null
    if (s.distinctColors > 2) return { screenshot: s.path, size: s.w + 'x' + s.h, distinctColors: s.distinctColors, settleRetries: i }
  }
  return { screenshot: 'fixture.png', size: '200x100', distinctColors: 1, settleRetries: maxRetries, note: '疑似纯色' }
}

const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const launchStart = source.indexOf("server.tool(\n  'ui_launch'")
const launchEnd = source.indexOf("\nserver.tool(", launchStart + 1)
assert.ok(launchStart >= 0 && launchEnd > launchStart)
let mcpLaunch
vm.runInNewContext(source.slice(launchStart, launchEnd), {
  drv: () => driver,
  shotState: shotStateStub,
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
    // 默认：截一张图
    calls.length = 0
    const def = await launch({})
    assert.equal(def.readiness, 'window-ready', surface)
    assert.equal(calls.filter(c => c.kind === 'launch').length, 1, surface)
    assert.equal(calls.filter(c => c.kind === 'drive').length, 1, surface + ' 默认应截图一次')
    assert.equal(def.uiState.screenshot, 'fixture.png', surface)
    assert.equal(def.uiState.size, '200x100', surface)

    // includeScreenshot:false：完全不截图（只剩 launch 一次调用）
    calls.length = 0
    const skipped = await launch({ includeScreenshot: false })
    assert.equal(skipped.uiState, undefined, surface)
    assert.deepEqual(calls.map(c => c.kind), ['launch'], surface + ' 跳过截图时不应有任何其它调用')

    // 哪怕有人硬传 describe（该参数已从两面 schema 摘掉），也**不会**有视觉调用 —— 因为插件里没有视觉描述链路
    calls.length = 0
    const stale = await launch({ describe: true })
    assert.equal(calls.filter(c => c.kind === 'describe').length, 0, surface + ' 不应存在任何视觉描述调用')
    assert.equal(typeof stale.uiState.screenshot, 'string', surface)

    // 已在运行：同样默认出图（这正是"一步拿到当前界面"的路径）
    launchResult = { ok: true, started: false, alreadyRunning: true }
    calls.length = 0
    const existing = await launch({})
    assert.equal(existing.readiness, 'window-ready', surface)
    assert.equal(calls.filter(c => c.kind === 'drive').length, 1, surface + ' 已运行时也应出图（默认开）')
    launchResult = { ok: true, started: true }

    // 半成功（没有可用主窗口）：绝不截图
    launchResult = { ok: false, started: true }
    calls.length = 0
    const partial = await launch({})
    assert.equal(partial.readiness, 'spawned', surface)
    assert.deepEqual(calls.map(c => c.kind), ['launch'], surface + ' 半成功不得去截别人的窗口')
    launchResult = { ok: true, started: true }
  }
  console.log('PASS ui_launch 两面：默认出图、includeScreenshot=false 跳过、无任何视觉调用、半成功不碰窗口')
} finally {
  delete globalThis.__launchOptionalDriver
}
