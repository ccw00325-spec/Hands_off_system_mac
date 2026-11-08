import {createServer} from 'node:http';
import {extname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest,relativeFile} from './workspace.js';
import {deviceBinding} from './device-binding.js';
import {secretFinding} from './secrets.js';

const TYPES={'.html':'text/html','.css':'text/css','.js':'application/javascript','.mjs':'application/javascript','.cjs':'application/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
const code=message=>Object.assign(new Error(message),{code:'VISUAL_CAPTURE'});
export function composeVisualPair(nativeImage,left,right){
  const size=left.getSize(),gap=24,width=size.width*2+gap,bitmap=Buffer.alloc(width*size.height*4,96),a=left.toBitmap(),b=right.resize(size).toBitmap();
  if(a.length!==size.width*size.height*4||b.length!==a.length)throw code('시안 비교 이미지 크기를 정규화하지 못했습니다.');
  for(let p=3;p<bitmap.length;p+=4)bitmap[p]=255;
  for(let y=0;y<size.height;y++){a.copy(bitmap,y*width*4,y*size.width*4,(y+1)*size.width*4);b.copy(bitmap,(y*width+size.width+gap)*4,y*size.width*4,(y+1)*size.width*4);}
  return nativeImage.createFromBitmap(bitmap,{width,height:size.height}).toPNG();
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
    if(!initial.files.some(row=>row.path==='index.html'))throw code('자동 캡처는 프로젝트 루트의 정적 index.html을 지원합니다. 빌드가 필요한 앱은 아직 자동 캡처할 수 없습니다.');
    const token=randomBytes(32).toString('hex'),assets=new Map(),violations=[];let total=0,requests=0,origin,window,server,timer;
    const previewSession=session.fromPartition('visual-'+randomUUID(),{cache:false});
    const fail=message=>{if(violations.length<12)violations.push(message);};
    server=createServer(async(req,res)=>{
      try{
        if(req.headers.host!==origin?.slice(7)||req.headers['x-hands-off-preview']!==token||!['GET','HEAD'].includes(req.method))throw code('허용되지 않은 미리보기 요청입니다.');
        if(++requests>160)throw code('미리보기 리소스 요청 한도를 초과했습니다.');
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
      previewSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(request,callback)=>{const allowed=request.url.startsWith(origin+'/')||request.url.startsWith('data:')||request.url.startsWith('blob:');if(!allowed)fail('외부·파일·네트워크 리소스 요청을 차단했습니다.');callback({cancel:!allowed});});
      previewSession.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(request,callback)=>callback({requestHeaders:{...request.requestHeaders,'X-Hands-Off-Preview':token}}));
      window=new BrowserWindow({show:false,skipTaskbar:true,useContentSize:true,width:size.width,height:size.height,webPreferences:{session:previewSession,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false,backgroundThrottling:false}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/')){event.preventDefault();fail('외부 화면 이동을 차단했습니다.');}});
      window.webContents.on('render-process-gone',()=>fail('미리보기 렌더러가 종료됐습니다.'));
      window.webContents.on('console-message',(...args)=>{const row=args[1],level=typeof row==='object'?row.level:row,message=typeof row==='object'?row.message:args[2];if(level==='error'||level===3||/Content Security Policy|Refused to/i.test(message??''))fail('미리보기 스크립트 또는 보안 정책 오류가 있어 정상 화면으로 인정하지 않았습니다.');});
      signal.addEventListener('abort',abort,{once:true});
      const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reject(code('미리보기 캡처 시간이 초과됐습니다.'));},15000);});
      return await Promise.race([expired,(async()=>{
        await window.loadURL(origin+'/index.html');signal.throwIfAborted();
        await window.webContents.insertCSS('*{animation:none!important;transition:none!important;caret-color:transparent!important}');
        const metrics=await window.webContents.executeJavaScript(`(async()=>{await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1000))]);await new Promise(r=>setTimeout(r,400));return{width:innerWidth,height:innerHeight,title:document.title,text:document.body.innerText.slice(0,12000),elements:[...document.querySelectorAll('h1,h2,button,aside,main,input,select')].slice(0,100).map(el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return{tag:el.tagName,id:el.id,text:el.textContent.trim().slice(0,120),x:b.x,y:b.y,width:b.width,height:b.height,font:s.fontFamily,fontSize:s.fontSize,color:s.color,background:s.backgroundColor}})}})()`);
        signal.throwIfAborted();
        if(!metrics.text.trim()||metrics.width!==size.width||metrics.height!==size.height)throw code('시안과 같은 크기의 정상 화면을 확인하지 못했습니다.');
        if(secretFinding(metrics.text))throw code('화면에서 비밀값을 발견해 AI에 전달하지 않았습니다.');
        if(violations.length)throw code(violations.join(' '));
        const actual=(await window.webContents.capturePage()).resize({width:size.width,height:size.height});
        const evidence={sourceHash,referencePath,referenceHash,viewport:size,assets:[...assets].map(([path,hash])=>({path,hash})),metrics};
        if((await this.workspace.snapshot(projectId)).hash!==sourceHash||!await this.stable(projectId,grantId,evidence))throw code('캡처 중 소스나 리소스가 바뀌었습니다.');
        const comparison=composeVisualPair(nativeImage,ref,actual),png=actual.toPNG();
        const prefix=`.control-tower/runs/${runId}/visual/${round}-${randomUUID()}`;
        const write=async(suffix,buffer)=>{const path=prefix+suffix;await this.workspace.write(projectId,path,buffer,{grantId,internal:true,newOnly:true});return{path,hash:digest(buffer)};};
        return{...evidence,capturedAt:new Date().toISOString(),actual:await write('-actual.png',png),comparison:await write('-comparison.png',comparison)};
      })()]);
    }finally{
      clearTimeout(timer);signal.removeEventListener('abort',abort);abort();
      previewSession.webRequest.onBeforeRequest(null);previewSession.webRequest.onBeforeSendHeaders(null);
      await previewSession.clearStorageData().catch(()=>{});
      if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    }
  }
}
