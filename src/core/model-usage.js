export function aggregateModels(usage){
 const models=new Map();for(const panel of Object.values(usage?.byPanel??{}))for(const row of Object.values(panel.models??{})){
  const key=JSON.stringify([row.provider,row.model,row.api]),total=models.get(key)??{provider:row.provider,model:row.model,api:row.api,calls:0,input:0,output:0,measured:0};
  for(const field of ['calls','input','output','measured'])total[field]+=row[field]??0;
  if(row.estimatedUsd!==undefined)total.estimatedUsd=(total.estimatedUsd??0)+row.estimatedUsd;models.set(key,total);
 }return [...models.values()];
}
export function modelUsageLabel(row){
 const tokens=row.measured?`입력 ${row.input.toLocaleString()} · 출력 ${row.output.toLocaleString()}`:'토큰 집계 대기·미지원';
 const money=row.estimatedUsd!==undefined?` · API 추정 $${row.estimatedUsd.toFixed(4)}`:row.api?' · 비용 미확인':' · CLI 구독 비용 미제공';
 return`${row.model||'CLI 기본 모델 · 실제 ID 미제공'} · ${tokens}${money} · ${row.calls}회${row.measured<row.calls?' (일부 미집계)':''}`;
}
