import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {workspaceWindow} from './electron-workspace.mjs';
const artifacts=resolve('artifacts'),id=randomUUID(),profile=join(artifacts,'visual-profile-'+id),root=join(artifacts,'visual-project-'+id),checks=[];
await mkdir(root);await mkdir(profile);for(const dir of [root,profile])await writeFile(join(dir,'.visual-test-owned'),id);
const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;let application;
try{
 application=await electron.launch({args:['.'],cwd:resolve('.'),env});
 await application.evaluate(({dialog,BrowserWindow},data)=>{
  const file=process.getBuiltinModule('url').fileURLToPath(data.url),require=process.getBuiltinModule('module').createRequire(file),module=name=>require(file.replace('providers.js',name+'.js'));
  module('prerequisites').Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
  for(const [file,name]of [['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']]){
   module(file)[name].prototype.status=async()=>({installed:true,connected:true,source:'codex',login:{waiting:false}});module(file)[name].prototype.models=async()=>[{id:'fixture-model',name:'Fixture model',isDefault:true}];
  }
  const Preferences=module('preferences').Preferences,get=Preferences.prototype.get;
  globalThis.__visualBackend='host';globalThis.__previewAnswer=1;
  Preferences.prototype.get=async function(){return{...await get.call(this),onboardingComplete:true,designApproval:true,designMode:'image',visualReview:true,maxRepairRounds:1,maxAgentCalls:30,allowExecution:true,executionBackend:globalThis.__visualBackend,validationScript:'test'};};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[data.root]});dialog.showMessageBox=async(...args)=>({response:args.at(-1)?.title==='UI 브라우저 미리보기 실행'?globalThis.__previewAnswer:1});
  const Workflow=module('workflow').Workflow,start=Workflow.prototype.start;Workflow.prototype.start=async function(...args){globalThis.__visualEngine=this;return start.apply(this,args);};
  const desired=`<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;padding:20px}button{width:120px;height:44px;background:#b1e1d0;border:0}</style><h1>Visual Demo</h1><button id="increment">Add</button><span id="count">0</span>`;
  globalThis.__desired=desired;globalThis.__visualCalls=[];globalThis.__uiBuilds=0;globalThis.__testBuilds=0;
  module('images').ImageService.prototype.generate=async()=>{
   const w=new BrowserWindow({show:false,skipTaskbar:true,useContentSize:true,width:640,height:480,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   try{await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(desired));await new Promise(r=>setTimeout(r,150));const png=(await w.webContents.capturePage()).resize({width:640,height:480}).toPNG();return{buffer:png,dataUrl:'data:image/png;base64,'+png.toString('base64')};}finally{w.destroy();}
  };
  const Provider=require(file).GPTProvider;Provider.prototype.ready=async()=>true;
  Provider.prototype.plan=async()=>({contractVersion:1,version:'1.0.0',questions:[],decisions:[],reviewItems:[],requirements:[{id:'R1',title:'Counter',context:'Initial counter',trigger:'Add',reaction:'Increment by one',acceptanceCriteria:['Counter and UI logic return expected values']}],design:{screens:[{name:'Main',layout:'Title and 120px mint Add button',states:['idle']}],palette:['mint'],spacing:'20px',typography:'sans-serif'},testPlan:{runner:'node-test',files:['tests/demo.test.cjs'],cases:[1,2].map(n=>({id:'T'+n,requirementId:'R1',type:'unit',title:'Counter '+n,given:'Counter module',when:'Increment',expected:'Next value',steps:['Require and assert return value']}))},tasks:[{id:'logic',owner:'grok',kind:'feature',title:'Logic',requirementIds:['R1'],instructions:'Implement counter',acceptanceCriteria:['Counter returns next value'],dependsOn:[],writePaths:['logic.cjs']},{id:'ui',owner:'claude',kind:'ui',title:'UI',requirementIds:['R1'],instructions:'Implement approved UI',acceptanceCriteria:['Button matches approved reference'],dependsOn:['logic'],writePaths:['index.html','styles.css','ui.cjs']},{id:'tests',owner:'gpt',kind:'test',title:'Tests',requirementIds:['R1'],instructions:'Test counter and UI function',acceptanceCriteria:['T1 and T2 pass'],dependsOn:['logic','ui'],writePaths:['tests/demo.test.cjs']}]});
  Provider.prototype.build=async context=>{
   const task=context.task;
   if(task.kind==='feature')return{summary:'Logic fixture',files:[{path:'logic.cjs',content:'exports.next=n=>n+1;'}]};
   if(task.kind==='test'){globalThis.__testBuilds++;return{summary:'Test fixture',files:[{path:'tests/demo.test.cjs',content:"const t=require('node:test'),a=require('node:assert/strict');t('T1 counter',()=>a.equal(require('../logic.cjs').next(1),2));t('T2 UI function',()=>a.equal(require('../ui.cjs').next(4),5));"}]};}
   globalThis.__uiBuilds++;const repaired=context.issues.length>0;
   return{summary:repaired?'Corrected button width':'Initial UI fixture',files:[{path:'index.html',content:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><h1>Visual Demo</h1><button id="increment">Add</button><span id="count">0</span><script src="ui.cjs"></script>'},{path:'styles.css',content:`body{font:16px sans-serif;padding:20px}button{width:${repaired?120:80}px;height:44px;background:#b1e1d0;border:0}`},{path:'ui.cjs',content:"(function(){const next=n=>n+1;if(typeof module!=='undefined')module.exports={next};if(typeof document!=='undefined')document.querySelector('#increment').onclick=()=>{const el=document.querySelector('#count');el.textContent=next(Number(el.textContent));};})();"}]};
  };
  Provider.prototype.review=async context=>{
   if(!context.visualComparison)return{summary:'Fixture code review',issues:[]};
   const width=context.visualComparison.metrics.elements.find(row=>row.id==='increment').width;
   if(!context.designImage)throw new Error('Comparison image missing');globalThis.__visualCalls.push(width);
   return{verdict:width===120?'match':'mismatch',summary:width===120?'버튼 크기 등 여섯 기준 일치':'버튼 폭이 시안과 다릅니다.',observations:['layout','color','typography','spacing','size','icons'].map(category=>({category,status:category==='size'&&width!==120?'different':'match',expected:'시안 버튼 폭 120px',actual:'구현 버튼 폭 '+width+'px',evidence:'Add 버튼의 실제 캡처와 측정값'})),issues:width===120?[]:[{taskId:'ui',owner:'claude',file:'styles.css',description:'Add 버튼 폭을 시안의 120px로 고치고 기능과 테스트는 유지하세요.'}]};
  };
 },{url:pathToFileURL(resolve('src/core/providers.js')).href,root});
 const page=await workspaceWindow(application);page.setDefaultTimeout(20000);
 await page.locator('#first-run-tour[open]').waitFor();await page.locator('#tour-skip').click();
 if(await page.locator('#settings-dialog').evaluate(el=>el.open))await page.locator('#close-settings').click();
 await page.locator('#new-project').click();await page.locator('#folder-consent[open]').waitFor();await page.locator('#folder-consent-check').check();await page.locator('#confirm-folder').click();await page.locator('#folder-consent').waitFor({state:'hidden'});
 const projectId=(await page.evaluate(()=>window.tower.projects())).value.activeId;
 assert.equal((await page.evaluate(id=>window.tower.projectExecution(id,true),projectId)).value,true);
 const team=[{id:'gpt',provider:'gpt',modelId:'fixture-model',roles:['control','review','test']},{id:'grok',provider:'gpt',modelId:'fixture-model',roles:['feature']},{id:'claude',provider:'gpt',modelId:'fixture-model',roles:['ui']}];
 const assigned=await page.evaluate(({id,team})=>window.tower.setTeam(id,team),{id:projectId,team});assert.equal(assigned.ok,true);
 const waitState=async predicate=>{let last;const end=Date.now()+60000;while(Date.now()<end){last=(await page.evaluate(id=>window.tower.workflow(id),projectId)).value;if(last&&predicate(last))return last;await new Promise(r=>setTimeout(r,100));}throw new Error('Unexpected workflow state: '+JSON.stringify({state:last,alerts:await page.locator('#request-alerts').innerText()}));};
 const started=await page.evaluate(id=>window.tower.startWorkflow(id,{request:'Compare and repair approved demo UI'}),projectId);assert.equal(started.ok,true,started.error);
 const ready=await waitState(state=>state.status==='awaiting_design'&&state.design?.status==='ready');
 const approval=await page.evaluate(({id,conversationId})=>window.tower.sendMessage(id,conversationId,'gpt','이대로 적용','work'),{id:projectId,conversationId:ready.options.conversationId});assert.equal(approval.ok,true,approval.error);
 const state=await waitState(state=>['completed','needs_attention','awaiting_validation'].includes(state.status));
 if(state.status!=='completed')await writeFile(join(artifacts,'visual-review-failure.json'),JSON.stringify({state,alerts:await page.locator('#request-alerts').innerText()},null,2));
 assert.equal(state.status,'completed',state.events.at(-1)?.message);assert.equal(state.visual.status,'matched');assert.equal(state.round,1);
 assert.deepEqual(await application.evaluate(()=>globalThis.__visualCalls),[80,120]);assert.equal(await application.evaluate(()=>globalThis.__uiBuilds),2);assert.equal(await application.evaluate(()=>globalThis.__testBuilds),1);assert.equal(state.validation.cases.every(row=>row.status==='passed'),true);
 checks.push('Approved image is compared after actual rendering; a measured 80px mismatch routes only to the UI owner, is repaired to120px, and existing real Node tests rerun without test regeneration');
 await page.locator('#desk-workflow-open').click();await page.locator('#visual-open').click();await page.locator('#visual-dialog[open]').waitFor();
 assert.match(await page.locator('#visual-functional').innerText(),/통과/);assert.equal(await page.locator('#visual-observations li').count(),6);assert.ok((await page.locator('#visual-reference').getAttribute('src')).startsWith('data:image/png;base64,'));assert.ok((await page.locator('#visual-actual').getAttribute('src')).startsWith('data:image/png;base64,'));await page.screenshot({path:join(artifacts,'visual-review-ui.png')});
 await page.locator('#visual-close').click();await page.locator('#close-workflow-dialog').click();checks.push('Comparison dialog separates functional success and visual verdict, displays both real images and six categories, and closes normally');
 await application.evaluate(()=>{globalThis.__visualBackend='docker';globalThis.__previewAnswer=0;});
 const request={id:projectId,runId:state.id};
 assert.equal((await page.evaluate(({id,runId})=>window.tower.visualPermission(id,runId),request)).value.allowed,false);
 assert.equal((await page.evaluate(({id,runId})=>window.tower.visualPermission(id,runId,true),request)).value.allowed,false);
 checks.push('Docker execution consent does not authorize host browser preview; cancelling the separate native preview prompt keeps it denied');
 await application.evaluate(()=>globalThis.__previewAnswer=1);
 assert.equal((await page.evaluate(({id,runId})=>window.tower.visualPermission(id,runId,true),request)).value.allowed,true);
 assert.equal((await page.evaluate(()=>window.tower.preferences())).value.executionBackend,'docker');
 checks.push('Explicit browser preview approval is stored separately without changing the selected Docker test backend');
 assert.equal((await page.evaluate(({id,runId})=>window.tower.visualPermission(id,runId,false),request)).value.allowed,false);
 await application.evaluate(()=>globalThis.__visualBackend='host');
 checks.push('Revoking additional preview approval requires new consent for future Docker-mode previews');
 const sandbox=await application.evaluate(async()=>{
  const engine=globalThis.__visualEngine,state=[...engine.runs.values()][0].state,workspace=engine.workspace;
  const context=()=>({projectId:state.projectId,grantId:state.grantId,runId:state.id,round:state.round,referencePath:state.design.path,referenceHash:state.design.hash,options:state.options,signal:new AbortController().signal});
  await workspace.write(state.projectId,'index.html','<!doctype html><h1 id="probe">sandbox</h1><script>document.querySelector("h1").textContent=typeof require+"/"+typeof process;</script>');
  const evidence=await engine.visualCapture.capture({...context(),sourceHash:(await workspace.snapshot(state.projectId)).hash});
  return{probe:evidence.metrics.text,source:state.snapshotHash};
 });assert.match(sandbox.probe,/undefined\/undefined/);checks.push('Actual preview has no Node require/process access in the sandboxed renderer');
 const denied=await application.evaluate(async()=>{
  const engine=globalThis.__visualEngine,state=[...engine.runs.values()][0].state;
  await engine.workspace.write(state.projectId,'index.html','<!doctype html><h1>Network test</h1><img src="https://untrusted.invalid/test.png">');
  try{await engine.visualCapture.capture({projectId:state.projectId,grantId:state.grantId,runId:state.id,round:state.round,referencePath:state.design.path,referenceHash:state.design.hash,sourceHash:(await engine.workspace.snapshot(state.projectId)).hash,options:state.options,signal:new AbortController().signal});return false;}catch{return true;}
 });assert.equal(denied,true);checks.push('An external image/script policy violation blocks capture rather than producing a passing partial rendering');
 const stale=await page.evaluate(({id,runId})=>window.tower.visualEvidence(id,runId),{id:projectId,runId:state.id});assert.equal(stale.value.stale,true);checks.push('Changing source after a pass marks the stored comparison stale instead of reusing its green result');
 await writeFile(join(artifacts,'visual-review-report.json'),JSON.stringify({passed:checks.length,checks,providerInference:'Explicit fixtures; actual Electron captures, workspace guards, coordinator and Node tests',paidCalls:0},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{
 await application?.close().catch(()=>{});
 for(const dir of [root,profile]){const actual=await realpath(dir),parent=await realpath(artifacts),part=relative(parent,actual);if(!part||part.startsWith('..')||isAbsolute(part)||(await readFile(join(actual,'.visual-test-owned'),'utf8'))!==id)throw new Error('Unsafe test cleanup refused');await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
}
