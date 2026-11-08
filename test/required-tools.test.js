import test from 'node:test';
import assert from 'node:assert/strict';
import {requireTools,requiredTools} from '../src/core/prerequisites.js';

const report=(state,optional='missing')=>({rows:[{id:'node',label:'Node.js 24+ · npm',required:true,state},{id:'gemini',label:'Gemini CLI',required:false,state:optional}],needsAttention:false});
test('every non-ready required tool blocks the action even if cached attention flag says ready',async()=>{
 let dispatched=0;
 for(const state of ['missing','outdated','unknown','installing','npm-missing','not-running','image-missing']){
  await assert.rejects(()=>requireTools(async()=>report(state),()=>dispatched++),error=>{
   assert.equal(error.code,'PREREQUISITES_REQUIRED');assert.match(error.message,/설치를 진행해주세요.*Node.js/);assert.equal(requiredTools(error.prerequisites).length,1);return true;
  });
 }
 assert.equal(dispatched,0);
});
test('missing optional programs do not block and fresh readiness immediately permits dispatch',async()=>{
 let current=report('missing'),calls=0,scans=0;
 const run=()=>requireTools(async()=>{scans++;return current;},()=>++calls);
 await assert.rejects(run,/준비가 끝나야/);current=report('ready');assert.equal(await run(),1);assert.equal(scans,2);assert.equal(calls,1);
 current=report('outdated');await assert.rejects(run,/설치를 진행/);assert.equal(calls,1);
});
test('a failed or malformed scan never dispatches and required tool selection stays report-specific',async()=>{
 let calls=0;
 for(const scan of [async()=>{throw new Error('probe failed');},async()=>null,async()=>({})])await assert.rejects(()=>requireTools(scan,()=>calls++));
 const first=report('ready'),second={rows:[{id:'claude',label:'Claude Code',required:true,state:'missing'}]};
 await requireTools(async()=>first,()=>calls++);await assert.rejects(()=>requireTools(async()=>second,()=>calls++),/Claude/);assert.equal(calls,1);
});
