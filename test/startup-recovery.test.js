import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { RoleAssignments } from '../src/core/roles.js';
import { defaultTeam, resizeTeam } from '../src/core/team.js';
import { disconnectedTeam, replaceTeamProvider } from '../src/core/startup-recovery.js';

test('startup checks only assigned providers once, even with duplicate panels, and distinguishes unverified status', () => {
  const team=resizeTeam(defaultTeam(),4);team[3].provider='gpt';
  assert.deepEqual(disconnectedTeam(team,{gpt:{connected:true},grok:{connected:false,state:'disconnected'},claude:{connected:true},gemini:{connected:false}}),[{actor:'grok',provider:'grok',state:'disconnected',installed:true,actors:['grok']}]);
  const singleProvider=team.map(row=>({...row,provider:'gpt'}));
  const lost=disconnectedTeam(singleProvider,{gpt:{connected:false,state:'verification-failed'}});assert.equal(lost.length,1);assert.equal(lost[0].actors.length,4);assert.equal(lost[0].state,'verification-failed');
});

test('retiring an AI preserves every panel and role, resets incompatible models and removes every route back to it', () => {
  const team=defaultTeam();team[0].fallback={provider:'grok',modelId:'old-model'};team[1].modelId='old-model';team[1].fallback={provider:'gemini',modelId:'new-model'};
  const replaced=replaceTeamProvider(team,'grok','gemini','new-model');
  assert.deepEqual(replaced.map(row=>[row.id,row.roles]),team.map(row=>[row.id,row.roles]));assert.equal(replaced[1].provider,'gemini');assert.equal(replaced[1].modelId,'new-model');assert.ok(replaced.every(row=>!row.fallback));assert.equal(team[1].provider,'grok');
  assert.equal(replaceTeamProvider(team,'grok','gpt')[1].modelId,undefined);
  assert.throws(()=>replaceTeamProvider(team,'grok','grok'));assert.throws(()=>replaceTeamProvider(team,'unused','gpt'));assert.throws(()=>replaceTeamProvider(team,'grok','unknown'));
});

test('the last confirmed AI setup survives restart and seeds new projects without copying folder grants or execution approvals', async t => {
  const root=await mkdtemp(join(tmpdir(),'tower-team-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new Store(root,{});await store.init();
  const projects=new Projects(store),first=(await projects.list()).activeId,roles=new RoleAssignments(projects);
  await projects.grant(first,{root:'/private/first',approved:true});
  const selected=replaceTeamProvider(defaultTeam(),'grok','gemini','fixture-model');await roles.setTeam(first,selected);
  const reopened=new Projects(new Store(root,{})),restored=new RoleAssignments(reopened);assert.deepEqual(await restored.getTeam(first),selected);
  const created=await reopened.create('second'),second=created.items.find(row=>row.id===created.activeId);
  assert.deepEqual(await restored.getTeam(second.id),selected);assert.equal(second.workspace,undefined);assert.equal(second.allowExecution,undefined);
  const modified=replaceTeamProvider(selected,'gemini','gpt');await restored.setTeam(second.id,modified);
  assert.deepEqual(await restored.getTeam(first),selected);const third=await reopened.create('third');assert.deepEqual(await restored.getTeam(third.activeId),modified);
  assert.equal((await store.read('projects')).lastTeam.some(row=>row.provider==='grok'||row.fallback?.provider==='grok'),false);
  await reopened.mutate(data=>{data.lastTeam=[{provider:'invalid'}];});
  await assert.rejects(reopened.create('invalid inherited team'),/저장된 AI 구성을 읽지 못했습니다/);
});

test('2- and 4-panel teams, duplicate accounts and fallback settings remain intact across replacements', () => {
  for(const count of [2,4]){
    const team=resizeTeam(defaultTeam(),count);team[0].fallback={provider:'claude',modelId:'sonnet'};
    const changed=replaceTeamProvider(team,'grok','gpt');assert.equal(changed.length,count);assert.deepEqual(changed[0].fallback,team[0].fallback);
    assert.equal(changed.filter(row=>row.roles.includes('feature')).length,1);assert.equal(changed.filter(row=>row.roles.includes('ui')).length,1);
  }
});
