import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { renderDrive } from '../lib/render.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const server = readFileSync(join(root, 'mcp', 'server.mjs'), 'utf8').replace(/\r\n/g, '\n')
const plugin = readFileSync(join(root, 'plugins', 'dsh-ui-drive', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const require = createRequire(join(root, 'mcp', 'package.json'))
const { z } = require('zod')
const mcpDefinition = server.match(/const uiWaitAfter = ([\s\S]*?)\n\nconst uiAction/)
const dshDefinition = plugin.match(/const WAIT_AFTER = ([\s\S]*?\n})\n/)
assert.ok(mcpDefinition, 'MCP waitAfter schema is declared')
assert.ok(dshDefinition, 'DSH waitAfter schema is declared')
const mcpSchema = new Function('z', 'return ' + mcpDefinition[1])(z)
const dshSchema = new Function('return ' + dshDefinition[1])()
const fields = ['aid', 'name', 'state', 'ms', 'interval', 'winHandle', 'winTitle'].sort()
assert.deepEqual(Object.keys(dshSchema.properties).sort(), fields)
assert.equal(dshSchema.additionalProperties, false)
for (const toolName of ['ui_drive', 'ui_act']) {
  const start = server.indexOf("server.tool(\n  '" + toolName + "',")
  assert.ok(start >= 0, toolName + ' MCP registration exists')
  assert.match(server.slice(start, server.indexOf('\nserver.tool(', start + 1)), /waitAfter:\s*uiWaitAfter/)
  const pluginStart = plugin.indexOf("name: '" + toolName + "'")
  assert.ok(pluginStart >= 0, toolName + ' DSH registration exists')
  assert.match(plugin.slice(pluginStart, plugin.indexOf('\n  defineTool(', pluginStart + 1)), /waitAfter:\s*WAIT_AFTER/)
}
const valid = { aid: 'Ready', name: 'Ready button', state: 'enabled', ms: 1500, interval: 50, winHandle: 12345, winTitle: 'Popup' }
assert.deepEqual(mcpSchema.parse(valid), valid)
assert.equal(mcpSchema.safeParse(undefined).success, true)
for (const condition of [
  { aid: 'Ready', action: 'click' },
  { aid: 'Ready', procId: 42 },
  { aid: 'Ready', allowSideEffects: true },
  { aid: 'Ready', inAid: 'Container' },
  { aid: 'Ready', inName: 'Container' },
  { aid: 'Ready', state: 'selected' },
  { aid: 'Ready', ms: 0 },
  { aid: 'Ready', ms: 30001 },
  { aid: 'Ready', ms: 1.5 },
  { aid: 'Ready', interval: 0 },
  { aid: 'Ready', interval: 1001 },
  { aid: 'Ready', winHandle: 0 },
  { aid: 'Ready', winHandle: Number.MAX_SAFE_INTEGER + 1 },
]) assert.equal(mcpSchema.safeParse(condition).success, false, JSON.stringify(condition))
for (const [field, maximum] of [['ms', 30000], ['interval', 1000], ['winHandle', Number.MAX_SAFE_INTEGER]]) {
  assert.equal(dshSchema.properties[field].type, 'integer')
  assert.equal(dshSchema.properties[field].minimum, 1)
  assert.equal(dshSchema.properties[field].maximum, maximum)
}
const base = { ok: true, action: 'click', output: 'CLICKED target', actionOk: true }
const confirmed = renderDrive({ ...base, confirmed: true, waitAfter: { ok: true, found: true, waitedMs: 22, detail: 'Ready button' } })
assert.match(confirmed, /CLICKED target/)
assert.match(confirmed, /动作成功.*后置条件已确认.*22ms.*Ready button/)
const timedOut = renderDrive({ ...base, confirmed: false, waitAfter: { ok: false, found: false, waitedMs: 1500, error: 'target absent', unknown: false } })
assert.match(timedOut, /动作成功.*后置确认失败.*1500ms.*target absent/)
const unknown = renderDrive({ ...base, confirmed: false, waitAfter: { ok: false, found: false, waitedMs: 1500, unknown: true } })
assert.match(unknown, /动作成功.*后置确认结果未知/)
const failed = renderDrive({ ok: false, action: 'click', actionOk: false, confirmed: false, error: 'click failed', waitAfter: { ok: false, error: 'confirmation skipped' } })
assert.match(failed, /click failed/)
assert.match(failed, /动作未成功.*confirmation skipped/)
assert.doesNotMatch([confirmed, timedOut, unknown, failed].join('\n'), /undefined|NaN|\[object Object\]/)
console.log('PASS waitAfter: strict schemas on both tool surfaces and explicit action/confirmation rendering')
