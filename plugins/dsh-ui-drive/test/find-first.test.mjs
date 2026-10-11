import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !existsSync(powershell)) {
  console.log('SKIP find first requires Windows PowerShell 5.1')
  process.exit(0)
}

const directory = mkdtempSync(join(tmpdir(), 'dsh-ui-find-first-'))
const harnessPath = join(directory, 'find-first.ps1')
const sourcePath = fileURLToPath(new URL('../scripts/ui-drive-batch.ps1', import.meta.url))
const harness = String.raw`param([string]$SourcePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$UIA = [System.Windows.Automation.AutomationElement]
$tokens = $null
$parseErrors = $null
$syntax = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$functions = @('Is-RectUsable', 'Is-ElementUsable', 'Test-MatchText', 'Find-Elements', 'Find-Element', 'Find-ElementsByMatch', 'Wait-ForCondition', 'Resolve-Window', 'Resolve-Target')
foreach ($functionName in $functions) {
  $definition = $syntax.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
  if ($null -eq $definition) { throw ('Missing function: ' + $functionName) }
  . ([scriptblock]::Create($definition.Extent.Text))
}
Add-Type @'
public sealed class FirstFakeRect {
  public double X = 10, Y = 20, Width = 80, Height = 30;
}
public sealed class FirstFakeInfo {
  public string Name = "target", AutomationId = "target-id", HelpText;
  public bool IsOffscreen, IsEnabled = true;
  public FirstFakeRect BoundingRectangle = new FirstFakeRect();
}
public sealed class FirstFakeElement {
  public int Id;
  public FirstFakeInfo Current = new FirstFakeInfo();
  public int[] GetRuntimeId() { return new int[] { 42, Id }; }
}
public sealed class FirstFakeCollection {
  public FirstFakeElement[] Elements;
  public int Count { get { return Elements.Length; } }
  public FirstFakeElement Item(int index) { return Elements[index]; }
}
public sealed class FirstFakeRoot {
  public FirstFakeCollection Collection = new FirstFakeCollection();
  public int FirstCalls, AllCalls;
  public FirstFakeElement FindFirst(object scope, object condition) { FirstCalls++; return Collection.Count == 0 ? null : Collection.Item(0); }
  public FirstFakeCollection FindAll(object scope, object condition) { AllCalls++; return Collection; }
}
'@
function New-TestElement([int]$identity, [bool]$enabled = $true) {
  $element = New-Object FirstFakeElement
  $element.Id = $identity
  $element.Current.IsEnabled = $enabled
  $element.Current.HelpText = $(if ($identity -eq 1) { 'first' } else { 'second' })
  return $element
}
function New-TestRoot([FirstFakeElement[]]$elements) {
  $root = New-Object FirstFakeRoot
  $root.Collection.Elements = $elements
  return $root
}
function Read-First($root, $scope = $null) {
  $element = Find-Element $root '' 'target' $scope
  return @{id=$(if ($element) { $element.Id } else { $null }); firstCalls=$root.FirstCalls; allCalls=$root.AllCalls}
}
function Read-Wait($root, $spec) {
  $result = Wait-ForCondition $root '' 'target' $spec
  return @{ok=$result.ok; found=$result.found; id=$(if ($result.el) { $result.el.Id } else { $null }); firstCalls=$root.FirstCalls; allCalls=$root.AllCalls}
}
function Read-Resolve($step) {
  $root = New-TestRoot @((New-TestElement 1), (New-TestElement 2))
  $result = Resolve-Target $root $step 1
  return @{ok=$result.ok; count=$result.count; ambiguous=($result.ambiguous -eq $true); id=$(if ($result.el) { $result.el.Id } else { $null }); firstCalls=$root.FirstCalls; allCalls=$root.AllCalls}
}
$visibleRoot = New-TestRoot @((New-TestElement 1), (New-TestElement 2))
$visible = Read-First $visibleRoot
$hidden = New-TestElement 1
$hidden.Current.IsOffscreen = $true
$hiddenRoot = New-TestRoot @($hidden, (New-TestElement 2))
$hiddenResult = Read-First $hiddenRoot
$invalid = New-TestElement 1
$invalid.Current.BoundingRectangle.X = [double]::PositiveInfinity
$invalidRoot = New-TestRoot @($invalid, (New-TestElement 2))
$invalidResult = Read-First $invalidRoot
$emptyRoot = New-TestRoot @()
$empty = Read-First $emptyRoot
$mainRoot = New-TestRoot @((New-TestElement 1))
$scopeRoot = New-TestRoot @((New-TestElement 2))
$scoped = Read-First $mainRoot $scopeRoot
$scoped.scopeFirstCalls = $scopeRoot.FirstCalls
$scoped.scopeAllCalls = $scopeRoot.AllCalls
$disabledRoot = New-TestRoot @((New-TestElement 1 $false), (New-TestElement 2))
$disabled = Read-Wait $disabledRoot ([pscustomobject]@{ms=0; state='disabled'})
$enabledRoot = New-TestRoot @((New-TestElement 1 $false), (New-TestElement 2))
$enabled = Read-Wait $enabledRoot ([pscustomobject]@{ms=0; state='enabled'})
$goneRoot = New-TestRoot @()
$gone = Read-Wait $goneRoot ([pscustomobject]@{ms=0; state='gone'})
$indexRoot = New-TestRoot @((New-TestElement 1), (New-TestElement 2))
$indexedWait = Read-Wait $indexRoot ([pscustomobject]@{ms=0; state='appear'; index=1})
$zeroRoot = New-TestRoot @((New-TestElement 1), (New-TestElement 2))
$zeroWait = Read-Wait $zeroRoot ([pscustomobject]@{ms=0; state='appear'; index=0})
$matchRoot = New-TestRoot @((New-TestElement 1), (New-TestElement 2))
$matchedWait = Read-Wait $matchRoot ([pscustomobject]@{ms=0; state='appear'; match='second'})
$defaultFind = Read-Resolve ([pscustomobject]@{action='find';name='target'})
$indexedFind = Read-Resolve ([pscustomobject]@{action='find';name='target';index=1})
$matchedFind = Read-Resolve ([pscustomobject]@{action='find';name='target';match='second'})
$uniqueFind = Read-Resolve ([pscustomobject]@{action='find';name='target';requireUnique=$true})
@{visible=$visible; hidden=$hiddenResult; invalid=$invalidResult; empty=$empty; scoped=$scoped; disabled=$disabled; enabled=$enabled; gone=$gone; indexedWait=$indexedWait; zeroWait=$zeroWait; matchedWait=$matchedWait; defaultFind=$defaultFind; indexedFind=$indexedFind; matchedFind=$matchedFind; uniqueFind=$uniqueFind} | ConvertTo-Json -Depth 6 -Compress
`

