import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url))
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !existsSync(powershell)) {
  console.log('SKIP Windows boundary requires Windows PowerShell 5.1')
  process.exit(0)
}

function run(script, options = {}) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_BOUNDARY_SCRIPTS: scriptsDir, DSH_UI_ALLOW_LOCKED: '' }, ...options,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  return result.stdout.trim()
}

for (const name of ['ui-windows-boundary.ps1', 'ui-drive-batch.ps1', 'ui-drive.ps1']) {
  assert.equal(readFileSync(join(scriptsDir, name)).subarray(0, 3).toString('hex'), 'efbbbf', `${name} has UTF-8 BOM`)
}

const results = JSON.parse(run(`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
foreach ($name in @('ui-windows-boundary.ps1', 'ui-drive-batch.ps1', 'ui-drive.ps1')) {
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS $name), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
. (Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-windows-boundary.ps1')
$actualIdentity = Get-UiProcessIdentity (Get-Process -Id $PID)
$desktopState = Get-UiDesktopState
$dpiAwareness = [UiDriveInputWin32]::GetDpiAwareness()
$policies = @()
foreach ($state in @('unlocked', 'locked', 'secure', 'unknown')) {
  foreach ($setting in @('', '0', 'false', 'yes', 'true', '1')) {
    $policies += @{ state = $state; setting = $setting; code = [UiDriveInputWin32]::PolicyCodeForState($state, $setting) }
  }
}
function Get-AuthenticodeSignature { return [pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null } }
$unsignedIdentity = Get-UiProcessIdentity (Get-Process -Id $PID)
function Get-AuthenticodeSignature { return [pscustomobject]@{ Status = 'HashMismatch'; SignerCertificate = $null } }
$invalidIdentity = Get-UiProcessIdentity (Get-Process -Id $PID)
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1'), [ref]$tokens, [ref]$errors)
foreach ($functionName in @('Test-NeedsForeground', 'Invoke-Step')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
$DefaultWaitMs = 0
function Get-UiDesktopState { return 'locked' }
$locked = Invoke-Step $null ([pscustomobject]@{ action='click'; desktopState='unlocked'; allowLockedComputerUse=$true }) 0 $PID
function Get-UiDesktopState { return 'unknown' }
$env:DSH_UI_ALLOW_LOCKED = 'true'
$unknown = Invoke-Step $null ([pscustomobject]@{ action='click' }) 0 $PID
$readOnly = Invoke-Step $null ([pscustomobject]@{ action='wait'; waitMs=0 }) 0 $PID
$readOnlyActions = @('find','read','tree','state','windows','waitfor','expect','expectwindow','expecttext','waitany','state-live','shot','capture')
$foregroundReadOnly = @($readOnlyActions | Where-Object { Test-NeedsForeground ([pscustomobject]@{ action=$_ }) })
$loop = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.ForStatementAst] -and $node.Extent.Text.Contains('$stepResult = Invoke-Step') }, $true)
$steps = @([pscustomobject]@{ action='first'; stopOnFailure=$true }, [pscustomobject]@{ action='second'; stopOnFailure=$true })
$script:executed = 0
function Invoke-Step { $script:executed++; return @{ ok=$false } }
$results = New-Object System.Collections.ArrayList
. ([scriptblock]::Create($loop.Extent.Text))
$windowOwnerRejected = $false
try { [UiDriveInputWin32]::ResolveWindow($PID, 1, '', [IntPtr]::Zero) | Out-Null } catch { $windowOwnerRejected = $_.Exception.ToString().Contains('window_identity_mismatch') }
@{ actualIdentity=$actualIdentity; desktopState=$desktopState; dpiAwareness=$dpiAwareness; physicalPixels=$script:UiPhysicalPixels; policies=$policies; unsignedIdentity=$unsignedIdentity; invalidIdentity=$invalidIdentity; locked=$locked; unknown=$unknown; readOnly=$readOnly; foregroundReadOnly=$foregroundReadOnly; executed=$executed; resultCount=$results.Count; windowOwnerRejected=$windowOwnerRejected } | ConvertTo-Json -Depth 8 -Compress
`))

