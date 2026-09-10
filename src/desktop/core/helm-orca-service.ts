import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HelmOrcaPreflightError } from './helm-orca-errors';
export interface HelmOrcaScope { root: string; profile: string }
export interface HelmOrcaConnection {
  runtimeId: string; coordinator: string; repo: string;
  call(method: string, params: unknown, options?: { requestId?: string; signal?: AbortSignal }): Promise<any>;
}
export interface HelmOrcaInput { requestId: string; prompt: string; agent: 'codex'|'claude'|'opencode'; model?: string }
export interface HelmOrcaRecord extends HelmOrcaScope {
  id: string; fingerprint: string; input: HelmOrcaInput; state: 'starting'|'ready'|'failed'|'unknown'|'stopping'|'stopped'|'needs_review';
  active: boolean; revision: number;
  stage: 'connect'|'run'|'dispatch'|'stop'; runtimeId?: string; runId?: string; dispatchId?: string; requestId: string; error?: string; receipt?: unknown;
}
const coordinatorQueues=new Map<string,Promise<void>>();
async function reserveCoordinator(key:string,signal:AbortSignal){
  const previous=coordinatorQueues.get(key)??Promise.resolve();let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),current=previous.then(()=>gate);
  coordinatorQueues.set(key,current);
  void current.then(()=>{if(coordinatorQueues.get(key)===current)coordinatorQueues.delete(key);});
  try{
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??new Error('Orca startup cancelled'));};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      void previous.then(()=>{signal.removeEventListener('abort',abort);resolve();});
    });signal.throwIfAborted();
  }catch(error){release();throw error;}
  return release;
}
/** Owns Hades intent, never Orca's worktree/worker state. Unknown mutations are read-reconciled only. */
export class HelmOrcaService {
  private live = new Map<string, AbortController>(); private settling = new Map<string,Promise<void>>(); private closed = false; private db:DatabaseSync;
  private operations = new Set<Promise<unknown>>();
  private stopping = new Map<string, Promise<HelmOrcaRecord>>();
  private shutdown?: Promise<void>;
  constructor(private directory: string, private options: { connect(scope: HelmOrcaScope, signal: AbortSignal): Promise<HelmOrcaConnection> }) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(readdirSync(directory).some(f=>f.endsWith('.json')||f.endsWith('.claim')))throw new Error('Legacy Orca intent files require explicit migration; no records changed');
    this.db=new DatabaseSync(join(directory,'intents.sqlite'));chmodSync(join(directory,'intents.sqlite'),0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,active INTEGER NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);");
  }
  private rows():HelmOrcaRecord[]{return (this.db.prepare('SELECT payload,revision FROM attempts').all() as Array<{payload:string;revision:number}>).map(r=>({...JSON.parse(r.payload),revision:r.revision}));}
  private scope(s:HelmOrcaScope){if(typeof s.profile!=='string'||!s.profile.trim()||s.profile.length>100||s.profile.includes('\0'))throw new Error('Invalid profile');return {root:realpathSync(s.root),profile:s.profile};}
  private cancelled(id:string){return (this.db.prepare('SELECT cancel_requested FROM attempts WHERE id=?').get(id) as {cancel_requested:number}|undefined)?.cancel_requested===1;}
  private save(r:HelmOrcaRecord){
    if(this.cancelled(r.id)&&r.active&&r.state!=='stopped'&&r.state!=='stopping'){r.state='unknown';r.error='Cancellation requested; provider termination is unconfirmed. Inspect retained dispatch.';}
    const changed=this.db.prepare('UPDATE attempts SET payload=?,active=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(r),r.active?1:0,r.id,r.revision).changes;
    if(changed!==1)throw new Error('Orca intent revision changed; inspect before continuing');r.revision++;
  }
  list(s:HelmOrcaScope){const scope=this.scope(s);return this.rows().filter(r=>r.root===scope.root&&r.profile===scope.profile).map(r=>{if((r.state==='starting'||r.state==='stopping')&&!this.live.has(r.id)){r.state='unknown';r.error='This host cannot confirm the in-flight owner; reconcile retained intent.';}return r;});}
  get(s:HelmOrcaScope,id:string){const r=this.list(s).find(r=>r.id===id);if(!r)throw new Error('Orca task not owned by this project/profile');return r;}
  private async connection(r:HelmOrcaRecord,signal:AbortSignal){if(this.closed)throw new Error('Orca service closed');signal.throwIfAborted();const c=await this.options.connect(r,signal);signal.throwIfAborted();if(r.runtimeId&&c.runtimeId!==r.runtimeId)throw new Error('Orca runtime authority changed; manual reconciliation required');return c;}
  private operation<T>(body:()=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Orca service closed'));
    const pending=body();this.operations.add(pending);
    return pending.finally(()=>this.operations.delete(pending));
  }
  start(s:HelmOrcaScope,input:HelmOrcaInput,signal?:AbortSignal):Promise<HelmOrcaRecord>{
    return this.operation(()=>this.startOwned(s,input,signal));
  }
  private async startOwned(s:HelmOrcaScope,input:HelmOrcaInput,signal?:AbortSignal):Promise<HelmOrcaRecord>{
    if(this.closed)throw new Error('Orca service closed');
    // No intent or capacity is consumed when the caller has already withdrawn the request.
    signal?.throwIfAborted();
    const scope=this.scope(s);
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.requestId)||!['codex','claude','opencode'].includes(input.agent)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000||input.prompt.includes('\0')||(input.model!==undefined&&(typeof input.model!=='string'||!input.model.trim()||input.model.length>200||input.model.includes('\0')||input.model.startsWith('-'))))throw new Error('Invalid Orca task');
    const fingerprint=createHash('sha256').update(JSON.stringify([scope,input])).digest('hex');
    const prior=this.rows().find(r=>r.id===input.requestId);if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Request identity conflict');return this.get(scope,prior.id);}
    
    const r:HelmOrcaRecord={...scope,id:input.requestId,fingerprint,input:structuredClone(input),state:'starting',stage:'connect',requestId:randomUUID(),active:true,revision:0};
    // Atomic durable admission across processes. Unknown/ready workers never age out of capacity.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.rows().find(x=>x.id===r.id);if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Request identity conflict');this.db.exec('COMMIT');return this.get(scope,prior.id);}
      const count=(this.db.prepare('SELECT count(*) AS n FROM attempts WHERE active=1').get() as {n:number}).n;
      if(count>=4)throw new Error('Four Orca workers are active or uncertain; inspect or stop one before starting more');
      this.db.prepare('INSERT INTO attempts(id,payload,active) VALUES(?,?,1)').run(r.id,JSON.stringify(r));this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    let settled!:()=>void;this.settling.set(r.id,new Promise<void>(resolve=>{settled=resolve;}));
    const controller=new AbortController();this.live.set(r.id,controller);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let releaseCoordinator:(()=>void)|undefined;
    try {
      const c=await this.connection(r,controller.signal);r.runtimeId=c.runtimeId;releaseCoordinator=await reserveCoordinator(c.runtimeId+':'+c.coordinator,controller.signal);controller.signal.throwIfAborted();if(this.cancelled(r.id))throw new Error('Cancellation requested');r.stage='run';this.save(r);
      const created=await c.call('orchestration.runCreate',{objective:input.prompt,from:c.coordinator},{requestId:r.requestId,signal:controller.signal});
      if(typeof created?.run?.id!=='string')throw new Error('Malformed Orca Run receipt');r.runId=created.run.id;
      controller.signal.throwIfAborted();if(this.cancelled(r.id))throw new Error('Cancellation requested');r.stage='dispatch';r.requestId=randomUUID();this.save(r);
      const result=await c.call('orchestration.workerStart',{spec:input.prompt,agent:input.agent,...(input.model?{model:input.model}:{}),run:r.runId,from:c.coordinator,repo:c.repo,worktree:'new-top-level',setup:'skip',timeoutMs:30000},{requestId:r.requestId,signal:controller.signal});
      this.accept(r,result);
    }catch(e){
      r.state='unknown';r.error=e instanceof Error?e.message:'Orca outcome unknown';
      if(e instanceof HelmOrcaPreflightError){r.state='failed';r.active=false;}
      else if(controller.signal.aborted&&r.stage!=='dispatch'){
        // Bootstrap/run records may exist, but no workerStart was submitted.
        r.state='stopped';r.active=false;r.error='Cancelled before worker dispatch.';
      }
    }finally{releaseCoordinator?.();try{this.save(r);}finally{this.live.delete(r.id);signal?.removeEventListener('abort',abort);settled();this.settling.delete(r.id);}}
    return structuredClone(r);
  }
  private accept(r:HelmOrcaRecord,result:any){r.receipt=result;if(typeof result?.dispatchId==='string')r.dispatchId=result.dispatchId;r.state=result?.state==='ready'&&r.dispatchId?'ready':result?.state==='failed'?'failed':'unknown';}
  recover(s:HelmOrcaScope,id:string){return this.operation(()=>this.recoverOwned(s,id));}
  private async recoverOwned(s:HelmOrcaScope,id:string){
    const r=this.get(s,id);
    // A connect-stage intent has no submitted orchestration request. Looking up
    // its UUID must not bootstrap a runtime under the guise of reconciliation.
    if(this.live.has(id)||r.stage==='connect')return r;
    const c=await this.connection(r,new AbortController().signal);const result=await c.call('orchestration.requestShow',{request:r.requestId});
    if(result?.requestId!==r.requestId)throw new Error('Mismatched reconciliation receipt');
    if(result.state==='completed'&&result.method==='orchestration.runCreate'&&r.stage==='run'&&typeof result.receipt?.run?.id==='string'){
      r.runId=result.receipt.run.id;r.state='failed';r.active=false;r.receipt=result.receipt;r.error='The run was created but no worker was dispatched. Inspect it before allocating new work.';
    }
    if(result.state==='completed'&&result.method==='orchestration.workerStart'&&r.stage==='dispatch'){this.accept(r,result.receipt);}
    if(result.state==='completed'&&result.method==='orchestration.workerStop'&&r.stage==='stop'&&result.receipt?.dispatchId===r.dispatchId&&result.receipt?.state==='stopped'){r.state='stopped';r.active=false;}
    this.save(r);return r;
  }
  read(s:HelmOrcaScope,id:string,cursor?:string|number){return this.operation(async()=>{const r=this.get(s,id);if(!r.dispatchId)throw new Error('No acknowledged dispatch');const c=await this.connection(r,new AbortController().signal);return c.call('orchestration.workerRead',{dispatch:r.dispatchId,source:'auto',limit:16000,...(cursor!==undefined?{cursor}:{})});});}
  status(s:HelmOrcaScope,id:string){return this.operation(()=>this.statusOwned(s,id));}
  private async statusOwned(s:HelmOrcaScope,id:string){
    const r=this.get(s,id);if(!r.dispatchId) return r;
    const c=await this.connection(r,new AbortController().signal),result=await c.call('orchestration.workerShow',{dispatch:r.dispatchId});
    if(result?.dispatch?.id!==r.dispatchId)throw new Error('Mismatched worker observation');
    r.receipt=result;
    if(result.observation?.exactWorker===true&&result.observation.status==='exited'){r.active=false;r.state='needs_review';r.error='Worker process exited; independent change verification is still required.';}
    else if(result.observation?.exactWorker!==true||result.observation.status!=='live'){r.state='unknown';r.error='Worker liveness/identity is unconfirmed';}
    // A completed report with a still-live terminal does not release worker admission.
    this.save(r);return r;
  }
  stop(s:HelmOrcaScope,id:string){
    // Verify scope before joining an existing operation so another profile cannot observe it.
    if(this.closed)return Promise.reject(new Error('Orca service closed'));
    try{this.get(s,id);}catch(e){return Promise.reject(e);}
    const prior=this.stopping.get(id);if(prior)return prior;
    const pending=this.operation(()=>this.stopOwned(s,id));this.stopping.set(id,pending);
    void pending.finally(()=>{if(this.stopping.get(id)===pending)this.stopping.delete(id);}).catch(()=>{});
    return pending;
  }
  private async stopOwned(s:HelmOrcaScope,id:string){
    let r=this.get(s,id);if(!r.active)return r;
    if(this.live.has(id)||!r.dispatchId&&r.active&&r.stage!=='stop'){
      this.db.prepare('UPDATE attempts SET cancel_requested=1 WHERE id=?').run(id);this.live.get(id)?.abort();
      const pending=this.settling.get(id);if(pending)await pending;
      r=this.get(s,id);
      if(!r.active)return r;
      if(!r.dispatchId){
        if(!pending){r.state='unknown';r.error='Startup cancellation recorded for owning host; termination is unconfirmed.';this.save(r);}
        return r;
      }
      // The original Stop authorizes this exact dispatch. A late startup receipt must
      // complete that request, without forcing the user to click Stop a second time.
    }
    if(!r.dispatchId||r.stage==='stop'&&(r.state==='unknown'||r.state==='stopping'))throw new Error('Reconcile uncertain dispatch before stop');
    const c=await this.connection(r,new AbortController().signal);
    r.state='stopping';r.stage='stop';r.requestId=randomUUID();this.save(r);
    try{r.receipt=await c.call('orchestration.workerStop',{dispatch:r.dispatchId},{requestId:r.requestId});const receipt=r.receipt as any;r.state=receipt?.dispatchId===r.dispatchId&&receipt?.state==='stopped'?'stopped':'unknown';if(r.state==='stopped')r.active=false;else r.error='Stop outcome is uncertain; inspect the retained receipt.';}catch(e){r.state='unknown';r.error=String(e);}this.save(r);return r;
  }
  hasActiveWork(){return this.live.size>0||(this.db.prepare('SELECT count(*) AS n FROM attempts WHERE active=1').get() as {n:number}).n>0;}
  close(){
    if(this.shutdown)return this.shutdown;
    this.closed=true;for(const c of this.live.values())c.abort();
    // Stop/status/recovery can also have receipts in flight. Keep storage open until
    // every admitted operation has persisted its result, not just startup operations.
    this.shutdown=Promise.allSettled([...this.operations]).then(()=>{this.db.close();});
    return this.shutdown;
  }
}
