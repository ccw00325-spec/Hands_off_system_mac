import {randomUUID} from 'node:crypto';
import {digest} from './workspace.js';
import {deviceBinding} from './device-binding.js';
import {secretFinding} from './secrets.js';
import {preferenceQuestion} from './autopilot-policy.js';
export class Autopilot{
 constructor(store,preferences,identity=deviceBinding){Object.assign(this,{store,preferences,identity});this.queue=Promise.resolve();}
 async enabled(){return(await this.preferences.get()).autopilotEnabled===true;}
 async scope(state){return{projectId:state.projectId,grantId:state.grantId,binding:await this.identity(),requestHash:digest(state.request)};}
 async list(projectId){const rows=await this.store.read('autopilot-rules',[]),binding=await this.identity();return rows.filter(r=>r.projectId===projectId&&r.binding===binding).map(({binding,...r})=>r);}
 async change(operation){const next=this.queue.then(async()=>{const rows=await this.store.read('autopilot-rules',[]),result=await operation(rows);await this.store.write('autopilot-rules',result.slice(-200));});this.queue=next.catch(()=>{});return next;}
 async rememberQuestions(state,decisions,ids){
  if(!Array.isArray(ids)||ids.length>8||ids.some(id=>typeof id!=='string'))throw new Error('기억할 질문을 확인하세요.');
  const scope=await this.scope(state),rules=[];
  for(const id of ids){const q=state.questions.find(q=>q.id===id),a=decisions.find(a=>a.id===id);if(!q||!a||!preferenceQuestion(q,state.questionSource)||secretFinding(a.value))throw new Error('취향 설정 질문만 자동 수락 규칙으로 저장할 수 있습니다. 권한·중요 결정은 항상 확인합니다.');rules.push({...scope,id:randomUUID(),type:'question',fingerprint:digest(JSON.stringify({prompt:q.prompt,options:q.options})),label:q.prompt.slice(0,400),answer:{kind:a.kind,value:a.value},createdAt:new Date().toISOString()});}
  await this.change(rows=>[...rows,...rules]);
 }
 async answers(state,questions){
  if(!await this.enabled())return[];const scope=await this.scope(state),rows=await this.store.read('autopilot-rules',[]),result=[];
  for(const q of questions){if(!preferenceQuestion(q,state.questionSource))continue;const hash=digest(JSON.stringify({prompt:q.prompt,options:q.options}));const rule=rows.findLast(r=>r.type==='question'&&Object.entries(scope).every(([k,v])=>r[k]===v)&&r.fingerprint===hash);if(rule&&(rule.answer.kind!=='option'||q.options.includes(rule.answer.value)))result.push({id:q.id,prompt:q.prompt,...rule.answer,ruleId:rule.id});}
  return result;
 }
 async designKey(state){return digest(JSON.stringify({spec:state.spec,format:state.design.format,hash:state.design.hash??digest(state.design.previewText??''),provider:state.design.provider}));}
 async rememberDesign(state){if(state.design?.status!=='approved')throw new Error('직접 승인한 시안만 규칙에 저장할 수 있습니다.');const scope=await this.scope(state),fingerprint=await this.designKey(state);await this.change(rows=>[...rows,{...scope,id:randomUUID(),type:'design',fingerprint,label:'같은 요청·명세·시안의 승인 재사용',createdAt:new Date().toISOString()}]);}
 async approvesDesign(state){if(!await this.enabled()||state.design?.status!=='ready')return false;const scope=await this.scope(state),fingerprint=await this.designKey(state);return(await this.store.read('autopilot-rules',[])).some(r=>r.type==='design'&&r.fingerprint===fingerprint&&Object.entries(scope).every(([k,v])=>r[k]===v));}
 async remove(projectId,id){const binding=await this.identity();await this.change(rows=>rows.filter(r=>!(r.projectId===projectId&&r.binding===binding&&(id===null||r.id===id))));}
}
