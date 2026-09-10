import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { helmEnv } from './helm-adapters.js';
import type { HelmCheck } from './helm-types.js';
import type { HelmIntegrationReview, HelmIntegrationScope } from './helm-integration.js';
export interface HelmSourceCheckResult extends HelmCheck { exitCode: number|null; output: string; truncated: boolean; error?: string }
export interface HelmSourceCheckReceipt {
 id:string;reviewId:string;runId:string;root:string;owner?:string;parentSession?:string;
 status:'running'|'passed'|'failed'|'cancelled'|'interrupted'|'stale';createdAt:number;finishedAt?:number;
 before:string;after?:string;checks:HelmCheck[];results:HelmSourceCheckResult[];error?:string;maxSeconds:number;
}
interface Host { review(id:string,scope:HelmIntegrationScope):HelmIntegrationReview;fingerprint(root:string):Promise<string> }
interface Live {controller:AbortController;done?:Promise<void>;interrupted?:boolean}
/** Commands are explicitly chosen trusted local execution, not an OS sandbox. */
export class HelmSourceChecks {
 private directory:string;private live=new Map<string,Live>();private starting=new Set<string>();private closed=false;private shutdown?:Promise<void>;
 constructor(dataDir:string,private host:Host,private emit:()=>void=()=>{}){
  this.directory=join(dataDir,'helm','source-checks');mkdirSync(this.directory,{recursive:true,mode:0o700});this.directory=realpathSync(this.directory);
  for(const receipt of this.all())if(receipt.status==='running'){receipt.status='interrupted';receipt.error='Hades restarted during source checks. No commands were replayed.';receipt.finishedAt=Date.now();this.save(receipt);}
 }
 hasActiveWork():boolean{return this.live.size>0||this.starting.size>0;}
 private all():HelmSourceCheckReceipt[]{return readdirSync(this.directory).filter(file=>/^[a-f0-9-]{36}\.json$/.test(file)).map(file=>JSON.parse(readFileSync(join(this.directory,file),'utf8')) as HelmSourceCheckReceipt);}
 private save(receipt:HelmSourceCheckReceipt):void{
  const target=join(this.directory,receipt.id+'.json'),temp=target+'.'+randomUUID(),fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(receipt));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,target);
  const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}try{this.emit();}catch{/* observer is not execution authority */}
 }
 private read(id:string,scope:HelmIntegrationScope):HelmSourceCheckReceipt{
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid source check identifier');
  const receipt=JSON.parse(readFileSync(join(this.directory,id+'.json'),'utf8')) as HelmSourceCheckReceipt;
  this.host.review(receipt.reviewId,scope);
  if(realpathSync(scope.root)!==receipt.root || scope.owner!==receipt.owner || scope.parentSession!==receipt.parentSession)throw new Error('Source check scope mismatch');return receipt;
 }
 async get(id:string,scope:HelmIntegrationScope):Promise<HelmSourceCheckReceipt>{
  const receipt=this.read(id,scope);
  if(receipt.status==='passed'){
   try{if(await this.host.fingerprint(receipt.root)!==receipt.after){receipt.status='stale';receipt.error='Source changed after these checks. Run fresh checks.';this.save(receipt);}}
   catch(error){receipt.status='stale';receipt.error='Source revision could not be verified: '+String(error);this.save(receipt);}
  }return receipt;
 }
 async list(reviewId:string,scope:HelmIntegrationScope):Promise<HelmSourceCheckReceipt[]>{this.host.review(reviewId,scope);return Promise.all(this.all().filter(receipt=>receipt.reviewId===reviewId).sort((a,b)=>b.createdAt-a.createdAt).map(receipt=>this.get(receipt.id,scope)));}
 async start(reviewId:string,scope:HelmIntegrationScope,checks:HelmCheck[],maxSeconds=300):Promise<HelmSourceCheckReceipt>{
  if(this.closed)throw new Error('Source checks are closed');
  if(this.live.size+this.starting.size>=4)throw new Error('Source checks can run four jobs at a time');
  if(!Number.isInteger(maxSeconds)||maxSeconds<1||maxSeconds>300)throw new Error('Choose a source check time limit of 1–300 seconds');
  if(!Array.isArray(checks)||!checks.length||checks.length>8||checks.some(check=>!check||typeof check.command!=='string'||!check.command.trim()||check.command.includes('\0')||check.command.length>1000||!Array.isArray(check.args)||check.args.length>100||check.args.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>10000)))throw new Error('Choose 1–8 bounded commands and argument arrays');
  const review=this.host.review(reviewId,scope);if(review.status!=='applied')throw new Error('Apply the reviewed changes before checking the source project');
  const root=realpathSync(scope.root);if(this.starting.has(root)||this.all().some(receipt=>receipt.root===root&&receipt.status==='running'))throw new Error('Source checks are already running for this project');
  if(this.all().length>=250)throw new Error('Source checks reached the 250 receipt limit');
  this.starting.add(root);
  try{
   const before=await this.host.fingerprint(root);if(this.closed)throw new Error('Source checks are closed');
   const receipt:HelmSourceCheckReceipt={id:randomUUID(),reviewId,runId:review.runId,root,owner:scope.owner,parentSession:scope.parentSession,status:'running',createdAt:Date.now(),before,checks:structuredClone(checks),results:[],maxSeconds};
   this.save(receipt);const live:Live={controller:new AbortController()};this.live.set(receipt.id,live);
   live.done=this.execute(receipt,live).catch(error=>{receipt.status='failed';receipt.error='Source check persistence failed: '+String(error);try{this.save(receipt);}catch{}}).finally(()=>this.live.delete(receipt.id));
   return structuredClone(receipt);
  }finally{this.starting.delete(root);}
 }
 private async execute(receipt:HelmSourceCheckReceipt,live:Live):Promise<void>{
  const deadline=Date.now()+receipt.maxSeconds*1000;
  try{
   for(const check of receipt.checks){
    if(live.controller.signal.aborted)break;
    const remaining=deadline-Date.now();if(remaining<=0){receipt.error='Source check time limit reached';break;}
    const result=await this.command(check,receipt.root,live.controller.signal,remaining);receipt.results.push(result);this.save(receipt);
    if(result.exitCode!==0||result.error){receipt.error=result.error??'A source check failed';break;}
   }
   if(receipt.status==='running'){
    receipt.after=await this.host.fingerprint(receipt.root);
    if(live.controller.signal.aborted){receipt.status=live.interrupted?'interrupted':'cancelled';receipt.error=live.interrupted?'Hades closed during source checks':'Source checks cancelled';}
    else if(receipt.after!==receipt.before){receipt.status='stale';receipt.error='Source changed while checks ran. Review it and run fresh checks.';}
    else receipt.status=receipt.results.length===receipt.checks.length&&receipt.results.every(result=>result.exitCode===0&&!result.error)?'passed':'failed';
   }
  }catch(error){if(receipt.status==='running'){receipt.status=live.controller.signal.aborted?(live.interrupted?'interrupted':'cancelled'):'failed';receipt.error=String(error);}}
  receipt.finishedAt=Date.now();this.save(receipt);
 }
 async cancel(id:string,scope:HelmIntegrationScope):Promise<HelmSourceCheckReceipt>{const receipt=this.read(id,scope),live=this.live.get(id);if(live){live.controller.abort();await live.done;}return this.get(receipt.id,scope);}
 close():Promise<void>{
  if(this.shutdown)return this.shutdown;
  this.closed=true;
  // Process revocation must not depend on disk availability or readable receipts.
  for(const live of this.live.values()){live.interrupted=true;live.controller.abort();}
  let checkpointFailed=false;
  for(const [id]of this.live){try{const receipt=this.all().find(item=>item.id===id);if(receipt){receipt.status='interrupted';receipt.error='Hades closed during source checks';this.save(receipt);}}catch{checkpointFailed=true;}}
  this.shutdown=Promise.allSettled([...this.live.values()].map(live=>live.done)).then(()=>{if(checkpointFailed)throw new Error('Source checks stopped but the interruption checkpoint could not be saved');});
  void this.shutdown.catch(()=>{});return this.shutdown;
 }

 private command(check:HelmCheck,root:string,signal:AbortSignal,timeout:number):Promise<HelmSourceCheckResult>{
  return new Promise(resolve=>{
   let output='',truncated=false,error:string|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
   const env=helmEnv({...process.env,PWD:root,INIT_CWD:root});for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete (env as NodeJS.ProcessEnv)[key];
   const child=spawn(check.command,check.args,{cwd:root,env,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
   const force=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
   const kill=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}if(!killTimer)killTimer=setTimeout(force,250);};
   const watchdog=process.platform==='win32'||!child.pid?undefined:spawn(process.execPath,['-e',`const group=Number(process.argv[1]);const stop=()=>{try{process.kill(-group,'SIGKILL')}catch{}process.exit(0)};process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();`,String(child.pid)],{cwd:this.directory,env,detached:true,stdio:['pipe','ignore','ignore']});
   watchdog?.unref();watchdog?.stdin?.on('error',()=>{});watchdog?.on('error',()=>{error='Source check process watchdog failed';kill();});
   const abort=()=>{error='Source checks cancelled';kill();},timer=setTimeout(()=>{error='Source check time limit reached';kill();},timeout);
   const append=(chunk:Buffer)=>{output+=chunk.toString('utf8');if(output.length>200000){output=output.slice(-200000);truncated=true;}};
   child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',event=>{error=event.message;});
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   child.on('close',exitCode=>{force();watchdog?.stdin?.end();watchdog?.kill();clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',abort);resolve({...check,exitCode,output,truncated,...(error?{error}:{})});});
  });
 }
}