assert.ok(['unlocked', 'locked', 'secure', 'unknown'].includes(results.desktopState))
if (results.physicalPixels) assert.equal(results.dpiAwareness, 2)
assert.equal(results.actualIdentity.binaryName.toLowerCase(), 'powershell.exe')
assert.ok(['available', 'none', 'unavailable'].includes(results.actualIdentity.aumidStatus))
if (results.actualIdentity.signatureStatus === 'Valid') {
  assert.equal(results.actualIdentity.publisherVerified, true)
  assert.ok(results.actualIdentity.publisherName)
}
for (const identity of [results.unsignedIdentity, results.invalidIdentity]) {
  assert.ok(identity.company)
  assert.equal(identity.publisherName, '')
  assert.equal(identity.publisherVerified, false)
}
for (const policy of results.policies) {
  const allowed = policy.state === 'unlocked' || policy.state === 'locked' && ['true', '1'].includes(policy.setting)
  assert.equal(policy.code, allowed ? null : `desktop_${policy.state}`)
}
assert.equal(results.locked.ok, false)
assert.equal(results.locked.policyCode, 'desktop_locked')
assert.equal(results.unknown.policyCode, 'desktop_unknown')
assert.equal(results.readOnly.ok, true)
assert.deepEqual(results.foregroundReadOnly, [])
assert.equal(results.executed, 1)
assert.equal(results.resultCount, 1)
assert.equal(results.windowOwnerRejected, true)

for (const entry of ['ui-drive-batch.ps1', 'ui-drive.ps1']) {
  const statusFlag = entry === 'ui-drive-batch.ps1' ? '-Status' : "-Action 'status'"
  const output = run(`& (Join-Path $env:DSH_BOUNDARY_SCRIPTS '${entry}') ${statusFlag} -ProcId ${process.pid}`)
  assert.match(output, /RUNNING pid=/)
  assert.match(output, /DESKTOP (unlocked|locked|secure|unknown)/)
  const encoded = output.match(/IDENT (\S+)/)?.[1]
  assert.ok(encoded)
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64')).binaryName.toLowerCase(), 'node.exe')
}

const fastStatus = run(`
function Add-Type { throw 'fast_status_must_not_compile_native_helper' }
& (Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1') -Status -SkipIdentity -ProcId ${process.pid}
`)
assert.match(fastStatus, new RegExp(`^RUNNING pid=${process.pid} window=`))
assert.doesNotMatch(fastStatus, /IDENT|DESKTOP|HANDLE|RECT/)
const fastMissing = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(scriptsDir, 'ui-drive-batch.ps1'), '-Status', '-SkipIdentity', '-ProcId', '2147483647'], { encoding: 'utf8', timeout: 30000 })
assert.equal(fastMissing.status, 2)
assert.equal(fastMissing.stdout.trim(), 'NOT_RUNNING')

const warm = run(`& (Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1') -Serve -ProcId ${process.pid}`, { input: '{"cmd":"status"}\n' })
const warmStatus = JSON.parse(warm.match(/RESP_JSON=(.*)/)[1])
assert.equal(warmStatus.ok, true, JSON.stringify(warmStatus))
assert.equal(warmStatus.binaryName.toLowerCase(), 'node.exe')
assert.ok(['unlocked', 'locked', 'secure', 'unknown'].includes(warmStatus.desktopState))

