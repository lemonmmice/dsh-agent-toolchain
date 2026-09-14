// dsh-ui-drive 单测：ui_tree 的空树必须是**观测失败**而不是"空成功"（F-015 数据层修复）
//
// 为什么修在数据层而不是渲染层：
//   `mcp/server.mjs:88-89` 明写「renderDrive/renderState 只被 DSH 插件的 output.render 消费，
//   它们加的'下一步'文本永远到不了 MCP 客户端」。也就是说渲染层的诚实性修复**只对 DSH 面有效**；
//   MCP 面的消费者拿到的是 driver 返回的**原始对象**。
//   旧 driver 在探针没拿到节点时返回 `{ok:true, text:'', truncated:false}` —— 两个面都会把它当成功。
//
// 做法：假 ui-probe.ps1（离线，不碰客户端、不注入任何进程）。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-tree-test-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-tree-evid-'))

/**
 * 写一个假探针：按 FAKE_PROBE_MODE 输出不同内容。
 *
 * ⚠ 必须写 **UTF-8 BOM**：PowerShell 5.1 对无 BOM 的 .ps1 按系统 ANSI 码页（本机 GBK）解码，
 * 脚本里的中文会被解坏（实测输出 "涓荤獥鍙?"）。这正是 scripts/check.mjs 规则 6 防的那个坑 ——
 * 本测试第一次跑就撞上了，所以这里显式加 BOM，和仓库里真实 .ps1 的写法保持一致。
 */
writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '\uFEFF' + `param([string]$Action='',[int]$MaxDepth=8)
# 'empty' = 探针**跑到了**（有结果区）但结果为空 —— 这才是"空树"
if ($env:FAKE_PROBE_MODE -eq 'empty') {
  Write-Output '--- RESULT ---'
  exit 0
}
# 'nomarker' = 探针**压根没跑起来**（连结果区都没有，例如缺 DSH_SNOOP_DIR 时脚本在第 28 行就 throw）
if ($env:FAKE_PROBE_MODE -eq 'nomarker') { exit 0 }
if ($env:FAKE_PROBE_MODE -eq 'nodes') {
  Write-Output '--- RESULT ---'
  Write-Output 'Window "主窗口"'
  Write-Output '  [Button] "登录" aid="btnLogin"'
  exit 0
}
exit 0
`, 'utf8')
// driver 的其它路径也要求这些脚本存在
writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), '# stub\n', 'utf8')
writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')

process.env.DSH_UI_SERVE = '0'

// ------------------------------------------------- 1. 空树 → ok:false + 明确说"不等于没有控件"
// 注意与下面第 3 段的区别：这里探针**跑到了**（有结果区、结果为空）= 空树；
// 探针连结果区都没有（脚本提前 throw）= 没跑起来（probeNotRun）。两者过去被混成一句话。
{
  process.env.FAKE_PROBE_MODE = 'empty'
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
  const r = await d.tree({ maxDepth: 3 })
  check('空树 → ok:false（旧实现是 ok:true，两面都会当成功）', r.ok === false, JSON.stringify(r).slice(0, 220))
  check('空树 → 打上 emptyTree 标记（可与"探针崩了"区分）', r.emptyTree === true, JSON.stringify(r))
  check('空树 → error 说明是空树而非无错误', /空树/.test(String(r.error)), String(r.error).slice(0, 160))
  check('空树 → hint 明说"不等于界面上没有控件"', /不等于/.test(String(r.hint)) && /没有控件/.test(String(r.hint)), String(r.hint).slice(0, 220))
  check('空树 → hint 给出交叉验证的下一步', /ui_observe\(state\)/.test(String(r.hint)), String(r.hint).slice(0, 260))
  check('空树 → 不谎报截断', r.truncated === false, JSON.stringify(r.truncated))
  d.warmShutdown()
}

// ------------------------------------------------- 3. 探针**没跑起来** → 必须与"空树"区分开（2026-09-11 真机）
// 真机事实：本机 DSH_SNOOP_DIR 未配置 → ui-probe.ps1 第 28 行 throw → stdout 里没有结果区。
// 旧代码把这种情况说成"探针执行成功但一个节点都没拿到" —— 把配置缺失怪到客户端头上。
{
  process.env.FAKE_PROBE_MODE = 'nomarker'
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
  const r = await d.tree({ maxDepth: 3 })
  check('探针未运行 → probeNotRun=true（不是 emptyTree）', r.probeNotRun === true && r.emptyTree !== true, JSON.stringify({ p: r.probeNotRun, e: r.emptyTree }))
  check('探针未运行 → 错误里说清"探针不可行"而不是"界面空"', /探针/.test(String(r.error)) && !/界面/.test(String(r.error).slice(0, 60)), String(r.error).slice(0, 200))
  check('探针未运行 → injectorUnavailable 里保留原始分类', !!(r.injectorUnavailable && r.injectorUnavailable.probeNotRun === true), JSON.stringify(r.injectorUnavailable))
  d.warmShutdown()
}

// ------------------------------------------------- 2. 有节点 → 正常成功
{
  process.env.FAKE_PROBE_MODE = 'nodes'
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
  const r = await d.tree({ maxDepth: 3 })
  check('有节点 → ok:true', r.ok === true, JSON.stringify(r).slice(0, 200))
  check('有节点 → text 含探针输出', /主窗口/.test(String(r.text)) && /btnLogin/.test(String(r.text)), String(r.text).slice(0, 160))
  check('有节点 → 不带 emptyTree 标记', r.emptyTree === undefined, JSON.stringify(r.emptyTree))
  d.warmShutdown()
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_PROBE_MODE

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-ui-drive ui_tree 空树（数据层诚实性，两面通用）')
process.exit(failures ? 1 : 0)
