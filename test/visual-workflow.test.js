import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.js';
import {Projects} from '../src/core/projects.js';
import {Workspace,digest} from '../src/core/workspace.js';
import {Workflow} from '../src/core/workflow.js';
import {roleProviders} from '../src/core/roles.js';
const team=[{id:'gpt',provider:'gpt',roles:['control','review']},{id:'grok',provider:'gpt',roles:['feature']},{id:'claude',provider:'gpt',roles:['ui']}];
async function fixture(t,{rounds=1,blocked=false,malicious=false,mutate=false,alwaysDifferent=false}={}){
 const base=await mkdtemp(join(tmpdir(),'visual-flow-'));t.after(()=>rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:100}));const root=join(base,'project');await mkdir(root);const store=new Store(join(base,'profile'),{});await store.init();const projects=new Projects(store),id=(await projects.list()).activeId,workspace=new Workspace(projects);const ticket=await workspace.prepare(id,root);await workspace.consent(id,ticket.ticket,true);
 const calls=[],builds=[],reference=Buffer.from('reference-fixture');let visualCalls=0,validationCalls=0;
 const provider={ready:async()=>true,plan:async()=>({spec:'Approved UI spec',design:{screens:[{name:'Main',layout:'120px button'}]},tasks:[{id:'ui',owner:'claude',kind:'ui',instructions:'Render reference',acceptanceCriteria:['120px button'],writePaths:['styles.css'],dependsOn:[]}]}),build:async context=>{builds.push(context);return{summary:'Written UI fixture',files:[{path:'styles.css',content:'button{width:'+(context.issues.length?120:80)+'px}'}]};},review:async context=>{
  calls.push(context);if(!context.visualComparison)return{summary:'Read-only code review',issues:[]};visualCalls++;
  if(mutate)await workspace.write(id,'styles.css','external change');
  const different=alwaysDifferent||!(await workspace.read(id,'styles.css')).toString().includes('120');
  return{verdict:different?'mismatch':'match',summary:different?'버튼 폭 차이':'여섯 기준 일치',observations:['layout','color','typography','spacing','size','icons'].map(category=>({category,status:different&&category==='size'?'different':'match',expected:'120px button',actual:different?'80px button':'120px button',evidence:'Button extent comparison'})),issues:different?[{taskId:'ui',owner:'claude',file:malicious?'tests/fake.test.js':'styles.css',description:'Set button width to120px'}]:[]};}};
 const engine=new Workflow(workspace,roleProviders({gpt:provider}),()=>{},async()=>{validationCalls++;return{configured:true,passed:true,summary:'Functional fixture passed',output:'ok'};});
 engine.designGenerator=async()=>{const path='design/reference.png';await workspace.write(id,path,reference);return{path,hash:digest(reference),artifactId:'ref'};};
 engine.visualCapture={capture:async context=>{if(blocked)throw Object.assign(new Error('Preview needs permission'),{requiresPreviewConsent:true});const pixels=await workspace.read(id,'styles.css'),path=`.control-tower/runs/${context.runId}/visual/${context.round}-${randomUUID()}-comparison.png`;await workspace.write(id,path,pixels,{internal:true});return{sourceHash:context.sourceHash,referenceHash:context.referenceHash,viewport:{width:640,height:480},actual:{hash:digest(pixels)},comparison:{path,hash:digest(pixels)},assets:[],metrics:{}};},stable:async()=>true};
 await engine.start(id,{request:'Build approved UI',team,designApproval:true,designMode:'image',visualReview:true,maxRepairRounds:rounds,maxAgentCalls:20});
 const end=Date.now()+5000;while(Date.now()<end&&engine.runs.get(id).state.design?.status!=='ready')await new Promise(r=>setTimeout(r,5));
 await engine.approveDesign(id,undefined);await engine.runs.get(id).promise;
 return{engine,id,root,workspace,calls,builds,get visualCalls(){return visualCalls;},get validationCalls(){return validationCalls;},state:await engine.current(id)};
}
test('visual mismatch repairs only its UI owner, reruns functional validation and is required before completion',async t=>{
 const f=await fixture(t);assert.equal(f.state.status,'completed');assert.equal(f.state.visual.status,'matched');assert.equal(f.builds.length,2);assert.equal(f.visualCalls,2);assert.equal(f.validationCalls,2);
 assert.deepEqual(f.builds[1].issues.map(row=>row.file),['styles.css']);assert.match(f.builds[1].task.instructions,/LEFT panel/);assert.equal((await readFile(join(f.root,'styles.css'),'utf8')),'button{width:120px}');
 const before=f.calls.length;await f.engine.reviewVisual(f.engine.runs.get(f.id),await f.workspace.snapshot(f.id));assert.equal(f.calls.length,before);assert.equal(f.engine.runs.get(f.id).state.visual.reused,true);
});
test('missing preview consent blocks without a vision call even when functional validation passed',async t=>{
 const f=await fixture(t,{blocked:true});assert.equal(f.state.status,'awaiting_validation');assert.equal(f.state.validation.passed,true);assert.equal(f.state.visual.requiresPreviewConsent,true);assert.equal(f.visualCalls,0);assert.equal(f.builds.length,1);
});
test('visual repair limit is enforced without marking a mismatch completed',async t=>{
 const f=await fixture(t,{rounds:0,alwaysDifferent:true});assert.equal(f.state.status,'needs_attention');assert.equal(f.state.visual.status,'mismatch');assert.equal(f.builds.length,1);
});
test('an invalid correction target is blocked and never weakens tests',async t=>{
 const f=await fixture(t,{malicious:true});assert.equal(f.state.status,'awaiting_validation');assert.equal(f.state.visual.status,'blocked');assert.equal(f.builds.length,1);assert.match(f.state.visual.summary,/UI 담당/);
});
test('source mutation during visual review invalidates the verdict',async t=>{
 const f=await fixture(t,{mutate:true});assert.equal(f.state.status,'awaiting_validation');assert.equal(f.state.visual.status,'blocked');assert.match(f.state.visual.summary,/바뀌었/);
});

test('simultaneous visual retry requests cannot start two runs for the same project',async t=>{
 const f=await fixture(t,{blocked:true});
 const results=await Promise.allSettled([f.engine.retryVisual(f.id,f.state.id,{}),f.engine.retryVisual(f.id,f.state.id,{})]);
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.match(results.find(row=>row.status==='rejected').reason.message,/현재 작업/);
 await f.engine.runs.get(f.id).promise;
});
