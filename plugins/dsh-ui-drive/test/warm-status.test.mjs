import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !fs.existsSync(powershell)) {
  console.log('SKIP warm status requires Windows PowerShell 5.1')
  process.exit(0)
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-warm-status-'))
const eventsFile = path.join(folder, 'events.jsonl')
const previous = new Map()
for (const [name, value] of Object.entries({ DSH_NO_ENV_FALLBACK: '1', DSH_UI_SERVE: '1', DSH_UI_CONTROL_POLICY: '', DSH_WARM_STATUS_EVENTS: eventsFile })) {
  previous.set(name, process.env[name])
  process.env[name] = value
}

fs.writeFileSync(path.join(folder, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [long]$WinHandle=0, [switch]$Status, [switch]$SkipIdentity, [switch]$Serve, [string]$ScriptStamp='')
function Log-Event($event) {
  [System.IO.File]::AppendAllText($env:DSH_WARM_STATUS_EVENTS, (($event | ConvertTo-Json -Compress) + [Environment]::NewLine))
}
function Identity([int]$targetPid) { return @{exeCanonical=('test-' + $targetPid + '.exe');binaryName='test.exe';publisherVerified=$false} }
if ($Status) {
  Log-Event @{kind='cold-status';procId=$ProcId;title=$WindowName;handle=$WinHandle;skipIdentity=[bool]$SkipIdentity}
  Write-Output ('RUNNING pid=' + $ProcId + ' window=' + $WindowName)
  if (-not $SkipIdentity) {
    Write-Output ('HANDLE ' + $WinHandle)
    $identityJson = (Identity $ProcId) | ConvertTo-Json -Compress
    Write-Output ('IDENT ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($identityJson)))
    Write-Output 'DESKTOP unlocked'
    Write-Output 'RECT 640x480 @-20,30'
  }
  exit 0
}
Log-Event @{kind='serve-start'}
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush=$true
while ($true) {
  $line=$reader.ReadLine()
  if ($null -eq $line) { break }
  $request=$line | ConvertFrom-Json
  if ($request.cmd -eq 'ping') { $writer.WriteLine('RESP_JSON={"id":' + $request.id + ',"ok":true,"pong":true}'); continue }
  if ($request.cmd -eq 'status') {
    Log-Event @{kind='warm-status';procId=$request.procId;procName=$request.procName;title=$request.winTitle;handle=$request.winHandle}
    if ($request.winTitle -eq 'delayed-status') { Start-Sleep -Milliseconds 120 }
    if ($request.winTitle -eq 'never-return') { Start-Sleep -Seconds 30 }
    if ($request.winTitle -eq 'unavailable') { $response=@{id=$request.id;ok=$false;error='identity unavailable'} }
    elseif ($request.procId -eq 9999) { $response=@{id=$request.id;ok=$false;error='NOT_RUNNING'} }
    else { $response=@{id=$request.id;ok=$true;pid=$request.procId;window=$request.winTitle;handle=$request.winHandle;identity=(Identity $request.procId);desktopState='unlocked';rect=@{w=640;h=480;x=-20;y=30}} }
  } else {
    Log-Event @{kind='begin';name=$request.name}
    if ($request.waitMs -gt 0) { Start-Sleep -Milliseconds $request.waitMs }
    Log-Event @{kind='end';name=$request.name}
    $response=@{id=$request.id;ok=$true;action=$request.action;count=1;lines=@('warm');output='EXECUTED';skipped=0;window='FakeWin'}
  }
  $writer.WriteLine('RESP_JSON=' + ($response | ConvertTo-Json -Depth 8 -Compress))
}
`, 'utf8')

const { makeDriver } = await import('../lib/driver.mjs')
const { createPolicy } = await import('../lib/policy.mjs')
const driver = makeDriver({ scriptsDir: folder, evidenceDir: path.join(folder, 'evidence'), procName: 'FakeProc', windowName: '', clientExe: '', lockPath: '', defaultWaitMs: 0,
  policy: createPolicy({ approvalFile: '', policyFile: '', estopFile: '', safetyPolicyFile: '' }) })
const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
const statusFields = result => Object.fromEntries(['running', 'pid', 'title', 'handle', 'identity', 'desktopState', 'rect'].map(key => [key, result[key]]))
async function waitForEvent(name, kind = 'begin') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (events().some(event => event.kind === kind && (event.name === name || event.title === name))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('mock request did not start: ' + name)
}

try {
  const selectors = { procId: 101, winTitle: 'First window', winHandle: 401 }
  const cold = await driver.status(selectors)
  assert.equal(cold.running, true)
  assert.equal(events().filter(event => event.kind === 'serve-start').length, 0)
  assert.equal((await driver.drive({ action: 'read', name: 'ready' })).ok, true)
  const warm = await driver.status(selectors)
  assert.deepEqual(statusFields(warm), statusFields(cold))
  assert.equal(events().filter(event => event.kind === 'warm-status').length, 1)
  assert.equal(events().filter(event => event.kind === 'cold-status').length, 1)
  assert.deepEqual(events().find(event => event.kind === 'warm-status'), { kind: 'warm-status', procId: 101, procName: 'FakeProc', title: 'First window', handle: 401 })

  const switched = await driver.status({ procId: 202, winTitle: 'Second window', winHandle: 402 })
  assert.equal(switched.pid, 202)
  assert.equal(switched.title, 'Second window')
  assert.equal(switched.handle, 402)
  assert.equal(switched.identity.exeCanonical, 'test-202.exe')
  const missing = await driver.status({ procId: 9999 })
  assert.equal(missing.running, false)
  assert.notEqual(missing.unknown, true)
  const unavailable = await driver.status({ ...selectors, winTitle: 'unavailable' })
  assert.equal(unavailable.unknown, true)
  assert.match(unavailable.error, /identity unavailable/)

  const fast = await driver.status({ ...selectors, includeIdentity: false })
  assert.equal(fast.running, true)
  assert.equal(fast.identity, null)
  assert.equal(events().filter(event => event.kind === 'cold-status' && event.skipIdentity).length, 1)

  const active = driver.drive({ action: 'click', name: 'active-effect', allowSideEffects: true, waitMs: 1000, timeoutMs: 5000 })
  await waitForEvent('active-effect')
  const busy = await driver.status({ ...selectors, timeoutMs: 3000 })
  assert.equal(busy.running, true)
  assert.equal(events().filter(event => event.kind === 'cold-status').length, 3)
  assert.equal((await active).ok, true)
  assert.equal(events().filter(event => event.kind === 'end' && event.name === 'active-effect').length, 1)

  const delayedStatus = driver.status({ ...selectors, winTitle: 'delayed-status', timeoutMs: 400 })
  await waitForEvent('delayed-status', 'warm-status')
  const followingEffect = driver.drive({ action: 'click', name: 'after-successful-status', allowSideEffects: true, waitMs: 650, timeoutMs: 3000 })
  assert.equal((await delayedStatus).running, true)
  assert.equal((await followingEffect).ok, true)
  assert.equal(events().filter(event => event.kind === 'serve-start').length, 1)

  const statusTimeout = driver.status({ ...selectors, winTitle: 'never-return', timeoutMs: 300 })
  await waitForEvent('never-return', 'warm-status')
  const queuedEffect = driver.drive({ action: 'click', name: 'behind-status', allowSideEffects: true, timeoutMs: 3000 })
  const timedOut = await statusTimeout
  assert.equal(timedOut.unknown, true)
  assert.equal(timedOut.timeout, true)
  assert.equal(driver.warmStatus().alive, false)
  const cancelledEffect = await queuedEffect
  assert.equal(cancelledEffect.notExecuted, true)
  assert.equal(cancelledEffect.killed, true)
  assert.equal(cancelledEffect.evidence.executed, false)
  assert.equal(events().filter(event => event.kind === 'begin' && event.name === 'behind-status').length, 0)
  assert.equal((await driver.drive({ action: 'read', name: 'after-timeout', timeoutMs: 3000 })).ok, true)
  assert.equal(events().filter(event => event.kind === 'serve-start').length, 2)
  const scriptPath = path.join(folder, 'ui-drive-batch.ps1')
  const scriptInfo = fs.statSync(scriptPath)
  fs.utimesSync(scriptPath, scriptInfo.atime, new Date(scriptInfo.mtimeMs + 2000))
  assert.equal((await driver.status(selectors)).running, true)
  assert.equal(events().filter(event => event.kind === 'cold-status').length, 4)
  assert.equal(events().filter(event => event.kind === 'serve-start').length, 2)

  const boundaryScript = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_WARM_STATUS_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$dispatch=$ast.Find({param($node) $node -is [System.Management.Automation.Language.SwitchStatementAst] -and $node.Condition.Extent.Text -eq '$cmd'},$true)
$clause=$dispatch.Clauses | Where-Object { $_.Item1.Value -eq 'status' }
$body=$clause.Item2.Extent.Text
$statusCode=[scriptblock]::Create($body.Substring(1,$body.Length-2))
Add-Type @"
using System;
public static class UiDriveInputWin32 {
  public static int TargetPid;
  public static string TargetTitle;
  public static bool UsePhysicalPixels() { return true; }
  public static IntPtr ResolveWindow(int processId, long handle, string title, IntPtr fallback) {
    TargetPid=processId; TargetTitle=title; return handle == 0 ? fallback : new IntPtr(handle);
  }
  public static string GetWindowTitle(IntPtr handle) { return "Window " + handle; }
}
public static class UiDriveBatchWin32 {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static bool GetWindowRect(IntPtr handle, out RECT rectangle) {
    rectangle=new RECT { Left=-20, Top=30, Right=620, Bottom=510 }; return true;
  }
}
"@
function Get-Process {
  param([int]$Id,[string]$Name,[string]$ErrorAction)
  if ($Id -eq 9999) { return $null }
  if (-not $Id) { $Id=$(if ($Name -eq 'DefaultProc') {600} else {700}) }
  return [pscustomobject]@{Id=$Id;MainWindowHandle=$(if ($Id -eq 909) {[IntPtr]::Zero} else {[IntPtr]($Id*10)})}
}
$script:identityCalls=0
function Get-UiProcessIdentity($process) {
  $script:identityCalls++
  return @{exeCanonical=('test-' + $process.Id + '.exe');generation=$script:identityCalls}
}
function Get-UiDesktopState { return 'unlocked' }
$script:ConfiguredProcId=500
$ProcName='DefaultProc'; $WindowName='Default window'; $WinHandle=0
$main='unchanged-main'; $procId=500
$results=@()
foreach ($request in @(
  @{procId=101;winTitle='First window';winHandle=401},
  @{procId=202;winTitle='Second window';winHandle=402},
  @{procId=0;winTitle='Default selection';winHandle=0},
  @{procId=101;winTitle='First window';winHandle=401},
  @{procId=909;winTitle='';winHandle=0},
  @{procId=9999;winTitle='';winHandle=0},
  @{procId=0;procName='OtherProc';winTitle='';winHandle=0}
)) {
  $req=[pscustomobject]$request
  $resp=@{ok=$false}
  . $statusCode
  $results+=@{response=$resp;targetPid=[UiDriveInputWin32]::TargetPid;targetTitle=[UiDriveInputWin32]::TargetTitle;configuredPid=$script:ConfiguredProcId;main=$main;procId=$procId}
}
$results | ConvertTo-Json -Depth 8 -Compress
`
  const boundary = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(boundaryScript, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, DSH_WARM_STATUS_SCRIPT: path.resolve(import.meta.dirname, '../scripts/ui-drive-batch.ps1') },
  })
  assert.equal(boundary.status, 0, boundary.stderr || boundary.error?.message || boundary.stdout)
  const results = JSON.parse(boundary.stdout)
  assert.deepEqual(results.slice(0, 4).map(result => result.targetPid), [101, 202, 600, 101])
  assert.deepEqual(results.slice(0, 4).map(result => result.targetTitle), ['First window', 'Second window', 'Default selection', 'First window'])
  assert.deepEqual(results.slice(0, 4).map(result => result.response.handle), [401, 402, 6000, 401])
  assert.deepEqual(results.slice(0, 4).map(result => result.response.identity.generation), [1, 2, 3, 4])
  assert.deepEqual(results[0].response.rect, { w: 640, h: 480, x: -20, y: 30 })
  assert.equal(results[4].response.window, 'NONE')
  assert.equal(results[4].response.rect, undefined)
  assert.equal(results[5].response.error, 'NOT_RUNNING')
  assert.equal(results[6].response.pid, 700)
  assert.ok(results.every(result => result.configuredPid === 500 && result.procId === 500 && result.main === 'unchanged-main'))
  console.log('PASS warm status: cold startup, fresh selectors, field parity, busy isolation, fast launch and hung-status recovery')
} finally {
  driver.warmShutdown()
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(folder, { recursive: true, force: true })
}
