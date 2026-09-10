// Independent negative cases; reusable isolated Git/offline Workbench fixture adapted from root author suite.
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchService } from '../core/workbench-service';
import type { WorkExecution, WorkGoal } from '../core/durable-work';
vi.mock('../core/webhook-service',async()=>({WebhookService:(await import('./fixtures/offline-webhooks')).OfflineWebhookFixture}));
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
const sha=(data:string)=>createHash('sha256').update(data).digest('hex');
const checks=[{command:process.execPath,args:['--test','sum.test.cjs']}];
async function fixture(){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'work-orca-acceptance-'))),root=join(home,'source'),workspace=join(home,'orca-worker'),data=join(home,'data');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString();
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'sum.cjs'),'exports.sum=(a,b)=>a-b;\n');
  writeFileSync(join(root,'sum.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');const {sum}=require('./sum.cjs');test('adds signed values',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,4),2);assert.equal(sum(0,0),0);});\n");
  git('add','.');git('commit','-m','fixture');
  const service=new WorkbenchService(data,()=>{},{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'});
  cleanups.push(async()=>{await service.close();rmSync(home,{recursive:true,force:true});});
  await service.dispatch('project.add',{path:root});
  const host=service as any;host.preflightWorkOrca=()=>{};let base='',starts=0,live=false,childCalls=0;
  host.helmOrca.options.connect=async()=>({runtimeId:'fixture-runtime',coordinator:'coordinator',repo:'fixture-repo',call:async(method:string,p:any)=>{
    if(method==='orchestration.runCreate')return {run:{id:'orca-run'}};
    if(method==='orchestration.workerStart'){starts++;base=p.baseBranch;git('worktree','add','--detach',workspace,base);writeFileSync(join(workspace,'sum.cjs'),'exports.sum=(a,b)=>a+b;\n');return {state:'ready',dispatchId:'dispatch'};}
    if(method==='orchestration.workerShow')return {dispatch:{id:'dispatch'},worker:{dispatchId:'dispatch',runtimeEpoch:'fixture-runtime',worktreeId:'orca-tree',startOptions:{baseBranch:base}},observation:{exactWorker:true,status:live?'live':'exited'}};
    if(method==='worktree.show')return {worktree:{id:'orca-tree',repoId:'fixture-repo',git:{path:workspace}}};
    if(method==='orchestration.requestShow')return {requestId:p.request,state:'completed',method:'orchestration.workerStart',receipt:{state:'ready',dispatchId:'dispatch'}};
    if(method==='orchestration.workerStop')return {dispatchId:'dispatch',state:'stopped'};
    throw new Error('Unexpected fixture method '+method);
  }});
  const execute=host.work.deps.execute;
  host.work.deps.execute=async(input:WorkExecution,signal:AbortSignal,bind:any)=>{
    if(input.engine?.kind==='orca')return execute(input,signal,bind);
    childCalls++;input.assertActive();writeFileSync(join(root,'report.md'),'The accepted addition passes its tests.');return {answer:'Report checked',tokens:10};
  };
  const goal=await service.dispatch('work.create',{root,objective:'Repair and review arithmetic',maxConcurrent:1,maxTokens:10000,tasks:[{id:'fix',title:'Fix addition',prompt:'Repair sum',engine:{kind:'orca',agent:'codex'},writes:['sum.cjs'],acceptance:[{path:'sum.cjs',contains:'a+b'}]},{id:'report',title:'Report',prompt:'Report checked changes',dependsOn:['fix'],writes:['report.md'],acceptance:[{path:'report.md',contains:'accepted addition'}]}],acceptance:[{path:'sum.cjs',contains:'a+b'},{path:'report.md',contains:'accepted addition'}]}) as WorkGoal;
  await service.dispatch('work.run',{id:goal.id});
  const waitGoal=async()=>{for(let i=0;i<400;i++){const g=await service.dispatch('work.get',{id:goal.id}) as WorkGoal;if(g.status!=='running')return g;await new Promise(r=>setTimeout(r,10));}throw Error('Work did not settle');};
  await waitGoal();
  const importOutput=async()=>service.dispatch('work.orca.import',{id:goal.id,task:'fix'}) as Promise<any>;
  const imported=await importOutput();
  return {service,host,root,workspace,goal,imported,importOutput,waitGoal,starts:()=>starts,childCalls:()=>childCalls,setLive:(value:boolean)=>{live=value;}};
}
async function applied(f:Awaited<ReturnType<typeof fixture>>){
  const run=f.imported.run;
  const verified:any=await f.service.dispatch('helm.verify',{id:run.id,checks});expect(verified.status).toBe('verified');
  const review:any=await f.service.dispatch('helm.integration.prepare',{id:run.id});
  await f.service.dispatch('helm.integration.apply',{id:run.id,reviewId:review.id,patchDigest:sha(review.patch)});
  const source:any=await f.service.dispatch('helm.source.start',{id:run.id,reviewId:review.id,checks});
  let check:any;
  for(let i=0;i<200;i++){check=await f.service.dispatch('helm.source.get',{id:run.id,reviewId:review.id,sourceCheckId:source.id});if(check.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  expect(check.status).toBe('passed');
  // The reservation drains only after the check operation has stopped producing effects.
  for(let i=0;i<100;i++){if(!(await f.service.dispatch('work.source.status',{}) as any[]).length)break;await new Promise(r=>setTimeout(r,5));}
  return {id:f.goal.id,task:'fix',runId:run.id,reviewId:review.id,sourceCheckId:source.id};
}
it('Stop during source fingerprint prevents a late first command from dispatching',async()=>{
 const f=await fixture(),args=await applied(f);
 let enter!:()=>void,release!:(value:string)=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
 const original=f.host.helmSourceChecks.host.fingerprint;let block=true;
 f.host.helmSourceChecks.host.fingerprint=async(root:string)=>{if(block){block=false;enter();return new Promise<string>(resolve=>{release=resolve;});}return original(root);};
 const command=vi.spyOn(f.host.helmSourceChecks,'command').mockImplementation(async()=>({command:'fixture',args:[],exitCode:0,output:'',truncated:false}));
 const starting=f.service.dispatch('helm.source.start',{id:args.runId,reviewId:args.reviewId,checks});const settled=starting.catch(error=>error);
 await entered;await f.service.dispatch('work.stop',{id:f.goal.id});release(await original(f.root));await settled;
 expect(command).not.toHaveBeenCalled();expect(f.childCalls()).toBe(0);
},20000);

it('new instructions invalidate an accepted task instead of reusing its old acceptance receipt',async()=>{
 const f=await fixture(),args=await applied(f);await f.service.dispatch('work.orca.accept',args);
 await f.service.dispatch('work.message',{id:f.goal.id,task:'fix',input:'Change the behavior again'});
 const current:any=await f.service.dispatch('work.orca.acceptance',args);expect(current.eligible).toBe(false);
 await expect(f.service.dispatch('work.orca.accept',args)).rejects.toThrow();expect(f.starts()).toBe(1);expect(f.childCalls()).toBe(0);
},20000);
it('close drains a source start waiting on fingerprint without launching a late command',async()=>{
 const f=await fixture(),args=await applied(f);
 let enter!:()=>void,release!:(value:string)=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
 const original=f.host.helmSourceChecks.host.fingerprint;let block=true;
 f.host.helmSourceChecks.host.fingerprint=async(root:string)=>{if(block){block=false;enter();return new Promise<string>(resolve=>{release=resolve;});}return original(root);};
 const command=vi.spyOn(f.host.helmSourceChecks,'command').mockImplementation(async()=>({command:'fixture',args:[],exitCode:0,output:'',truncated:false}));
 const starting=f.service.dispatch('helm.source.start',{id:args.runId,reviewId:args.reviewId,checks});const settled=starting.catch(error=>error);
 await entered;let closed=false;const closing=f.service.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
 release(await original(f.root));await settled;await closing;expect(command).not.toHaveBeenCalled();
},20000);
