// Regression: cleanup failures remain recoverable through a new trace instance; async owner changes never overwrite another attempt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {makeTrace} from '../lib/trace.mjs';
import {withTaskContext} from '../../../lib/task-context.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trace-recovery-journal-'));
process.env.DSH_NO_ENV_FALLBACK='1';
const good=()=>({code:0,stdout:'',stderr:'',timedOut:false});
const bad=()=>({code:1,stdout:'',stderr:'fixture stop failed',timedOut:false});
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}};
const serialize=e=>e?{message:e.message,code:e.code,unknown:e.unknown,incomplete:e.incomplete,recovery:e.recovery}:null;
async function scenario(name,opts){
 const evidenceDir=path.join(dir,name),lease=path.join(evidenceDir,'lease.json'),session=path.join(evidenceDir,'trace-session.json');
 const ctrl=new AbortController(),calls=[],state={kernel:false,aux:[]};
 const originalWrite=fs.writeFileSync;
 let firstPhase=true,starts=0,markerFailures=0,result,error;
 const foreign={attemptId:'fixture-foreign',state:'running',engine:'wpr',etlPath:path.join(evidenceDir,'foreign.etl')};
 const replaceOwner=()=>{originalWrite(lease,JSON.stringify(foreign));originalWrite(session,JSON.stringify(foreign));};
 const config={evidenceDir,kernelLeaseFile:lease,wpr:process.execPath,xperf:process.execPath,logman:process.execPath,runExe:async(_exe,args)=>{
  calls.push({phase:firstPhase?'initial':'recovery',args});
  if(args.includes('-Command'))return {...good(),stdout:'True'};
  const namedStart=args[0]==='start'||(args[0]==='-start'&&String(args[1]).startsWith('dshperf'));
  if(namedStart){
   state.aux.push(args[1]);
   if(opts.abortOnAuxStart)ctrl.abort(new Error('fixture cancelled after auxiliary start'));
   return good();
  }
  if(args[0]==='-start'||args[0]==='-on'){
   starts++;state.kernel=true;
   if(opts.ownerChangedAtStart)replaceOwner();
   if(opts.abortOnKernelStart)ctrl.abort(new Error('fixture cancelled after kernel start'));
   return good();
  }
  const namedStop=args[0]==='stop'||(args[0]==='-stop'&&String(args[1]).startsWith('dshperf'));
  if(namedStop){
   if(firstPhase&&opts.ownerChangedDuringAuxStop)replaceOwner();
   if(firstPhase&&opts.auxStopFails)return bad();
   if(!state.aux.includes(args[1]))return {...bad(),stderr:'fixture session no longer exists'};
   state.aux=state.aux.filter(x=>x!==args[1]);return good();
  }
  if(args[0]==='-stop'||args[0]==='-cancel'){
   if(firstPhase&&opts.ownerChangedDuringKernelStop)replaceOwner();
   if(firstPhase&&opts.preflightStopThrows&&args[0]==='-stop')throw Object.assign(new Error('fixture stop threw'),{code:'EIO'});
   if(firstPhase&&opts.kernelStopFails)return bad();
   if(!state.kernel)return {...bad(),stderr:'fixture no kernel recording'};
   state.kernel=false;
   if(args[0]==='-stop'&&args[1])originalWrite(args[1],'fixture ETL');
   return good();
  }
  return good();
 }};
 const trace=makeTrace(config);
 if(opts.markerWriteFails){
  fs.writeFileSync=function(file,data,...rest){
   if(firstPhase&&String(file)===session&&typeof data==='string'&&data.includes('"state":"running"')){
    markerFailures++;throw Object.assign(new Error('fixture running-marker ENOSPC'),{code:'ENOSPC'});
   }
   return originalWrite.call(fs,file,data,...rest);
  };syncBuiltinESMExports();
 }
 try{
  try{result=await withTaskContext({signal:ctrl.signal},()=>trace.trace({action:'start',engine:opts.engine||'wpr',skipPreflight:!opts.preflight,clr:!!opts.clr,jit:!!opts.jit,alloc:!!opts.alloc}));}
  catch(e){error=serialize(e);}
  if(opts.directCancel||opts.directStop){try{result=await trace.trace({action:opts.directStop?'stop':'cancel'});}catch(e){error=serialize(e);}}
  const before={result,error,lease:read(lease),session:read(session),fixtureState:structuredClone(state),markerFailures,starts};
  firstPhase=false;
  // Recover after the injected I/O or stop failure has been removed. Do not edit persisted state.
  let recovery,recoveryError;
  try{recovery=await makeTrace(config).trace({action:'cancel'});}catch(e){recoveryError=serialize(e);}
  return {name,opts,before,recovery,recoveryError,after:{lease:read(lease),session:read(session),fixtureState:structuredClone(state)},calls};
 }finally{fs.writeFileSync=originalWrite;syncBuiltinESMExports();}
}

