import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !existsSync(powershell)) {
  console.log('SKIP state property reads requires Windows PowerShell 5.1')
  process.exit(0)
}

const directory = mkdtempSync(join(tmpdir(), 'dsh-ui-state-properties-'))
const harnessPath = join(directory, 'state-properties.ps1')
const sourcePath = fileURLToPath(new URL('../scripts/ui-drive-batch.ps1', import.meta.url))
const harness = String.raw`param([string]$SourcePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$tokens = $null
$parseErrors = $null
$syntax = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$functions = @('Get-ControlTypeName', 'Reset-SkipCounter', 'Add-Skip', 'Is-RectUsable', 'Get-SafeInt', 'Is-SecretControl', 'Get-ElementValue', 'Get-ElementValueForReport', 'Get-InteractiveLines')
foreach ($functionName in $functions) {
  $definition = $syntax.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
  if ($null -eq $definition) { throw ('Missing function: ' + $functionName) }
  . ([scriptblock]::Create($definition.Extent.Text))
}
foreach ($variableName in @('INTERACTIVE_TYPES', 'SECRET_NAME_RE')) {
  $definition = $syntax.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq $variableName }, $true)
  if ($null -eq $definition) { throw ('Missing variable: ' + $variableName) }
  . ([scriptblock]::Create($definition.Extent.Text))
}
Add-Type @'
using System;
public sealed class StateFakeRect {
  public double X, Y = 20, Width = 80, Height = 30;
}
public sealed class StateFakeType {
  public string ProgrammaticName;
}
public sealed class StateFakeInfo {
  public string NameValue, AidValue;
  public bool Strict = true, Unavailable;
  public int NameReads, AidReads, EnabledReads;
  public bool IsOffscreen = false;
  public StateFakeRect BoundingRectangle = new StateFakeRect();
  public StateFakeType ControlType = new StateFakeType();
  public string Name { get { NameReads++; if (Unavailable || (Strict && NameReads > 1)) throw new InvalidOperationException("Name unavailable"); return NameValue; } }
  public string AutomationId { get { AidReads++; if (Strict && AidReads > 1) throw new InvalidOperationException("AutomationId read twice"); return AidValue; } }
  public bool IsEnabled { get { EnabledReads++; if (Strict && EnabledReads > 1) throw new InvalidOperationException("IsEnabled read twice"); return true; } }
}
public sealed class StateFakeValue {
  public string Value = "private-test-value";
}
public sealed class StateFakePattern {
  public StateFakeValue Current = new StateFakeValue();
}
public sealed class StateFakeElement {
  public StateFakeInfo Current = new StateFakeInfo();
  public StateFakePattern GetCurrentPattern(object pattern) { return new StateFakePattern(); }
}
public sealed class StateFakeCollection {
  public StateFakeElement[] Elements;
  public int Count { get { return Elements.Length; } }
  public StateFakeElement Item(int index) { if (Elements[index].Current.Unavailable) throw new InvalidOperationException("Element unavailable"); return Elements[index]; }
}
public sealed class StateFakeRoot {
  public StateFakeCollection Collection = new StateFakeCollection();
  public StateFakeCollection FindAll(object scope, object condition) { return Collection; }
}
'@
function New-TestElement([string]$name, [string]$aid, [string]$type, [int]$position) {
  $element = New-Object StateFakeElement
  $element.Current.NameValue = $name
  $element.Current.AidValue = $aid
  $element.Current.ControlType.ProgrammaticName = 'ControlType.' + $type
  $element.Current.BoundingRectangle.X = $position
  return $element
}
function Read-TestState([StateFakeElement[]]$elements, [int]$maximum) {
  $root = New-Object StateFakeRoot
  $root.Collection.Elements = $elements
  Reset-SkipCounter
  $lines = @(Get-InteractiveLines $root '' $maximum)
  return @{lines=$lines; controls=@($script:DecisionControls); scanned=$script:LastScanned; skipped=$script:SkipCount}
}
$fullName = 'Control-' + ('x' * 65)
$first = New-TestElement $fullName 'first' 'Custom' 10
$second = New-TestElement 'Second' 'second' 'Custom' 20
$tail = New-TestElement 'Tail' 'tail' 'Custom' 30
$normal = Read-TestState @($first, $second, $tail) 2
$normal.reads = @($first, $second, $tail | ForEach-Object { @{name=$_.Current.NameReads; aid=$_.Current.AidReads; enabled=$_.Current.EnabledReads} })
$unavailable = New-TestElement 'Unavailable' 'bad' 'Custom' 40
$unavailable.Current.Unavailable = $true
$healthy = New-TestElement 'Healthy' 'healthy' 'Custom' 50
$partial = Read-TestState @($unavailable, $healthy) 0
$secret = New-TestElement 'Account entry' 'password-entry' 'Edit' 60
$secret.Current.Strict = $false
$redacted = Read-TestState @($secret) 0
@{normal=$normal; partial=$partial; redacted=$redacted; fullName=$fullName} | ConvertTo-Json -Depth 8 -Compress
`

try {
  writeFileSync(harnessPath, '\ufeff' + harness, 'utf8')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', harnessPath, '-SourcePath', sourcePath], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout.trim())
  assert.equal(output.normal.skipped, 0)
  assert.equal(output.normal.scanned, 3)
  assert.equal(output.normal.lines.length, 2)
  assert.equal(output.normal.controls.length, 2)
  assert.deepEqual(output.normal.reads, [
    { name: 1, aid: 1, enabled: 1 },
    { name: 1, aid: 1, enabled: 1 },
    { name: 0, aid: 0, enabled: 0 },
  ])
  assert.equal(output.normal.controls[0].name, output.fullName)
  assert.equal(output.normal.controls[0].aid, 'first')
  assert.equal(output.normal.controls[0].enabled, true)
  assert.equal(output.normal.lines[0], '#0 [Custom] "' + output.fullName.slice(0, 60) + '" aid="first" enabled=True @10,20')
  assert.equal(output.normal.lines[1], '#1 [Custom] "Second" aid="second" enabled=True @20,20')
  assert.equal(output.partial.skipped, 1)
  assert.equal(output.partial.scanned, 2)
  assert.equal(output.partial.lines.length, 1)
  assert.equal(output.partial.controls[0].aid, 'healthy')
  assert.equal(output.redacted.skipped, 0)
  assert.equal(output.redacted.controls[0].secret, true)
  assert.match(output.redacted.lines[0], /value="<secret:18chars>"/)
  assert.equal(JSON.stringify(output).includes('private-test-value'), false)
  console.log('PASS state property reads: one getter call, consistent fields, max, skipped and secret redaction')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
