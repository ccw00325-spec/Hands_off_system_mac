import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,lstat,readdir,symlink,access} from 'node:fs/promises';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {digest} from './workspace.js';
import {deviceBinding} from './device-binding.js';
import {projectEnvironment} from './child-env.js';
import {nodeRuntime} from './node-runtime.js';
import {findExecutable} from './providers.js';
import {terminateTree} from './processes.js';
import {redact,secretFinding} from './secrets.js';
const exec=promisify(execFile), pause=ms=>new Promise(r=>setTimeout(r,ms));
// The container has no network interface other than loopback. The host reads
// bounded GET/HEAD responses through docker exec, never a published bridge port.
const CONTAINER_REQUEST=`const http=require('node:http');const target=new URL(process.argv[1]);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1')process.exit(2);const req=http.request(target,{method:process.argv[2],headers:{Accept:process.argv[3]||'*/*'}},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){req.destroy(new Error('Preview response exceeds 8MiB'));return;}chunks.push(chunk);});res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,type:res.headers['content-type'],location:res.headers.location,body:Buffer.concat(chunks).toString('base64')})));});req.on('error',error=>{process.stderr.write(error.message.slice(0,500));process.exitCode=1;});req.setTimeout(10000,()=>req.destroy(new Error('Preview response timeout')));req.end();`;
const previewError=(message,details={})=>Object.assign(new Error(message),{code:'PREVIEW_SETUP',...details});
export const DEFAULT_PREVIEW_PROFILES=[{id:'mobile',path:'/',width:390,height:844,selector:'',actions:[]},{id:'tablet',path:'/',width:768,height:1024,selector:'',actions:[]}];
export function localPreviewURL(value){
 const u=new URL(value);
 if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.hash||u.search||!u.port||Number(u.port)<1024||u.href.length>2048||/\.(?:env|pem|key)(?:\/|$)|\/(?:\.git|\.control-tower)(?:\/|$)/i.test(u.pathname))throw previewError('미리보기 주소는 인증 정보 없는 http://127.0.0.1:1024~65535/경로 형식이어야 합니다.');
 u.hostname='127.0.0.1';return u;
}
export function previewConfiguration(input={}){
 const mode=input.mode??'auto';if(!['auto','static','script','external'].includes(mode))throw previewError('미리보기 실행 방식을 확인하세요.');
 const script=input.script??'';if(typeof script!=='string'||!/^$|^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script))throw previewError('명령문 대신 package.json에 등록한 npm 스크립트 이름을 선택하세요.');
 const url=input.url?localPreviewURL(input.url).href:'';
 const cleanupScript=input.cleanupScript??'';if(typeof cleanupScript!=='string'||!/^$|^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(cleanupScript))throw previewError('정리 명령은 등록한 npm 스크립트 이름이어야 합니다.');
 if(['script','external'].includes(mode)&&!url)throw previewError('사용자 지정 미리보기에는 로컬 접속 주소가 필요합니다.');
 const profiles=input.profiles??DEFAULT_PREVIEW_PROFILES;if(!Array.isArray(profiles)||profiles.length>6)throw previewError('화면 상태는 최대 6개까지 지정하세요.');
 const normalized=profiles.map((p,i)=>{
  const width=Number(p.width),height=Number(p.height),selector=p.selector??'';
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(p.id??'')||!Number.isInteger(width)||!Number.isInteger(height)||width<320||width>1920||height<240||height>2160||width*height>3145728||typeof selector!=='string'||selector.length>200)throw previewError('화면 상태의 ID·크기·컴포넌트 선택자를 확인하세요.');
  const path=p.path??'/';if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||path.length>1000||/[\r\n\x00]/.test(path)||new URL(path,'http://preview').origin!=='http://preview')throw previewError('미리보기 경로는 같은 서버의 /경로만 사용할 수 있습니다.');
  const actions=p.actions??[];if(!Array.isArray(actions)||actions.length>12||actions.some(a=>!['click','fill','select'].includes(a.type)||typeof a.selector!=='string'||!a.selector||a.selector.length>200||a.value!==undefined&&(typeof a.value!=='string'||a.value.length>500||secretFinding(a.value))))throw previewError('화면 동작은 CSS 선택자로 클릭·텍스트 입력·선택만 지정할 수 있습니다. 비밀값은 입력하지 마세요.');
  return{id:p.id,path,width,height,selector,actions:actions.map(a=>({type:a.type,selector:a.selector,...(a.value!==undefined?{value:a.value}:{})}))};
 });if(new Set(normalized.map(p=>p.id)).size!==normalized.length)throw previewError('화면 상태 ID가 중복됐습니다.');
 return{mode,script,url,cleanupScript,profiles:normalized};
}
export function discoverPreview(manifest){
 const candidates=[];for(const [script,command]of Object.entries(manifest?.scripts??{})){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script)||typeof command!=='string')continue;
  const clean=!/[;&|<>`$\r\n]/.test(command),kind=clean&&/^next\s+dev(?:\s|$)/.test(command)?'next':clean&&/^vite(?:\s+(?:dev|serve))?(?:\s+--[^;&|]*)?$/.test(command.trim())?'vite':clean&&/^react-scripts\s+start\s*$/.test(command)?'react-scripts':null;
  if(kind)candidates.push({script,kind,command:command.slice(0,1000)});
 }return candidates.sort((a,b)=>(a.script==='dev'?-1:0)-(b.script==='dev'?-1:0));
}
export async function copyPreviewSource(workspace,id,grantId,target,expected){
 const tree=await workspace.tree(id);if(tree.omitted)throw previewError('프리뷰 복사 범위를 넘었습니다. 일부 파일만 실행하지 않습니다.');let bytes=0;const assets=[];
 for(const file of tree.files.filter(r=>r.type==='file')){const data=await workspace.read(id,file.path,{grantId,maxBytes:5*1024*1024}),hash=digest(data);if(expected?.files.find(r=>r.path===file.path)?.hash&&expected.files.find(r=>r.path===file.path).hash!==hash)throw previewError('프리뷰 복사 중 소스가 바뀌었습니다. 실행하지 않습니다.');if((bytes+=data.length)>32*1024*1024)throw previewError('프리뷰 소스 복사 한도를 초과했습니다.');if(!data.includes(0)&&secretFinding(data.toString('utf8')))throw previewError('프리뷰 소스의 비밀값을 먼저 정리하세요.');const path=join(target,file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,data,{mode:0o644});assets.push({path:file.path,hash});}
 if(expected?.files.some(r=>!assets.some(a=>a.path===r.path&&a.hash===r.hash)))throw previewError('현재 소스의 모든 파일을 같은 버전으로 복사하지 못했습니다.');return assets;
}
async function freePort(preferred){const server=createServer();try{await new Promise((yes,no)=>{server.once('error',no);server.listen(preferred??0,'127.0.0.1',yes);});return server.address().port;}finally{if(server.listening)await new Promise(r=>server.close(r));}}
async function npmPath(node){for(const part of ['node_modules/npm/bin/npm-cli.js','../lib/node_modules/npm/bin/npm-cli.js','../share/nodejs/npm/bin/npm-cli.js']){const path=join(dirname(node),part);if(await access(path).then(()=>true,()=>false))return path;}throw previewError('신뢰할 수 있는 Node.js 설치의 npm을 찾지 못했습니다.');}

export class PreviewServers{
 constructor(workspace,store,identity=deviceBinding){Object.assign(this,{workspace,store,identity});}
 async inspect(id,input){
  const grant=await this.workspace.grant(id),project=this.workspace.projects.find(await this.workspace.projects.list(),id);
  let bytes;try{bytes=await this.workspace.read(id,'package.json',{grantId:grant.grantId,maxBytes:500000});}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  let manifest={};if(bytes)try{manifest=JSON.parse(bytes);}catch{throw previewError('package.json을 해석하지 못했습니다.');}
  const config=previewConfiguration(input??project.previewConfig??manifest.handsoff?.preview??{}),candidates=discoverPreview(manifest);
  const candidate=config.script?candidates.find(c=>c.script===config.script):candidates[0];
  if(secretFinding(manifest.scripts?.[config.script||candidate?.script]??''))throw previewError('미리보기 명령에 비밀값을 하드코딩하지 마세요.');
  if(config.mode==='script'&&!Object.hasOwn(manifest.scripts??{},config.script))throw previewError('선택한 npm 스크립트가 package.json에 없습니다.');
  const cleanupCommand=manifest.scripts?.[config.cleanupScript]??'';if(config.cleanupScript&&(!cleanupCommand||secretFinding(cleanupCommand)))throw previewError('등록한 비밀값 없는 정리 스크립트를 확인하세요.');
  return{nextMajor:Number(/^[~^]?(\d+)/.exec(manifest.dependencies?.next??manifest.devDependencies?.next??'')?.[1])||null,scripts:Object.keys(manifest.scripts??{}).filter(key=>/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(key)),grant,config,candidates,candidate,cleanupCommand,manifestHash:bytes?digest(bytes):null,script:config.script||candidate?.script||'',command:manifest.scripts?.[config.script||candidate?.script]??'',usesServer:config.mode==='external'||config.mode==='script'||config.mode==='auto'&&!!candidate};
 }
 async fingerprint(id,options,input){const info=await this.inspect(id,input);return{...info,key:digest(JSON.stringify({config:info.config,script:info.script,command:info.command,manifestHash:info.manifestHash,backend:options.executionBackend,image:options.dockerImage,grantId:info.grant.grantId,binding:await this.identity()}))};}
 async allowed(id,options){const info=await this.fingerprint(id,options);const saved=await this.store.read('preview-approvals',{});return{...info,allowed:saved[id]===info.key};}
 async approve(id,options,input,expectedKey){const info=await this.fingerprint(id,options,input);if(expectedKey&&info.key!==expectedKey)throw previewError('승인 창을 연 뒤 실행 설정이나 스크립트가 바뀌었습니다. 다시 확인하세요.');await this.workspace.projects.mutate(data=>{this.workspace.projects.find(data,id).previewConfig=info.config;});const saved=await this.store.read('preview-approvals',{});saved[id]=info.key;await this.store.write('preview-approvals',saved);return info.config;}
 async start(context){
  const {projectId:id,grantId,options,signal}=context,info=await this.allowed(id,options);if(!info.usesServer)return null;
  if(!info.allowed)throw previewError('미리보기 명령·주소·실행 위치를 설정에서 확인하고 승인하세요.',{requiresPreviewSetup:true});
  if(info.config.mode==='external')return{url:info.config.url,config:info.config,unverifiedSource:true,log:'사용자가 지정한 기존 로컬 서버입니다. 현재 소스와 서버의 연결은 자동 증명할 수 없습니다.',close:async()=>{}};
  if(!options.allowExecution||!info.grant.executionApproved)throw previewError('프리뷰 서버 실행에는 전역·현재 폴더 실행 동의가 필요합니다.',{requiresPreviewConsent:true});
  if(/(?:docker\s+compose|docker-compose).*\bup\b.*(?:--detach|\s-d\b)/.test(info.command))throw previewError('사용자 지정 서버는 foreground로 실행해야 종료를 관리할 수 있습니다. Compose의 -d 대신 foreground up을 사용하거나 기존 서버 주소 연결을 선택하세요.');
  const anchor=process.platform==='win32'&&options.executionBackend==='host'&&(info.candidate?.kind==='next'||info.nextMajor)?await this.workspace.locate(id,'.control-tower/previews/anchor',{grantId,internal:true,create:true}):null;const parent=await realpath(anchor?dirname(anchor.target):tmpdir()),root=await mkdtemp(join(parent,'cw-preview-')),input=join(root,'input');await mkdir(input);
  const container='cw-preview-'+randomUUID();let child,docker,request=fetch,log='',firstLog='',tailLog='',timer,hostCleanup,closed=false;
  const append=data=>{const value=data.toString();firstLog=(firstLog+value).slice(0,8000);tailLog=(tailLog+value).slice(-16000);log=redact(firstLog+'\n<latest log>\n'+tailLog);};
  const hostOptions={env:projectEnvironment(),windowsHide:true,shell:false,timeout:10000,maxBuffer:32000};
  const close=async()=>{if(closed)return;closed=true;clearTimeout(timer);await terminateTree(child);if(hostCleanup){try{await hostCleanup();}catch{throw previewError('프리뷰 정리 스크립트가 실패했습니다. 임시 폴더와 실행 로그를 보존했습니다. 직접 리소스를 정리하세요: '+root,{diagnostics:{log}});}}if(docker){await exec(docker,['rm','--force',container],hostOptions).catch(()=>{});}const actual=await realpath(root).catch(()=>null),part=actual&&relative(parent,actual);if(actual&&part&&!isAbsolute(part)&&!part.startsWith('..')&&part.startsWith('cw-preview-'))await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});};
  try{
   signal.throwIfAborted();const frozen=await this.workspace.snapshot(id);if(context.sourceHash&&frozen.hash!==context.sourceHash||frozen.truncated)throw previewError('프리뷰 실행 전에 소스가 바뀌었습니다.');const assets=await copyPreviewSource(this.workspace,id,grantId,input,frozen);
   if((await this.workspace.snapshot(id)).hash!==frozen.hash||info.manifestHash!==digest(await readFile(join(input,'package.json'))))throw previewError('승인한 실행 명령 또는 소스가 복사 중 변경됐습니다. 실행하지 않습니다.');
   await this.workspace.grant(id,grantId);if(this.executionAllowed&&!await this.executionAllowed(context))throw previewError('실행 동의 또는 선택한 실행 위치가 바뀌었습니다.',{requiresPreviewConsent:true});signal.throwIfAborted();
   const preferred=info.config.url?Number(localPreviewURL(info.config.url).port):undefined,port=options.executionBackend==='docker'?(preferred??5173):await freePort(preferred),containerPort=preferred??5173;
   const kind=info.candidate?.kind,flags=kind==='vite'?['--host',options.executionBackend==='docker'?'0.0.0.0':'127.0.0.1','--port',String(options.executionBackend==='docker'?containerPort:port),'--strictPort']:kind==='next'?[...(info.nextMajor>=16&&!/--(?:turbo|turbopack|webpack)\b/.test(info.command)?['--webpack']:[]),'--hostname',options.executionBackend==='docker'?'0.0.0.0':'127.0.0.1','--port',String(options.executionBackend==='docker'?containerPort:port)]:[];
   const url=info.config.url||`http://127.0.0.1:${port}/`;
   if(options.executionBackend==='docker'){
    docker=await findExecutable('docker');if(!docker)throw previewError('Docker 엔진·프리뷰용 의존성 이미지가 필요합니다. PC에서 대신 실행하지 않습니다.');
    const endpoint=(await exec(docker,['context','inspect','--format','{{(index .Endpoints "docker").Host}}'],hostOptions)).stdout.trim();if(!/^(?:unix:\/\/\/|npipe:\/\/)/.test(endpoint))throw previewError('로컬 Docker 엔진만 프리뷰에 사용할 수 있습니다.');
    const image=options.dockerImage;if(!/^[a-z0-9][a-z0-9./_:-]*(?:@sha256:[a-f0-9]{64})?$/.test(image))throw previewError('프리뷰 이미지 이름을 확인하세요.');
    if((await exec(docker,['image','inspect','--format','{{.Os}}',image],hostOptions)).stdout.trim()!=='linux')throw previewError('로컬 Linux 이미지를 준비하세요.');
    const uid=process.getuid?.()??1000,gid=process.getgid?.()??1000;
    const args=['run','--rm','--pull=never','--name',container,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=1g','--cpus=2','--user',`${uid}:${gid}`,'--tmpfs',`/workspace:rw,nosuid,nodev,size=536870912,uid=${uid},gid=${gid}`,'--tmpfs',`/tmp:rw,nosuid,nodev,size=134217728,uid=${uid},gid=${gid}`,'--mount',`type=bind,src=${input},dst=/input,readonly`,'--workdir','/workspace','--env',`PORT=${containerPort}`,'--env','HOST=0.0.0.0','--env','BROWSER=none',image,'sh','-c','cp -R /input/. /workspace/; if [ -d /opt/node_modules ]; then ln -s /opt/node_modules /workspace/node_modules; fi; exec "$@"','--','npm','--ignore-scripts','run',info.script,'--',...flags];
    request=async(value,init={})=>{const target=new URL(value),method=init.method??'GET';if(target.origin!=='http://127.0.0.1:'+containerPort||!['GET','HEAD'].includes(method))throw previewError('컨테이너 프리뷰의 읽기 전용 루프백 요청만 허용합니다.');const result=await exec(docker,['exec',container,'node','-e',CONTAINER_REQUEST,target.href,method,String(init.headers?.Accept??'*/*')],{...hostOptions,timeout:12000,maxBuffer:12*1024*1024,signal:init.signal});const row=JSON.parse(result.stdout);if(!Number.isInteger(row.status)||row.status<200||row.status>599||typeof row.body!=='string'||row.body.length>11200000)throw previewError('컨테이너 응답을 확인하지 못했습니다.');const bytes=Buffer.from(row.body,'base64');if(bytes.length>8*1024*1024)throw previewError('컨테이너 응답 크기를 초과했습니다.');return new Response([204,205,304].includes(row.status)||method==='HEAD'?null:bytes,{status:row.status,headers:{'Content-Type':row.type??'application/octet-stream',...(row.location?{Location:row.location}:{})}});};
    await this.workspace.grant(id,grantId);if(this.executionAllowed&&!await this.executionAllowed(context))throw previewError('실행 동의 또는 실행 위치가 바뀌었습니다.');signal.throwIfAborted();child=spawn(docker,args,{...hostOptions,timeout:undefined,stdio:['ignore','pipe','pipe']});
   }else if(options.executionBackend==='host'){
    const node=await nodeRuntime();if(!node)throw previewError('Node.js 24+와 npm이 필요합니다.');const npm=await npmPath(node);
    const dependencies=join(info.grant.root,'node_modules');
    if(await access(dependencies).then(()=>true,()=>false)){
      const stat=await lstat(dependencies);if(!stat.isDirectory()||stat.isSymbolicLink())throw previewError('실제 프로젝트 안의 node_modules 디렉터리를 사용하세요.');
      const deps=await realpath(dependencies),local=join(input,'node_modules');await mkdir(local);
      for(const entry of await readdir(deps,{withFileTypes:true})){if(entry.name.startsWith('.')&&entry.name!=='.bin')continue;const target=await realpath(join(deps,entry.name)),part=relative(deps,target);if(part.startsWith('..')||isAbsolute(part))throw previewError('프로젝트 밖으로 연결된 의존성은 자동 프리뷰에서 지원하지 않습니다.');await symlink(target,join(local,entry.name),entry.isDirectory()||entry.isSymbolicLink()?'junction':'file');}
    }
    if(!kind&&!info.config.cleanupScript)throw previewError('사용자 지정 서버는 정리 npm 스크립트도 지정하세요. Compose 등 별도 리소스는 프로세스 종료만으로 정리되지 않습니다.');await this.workspace.grant(id,grantId);if(this.executionAllowed&&!await this.executionAllowed(context))throw previewError('실행 동의 또는 실행 위치가 바뀌었습니다.');if(info.config.cleanupScript)hostCleanup=()=>exec(node,[npm,'--ignore-scripts','run',info.config.cleanupScript],{cwd:input,env:projectEnvironment({HOME:root,USERPROFILE:root,COMPOSE_PROJECT_NAME:container,NPM_CONFIG_CACHE:join(root,'npm-cache')}),windowsHide:true,shell:false,timeout:15000,maxBuffer:32000});signal.throwIfAborted();child=spawn(node,[npm,'--ignore-scripts','run',info.script,'--',...flags],{cwd:input,env:projectEnvironment({PORT:String(port),HOST:'127.0.0.1',BROWSER:'none',NEXT_TELEMETRY_DISABLED:'1',HOME:root,USERPROFILE:root,NPM_CONFIG_CACHE:join(root,'npm-cache'),COMPOSE_PROJECT_NAME:container}),windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
   }else throw previewError('선택한 실행 위치를 확인하세요.');
   let failure;child.once('error',error=>{failure=error;});child.stdout.on('data',append);child.stderr.on('data',append);
   const stop=()=>void terminateTree(child);signal.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,180000);
   const started=Date.now();let ready=false;while(Date.now()-started<60000){signal.throwIfAborted();if(failure||child.exitCode!==null)throw previewError('프리뷰 서버가 시작되기 전에 종료됐습니다.',{diagnostics:{log}});try{const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(1200)});await response.body?.cancel();if(response.status<500){ready=true;break;}}catch{}await pause(300);}
   if(!ready)throw previewError('60초 안에 프리뷰 서버 응답을 확인하지 못했습니다.',{diagnostics:{log}});
   return{url,fetch:request,containerized:options.executionBackend==='docker',config:info.config,assets,get log(){return log.split(root).join('<preview>').split(info.grant.root).join('<project>');},close:async()=>{signal.removeEventListener('abort',stop);await close();},unverifiedSource:false};
  }catch(error){await close();if(error.name==='AbortError')throw error;throw previewError(redact(error.message),{diagnostics:{log,...error.diagnostics},requiresPreviewSetup:error.requiresPreviewSetup});}
 }
}
