import {digest} from './workspace.js';
import {deviceBinding} from './device-binding.js';
export function geometryChanges(before,after,tolerance=2){
 const old=new Map(before.map((r,i)=>[r.id?'#'+r.id:r.tag+':'+i,r]));const changes=[];
 for(const [i,row]of after.entries()){
  const key=row.id?'#'+row.id:row.tag+':'+i,previous=old.get(key);if(!previous){changes.push({element:key,type:'added'});continue;}old.delete(key);
  const deltas=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number((row[k]-previous[k]).toFixed(2))]));
  const styles=['font','fontSize','color','background'].filter(k=>row[k]!==previous[k]);
  if(Object.values(deltas).some(v=>Math.abs(v)>tolerance)||styles.length)changes.push({element:key,type:'changed',deltas,styles});
 }for(const key of old.keys())changes.push({element:key,type:'removed'});return changes.slice(0,100);
}
export function pixelChanges(nativeImage,before,after){
 const a=nativeImage.createFromBuffer(before),b=nativeImage.createFromBuffer(after),s=a.getSize(),t=b.getSize();if(s.width!==t.width||s.height!==t.height)return{resized:true,before:s,after:t};
 const x=a.toBitmap(),y=b.toBitmap();let changed=0;for(let i=0;i<x.length;i+=4)if([0,1,2,3].some(c=>Math.abs(x[i+c]-y[i+c])>8))changed++;
 return{changedPixels:changed,totalPixels:s.width*s.height,changedRatio:changed/(s.width*s.height),channelTolerance:8,note:'동일 크기 이미지의 픽셀 변화량이며 디자인 품질·유사도 점수가 아닙니다.'};
}
export class VisualRegression{
 constructor(workspace,store,nativeImage,identity=deviceBinding){Object.assign(this,{workspace,store,nativeImage,identity});this.queue=Promise.resolve();}
 async key(id,grantId,profile,referenceHash){return digest(JSON.stringify({id,grantId,profile,referenceHash,binding:await this.identity()}));}
 async approve(state,profileId){
  const item=state.visual?.evidence?.states?.find(row=>row.id===profileId);if(!item||state.visual.evidence.sourceHash!==(await this.workspace.snapshot(state.projectId)).hash)throw new Error('현재 소스의 화면 상태 캡처만 회귀 기준으로 승인할 수 있습니다.');
  const bytes=await this.workspace.read(state.projectId,item.image.path,{grantId:state.grantId,internal:true,maxBytes:16*1024*1024});if(digest(bytes)!==item.image.hash)throw new Error('상태 캡처가 변경됐습니다.');
  const key=await this.key(state.projectId,state.grantId,item.profile,state.design.hash);
  const operation=this.queue.then(async()=>{const rows=await this.store.read('visual-baselines',{});rows[key]={image:item.image,metrics:item.metrics,approvedAt:new Date().toISOString()};await this.store.write('visual-baselines',rows);});this.queue=operation.catch(()=>{});await operation;
 }
 async compare(id,grantId,profile,referenceHash,metrics,buffer){
  const row=(await this.store.read('visual-baselines',{}))[await this.key(id,grantId,profile,referenceHash)];if(!row)return{status:'unbaselined',summary:'이 뷰포트·상태에는 사용자가 승인한 회귀 기준이 없습니다.'};
  const bytes=await this.workspace.read(id,row.image.path,{grantId,internal:true,maxBytes:16*1024*1024});if(digest(bytes)!==row.image.hash)throw new Error('승인한 상태별 회귀 기준이 변경됐습니다.');
  const pixels=pixelChanges(this.nativeImage,bytes,buffer),layout=geometryChanges(row.metrics.dom,metrics.dom);
  return{status:pixels.resized||pixels.changedPixels||layout.length?'changed':'unchanged',pixels,layout,baseline:row.image,approvedAt:row.approvedAt};
 }
}
