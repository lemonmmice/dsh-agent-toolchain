import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !existsSync(powershell)) {
  console.log('SKIP target refs require Windows PowerShell 5.1')
  process.exit(0)
}
const script = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_REF_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Is-RectUsable','New-TargetRef','Resolve-TargetRef','Resolve-Target','Wait-Target','Invoke-Step','Test-NeedsForeground','Invoke-DoubleClickElement','Test-DoubleClickHit')) {
  $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
Add-Type @'
using System;
public class UiDriveInputWin32 { public static int MouseCalls; public static bool FailMouse; public static bool UsePhysicalPixels() { return true; } public static void ReleasePressedInputs() {} public static bool SetForegroundWindow(IntPtr handle) { return true; } public static bool SetCursorPos(int x,int y) { return true; } public static void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra) { MouseCalls++; if (FailMouse) throw new InvalidOperationException("mouse interrupted"); } }
public class UiDriveBatchWin32 { public static bool IsIconic(IntPtr handle) { return false; } }
'@
function Make-Element([int]$runtime,[int]$handle=0) {
  $element=[pscustomobject]@{Runtime=$runtime;Parent=$null;Current=[pscustomobject]@{ProcessId=10;NativeWindowHandle=$handle;Name='Target';AutomationId='target';IsOffscreen=$false;IsEnabled=$true;ControlType=[pscustomobject]@{ProgrammaticName='ControlType.Button'};BoundingRectangle=[pscustomobject]@{X=10;Y=20;Width=100;Height=30}}}
  $element | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return @(1,$this.Runtime) }
  return $element
}
function Get-TargetRefParent($element) { return $element.Parent }
function Get-DoubleClickHitTarget { return $script:hitElement }
function Resolve-Window($main,$step,$procId) { return $main }
function Find-Elements { throw 'full-tree-query-forbidden' }
function Find-ElementsByMatch { throw 'full-tree-query-forbidden' }
function Assert-UiInputAllowed {}
function Assert-NotDenied {}
function Get-ControlTypeName { return 'Button' }
function Get-UiDesktopState { return 'unlocked' }
function Get-UiPolicyFailure { return $null }
function Invoke-ElementPattern { $script:invocations++; if ($script:failInvoke) { throw 'invoke failed' }; return 'Invoke' }
$script:invocations=0
$script:failInvoke=$false
$DefaultWaitMs=0
$Serve=$true
$root=Make-Element 100 1000
$element=Make-Element 101
$element.Parent=$root
$reference=New-TargetRef $element $root
$step=[pscustomobject]@{action='pattern';targetRef=$reference;name='';aid='';match='';waitFor=$null;requireUnique=$false;value='Invoke';waitMs=0}
$fresh=Resolve-Target $root $step 10
$again=Resolve-Target $root $step 10
$root.Current.NativeWindowHandle=2000
$wrongWindow=Resolve-Target $root $step 10
$root.Current.NativeWindowHandle=1000
$wrongProcess=Resolve-Target $root $step 11
$element.Current.Name='Changed'
$nameDrift=Resolve-Target $root $step 10
$element.Current.Name='Target'
$element.Current.AutomationId='Changed'
$aidDrift=Resolve-Target $root $step 10
$element.Current.AutomationId='target'
$element.Current.ControlType.ProgrammaticName='ControlType.Edit'
$typeDrift=Resolve-Target $root $step 10
$element.Current.ControlType.ProgrammaticName='ControlType.Button'
$element.Runtime=202
$runtimeDrift=Resolve-Target $root $step 10
$element.Runtime=101
$element.Current.BoundingRectangle.X=11
$rectDrift=Resolve-Target $root $step 10
$element.Current.BoundingRectangle.X=10
$element.Current.IsEnabled=$false
$disabled=Resolve-Target $root $step 10
$element.Current.IsEnabled=$true
$element.Current.IsOffscreen=$true
$offscreen=Resolve-Target $root $step 10
$element.Current.IsOffscreen=$false
$element.Parent=$null
$detached=Resolve-Target $root $step 10
$element.Parent=$element
$cycle=Resolve-Target $root $step 10
$element.Parent=$root
$step | Add-Member index 0
$mixed=Resolve-Target $root $step 10
$step.PSObject.Properties.Remove('index')
$script:TargetRefs[$reference].expiresAt=[DateTime]::UtcNow.AddSeconds(-1)
$expired=Resolve-Target $root $step 10
$Serve=$false
$cold=New-TargetRef $element $root
$Serve=$true
$script:TargetRefs=[ordered]@{}
$first=$null
for ($index=0;$index -lt 129;$index++) { $created=New-TargetRef $element $root; if ($index -eq 0) { $first=$created } }
$limit=$script:TargetRefs.Count
$oldestRemoved=-not $script:TargetRefs.Contains($first)
$step.targetRef=$created
$invoked=Invoke-Step $root $step 0 10
$consumed=-not $script:TargetRefs.Contains($created)
$second=Invoke-Step $root $step 0 10
$step.targetRef=New-TargetRef $element $root
$script:failInvoke=$true
$failedInvoke=Invoke-Step $root $step 0 10
$failedConsumed=-not $script:TargetRefs.Contains([string]$step.targetRef)
$element | Add-Member -MemberType ScriptMethod -Name GetClickablePoint -Value { if ($script:failClickablePoint) { throw 'no point' }; return [pscustomobject]@{X=20;Y=30} }
$element | Add-Member -MemberType ScriptMethod -Name SetFocus -Value {}
$step.action='doubleclick'
$step.targetRef=New-TargetRef $element $root
$double=Invoke-Step $root $step 0 10
$doubleConsumed=-not $script:TargetRefs.Contains([string]$step.targetRef)
$doubleCalls=[UiDriveInputWin32]::MouseCalls
$doubleAgain=Invoke-Step $root $step 0 10
$script:failClickablePoint=$true
$step.targetRef=New-TargetRef $element $root
$noPoint=Invoke-Step $root $step 0 10
$noPointCalls=[UiDriveInputWin32]::MouseCalls
$script:hitElement=Make-Element 303
$script:hitElement.Parent=$element
$step.targetRef=New-TargetRef $element $root
$childHit=Invoke-Step $root $step 0 10
$childHitCalls=[UiDriveInputWin32]::MouseCalls
$script:hitElement=Make-Element 404
$step.targetRef=New-TargetRef $element $root
$miss=Invoke-Step $root $step 0 10
$missCalls=[UiDriveInputWin32]::MouseCalls
$script:hitElement.Current.ProcessId=20
$script:hitElement.Parent=$element
$step.targetRef=New-TargetRef $element $root
$foreignHit=Invoke-Step $root $step 0 10
$foreignHitCalls=[UiDriveInputWin32]::MouseCalls
$container=Make-Element 505
$container.Parent=$root
$root.Parent=Make-Element 707 7070
$root.Parent.Current.ProcessId=99
$element.Parent=$container
$script:hitElement=$container
$reverseAncestor=Test-DoubleClickHit $element 20 30
$outsidePoint=Test-DoubleClickHit $element 500 500
$script:hitElement=$root
$topWindowHit=Test-DoubleClickHit $element 20 30
$script:hitElement=Make-Element 606
$unrelatedHit=Test-DoubleClickHit $element 20 30
$element.Parent=$root
$script:failClickablePoint=$false
[UiDriveInputWin32]::FailMouse=$true
$step.targetRef=New-TargetRef $element $root
$interrupted=Invoke-Step $root $step 0 10
$interruptedCalls=[UiDriveInputWin32]::MouseCalls
[UiDriveInputWin32]::FailMouse=$false
$script:failClickablePoint=$true
$legacy=Invoke-DoubleClickElement $element $root
$legacyCalls=[UiDriveInputWin32]::MouseCalls
function Wait-Target { return @{ok=$true;el=$element;count=1;elapsedMs=0} }
function Get-ElementDetail { return 'Target' }
$find=Invoke-Step $root ([pscustomobject]@{action='find';aid='target'}) 0 10
@{fresh=$fresh.ok;again=$again.ok;rejections=@($wrongWindow,$wrongProcess,$nameDrift,$aidDrift,$typeDrift,$runtimeDrift,$rectDrift,$disabled,$offscreen,$detached,$cycle,$mixed,$expired);cold=$cold;limit=$limit;oldestRemoved=$oldestRemoved;invoked=$invoked;consumed=$consumed;second=$second;invocations=$script:invocations;failedInvoke=$failedInvoke;failedConsumed=$failedConsumed;find=$find;double=$double;doubleConsumed=$doubleConsumed;doubleCalls=$doubleCalls;doubleAgain=$doubleAgain;noPoint=$noPoint;noPointCalls=$noPointCalls;interrupted=$interrupted;interruptedCalls=$interruptedCalls;legacy=$legacy;legacyCalls=$legacyCalls;childHit=$childHit;childHitCalls=$childHitCalls;miss=$miss;missCalls=$missCalls;foreignHit=$foreignHit;foreignHitCalls=$foreignHitCalls;reverseAncestor=$reverseAncestor;outsidePoint=$outsidePoint;topWindowHit=$topWindowHit;unrelatedHit=$unrelatedHit} | ConvertTo-Json -Depth 5 -Compress
`
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, DSH_REF_SCRIPT: resolve(import.meta.dirname, '../scripts/ui-drive-batch.ps1') },
})
assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.fresh, true)
assert.equal(output.again, true)
assert.ok(output.rejections.every(entry => entry.ok === false && entry.staleTargetRef === true && entry.notExecuted === true))
assert.equal(output.cold, null)
assert.equal(output.limit, 128)
assert.equal(output.oldestRemoved, true)
assert.equal(output.invoked.ok, true)
assert.equal(output.consumed, true)
assert.equal(output.second.staleTargetRef, true)
assert.equal(output.invocations, 2)
assert.equal(output.failedInvoke.ok, false)
assert.equal(output.failedConsumed, true)
assert.match(output.find.targetRef, /^[a-f0-9]{32}$/)
assert.equal(output.find.targetAid, 'target')
assert.equal(output.double.ok, true)
assert.equal(output.doubleConsumed, true)
assert.equal(output.doubleCalls, 4)
assert.equal(output.doubleAgain.staleTargetRef, true)
assert.equal(output.noPoint.notExecuted, true, JSON.stringify(output.noPoint))
assert.notEqual(output.noPoint.unknown, true)
assert.equal(output.noPointCalls, 4)
assert.equal(output.interrupted.unknown, true)
assert.notEqual(output.interrupted.notExecuted, true)
assert.equal(output.childHit.ok, true)
assert.equal(output.childHitCalls, 8)
assert.equal(output.miss.notExecuted, true)
assert.equal(output.missCalls, 8)
assert.equal(output.foreignHit.notExecuted, true)
assert.equal(output.foreignHitCalls, 8)
assert.equal(output.reverseAncestor, true)
assert.equal(output.outsidePoint, false)
assert.equal(output.topWindowHit, false)
assert.equal(output.unrelatedHit, false)
assert.equal(output.interruptedCalls, 9)
assert.match(output.legacy, /doubleClick/)
assert.equal(output.legacyCalls, 13)
console.log('PASS target refs: fresh resolution without scans, identity drift, bounded cache, expiry, ancestry and one-use invocation')
