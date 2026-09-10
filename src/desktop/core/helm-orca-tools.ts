import type { Tool } from '../../hades/agent/tools';
export interface HelmOrcaToolInput { key:string; prompt:string; agent:'codex'|'claude'|'opencode'; model?:string }
export interface HelmOrcaToolScope {
 signal:AbortSignal; guard():void; canStart:boolean;
 readiness():unknown|Promise<unknown>;
 preflight():void|Promise<void>;
 /** Host persists the UUID + exact input fingerprint before returning, cap4; never refunds unknown. */
 reserve(input:HelmOrcaToolInput):string;
 owns(id:string):boolean;
 start(id:string,input:HelmOrcaToolInput):Promise<unknown>;
 status(id:string):Promise<unknown>;
 usage?(id:string,offset?:number):unknown|Promise<unknown>;
 read(id:string,cursor?:string|number):Promise<unknown>;
 reconcile(id:string):Promise<unknown>;
 stop(id:string):Promise<unknown>;
}
const obj=(text:string)=>{const v:unknown=JSON.parse(text);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Expected an object');return v as Record<string,unknown>;};
const keys=(value:Record<string,unknown>,allowed:string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('Unexpected field; project, profile and execution authority are fixed by this conversation');};
const string=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw new Error('Invalid bounded text');return v.trim();};
export function helmOrcaTools(scope:HelmOrcaToolScope):Tool[]{
 const guard=()=>{scope.signal.throwIfAborted();scope.guard();};
 const owned=(value:unknown)=>{const id=string(value,100);if(!scope.owns(id))throw new Error('This conversation does not own that Orca intent');return id;};
 const target=(v:Record<string,unknown>)=>{keys(v,['id']);return owned(v.id);};
 const wait=async<T>(operation:()=>Promise<T>|T)=>{guard();const result=await operation();guard();return result;};
 const tool=<T>(name:string,description:string,parse:(v:Record<string,unknown>)=>T,run:(v:T)=>Promise<unknown>):Tool=>({name,description,validate:input=>{try{parse(obj(input));}catch(e){return e instanceof Error?e.message:'Invalid Orca input';}},run:async input=>{try{guard();const value=parse(obj(input));return {ok:true,output:JSON.stringify(await run(value))};}catch(e){return {ok:false,output:e instanceof Error?e.message:'Orca operation failed; inspect retained intent before retrying'};}}});
 const tools=[
  tool('helm_orca_readiness','Inspect packaged Orca availability and your retained intent IDs/keys for recovery. JSON {}. Artifact validation does not prove runtime/provider authentication. Orca provider token/time caps are not enforced by this adapter; no spending measurement is available.',v=>{keys(v,[]);},async()=>wait(scope.readiness)),
  tool('helm_orca_status','Refresh only your retained Orca worker status. JSON {"id":string}. Ready means startup accepted; exited/needs_review is not verified coding work.',target,id=>wait(()=>scope.status(id))),
  tool('helm_orca_read','Read bounded output from your Orca worker. JSON {"id":string,"cursor"?:string|number}. A transcript or success claim does not certify changes.',v=>{keys(v,['id','cursor']);if(v.cursor!==undefined&&!(typeof v.cursor==='string'&&v.cursor.length<=2000)&&!(Number.isSafeInteger(v.cursor)&&Number(v.cursor)>=0))throw new Error('Invalid cursor');return {id:owned(v.id),cursor:v.cursor as string|number|undefined};},v=>wait(()=>scope.read(v.id,v.cursor))),
  tool('helm_orca_reconcile','Read durable receipt for your uncertain Orca intent. JSON {"id":string}. Does not replay dispatch; missing acknowledgement remains unknown.',target,id=>wait(()=>scope.reconcile(id))),
  tool('helm_orca_stop','Request stop for your Orca intent. Requires approval. JSON {"id":string}. Cancellation does not prove the provider process stopped; inspect the returned verdict.',target,id=>wait(()=>scope.stop(id))),
 ];
 if(scope.usage)tools.push(tool('helm_orca_usage','Read retained provider usage evidence for your Orca intent. JSON {"id":string,"offset"?:number}. Reports are partial observations, not billing totals or released reservations. Follow nextOffset for retained pages; unavailable or empty does not mean zero.',v=>{keys(v,['id','offset']);if(v.offset!==undefined&&(!Number.isSafeInteger(v.offset)||Number(v.offset)<0))throw new Error('Invalid usage offset');return {id:owned(v.id),offset:v.offset as number|undefined};},v=>wait(()=>scope.usage!(v.id,v.offset))));
 if(scope.canStart)tools.unshift(tool('helm_orca_start','Start actual Orca coding work in an isolated worktree. Requires approval. JSON {"key":string,"prompt":string,"agent":"codex"|"claude"|"opencode","model"?:string}. Reuse the SAME key and exact instructions after an uncertain result. Four allocations per conversation; unknown allocations are retained. Setup hooks disabled. This adapter does NOT enforce provider token/time caps or measure spend. No automatic merge, verification or retry.',v=>{keys(v,['key','prompt','agent','model']);const key=string(v.key,100);if(!/^[\w-]+$/.test(key))throw new Error('Choose a stable alphanumeric request key');if(!['codex','claude','opencode'].includes(String(v.agent)))throw new Error('Choose a supported Orca provider');const model=v.model===undefined?undefined:string(v.model,200);if(model?.startsWith('-'))throw new Error('Invalid model');return {key,prompt:string(v.prompt,20000),agent:v.agent as HelmOrcaToolInput['agent'],...(model?{model}:{})};},async input=>{
  await wait(scope.preflight);guard();const id=scope.reserve(input);guard();return wait(()=>scope.start(id,input));
 }));
 return tools;
}
