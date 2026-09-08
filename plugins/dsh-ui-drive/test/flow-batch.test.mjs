// dsh-ui-drive 批量引擎单测（离线，不需要客户端、不启动 PowerShell）
//
// 覆盖三件事：
//  1. flow() 把整个步骤序列交给一个进程（batch），而不是每步一个进程；
//  2. batch 脚本无输出时的行为是「明确失败」，不是静默通过；
//  3. 副作用护栏与非法动作在本地就被拦下（不浪费进程）。
//
// 做法：用假的 scriptsDir + 假 batch 脚本（一个把预置 JSON 写到 -Out 的
// 真脚本），让 driver 走真实的进程调用路径，同时完全离线可控。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-test-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-evidence-'))

/** 写一个假 batch 脚本：把 payload 写到 -Out 指定的文件，并打印 RESULT_JSON=。 */
function installFakeBatch(payload) {
  const json = JSON.stringify(payload === null ? null : payload)
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($StepsFile -and $env:FAKE_CAPTURE_STEPS) { [System.IO.File]::WriteAllText($env:FAKE_CAPTURE_STEPS, [System.IO.File]::ReadAllText($StepsFile), (New-Object System.Text.UTF8Encoding($false))) }
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_BATCH_PAYLOAD = json
}

function newDriver() {
  // DSH_UI_SERVE=0：本单测只验批量路径，常驻进程另有专项
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

// ---------------------------------------------------------------- 1. batch 一次进程跑完整个序列
{
  const fake = {
    ok: true,
    elapsedMs: 321,
    pid: 42,
    window: 'Fake',
    steps: [
      { step: 1, action: 'find', ok: true, found: true, detail: '[Button] name="A" enabled=True' },
      { step: 2, action: 'read', ok: true, count: 2, lines: ['[Text] "x"', '[Button] "y"'] },
      { step: 3, action: 'wait', ok: true, waitedMs: 50 },
      { step: 4, action: 'expect', ok: true, found: true, detail: '[Button] name="B" enabled=True' },
      { step: 5, action: 'shot', ok: true, path: join(evidenceDir, 'final.png'), w: 800, h: 600 },
    ],
  }
  installFakeBatch(fake)
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-batch', steps: [
    { action: 'find', name: 'A' },
    { action: 'read', match: 'x' },
    { action: 'wait', waitMs: 50 },
    { action: 'expect', name: 'B', expectEnabled: true },
    { action: 'shot', label: 'final' },
  ] })
  check('flow passed=1（只有 expect 计入断言）', v.passed === 1, 'passed=' + v.passed)
  check('flow failed=0', v.failed === 0, 'failed=' + v.failed)
  check('flow 带 batch 耗时', v.elapsedMs === 321, 'elapsedMs=' + v.elapsedMs)
  check('flow 引擎标记 batch', v.engine === 'batch')
  check('transcript 每步都有 ok 字段', v.transcript.every((t) => typeof t.ok === 'boolean'))
  check('find 步透传 found/detail', v.transcript[0].found === true && /A/.test(v.transcript[0].detail))
  check('read 步截断到 50 行以内', Array.isArray(v.transcript[1].lines) && v.transcript[1].lines.length <= 50)
  check('shot 步记录 finalShot', v.finalShot && v.finalShot.endsWith('final.png'))
  check('steps.json 落盘', existsSync(v.stepsJson))
  const saved = JSON.parse(readFileSync(v.stepsJson, 'utf8'))
  check('steps.json engine=batch', saved.engine === 'batch')
  check('steps.json batchElapsedMs 记录', saved.batchElapsedMs === 321)
  check('batch 临时步骤文件已清理', !existsSync(join(v.evidenceDir, 'batch-steps.json')))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 2. batch 无输出 = 显式失败
{
  installFakeBatch(null)
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-batch-fail', steps: [{ action: 'find', name: 'A' }, { action: 'expect', name: 'B' }] })
  check('batch 无输出时 flow.ok=false', v.ok === false)
  check('batch 无输出时 failed=步数', v.failed === 2, 'failed=' + v.failed)
  check('batch 无输出时 transcript 带 error', v.transcript.every((t) => t.error))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 3. 护栏与非法动作本地拦截
{
  installFakeBatch({ ok: true, elapsedMs: 1, steps: [{ step: 1, action: 'find', ok: true, found: true, detail: '[Button] "A"' }] })
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-guard', steps: [
    { action: 'click', name: '保存' },
    { action: 'bogus', name: 'X' },
    { action: 'find', name: 'A' },
  ] })
  check('副作用动作被本地拦截', v.transcript[0].ok === false && /allowSideEffects/.test(v.transcript[0].error || ''))
  check('非法动作被本地拦截', v.transcript[1].ok === false && /非法动作/.test(v.transcript[1].error || ''))
  check('failed=2（两个被拦截的步骤）', v.failed === 2, 'failed=' + v.failed)
  check('合法只读步骤仍执行', v.transcript[2].ok === true)
  d.warmShutdown()
}

