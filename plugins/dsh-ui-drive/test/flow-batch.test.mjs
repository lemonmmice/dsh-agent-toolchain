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

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive flow batch unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
