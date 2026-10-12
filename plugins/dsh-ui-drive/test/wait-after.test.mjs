// @heavy-test —— 真机/真进程重型用例（2026-10-12 全量剖面：单文件 >10s；14 个重型文件占全量 78% 时间）。默认层不跑，`npm test -- --all` 跑全量。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !fs.existsSync(powershell)) {
  console.log('SKIP wait-after requires Windows PowerShell 5.1')
  process.exit(0)
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-wait-after-'))
const eventsFile = path.join(folder, 'events.jsonl')
const previous = new Map()
for (const [name, value] of Object.entries({ DSH_NO_ENV_FALLBACK: '1', DSH_UI_SERVE: '1', DSH_UI_CONTROL_POLICY: '', DSH_WAIT_AFTER_EVENTS: eventsFile })) {
  previous.set(name, process.env[name])
  process.env[name] = value
}
fs.writeFileSync(path.join(folder, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [switch]$Serve, [string]$ScriptStamp='')
$reader=New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.Encoding]::UTF8)
$writer=New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(),(New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush=$true
while ($true) {
  $line=$reader.ReadLine()
  if ($null -eq $line) { break }
  $request=$line | ConvertFrom-Json
  if ($request.cmd -eq 'ping') { $writer.WriteLine('RESP_JSON={"id":' + $request.id + ',"ok":true,"pong":true}'); continue }
  [System.IO.File]::AppendAllText($env:DSH_WAIT_AFTER_EVENTS,$line+[Environment]::NewLine)
  $response=@{id=$request.id;ok=$true;action=$request.action;output='EXECUTED'}
  if ($request.action -eq 'waitfor') {
    if ($request.aid -eq 'hung') { Start-Sleep -Seconds 5 }
    $response.found=($request.state -ne 'gone')
    $response.waitedMs=12
    $response.detail='result control'
    if ($request.aid -eq 'not-confirmed') { $response.ok=$false; $response.found=$false; $response.error='condition not met' }
  }
  if ($request.name -eq 'failed-action') { $response.ok=$false; $response.error='action failed' }
  $writer.WriteLine('RESP_JSON='+($response | ConvertTo-Json -Compress))
}
`, 'utf8')
const { makeDriver } = await import('../lib/driver.mjs')
const { createPolicy } = await import('../lib/policy.mjs')
const driver = makeDriver({ scriptsDir: folder, evidenceDir: path.join(folder, 'evidence'), procName: 'FixtureProc', windowName: '', clientExe: '', lockPath: '',
  policy: createPolicy({ approvalFile: '', policyFile: '', estopFile: '', safetyPolicyFile: '' }) })
const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
const resetEvents = () => fs.writeFileSync(eventsFile, '', 'utf8')
const action = { action: 'click', name: 'action-target', procId: 101, winHandle: 801, allowSideEffects: true }
try {
  const success = await driver.drive({ ...action, observe: true, waitAfter: { aid: 'result' } })
  assert.equal(success.ok, true)
  assert.equal(success.actionOk, true)
  assert.equal(success.confirmed, true)
  assert.equal(success.waitAfter.waitedMs, 12)
  assert.equal(success.waitAfter.detail, 'result control')
  assert.equal(success.waitAfter.error, null)
  assert.equal(success.observe, undefined)
  assert.deepEqual(events().map(entry => entry.action), ['click', 'waitfor'])
  assert.equal(events()[0].waitMs, 0)
  assert.equal(events()[1].ms, 1500)
  assert.equal(events()[1].interval, 50)
  assert.equal(events()[1].procId, 101)
  assert.equal(events()[1].winHandle, 801)

  resetEvents()
  await driver.drive({ ...action, waitMs: 123, waitAfter: { name: 'result', winHandle: 802, state: 'enabled', ms: 200, interval: 30 } })
  assert.equal(events()[0].waitMs, 123)
  assert.equal(events()[1].winHandle, 802)
  assert.equal(events()[1].procId, 101)
  assert.equal(events()[1].state, 'enabled')
  resetEvents()
  const gone = await driver.drive({ ...action, waitAfter: { aid: 'gone-result', state: 'gone', winTitle: 'New window' } })
  assert.equal(gone.confirmed, true)
  assert.equal(gone.waitAfter.found, false)
  assert.equal(events()[1].winHandle, undefined)
  assert.equal(events()[1].winTitle, 'New window')
  assert.equal(events()[1].procId, 101)

  resetEvents()
  await driver.drive({ ...action, winTitle: 'Action window', waitAfter: { aid: 'result', winTitle: '' } })
  assert.equal(events()[1].winHandle, undefined)
  assert.equal(events()[1].winTitle, '')
  resetEvents()
  await driver.drive({ ...action, waitAfter: { aid: 'result', winTitle: 'Explicit window', winHandle: 803 } })
  assert.equal(events()[1].winHandle, 803)
  assert.equal(events()[1].winTitle, 'Explicit window')

  resetEvents()
  const failed = await driver.drive({ ...action, name: 'failed-action', waitAfter: { aid: 'result' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.actionOk, false)
  assert.equal(failed.confirmed, false)
  assert.deepEqual(events().map(entry => entry.action), ['click'])
  resetEvents()
  const notConfirmed = await driver.drive({ ...action, waitAfter: { aid: 'not-confirmed' } })
  assert.equal(notConfirmed.ok, true)
  assert.equal(notConfirmed.actionOk, true)
  assert.equal(notConfirmed.confirmed, false)
  assert.equal(notConfirmed.waitAfter.error, 'condition not met')
  assert.equal(notConfirmed.evidence.executed, true)
  assert.deepEqual(events().map(entry => entry.action), ['click', 'waitfor'])

  for (const waitAfter of [null, [], {}, { aid: 7 }, { aid: 'result', action: 'click' }, { aid: 'result', procId: 999 }, { aid: 'result', allowSideEffects: true }, { aid: 'result', inAid: 'container' }, { aid: 'result', state: 'bad' }, { aid: 'result', ms: 0 }, { aid: 'result', ms: 1.5 }, { aid: 'result', ms: 30001 }, { aid: 'result', interval: 1001 }, { aid: 'result', winHandle: -1 }]) {
    resetEvents()
    const rejected = await driver.drive({ ...action, waitAfter })
    assert.equal(rejected.invalidWaitAfter, true, JSON.stringify(waitAfter))
    assert.equal(rejected.notExecuted, true)
    assert.equal(rejected.evidence.executed, false)
    assert.equal(events().length, 0)
  }
  resetEvents()
  assert.equal((await driver.drive({ action: 'read', procId: 101, waitAfter: { aid: 'result' } })).invalidWaitAfter, true)
  assert.equal(events().length, 0)
  const secret = await driver.drive({ ...action, secret: true, waitAfter: { aid: 'result' } })
  assert.equal(secret.waitAfter.detail, '[redacted]')
  resetEvents()
  const timeout = await driver.drive({ ...action, waitAfter: { aid: 'hung', ms: 1 } })
  assert.equal(timeout.ok, true)
  assert.equal(timeout.actionOk, true)
  assert.equal(timeout.confirmed, false)
  assert.equal(timeout.waitAfter.unknown, true)
  assert.equal(timeout.evidence.executed, true)
  assert.deepEqual(events().map(entry => entry.action), ['click', 'waitfor'])
  console.log('PASS wait-after: targeted confirmation, no full state, fixed targets, validation, timing and no action replay')
} finally {
  driver.warmShutdown()
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(folder, { recursive: true, force: true })
}
