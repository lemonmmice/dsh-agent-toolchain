import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_UI_SERVE = '0'
process.env.DSH_UI_CONTROL_POLICY = ''
const root = path.resolve(import.meta.dirname, '../../..')
const server = fs.readFileSync(path.join(root, 'mcp/server.mjs'), 'utf8').replace(/\r\n/g, '\n')
const plugin = fs.readFileSync(path.join(root, 'plugins/dsh-ui-drive/index.js'), 'utf8').replace(/\r\n/g, '\n')
const registration = server.slice(server.indexOf("server.tool(\n  'ui_flow',"), server.indexOf("server.tool(\n  'ui_replay',"))
const schemaSource = registration.slice(registration.indexOf('  {') + 2, registration.indexOf('\n  async (args)')).trim().replace(/,$/, '')
const require = createRequire(path.join(root, 'mcp/package.json'))
const { z } = require('zod')
const schema = z.object(new Function('z', 'return (' + schemaSource + ')')(z))
const steps = [
  { action: 'clickat', x: 10, y: 20, double: true, button: 'left', mods: 'ctrl', waitMs: 70 },
  { action: 'doubleclick', name: 'Row', requireUnique: true },
  { action: 'move', x: 15, y: 25, holdMs: 0 },
  { action: 'wheel', x: 30, y: 40, delta: -120, count: 2 },
]
assert.deepEqual(schema.parse({ procId: 42, waitMs: 0, steps, allowSideEffects: true }).steps, steps)
const pluginStart = plugin.indexOf("name: 'ui_flow'")
const pluginSection = plugin.slice(pluginStart, plugin.indexOf('\n  defineTool(', pluginStart + 1))
for (const action of ['clickat', 'doubleclick', 'move', 'wheel']) assert.ok(pluginSection.includes("'" + action + "'"))
assert.match(pluginSection, /procId: \{ type: 'integer'/)
assert.match(pluginSection, /waitMs: \{ type: 'integer'/)
assert.match(registration, /procId: args.procId/)
assert.match(registration, /waitMs: args.waitMs/)

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-flow-target-'))
const capture = path.join(folder, 'capture.jsonl')
process.env.DSH_FLOW_TARGET_CAPTURE = capture
fs.writeFileSync(path.join(folder, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [int]$ProcId=0, [string]$StepsFile='', [string]$Out='', [int]$DefaultWaitMs=250)
$steps=@(([System.IO.File]::ReadAllText($StepsFile) | ConvertFrom-Json))
[System.IO.File]::AppendAllText($env:DSH_FLOW_TARGET_CAPTURE,((@{procId=$ProcId;steps=$steps}|ConvertTo-Json -Depth 8 -Compress)+[Environment]::NewLine))
$results=@()
foreach($step in $steps) {
  $failed=$step.name -eq 'fail'
  $results+=@{ok=(-not $failed);action=$step.action;output='executed';error=$(if($failed){'failed'}else{''});path=$step.out;w=640;h=480;captureMethod='CopyFromScreen';windowHandle=800;rect=@{x=10;y=20;w=640;h=480};coordinateSpace='window';physicalPixels=$true}
  if($failed -and $step.stopOnFailure){break}
}
$result=@{ok=$true;pid=$ProcId;window='Fixture';elapsedMs=7;steps=$results}|ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($Out,$result)
Write-Output ('RESULT_JSON='+$result)
`, 'utf8')
const { makeDriver } = await import('../lib/driver.mjs')
const { createPolicy } = await import('../lib/policy.mjs')
const driver = makeDriver({ scriptsDir: folder, evidenceDir: path.join(folder, 'evidence'), procName: 'Fixture', clientExe: 'C:\\fixture.exe', lockPath: '',
  policy: createPolicy({ approvalFile: '', policyFile: '', estopFile: '', safetyPolicyFile: '' }) })
const captures = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
try {
  const result = await driver.flow({ procId: 42, waitMs: 0, steps, allowSideEffects: true, failFast: true })
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'batch')
  assert.equal(captures().length, 1)
  assert.equal(captures()[0].procId, 42)
  assert.deepEqual(captures()[0].steps.map(step => step.waitMs), [70, 0, 0, 0])
  assert.deepEqual(captures()[0].steps.map(step => step.action), steps.map(step => step.action))
  assert.equal(captures()[0].steps[0].x, 10)
  assert.equal(captures()[0].steps[3].delta, -120)
  assert.equal(result.elapsedMs, 7)
  assert.ok(result.totalElapsedMs > result.elapsedMs)
  const saved = JSON.parse(fs.readFileSync(result.stepsJson, 'utf8'))
  assert.equal(saved.transcript.length, 4)
  const override = await driver.flow({ procId: 42, waitMs: 0, steps: [{ action: 'move', procId: 43, x: 3, y: 4 }] })
  assert.equal(override.ok, true)
  assert.equal(captures().at(-1).procId, 43)
  const before = captures().length
  const denied = await driver.flow({ procId: 42, steps: [{ action: 'doubleclick', name: 'Row' }], failFast: true })
  assert.equal(denied.ok, false)
  assert.equal(captures().length, before)
  const failed = await driver.flow({ procId: 42, waitMs: 0, allowSideEffects: true, failFast: true, steps: [{ action: 'doubleclick', name: 'fail' }, { action: 'clickat', x: 1, y: 2 }] })
  assert.equal(failed.ok, false)
  assert.equal(failed.transcript.length, 1)
  assert.equal(captures().length, before + 1)
  assert.equal(captures().at(-1).steps[0].stopOnFailure, true)
  const shots = await driver.flow({ procId: 42, steps: [{ action: 'shot', label: 'same', captureMode: 'screen' }, { action: 'shot', label: 'same', captureMode: 'screen' }] })
  assert.equal(shots.ok, true)
  assert.notEqual(shots.transcript[0].path, shots.transcript[1].path)
  assert.equal(shots.transcript[0].captureMethod, 'CopyFromScreen')
  assert.equal(shots.transcript[0].windowHandle, 800)
  assert.equal(shots.transcript[0].physicalPixels, true)
  assert.equal(captures().at(-1).steps[0].captureMode, 'screen')
  for (const settings of [{ procId: 0 }, { waitMs: -1 }]) {
    assert.equal((await driver.flow({ ...settings, steps: [{ action: 'find', name: 'Row' }] })).notExecuted, true)
  }
  console.log('PASS flow target: batched coordinate actions, fixed PID, zero waits, fail-fast and measured total latency')
} finally {
  driver.warmShutdown()
  fs.rmSync(folder, { recursive: true, force: true })
}