// ---------------------------------------------------------------- 4. 默认值
{
  const d = newDriver()
  check('默认 waitMs 从 1200 降到 250', d.config.defaultWaitMs === 250, 'got=' + d.config.defaultWaitMs)
  check('暴露 batch 引擎', typeof d.batch === 'function')
  d.warmShutdown()
}

// ---------------------------------------------------------------- 5. batch 步骤文件内容规则
{
  installFakeBatch({ ok: true, elapsedMs: 2, steps: [{ step: 1, action: 'find', ok: true, found: false }] })
  const capture = join(evidenceDir, 'captured-steps.json')
  process.env.FAKE_CAPTURE_STEPS = capture
  const d = newDriver()
  await d.batch({ steps: [{ action: 'find', name: 'A', waitMs: 0 }, { action: 'read', match: 'z', waitMs: 0 }], tmpDir: evidenceDir })
  const captured = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null
  check('batch 步骤文件是 JSON 数组', Array.isArray(captured) && captured.length === 2, JSON.stringify(captured))
  check('batch 透传 waitMs=0', captured && captured[0].waitMs === 0)
  check('batch 只保留白名单字段', captured && Object.keys(captured[0]).sort().join(',') === 'action,name,waitMs', JSON.stringify(captured && captured[0]))
  delete process.env.FAKE_CAPTURE_STEPS
  d.warmShutdown()
}

// ---------------------------------------------------------------- 6. 副作用动作绝不因常驻进程异常而重放
{
  // 假 serve：起来后立刻退出 → 请求永远等不到响应，warm 判定进程死亡
  // 注意：param() 必须是脚本第一行，否则 PowerShell 直接忽略（$Action/$Name 为 null）；
  // 字符串拼接要用双引号，单引号里 $Name 不会展开。
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve,[string]$Action='',[string]$Name='')
if ($Serve) { exit 0 }
if ($Out) { [System.IO.File]::WriteAllText($Out, '{"ok":true,"steps":[]}', (New-Object System.Text.UTF8Encoding($false))) }
if ($Action -eq 'find') { Write-Output ("FOUND [Button] name=" + $Name + " enabled=True") } else { Write-Output 'RESULT_JSON={"ok":true,"steps":[]}' }
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  // 回退路径走的是 ui-drive.ps1（一次性脚本），fake 里也要能回一个 find 结果
  const oneShot = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='')
