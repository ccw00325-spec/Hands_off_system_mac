import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {workspaceWindow} from './electron-workspace.mjs';
const artifacts=resolve('artifacts'),stamp=Date.now(),profile=join(artifacts,`role-review-profile-${stamp}`),root=join(artifacts,`role-review-project-${stamp}`);
await mkdir(root,{recursive:true});const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let application;const checks=[];
async function completed(page,id,previous){const end=Date.now()+45000;while(Date.now()<end){const result=await page.evaluate(id=>window.tower.workflow(id),id);if(result.ok&&result.value?.id!==previous&&result.value?.status==='completed')return result.value;if(result.value?.status==='needs_attention')throw new Error(result.value.events.at(-1).message);await page.waitForTimeout(100);}throw new Error('Simulation did not complete.');}
async function resize(page,count){await page.locator('#agent-count').selectOption(String(count));await page.waitForFunction(count=>document.querySelectorAll('#team-editor fieldset[data-agent]').length===count&&!document.querySelector('#agent-count').disabled,count);}
async function allRoles(page,count){for(const role of ['debug','review','test'])assert.equal(await page.locator(`#team-editor input[value=${role}]:checked`).count(),count);for(const role of ['feature','ui'])assert.equal(await page.locator(`#team-editor input[value=${role}]:checked`).count(),1);}
async function provider(page,actor,name){await page.locator('#role-'+actor).selectOption(name);await page.locator('#panel-model-'+actor).selectOption(name==='claude'?'':'fixture-model');}
try{
  application=await electron.launch({args:['.'],cwd:resolve('.'),env});
  await application.evaluate(({dialog},data)=>{
    const path=process.getBuiltinModule('url').fileURLToPath(data.url),require=process.getBuiltinModule('module').createRequire(path),module=file=>require(path.replace('providers.js',file+'.js'));
    module('prerequisites').Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
    for(const [file,name]of[['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']]){
      module(file)[name].prototype.status=async()=>({installed:true,connected:true,state:'connected',login:{waiting:false}});
      module(file)[name].prototype.models=async()=>[{id:'fixture-model',name:'Fixture model',current:true}];
    }
    const Preferences=module('preferences').Preferences,get=Preferences.prototype.get;Preferences.prototype.get=async function(){return{...await get.call(this),onboardingComplete:true,designApproval:false};};
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[data.root]});
    globalThis.__roleWarnings=0;globalThis.__allowCursorRole=false;globalThis.__roleReviews=[];
    const show=dialog.showMessageBox;dialog.showMessageBox=(...args)=>{
      const title=args.at(-1)?.title;
      if(title==='Cursor UI 역할 선택 확인'){globalThis.__roleWarnings++;return Promise.resolve({response:globalThis.__allowCursorRole?1:0});}
      if(['현재 PC에서 실행','프로젝트 코드 실행 승인'].includes(title))return Promise.resolve({response:1});
      return show(...args);
    };
    const fixture=require(data.fixture);
    for(const [file,name]of[['providers','GPTProvider'],['providers','ClaudeProvider'],['cursor-provider','CursorProvider'],['gemini','GeminiProvider']]){
      const Provider=module(file)[name];Provider.prototype.ready=async()=>true;
      Provider.prototype.plan=async context=>fixture.reviewFixturePlan(context.options.team);
      Provider.prototype.build=async context=>fixture.reviewFixtureBuild(context);
      Provider.prototype.review=async context=>{
        globalThis.__roleReviews.push({actor:context.options.agentId,scope:context.reviewScope,prior:context.priorReviews?.map(row=>row.actor),cases:context.validation.cases?.length});
        await new Promise(resolve=>setTimeout(resolve,25));return {summary:'Fixture independent inspection OK',issues:[]};
      };
    }
  },{url:pathToFileURL(resolve('src/core/providers.js')).href,fixture:resolve('scripts/review-fixture.mjs'),root});
  const page=await workspaceWindow(application);page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#first-run-tour[open]').waitFor();await page.locator('#tour-skip').click();
  await page.locator('#new-project').click();await page.locator('#folder-consent[open]').waitFor();await page.locator('#folder-consent-check').check();await page.locator('#confirm-folder').click();await page.locator('#folder-consent').waitFor({state:'hidden'});
  const id=(await page.evaluate(()=>window.tower.projects())).value.activeId;
  const saved=await page.evaluate(async()=>{const current=await window.tower.preferences();return window.tower.savePreferences({...current.value,allowExecution:true,executionBackend:'host',designApproval:false});});assert.equal(saved.ok,true);
  assert.equal((await page.evaluate(id=>window.tower.projectExecution(id,true),id)).ok,true);
  await page.locator('#planner-input').fill('모델 설정 전에는 작업을 보내지 마세요');
  assert.equal(await page.locator('#start-workflow').isEnabled(),true);
  await page.locator('#start-workflow').click();
  await page.locator('.request-alert').waitFor();
  assert.match(await page.locator('#request-alerts').innerText(),/AI 역할 변경.*Cursor.*모델/s);
  await page.waitForTimeout(2000);await page.locator('#start-workflow').click();
  await page.waitForFunction(()=>document.querySelectorAll('.request-alert').length===2);
  assert.equal(await page.locator('.request-alert').count(),2);
  await page.screenshot({path:join(artifacts,'request-readiness.png')});
  assert.equal((await page.evaluate(id=>window.tower.workflow(id),id)).value,null);
  await page.waitForTimeout(3300);assert.equal(await page.locator('.request-alert').count(),1);
  await page.waitForTimeout(2000);assert.equal(await page.locator('.request-alert').count(),0);
  checks.push('Unconfigured workers leave request clickable; each click shows an actionable error, creates no workflow, and expires independently after five seconds');
  await page.locator('#start-workflow').click();
  await page.locator('#request-alerts button').filter({hasText:'AI 역할 변경'}).first().click();
  await page.locator('#roles-dialog[open]').waitFor();
  await page.waitForFunction(()=>document.querySelector('#panel-model-grok')===document.activeElement);
  await page.locator('#close-roles').click();
  checks.push('The model error shortcut opens AI roles and focuses the missing worker model instead of the controller model');
  await page.locator('#open-roles').click();await resize(page,2);await allRoles(page,2);
  assert.equal(await page.locator('[data-agent=gpt] input[value=ui]').isChecked(),true);
  assert.equal(await page.locator('[data-agent=grok] input[value=ui]').isChecked(),false);
  await page.locator('#panel-model-grok').selectOption('fixture-model');
  checks.push('Switching to two panels covers every role, selects debugging/review/testing on both, and gives missing UI to GPT instead of Cursor');
  await page.locator('[data-agent=gpt] input[value=ui]').uncheck();await page.locator('[data-agent=grok] input[value=ui]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-agent=grok] input[value=ui]').checked&&!document.querySelector('[data-cursor-pending]'));
  assert.equal(await application.evaluate(()=>globalThis.__roleWarnings),1);
  await application.evaluate(()=>globalThis.__allowCursorRole=true);await page.locator('[data-agent=grok] input[value=ui]').check();
  await page.waitForFunction(()=>!document.querySelector('[data-cursor-pending]'));assert.equal(await page.locator('[data-agent=grok] input[value=ui]').isChecked(),true);
  await page.locator('[data-agent=grok] input[value=ui]').uncheck();await page.locator('[data-agent=gpt] input[value=ui]').check();
  await application.evaluate(()=>globalThis.__allowCursorRole=false);await page.locator('#role-gpt').selectOption('grok');
  await page.waitForFunction(()=>document.querySelector('#role-gpt').value==='gpt');
  assert.equal(await page.locator('[data-agent=gpt] input[value=ui]').isChecked(),true);
  checks.push('Cursor UI selection requires an explicit native warning: cancel clears the check, approval permits it, and changing an existing UI owner to Cursor also warns and can revert');
  await page.locator('#save-roles').click();await page.locator('#roles-dialog').waitFor({state:'hidden'});
  await page.locator('#planner-input').fill('검토 흐름을 확인하는 업무 필터 모듈을 만들어줘');await page.locator('#start-workflow').click();
  const two=await completed(page,id,null);assert.deepEqual(two.reviews.map(row=>row.actor),['grok','gpt']);assert.equal(two.testing.result.cases.filter(row=>row.status==='passed').length,4);
  await page.locator('#desk-workflow-open').click();await page.locator('#workflow-dialog[open]').waitFor();assert.equal(await page.locator('#review-chain-list [data-review-status=passed]').count(),2);
  await page.screenshot({path:join(artifacts,'two-panel-review.png')});await page.locator('#close-workflow-dialog').click();
  checks.push('Two-panel work executes four real Node assertions, passes Cursor results to the control tower, and shows both OK steps in Workflow');
  await page.locator('#open-roles').click();await resize(page,4);await allRoles(page,4);
  await provider(page,'claude','claude');await provider(page,'reviewer','gemini');
  await page.locator('[data-agent=gpt] input[value=ui]').uncheck();await page.locator('[data-agent=claude] input[value=ui]').check();
  assert.match(await page.locator('#role-review-order').innerText(),/Cursor.*Gemini.*Claude.*GPT/);
  await page.locator('#save-roles').click();await page.locator('#roles-dialog').waitFor({state:'hidden'});
  await page.locator('#planner-input').fill('네 개 AI로 같은 기능을 다시 검증해줘');await page.locator('#start-workflow').click();
  const four=await completed(page,id,two.id);assert.deepEqual(four.reviews.map(row=>row.actor),['grok','reviewer','claude','gpt']);
  const records=await application.evaluate(()=>globalThis.__roleReviews);assert.deepEqual(records.at(-1).prior,['grok','reviewer','claude']);assert.equal(records.at(-1).cases,4);
  await page.locator('#desk-workflow-open').click();await page.locator('#workflow-dialog[open]').waitFor();assert.equal(await page.locator('#review-chain-list [data-review-status=passed]').count(),4);
  await page.screenshot({path:join(artifacts,'four-panel-review.png')});await page.locator('#close-workflow-dialog').click();
  checks.push('Four providers run Grok→Gemini→Claude→GPT serially; every next reviewer receives all four actual test cases and prior verdicts for the same source revision');
  await page.locator('#open-roles').click();await provider(page,'gpt','claude');await provider(page,'claude','gpt');
  await page.locator('#save-roles').click();await page.locator('#roles-dialog').waitFor({state:'hidden'});
  await page.locator('#planner-input').fill('Claude 컨트롤 타워의 마지막 검토 순서를 확인해줘');await page.locator('#start-workflow').click();
  const claude=await completed(page,id,four.id);assert.deepEqual(claude.reviewChain.map(step=>step.provider),['grok','gemini','gpt','claude']);assert.equal(claude.reviewChain.at(-1).actor,'gpt');
  checks.push('Choosing Claude as control tower places worker GPT before the final Claude inspection without confusing fixed panel IDs with provider names');
  assert.deepEqual(errors,[]);await writeFile(join(artifacts,'role-review-ui-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0,providerInference:'explicit fixtures; actual coordinator, files and Node tests'},null,2));console.log(JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
}finally{
  await application?.close().catch(()=>{});
  for(const candidate of [root,profile]){const actual=await realpath(candidate).catch(()=>null);if(actual===candidate&&actual.startsWith(join(artifacts,'role-review-')))await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
