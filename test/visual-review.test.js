import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVisualReview,VISUAL_CATEGORIES} from '../src/core/visual-review.js';
import {previewFile,VisualCapture} from '../src/core/visual-capture.js';
import {Workflow} from '../src/core/workflow.js';
import {GPTProvider,ClaudeProvider} from '../src/core/providers.js';
import {GeminiProvider,GeminiConnection} from '../src/core/gemini.js';
import {CursorProvider} from '../src/core/cursor-provider.js';
import {CursorConnection} from '../src/core/cursor.js';
import {claudeResultEnvelope} from '../src/core/claude-options.js';
const tasks=[{id:'ui',owner:'claude',kind:'ui',writePaths:['index.html','styles.css']}];
const verdict=(type='match')=>({verdict:type,summary:'실제 비교 결과',observations:VISUAL_CATEGORIES.map(category=>({category,status:type==='match'?'match':type==='mismatch'&&category==='size'?'different':type==='unverifiable'?'unverifiable':'match',expected:'시안 기준',actual:'현재 캡처',evidence:'해당 위치의 비교 근거'})),issues:type==='mismatch'?[{taskId:'ui',owner:'claude',file:'styles.css',description:'버튼 폭을 시안의 120px에 맞추세요.'}]:[]});

test('Claude image protocol accepts only one final stream result, retaining usage and rejecting partial events',()=>{
 const result={type:'result',result:JSON.stringify(verdict()),usage:{input_tokens:50,output_tokens:20}};
 const stream=[{type:'system',subtype:'init'},{type:'assistant',message:{content:[]}},result].map(JSON.stringify).join('\n');
 assert.deepEqual(claudeResultEnvelope(stream,true),result);assert.deepEqual(claudeResultEnvelope(JSON.stringify(result)),result);
 for(const output of ['{"type":"assistant"}',JSON.stringify(result)+'\n'+JSON.stringify(result),'not JSON'])assert.throws(()=>claudeResultEnvelope(output,true),/최종 JSON/);
});

for(const vendor of ['cursor','gemini'])test(`${vendor} refuses an image-unsupported ACP connection before any text-only prompt`,async()=>{
 const methods=[],model=vendor==='cursor'?'grok-test[effort=high]':'fixture-model';let closed=false;
 const rpcFactory=()=>({request:async method=>{methods.push(method);if(method==='initialize')return{authMethods:[{id:vendor==='cursor'?'cursor_login':'oauth-personal'}]};if(method==='session/new')return{sessionId:'fixture',modes:{availableModes:[{id:'ask'}]},models:{availableModels:[{modelId:model}]}};return{};},close:()=>{closed=true;}});
 const deps={find:async()=>({executable:'fixture',prefix:[]}),rpcFactory};
 const connection=vendor==='cursor'?new CursorConnection(()=>{},deps):new GeminiConnection('/fixture',()=>{},deps);
 await assert.rejects(()=>connection.ask('compare',{snapshot:{root:'/fixture'},signal:new AbortController().signal,designImage:'PNG-fixture'},model),/이미지 입력을 지원하지/);
 assert.equal(methods.includes('session/prompt'),false);assert.equal(closed,true);
});
test('visual verdict requires every visual category and cannot hide differences behind a match',()=>{
 assert.equal(validateVisualReview(verdict(),tasks,'design/ref.png').verdict,'match');
 assert.equal(validateVisualReview(verdict('mismatch'),tasks,'design/ref.png').issues[0].owner,'claude');
 for(const change of [v=>v.observations.pop(),v=>v.observations[1]=v.observations[0],v=>v.observations[0].status='different',v=>v.observations[0].evidence='']){const v=verdict();change(v);assert.throws(()=>validateVisualReview(v,tasks,'design/ref.png'));}
 assert.equal(validateVisualReview(verdict('unverifiable'),tasks,'design/ref.png').verdict,'unverifiable');
});
test('visual corrections cannot alter tests, other roles, paths outside the UI scope or the reference',()=>{
 for(const patch of [{owner:'gpt'},{taskId:'logic'},{file:'tests/a.test.js'},{file:'core.cjs'},{file:'../styles.css'},{file:'design/ref.png'}]){const v=verdict('mismatch');Object.assign(v.issues[0],patch);assert.throws(()=>validateVisualReview(v,tasks,'design/ref.png'));}
});
test('preview routes exclude traversal, private stores, executable sources and build output',()=>{
 assert.equal(previewFile('/styles.css?q=1'),'styles.css');assert.equal(previewFile('/'),'index.html');
 for(const path of ['/..%2f.env','/.env','/.git/config','/.runtime/data.json','/node_modules/p.js','/dist/index.html','/image.exe','/C:%5ctoken.json'])assert.throws(()=>previewFile(path));
});
test('browser preview permission is isolated by OS identity and folder grant and never inherited from Docker consent',async()=>{
 let binding='userA',grant={grantId:'a',executionApproved:true},data={};const workspace={grant:async()=>grant},store={read:async()=>structuredClone(data),write:async(_n,v)=>data=structuredClone(v)};
 const preview=new VisualCapture(workspace,store,{},async()=>binding);
 assert.equal((await preview.permission('p','a',{executionBackend:'docker',allowExecution:true})).allowed,false);
 assert.equal((await preview.permission('p','a',{executionBackend:'host',allowExecution:true})).allowed,true);
 await preview.authorize('p','a',true);assert.equal((await preview.permission('p','a',{})).allowed,true);
 binding='userB';assert.equal((await preview.permission('p','a',{})).allowed,false);binding='userA';grant={...grant,grantId:'b'};assert.equal((await preview.permission('p','b',{})).allowed,false);
 grant={...grant,grantId:'a'};await preview.authorize('p','a',false);assert.equal((await preview.permission('p','a',{})).allowed,false);
});
for(const [name,Provider,args]of [['GPT',GPTProvider,[null]],['Claude',ClaudeProvider,[{}]],['Gemini',GeminiProvider,[{}]],['Cursor',CursorProvider,[{directory:'.'}]]])test(`${name} visual review sends the comparison image and the dedicated evidence contract`,async()=>{
 const provider=new Provider(...args);let instruction,payload;provider.ask=async(i,p)=>{instruction=i;payload=p;return verdict();};
 await provider.review({designImage:'real-comparison',visualComparison:{viewport:{width:640,height:480}},snapshot:{files:[]},task:tasks[0],tasks,options:{}});
 assert.match(instruction,/LEFT.*RIGHT/);assert.match(instruction,/unverifiable/);assert.equal(payload.designImage,'real-comparison');assert.equal(payload.visualComparison.viewport.width,640);
});
test('a missing capture tool blocks image acceptance and text-only designs are not falsely counted as visual passes',async()=>{
 const engine=new Workflow({},{}),run={state:{id:'r',projectId:'p',grantId:'g',round:0,options:{},design:{status:'approved',hash:'h',path:'design/ref.png'},tasks},controller:new AbortController()};engine.record=async()=>{};
 const result=await engine.reviewVisual(run,{hash:'s'});assert.equal(result.status,'blocked');
 run.state.design.hash=null;assert.equal((await engine.reviewVisual(run,{hash:'s'})).status,'not_applicable');
});
