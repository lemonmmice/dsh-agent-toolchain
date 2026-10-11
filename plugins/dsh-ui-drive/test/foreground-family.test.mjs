import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !existsSync(powershell)) {
  console.log('SKIP foreground family requires Windows PowerShell 5.1')
  process.exit(0)
}

const script = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$helperPath=Join-Path $env:DSH_FAMILY_SCRIPTS 'ui-windows-boundary.ps1'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($helperPath,[ref]$tokens,[ref]$errors)
$source=$ast.Find({param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('public static class UiDriveInputWin32')},$true).Value
$fields=@'
public static class UiDriveInputWin32 {
  public static Dictionary<long,uint> Processes = new Dictionary<long,uint>();
  public static Dictionary<long,long> Owners = new Dictionary<long,long>();
  public static Dictionary<long,long> Parents = new Dictionary<long,long>();
  public static IntPtr Foreground;
  public static int Activations;
  public static int OwnerReads;
  public static string Desktop = "unlocked";
'@
$source=$source.Replace('public static class UiDriveInputWin32 {',$fields)
$source=$source.Replace('[DllImport("user32.dll", EntryPoint="SetForegroundWindow")] static extern bool NativeSetForegroundWindow(IntPtr handle);','static bool NativeSetForegroundWindow(IntPtr handle) { Activations++; return true; }')
$source=$source.Replace('[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);','static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) { Processes.TryGetValue(handle.ToInt64(), out processId); return processId; }')
$source=$source.Replace('[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();','static IntPtr GetForegroundWindow() { return Foreground; }')
$source=$source.Replace('[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);','static IntPtr GetWindow(IntPtr handle, uint command) { OwnerReads++; long owner; Owners.TryGetValue(handle.ToInt64(), out owner); return new IntPtr(owner); }')
$source=$source.Replace('[DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr window);','static bool IsChild(IntPtr parent, IntPtr window) { long candidate = window.ToInt64(); for (int depth=0; depth<32; depth++) { if (!Parents.TryGetValue(candidate, out candidate)) return false; if (candidate == parent.ToInt64()) return true; } return false; }')
$source=$source.Replace('public static string GetDesktopState() {','public static string NativeDesktopState() {')
$source=$source.Replace('public static string PolicyCodeForState','public static string GetDesktopState() { return Desktop; } public static string PolicyCodeForState')
Add-Type $source
. $helperPath
foreach ($handle in @(100,110,200,300,400,600,800,900)) { [UiDriveInputWin32]::Processes[$handle]=10 }
[UiDriveInputWin32]::Processes[500]=20
[UiDriveInputWin32]::Processes[510]=20
[UiDriveInputWin32]::Owners[200]=100
[UiDriveInputWin32]::Owners[300]=200
[UiDriveInputWin32]::Owners[500]=100
[UiDriveInputWin32]::Owners[600]=500
[UiDriveInputWin32]::Owners[800]=900
[UiDriveInputWin32]::Owners[900]=800
[UiDriveInputWin32]::Parents[110]=100
[UiDriveInputWin32]::Parents[510]=100
$cases=@()
foreach ($case in @(
  @{name='target';foreground=100;target=100},
  @{name='child';foreground=110;target=100},
  @{name='owned';foreground=200;target=100},
  @{name='nested-owner';foreground=300;target=100},
  @{name='same-process-independent';foreground=400;target=100},
  @{name='foreign-owner';foreground=500;target=100},
  @{name='foreign-intermediate';foreground=600;target=100},
  @{name='foreign-child';foreground=510;target=100},
  @{name='no-foreground';foreground=0;target=100},
  @{name='no-target';foreground=100;target=0},
  @{name='invalid-target';foreground=100;target=999},
  @{name='owner-cycle';foreground=800;target=100}
)) {
  [UiDriveInputWin32]::Foreground=[IntPtr]$case.foreground
  [UiDriveInputWin32]::Activations=0
  [UiDriveInputWin32]::OwnerReads=0
  [UiDriveInputWin32]::SetForegroundWindow([IntPtr]$case.target) | Out-Null
  $cases+=@{name=$case.name;activations=[UiDriveInputWin32]::Activations;ownerReads=[UiDriveInputWin32]::OwnerReads}
}
[UiDriveInputWin32]::Foreground=[IntPtr]200
[UiDriveInputWin32]::Desktop='locked'
[UiDriveInputWin32]::Activations=0
$locked=$false
try { [UiDriveInputWin32]::SetForegroundWindow([IntPtr]100) | Out-Null } catch { $locked=(Get-UiPolicyFailure $_.Exception).policyCode -eq 'desktop_locked' }
$lockedActivations=[UiDriveInputWin32]::Activations
[UiDriveInputWin32]::Desktop='unlocked'
Add-Type 'using System; public class UiDriveBatchWin32 { public static bool IsIconic(IntPtr handle) { return false; } }'
$batch=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:DSH_FAMILY_SCRIPTS 'ui-drive-batch.ps1'),[ref]$tokens,[ref]$errors)
foreach ($name in @('Test-NeedsForeground','Invoke-Step')) {
  $definition=$batch.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Resolve-Window($main,$step,$procId) { return $main }
function Invoke-ClickAt($main) { $script:clicks++; return 'clicked' }
function Invoke-WithMods($mods,$body) { & $body }
$script:clicks=0
$DefaultWaitMs=0
$main=[pscustomobject]@{Current=[pscustomobject]@{NativeWindowHandle=100}}
$owned=Invoke-Step $main ([pscustomobject]@{action='clickat';waitMs=0}) 0 10
$ownedActivations=[UiDriveInputWin32]::Activations
[UiDriveInputWin32]::SetForegroundWindow([IntPtr]100) | Out-Null
$repeatedActivations=[UiDriveInputWin32]::Activations
[UiDriveInputWin32]::Foreground=[IntPtr]400
$independent=Invoke-Step $main ([pscustomobject]@{action='clickat';waitMs=0}) 1 10
@{cases=$cases;locked=$locked;lockedActivations=$lockedActivations;owned=$owned;ownedActivations=$ownedActivations;repeatedActivations=$repeatedActivations;independent=$independent;independentActivations=[UiDriveInputWin32]::Activations;clicks=$script:clicks} | ConvertTo-Json -Depth 8 -Compress
`
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, DSH_FAMILY_SCRIPTS: resolve(import.meta.dirname, '../scripts'), DSH_UI_ALLOW_LOCKED: '', DSH_UI_CONTROL_POLICY_DATA: '' },
})
assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
const output = JSON.parse(result.stdout)
const family = new Set(['target', 'child', 'owned', 'nested-owner'])
for (const entry of output.cases) {
  assert.equal(entry.activations, family.has(entry.name) ? 0 : 1, entry.name)
  assert.ok(entry.ownerReads <= 32, entry.name)
}
assert.equal(output.locked, true)
assert.equal(output.lockedActivations, 0)
assert.equal(output.owned.ok, true, JSON.stringify(output.owned))
assert.equal(output.ownedActivations, 0)
assert.equal(output.repeatedActivations, 0)
assert.equal(output.independent.ok, true, JSON.stringify(output.independent))
assert.equal(output.independentActivations, 1)
assert.equal(output.clicks, 2)
console.log('PASS foreground window family: owned popup focus, isolated windows, PID boundaries, bounded traversal and locked desktop')
