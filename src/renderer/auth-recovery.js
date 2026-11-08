import {PROVIDERS} from '../core/team.js';
export function recoveryActions(agent,{login,change}){
 const box=document.createElement('section');box.className='auth-recovery';box.dataset.authRecovery=agent.id;box.setAttribute('aria-label',PROVIDERS[agent.provider]+' 로그인 복구');
 const text=document.createElement('p');text.textContent=PROVIDERS[agent.provider]+' 로그인이 필요하거나 연결을 확인하지 못했습니다.';const actions=document.createElement('div');actions.className='action-row';
 for(const [action,label,callback]of [['login','로그인 페이지로 이동',login],['change','AI 바꾸기',change]]){const b=document.createElement('button');b.type='button';b.dataset.authAction=action;b.textContent=label;b.onclick=()=>callback(agent.id);actions.append(b);}if(agent.provider==='grok'){const source=document.createElement('small');source.textContent='Grok 모델은 Cursor Agent 계정으로 실행합니다. grok.com 웹 로그인과 별개입니다.';box.append(source);}box.append(text,actions);return box;
}
