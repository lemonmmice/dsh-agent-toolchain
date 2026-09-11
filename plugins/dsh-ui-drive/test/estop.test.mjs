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
console.log('PASS estop')