if ($Action -eq 'find') { Write-Output ("FOUND [Button] name=" + $Name + " enabled=True") } else { Write-Output 'NOT_FOUND' }
`
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), oneShot, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  delete process.env.DSH_UI_SERVE
  process.env.DSH_UI_SERVE_IDLE_MS = '60000'
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
  const r = await d.drive({ action: 'click', name: '保存', allowSideEffects: true })
  check('常驻进程异常时副作用动作返回失败', r.ok === false, JSON.stringify(r))
  check('副作用动作不重放（无 fallback 结果）', r.output === undefined, JSON.stringify(r))
  const r2 = await d.drive({ action: 'find', name: 'A' })
  check('只读动作在常驻进程不可用时仍能回退成功', r2.ok === true, JSON.stringify(r2))
  d.warmShutdown()
  process.env.DSH_UI_SERVE = '0'
  delete process.env.DSH_UI_SERVE_IDLE_MS
}

// ---------------------------------------------------------------- 7. 动态界面原语：动作名归一化 + 新字段透传
{
  installFakeBatch({ ok: true, elapsedMs: 5, steps: [
    { step: 1, action: 'waitfor', ok: true, found: true, waitedMs: 320, detail: '[Button] name="A"' },
    { step: 2, action: 'type', ok: true, output: 'TYPED "1234{ENTER}" into box' },
    { step: 3, action: 'drag', ok: true, output: 'drag 10,10 -> 200,10 (12 steps)' },
  ] })
  const capture = join(evidenceDir, 'captured-dynamic.json')
  process.env.FAKE_CAPTURE_STEPS = capture
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-dynamic', allowSideEffects: true, steps: [
    { action: 'waitFor', name: 'A', waitFor: { ms: 3000, state: 'enabled' } }, // 大小写混杂
    { action: 'type', aid: 'box', value: '1234{ENTER}', allowSideEffects: true },
    { action: 'drag', fromX: 10, fromY: 10, toX: 200, toY: 10, allowSideEffects: true },
  ] })
  const captured = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null
  check('waitFor 归一化成 waitfor', captured && captured[0].action === 'waitfor', JSON.stringify(captured && captured[0]))
  check('waitFor 参数透传', captured && captured[0].waitFor && captured[0].waitFor.ms === 3000 && captured[0].waitFor.state === 'enabled')
  check('type 动作透传 keys/value', captured && captured[1].action === 'type' && captured[1].value === '1234{ENTER}')
  check('drag 坐标透传', captured && captured[2].action === 'drag' && captured[2].fromX === 10 && captured[2].toX === 200)
  check('waitfor 计入断言 passed', v.passed === 1, 'passed=' + v.passed)
  delete process.env.FAKE_CAPTURE_STEPS
  d.warmShutdown()
}

// ---------------------------------------------------------------- 8. waitfor 条件不满足 = 断言失败（不是静默通过）
{
  installFakeBatch({ ok: false, elapsedMs: 9, steps: [
    { step: 1, action: 'waitfor', ok: false, found: false, waitedMs: 3000, error: '条件未满足: state=appear target=/X 超时 3000ms' },
  ] })
  const d = newDriver()
  const v = await d.flow({ tag: 'unit-waitfor-fail', steps: [{ action: 'waitfor', name: 'X', waitFor: { ms: 3000 } }] })
  check('waitfor 超时 → failed=1', v.failed === 1 && v.ok === false, JSON.stringify({ ok: v.ok, failed: v.failed }))
  check('waitfor 超时 transcript 带 waitedMs/error', v.transcript[0].waitedMs === 3000 && /超时/.test(v.transcript[0].error || ''))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 9. 新动作在一次性进程路径下自动走批量引擎
{
  installFakeBatch({ ok: true, elapsedMs: 3, steps: [{ step: 1, action: 'windows', ok: true, count: 2, lines: ['[Window] "a"', '[Window] "b"'] }] })
  delete process.env.DSH_UI_SERVE
  process.env.DSH_UI_SERVE = '0'
  const d = newDriver()
  const r = await d.drive({ action: 'windows' })
  check('windows 动作走批量引擎', r.ok === true && r.count === 2, JSON.stringify(r))
  check('windows 是只读动作（不需要 allowSideEffects）', r.ok === true)
  const r2 = await d.drive({ action: 'type', name: 'box', value: 'x' })
  check('type 仍受副作用护栏保护', r2.ok === false && /allowSideEffects/.test(r2.error || ''), JSON.stringify(r2))
  d.warmShutdown()
}

// ---------------------------------------------------------------- 10. ui_state 快照透传
{
  installFakeBatch({ ok: true, elapsedMs: 7, steps: [
    { step: 1, action: 'state', ok: true, window: '主窗口', focusedWindow: '主窗口', focused: '[Edit] name="搜索" enabled=True', count: 2, lines: ['#0 [Button] "登录"', '#1 [Edit] "搜索"'] },
  ] })
  process.env.DSH_UI_SERVE = '0'
  const d = newDriver()
  const r = await d.drive({ action: 'state', max: 2 })
  check('state 返回窗口/焦点/控件清单', r.ok === true && r.window === '主窗口' && /Edit/.test(r.focused) && r.count === 2, JSON.stringify(r))
  const v = await d.flow({ tag: 'unit-state', steps: [{ action: 'state', max: 2 }] })
  check('state 是只读动作（不需要 allowSideEffects）', v.ok === true && v.transcript[0].focused !== undefined, JSON.stringify(v.transcript[0]))
  d.warmShutdown()
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive flow batch unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
