import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeDriver } from '../lib/driver.mjs'
import { createPolicy } from '../lib/policy.mjs'

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-warm-queue-'))
const eventsFile = path.join(folder, 'events.jsonl')
const settingsFile = path.join(folder, 'settings.json')
const previous = new Map()
const drivers = []
const metrics = {}
const failures = []
function setEnvironment(name, value) {
  previous.set(name, process.env[name])
  process.env[name] = value
}
setEnvironment('DSH_UI_SERVE', '1')
setEnvironment('DSH_UI_SERVE_IDLE_MS', '60000')
setEnvironment('DSH_UI_STALL_MS', '90000')
setEnvironment('DSH_WARM_TEST_EVENTS', eventsFile)
setEnvironment('DSH_WARM_TEST_SETTINGS', settingsFile)
fs.writeFileSync(settingsFile, JSON.stringify({ handshakeDelay: 500 }), 'utf8')

fs.writeFileSync(path.join(folder, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [string]$StepsFile='', [string]$Out='', [int]$DefaultWaitMs=0, [switch]$Status, [switch]$Serve, [string]$ScriptStamp='')
function Log-Event([string]$kind, [string]$name='') {
  $event = @{kind=$kind; name=$name; process=$PID; at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  [System.IO.File]::AppendAllText($env:DSH_WARM_TEST_EVENTS, (($event | ConvertTo-Json -Compress) + [Environment]::NewLine))
}
if (-not $Serve) { Log-Event 'cold-batch'; Write-Output 'RESULT_JSON={"ok":true,"steps":[{"action":"state","ok":true,"lines":["cold"],"count":1}]}'; exit 0 }
Log-Event 'serve-start'
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush=$true
while ($true) {
  $line=$reader.ReadLine()
  if ($null -eq $line) { break }
  $request=$line | ConvertFrom-Json
  if ($request.cmd -eq 'ping') {
    $settings=[System.IO.File]::ReadAllText($env:DSH_WARM_TEST_SETTINGS) | ConvertFrom-Json
    Start-Sleep -Milliseconds $settings.handshakeDelay
    $writer.WriteLine('RESP_JSON={"id":' + $request.id + ',"ok":true,"pong":true}')
    continue
  }
  Log-Event 'begin' $request.name
  if ($request.waitMs -gt 0) { Start-Sleep -Milliseconds $request.waitMs }
  Log-Event 'end' $request.name
  $response=@{id=$request.id;ok=$true;action=$request.action;count=1;lines=@('warm');output='EXECUTED';skipped=0;window='FakeWin'}
  $writer.WriteLine('RESP_JSON=' + ($response | ConvertTo-Json -Compress))
}
`, 'utf8')
fs.writeFileSync(path.join(folder, 'ui-drive.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [string]$Action='', [string]$Name='', [int]$WaitMs=0)
[System.IO.File]::AppendAllText($env:DSH_WARM_TEST_EVENTS, ('{"kind":"cold-oneshot"}' + [Environment]::NewLine))
Write-Output '[Button] cold'
`, 'utf8')

function newDriver() {
  const driver = makeDriver({ scriptsDir: folder, evidenceDir: path.join(folder, 'evidence'), procName: 'FakeProc', defaultWaitMs: 0,
    policy: createPolicy({ approvalFile: '', policyFile: '', estopFile: '', safetyPolicyFile: '' }) })
  drivers.push(driver)
  return driver
}
function events() { return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [] }
async function waitForEvent(name) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (events().some(event => event.kind === 'begin' && event.name === name)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('mock request did not start: ' + name)
}
function verify(name, callback) {
  try { callback() } catch (error) { failures.push(name + ': ' + error.message) }
}

try {
  const cold = newDriver()
  const coldStarted = Date.now()
  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => cold.drive({ action: 'read', name: 'cold-' + index, timeoutMs: 5000 })))
  metrics.concurrentColdMs = Date.now() - coldStarted
  metrics.concurrentColdProcesses = events().filter(event => ['serve-start', 'cold-batch', 'cold-oneshot'].includes(event.kind)).length
  metrics.concurrentColdFallbacks = events().filter(event => event.kind.startsWith('cold-')).length
  verify('cold callers share one ready handshake', () => {
    assert.ok(concurrent.every(result => result.ok), JSON.stringify(concurrent))
    assert.equal(metrics.concurrentColdProcesses, 1)
    assert.equal(metrics.concurrentColdFallbacks, 0)
    assert.equal(events().filter(event => event.kind === 'begin').length, 4)
  })
  const warmDurations = []
  for (let iteration = 0; iteration < 5; iteration++) {
    const started = Date.now()
    assert.equal((await cold.drive({ action: 'read', name: 'fast-' + iteration })).ok, true)
    warmDurations.push(Date.now() - started)
  }
  metrics.warmMedianMs = warmDurations.sort((left, right) => left - right)[2]
  cold.warmShutdown()

  fs.writeFileSync(eventsFile, '', 'utf8')
  fs.writeFileSync(settingsFile, JSON.stringify({ handshakeDelay: 0 }), 'utf8')
  const queued = newDriver()
  assert.equal((await queued.drive({ action: 'read', name: 'ready' })).ok, true)
  const longStarted = Date.now()
  const long = queued.drive({ action: 'click', name: 'long-action', allowSideEffects: true, waitMs: 1200, timeoutMs: 5000 })
  await waitForEvent('long-action')
  const shortStarted = Date.now()
  const short = await queued.drive({ action: 'read', name: 'short-observation', timeoutMs: 150 })
  metrics.queuedReadMs = Date.now() - shortStarted
  const longResult = await long
  metrics.longActionMs = Date.now() - longStarted
  metrics.longActionOk = longResult.ok
  metrics.longActionUnknown = longResult.unknown === true
  metrics.queuedReadOk = short.ok
  metrics.queuedReadNotExecuted = short.notExecuted === true
  metrics.queueProcesses = events().filter(event => event.kind === 'serve-start').length
  verify('queued deadline never kills an in-budget active action', () => {
    assert.equal(longResult.ok, true, JSON.stringify(longResult))
    assert.equal(short.ok, false)
    assert.equal(short.queueTimeout, true, JSON.stringify(short))
    assert.equal(short.notExecuted, true)
    assert.equal(metrics.queueProcesses, 1)
    assert.equal(events().filter(event => event.kind === 'begin' && event.name === 'short-observation').length, 0)
    assert.equal(events().filter(event => event.kind === 'end' && event.name === 'long-action').length, 1)
  })
  assert.equal((await queued.drive({ action: 'read', name: 'after-queue' })).ok, true)
  queued.warmShutdown()

  fs.writeFileSync(eventsFile, '', 'utf8')
  const cancelled = newDriver()
  assert.equal((await cancelled.drive({ action: 'read', name: 'ready' })).ok, true)
  const activeTimeout = cancelled.drive({ action: 'click', name: 'active-timeout', allowSideEffects: true, waitMs: 1000, timeoutMs: 250 })
  await waitForEvent('active-timeout')
  const waitingEffect = cancelled.drive({ action: 'click', name: 'never-sent', allowSideEffects: true, timeoutMs: 3000 })
  const [activeFailure, queuedFailure] = await Promise.all([activeTimeout, waitingEffect])
  assert.equal(activeFailure.unknown, true)
  assert.equal(queuedFailure.notExecuted, true, JSON.stringify(queuedFailure))
  assert.equal(queuedFailure.evidence.executed, false)
  assert.equal(events().filter(event => event.kind === 'begin' && event.name === 'never-sent').length, 0)
  cancelled.warmShutdown()

  fs.writeFileSync(eventsFile, '', 'utf8')
  const capture = newDriver()
  assert.equal((await capture.drive({ action: 'read', name: 'ready' })).ok, true)
  const capturePromise = capture.drive({ action: 'capture', name: 'late-capture', waitMs: 600, timeoutMs: 100 })
  await waitForEvent('late-capture')
  const observedTimeout = await capturePromise
  assert.equal(observedTimeout.ok, false)
  assert.equal(observedTimeout.timeout, true)
  const queuedObservation = await capture.drive({ action: 'read', name: 'behind-capture', timeoutMs: 100 })
  assert.equal(queuedObservation.queueTimeout, true)
  const resumed = await capture.drive({ action: 'read', name: 'after-capture', timeoutMs: 3000 })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(capture.warmStatus().lateResponses, 1)
  assert.equal(events().filter(event => event.kind === 'begin' && event.name === 'late-capture').length, 1)
  assert.equal(events().filter(event => event.kind === 'begin' && event.name === 'behind-capture').length, 0)
  assert.equal(events().filter(event => event.kind === 'serve-start').length, 1)
  capture.warmShutdown()
  console.log(JSON.stringify(metrics))
  if (failures.length) throw new Error(failures.join('\n'))
  console.log('PASS warm queue: shared cold startup, serialized dispatch, isolated queue deadlines and warm reuse')
} finally {
  for (const driver of drivers) driver.warmShutdown()
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(folder, { recursive: true, force: true })
}
