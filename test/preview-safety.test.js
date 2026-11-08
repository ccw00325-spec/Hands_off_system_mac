import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {Projects} from '../src/core/projects.js';
import {Workspace} from '../src/core/workspace.js';
import {PreviewServers,discoverPreview} from '../src/core/preview-server.js';
import {Autopilot} from '../src/core/autopilot.js';
import {aggregateModels} from '../src/core/model-usage.js';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'cw-preview-safety-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:8}));const folder=join(root,'app');await mkdir(folder);
 const store=new Store(join(root,'profile'),{});await store.init();const projects=new Projects(store),id=(await projects.list()).activeId,workspace=new Workspace(projects),pending=await workspace.prepare(id,folder);await workspace.consent(id,pending.ticket,true);const grant=await workspace.grant(id);await workspace.setExecutionApproval(id,grant.grantId,true);
 await writeFile(join(folder,'package.json'),JSON.stringify({scripts:{dev:'vite',custom:'node server.cjs',stop:'node stop.cjs'}}));const server=new PreviewServers(workspace,store,async()=>'owner');return{root,folder,store,workspace,id,grant,server};
}
test('preview approval binds the shown command, manifest, backend, folder and device; changed settings cannot reuse consent',async t=>{
 const f=await fixture(t),options={executionBackend:'host',dockerImage:'node:24-bookworm-slim'},input={mode:'auto',profiles:[]},shown=await f.server.fingerprint(f.id,options,input);
 await writeFile(join(f.folder,'package.json'),JSON.stringify({scripts:{dev:'vite --open'}}));await assert.rejects(f.server.approve(f.id,options,input,shown.key),/바뀌/);assert.equal((await f.server.allowed(f.id,options)).allowed,false);
 const next=await f.server.fingerprint(f.id,options,input);await f.server.approve(f.id,options,input,next.key);assert.equal((await f.server.allowed(f.id,options)).allowed,true);
 assert.equal((await f.server.allowed(f.id,{...options,executionBackend:'docker'})).allowed,false);
 assert.equal((await new PreviewServers(f.workspace,f.store,async()=>'other').allowed(f.id,options)).allowed,false);
 const replacement=await f.workspace.prepare(f.id,f.folder);await f.workspace.consent(f.id,replacement.ticket,true);assert.equal((await f.server.allowed(f.id,options)).allowed,false);
});
test('preview never falls back from Docker, starts no process after consent is revoked, and labels external sources unverified',async t=>{
 const f=await fixture(t),options={allowExecution:true,executionBackend:'docker',dockerImage:'missing-fixture-image'},input={mode:'auto',profiles:[]};await f.server.approve(f.id,options,input);f.server.executionAllowed=async()=>false;
 await assert.rejects(f.server.start({projectId:f.id,grantId:f.grant.grantId,options,signal:AbortSignal.timeout(5000)}),/동의|위치/);
 await f.server.approve(f.id,options,{mode:'external',url:'http://localhost:5173/board',profiles:[]});const live=await f.server.start({projectId:f.id,grantId:f.grant.grantId,options,signal:AbortSignal.timeout(5000)});assert.equal(live.unverifiedSource,true);await live.close();
 assert.equal(discoverPreview({scripts:{bad:'echo secret && vite',other:'node server.cjs',build:'vite build'}}).length,0);
});
test('saved design reuse requires direct approval and exact spec, artifact, request and enabled policy; removal revokes it',async()=>{
 const data=new Map(),store={read:async(k,d)=>structuredClone(data.get(k)??d),write:async(k,v)=>data.set(k,structuredClone(v))};let enabled=true;const auto=new Autopilot(store,{get:async()=>({autopilotEnabled:enabled})},async()=>'owner'),state={projectId:'p',grantId:'g',request:'Build',spec:'spec1',design:{status:'ready',format:'layout',previewText:'Mint board',provider:'gpt'}};
 await assert.rejects(auto.rememberDesign(state));assert.equal(await auto.approvesDesign(state),false);await auto.rememberDesign({...state,design:{...state.design,status:'approved'}});assert.equal(await auto.approvesDesign(state),true);
 for(const changed of [{spec:'new'},{request:'other'},{design:{...state.design,previewText:'Changed layout'}}])assert.equal(await auto.approvesDesign({...state,...changed}),false);
 enabled=false;assert.equal(await auto.approvesDesign(state),false);enabled=true;await auto.remove('p',null);assert.equal(await auto.approvesDesign(state),false);
});
test('model dashboard aggregates real reports across panels without inventing CLI price or unreported tokens',()=>{
 const rows=aggregateModels({byPanel:{a:{models:{a:{provider:'gpt',model:'api',api:true,calls:2,measured:1,input:100,output:10,estimatedUsd:.01}}},b:{models:{b:{provider:'gpt',model:'api',api:true,calls:1,measured:1,input:20,output:5,estimatedUsd:.02},c:{provider:'claude',model:'cli',api:false,calls:1}}}}});
 assert.deepEqual(rows[0],{provider:'gpt',model:'api',api:true,calls:3,measured:2,input:120,output:15,estimatedUsd:.03});assert.equal(rows[1].estimatedUsd,undefined);assert.equal(rows[1].measured,0);
});
