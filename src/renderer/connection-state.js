export function mergeConnectionStatus(current,incoming,now=Date.now()){
 const result={...incoming};for(const id of ['codex','claude','grok','gemini','gpt']){
  if(id==='gpt'&&current?.gpt?.source!==incoming.gpt?.source)continue;
  if((current?.[id]?.authRevision??0)>(incoming[id]?.authRevision??0))result[id]={...incoming[id],...current[id]};
 }
 for(const id of ['codex','claude','grok','gemini','gpt'])if(result[id]?.connected===true&&Number.isFinite(result[id].checkedAt)&&now-result[id].checkedAt>15000)result[id]={...result[id],connected:false,state:'verification-needed'};
 if(result.gpt?.source==='codex')result.gpt={...result.gpt,connected:result.codex?.connected===true,authRevision:result.codex?.authRevision};return result;
}
