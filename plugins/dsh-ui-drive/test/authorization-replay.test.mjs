import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeDriver } from '../lib/driver.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { contentHash, validateReplay } from '../lib/protocol.mjs'
import { validateEnvelope } from '../lib/evidence.mjs'

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-authorization-replay-'))
const scriptsDir = path.join(folder, 'scripts')
const evidenceDir = path.join(folder, 'evidence')
const sentinel = path.join(folder, 'executed.jsonl')
const identityFile = path.join(folder, 'identity.json')
const approvalFile = path.join(folder, 'approvals.json')
const baseIdentity = { exe: 'C:/App/client.exe', exeCanonical: 'c:/app/client.exe', binaryName: 'client.exe' }
const observedSecret = 'plain-token-observe-862913'
const previousEnvironment = new Map()
const drivers = []
fs.mkdirSync(scriptsDir)
fs.writeFileSync(identityFile, JSON.stringify(baseIdentity), 'utf8')

function setEnvironment(key, value) {
  if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key])
  process.env[key] = value
}
setEnvironment('DSH_UI_SERVE', '0')
setEnvironment('DSH_AUTH_TEST_SENTINEL', sentinel)
setEnvironment('DSH_AUTH_TEST_IDENTITY', identityFile)
setEnvironment('DSH_AUTH_TEST_APPROVAL_FILE', approvalFile)
setEnvironment('DSH_AUTH_TEST_STATE_SECRET', '')
setEnvironment('DSH_AUTH_TEST_OMIT_SECRET_FOCUS', '')

