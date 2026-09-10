import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orcaRequest, type OrcaMetadata } from './helm-orca-transport';
import type { HelmOrcaScope, HelmOrcaConnection } from './helm-orca-service';
import { HelmOrcaPreflightError } from './helm-orca-errors';
const PIN='bf4e2705046cf9ef9c915929a9646da85717af07';
interface RuntimeEntry {child:ChildProcess;pending:Promise<HelmOrcaConnection>;controller:AbortController;waiters:number;ready:boolean}
/** One private runtime per canonical project/profile. No global Orca discovery or credential copying. */
export class HelmOrcaRuntime {
  private entries=new Map<string,RuntimeEntry>();private closed=false;
  constructor(private directory:string,private artifactDirectory:string,private env:Partial<NodeJS.ProcessEnv>={}){mkdirSync(directory,{recursive:true,mode:0o700});}
  /** Read-only packaging preflight; does not establish PTY/provider runtime readiness. */
  validateArtifacts(){
    try{
      const manifestPath=join(this.artifactDirectory,'helm-orca-build.json');
      const stat=lstatSync(manifestPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Invalid Orca artifact manifest');
      const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
      if(manifest.sourceRevision!==PIN||!Array.isArray(manifest.files)||manifest.files.length>4096||!['orcad.js','daemon-entry.js','parcel-watcher-process-entry.js'].every(p=>manifest.files.some((f:any)=>f?.path===p)))throw new Error('Pinned Orca artifact required');
      if(manifest.platform!==undefined&&manifest.platform!==process.platform||manifest.arch!==undefined&&manifest.arch!==process.arch)throw new Error('Orca artifact platform or architecture mismatch');
      const root=realpathSync(this.artifactDirectory),seen=new Set<string>();let bytes=0;
      for(const f of manifest.files){
        if(!f||typeof f.path!=='string'||f.path.length>2048||f.path.includes('\\')||f.path.split('/').some((p:string)=>!p||p==='.'||p==='..')||seen.has(f.path)||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error('Invalid Orca artifact manifest');
        seen.add(f.path);const p=join(root,f.path),file=lstatSync(p);bytes+=file.size;
        if(!realpathSync(p).startsWith(root+'/')||!file.isFile()||file.isSymbolicLink()||file.size>128*1024*1024||bytes>512*1024*1024||(f.bytes!==undefined&&f.bytes!==file.size)||createHash('sha256').update(readFileSync(p)).digest('hex')!==f.sha256)throw new Error('Orca artifact hash mismatch');
      }
      return {sourceRevision:PIN,files:seen.size,bytes,manifestSha256:createHash('sha256').update(readFileSync(manifestPath)).digest('hex')};
    }catch(e){throw new HelmOrcaPreflightError(e instanceof Error?e.message:'Invalid Orca artifact');}
  }
  async connect(scope:HelmOrcaScope,callerSignal:AbortSignal):Promise<HelmOrcaConnection>{
    if(this.closed)throw new Error('Orca runtime manager closed');callerSignal.throwIfAborted();
    const root=realpathSync(scope.root),key=createHash('sha256').update(JSON.stringify([root,scope.profile])).digest('hex');
    const existing=this.entries.get(key);if(existing)return this.waitForConnection(existing,callerSignal);
    this.validateArtifacts();
    const data=join(this.directory,key);mkdirSync(data,{recursive:true,mode:0o700});
    const metaPath=join(data,'orca-runtime.json');if(publicationExists(metaPath))throw new HelmOrcaPreflightError('Prior Orca runtime publication retained. Explicit recovery is required; no second runtime launched.');
    // Atomic across managers/processes, including the pre-publication interval. A
    // retained claim is never stolen on a clock/PID guess or merely because kill was sent.
    try{writeFileSync(join(data,'hades-runtime-owner.json'),JSON.stringify({sourceRevision:PIN,owner:randomUUID(),hostPid:process.pid,root,profile:scope.profile}),{flag:'wx',mode:0o600});}
    catch(e){throw new HelmOrcaPreflightError((e as NodeJS.ErrnoException).code==='EEXIST'?'Orca runtime startup is already claimed. Inspect the retained owner before recovery.':e instanceof Error?e.message:'Unable to claim Orca runtime');}
    const controller=new AbortController(),signal=controller.signal;
    const child=spawn(process.execPath,[join(this.artifactDirectory,'orcad.js'),'--json','--no-pairing','--bind','127.0.0.1','--port','0'],{cwd:this.artifactDirectory,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,...this.env,NODE_ENV:process.env.NODE_ENV,ORCA_USER_DATA_PATH:data},stdio:['ignore','ignore','ignore']});
    const abort=()=>child.kill('SIGTERM');signal.addEventListener('abort',abort,{once:true});
    let entry!:RuntimeEntry;
    const pending=(async()=>{
      let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});let meta:OrcaMetadata|undefined;
      for(let n=0;n<200;n++){signal.throwIfAborted();if(this.closed||exited)throw new Error('Orca exited before readiness');if(existsSync(metaPath)){const stat=lstatSync(metaPath);if(!stat.isFile()||stat.size>16384)throw new Error('Invalid Orca metadata');try{const m=JSON.parse(readFileSync(metaPath,'utf8'));if(m.pid===child.pid&&typeof m.runtimeId==='string'&&Array.isArray(m.transports))meta=m;}catch{}if(meta)break;}await new Promise(r=>setTimeout(r,100));}
      if(!meta)throw new Error('Orca did not publish owned runtime metadata');
      const pinned=meta;
      const call:HelmOrcaConnection['call']=async(method,params,options={})=>{if(this.closed||exited)throw new Error('Owned Orca runtime unavailable');const fresh=JSON.parse(readFileSync(metaPath,'utf8'));if(fresh.runtimeId!==pinned.runtimeId||fresh.pid!==child.pid)throw new Error('Orca runtime authority changed');return orcaRequest(pinned,method,params,options);};
      const status=await call('status.get',null,{signal});if(status.runtimeId!==meta.runtimeId||status.runtimeProtocolVersion!==3||!status.capabilities?.includes('orchestration.contract.v1'))throw new Error('Orca orchestration contract unavailable');
      // Bootstrap is deliberately not replayed after uncertain delivery. Orca owns every created resource.
      const bootstrap=join(data,'hades-bootstrap.json');if(existsSync(bootstrap))throw new Error('Coordinator bootstrap already retained; inspect before recovery');
      writeFileSync(bootstrap,JSON.stringify({state:'starting',root,profile:scope.profile}),{flag:'wx',mode:0o600});
      const repoResult=await call('repo.add',{path:root,kind:'git'},{signal});const repo=repoResult?.repo?.id;if(typeof repo!=='string')throw new Error('Invalid Orca repository receipt');
      const work=await call('worktree.create',{repo,name:'helm-coordinator-'+randomUUID().slice(0,8),runHooks:false,activate:false,clientMutationId:randomUUID()},{signal});
      const worktree=work?.worktree?.id;if(typeof worktree!=='string')throw new Error('Invalid Orca coordinator workspace receipt');
      const terminal=await call('terminal.create',{worktree,command:'/bin/cat',title:'Helm coordinator',focus:false,activate:false,presentation:'background',clientMutationId:randomUUID()},{signal});
      const coordinator=terminal?.terminal?.handle;if(typeof coordinator!=='string')throw new Error('Invalid Orca coordinator terminal receipt');
      const tmp=bootstrap+'.tmp';writeFileSync(tmp,JSON.stringify({state:'ready',root,profile:scope.profile,repo,worktree,coordinator,runtimeId:meta.runtimeId}),{mode:0o600});renameSync(tmp,bootstrap);
      entry.ready=true;return {runtimeId:meta.runtimeId,coordinator,repo,call};
    })().catch(e=>{abort();throw e;}).finally(()=>signal.removeEventListener('abort',abort));
    entry={child,pending,controller,waiters:0,ready:false};this.entries.set(key,entry);
    return this.waitForConnection(entry,callerSignal);
  }
  private waitForConnection(entry:RuntimeEntry,signal:AbortSignal):Promise<HelmOrcaConnection>{
    entry.waiters++;
    // One task withdrawing must not tear down a shared runtime another task is
    // still starting. Stop startup only after every waiting caller has left.
    return new Promise<HelmOrcaConnection>((resolve,reject)=>{
      const abort=()=>reject(signal.reason??new Error('Orca startup cancelled'));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      void entry.pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    }).finally(()=>{entry.waiters--;if(!entry.waiters&&!entry.ready)entry.controller.abort();});
  }
  close(){if(this.closed)return;this.closed=true;for(const entry of this.entries.values()){if(entry.ready)entry.child.kill('SIGTERM');else entry.controller.abort();}}
}

function publicationExists(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
