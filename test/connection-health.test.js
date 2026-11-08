import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionHealth} from '../src/core/connection-health.js';
import {CodexConnection} from '../src/core/codex.js';
import {parseCursorStatus} from '../src/core/cursor.js';
import {isAuthenticationFailure,providerFailure} from '../src/core/provider-errors.js';
import {mergeConnectionStatus} from '../src/renderer/connection-state.js';
import {roleProviders} from '../src/core/roles.js';
import {defaultTeam} from '../src/core/team.js';
test('health probes replace cached login, fail closed when stale/unavailable, and preserve current browser login progress',async()=>{
 let now=0,connected=true,calls=0;const events=[],health=new ConnectionHealth({grok:async()=>{calls++;return{connected,state:connected?'connected':'disconnected'};}},e=>events.push(e),()=>now);
 health.seed('grok',{connected:true});now=16000;assert.equal(health.view('grok').connected,false);connected=false;await health.check('grok');assert.equal(health.view('grok').connected,false);connected=true;await health.check('grok');assert.equal(health.view('grok').connected,true);assert.equal(health.view('grok',{login:{waiting:true}}).login.waiting,true);
 health.probes.grok=async()=>{throw Error('timeout');};await health.check('grok');assert.equal(health.view('grok').connected,false);assert.equal(calls,2);assert.ok(events.every(e=>e.type==='connection-health'));
});
test('authentication rejection defeats an older in-flight success and remains blocked until explicit login verification',async()=>{
 let resolve,count=0;const health=new ConnectionHealth({grok:()=>{count++;return new Promise(r=>resolve=r);}});const first=health.check('grok'),second=health.check('grok');assert.equal(first,second);assert.equal(count,1);health.invalidate('grok');resolve({connected:true});await first;assert.equal(health.view('grok').connected,false);
 health.probes.grok=async()=>({connected:true});await health.check('grok');assert.equal(health.view('grok').connected,false);health.release('grok');await health.check('grok');assert.equal(health.view('grok').connected,true);
});
test('Codex checks external logout through a fresh metadata server without closing the live work server',async()=>{
 let freshClosed=false;const live={closed:false,close(){this.closed=true;}},connection=new CodexConnection('/fixture',()=>{},{find:async()=>'/fixture/codex',rpcFactory:()=>({request:async method=>method==='account/read'?{account:null}:{},notify(){},close(){freshClosed=true;}})});connection.rpc=live;connection.cache={at:Date.now(),value:{connected:true}};
 assert.equal((await connection.freshStatus()).connected,false);assert.equal(live.closed,false);assert.equal(freshClosed,true);assert.equal((await connection.status()).connected,false);
});
test('explicit Cursor logout wins conflicting fields; auth failures are distinct from quota and generic permission errors',()=>{
 assert.equal(parseCursorStatus({isAuthenticated:true,loggedIn:false}).connected,false);assert.equal(isAuthenticationFailure({status:401}),true);assert.equal(isAuthenticationFailure({code:'invalid_api_key'}),true);assert.equal(isAuthenticationFailure(new Error('HTTP 403 forbidden resource')),false);assert.equal(isAuthenticationFailure({code:'usage_limit_reached'}),false);assert.equal(providerFailure('grok',{code:'unauthorized'},'Login needed').authenticationRequired,true);
 assert.equal(isAuthenticationFailure({error:{type:'authentication_error'}}),true);assert.equal(isAuthenticationFailure({is_error:true,result:'Not logged in · Please run /login'}),true);assert.equal(isAuthenticationFailure({is_error:false,result:'Example: authentication required'}),false);
});
test('late status responses cannot resurrect a disconnected card or stale control tower login',()=>{
 const current={codex:{connected:false,authRevision:4},gpt:{source:'codex',connected:false},grok:{connected:false,authRevision:8}},stale={codex:{connected:true,authRevision:3},gpt:{source:'codex',connected:true},grok:{connected:true,authRevision:7}};
 const merged=mergeConnectionStatus(current,stale);assert.equal(merged.gpt.connected,false);assert.equal(merged.grok.connected,false);assert.equal(mergeConnectionStatus(merged,{...stale,grok:{connected:true,authRevision:9}}).grok.connected,true);
});
test('fresh installation/model metadata remains usable while old authentication is still disconnected',()=>{
 const health=new ConnectionHealth({});health.seed('grok',{installed:false,connected:false,modelId:null});const value=health.view('grok',{installed:true,connected:true,modelId:'new-model'});assert.equal(value.installed,true);assert.equal(value.modelId,'new-model');assert.equal(value.connected,false);
});
test('a provider authentication error immediately invalidates its actual route and does not trigger quota fallback',async()=>{
 const revoked=[],routes=roleProviders({grok:{chat:async()=>{throw providerFailure('grok',{code:'unauthorized'},'login required');}}},{onAuthenticationFailure:id=>revoked.push(id)});
 await assert.rejects(routes.grok.chat({message:'Hi',options:{team:defaultTeam()},signal:new AbortController().signal}),/login required/);assert.deepEqual(revoked,['grok']);
});
