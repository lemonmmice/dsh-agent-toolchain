/**
 * 防回归（2026-10-14 用户决定）：**dsh-ui-drive 不再调用任何视觉模型做"界面描述"**。
 *
 * 背景：ui_launch / ui_drive(shot) / ui_observe 原先会在 describe=true 时把截图 base64 发给
 * 远程视觉模型（小米 mimo-v2.5 @ api.xiaomimimo.com）换一段界面文字描述。真机实测那一次调用
 * ≈24s（2026-10-14 15:16 冷启动：窗口就绪 19.6s + 截图 1.3s + 视觉 24.4s），而用户要的是
 * "一步拿到截图"——看图交给**有读图能力的调用方**（read_image）。
 *
 * 这条测试守住三件事：
 *   ① 两个面（DSH 插件面 index.js / MCP 面 server.mjs）都**不再有** describeImage / UI_STATE_PROMPT 调用；
 *   ② **visualFallback 的视觉定位保留**（locateImage）——那是"UIA 找不到控件时的坐标兜底"，不是描述；
 *   ③ 删掉的是**远程描述调用**，不是 vision.mjs 整个模块（locateImage 仍在，driver 仍在用它）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const read = (p) => readFileSync(REPO + p, 'utf8')

const dshFace = read('plugins/dsh-ui-drive/index.js')
const mcpFace = read('mcp/server.mjs')

for (const [face, source] of [['DSH 面 index.js', dshFace], ['MCP 面 server.mjs', mcpFace]]) {
  assert.ok(!/describeImage/.test(source), face + ' 不应再调用 describeImage（远程视觉描述已移除）')
  assert.ok(!/UI_STATE_PROMPT/.test(source), face + ' 不应再引用 UI_STATE_PROMPT（描述提示词已不再使用）')
  assert.ok(!/makeVision/.test(source), face + ' 不应再构造 vision 实例（描述链路已移除）')
  // attachVision 是 MCP 面原先的描述接线函数，删掉后不应复活
  assert.ok(!/attachVision/.test(source), face + ' 不应再有 attachVision 接线')
}

// ② visualFallback 的定位能力必须还在（用户明确要求保留）
const visionModule = read('plugins/dsh-ui-drive/lib/vision.mjs')
assert.ok(/export function makeVision/.test(visionModule), 'vision.mjs 仍应导出 makeVision（供 locateImage 用）')
assert.ok(/locateImage/.test(visionModule), 'vision.mjs 应仍提供 locateImage（visualFallback 依赖它）')
const driver = read('plugins/dsh-ui-drive/lib/driver.mjs')
assert.ok(/executeVisualFallback/.test(driver), 'driver 仍应接 visualFallback')
assert.ok(/makeVision/.test(driver), 'driver 仍应自建 vision（visualFallback 用）')

// ③ ui_launch 的默认行为：就绪后**默认截图**（includeScreenshot=false 才跳过），且不描述
assert.ok(/args\.includeScreenshot !== false/.test(dshFace), 'DSH 面 ui_launch 应默认截图（includeScreenshot !== false）')
assert.ok(/args\.includeScreenshot !== false/.test(mcpFace), 'MCP 面 ui_launch 应默认截图（includeScreenshot !== false）')

console.log('PASS no-vision-describe: 两面都不再调用远程视觉描述；visualFallback 的视觉定位保留；ui_launch 默认出图')