const globalStop=c=>c.args[0]==='-cancel'||(c.args[0]==='-stop'&&!String(c.args[1]).startsWith('dshperf'));
const recovered=c=>{
 assert.equal(c.recovery?.ok,true,JSON.stringify(c));
 assert.equal(c.after.fixtureState.kernel,false);
 assert.equal(c.after.fixtureState.aux.length,0);
 assert.equal(c.after.lease,null);
 assert.equal(c.after.session,null);
};
try {
 const preflight=await scenario('preflight-stop-failed',{preflight:true,kernelStopFails:true});
 assert.equal(preflight.before.result?.unknown,true);
 assert.equal(preflight.before.lease?.recoveryReady,true);
 recovered(preflight);
 const thrown=await scenario('preflight-stop-threw',{preflight:true,preflightStopThrows:true});
 assert.ok(thrown.calls.some(c=>c.phase==='initial'&&c.args[0]==='-cancel'));
 assert.equal(thrown.before.result?.ok,true);
 recovered(thrown);
 const disk=await scenario('marker-and-cleanup-failed',{markerWriteFails:true,kernelStopFails:true,auxStopFails:true,clr:true,jit:true,alloc:true});
 assert.equal(disk.before.result?.unknown,true);
 assert.equal(disk.before.lease?.recoveryReady,true);
 assert.equal(disk.before.session?.state,'starting');
 assert.ok(disk.before.lease.clrSession&&disk.before.lease.jitSession&&disk.before.lease.allocSession);
 recovered(disk);
 const aux=await scenario('aux-only-recovery',{markerWriteFails:true,auxStopFails:true,clr:true,jit:true});
 assert.equal(aux.before.lease?.kernelStopped,true);
 recovered(aux);
 assert.equal(aux.calls.filter(c=>c.phase==='recovery'&&globalStop(c)).length,0);
 const duringAux=await scenario('owner-changed-during-aux-stop',{clr:true,jit:true,abortOnAuxStart:true,ownerChangedDuringAuxStop:true});
 assert.equal(duringAux.calls.filter(c=>c.phase==='initial'&&globalStop(c)).length,0);
 assert.equal(duringAux.before.lease?.attemptId,'fixture-foreign');
 assert.equal(duringAux.before.session?.attemptId,'fixture-foreign');
 const duringKernel=await scenario('owner-changed-during-failed-stop',{abortOnKernelStart:true,clr:true,kernelStopFails:true,ownerChangedDuringKernelStop:true});
 assert.equal(duringKernel.before.lease?.attemptId,'fixture-foreign');
 assert.equal(duringKernel.before.session?.attemptId,'fixture-foreign');
 const fallback=await scenario('owner-changed-before-stop-fallback',{directStop:true,kernelStopFails:true,ownerChangedDuringKernelStop:true});
 assert.equal(fallback.before.result?.unknown,true);
 assert.equal(fallback.calls.filter(c=>c.phase==='initial'&&c.args[0]==='-cancel').length,0);
 assert.equal(fallback.before.session?.attemptId,'fixture-foreign');
 const probeOwner=await scenario('owner-changed-during-probe',{preflight:true,ownerChangedAtStart:true});
 assert.equal(probeOwner.before.result?.unknown,true);
 assert.equal(probeOwner.calls.filter(c=>c.phase==='initial'&&globalStop(c)).length,0);
 assert.equal(probeOwner.before.session?.attemptId,'fixture-foreign');
 // A new instance can recover a crashed operation, but may not race an active startup.
 {
  const evidenceDir=path.join(dir,'operation-lock'),lease=path.join(evidenceDir,'lease.json');
  let nested,trace;
  const calls=[];
  const config={evidenceDir,kernelLeaseFile:lease,wpr:process.execPath,runExe:async(_exe,args)=>{
   calls.push(args);
   if(args.includes('-Command'))return {...good(),stdout:'True'};
   if(args[0]==='-start')nested=await trace.trace({action:'cancel'});
   return good();
  }};
  trace=makeTrace(config);
  assert.equal((await trace.trace({action:'start',skipPreflight:true})).ok,true);
  assert.equal(nested.busy,true);
  assert.equal(calls.some(args=>args[0]==='-cancel'),false);
  const child=spawnSync(process.execPath,['-e',''],{encoding:'utf8'});
  assert.equal(child.status,0);
  assert.ok(child.pid>0);
  fs.writeFileSync(lease+'.stop',JSON.stringify({attemptId:read(lease).attemptId,ownerPid:child.pid,token:'crashed-operation'}));
  assert.equal((await makeTrace(config).trace({action:'cancel'})).ok,true);
  assert.equal(fs.existsSync(lease+'.stop'),false);
 }
 // Refuse an external start if its recovery journal cannot be committed first.
 {
  const evidenceDir=path.join(dir,'journal-write-failed'),lease=path.join(evidenceDir,'lease.json');
  const calls=[],original=fs.writeFileSync;
  fs.writeFileSync=function(file,...args){
   if(String(file).startsWith(lease+'.')&&String(file).endsWith('.tmp'))throw Object.assign(new Error('fixture journal ENOSPC'),{code:'ENOSPC'});
   return original.call(fs,file,...args);
  };syncBuiltinESMExports();
  try{
   const trace=makeTrace({evidenceDir,kernelLeaseFile:lease,wpr:process.execPath,runExe:async(_exe,args)=>{calls.push(args);return {...good(),stdout:'True'};}});
   await assert.rejects(trace.trace({action:'start',skipPreflight:true}),/journal ENOSPC/);
   assert.equal(calls.some(args=>args[0]==='-start'),false);
   assert.equal(fs.existsSync(lease),false);
  }finally{fs.writeFileSync=original;syncBuiltinESMExports();}
 }
 console.log('PASS trace recovery journal: preflight failure/throw, persistent marker failure, new-instance recovery, remaining sessions, owner changes during cleanup');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
