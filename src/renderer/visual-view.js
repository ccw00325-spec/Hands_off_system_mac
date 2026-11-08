const labels={capturing:'화면 캡처 중',reviewing:'UI 담당 비교 중',matched:'AI 기준 일치',mismatch:'차이 발견',repairing:'UI 보정 중',blocked:'확인 필요',waiting:'기능 검증 대기',not_applicable:'이미지 비교 대상 없음',disabled:'미선택',stale:'다시 확인 필요'};
const categories={layout:'구조·배치',color:'색상',typography:'글꼴',spacing:'간격',size:'크기',icons:'아이콘'};
const providers={gpt:'GPT',claude:'Claude',grok:'Cursor',gemini:'Gemini'};
export function createVisualView({api,call,projectId,currentRun,active,notice}){
 const $=s=>document.querySelector(s);let selected;
 const functional=run=>run?.validation?.stale?'기능 검증 · 소스 변경으로 재확인 필요':run?.validation?.passed?'기능 검증 · 통과':'기능 검증 · 실패 또는 미확인';
 function render(run){
  if(selected&&(selected.projectId!==projectId()||selected.runId!==run?.id)){$('#visual-dialog').close();selected=null;for(const id of ['#visual-reference','#visual-actual'])$(id).removeAttribute('src');}
  const visual=run?.visual;$('#visual-flow-panel').hidden=!visual;$('#visual-open-image').hidden=!visual;
  $('#visual-flow-status').textContent=labels[visual?.status]??'대기';$('#visual-flow-summary').textContent=visual?.summary??'';$('#visual-flow-functional').textContent=functional(run);
  if($('#visual-dialog').open&&selected?.runId===run?.id)void open(false);
 }
 async function open(show=true){
  const run=currentRun();if(!run?.visual)return;
  const request={projectId:projectId(),runId:run.id};selected=request;
  try{
   const result=await call(api.visualEvidence(request.projectId,request.runId));if(selected!==request||projectId()!==request.projectId||currentRun()?.id!==request.runId)return;
   const visual=result.visual??run.visual;$('#visual-summary').textContent=(labels[visual.status]??'확인 필요')+' · '+visual.summary;
   $('#visual-functional').textContent=functional({validation:result.functional??run.validation});
   $('#visual-note').textContent=result.stale?'캡처 이후 파일이 바뀌었습니다. 이전 판정을 현재 화면에 적용할 수 없습니다.':visual.provider?`${providers[visual.provider]??visual.provider}${visual.model?' · '+visual.model:''} · 보정 ${run.round??0}회${visual.reused?' · 동일 이미지 판정 재사용':''}`:'';
   $('#visual-pictures').hidden=!result.images;
   for(const [id,key]of [['#visual-reference','reference'],['#visual-actual','actual']]){if(result.images)$(id).src=result.images[key];else $(id).removeAttribute('src');}
   const list=$('#visual-observations');list.replaceChildren();for(const row of visual.observations??[]){const li=document.createElement('li');li.dataset.result=row.status;const title=document.createElement('strong');title.textContent=(categories[row.category]??row.category)+' · '+({match:'일치',different:'차이',unverifiable:'판단 불가'}[row.status]??row.status);const text=document.createElement('p');text.textContent=`시안: ${row.expected}\n구현: ${row.actual}\n근거: ${row.evidence}`;li.append(title,text);list.append(li);}
   $('#visual-retry').disabled=active(run)||result.stale===true;$('#visual-revoke').disabled=active(run);
   if(show&&!$('#visual-dialog').open)$('#visual-dialog').showModal();
  }catch(error){notice(error.message,'error');}
 }
 for(const id of ['#visual-open','#visual-open-image'])$(id).onclick=()=>void open();
 $('#visual-close').onclick=()=>{$('#visual-dialog').close();selected=null;};
 $('#visual-dialog').addEventListener('close',()=>{selected=null;});
 $('#visual-retry').onclick=async()=>{
  const request=selected;if(!request)return;$('#visual-retry').disabled=true;
  try{let permission=await call(api.visualPermission(request.projectId,request.runId));if(!permission.allowed)permission=await call(api.visualPermission(request.projectId,request.runId,true));if(!permission.allowed){notice('미리보기 실행을 허용하지 않아 비교를 시작하지 않았습니다.');return;}await call(api.retryVisual(request.projectId,request.runId));notice('기능 검증과 시안 비교를 다시 시작합니다.');}
  catch(error){notice(error.message,'error');}finally{if(selected===request)$('#visual-retry').disabled=active(currentRun());}
 };
 $('#visual-revoke').onclick=async()=>{if(!selected)return;try{const p=await call(api.visualPermission(selected.projectId,selected.runId,false));notice(p.allowed?'추가 허용은 해제했습니다. 현재 폴더의 PC 실행 동의는 설정에서 해제할 수 있습니다.':'다음 브라우저 미리보기 전에 다시 동의가 필요합니다.');}catch(error){notice(error.message,'error');}};
 return{render,open};
}
