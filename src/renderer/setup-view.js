import {PROVIDERS,SLOT_IDS} from '../core/team.js';
const $=selector=>document.querySelector(selector),node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
export function createSetupView({open,install,login,model,saveTeam,close}){
 const dialog=$('#prerequisites-dialog'),accounts=$('#connections'),overview=node('section'),tools=node('section'),accountPane=node('section'),tabs=node('nav'),summary=node('div'),cards=node('div');
 overview.id='setup-overview';tools.id='setup-tools';accountPane.id='setup-accounts';tabs.className='setup-tabs';summary.className='setup-next';cards.id='setup-ai-cards';cards.className='setup-ai-cards';
 const heading=dialog.querySelector('header');heading.querySelector('h2').textContent='시작 준비';
 const original=[...dialog.children].filter(el=>el!==heading);tools.append(...original);accountPane.append(accounts.querySelector('.connection-content'),accounts.querySelector('footer'));
 const chooser=node('fieldset'),legend=node('legend','사용할 AI만 선택하세요'),choices=node('div'),apply=node('button','선택한 AI로 팀 구성');choices.className='action-row';apply.type='button';apply.id='setup-apply-team';
 chooser.append(legend,choices,node('p','이미 연결된 계정을 재사용합니다. AI 하나만 선택해도 두 역할에 나눠 사용할 수 있어요.'),apply);overview.append(chooser,summary,cards);
 const inputs=new Map();for(const [id,label]of Object.entries(PROVIDERS)){const l=node('label'),input=node('input');input.type='checkbox';input.value=id;input.dataset.setupProvider=id;l.append(input,document.createTextNode(' '+label));choices.append(l);inputs.set(id,input);}
 const buttons=new Map();let selectedTab='overview',state={},transient={},selectionDirty=false,lastTeam='',remaining=0,lastProject;
 for(const [id,label]of [['overview','전체 준비'],['tools','도구 설치'],['accounts','계정·모델']]){const button=node('button',label);button.type='button';button.dataset.setupTab=id;button.onclick=()=>select(id);buttons.set(id,button);tabs.append(button);}
 dialog.append(summary,tabs,overview,tools,accountPane);for(const input of inputs.values())input.onchange=()=>{selectionDirty=true;};
 function select(id){selectedTab=id;overview.hidden=id!=='overview';tools.hidden=id!=='tools';accountPane.hidden=id!=='accounts';for(const [key,b]of buttons){b.setAttribute('aria-pressed',String(key===id));}if(id==='accounts')accountPane.scrollTop=0;}
 const run=async(action,button)=>{button.disabled=true;try{await action();}catch(error){$('#setup-error').textContent=error.message;}finally{button.disabled=false;}};
 const error=node('p');error.id='setup-error';error.className='hint error';dialog.insertBefore(error,tabs);
 apply.onclick=()=>run(async()=>{
  const selected=[...inputs].filter(([,input])=>input.checked).map(([id])=>id);if(!selected.length)throw new Error('사용할 AI를 하나 이상 선택하세요.');
  const providers=selected.length===1?[selected[0],selected[0]]:selected;
  const team=providers.map((provider,index)=>({id:SLOT_IDS[index],provider,roles:index===0?['control','debug','review','test']:['debug','review','test']}));
  const feature=team.find(a=>a.id!=='gpt'&&a.provider==='grok')??team[1],ui=[...team].sort((a,b)=>['claude','gpt','gemini','grok'].indexOf(a.provider)-['claude','gpt','gemini','grok'].indexOf(b.provider))[0];feature.roles.push('feature');ui.roles.push('ui');team[1].roles.push('critic');
  await saveTeam(team);selectionDirty=false;await open('overview');
 },apply);
 function render(next){
  if(next.projectId&&next.projectId!==lastProject){selectionDirty=false;transient={};lastTeam='';lastProject=next.projectId;}state=next;const team=next.team??[],ids=[...new Set(team.map(a=>a.provider))],fingerprint=JSON.stringify(team);
  if(lastTeam!==fingerprint&&!selectionDirty){for(const [id,input]of inputs)input.checked=ids.includes(id);lastTeam=fingerprint;}
  cards.replaceChildren();const pending=[];
  for(const id of ids){
   const status={...next.connection?.[id],...(id==='gpt'&&next.connection?.gpt?.source==='codex'?next.connection?.codex:{}),...transient[id]},tool=next.report?.rows.find(r=>r.id===id),agent=team.find(a=>a.provider===id),name=PROVIDERS[id],card=node('article'),title=node('strong',name),description=node('p'),button=node('button');button.type='button';card.dataset.setupAi=id;
   const installed=id==='gpt'&&status.source==='api'||tool?.state==='ready'||!tool&&status.installed;
   const waiting=status.login?.waiting,needsModel=!agent?.modelId&&((id==='gpt'&&status.source==='api'&&!status.modelId)||['grok','gemini'].includes(id)&&!status.modelId);
   let action;
   if(!installed){description.textContent='공식 도구 설치가 필요해요.';button.textContent='공식 설치 안내';action=()=>{select('tools');install(id);};}
   else if(waiting){description.textContent=status.login.codeRequired?'브라우저 승인 코드를 계정·모델 화면에 입력하세요.':status.login.hasBrowserLink?'브라우저에서 공식 승인을 완료해 주세요.':'공식 로그인 주소를 준비하고 있어요.';button.textContent=status.login.codeRequired?'승인 코드 입력':status.login.hasBrowserLink?'브라우저 다시 열기':'계정 연결 상태 보기';action=()=>status.login.codeRequired||!status.login.hasBrowserLink?select('accounts'):login(id,true);}
   else if(!status.connected){description.textContent='설치됐어요. 이제 계정을 연결하세요.';button.textContent=name+'에 로그인';action=()=>login(id,false);}
   else if(needsModel){description.textContent='연결됐어요. 사용할 모델을 선택하세요.';button.textContent='모델 선택';action=()=>{select('accounts');model(id);};}
   else{description.textContent='사용 가능 ✓ · 기존 인증 재사용';button.textContent='연결·모델 설정';action=()=>{select('accounts');model(id);};card.dataset.ready='true';}
   button.onclick=()=>run(action,button);card.append(title,description,button);cards.append(card);if(card.dataset.ready!=='true')pending.push({text:name+' 연결 준비',action,button});
  }
  const missing=next.report?.rows.filter(r=>r.required&&r.state!=='ready')??[];
  for(const row of missing.filter(r=>!ids.includes(r.id)))pending.unshift({text:row.label+' 준비',action:()=>{select('tools');install(row.id);}});
  remaining=pending.length;summary.replaceChildren();const message=node('p',pending.length?`작업 시작까지 ${pending.length}단계 · 다음: ${pending[0].text}`:'필수 도구와 AI 연결 준비가 끝났어요. 입력한 요청으로 돌아가세요.'),nextButton=node('button',pending.length?'다음 단계 준비하기':'작업 화면으로 돌아가기');nextButton.type='button';nextButton.id='setup-next-action';nextButton.onclick=()=>pending.length?run(pending[0].action,nextButton):close();summary.append(message,nextButton);select(selectedTab);
 }
 return{render,select,get remaining(){return remaining;},event(event){const id=['auth','codex'].includes(event.type)?'gpt':event.type;if(!Object.hasOwn(PROVIDERS,id))return;transient[id]={...transient[id],...(event.login?{login:event.login}:{}),...(event.state==='connected'?{connected:true}:{}),...(['error','disconnected'].includes(event.state)?{connected:false}:{})};render(state);},settled(){transient={};}};
}
