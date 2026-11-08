import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {workspaceWindow} from './electron-workspace.mjs';
const artifacts=resolve('artifacts'),profile=join(artifacts,'prerequisites-profile-'+Date.now());await mkdir(profile,{recursive:true});
const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const checks=[];let application;
try{
 application=await electron.launch({args:['.'],cwd:resolve('.'),env});
 await application.evaluate(({dialog},data)=>{
  const path=process.getBuiltinModule('url').fileURLToPath(data.url),require=process.getBuiltinModule('module').createRequire(path);
  globalThis.__toolsReady=false;globalThis.__sites=[];globalThis.__hostApproved=false;globalThis.__workCalls=0;
  require(path.replace('prerequisites.js','agent-chat.js')).AgentChat.prototype.send=async()=>{globalThis.__workCalls++;return{message:{content:'fixture reply'}};};
  const Prerequisites=require(path).Prerequisites, scan=Prerequisites.prototype.scan;
  Prerequisites.prototype.scan=async function(_status,options={}){
   const ready=globalThis.__toolsReady;
   const fixture=new Prerequisites({node:async()=>data.nodePath,find:async name=>ready&&name!=='git'?'/fixture/'+name:null,
    probe:async(executable,args)=>({code:0,output:args[0]==='--version'?(executable.endsWith('git')?'git version 2.48.0':ready?'v24.0.0':'v22.0.0'):'28.0.0'})});
   return this.current=await scan.call(fixture,{gpt:{installed:ready}},{providers:globalThis.__honorTeam?options.providers:['gpt'],executionBackend:'docker'});
  };
  const Browser=require(path.replace('prerequisites.js','browser.js')).BrowserOpener,open=Browser.prototype.open;
  Browser.prototype.open=async function(url){this.openDefault=async safe=>{globalThis.__sites.push(safe);return true;};return open.call(this,url);};
  for(const [file,name]of[['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']])require(path.replace('prerequisites.js',file+'.js'))[name].prototype.status=async()=>({installed:false,connected:false,login:{waiting:false}});
  const show=dialog.showMessageBox;dialog.showMessageBox=(...args)=>args.at(-1)?.title==='현재 PC에서 실행'?Promise.resolve({response:globalThis.__hostApproved?1:0}):show(...args);
 },{url:pathToFileURL(resolve('src/core/prerequisites.js')).href,nodePath:process.execPath});
 const page=await workspaceWindow(application);page.setDefaultTimeout(30000);
 await page.locator('#prerequisites-dialog[open]').waitFor();
 await page.waitForFunction(()=>window.tower.startupState().then(r=>r.value.mainVisible));
 assert.equal(await page.locator('#first-run-tour').evaluate(el=>el.open),false);
 assert.match(await page.locator('[data-tool=node]').innerText(),/24 이상으로 업데이트/);
 assert.match(await page.locator('[data-tool=gemini]').innerText(),/선택/);
  assert.equal(await page.locator('[data-tool=node] .prerequisite-badge').innerText(),'필수');
  assert.equal(await page.locator('[data-tool=gemini] .prerequisite-badge').innerText(),'선택');
  assert.equal(await page.locator('[data-tool=node] .prerequisite-badge').getAttribute('data-required'),'true');
  assert.equal(await page.locator('[data-tool=gemini] .prerequisite-badge').getAttribute('data-required'),'false');
  assert.ok(await page.locator('[data-tool=node] .prerequisite-purpose').innerText());
 assert.equal(await page.locator('[data-tool=git] .prerequisite-badge').innerText(),'선택');
 assert.equal(await page.locator('[data-tool=docker] .prerequisite-badge').innerText(),'필수');
 assert.match(await page.locator('[data-tool=docker] .prerequisite-purpose').innerText(),/현재 Docker.*필수/);
 assert.match(await page.locator('[data-tool=git] .prerequisite-purpose').innerText(),/GitHub.*백업/);
 await page.screenshot({path:join(artifacts,'prerequisites-ui.png')});
 checks.push('Fresh startup finishes the splash and opens a missing/outdated tools dialog before the first-run tour; unused Gemini remains optional');
 const projectId=(await page.evaluate(()=>window.tower.projects())).value.activeId;
 for(const endpoint of ['sendMessage','startWorkflow','rerunTests','retryVisual','generateImage','reviseLayout','answerQuestions']){
  const result=await page.evaluate(({endpoint,id})=>window.tower[endpoint](id,...(endpoint==='startWorkflow'?[{request:'Build fixture app'}]:['fixture','gpt','Build fixture app','work'])),{endpoint,id:projectId});
  assert.equal(result.ok,false);assert.equal(result.code,'PREREQUISITES_REQUIRED',endpoint);assert.ok(result.prerequisites.rows.some(row=>row.required&&row.state!=='ready'));
 }
 assert.equal(await application.evaluate(()=>globalThis.__workCalls),0);
 checks.push('All public AI work/resume/test/design endpoints reject missing required tools before dispatch, file generation or billable calls');
 await page.locator('#continue-prerequisites').click();await page.locator('#first-run-tour[open]').waitFor();await page.locator('#tour-skip').click();
 if(await page.locator('#settings-dialog').evaluate(el=>el.open))await page.locator('#close-settings').click();
 await page.locator('#planner-input').fill('작업 요청은 설치 후에만 보내 주세요');await page.locator('#start-workflow').click();await page.locator('#prerequisites-dialog[open]').waitFor();
 assert.match(await page.locator('#toast').innerText(),/설치를 진행해주세요/);assert.match(await page.locator('#prerequisites-required').innerText(),/닫아도.*차단/);assert.equal(await page.locator('#planner-input').inputValue(),'작업 요청은 설치 후에만 보내 주세요');
 assert.equal(await application.evaluate(()=>globalThis.__workCalls),0);await page.screenshot({path:join(artifacts,'prerequisites-blocked.png')});
 const notices=(await page.evaluate(()=>window.tower.notifications())).value;assert.ok(notices.some(row=>row.action==='prerequisites'));
 checks.push('Closing setup does not bypass the gate: request reopens the install popup and right-side actionable notification, retaining the unsent prompt');
 await page.locator('[data-tool=node] button').click();
 assert.match(await page.locator('[data-tool=node] .prerequisite-state').innerText(),/대기|확인 중/);
 assert.deepEqual(await application.evaluate(()=>globalThis.__sites),['https://nodejs.org/en/download']);
 const invalid=await page.evaluate(()=>window.tower.openInstallSite('https://untrusted.example/install'));assert.equal(invalid.ok,false);
 checks.push('An install click opens only the fixed official URL; arbitrary installer URLs are rejected and no download script runs');
 await application.evaluate(()=>globalThis.__toolsReady=true);
 await page.locator('#continue-prerequisites').filter({hasText:'준비 완료'}).waitFor();
 await page.locator('#recheck-prerequisites').click();
 assert.match(await page.locator('[data-tool=node]').innerText(),/24.0.0/);
 assert.match(await page.locator('#prerequisites-required').innerText(),/준비 완료/);
 const allowed=await page.evaluate(id=>window.tower.sendMessage(id,'fixture','gpt','Build after install','work'),projectId);assert.equal(allowed.ok,true);assert.equal(await application.evaluate(()=>globalThis.__workCalls),1);
 assert.match(await page.locator('[data-tool=gemini]').innerText(),/설치 필요/);assert.match(await page.locator('[data-tool=git]').innerText(),/설치 필요/);
 checks.push('Fresh readiness immediately unlocks the guarded dispatch while optional Gemini and Git remain uninstalled; no AI inference is called');
 const twoGPT=[{id:'gpt',provider:'gpt',roles:['control','debug','review','test']},{id:'grok',provider:'gpt',roles:['feature','ui','debug','review','test']}];
 const assigned=await page.evaluate(({id,team})=>window.tower.setTeam(id,team),{id:projectId,team:twoGPT});assert.equal(assigned.ok,true,assigned.error);
 const second=(await page.evaluate(()=>window.tower.createProject('Required tool scope fixture'))).value.activeId;
 await application.evaluate(()=>globalThis.__honorTeam=true);
 const scope=await page.evaluate(async({first,second})=>({first:await window.tower.checkWorkTools(first),second:await window.tower.checkWorkTools(second)}),{first:projectId,second});
 assert.equal(scope.first.ok,true);assert.equal(scope.second.code,'PREREQUISITES_REQUIRED');assert.equal(scope.second.prerequisites.projectId,second);
 assert.ok(scope.second.prerequisites.rows.some(row=>row.id==='claude'&&row.required&&row.state==='missing'));
 await application.evaluate(()=>globalThis.__honorTeam=false);await page.evaluate(id=>window.tower.selectProject(id),projectId);
 checks.push('The gate uses the requested project team: a two-GPT project passes while a different active project requiring missing Claude is blocked');
 await page.locator('#continue-prerequisites').click();await page.locator('#open-settings').click();
 await page.locator('#settings-dialog[open]').waitFor();
 assert.equal(await page.locator('#execution-backend').inputValue(),'docker');assert.equal(await page.locator('#design-mode').inputValue(),'layout');assert.equal(await page.locator('#mutation-by-default').isChecked(),false);
 checks.push('Passive polling marks newly runnable tools ready without a manual refresh; manual recheck still works and onboarding keeps Docker, text preview and opt-in mutation defaults');
 await page.locator('#execution-backend').selectOption('host');await page.locator('#allow-execution').check();await page.locator('#save-settings').click();
 const denied=(await page.evaluate(()=>window.tower.preferences())).value;assert.equal(denied.executionBackend,'docker');assert.equal(denied.allowExecution,false);
 await application.evaluate(()=>globalThis.__hostApproved=true);await page.locator('#save-settings').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
 const approved=(await page.evaluate(()=>window.tower.preferences())).value;assert.equal(approved.executionBackend,'host');assert.equal(approved.allowExecution,true);
 checks.push('Host execution requires a separate native consent: cancel preserves Docker, explicit approval persists the chosen host setting');
 const shortcut=page.locator('#open-prerequisites-header');
 assert.equal(await shortcut.innerText(),'필수 프로그램 설치');
 for(const width of [1440,1280,900,390]) {
  await page.setViewportSize({width,height:960});
  const box=await shortcut.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=960);
 }
 await page.setViewportSize({width:1440,height:960});
 await shortcut.click();await page.locator('#prerequisites-dialog[open]').waitFor();
 assert.match(await page.locator('[data-tool=node]').innerText(),/준비됨/);
 assert.equal(await page.locator('#settings-dialog').evaluate(el=>el.open),false);
 await page.locator('#close-prerequisites').click();await page.locator('#prerequisites-dialog').waitFor({state:'hidden'});
 await shortcut.click();await page.locator('#prerequisites-dialog[open]').waitFor();
 await page.screenshot({path:join(artifacts,'prerequisites-shortcut.png')});
 await page.locator('#close-prerequisites').click();
 checks.push('The top-right prerequisite install shortcut remains visible from 390 to 1440px and reopens the same installation dialog after closing without opening settings');
 await writeFile(join(artifacts,'prerequisites-ui-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));console.log(JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
}finally{
 await application?.close().catch(()=>{});
 const actual=await realpath(profile).catch(()=>null);if(actual===profile&&actual.startsWith(join(artifacts,'prerequisites-profile-')))await rm(actual,{recursive:true,force:true,maxRetries:5});
}