try {
  writeFileSync(harnessPath, '\ufeff' + harness, 'utf8')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', harnessPath, '-SourcePath', sourcePath], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout.trim())
  assert.deepEqual(output.visible, { id: 1, firstCalls: 1, allCalls: 0 })
  assert.deepEqual(output.hidden, { id: 2, firstCalls: 1, allCalls: 1 })
  assert.deepEqual(output.invalid, { id: 2, firstCalls: 1, allCalls: 1 })
  assert.deepEqual(output.empty, { id: null, firstCalls: 1, allCalls: 0 })
  assert.deepEqual(output.scoped, { id: 2, firstCalls: 0, allCalls: 0, scopeFirstCalls: 1, scopeAllCalls: 0 })
  assert.deepEqual(output.disabled, { ok: true, found: true, id: 1, firstCalls: 1, allCalls: 0 })
  assert.deepEqual(output.enabled, { ok: false, found: true, id: null, firstCalls: 1, allCalls: 0 })
  assert.deepEqual(output.gone, { ok: true, found: false, id: null, firstCalls: 1, allCalls: 0 })
  for (const key of ['indexedWait', 'zeroWait', 'matchedWait']) {
    assert.equal(output[key].ok, true)
    assert.equal(output[key].id, key === 'zeroWait' ? 1 : 2)
    assert.equal(output[key].firstCalls, 0)
    assert.equal(output[key].allCalls, 1)
  }
  for (const key of ['defaultFind', 'indexedFind', 'matchedFind', 'uniqueFind']) {
    assert.equal(output[key].firstCalls, 0)
    assert.equal(output[key].allCalls, 1)
  }
  assert.equal(output.defaultFind.count, 2)
  assert.equal(output.defaultFind.id, 1)
  assert.equal(output.indexedFind.count, 2)
  assert.equal(output.indexedFind.id, 2)
  assert.equal(output.matchedFind.count, 1)
  assert.equal(output.matchedFind.id, 2)
  assert.equal(output.uniqueFind.ok, false)
  assert.equal(output.uniqueFind.ambiguous, true)
  assert.equal(output.uniqueFind.count, 2)
  console.log('PASS find first: visible/hidden/invalid/empty/scope, wait states, explicit index/match and public find counts/uniqueness')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
