import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeDriver } from '../lib/driver.mjs'
import { createPolicy } from '../lib/policy.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP target reference transport requires Windows PowerShell')
  process.exit(0)
}
const directory = mkdtempSync(join(tmpdir(), 'dsh-ui-target-ref-'))
const capture = join(directory, 'requests.jsonl')
process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_UI_SERVE = '1'
process.env.DSH_UI_CONTROL_POLICY = ''
process.env.DSH_TARGET_REF_REQUESTS = capture
writeFileSync(join(directory, 'ui-drive-batch.ps1'), `param([string]$ProcName='', [string]$WindowName='', [switch]$Serve, [string]$ScriptStamp='')
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
while ($null -ne ($line = $reader.ReadLine())) {
  $request = $line | ConvertFrom-Json
  if ($request.cmd -eq 'ping') { $response = @{id=$request.id;ok=$true;pong=$true} }
  else {
    [System.IO.File]::AppendAllText($env:DSH_TARGET_REF_REQUESTS,$line+[Environment]::NewLine)
    if ($request.action -eq 'find') { $reference = $(if ($request.name -in @('stale','unknown')) { $request.name } else { 'reference-1' }); $response = @{id=$request.id;ok=$true;found=$true;count=1;targetRef=$reference;targetAid='target';detail='target'} }
    elseif ($request.action -eq 'state') { $response = @{id=$request.id;ok=$true;lines=@('target');controls=@(@{targetRef='reference-1';aid='target'});windowHandle=42;skipped=0;count=1} }
    elseif ($request.targetRef -eq 'stale') { $response = @{id=$request.id;ok=$false;staleTargetRef=$true;notExecuted=$true;error='reference expired'} }
    elseif ($request.targetRef -eq 'unknown') { $response = @{id=$request.id;ok=$false;unknown=$true;error='invoke result unknown'} }
    else { $response = @{id=$request.id;ok=$true;output=('PATTERN '+$request.value)} }
  }
  $writer.WriteLine('RESP_JSON='+($response | ConvertTo-Json -Depth 8 -Compress))
}
`, 'utf8')
const policy = createPolicy({ approvalFile:'',policyFile:'',estopFile:'',safetyPolicyFile:'' })
const policyCalls = []
let denyTarget = false
const driver = makeDriver({ scriptsDir: directory, evidenceDir: join(directory,'evidence'), procName: 'FakeRef', clientExe: '', lockPath: '', defaultWaitMs: 250,
  policy: { ...policy, needsCheck: () => true, requiresIdentity: false, check: args => { policyCalls.push(args); return denyTarget && args.identity.aid === 'target' ? {ok:false,code:'policy_unavailable',error:'aid denied'} : policy.check(args) } } })
const requests = () => readFileSync(capture,'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
const valid = { action:'pattern', targetRef:'reference-1', value:'Invoke', procId:101, winHandle:42, allowSideEffects:true, waitMs:0 }
try {
  const found = await driver.drive({action:'find',name:'target',procId:101})
  assert.equal(found.targetRef,'reference-1')
  const state = await driver.drive({action:'state',procId:101,winHandle:42})
  assert.equal(state.controls[0].targetRef,'reference-1')
  assert.equal((await driver.drive({...valid,snapshotId:state.snapshotId})).ok,true)
  assert.equal(policyCalls.at(-1).identity.aid,'target')
  assert.equal(requests().at(-1).targetRef,'reference-1')
  await driver.drive({action:'find',name:'target',procId:101})
  const beforeInvalid = requests().length
  const policyBeforeInvalid = policyCalls.length
  for (const extra of [{name:'target'},{aid:'target'},{match:'x'},{index:0},{index:null},{inAid:'scope'},{inName:'scope'},{waitFor:{}},{requireUnique:true},{action:'click'},{targetRef:''},{targetRef:null},{targetRef:12},{visualFallback:true},{action:'doubleclick',visualFallback:true}]) {
    const result = await driver.drive({...valid,...extra})
    assert.equal(result.invalidTargetRef,true,JSON.stringify(result))
    assert.equal(result.notExecuted,true)
  }
  assert.equal(requests().length,beforeInvalid)
  assert.equal(policyCalls.length,policyBeforeInvalid)
  const denied = await driver.drive({...valid,allowSideEffects:false})
  assert.equal(denied.ok,false)
  assert.equal(requests().length,beforeInvalid)
  denyTarget = true
  const deniedByAid = await driver.drive(valid)
  assert.equal(deniedByAid.policyCode,'policy_unavailable')
  assert.equal(requests().length,beforeInvalid)
  denyTarget = false
  await driver.drive({action:'find',name:'stale',procId:101})
  const stale = await driver.drive({...valid,targetRef:'stale'})
  assert.equal(stale.staleTargetRef,true)
  assert.equal(stale.notExecuted,true)
  assert.equal(stale.evidence.executed,false)
  assert.equal(requests().length,beforeInvalid+2)
  await driver.drive({action:'find',name:'unknown',procId:101})
  const uncertain = await driver.drive({...valid,targetRef:'unknown'})
  assert.equal(uncertain.unknown,true)
  assert.equal(uncertain.evidence.executed,null)
  assert.equal(requests().length,beforeInvalid+4)
  for (const reference of ['reference-1','stale','unknown']) {
    await driver.drive({action:'find',name:reference,procId:101})
    const beforeDoubleclick = requests().length
    const result = await driver.drive({...valid,action:'doubleclick',targetRef:reference,value:undefined,waitMs:undefined})
    assert.equal(requests().length,beforeDoubleclick+1)
    assert.equal(requests().at(-1).action,'doubleclick')
    assert.equal(requests().at(-1).targetRef,reference)
    assert.equal(requests().at(-1).waitMs,0)
    assert.equal(policyCalls.at(-1).identity.aid,'target')
    if (reference === 'reference-1') assert.equal(result.ok,true)
    if (reference === 'stale') { assert.equal(result.notExecuted,true); assert.equal(result.evidence.executed,false) }
    if (reference === 'unknown') { assert.equal(result.unknown,true); assert.equal(result.evidence.executed,null) }
    const consumed = await driver.drive({...valid,action:'doubleclick',targetRef:reference})
    assert.equal(consumed.staleTargetRef,true)
    assert.equal(consumed.notExecuted,true)
    assert.equal(requests().length,beforeDoubleclick+1)
  }
  await driver.drive({action:'find',name:'target',procId:101})
  assert.equal((await driver.drive({...valid,action:'doubleclick',waitMs:17})).ok,true)
  assert.equal(requests().at(-1).waitMs,17)
  const beforeFlow = requests().length
  const flow = await driver.flow({steps:[valid],allowSideEffects:true})
  assert.equal(flow.invalidTargetRef,true)
  assert.equal(flow.notExecuted,true)
  assert.equal(requests().length,beforeFlow)
  driver.warmShutdown()
  const cold = await driver.drive(valid)
  assert.equal(cold.staleTargetRef,true)
  assert.equal(cold.notExecuted,true)
  console.log('PASS targetRef driver: pattern/doubleclick, default/explicit waits, visual/selector conflicts, authorization, snapshot, consume, stale/unknown no replay, flow rejection and cold refusal')
} finally {
  driver.warmShutdown()
  rmSync(directory,{recursive:true,force:true})
}
