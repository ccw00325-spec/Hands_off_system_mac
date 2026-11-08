export function mergeConnectionStatus(current,incoming){
 const result={...incoming};for(const id of ['codex','claude','grok','gemini','gpt']){
  if(id==='gpt'&&current?.gpt?.source!==incoming.gpt?.source)continue;
  if((current?.[id]?.authRevision??0)>(incoming[id]?.authRevision??0))result[id]={...incoming[id],...current[id]};
 }
 if(result.gpt?.source==='codex')result.gpt={...result.gpt,connected:result.codex?.connected===true,authRevision:result.codex?.authRevision};return result;
}
