import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {Projects} from '../src/core/projects.js';
import {Workspace} from '../src/core/workspace.js';
import {Workflow} from '../src/core/workflow.js';
import {roleProviders} from '../src/core/roles.js';
import {validateProject} from '../src/core/validation.js';

const team=[{id:'gpt',provider:'gpt',modelId:'gpt-fixture',roles:['control','review','test']},{id:'grok',provider:'claude',modelId:'claude-fixture',roles:['feature','ui','review','critic']}];
const proposed=()=>({contractVersion:1,version:'1.0.0',questions:[],decisions:[],reviewItems:[],formal:{schemaVersion:1,constraints:[{id:'C1',subject:'counter',kind:'number',minimum:0,maximum:10,requirementIds:['R1','R2']}]},requirements:[{id:'R1',title:'Increment',context:'count under10',trigger:'increment',reaction:'count+1',acceptanceCriteria:['next(1)=2']},{id:'R2',title:'Boundary',context:'count is10',trigger:'increment',reaction:'RangeError',acceptanceCriteria:['next(10) throws RangeError']}],design:{screens:[{name:'Main',layout:'Counter',states:['idle']}],palette:['mint'],spacing:'16px',typography:'sans-serif'},testPlan:{runner:'node-test',files:['tests/counter.test.cjs'],cases:[{id:'T1',requirementId:'R1',type:'unit',title:'increment',given:'1',when:'next',expected:'2',steps:['assert returned value']},{id:'T2',requirementId:'R2',type:'unit',title:'boundary',given:'10',when:'next',expected:'RangeError',steps:['assert exception']}]},tasks:[{id:'core',owner:'grok',kind:'feature',title:'Counter logic',requirementIds:['R1','R2'],instructions:'Implement exports.next in core.cjs',acceptanceCriteria:['increment and cap'],dependsOn:[],writePaths:['core.cjs']},{id:'tests',owner:'gpt',kind:'test',title:'Counter tests',requirementIds:['R1','R2'],instructions:'Use public exports.next',acceptanceCriteria:['T1 T2'],dependsOn:['core'],writePaths:['tests/counter.test.cjs']}]});
const tests="const t=require('node:test'),a=require('node:assert/strict');t('T1 increment',()=>a.equal(require('../core.cjs').next(1),2));t('T2 boundary',()=>a.throws(()=>require('../core.cjs').next(10),RangeError));";
async function fixture(t,{blockingPhase,common=false,sameVendor=false,badTest=false,invalidChallenge=false}={}){
 const base=await mkdtemp(join(tmpdir(),'cw-engineering-'));t.after(()=>rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:100}));const root=join(base,'project');await mkdir(root);const store=new Store(join(base,'profile'),{});await store.init();const projects=new Projects(store),id=(await projects.list()).activeId,workspace=new Workspace(projects);const prepared=await workspace.prepare(id,root);await workspace.consent(id,prepared.ticket,true);const grant=await workspace.grant(id);await workspace.setExecutionApproval(id,grant.grantId,true);
 const events=[],validations=[];let concurrent=0,maxConcurrent=0,normalReviews=0;let started=0,release;const barrier=new Promise(resolve=>{release=resolve;});
 const provider={ready:async()=>true,plan:async()=>proposed(),build:async context=>{events.push(context.task.kind);context.options.onUsage?.(10,5);return{summary:'Fixture files',files:context.task.kind==='test'?[{path:'tests/counter.test.cjs',content:badTest?'this is not valid JS ))':tests}]:[{path:'core.cjs',content:'exports.next=n=>{if(n>=10)throw new RangeError("cap");return n+1;};'}]};},review:async context=>{
  if(!context.challenge){normalReviews++;return{summary:'No ordinary findings',issues:[]};}
  assert.equal(context.priorReviews,undefined);assert.deepEqual(context.handoff.recentFacts,[]);assert.deepEqual(context.handoff.conversation,[]);assert.equal(context.options.conversationHistory,undefined);assert.ok(context.handoff.completedTasks.every(t=>t.summary===undefined));concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);if(context.challenge.phase==='architecture'){if(++started===2)release();await Promise.race([barrier,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Independent reviewers did not start together')),5000);timer.unref();})]);}concurrent--;
  const phase=context.challenge.phase;events.push(phase);context.options.onUsage?.(20,5);
  const findings=phase===blockingPhase&&!context.challenge.userAnswers.length?[{risk:'boundary',severity:common?'warning':'blocking',requirementIds:['R2'],assumption:'cap semantics',evidence:'R2 says maximum10; check next(10)',question:'최댓값에서 증가를 허용하나요?',options:[]}]:[];
  if(invalidChallenge&&phase==='architecture'&&context.options.agentId==='gpt')return{summary:'Malformed finding',findings:[{severity:'blocking'}]};return{summary:findings.length?'Boundary needs a decision':'No concrete assumption gap',findings};}};
 const workflow=new Workflow(workspace,roleProviders({gpt:provider,claude:provider}),()=>{},async context=>{const result=await validateProject(workspace,context);validations.push(result);return result;});
 const chosen=structuredClone(team);if(sameVendor)chosen[1].provider='gpt';
 await workflow.start(id,{request:'Implement a capped counter',conversationId:'fixture',team:chosen,engineeringGates:true,funContract:true,funEnabled:true,designApproval:false,allowExecution:true,executionBackend:'host',validationScript:'test',maxRepairRounds:1,maxAgentCalls:20,maxConcurrentAgents:4});await workflow.runs.get(id).promise;
 return{state:await workflow.current(id),root,events,validations,normalReviews,maxConcurrent,workflow,id,workspace};
}
test('real Node Red precedes implementation, frozen tests turn Green, independent challenge precedes ordered final review',async t=>{
 const f=await fixture(t);assert.equal(f.state.status,'completed',f.state.events.at(-1)?.message);assert.equal(f.state.formal.validation.status,'passed');assert.equal(f.state.architectureChallenge.diversity,2);assert.equal(f.maxConcurrent,2);assert.deepEqual(f.events.filter(e=>['test','feature'].includes(e)),['test','feature']);assert.equal(f.validations[0].passed,false);assert.ok(f.validations[0].cases.every(c=>c.status==='failed'));assert.equal(f.validations[1].passed,true);assert.equal(f.state.testFirst.status,'green');assert.equal(await readFile(join(f.root,'tests/counter.test.cjs'),'utf8'),tests);assert.equal(f.state.redTeam.status,'passed');assert.ok(Object.values(f.state.usage.byPanel).every(panel=>Object.keys(panel.models).length));
});
test('an evidence-backed architecture challenge pauses before test or implementation files',async t=>{
 const f=await fixture(t,{blockingPhase:'architecture'});assert.equal(f.state.status,'needs_input');assert.equal(f.state.questionSource,'critical-challenge');assert.equal(f.validations.length,0);assert.equal(f.events.includes('feature'),false);await assert.rejects(readFile(join(f.root,'core.cjs')),/ENOENT/);
});
test('two independent vendors sharing a warning pause, but one-provider configurations expose limited diversity',async t=>{
 const f=await fixture(t,{blockingPhase:'architecture',common:true});assert.equal(f.state.status,'needs_input');
 const limited=await fixture(t,{sameVendor:true});assert.equal(limited.state.status,'completed');assert.equal(limited.state.architectureChallenge.diversity,1);assert.match(limited.state.architectureChallenge.limitation,/교차 벤더/);
});
test('post-build critical question stops ordinary review and can resume the same test/implementation without regenerating',async t=>{
 const f=await fixture(t,{blockingPhase:'red-team'});assert.equal(f.state.status,'needs_input');assert.equal(f.normalReviews,0);assert.deepEqual(f.events.filter(e=>['test','feature'].includes(e)),['test','feature']);
 const state=f.workflow.runs.get(f.id).state;
 await f.workflow.answerQuestions(f.id,state.id,state.questionBatchId,state.questions.map(q=>({id:q.id,kind:'option',value:'기존 명세대로 유지하고 검토를 계속'})),'fixture');await f.workflow.runs.get(f.id).promise;
 assert.equal((await f.workflow.current(f.id)).status,'completed');assert.deepEqual(f.events.filter(e=>['test','feature'].includes(e)),['test','feature']);
});
test('syntax errors are not accepted as Red and never reach implementation',async t=>{
 const f=await fixture(t,{badTest:true});assert.equal(f.state.status,'needs_attention');assert.equal(f.events.includes('feature'),false);assert.match(f.state.events.at(-1).message,/Red/);
});

test('successful challenge cache is invalidated by changed specification or explicit decisions, even with unchanged source',async t=>{const f=await fixture(t),run=f.workflow.runs.get(f.id),before=f.events.filter(e=>e==='red-team').length;assert.equal(await f.workflow.criticalChallenge(run,'red-team',await f.workspace.snapshot(f.id)),true);assert.equal(f.events.filter(e=>e==='red-team').length,before);run.state.spec+='\nExplicit clarification changed';assert.equal(await f.workflow.criticalChallenge(run,'red-team',await f.workspace.snapshot(f.id)),true);assert.equal(f.events.filter(e=>e==='red-team').length,before+1);});
test('invalid independent report aborts the parallel challenge without implementation or fabricated consensus',async t=>{const f=await fixture(t,{invalidChallenge:true});assert.equal(f.state.status,'needs_attention');assert.equal(f.events.includes('feature'),false);assert.equal(f.validations.length,0);assert.equal(f.workflow.runs.get(f.id).controller.signal.aborted,true);});
