import test from 'node:test';
import assert from 'node:assert/strict';
import {formalSpecification,challengeReport,challengeQuestions,assertRedTests,modelVendor} from '../src/core/engineering-gates.js';
import {geometryChanges} from '../src/core/visual-regression.js';
import {previewConfiguration,discoverPreview,localPreviewURL} from '../src/core/preview-server.js';
import {Autopilot} from '../src/core/autopilot.js';
import {preferenceQuestion} from '../src/core/autopilot-policy.js';
import {modelUsageLabel} from '../src/core/model-usage.js';
const plan=()=>({version:'1.0.0',formal:{schemaVersion:1,constraints:[{id:'C1',subject:'count',kind:'number',minimum:0,maximum:10,requirementIds:['R1']}]},requirements:[{id:'R1',context:'Counter',trigger:'Add',reaction:'Increase',acceptanceCriteria:['incremented']}],testPlan:{files:['tests/app.test.cjs'],cases:[{id:'T1',requirementId:'R1'}]},tasks:[{id:'core',kind:'feature',writePaths:['core.cjs']},{id:'tests',kind:'test',writePaths:['tests/app.test.cjs']}]});
test('formal gate accepts bounded BDD contracts and blocks contradictory ranges, enums, references and test ownership',()=>{
 assert.equal(formalSpecification(plan()).validation.status,'passed');
 for(const patch of [p=>p.formal.constraints.push({id:'C2',subject:'count',kind:'number',minimum:11,requirementIds:['R1']}),p=>p.formal.constraints[0].requirementIds=['missing'],p=>p.tasks[0].writePaths=['tests/app.test.cjs'],p=>p.requirements[0].trigger='',p=>p.formal={schemaVersion:2,constraints:[]}]){const p=plan();patch(p);assert.throws(()=>formalSpecification(p));}
 const p=plan();p.formal.constraints=[{id:'C1',subject:'state',kind:'enum',allowed:['on'],requirementIds:['R1']},{id:'C2',subject:'state',kind:'enum',allowed:['off'],requirementIds:['R1']}];assert.throws(()=>formalSpecification(p),/교집합/);
});
test('critical consensus uses known model vendors, not platform logos, and one blocking evidence already pauses work',()=>{
 assert.equal(modelVendor('grok','gpt-6'),'openai');assert.equal(modelVendor('grok','grok-4'),'xai');assert.equal(modelVendor('grok','auto'),null);
 const report=challengeReport({summary:'Boundary issue',findings:[{risk:'boundary',severity:'warning',requirementIds:['R1'],assumption:'inclusive boundary',evidence:'count=10 permits +1 despite max10',question:'최댓값에서 어떻게 처리하나요?'}]},plan().requirements);
 assert.equal(challengeQuestions([{...report,actor:'a',provider:'gpt',vendor:'openai'},{...report,actor:'b',provider:'grok',vendor:'openai'}]).length,0);
 assert.equal(challengeQuestions([{...report,actor:'a',vendor:'openai'},{...report,actor:'b',vendor:'anthropic'}]).length,1);
 report.findings[0].severity='blocking';assert.equal(challengeQuestions([{...report,actor:'a',vendor:null}]).length,1);
 assert.throws(()=>challengeReport({...report,findings:[{...report.findings[0],requirementIds:['forged']}]},plan().requirements));
});
test('test-first gate requires every planned case to execute and rejects setup, syntax, skipped and already-green baselines',()=>{
 const valid={configured:true,passed:false,exitCode:1,cases:[{id:'T1',status:'failed'}],output:'not ok 1 - T1 increments'};
 assert.equal(assertRedTests(valid,plan().testPlan).status,'red');
 for(const change of [{passed:true},{requiresConsent:true},{output:'SyntaxError: missing )'},{cases:[]},{cases:[{id:'T1',status:'skipped'}]}])assert.throws(()=>assertRedTests({...valid,...change},plan().testPlan));
});
test('preview discovery accepts framework scripts and refuses remote/credential URLs, shell command fields and unsafe profiles',()=>{
 assert.deepEqual(discoverPreview({scripts:{dev:'vite',ssr:'next dev',start:'react-scripts start',build:'vite build'}}).map(r=>r.kind).sort(),['next','react-scripts','vite']);
 assert.equal(localPreviewURL('http://localhost:5173/board').hostname,'127.0.0.1');
 for(const url of ['https://example.com:5173/','http://127.0.0.1:22/','http://a:b@localhost:5173/','http://127.0.0.1:3000/.env','http://127.0.0.1:3000/?token=x','http://169.254.169.254:3000/'])assert.throws(()=>localPreviewURL(url));
 for(const input of [{mode:'script',script:'npm run dev; rm -r',url:'http://localhost:3000/'},{profiles:[{id:'bad',width:10,height:10}]},{profiles:[{id:'x',width:390,height:844,path:'//remote.test'}]}])assert.throws(()=>previewConfiguration(input));
});
test('DOM regression quantifies geometry/style changes without calling them a similarity score',()=>{
 const a=[{id:'button',tag:'BUTTON',x:0,y:0,width:120,height:44,fontSize:'16px'}],b=[{...a[0],width:80,fontSize:'12px'}];
 assert.deepEqual(geometryChanges(a,a),[]);const rows=geometryChanges(a,b);assert.equal(rows[0].deltas.width,-40);assert.deepEqual(rows[0].styles,['fontSize']);
});
test('autopilot starts enabled with no rules, reuses only an explicit exact preference and isolates OS user, folder, request and changed choices',async()=>{
 const data=new Map(),store={read:async(k,d)=>structuredClone(data.get(k)??d),write:async(k,v)=>data.set(k,structuredClone(v))};let enabled=true;
 const policy=new Autopilot(store,{get:async()=>({autopilotEnabled:enabled})},async()=>'owner'),state={projectId:'p',grantId:'g',request:'Build board',questionSource:'requirements',questions:[{id:'Q1',prompt:'화면 테마는 무엇으로 할까요?',options:['다크','라이트']}]};
 assert.deepEqual(await policy.answers(state,state.questions),[]);await policy.rememberQuestions(state,[{id:'Q1',kind:'option',value:'다크'}],['Q1']);assert.equal((await policy.answers(state,state.questions))[0].value,'다크');
 for(const patch of [{grantId:'new'},{request:'New app'},{questionSource:'critical-challenge'}])assert.deepEqual(await policy.answers({...state,...patch},state.questions),[]);
 assert.deepEqual(await new Autopilot(store,{get:async()=>({autopilotEnabled:true})},async()=>'other').answers(state,state.questions),[]);
 assert.deepEqual(await policy.answers(state,[{...state.questions[0],options:['blue']}]),[]);enabled=false;assert.deepEqual(await policy.answers(state,state.questions),[]);
 assert.equal(preferenceQuestion({prompt:'색상 설정과 배포 권한을 승인할까요?'}),false);assert.equal(preferenceQuestion({prompt:'테마와 호출 예산은?'}),false);
 await policy.remove('p',null);assert.equal((await policy.list('p')).length,0);
});
test('per-model usage distinguishes actual token reports, missing costs and API estimates',()=>{
 assert.match(modelUsageLabel({model:'test',measured:1,input:100,output:20,calls:2,api:false}),/일부 미집계/);
 assert.match(modelUsageLabel({model:null,measured:0,calls:1,api:true}),/비용 미확인/);
 assert.match(modelUsageLabel({model:'api',measured:1,input:100,output:20,calls:1,api:true,estimatedUsd:.01}),/API 추정 \$0.0100/);
});
