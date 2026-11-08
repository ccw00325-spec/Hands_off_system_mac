// Authentication probes never run model inference. A failed/stale probe is not
// evidence of a usable login; an authentication rejection requires re-login.
export class ConnectionHealth {
 constructor(probes,notify=()=>{},now=()=>Date.now()){Object.assign(this,{probes,notify,now});this.rows=new Map();this.pending=new Map();this.epochs=new Map();this.rejected=new Set();this.revisions=new Map();}
 view(id,fallback={}){const row=this.rows.get(id);if(!row)return fallback;const stale=this.now()-row.checkedAt>15000;if(stale&&!row.staleMarked){row.staleMarked=true;this.revisions.set(id,(this.revisions.get(id)??0)+1);}return{...row.value,...fallback,connected:row.value.connected===true&&fallback.installed!==false&&fallback.connected!==false,state:row.value.state,login:fallback.login??row.value.login,checkedAt:row.checkedAt,authRevision:this.revisions.get(id)??0,...(stale?{connected:false,state:'verification-needed'}:{}),...(this.rejected.has(id)?{connected:false,state:'authentication-required'}:{})};}
 seed(id,value){if(!this.rows.has(id)){this.revisions.set(id,(this.revisions.get(id)??0)+1);this.rows.set(id,{value:{...value},checkedAt:this.now()});}return this.view(id,value);}
 invalidate(id){this.revisions.set(id,(this.revisions.get(id)??0)+1);this.epochs.set(id,(this.epochs.get(id)??0)+1);this.rejected.add(id);this.rows.set(id,{checkedAt:this.now(),value:{connected:false,state:'authentication-required'}});this.emit(id);}
 release(id){this.epochs.set(id,(this.epochs.get(id)??0)+1);this.rejected.delete(id);this.rows.delete(id);const pending=this.pending.get(id);if(pending)void pending.finally(()=>this.check(id));else void this.check(id);}
 emit(id){this.notify({type:'connection-health',provider:id,value:this.view(id)});}
 check(id){if(this.pending.has(id))return this.pending.get(id);const epoch=this.epochs.get(id)??0;const task=(async()=>{let value;try{value=await this.probes[id]();if(!value||typeof value.connected!=='boolean')throw Error('Unverified login');}catch{value={connected:false,state:'verification-failed'};}if((this.epochs.get(id)??0)===epoch){this.revisions.set(id,(this.revisions.get(id)??0)+1);this.rows.set(id,{value,checkedAt:this.now()});this.emit(id);}return this.view(id);})().finally(()=>this.pending.delete(id));this.pending.set(id,task);return task;}
 poll(){for(const id of Object.keys(this.probes)){this.emit(id);void this.check(id);}}
 start(){if(!this.timer){this.poll();this.timer=setInterval(()=>this.poll(),10000);this.timer.unref?.();}}
 stop(){clearInterval(this.timer);this.timer=null;}
}
