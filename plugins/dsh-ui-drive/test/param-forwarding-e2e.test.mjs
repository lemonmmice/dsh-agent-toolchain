/**
 * 端到端证明：`ui_drive` 声明的参数真的到达驱动，而不是在 MCP handler 里蒸发。
 *
 * 为什么需要它：源码级护栏（mcp-toolface-consistency）只能证明"写法是 {...args}"，
 * 证不了**运行时真的转发**。本仓纪律是端到端哨兵优先（W0/W2 都这么验）。
 *
 * 判据怎么设计才干净（关键）：
 *   驱动对 `index/inAid/inName/waitFor/keys` 有**明确的行为分支**（driver.mjs:983-988）——
 *   这些字段非默认值时**必须走批量引擎**（一次性脚本不认识它们）。
 *   而批量引擎会把这一步的字段写进 `batch-steps.json` 再交给 `ui-drive-batch.ps1`。
 *   于是：
 *     · 参数被丢掉 → 驱动认为"没有特殊字段" → 走一次性脚本 → **绝不会**产出 batch-steps.json
 *     · 参数到达   → 驱动判定 needsBatch → **一定**产出 batch-steps.json，且里面能看到这些字段
 *   所以"batch-steps.json 里出现了 index/inAid/waitFor"就是"参数到达"的充分证据。
 *   （这也是 snapshotId 那条测试的同款思路：找一个只有"透传成功"才会出现的可观测结果。）
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ui-drive-fwd-'))
const evidenceDir = join(dir, 'evidence')
mkdirSync(evidenceDir, { recursive: true })

// SERVE=0 强制走一次性脚本路径（否则会尝试常驻进程），和 mcp-snapshot-gate 的做法一致
process.env.DSH_UI_SERVE = '0'
delete process.env.DSH_UI_APP_POLICY
delete process.env.DSH_UI_ESTOP_FILE

/** 一次性脚本：总是失败，逼驱动回退到批量引擎（否则不会走到我们要观察的分支）。 */
const oneShot = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='',[string]$Value='',[int]$WaitMs=250,[switch]$Ascii,[string]$Match='',[string]$Out='')
Write-Output 'NOT_RUNNING'
exit 0
`

/** 批量脚本：把收到的 -StepsFile 内容原样复制到捕获文件（这就是"驱动最终交给执行器的东西"）。 */
const batchCapture = join(dir, 'captured-steps.json')
const batchShim = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[string]$Tag='')
if ($StepsFile -and (Test-Path $StepsFile)) {
  Copy-Item -LiteralPath $StepsFile -Destination ${JSON.stringify(batchCapture)} -Force
}
Write-Output '--- RESULT ---'
exit 0
`

writeFileSync(join(dir, 'ui-drive.ps1'), oneShot, 'utf8')
writeFileSync(join(dir, 'ui-drive-batch.ps1'), batchShim, 'utf8')

const { makeDriver } = await import('file://' + join(here, '..', 'lib', 'driver.mjs').replace(/\\/g, '/'))

const drv = makeDriver({
  scriptsDir: dir,
  procName: 'dummy-proc',
  windowName: 'dummy-win',
  clientExe: '',
  evidenceDir,
})

// 对照 1：只给"一次性脚本能理解"的字段 → 不应触发批量引擎（证明观察点本身是有效的）
await drv.drive({ action: 'click', name: 'A', allowSideEffects: true })
check('对照：无特殊字段时【不】走批量引擎（没有 batch-steps.json）', !existsSync(batchCapture),
  '若这条为真说明观察点无效——任何调用都会产出捕获文件')

// 被验证项：这些正是历史上被 ui_drive 的 handler 丢掉的那批字段
const sent = {
  action: 'click',
  name: '确定',
  index: 2,
  inAid: 'MainGrid',
  inName: '主面板',
  waitFor: { ms: 3000, state: 'enabled', match: '确定' },
  state: 'enabled',
  keys: '{ENTER}',
  fromX: 10,
  fromY: 20,
  toX: 110,
  toY: 220,
  steps: 8,
  holdMs: 150,
  allowSideEffects: true,
}
await drv.drive(sent)

check('特殊字段存在时【走了】批量引擎（batch-steps.json 已产出 = 参数到达驱动）',
  existsSync(batchCapture), '缺失说明字段在到达驱动前就被丢掉了')

if (existsSync(batchCapture)) {
  const raw = readFileSync(batchCapture, 'utf8')
  let steps = null
  try { steps = JSON.parse(raw) } catch { /* ignore */ }
  const step = Array.isArray(steps) ? steps[0] : (steps && steps.steps ? steps.steps[0] : null)
  check('batch-steps.json 可解析出步骤', !!step, raw.slice(0, 300))
  if (step) {
    for (const k of ['index', 'inAid', 'inName', 'waitFor', 'state', 'keys', 'fromX', 'fromY', 'toX', 'toY', 'steps', 'holdMs']) {
      check(`字段 ${k} 到达执行器`, step[k] !== undefined, JSON.stringify(step))
    }
    check('字段值正确（index=2）', step.index === 2, JSON.stringify(step.index))
    check('waitFor 嵌套对象完整到达', !!step.waitFor && step.waitFor.match === '确定' && step.waitFor.ms === 3000,
      JSON.stringify(step.waitFor))
  }
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive parameter forwarding reaches the driver')
