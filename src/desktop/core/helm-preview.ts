import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HadesBrowserClient } from './hades-browser-client.js';
import type { HelmIntegrationScope } from './helm-integration.js';
export interface HelmPreviewContext {workspaceId:string;profile:string;sourceRevision:string}
export interface HelmPreviewReceipt {id:string;runId:string;sourceCheckId:string;root:string;owner?:string;parentSession?:string;workspaceId:string;profile:string;sourceRevision:string;url:string;digest:string;browserRunId:string;status:'opening'|'opened'|'failed'|'unknown';createdAt:number;tabId?:string;error?:string}
interface Host {
 /** Must resolve owned Helm run, passed CURRENT source check, and original notebook space. */
 context(runId:string,sourceCheckId:string,scope:HelmIntegrationScope):Promise<HelmPreviewContext>;
 client(profile:string):Pick<HadesBrowserClient,'emit'|'call'>;
}
export function helmPreviewUrl(value:string):string{
 if(typeof value!=='string'||value.length>4000||value.includes('\0'))throw new Error('Provide a local preview URL');
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.username||url.password)throw new Error('Preview must use HTTP(S) localhost, 127.0.0.1 or [::1] with an explicit port and no credentials');
 return url.href;
}
/** Opens once through the existing paired Browser task policy. No server launch or health probe. */
export class HelmPreview {
 private directory:string;
 constructor(dataDir:string,private host:Host){this.directory=join(dataDir,'helm','previews');mkdirSync(this.directory,{recursive:true,mode:0o700});this.directory=realpathSync(this.directory);for(const receipt of this.all())if(receipt.status==='opening'){receipt.status='unknown';receipt.error='Hades restarted before preview acknowledgement. Inspect Browser; this request will not be replayed.';this.save(receipt);}}
 private all():HelmPreviewReceipt[]{return readdirSync(this.directory).filter(file=>/^[a-f0-9-]{36}\.json$/.test(file)).map(file=>JSON.parse(readFileSync(join(this.directory,file),'utf8')) as HelmPreviewReceipt);}
 private save(receipt:HelmPreviewReceipt):void{const path=join(this.directory,receipt.id+'.json'),temp=path+'.'+randomUUID(),fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(receipt));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 get(id:string,scope:HelmIntegrationScope):HelmPreviewReceipt{
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid preview identifier');const receipt=JSON.parse(readFileSync(join(this.directory,id+'.json'),'utf8')) as HelmPreviewReceipt;
  if(realpathSync(scope.root)!==receipt.root||scope.owner!==receipt.owner||scope.parentSession!==receipt.parentSession)throw new Error('Preview scope mismatch');return receipt;
 }
 list(runId:string,scope:HelmIntegrationScope):HelmPreviewReceipt[]{return this.all().filter(receipt=>receipt.runId===runId&&receipt.root===realpathSync(scope.root)&&receipt.owner===scope.owner&&receipt.parentSession===scope.parentSession).map(receipt=>this.get(receipt.id,scope)).sort((a,b)=>b.createdAt-a.createdAt);}
 async open(requestId:string,runId:string,sourceCheckId:string,scope:HelmIntegrationScope,value:string):Promise<HelmPreviewReceipt>{
  if(!/^[a-f0-9-]{36}$/.test(requestId))throw new Error('Invalid preview identifier');
  const url=helmPreviewUrl(value),root=realpathSync(scope.root),digest=createHash('sha256').update(JSON.stringify({runId,sourceCheckId,root,owner:scope.owner,parentSession:scope.parentSession,url})).digest('hex');
  const existing=join(this.directory,requestId+'.json');
  if(existsSync(existing)){const receipt=this.get(requestId,scope);if(receipt.digest!==digest)throw new Error('Preview identifier already belongs to another request');return receipt;}
  const context=await this.host.context(runId,sourceCheckId,scope);
  if(!context.workspaceId||context.workspaceId.length>128||context.profile!==scope.owner||!context.sourceRevision)throw new Error('Preview context is not bound to this project, profile and original Browser space');
  if(this.all().length>=250)throw new Error('Preview receipt limit reached');
  const client=this.host.client(context.profile),browserRunId='helm-preview-'+requestId;
  const receipt:HelmPreviewReceipt={id:requestId,runId,sourceCheckId,root,owner:scope.owner,parentSession:scope.parentSession,...context,url,digest,browserRunId,status:'opening',createdAt:Date.now()};
  let lock:number;try{lock=openSync(join(this.directory,requestId+'.claim'),'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Preview request already claimed. Inspect its retained outcome; do not replay.');throw error;}
  try{writeFileSync(lock,digest);fsyncSync(lock);}finally{closeSync(lock);}
  this.save(receipt);
  let started=false;
  try{
   client.emit(context.profile,'task.started',{runId:browserRunId,title:'Open Helm local preview',workspaceId:context.workspaceId,task:{goal:'Open the explicitly requested local preview',workspaceId:context.workspaceId,plan:[{id:'open',text:'Open local preview',status:'pending'}],budget:{maxTokens:1000,maxDurationMs:30000},allowedOrigins:[new URL(url).origin],readOnly:true}});started=true;
   const result=await client.call(context.profile,'browser.openTab',{url,workspaceId:context.workspaceId,background:false},{runId:browserRunId,signal:AbortSignal.timeout(30000)});
   if(!result.ok){receipt.status='unknown';receipt.error=result.error?.message??'Browser refused the preview';}
   else{
    const tab=(result.value as {tab?:{id?:unknown;workspaceId?:unknown}}|undefined)?.tab;
    if(typeof tab?.id!=='string'||!tab.id||tab.workspaceId!==context.workspaceId)throw new Error('Browser returned an unconfirmed preview target');
    receipt.status='opened';receipt.tabId=tab.id;
   }
   this.save(receipt);
  }catch(error){receipt.status='unknown';receipt.error='Preview outcome unconfirmed. Inspect Browser before another action. '+String(error);this.save(receipt);}
  finally{if(started)try{client.emit(context.profile,'task.finished',{runId:browserRunId,status:receipt.status==='opened'?'done':'failed',summary:receipt.status==='opened'?'Local preview tab created. Page behavior has not been verified.':receipt.error??'Preview not confirmed',artifacts:receipt.tabId?[{kind:'tab',id:receipt.tabId,label:'Helm local preview',url}]:[]});}catch{/* Retain the actual open acknowledgement independently of task event delivery. */}}
  return receipt;
 }
}
