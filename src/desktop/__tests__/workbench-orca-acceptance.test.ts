import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
async function fixture(separateWorkerProfile=false){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'work-orca-acceptance-'))),root=join(home,'source'),workspace=join(home,'orca-worker'),data=join(home,'data');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString();
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'sum.cjs'),'exports.sum=(a,b)=>a-b;\n');
  writeFileSync(join(root,'sum.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');const {sum}=require('./sum.cjs');test('adds signed values',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,4),2);assert.equal(sum(0,0),0);});\n");
  git('add','.');git('commit','-m','fixture');
  const service=new WorkbenchService(data,()=>{},{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'});
  cleanups.push(async()=>{await service.close();rmSync(home,{recursive:true,force:true});});
  await service.dispatch('project.add',{path:root});
  const workerProfile=separateWorkerProfile?(await service.dispatch('profile.save',{name:'Coding worker',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}) as any).id:'default';
  await service.dispatch('profile.select',{id:'default'}); // Creating a profile selects it; the manager owns this goal.
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
  const goal=await service.dispatch('work.create',{root,profile:'default',objective:'Repair and review arithmetic',maxConcurrent:1,maxTokens:10000,tasks:[{id:'fix',title:'Fix addition',prompt:'Repair sum',profile:workerProfile,engine:{kind:'orca',agent:'codex'},writes:['sum.cjs'],acceptance:[{path:'sum.cjs',contains:'a+b'}]},{id:'report',title:'Report',prompt:'Report checked changes',dependsOn:['fix'],writes:['report.md'],acceptance:[{path:'report.md',contains:'accepted addition'}]}],acceptance:[{path:'sum.cjs',contains:'a+b'},{path:'report.md',contains:'accepted addition'}]}) as WorkGoal;
  await service.dispatch('work.run',{id:goal.id});
  const waitGoal=async()=>{for(let i=0;i<400;i++){const g=await service.dispatch('work.get',{id:goal.id}) as WorkGoal;if(g.status!=='running')return g;await new Promise(r=>setTimeout(r,10));}throw Error('Work did not settle');};
  await waitGoal();
  const importOutput=async()=>service.dispatch('work.orca.import',{id:goal.id,task:'fix'}) as Promise<any>;
  const imported=await importOutput();
  return {service,host,data,root,workspace,goal,workerProfile,imported,importOutput,waitGoal,starts:()=>starts,childCalls:()=>childCalls,setLive:(value:boolean)=>{live=value;}};
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
it('imports once, reviews and checks real Git changes, accepts without freeing unknown usage, then runs its dependent',async()=>{
  const f=await fixture();
  expect(f.imported.run.status).toBe('needs_review');expect(readFileSync(join(f.root,'sum.cjs'),'utf8')).toContain('a-b');
  expect((await f.importOutput()).run.id).toBe(f.imported.run.id);expect(f.starts()).toBe(1);expect(f.childCalls()).toBe(0);
  const before:any=await f.service.dispatch('work.get',{id:f.goal.id}),args=await applied(f);
  expect((await f.service.dispatch('work.orca.acceptance',args) as any).eligible).toBe(true);
  const accepted:any=await f.service.dispatch('work.orca.accept',args);
  expect(accepted.tasks[0].status).toBe('completed');expect(accepted.tasks[0].reservedTokens).toBe(before.tasks[0].reservedTokens);expect(accepted.tasks[0].attempts).toEqual(before.tasks[0].attempts);expect(accepted.tokens).toBe(0);expect(f.childCalls()).toBe(0);
  expect((await f.service.dispatch('work.orca.accept',args) as any).tasks[0].orcaAcceptance).toEqual(accepted.tasks[0].orcaAcceptance);
  await f.service.dispatch('work.resume',{id:f.goal.id,maxTokens:20000});const done=await f.waitGoal();
  expect(done.status).toBe('completed');expect(f.childCalls()).toBe(1);expect(f.starts()).toBe(1);expect(done.tasks[0].reservedTokens).toBe(10000);
},20000);
it('refuses changed source after checks and another task or profile receipt',async()=>{
  const f=await fixture(),args=await applied(f);writeFileSync(join(f.root,'sum.cjs'),'exports.sum=(a,b)=>a+b+1;\n');
  const current:any=await f.service.dispatch('work.orca.acceptance',args);expect(current.eligible).toBe(false);expect(current.reasons.join(' ')).toMatch(/fresh|changed/i);
  await expect(f.service.dispatch('work.orca.accept',args)).rejects.toThrow();
  await expect(f.service.dispatch('work.orca.acceptance',{...args,task:'report'})).rejects.toThrow();
  await expect(f.service.dispatch('work.orca.accept',{...args,profile:'foreign'})).rejects.toThrow();
  expect((await f.service.dispatch('work.get',{id:f.goal.id}) as WorkGoal).tasks[0].status).not.toBe('completed');expect(f.childCalls()).toBe(0);
},20000);
it('Stop cancels isolated verification before a late passing command can enable acceptance',async()=>{
  const f=await fixture(),started=f.service.dispatch('helm.verify',{id:f.imported.run.id,checks:[{command:process.execPath,args:['-e','setTimeout(()=>process.exit(0),10000)']}]});
  for(let i=0;i<100;i++){if(f.host.helm.get(f.imported.run.id).status==='running')break;await new Promise(r=>setTimeout(r,5));}
  await f.service.dispatch('work.stop',{id:f.goal.id});await expect(started).rejects.toThrow();
  expect(f.host.helm.get(f.imported.run.id).status).not.toBe('verified');expect(await f.service.dispatch('work.source.status',{})).toEqual([]);expect(f.childCalls()).toBe(0);
},20000);
it('reconciles a retained completed-apply reservation without replay and preserves an unknown one',async()=>{
  const f=await fixture(),args=await applied(f),id=randomUUID(),db=new DatabaseSync(join(f.data,'work.sqlite'));
  try{
    db.prepare('INSERT INTO work_source_operations(id,root,profile,goal,task,kind,owner,started) VALUES(?,?,?,?,?,?,?,?)').run(id,f.root,'default',f.goal.id,'fix','apply:'+args.reviewId,'fixture-crashed-owner',Date.now());
    await expect(f.service.dispatch('work.source.reconcile',{id,profile:'foreign'})).rejects.toThrow();
    expect(await f.service.dispatch('work.source.reconcile',{id})).toEqual({id,reconciled:true});
    expect(await f.service.dispatch('work.source.status',{})).toEqual([]);expect(f.starts()).toBe(1);
    const path=join(f.data,'helm','integration',args.reviewId+'.json'),receipt=JSON.parse(readFileSync(path,'utf8'));
    writeFileSync(path,JSON.stringify({...receipt,status:'unknown'}));
    db.prepare('INSERT INTO work_source_operations(id,root,profile,goal,task,kind,owner,started) VALUES(?,?,?,?,?,?,?,?)').run(id,f.root,'default',f.goal.id,'fix','apply:'+args.reviewId,'fixture-crashed-owner',Date.now());
    await expect(f.service.dispatch('work.source.reconcile',{id})).rejects.toThrow();
    expect((await f.service.dispatch('work.source.status',{}) as any[])).toHaveLength(1);expect(readFileSync(join(f.root,'sum.cjs'),'utf8')).toContain('a+b');
  }finally{db.close();}
},20000);
it('keeps the assigned worker profile separate from the goal owner throughout import and acceptance',async()=>{
  const f=await fixture(true),run=f.imported.run;
  expect(run.owner).toBe('default');expect(run.orcaOrigin.profile).toBe(f.workerProfile);expect(run.workOrigin).toMatchObject({ownerProfile:'default',taskProfile:f.workerProfile});
  await expect(f.service.dispatch('helm.get',{id:run.id,profile:f.workerProfile})).rejects.toThrow();
  await expect(f.service.dispatch('work.orca.import',{id:f.goal.id,task:'fix',profile:f.workerProfile})).rejects.toThrow();
  const args=await applied(f);expect((await f.service.dispatch('work.orca.accept',args) as WorkGoal).tasks[0].orcaAcceptance?.runId).toBe(run.id);
},20000);
it('Stop cancels new review work on an already accepted objective without undoing accepted results',async()=>{
  const f=await fixture(),args=await applied(f);await f.service.dispatch('work.orca.accept',args);
  await f.service.dispatch('work.resume',{id:f.goal.id,maxTokens:20000});expect((await f.waitGoal()).status).toBe('completed');
  const pending=f.service.dispatch('helm.verify',{id:f.imported.run.id,checks:[{command:process.execPath,args:['-e','setTimeout(()=>process.exit(0),10000)']}]}),rejected=expect(pending).rejects.toThrow();
  for(let i=0;i<100;i++){if(f.host.helm.get(f.imported.run.id).status==='running')break;await new Promise(r=>setTimeout(r,5));}
  const stopped:any=await f.service.dispatch('work.stop',{id:f.goal.id});expect(stopped.status).toBe('completed');await rejected;
  expect(f.host.helm.get(f.imported.run.id).status).not.toBe('running');expect(await f.service.dispatch('work.source.status',{})).toEqual([]);
  const goal:any=await f.service.dispatch('work.get',{id:f.goal.id});expect(goal.status).toBe('completed');expect(goal.tasks[0].orcaAcceptance).toBeTruthy();
},20000);
