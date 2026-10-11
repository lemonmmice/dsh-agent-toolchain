import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const folder = mkdtempSync(join(tmpdir(), 'dsh-capture-mode-'))
const previous = { ...process.env }
for (const name of Object.keys(process.env)) if (name.startsWith('DSH_')) delete process.env[name]
Object.assign(process.env, { DSH_NO_ENV_FALLBACK: '1', DSH_UI_SERVE: '1', DSH_CAPTURE_TEST_REQUESTS: join(folder, 'requests.jsonl') })
const { makeDriver } = await import('../lib/driver.mjs')
writeFileSync(join(folder, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [switch]$Serve, [string]$ScriptStamp='')
$reader=New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.Encoding]::UTF8)
$writer=New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(),(New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush=$true
while ($null -ne ($line=$reader.ReadLine())) {
  $request=$line | ConvertFrom-Json
  if ($request.cmd -eq 'ping') { $writer.WriteLine('RESP_JSON={"id":'+$request.id+',"ok":true,"pong":true}'); continue }
  [System.IO.File]::AppendAllText($env:DSH_CAPTURE_TEST_REQUESTS,$line+[Environment]::NewLine)
  [System.IO.File]::WriteAllText($request.out,'synthetic-image')
  $method='print'
  if ($request.captureMode -eq 'screen') { $method='screen' }
  $result=@{ id=$request.id; ok=$true; path=$request.out; w=120; h=80; captureMethod=$method; windowHandle=$request.winHandle; rect=@{x=5;y=7;w=120;h=80};coordinateSpace='window';physicalPixels=$true;state='visible' }
  $writer.WriteLine('RESP_JSON='+($result | ConvertTo-Json -Compress))
}
`, 'utf8')
writeFileSync(join(folder, 'ui-drive.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [string]$Action='', [string]$Out='', [int]$WaitMs=0, [string]$CaptureMode='print')
[System.IO.File]::WriteAllText($Out,'synthetic-image')
$metadata=@{captureMethod=$CaptureMode;windowHandle=42;physicalPixels=$true;coordinateSpace='window'} | ConvertTo-Json -Compress
Write-Output ('SHOT '+$Out+' 120x80')
Write-Output ('SHOT_META='+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($metadata)))
`, 'utf8')
const driver = makeDriver({ scriptsDir: folder, evidenceDir: folder, procName: 'FakeCaptureOnly', windowName: '', clientExe: '', lockPath: '' })
const requests = () => readFileSync(process.env.DSH_CAPTURE_TEST_REQUESTS, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
try {
  const first = await driver.drive({ action: 'shot', procId: 777, winHandle: 999, captureMode: 'screen', label: 'same-label' })
  const second = await driver.drive({ action: 'shot', procId: 777, winHandle: 999, label: 'same-label' })
  assert.equal(first.ok, true)
  assert.equal(first.captureMethod, 'screen')
  assert.equal(first.windowHandle, 999)
  assert.equal(first.physicalPixels, true)
  assert.equal(first.coordinateSpace, 'window')
  assert.equal(second.captureMethod, 'print')
  assert.notEqual(first.path, second.path)
  assert.equal(requests()[0].captureMode, 'screen')
  assert.equal(requests()[0].winHandle, 999)
  const capture = await driver.drive({ action: 'capture', procId: 777, winHandle: 999, captureMode: 'screen' })
  assert.equal(capture.captureMethod, 'screen')
  const before = requests().length
  for (const args of [{ action: 'shot', captureMode: 'desktop' }, { action: 'click', captureMode: 'screen', allowSideEffects: true }]) {
    const result = await driver.drive(args)
    assert.equal(result.ok, false)
    assert.equal(result.notExecuted, true)
  }
  assert.equal(requests().length, before)
  driver.warmShutdown()
  const cold = await driver.drive({ action: 'shot', captureMode: 'screen', label: 'same-label' })
  assert.equal(cold.ok, true)
  assert.equal(cold.captureMethod, 'screen')
  assert.equal(cold.windowHandle, 42)
  assert.notEqual(cold.path, first.path)
  const batchSource = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  const shotBranch = batchSource.slice(batchSource.indexOf("      'shot' {"), batchSource.indexOf("      'capture' {"))
  assert.match(shotBranch, /Resolve-Window \$main \$step \$procId/)
  assert.match(shotBranch, /Save-Shot \$shotWindow/)
  assert.match(batchSource, /if \(\$captureMode -ne 'screen'\)/)
  console.log('PASS captureMode: warm/cold forwarding, owned HWND routing, metadata, invalid-mode refusal and fresh unique paths')
} finally {
  driver.warmShutdown()
  driver.releaseLock()
  for (const name of Object.keys(process.env)) if (name.startsWith('DSH_')) delete process.env[name]
  Object.assign(process.env, previous)
  rmSync(folder, { recursive: true, force: true })
}
