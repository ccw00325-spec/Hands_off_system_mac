import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { desktopCodexCandidates, createDesktopCodexFinder, isCodexAppAlias } from '../src/core/desktop-codex.js';
import { CodexConnection } from '../src/core/codex.js';
import { ClaudeConnection } from '../src/core/claude.js';

const registered = { PackageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', SignatureKind: 3, InstallLocation: 'C:\\Program Files\\WindowsApps\\Codex_version' };
const fakeFiles = { fileStat: async () => ({ isFile: () => true }), canonical: async path => path };

test('desktop discovery selects exact official engines, never GUI launchers or unrelated/unsigned Windows packages', () => {
  const candidates = desktopCodexCandidates({ platform: 'win32', packages: [registered, {...registered, PackageFamilyName: 'Other_app'}, {...registered, SignatureKind: 1}, {...registered, InstallLocation: 'relative'}, {...registered, InstallLocation: '\\\\server\\share'}] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].binary, 'C:\\Program Files\\WindowsApps\\Codex_version\\app\\resources\\codex.exe');
  assert.deepEqual(desktopCodexCandidates({ platform: 'darwin', home: '/Users/alice' }).map(c => c.binary), ['/Applications/Codex.app/Contents/Resources/codex', '/Users/alice/Applications/Codex.app/Contents/Resources/codex']);
  assert.deepEqual(desktopCodexCandidates({ platform: 'linux' }), []);
  const options={platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\alice\\AppData\\Local'}};
  assert.equal(isCodexAppAlias('C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe',options),true);
  assert.equal(isCodexAppAlias('C:\\Users\\alice\\.local\\bin\\codex.exe',options),false);
});

test('desktop-only installation works without PATH, coalesces discovery, and rediscovers after application updates', async () => {
  let calls = 0, missing = false;
  const finder = createDesktopCodexFinder({platform:'win32', env:{PATH:''}, packages:async()=>{calls++;return [{...registered, InstallLocation:registered.InstallLocation+(missing?'_new':'')}];}, ...fakeFiles, fileStat:async path=>{if(missing&&!path.includes('_new'))throw Error('old version removed');return{isFile:()=>true};}});
  const results = await Promise.all([finder(), finder(), finder()]);assert.equal(new Set(results).size,1);assert.equal(calls,1);
  assert.equal(await finder(),results[0]);assert.equal(calls,1);
  missing=true;assert.match(await finder(),/_new/);assert.equal(calls,2);
});

test('missing installs and probe failures are retryable; escaped symlinks/directories are never engines', async () => {
  let time=0,calls=0;const finder=createDesktopCodexFinder({platform:'win32',now:()=>time,packages:async()=>{calls++;return calls===1?[]:[registered];},...fakeFiles});
  assert.equal(await finder(),null);assert.equal(await finder(),null);assert.equal(calls,1);time=15001;assert.ok(await finder());
  assert.equal(await createDesktopCodexFinder({platform:'darwin',...fakeFiles,canonical:async path=>path.endsWith('/codex')?'/tmp/untrusted/codex':path})(),null);
  assert.equal(await createDesktopCodexFinder({platform:'darwin',...fakeFiles,fileStat:async()=>({isFile:()=>false})})(),null);
  assert.equal(await createDesktopCodexFinder({platform:'darwin',...fakeFiles,fileStat:async()=>{throw Error('access denied');}})(),null);
});

test('a discovered desktop engine is connected only after official account metadata confirms ChatGPT; existing login opens no browser', async () => {
  let account={type:'chatgpt'},logins=0;const methods=[];
  const find=createDesktopCodexFinder({platform:'darwin',...fakeFiles});
  const connection=new CodexConnection('/fixture',()=>{},{find,open:()=>{throw Error('Unexpected browser');},rpcFactory:()=>({notify(){},close(){},request:async method=>{methods.push(method);if(method==='account/login/start')logins++;return method==='account/read'?{account}:{};}})});
  assert.equal((await connection.connect()).reused,true);assert.equal(logins,0);assert.deepEqual(methods,['initialize','account/read']);
  account=null;assert.equal((await connection.status({force:true})).connected,false);
});

test('Claude uses official auth status without a terminal, reuses valid login, and does not infer desktop authentication', async () => {
  let signedIn=true,spawns=0;const commands=[];
  const connection=new ClaudeConnection(()=>{},{find:async()=>'/official/claude',spawn:(file,args,options)=>{spawns++;commands.push(args);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stdout.end(JSON.stringify({loggedIn:signedIn,authMethod:'oauth_token'}));child.emit('close',signedIn?0:1);});return child;}});
  assert.equal((await connection.connect()).reused,true);assert.equal(spawns,1);assert.deepEqual(commands,[['auth','status','--json']]);
  signedIn=false;assert.equal((await connection.status({force:true})).connected,false);
  const desktopOnly=new ClaudeConnection(()=>{},{find:async()=>null,spawn:()=>{throw Error('No engine may be invoked');}});
  assert.equal((await desktopOnly.status()).connected,false);await assert.rejects(desktopOnly.connect(),/데스크톱 앱만 설치/);
});
