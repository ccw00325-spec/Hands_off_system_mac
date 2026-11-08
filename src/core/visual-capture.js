import {createServer} from 'node:http';
import {extname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest,relativeFile} from './workspace.js';
import {deviceBinding} from './device-binding.js';
import {secretFinding,redact} from './secrets.js';

const TYPES={'.html':'text/html','.css':'text/css','.js':'application/javascript','.mjs':'application/javascript','.cjs':'application/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
const code=message=>Object.assign(new Error(message),{code:'VISUAL_CAPTURE'});
export function composeVisualPair(nativeImage,left,right){
  const size=left.getSize(),gap=24,width=size.width*2+gap,bitmap=Buffer.alloc(width*size.height*4,96),a=left.toBitmap(),b=right.resize(size).toBitmap();
  if(a.length!==size.width*size.height*4||b.length!==a.length)throw code('시안 비교 이미지 크기를 정규화하지 못했습니다.');
  for(let p=3;p<bitmap.length;p+=4)bitmap[p]=255;
  for(let y=0;y<size.height;y++){a.copy(bitmap,y*width*4,y*size.width*4,(y+1)*size.width*4);b.copy(bitmap,(y*width+size.width+gap)*4,y*size.width*4,(y+1)*size.width*4);}
  return nativeImage.createFromBitmap(bitmap,{width,height:size.height}).toPNG();
}
export async function captureRendered(window){
 const contents=window.webContents;if(!contents.isOffscreen())return contents.capturePage();
 return new Promise((resolve,reject)=>{const done=(_event,_dirty,image)=>{if(image.isEmpty())return;clearTimeout(timer);contents.removeListener('paint',done);resolve(image);};const timer=setTimeout(()=>{contents.removeListener('paint',done);reject(code('미리보기 렌더링 프레임 대기 시간이 초과됐습니다.'));},10000);contents.on('paint',done);contents.invalidate();});
}
export function previewFile(url){
  const path=decodeURIComponent(new URL(url,'http://preview').pathname).slice(1)||'index.html';
  relativeFile(path);if(!TYPES[extname(path).toLowerCase()]||path.startsWith('.')||path.split('/').some(p=>['node_modules','dist','.next','build','artifacts'].includes(p)))throw code('미리보기에서 허용되지 않은 리소스입니다.');
  return path;
}
export class VisualCapture{
  constructor(workspace,store,electron,identity=deviceBinding){Object.assign(this,{workspace,store,electron,identity});this.queue=Promise.resolve();}
  async permission(projectId,grantId,options={}){
    const grant=await this.workspace.grant(projectId,grantId);
    const saved=(await this.store.read('visual-preview-grants',{}))[projectId];
    const explicit=saved?.grantId===grant.grantId&&saved.binding===await this.identity();
    return{allowed:explicit||(options.executionBackend==='host'&&options.allowExecution===true&&grant.executionApproved===true),explicit,grant};
  }
  async authorize(projectId,grantId,allow){
    const operation=this.queue.then(async()=>{const grant=await this.workspace.grant(projectId,grantId),saved=await this.store.read('visual-preview-grants',{});if(allow)saved[projectId]={grantId:grant.grantId,binding:await this.identity()};else delete saved[projectId];await this.store.write('visual-preview-grants',saved);return allow;});
    this.queue=operation.catch(()=>{});return operation;
  }
  async stable(projectId,grantId,evidence){
    try{if(!evidence.referencePath||digest(await this.workspace.read(projectId,evidence.referencePath,{grantId,maxBytes:16*1024*1024}))!==evidence.referenceHash)return false;for(const row of evidence.assets??[])if(digest(await this.workspace.read(projectId,row.path,{grantId,maxBytes:5*1024*1024}))!==row.hash)return false;return true;}catch{return false;}
  }
  async capture({projectId,grantId,runId,round,referencePath,referenceHash,sourceHash,options,signal}){
    signal.throwIfAborted();
    const permission=await this.permission(projectId,grantId,options);
    if(!permission.allowed)throw Object.assign(code('시안 비교를 위한 브라우저 미리보기 실행 동의가 필요합니다. Docker 테스트 설정은 그대로 유지됩니다.'),{requiresPreviewConsent:true});
    const reference=await this.workspace.read(projectId,referencePath,{grantId,maxBytes:16*1024*1024});
    if(digest(reference)!==referenceHash)throw code('승인한 시안 파일이 바뀌었습니다.');
    const {BrowserWindow,session,nativeImage}=this.electron,ref=nativeImage.createFromBuffer(reference),size=ref.getSize();
    if(ref.isEmpty()||size.width<320||size.height<240||size.width>1920||size.height>2160||size.width*size.height>3145728)throw code('자동 비교 시안은 가로 320~1920px, 세로 240~2160px, 총 314만 픽셀 이하 PNG를 사용하세요.');
    const initial=await this.workspace.snapshot(projectId);if(initial.hash!==sourceHash||initial.truncated)throw code('캡처 전에 소스가 바뀌었습니다.');
    const managed=await this.previewServers?.start({projectId,grantId,options,signal,sourceHash});
    if(!managed&&!initial.files.some(row=>row.path==='index.html'))throw code('정적 index.html이 없습니다. 미리보기 설정에서 개발 서버 스크립트와 로컬 주소를 선택하세요.');
    const upstream=managed?new URL(managed.url):null;
    const token=randomBytes(32).toString('hex'),assets=new Map(),bundleCache=new Map(),violations=[],consoleLog=[],networkLog=[];let total=0,requests=0,cacheBytes=0,origin,window,server,timer,metrics;const cacheDeadline=Date.now()+60000,CACHE_MAX_BYTES=8*1024*1024,CACHE_MAX_ENTRIES=12;
    const previewSession=session.fromPartition('visual-'+randomUUID(),{cache:false});
    const fail=message=>{if(violations.length<12)violations.push(message);};
    server=createServer(async(req,res)=>{
      try{
        if(req.headers.host!==origin?.slice(7)||req.headers['x-hands-off-preview']!==token||!['GET','HEAD'].includes(req.method)){res.writeHead(403);res.end('Forbidden');return;}
        if(++requests>160)throw code('미리보기 리소스 요청 한도를 초과했습니다.');
        if(new URL(req.url,'http://preview').pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
        if(upstream){
          const target=new URL(req.url,upstream.origin);
          if(target.origin!==upstream.origin||/(?:^|\/)(?:\.env[^/]*|\.git|\.ssh|\.control-tower)(?:\/|$)/i.test(decodeURIComponent(target.pathname)))throw code('프리뷰의 비밀·관리 경로는 요청할 수 없습니다.');
          const cached=Date.now()<cacheDeadline?bundleCache.get(target.href):null;if(cached){res.setHeader('Content-Type',cached.type);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.end(req.method==='HEAD'?undefined:cached.bytes);return;}const response=await (managed.fetch??fetch)(target,{method:req.method,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{Accept:req.headers.accept??'*/*'}});
          if(response.status>=400&&networkLog.length<20)networkLog.push(`${response.status} ${target.pathname}`);
          const location=response.headers.get('location');if(location){const next=new URL(location,target);if(next.origin!==upstream.origin)throw code('프리뷰 서버의 외부 리디렉션을 차단했습니다.');res.setHeader('Location',next.pathname+next.search);}
          const chunks=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.length;total+=chunk.length;if(size>8*1024*1024||total>32*1024*1024)throw code('개발 서버 응답 용량 한도(파일 8MiB·총 32MiB)를 초과했습니다. '+target.pathname+' · 파일 '+size+' bytes · 누적 '+total+' bytes. 프로젝트의 프리뷰 설정에서 개발 소스맵을 줄이거나 빌드한 프리뷰 스크립트를 사용하세요.');chunks.push(chunk);}
          const bytes=Buffer.concat(chunks),type=response.headers.get('content-type')??'application/octet-stream';
          if(/text|json|javascript|svg/.test(type)&&secretFinding(bytes.toString('utf8')))throw code('개발 서버 응답의 비밀값을 발견해 캡처를 중단했습니다.');
          if(Date.now()<cacheDeadline&&cacheBytes+bytes.length<=CACHE_MAX_BYTES&&bundleCache.size<CACHE_MAX_ENTRIES&&req.method==='GET'&&response.status===200&&/\.(?:m?js|css|woff2?|ttf|png|jpe?g|svg|webp)$/.test(target.pathname)&&!target.pathname.includes('/api/')){bundleCache.set(target.href,{type,bytes});cacheBytes+=bytes.length;}res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
          res.setHeader('Content-Security-Policy',`default-src 'none';script-src 'self' 'unsafe-inline' 'unsafe-eval';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self' data:;connect-src 'self' ws://127.0.0.1:${upstream.port} ws://localhost:${upstream.port};object-src 'none';frame-src 'none';worker-src 'self' blob:;form-action 'self';base-uri 'none'`);
          res.writeHead(response.status);res.end(req.method==='HEAD'?undefined:bytes);return;
        }
        const path=previewFile(req.url),extension=extname(path).toLowerCase();
        if(path==='favicon.ico'){res.writeHead(204);res.end();return;}
        const bytes=await this.workspace.read(projectId,path,{grantId,maxBytes:5*1024*1024});
        if((total+=bytes.length)>24*1024*1024)throw code('미리보기 리소스 크기 한도를 초과했습니다.');
        if(['.html','.css','.js','.mjs','.cjs','.json','.svg'].includes(extension)&&secretFinding(bytes.toString('utf8')))throw code('미리보기 소스에서 비밀값을 발견해 캡처를 중단했습니다.');
        const hash=digest(bytes);if(assets.has(path)&&assets.get(path)!==hash)throw code('미리보기 중 리소스가 바뀌었습니다.');assets.set(path,hash);
        res.setHeader('Content-Type',TYPES[extension]+'; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'none';script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self';connect-src 'self';object-src 'none';frame-src 'none';worker-src 'none';form-action 'none';base-uri 'none'");
        res.end(req.method==='HEAD'?undefined:bytes);
      }catch(error){fail(error.code==='ENOENT'?'필요한 로컬 리소스를 찾지 못했습니다.':error.code==='VISUAL_CAPTURE'?error.message:'허용된 폴더의 리소스를 읽지 못했습니다.');res.writeHead(404);res.end('Preview resource unavailable');}
    });
    const abort=()=>{if(window&&!window.isDestroyed())window.destroy();};
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
      previewSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));previewSession.setPermissionCheckHandler(()=>false);
      previewSession.on('will-download',event=>event.preventDefault());
      previewSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(request,callback)=>{if(managed?.containerized&&request.resourceType==='webSocket'){callback({cancel:true});return;}const socket=managed&&request.resourceType==='webSocket'&&[origin.replace('http:','ws:'),`ws://127.0.0.1:${upstream.port}`,`ws://localhost:${upstream.port}`].some(base=>request.url.startsWith(base+'/'));
        const allowed=socket||request.url.startsWith(origin+'/')||request.url.startsWith('data:')||request.url.startsWith('blob:');if(!allowed){fail('외부·파일·네트워크 리소스 요청을 차단했습니다.');if(networkLog.length<20)networkLog.push(redact(request.url.slice(0,1000)));}callback({cancel:!allowed});});
      previewSession.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(request,callback)=>callback({requestHeaders:{...request.requestHeaders,'X-Hands-Off-Preview':token}}));
      window=new BrowserWindow({show:false,skipTaskbar:true,useContentSize:true,enableLargerThanScreen:true,width:size.width,height:size.height,webPreferences:{session:previewSession,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false,backgroundThrottling:false}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/')){event.preventDefault();fail('외부 화면 이동을 차단했습니다.');}});
      window.webContents.on('render-process-gone',()=>fail('미리보기 렌더러가 종료됐습니다.'));
      window.webContents.on('console-message',(...args)=>{const row=args[1],level=typeof row==='object'?row.level:row,message=typeof row==='object'?row.message:args[2];if(consoleLog.length<30)consoleLog.push(redact(String(message??'').slice(0,1500)));const hmr=managed&&/WebSocket connection|\[vite\].*(?:connect|websocket)|webpack.*HMR/i.test(message??'');if(!hmr&&(level==='error'||level===3||/Content Security Policy|Refused to/i.test(message??'')))fail('미리보기 스크립트 또는 보안 정책 오류가 있어 정상 화면으로 인정하지 않았습니다.');});
      signal.addEventListener('abort',abort,{once:true});
      const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reject(code('미리보기 캡처 시간이 초과됐습니다.'));},managed?120000:60000);});
      return await Promise.race([expired,(async()=>{
        await window.loadURL(origin+(upstream?.pathname??'/index.html'));signal.throwIfAborted();
        await window.webContents.insertCSS('*{animation:none!important;transition:none!important;caret-color:transparent!important}');
        metrics=await window.webContents.executeJavaScript(`(async()=>{await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1000))]);await new Promise(r=>setTimeout(r,600));return{width:innerWidth,height:innerHeight,title:document.title,text:document.body.innerText.slice(0,12000),overflow:document.documentElement.scrollWidth>innerWidth+1,elements:[...document.querySelectorAll('h1,h2,button,aside,main,input,select')].slice(0,100).map(el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return{tag:el.tagName,id:el.id,text:el.textContent.trim().slice(0,120),x:b.x,y:b.y,width:b.width,height:b.height,font:s.fontFamily,fontSize:s.fontSize,color:s.color,background:s.backgroundColor}})}})()`);
        signal.throwIfAborted();
        if(!metrics.text.trim()||metrics.width!==size.width||metrics.height!==size.height)throw code('시안과 같은 크기의 정상 화면을 확인하지 못했습니다.');
        if(secretFinding(metrics.text))throw code('화면에서 비밀값을 발견해 AI에 전달하지 않았습니다.');
        if(violations.length)throw code(violations.join(' '));
        const actual=(await captureRendered(window)).resize({width:size.width,height:size.height});
        const evidence={sourceHash,referencePath,referenceHash,viewport:size,assets:[...(managed?.assets??[]),...[...assets].map(([path,hash])=>({path,hash}))],metrics,backend:managed?'development-server':'static',unverifiedSource:managed?.unverifiedSource??false,diagnostics:{console:consoleLog,network:networkLog,log:managed?.log}};
        if((await this.workspace.snapshot(projectId)).hash!==sourceHash||!await this.stable(projectId,grantId,evidence))throw code('캡처 중 소스나 리소스가 바뀌었습니다.');
        const comparison=composeVisualPair(nativeImage,ref,actual),png=actual.toPNG();
        const prefix=`.control-tower/runs/${runId}/visual/${round}-${randomUUID()}`;
        const write=async(suffix,buffer)=>{const path=prefix+suffix;await this.workspace.write(projectId,path,buffer,{grantId,internal:true,newOnly:true});return{path,hash:digest(buffer)};};
        const states=await this.captureStates(window,origin,managed?.config?.profiles??options.previewProfiles??[],projectId,grantId,prefix,signal,referenceHash);if(violations.length)throw code(violations.join(' '));
        if((await this.workspace.snapshot(projectId)).hash!==sourceHash)throw code('다중 상태 캡처 중 소스가 변경됐습니다.');
        return{...evidence,states,capturedAt:new Date().toISOString(),actual:await write('-actual.png',png),comparison:await write('-comparison.png',comparison)};
      })()]);
    }catch(error){
      let dom=metrics?.text??'';if(window&&!window.isDestroyed())dom=await window.webContents.executeJavaScript(`document.body?.innerText?.slice(0,12000)??''`).catch(()=>dom);
      error.diagnostics={...(error.diagnostics??{}),log:redact(managed?.log??''),console:consoleLog,network:networkLog,dom:redact(dom),metrics};throw error;
    }finally{
      bundleCache.clear();cacheBytes=0;clearTimeout(timer);signal.removeEventListener('abort',abort);abort();
      previewSession.webRequest.onBeforeRequest(null);previewSession.webRequest.onBeforeSendHeaders(null);
      await previewSession.clearStorageData().catch(()=>{});
      if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
      await managed?.close();
    }
  }
  async captureStates(window,origin,profiles,projectId,grantId,prefix,signal,referenceHash){
    const result=[];
    for(const profile of profiles){
      signal.throwIfAborted();window.setContentSize(profile.width,profile.height);await window.loadURL(origin+profile.path);
      await window.webContents.insertCSS('*{animation:none!important;transition:none!important;caret-color:transparent!important}');
      for(const action of profile.actions){await window.webContents.executeJavaScript(`(()=>{const a=${JSON.stringify(action)},el=document.querySelector(a.selector);if(!el)throw new Error('상태 동작의 요소를 찾지 못했습니다.');if(el.matches('input[type=password],input[type=file]'))throw new Error('비밀값·파일 입력은 자동 조작하지 않습니다.');if(a.type==='click')el.click();else{const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,a.value??'');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}})()`);}
      await new Promise(r=>setTimeout(r,400));
      const metrics=await window.webContents.executeJavaScript(`(()=>{const selected=${JSON.stringify(profile.selector)},root=selected?document.querySelector(selected):document.body;if(!root)throw new Error('컴포넌트를 찾지 못했습니다.');const box=root.getBoundingClientRect();return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,rect:{x:Math.max(0,box.x),y:Math.max(0,box.y),width:Math.min(box.width,innerWidth),height:Math.min(box.height,innerHeight)},text:(root.innerText??root.textContent??'').slice(0,8000),dom:[root,...root.querySelectorAll('*')].slice(0,250).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{tag:el.tagName,id:el.id,role:el.getAttribute('role'),text:el.childElementCount?'':el.textContent.slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height,font:s.fontFamily,fontSize:s.fontSize,color:s.color,background:s.backgroundColor}})}})()`);
      if(metrics.width!==profile.width||metrics.height!==profile.height)throw code('요청한 뷰포트 크기로 상태를 렌더링하지 못했습니다.');
      if(secretFinding(JSON.stringify(metrics)))throw code('다중 화면의 비밀값을 발견해 캡처를 중단했습니다.');
      let capture=(await captureRendered(window)).resize({width:profile.width,height:profile.height});
      if(profile.selector){const r=metrics.rect;if(r.width<1||r.height<1||r.x+r.width>profile.width+1||r.y+r.height>profile.height+1)throw code('컴포넌트가 화면 밖에 있습니다. 상태·스크롤 위치를 확인하세요.');capture=capture.crop({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.floor(r.width),height:Math.floor(r.height)});}
      const buffer=capture.toPNG(),path=prefix+'-'+profile.id+'-state.png';await this.workspace.write(projectId,path,buffer,{grantId,internal:true,newOnly:true});
      const regression=await this.regression?.compare(projectId,grantId,profile,referenceHash,metrics,buffer)??{status:'unbaselined'};
      let comparison;
      if(regression.baseline){const before=await this.workspace.read(projectId,regression.baseline.path,{grantId,internal:true,maxBytes:16*1024*1024});const ref=this.electron.nativeImage.createFromBuffer(before),pair=composeVisualPair(this.electron.nativeImage,ref,capture),pairPath=prefix+'-'+profile.id+'-state-comparison.png';await this.workspace.write(projectId,pairPath,pair,{grantId,internal:true,newOnly:true});comparison={path:pairPath,hash:digest(pair),viewport:ref.getSize()};}
      result.push({id:profile.id,profile,metrics,regression,comparison,image:{path,hash:digest(buffer)},note:'반응형·상태별 캡처입니다. 별도 승인 기준이 없는 뷰포트를 원본 시안과 일치했다고 처리하지 않습니다.'});
    }return result;
  }
}
