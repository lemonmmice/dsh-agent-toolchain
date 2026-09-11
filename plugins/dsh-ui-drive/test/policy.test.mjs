import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPolicy } from '../lib/policy.mjs'
// 说明（2026-09 P2）：本测试只验 policy 的**身份/规则/授权**判定，不再验快照新鲜度 ——
// 新鲜度是 W1 validateSnapshot（driver 写侧单点）的职责，policy.check 集成路径下从不收 snapshot。
// 故原先的 gen/latestSeq 身份字段、'gen' 快照变体与 snapshot/targetWindowHandle 断言一并删除
// （它们制造了「policy 在管新鲜度」的假象，对应契约已从 policy.mjs 删除）。
const base={exe:'c:/app/client.exe',windowHandle:1,aid:'buy'}
const make=()=>createPolicy({rules:[{exe:'C:/App/client.exe',windowHandle:1,aid:'buy',effect:'allow'}]})
const variants=[['aid', {...base,aid:'sell'}],['windowHandle',{...base,windowHandle:2}],['exe',{...base,exe:'C:/Other.exe'}]]
assert.equal(make().check({action:'click',identity:base,allowSideEffects:true}).ok,true)
for (const [name, identity] of variants) {
  const args={action:'click',identity,allowSideEffects:true}
  assert.equal(make().check(args).ok,false,name+' changed must deny')
  assert.equal(make().check({...args,allowSideEffects:false}).ok,false,name+' no side effects must deny')
  assert.equal(make().check({...args,identity:{...base},allowSideEffects:true}).ok,true,name+' control')
}
let calls=0
assert.equal(make().check({action:'click',identity:base,onExecute:()=>calls++}).ok,false)
assert.equal(calls,0)
assert.equal(make().check({action:'click',identity:base,allowSideEffects:true,onExecute:()=>calls++}).ok,true)
assert.equal(calls,1)
assert.equal(createPolicy({rules:null}).check({action:'click',identity:base,allowSideEffects:true}).code,'policy_unavailable')

// 规则冲突：同一 canonical 身份命中两条 effect 相反的规则 → policy_conflict，且不采用"后写覆盖"
{
  const conflict = createPolicy({
    rules:[{exe:'C:/a.exe',effect:'allow'},{exe:'c:/A.exe',effect:'deny'}],
  })
  assert.equal(conflict.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true}).code,'policy_conflict')
}

// 软/硬分层：只有 safety 文本、没有硬规则表 → 副作用仍然拒（文本不参与执行）
// 且文本必须能在 diagnostics 里被读到（供解释/诊断，而不是当执行门）
{
  const sf = path.join(os.tmpdir(), 'dsh-safety-' + process.pid)
  fs.writeFileSync(sf, '本文档说明：允许一切操作（但这只是解释，不是执行门）')
  try {
    const p = createPolicy({rules:null, safetyPolicyFile:sf})
    assert.match(String(p.diagnostics.safetyPolicyText), /允许一切操作/)
    assert.equal(p.check({action:'click',identity:base,allowSideEffects:true}).code,'policy_unavailable')
    assert.equal(p.check({action:'click',identity:base,allowSideEffects:true,textSaysAllow:true}).code,'policy_unavailable')
  } finally { fs.unlinkSync(sf) }
}
console.log('PASS policy')
