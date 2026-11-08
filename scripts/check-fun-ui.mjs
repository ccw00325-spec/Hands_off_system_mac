import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { workspaceWindow } from './electron-workspace.mjs';
const artifacts=resolve('artifacts'),token=Date.now(),profile=join(artifacts,`fun-profile-${token}`),root=join(artifacts,`fun-project-${token}`);
await mkdir(root,{recursive:true});const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let application;const checks=[];
async function waitRun(page, id, predicate) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    const result=await page.evaluate(id=>window.tower.workflow(id),id);
    if(result.ok&&predicate(result.value)) return result.value;
    await page.waitForTimeout(100);
  }
  throw new Error('Expected workflow state was not reached.');
}
try {
  application=await electron.launch({args:['.'],cwd:resolve('.'),env});
  await application.evaluate(({dialog},data)=>{
    const path=process.getBuiltinModule('url').fileURLToPath(data.url),require=process.getBuiltinModule('module').createRequire(path);
    const module=file=>require(path.replace('providers.js',file+'.js'));
    module('prerequisites').Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
    for(const [file,name]of[['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']]) {
      module(file)[name].prototype.status=async()=>({installed:true,connected:true,state:'connected',login:{waiting:false}});
      module(file)[name].prototype.models=async()=>[{id:'fixture-model',name:'Fixture model'}];
    }
    const Preferences=module('preferences').Preferences,get=Preferences.prototype.get;
    Preferences.prototype.get=async function(){return {...await get.call(this),engineeringGates:false,onboardingComplete:true,designApproval:false};};
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[data.root]});
    globalThis.__funPlans=[];globalThis.__funBuilds=0;globalThis.__answerNotices=[];
    const Input=module('input-notifications').InputNotifications,observe=Input.prototype.observe;
    class TestNotification extends (require('node:events').EventEmitter) {
      static isSupported(){return true;}
      constructor(options){super();this.options=options;globalThis.__answerNotices.push(this);}
      show(){this.shown=true;}
    }
    Input.prototype.observe=async function(state){this.Notification=TestNotification;this.register=async()=>{};return observe.call(this,state);};
    const Provider=module('providers').GPTProvider;
    Provider.prototype.ready=async()=>true;
    Provider.prototype.plan=async context=>{
      globalThis.__funPlans.push({id:context.handoff.runId,options:context.options});
      if(context.options.funEnabled && !context.options.questionAnswers?.length) return {questions:[
        {id:'screen',prompt:'처음 표시할 화면을 선택해 주세요.',options:['목록 화면','상세 화면']},
        {id:'scope',prompt:'기록을 누가 볼 수 있나요?',options:['나만 보기','팀원과 공유']},
      ],tasks:[]};
      return {contractVersion:1,version:'1.0.0',questions:[],requirements:[{id:'R1',title:'Approved scope',context:'User supplied decisions',trigger:'Read output',reaction:'Approved output',acceptanceCriteria:['Output equals approved value']}],
        decisions:[{id:'D1',description:'Explicit user decisions',source:'user'}],reviewItems:[],
        design:{screens:[{name:'Main',layout:'User approved screen',states:['ready']}],palette:['black'],spacing:'16px',typography:'system'},
        tasks:[{id:'logic',title:'Approved output',owner:'grok',kind:'feature',requirementIds:['R1'],instructions:'Write approved output',acceptanceCriteria:['Output equals approved value'],dependsOn:[]}]};
    };
    Provider.prototype.build=async context=>{globalThis.__funBuilds++;return {summary:'Fixture implementation',files:[{path:'approved.cjs',content:`exports.value=${JSON.stringify(context.options.questionAnswers?.[0]?.answers?.[1]?.value??'direct')};`}]};};
    Provider.prototype.review=async()=>({summary:'Fixture review',issues:[]});
    const validate=module('workflow').Workflow.prototype.execute;
    module('workflow').Workflow.prototype.execute=async function(run){this.validate=async()=>({configured:true,passed:true,summary:'Fixture validation; not a real project test'});return validate.call(this,run);};
  },{url:pathToFileURL(resolve('src/core/providers.js')).href,root});
  const page=await workspaceWindow(application);page.setDefaultTimeout(30000);
  await page.locator('#first-run-tour[open]').waitFor();await page.locator('#tour-skip').click();
  await page.locator('#new-project').click();await page.locator('#folder-consent[open]').waitFor();
  await page.locator('#folder-consent-check').check();await page.locator('#confirm-folder').click();await page.locator('#folder-consent').waitFor({state:'hidden'});
  const id=(await page.evaluate(()=>window.tower.projects())).value.activeId;
  const team=[{id:'gpt',provider:'gpt',roles:['control','debug']},{id:'grok',provider:'gpt',roles:['feature','ui']}];
  assert.equal((await page.evaluate(({id,team})=>window.tower.setTeam(id,team),{id,team})).ok,true);
  await page.reload();await page.locator('#fun-option').waitFor();
  await page.waitForFunction(()=>window.tower.startupState().then(row=>row.value.mainVisible));
  await page.locator('#planner-input').fill('독서 기록 화면을 만들어줘');await page.locator('#start-workflow').click();
  await page.locator('#fun-questions-dialog[open]').waitFor();
  assert.equal(await application.evaluate(()=>globalThis.__funBuilds),0);
  assert.equal(await page.locator('#fun-question-fields input:checked').count(),0);
  assert.equal(await page.locator('#fun-option').isChecked(),true);
  assert.equal(await page.locator('#mutation-option').isVisible(),true);
  await page.locator('#submit-fun-questions').click();assert.match(await page.locator('#fun-questions-error').innerText(),/각 질문/);
  checks.push('The actual request pauses before any build, opens neutral unselected choices and refuses incomplete answers; fun and mut are adjacent visible controls');
  await page.locator('#defer-fun-questions').click();await page.locator('#fun-questions-dialog').waitFor({state:'hidden'});
  assert.equal(await application.evaluate(()=>globalThis.__funBuilds),0);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')).minimize());
  await application.evaluate(()=>globalThis.__answerNotices[0].emit('click'));
  await page.locator('#fun-questions-dialog[open]').waitFor();
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')).isMinimized()),false);
  assert.equal(await application.evaluate(()=>globalThis.__answerNotices[0].options.silent),false);
  assert.equal(await application.evaluate(()=>globalThis.__answerNotices.length),1);
  checks.push('Main-process notification wiring requests OS sound once, restores the minimized app and opens the matching question popup when clicked; native display is mocked here');
  await page.locator('[data-question-id=screen] input[value="0"]').check();
  await page.locator('[data-question-id=scope] input[value=text]').check();
  await page.locator('[data-question-id=scope] textarea').fill('내 계정과 지정한 가족만 보기');
  await page.screenshot({path:join(artifacts,'fun-questions.png')});
  await page.keyboard.press('Escape');await page.locator('#answer-fun-questions').click();
  assert.equal(await page.locator('[data-question-id=scope] textarea').inputValue(),'내 계정과 지정한 가족만 보기');
  checks.push('Choice plus free-text answers remain in the popup after Escape and reopening; no default choice is silently submitted');
  await page.locator('#submit-fun-questions').click();await page.locator('#fun-questions-dialog').waitFor({state:'hidden'});
  await waitRun(page,id,run=>run?.status==='completed');
  const plans=await application.evaluate(()=>globalThis.__funPlans);assert.equal(plans[0].id,plans[1].id);
  assert.equal(plans[1].options.questionAnswers[0].answers[1].value,'내 계정과 지정한 가족만 보기');
  assert.match(await readFile(join(root,'approved.cjs'),'utf8'),/지정한 가족/);
  const conversation=(await page.evaluate(id=>window.tower.conversation(id),id)).value.conversation;
  assert.ok(conversation.messages.some(row=>row.role==='user'&&row.content.includes('지정한 가족')));
  checks.push('Submitting sends answers through the real IPC, resumes the same run with recorded user decisions and writes the approved result; fixtures do not claim paid inference or real project tests');
  await page.locator('#fun-option').uncheck();await page.locator('#planner-input').fill('빈칸 확인 절차 없이 간단한 결과를 만들어줘');await page.locator('#start-workflow').click();
  await waitRun(page,id,run=>run?.status==='completed'&&run.governance?.enabled===false);
  assert.equal(await page.locator('#fun-questions-dialog').evaluate(node=>node.open),false);
  assert.equal((await application.evaluate(()=>globalThis.__funPlans)).at(-1).options.funEnabled,false);
  checks.push('Unchecking fun starts direct planning without a fun governance hash or question-first popup; validation and review stages still run');
  await page.reload();await page.locator('#fun-option').waitFor();
  await page.waitForFunction(()=>document.querySelector('#fun-option').checked===false);
  assert.equal((await page.evaluate(()=>window.tower.preferences())).value.funByDefault,false);
  checks.push('The saved fun toggle is restored after a full renderer reload without changing execution permissions');
  await writeFile(join(artifacts,'fun-ui-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0,nativeNotifications:'fixture; separate Windows probe records real OS show event'},null,2));
  console.log(JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
} finally {
  await application?.close().catch(()=>{});
  for(const candidate of [profile,root]) {const actual=await realpath(candidate).catch(()=>null);if(actual===candidate&&actual.startsWith(join(artifacts,'fun-')))await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