fs.writeFileSync(path.join(scriptsDir, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [long]$WinHandle=0, [string]$StepsFile='', [string]$Out='', [int]$DefaultWaitMs=0, [switch]$Status, [switch]$Serve)
if ($Status) {
  Write-Output 'RUNNING pid=4242 window=FakeWin'
  Write-Output 'HANDLE 777'
  Write-Output 'DESKTOP unlocked'
  $identity = [System.IO.File]::ReadAllText($env:DSH_AUTH_TEST_IDENTITY)
  Write-Output ('IDENT ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($identity)))
  Write-Output 'RECT 100x80 @10,20'
  exit 0
}
$source = [System.IO.File]::ReadAllText($StepsFile) | ConvertFrom-Json
$results = @()
$position = 0
foreach ($step in $source) {
  $position++
  $result = @{ step=$position; action=$step.action; ok=$true; output='EXECUTED'; window='FakeWin' }
  if ($step.action -in @('click', 'clickat', 'setvalue', 'key', 'type', 'pattern')) {
    $event = @{ action=$step.action; name=$step.name; pid=$ProcId; handle=$step.winHandle }
    [System.IO.File]::AppendAllText($env:DSH_AUTH_TEST_SENTINEL, (($event | ConvertTo-Json -Compress) + [Environment]::NewLine))
    if ($step.name -eq 'RevokeAfterFirst') {
      $stored = [System.IO.File]::ReadAllText($env:DSH_AUTH_TEST_APPROVAL_FILE)
      $revoked = $stored -replace '"revokedAt"\\s*:\\s*null', ('"revokedAt":"' + [DateTime]::UtcNow.ToString('o') + '"')
      [System.IO.File]::WriteAllText($env:DSH_AUTH_TEST_APPROVAL_FILE, $revoked)
    }
    if ($step.name -eq 'Disappearing') { $result.ok=$false; $result.notFound=$true; $result.error='not found' }
    if ($step.secret) { $result.output = 'SECRET-ECHO:' + [string]$step.value + ':' + [string]$step.keys }
  }
  if ($step.action -eq 'find') { $result.found=($step.name -ne 'VisualMissing'); $result.detail='target' }
  if ($step.action -in @('read', 'state', 'state-live')) {
    $result.count=1; $result.lines=@('[Button] Open'); $result.skipped=0; $result.scanned=1; $result.focused='Open'; $result.secretFocused=$false; $result.desktopState='unlocked'
    if ($env:DSH_AUTH_TEST_STATE_SECRET) { $result.lines=@('[Edit] PlainToken Value=' + $env:DSH_AUTH_TEST_STATE_SECRET); $result.focused='PlainToken Value=' + $env:DSH_AUTH_TEST_STATE_SECRET }
    if ($env:DSH_AUTH_TEST_OMIT_SECRET_FOCUS -eq '1') { $result.Remove('secretFocused') }
  }
  if ($step.action -eq 'capture') {
    [System.IO.File]::WriteAllBytes($step.out, [byte[]]@(1,2,3,4))
    $result.path=$step.out; $result.w=100; $result.h=80; $result.state='visible'; $result.captureMethod='print'; $result.coordinateSpace='window'; $result.physicalPixels=$true; $result.windowHandle=777; $result.pid=4242; $result.rect=@{x=10;y=20;w=100;h=80}
  }
  $results += $result
}
$response = @{ ok=$true; steps=$results; elapsedMs=1; pid=4242; window='FakeWin' }
Write-Output ('RESULT_JSON=' + ($response | ConvertTo-Json -Depth 20 -Compress))
`, 'utf8')
fs.writeFileSync(path.join(scriptsDir, 'ui-drive.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [string]$Action='', [string]$Name='', [string]$Aid='', [string]$Value='', [int]$WaitMs=0, [switch]$Ascii, [string]$Match='', [string]$Out='')
if ($Action -eq 'read') { Write-Output '[Button] Open'; exit 0 }
if ($Action -eq 'find') { Write-Output 'FOUND target'; exit 0 }
[System.IO.File]::AppendAllText($env:DSH_AUTH_TEST_SENTINEL, ('{"action":"' + $Action + '","name":"oneshot"}' + [Environment]::NewLine))
Write-Output 'CLICKED target'
`, 'utf8')
fs.writeFileSync(path.join(scriptsDir, 'ui-probe.ps1'), '', 'utf8')

function makePolicy(file = '') {
  return createPolicy({ approvalFile: file, policyFile: '', safetyPolicyFile: '', estopFile: '' })
}
function newDriver(policy = makePolicy()) {
  const driver = makeDriver({
    scriptsDir, evidenceDir, procName: 'FakeProc', clientExe: 'C:/App/client.exe', policy,
    defaultWaitMs: 0, defaultTimeoutMs: 10000,
    vision: { locateImage: async () => ({ ok: true, x: 20, y: 30, confidence: 0.95 }) },
  })
  drivers.push(driver)
  return driver
}
function events() {
  return fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
}
function resetEvents() { fs.rmSync(sentinel, { force: true }) }
function grant(driver, options = {}) {
  const result = driver.grantApproval({ identity: baseIdentity, sessionId: 'session-1', actions: ['click', 'clickat', 'setvalue', 'key', 'type'], ...options })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.approval.id
}
function checkObservation(observation) {
  assert.match(observation.actionId, /^act_/)
  assert.match(observation.observationId, /^obs_/)
  const { digest, ...body } = observation
  assert.equal(digest, contentHash({ ...body, observationId: null, actionId: null, at: null }))
}

try {
  const onceDriver = newDriver()
  const onceId = grant(onceDriver, { scope: 'once' })
  const onceArgs = { action: 'click', name: 'Once', approvalId: onceId, sessionId: 'session-1', allowSideEffects: true }
  const first = await onceDriver.drive(onceArgs)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.match(first.actionId, /^act_/)
  assert.equal(events().length, 1)
  assert.equal((await onceDriver.drive(onceArgs)).policyCode, 'approval_invalid')
  assert.equal(events().length, 1)
  assert.equal((await onceDriver.drive({ ...onceArgs, approvalId: 'apv_unknown' })).policyCode, 'approval_invalid')
  assert.equal(events().length, 1)

  resetEvents()
  const onceFlow = newDriver()
  const flowOnceId = grant(onceFlow, { scope: 'once' })
  const onceFlowResult = await onceFlow.flow({
    steps: [{ action: 'click', name: 'First' }, { action: 'click', name: 'Second' }, { action: 'click', name: 'Third' }],
    approvalId: flowOnceId, sessionId: 'session-1', allowSideEffects: true, failFast: false, tag: 'once-flow',
  })
  assert.equal(onceFlowResult.ok, false)
  assert.equal(onceFlowResult.engine, 'guarded-sequence')
  assert.equal(events().length, 1)
  assert.equal(onceFlowResult.transcript.length, 2)
  assert.equal(onceFlowResult.transcript[1].policyCode, 'approval_invalid')

  resetEvents()
  const revokeDriver = newDriver(makePolicy(approvalFile))
  const persistentId = grant(revokeDriver, { scope: 'persistent' })
  const revoked = await revokeDriver.flow({
    steps: [{ action: 'click', name: 'RevokeAfterFirst' }, { action: 'click', name: 'Second' }, { action: 'click', name: 'Third' }],
    approvalId: persistentId, sessionId: 'session-1', allowSideEffects: true, failFast: false, tag: 'revoked-flow',
  })
  assert.equal(revoked.ok, false)
  assert.equal(events().length, 1)
  assert.equal(revoked.transcript.length, 2)
  assert.equal(revoked.transcript[1].policyCode, 'approval_revoked', fs.readFileSync(approvalFile, 'utf8'))

  resetEvents()
  const secretDriver = newDriver()
  const secretId = grant(secretDriver)
  const secret = await secretDriver.flow({
    steps: [{ action: 'setvalue', name: 'Input', value: 'private-value-6291', keys: 'private-keys-8472' }],
    approvalId: secretId, sessionId: 'session-1', secret: true, allowSideEffects: true, tag: 'secret-flow',
  })
  assert.equal(secret.ok, true, JSON.stringify(secret))
  for (const file of [secret.stepsJson, secret.replayPath]) {
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(text.includes('private-value-6291'), false, file)
    assert.equal(text.includes('private-keys-8472'), false, file)
  }
  assert.equal(validateReplay(JSON.parse(fs.readFileSync(secret.replayPath, 'utf8'))).ok, false)

  setEnvironment('DSH_AUTH_TEST_STATE_SECRET', observedSecret)
  const stateControl = await newDriver().drive({ action: 'state' })
  assert.equal(JSON.stringify(stateControl.lines).includes(observedSecret), true)
  assert.equal(stateControl.focused.includes(observedSecret), true)
  const secretObserved = await secretDriver.drive({
    action: 'setvalue', name: 'PlainToken', value: observedSecret, secret: true, observe: true,
    approvalId: secretId, sessionId: 'session-1', allowSideEffects: true,
  })
  assert.equal(secretObserved.ok, true, JSON.stringify(secretObserved))
  assert.equal(JSON.stringify(secretObserved).includes(observedSecret), false)
  assert.deepEqual(secretObserved.observe.lines, ['[redacted]'])
  assert.equal(secretObserved.observe.focused, '[redacted]')
  assert.deepEqual(secretObserved.observationRecord.lines, ['[redacted]'])
  assert.equal(secretObserved.observationRecord.focused, '[redacted]')
  checkObservation(secretObserved.observationRecord)
  setEnvironment('DSH_AUTH_TEST_STATE_SECRET', '')
  const afterSecret = await secretDriver.drive({ action: 'click', name: 'AfterToken', approvalId: secretId, sessionId: 'session-1', allowSideEffects: true })
  assert.equal(afterSecret.ok, true, JSON.stringify(afterSecret))

  setEnvironment('DSH_AUTH_TEST_OMIT_SECRET_FOCUS', '1')
  const unknownFocus = await secretDriver.secretFocusNow()
  assert.equal(unknownFocus.ok, false, JSON.stringify(unknownFocus))
  assert.equal(unknownFocus.unknown, true)
  assert.equal(unknownFocus.secret, null)
  setEnvironment('DSH_AUTH_TEST_OMIT_SECRET_FOCUS', '')
  const knownFocus = await secretDriver.secretFocusNow()
  assert.equal(knownFocus.ok, true, JSON.stringify(knownFocus))
  assert.equal(knownFocus.unknown, false)
  assert.equal(knownFocus.secret, false)

  resetEvents()
  const replayDriver = newDriver()
  const replayApproval = grant(replayDriver)
  const source = await replayDriver.flow({
    steps: [{ action: 'state' }, { action: 'click', name: 'ReplayClick', approvalId: replayApproval, sessionId: 'session-1' }],
    allowSideEffects: true, tag: 'replay-source',
  })
  assert.equal(source.ok, true, JSON.stringify(source))
  assert.equal(events().length, 1)
  const saved = JSON.parse(fs.readFileSync(source.replayPath, 'utf8'))
  assert.equal(validateReplay(saved).ok, true, JSON.stringify(saved))
  assert.equal(saved.replayId, source.replayId)
  assert.equal(saved.steps.some(step => step.approvalId || step.sessionId || step.procId || step.winHandle), false)
  checkObservation(source.transcript[0].observationRecord)
  for (const entry of source.transcript) assert.match(entry.actionId, /^act_/)
  const replayed = await replayDriver.replay({ replayPath: source.replayPath, allowSideEffects: true, approvalId: replayApproval, sessionId: 'session-1' })
  assert.equal(replayed.ok, true, JSON.stringify(replayed))
  assert.equal(replayed.sourceReplayId, source.replayId)
  assert.notEqual(replayed.replayId, source.replayId)
  assert.equal(JSON.parse(fs.readFileSync(replayed.replayPath, 'utf8')).replayId, replayed.replayId)
  assert.equal(events().length, 2)
  const tamperedPath = path.join(folder, 'tampered.json')
  saved.steps[1].name = 'Tampered'
  fs.writeFileSync(tamperedPath, JSON.stringify(saved), 'utf8')
  const tampered = await replayDriver.replay({ replayPath: tamperedPath, allowSideEffects: true })
  assert.equal(tampered.ok, false)
  assert.match(tampered.error, /哈希/)
  assert.equal(events().length, 2)
  fs.writeFileSync(identityFile, JSON.stringify({ exe: 'C:/Other/app.exe', exeCanonical: 'c:/other/app.exe', binaryName: 'app.exe' }), 'utf8')
  const mismatch = await replayDriver.replay({ replayPath: source.replayPath, allowSideEffects: true })
  assert.equal(mismatch.policyCode, 'replay_identity_mismatch')
  assert.equal(events().length, 2)
  fs.writeFileSync(identityFile, JSON.stringify(baseIdentity), 'utf8')

  resetEvents()
  const visualDriver = newDriver()
  const visualApproval = grant(visualDriver, { scope: 'once' })
  const visual = await visualDriver.drive({ action: 'click', name: 'VisualMissing', visualFallback: true, approvalId: visualApproval, sessionId: 'session-1', allowSideEffects: true })
  assert.equal(visual.ok, true, JSON.stringify(visual))
  assert.equal(visual.visualFallback.source, 'vision-coordinate')
  assert.deepEqual(events().map(event => event.action), ['clickat'])
  assert.equal((await visualDriver.drive({ action: 'click', name: 'OnceMore', approvalId: visualApproval, sessionId: 'session-1', allowSideEffects: true })).policyCode, 'approval_invalid')
  assert.equal(events().length, 1)

  resetEvents()
  const disappearedApproval = grant(visualDriver, { scope: 'once' })
  const disappeared = await visualDriver.drive({ action: 'click', name: 'Disappearing', visualFallback: true, approvalId: disappearedApproval, sessionId: 'session-1', allowSideEffects: true })
  assert.equal(disappeared.ok, false)
  assert.equal(disappeared.policyCode, 'approval_invalid')
  assert.deepEqual(events().map(event => event.action), ['click'])

  const evidenceFiles = fs.readdirSync(evidenceDir, { recursive: true }).filter(name => String(name).endsWith('evidence.jsonl'))
  const envelopes = evidenceFiles.flatMap(name => fs.readFileSync(path.join(evidenceDir, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
  assert.ok(envelopes.length > 0)
  for (const envelope of envelopes) assert.equal(validateEnvelope(envelope).ok, true, JSON.stringify(envelope))
  const firstEvidence = envelopes.find(envelope => envelope.id === first.evidenceId)
  assert.equal(firstEvidence.protocol.actionId, first.actionId)
  for (const result of [secretObserved, afterSecret]) {
    const envelope = envelopes.find(entry => entry.id === result.evidenceId)
    assert.ok(envelope)
    assert.equal(JSON.stringify(envelope).includes(observedSecret), false)
  }
  assert.equal(JSON.stringify(envelopes).includes(observedSecret), false)
  console.log('PASS authorization/replay e2e: once, revocation, flow guards, redaction, bound replay, visual fallback and evidence hashes')
} finally {
  for (const driver of drivers) driver.warmShutdown()
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(folder, { recursive: true, force: true })
}
