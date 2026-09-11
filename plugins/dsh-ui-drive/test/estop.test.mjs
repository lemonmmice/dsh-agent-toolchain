import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPolicy } from '../lib/policy.mjs'
const file=path.join(os.tmpdir(),'dsh-estop-'+process.pid)
fs.writeFileSync(file,'stop')
try {
 const p=createPolicy({rules:[{exe:'C:/a.exe',effect:'allow'}],estopFile:file})
 assert.equal(p.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true,sessionId:'s1'}).code,'stopped_by_user')
 fs.unlinkSync(file)
 assert.equal(p.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true,sessionId:'s1'}).code,'stopped_by_user')
 p.reset('s2'); assert.equal(p.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true,sessionId:'s1'}).code,'stopped_by_user')
 p.reset('s1'); assert.equal(p.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true,sessionId:'s1'}).ok,true)
 p.stop('s1'); assert.equal(p.check({action:'click',identity:{exe:'C:/a.exe'},allowSideEffects:true,sessionId:'s1',reset:true,force:true}).code,'stopped_by_user')
} finally { if(fs.existsSync(file)) fs.unlinkSync(file) }

// 洞 #4 回归（独立复核 repro 1）：哨兵文件在盘上时，**任何** session 都必须被拒 ——
// 原实现把文件存在性检查门在 `stoppedSession === null` 后面，于是"第一个锁存的 session"之后
// 文件是否还在再也不复查，换个 session 直接放行，与"急停是全局总闸"的承诺冲突。
{
  const xfile = path.join(os.tmpdir(), 'dsh-estop-x-' + process.pid)
  fs.writeFileSync(xfile, 'stop')
  try {
    const p = createPolicy({ rules: [{ exe: 'C:/a.exe', effect: 'allow' }], estopFile: xfile })
    const arg = { action: 'click', identity: { exe: 'C:/a.exe' }, allowSideEffects: true }
    assert.equal(p.check({ ...arg, sessionId: 's1' }).code, 'stopped_by_user')
    assert.equal(p.check({ ...arg, sessionId: 's2' }).code, 'stopped_by_user', '换个 session 不得放行（洞 #4）')
    assert.equal(p.check({ ...arg }).code, 'stopped_by_user', '不带 session 也不得放行')
    assert.equal(p.check({ ...arg, sessionId: 's3', reset: true, force: true }).code, 'stopped_by_user', '模型参数不得复位')
  } finally { fs.unlinkSync(xfile) }
}

// stop()/reset() 的"无 session"归一必须与 check() 对称（原实现 stop() 不带参会**解除**急停）
{
  const p = createPolicy({ rules: [{ exe: 'C:/a.exe', effect: 'allow' }] })
  const arg = { action: 'click', identity: { exe: 'C:/a.exe' }, allowSideEffects: true }
  p.stop()
  assert.equal(p.check(arg).code, 'stopped_by_user', 'stop() 不带参 = 停所有')
  p.reset()
  assert.equal(p.check(arg).ok, true, 'reset() 不带参 = 复位默认 session')
}

console.log('PASS estop')