const cleanup = JSON.parse(run(`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$helperAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-windows-boundary.ps1'), [ref]$tokens, [ref]$errors)
$nativeSource = $helperAst.Find({ param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('public static class UiDriveInputWin32') }, $true).Value
$nativeSource = $nativeSource.Replace('public static class UiDriveInputWin32 {', 'public static class UiDriveInputWin32 { public static System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>(); public static bool SimulatedLocked;')
$nativeSource = $nativeSource.Replace('public static string GetDesktopState() {', 'public static string ReadNativeDesktopState() {')
$nativeSource = $nativeSource.Replace('public static string PolicyCodeForState', 'public static string GetDesktopState() { return SimulatedLocked ? "locked" : "unlocked"; } public static string PolicyCodeForState')
$nativeSource = $nativeSource.Replace('[DllImport("user32.dll", EntryPoint="mouse_event")] static extern void NativeMouseEvent(uint flags, uint dx, uint dy, uint data, UIntPtr extra);', 'static void NativeMouseEvent(uint flags, uint dx, uint dy, uint data, UIntPtr extra) { Calls.Add("mouse:" + flags); }')
$nativeSource = $nativeSource.Replace('[DllImport("user32.dll", EntryPoint="keybd_event")] static extern void NativeKeyboardEvent(byte key, byte scan, uint flags, UIntPtr extra);', 'static void NativeKeyboardEvent(byte key, byte scan, uint flags, UIntPtr extra) { Calls.Add("key:" + key + ":" + flags); }')
Add-Type $nativeSource
. (Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-windows-boundary.ps1')
$env:DSH_UI_ALLOW_LOCKED = ''
[UiDriveInputWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
[UiDriveInputWin32]::keybd_event(17,0,0,[UIntPtr]::Zero)
[UiDriveInputWin32]::SimulatedLocked = $true
$newInputDenied = $false
try { [UiDriveInputWin32]::keybd_event(65,0,0,[UIntPtr]::Zero) } catch { $newInputDenied = (Get-UiPolicyFailure $_.Exception).policyCode -eq 'desktop_locked' }
[UiDriveInputWin32]::ReleasePressedInputs()
[UiDriveInputWin32]::ReleasePressedInputs()
$untrackedReleaseDenied = $false
try { [UiDriveInputWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero) } catch { $untrackedReleaseDenied = (Get-UiPolicyFailure $_.Exception).policyCode -eq 'desktop_locked' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1'), [ref]$tokens, [ref]$errors)
foreach ($functionName in @('Test-NeedsForeground', 'Invoke-Step')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
[UiDriveInputWin32]::SimulatedLocked = $false
[UiDriveInputWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
[UiDriveInputWin32]::SimulatedLocked = $true
$DefaultWaitMs = 0
$deniedStep = Invoke-Step $null ([pscustomobject]@{ action='click' }) 0 $PID
@{ calls=@([UiDriveInputWin32]::Calls); newInputDenied=$newInputDenied; untrackedReleaseDenied=$untrackedReleaseDenied; deniedStep=$deniedStep } | ConvertTo-Json -Depth 5 -Compress
`))
assert.equal(cleanup.newInputDenied, true)
assert.equal(cleanup.untrackedReleaseDenied, true)
assert.equal(cleanup.deniedStep.policyCode, 'desktop_locked')
assert.deepEqual(cleanup.calls, ['mouse:2', 'key:17:0', 'mouse:4', 'key:17:2', 'mouse:2', 'mouse:4'])
const boundWindow = JSON.parse(run(`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
public class UiDriveInputWin32 { public static bool UsePhysicalPixels() { return true; } public static void ReleasePressedInputs() {} public static bool SetForegroundWindow(IntPtr handle) { return true; } }
public class UiDriveBatchWin32 { public static bool IsIconic(IntPtr handle) { return false; } }
'@
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1'),[ref]$tokens,[ref]$errors)
foreach ($functionName in @('Test-NeedsForeground','Invoke-Step','Test-DenyTarget')) {
  $definition=$ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName },$true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
$DefaultWaitMs=0
$DENY_RE='BlockedName|BlockedAid'
$script:coordinateCalls=0
function Assert-UiInputAllowed {}
function Get-UiDesktopState { return 'unlocked' }
function Get-UiPolicyFailure { return $null }
function Resolve-Window($main,$step,$procId) { return [pscustomobject]@{ Current=[pscustomobject]@{ NativeWindowHandle=$step.winHandle } } }
function Invoke-ClickAt($main) { $script:coordinateCalls++; return [string]$main.Current.NativeWindowHandle }
function Invoke-WithMods($mods,$body) { & $body }
function Invoke-Drag($main) { return [string]$main.Current.NativeWindowHandle }
$original=[pscustomobject]@{ Current=[pscustomobject]@{ NativeWindowHandle=11 } }
$click=Invoke-Step $original ([pscustomobject]@{action='clickat';winHandle=22;waitMs=0}) 0 $PID
$drag=Invoke-Step $original ([pscustomobject]@{action='drag';winHandle=33;waitMs=0}) 1 $PID
$nameDenied=Invoke-Step $original ([pscustomobject]@{action='clickat';name='BlockedName';winHandle=22;waitMs=0}) 2 $PID
$aidDenied=Invoke-Step $original ([pscustomobject]@{action='clickat';aid='BlockedAid';winHandle=22;waitMs=0}) 3 $PID
@{click=$click;drag=$drag;nameDenied=$nameDenied;aidDenied=$aidDenied;coordinateCalls=$script:coordinateCalls} | ConvertTo-Json -Depth 5 -Compress
`))
assert.equal(boundWindow.click.ok, true)
assert.equal(boundWindow.click.output, '22')
assert.equal(boundWindow.drag.ok, true)
assert.equal(boundWindow.drag.output, '33')
assert.equal(boundWindow.nameDenied.policyCode, 'control_denied')
assert.equal(boundWindow.aidDenied.policyCode, 'control_denied')
assert.match(boundWindow.nameDenied.error, /BlockedName/)
assert.match(boundWindow.aidDenied.error, /BlockedAid/)
assert.equal(boundWindow.coordinateCalls, 1)
const sensitivity = JSON.parse(run(`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public class FakeFocusedElement { public static object Element; public static bool Fail; public static object FocusedElement { get { if (Fail) throw new InvalidOperationException("focus_read_failed"); return Element; } } }
'@
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_BOUNDARY_SCRIPTS 'ui-drive-batch.ps1'),[ref]$tokens,[ref]$errors)
$definition=$ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-FocusedSensitivity' },$true)
. ([scriptblock]::Create($definition.Extent.Text))
$UIA=[FakeFocusedElement]
$SECRET_NAME_RE='password|token|secret'
$noDetail=Get-FocusedSensitivity ''
$noElement=Get-FocusedSensitivity 'ordinary'
[FakeFocusedElement]::Fail=$true
$unavailable=Get-FocusedSensitivity 'ordinary'
[FakeFocusedElement]::Fail=$false
[FakeFocusedElement]::Element=[pscustomobject]@{Current=[pscustomobject]@{Name='ordinary';AutomationId='field';IsPassword=$false}}
$safe=Get-FocusedSensitivity 'ordinary'
[FakeFocusedElement]::Element=[pscustomobject]@{Current=[pscustomobject]@{Name='ordinary';AutomationId='field';IsPassword=$true}}
$password=Get-FocusedSensitivity 'ordinary'
$broken=[pscustomobject]@{Name='ordinary';AutomationId='field'}
$broken | Add-Member -MemberType ScriptProperty -Name IsPassword -Value { throw 'password_read_failed' }
[FakeFocusedElement]::Element=[pscustomobject]@{Current=$broken}
$propertyFailure=Get-FocusedSensitivity 'ordinary'
$namedSecret=Get-FocusedSensitivity 'password field'
@{noDetail=$noDetail;noElement=$noElement;unavailable=$unavailable;safe=$safe;password=$password;propertyFailure=$propertyFailure;namedSecret=$namedSecret} | ConvertTo-Json -Depth 5 -Compress
`))
for (const result of [sensitivity.noDetail, sensitivity.noElement, sensitivity.unavailable, sensitivity.propertyFailure]) {
  assert.equal(result.secretFocused, null)
  assert.equal(result.sensitivityUnknown, true)
}
assert.equal(sensitivity.safe.secretFocused, false)
assert.equal(sensitivity.safe.sensitivityUnknown, false)
assert.equal(sensitivity.password.secretFocused, true)
assert.equal(sensitivity.namedSecret.secretFocused, true)
console.log('PASS Windows PowerShell 5.1 boundary: syntax/BOM, signed identity, AUMID, desktop gates, fail-fast, status and warm protocol')
