import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { defaultTeam } from '../src/core/team.js';
import { workspaceWindow } from './electron-workspace.mjs';

const artifacts=resolve('artifacts'),profile=join(artifacts,'startup-connections-'+randomUUID()),id='fixture-project',checks=[];
await mkdir(profile,{recursive:true});const team=defaultTeam();team[0].fallback={provider:'grok',modelId:'old-model'};team[1].modelId='old-model';
await writeFile(join(profile,'projects.json'),JSON.stringify({activeId:id,items:[{id,title:'연결 복원 검증',team}]}));
await writeFile(join(profile,'session-state.json'),JSON.stringify({deviceId:'fixture-device',lastActiveAt:Date.now(),lastVerifiedAt:Date.now(),verificationPending:false}));
const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;let application;
async function boot(){
 application=await electron.launch({args:['.'],cwd:resolve('.'),env});
 await application.evaluate(({Notification},data)=>{
  const require=process.getBuiltinModule('module').createRequire(data.module),module=name=>require(data.module.replace('codex.js',name+'.js'));
  Notification.prototype.show=()=>{};globalThis.__loginRequests=[];globalThis.__signedIn={gpt:true,grok:false,claude:true,gemini:true};
  module('prerequisites').Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
  const P=module('preferences').Preferences,get=P.prototype.get;P.prototype.get=async function(){return{...await get.call(this),onboardingComplete:true};};
  for(const [file,name,id]of[['codex','CodexConnection','gpt'],['cursor','CursorConnection','grok'],['claude','ClaudeConnection','claude'],['gemini','GeminiConnection','gemini']]){
   const C=module(file)[name];C.prototype.status=async()=>({installed:true,connected:globalThis.__signedIn[id],state:globalThis.__signedIn[id]?'connected':'disconnected',login:{waiting:false}});
   C.prototype.models=async()=>[{id:'fixture-model',name:'Fixture model',isDefault:true}];
   C.prototype.connect=async function(){globalThis.__loginRequests.push(id);globalThis.__signedIn[id]=true;(this.notify??this.login.notify)({type:id==='gpt'?'codex':id,state:'connected'});return{connected:true};};
  }
 },{module:resolve('src/core/codex.js')});
 const page=await workspaceWindow(application);page.setDefaultTimeout(25000);
 await page.waitForFunction(()=>document.querySelector('#first-run-tour')?.open||['checking','idle'].includes(document.querySelector('#startup-recovery-dialog')?.dataset.state));
 if(await page.locator('#first-run-tour').evaluate(el=>el.open))await page.locator('#tour-skip').click();
 return page;
}
async function shutdown(){await application.close();application=null;}
try{
 let page=await boot();await page.locator('#startup-recovery-dialog[open]').waitFor();assert.match(await page.locator('#startup-recovery-title').textContent(),/Grok.*로그인/);assert.deepEqual(await application.evaluate(()=>globalThis.__loginRequests),[]);
 await page.screenshot({path:join(artifacts,'startup-reconnect.png')});checks.push('Returning startup prompts for the assigned disconnected Cursor account without automatically launching authentication');
 await page.locator('#startup-recovery-close').click();await page.waitForFunction(()=>document.querySelector('#startup-recovery-dialog').dataset.state==='idle');assert.deepEqual((await page.evaluate(id=>window.tower.team(id),id)).value,team);assert.deepEqual(await application.evaluate(()=>globalThis.__loginRequests),[]);await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.desk-connected').length===2);await page.waitForTimeout(500);assert.equal(await page.locator('#startup-recovery-dialog').evaluate(el=>el.open),false);checks.push('Close/later preserves the exact saved team and does not repeat the prompt, including after a renderer reload');await shutdown();
 page=await boot();await page.locator('#startup-recovery-dialog[open]').waitFor();await page.locator('#startup-recovery-yes').click();await page.locator('#prerequisites-dialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('.desk-agent-card[data-actor=grok] .desk-connected'));assert.deepEqual(await application.evaluate(()=>globalThis.__loginRequests),['grok']);await page.locator('#close-prerequisites').click();await page.waitForFunction(()=>document.querySelector('#startup-recovery-dialog').dataset.state==='idle');checks.push('Yes invokes only the selected official login route and restores verified connection without changing panel roles');await shutdown();
 page=await boot();await page.locator('#startup-recovery-dialog[open]').waitFor();await page.locator('#startup-recovery-no').click();await page.locator('#startup-replacement-back').click();await page.locator('#startup-recovery-no').click();await page.locator('#startup-replacement-provider').selectOption('gemini');assert.equal(await page.locator('#startup-replacement-model').inputValue(),'fixture-model');assert.deepEqual(await application.evaluate(()=>globalThis.__loginRequests),[]);checks.push('No opens an AI/model picker with automatic model preparation, a working Back action and no involuntary login');
 await page.screenshot({path:join(artifacts,'startup-replacement.png')});await page.locator('#startup-replacement-save').click();await page.waitForFunction(()=>document.querySelector('#startup-recovery-dialog').dataset.state==='idle');const changed=(await page.evaluate(id=>window.tower.team(id),id)).value;assert.equal(changed[1].provider,'gemini');assert.equal(changed[1].modelId,'fixture-model');assert.deepEqual(changed.map(row=>row.roles),team.map(row=>row.roles));assert.equal(changed[0].fallback,undefined);checks.push('Replacing Cursor saves Gemini and its model, preserves roles and removes fallback routes back to the retired AI');await shutdown();
 page=await boot();await page.waitForFunction(()=>document.querySelector('#startup-recovery-dialog').dataset.state==='idle');assert.equal(await page.locator('#startup-recovery-dialog').evaluate(el=>el.open),false);assert.match(await page.locator('.desk-agent-card[data-actor=grok]').textContent(),/Gemini/);assert.deepEqual((await page.evaluate(id=>window.tower.team(id),id)).value,changed);assert.deepEqual(await application.evaluate(()=>globalThis.__loginRequests),[]);const persisted=JSON.parse(await readFile(join(profile,'projects.json'),'utf8'));assert.deepEqual(persisted.lastTeam,changed);checks.push('A fresh app process restores the replacement/model and never asks to log in to the no-longer-assigned Cursor account');
 await writeFile(join(artifacts,'startup-connections-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0,scope:'Four real Electron startups using one isolated persistent profile and official-auth metadata/login fixtures; no real account logout'},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{await application?.close().catch(()=>{});const actual=await realpath(profile).catch(()=>null);if(actual===profile&&(actual.startsWith(artifacts+'\\')||actual.startsWith(artifacts+'/')))await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
