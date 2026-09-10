import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkbenchService } from '../core/workbench-service';
import { DurableWork, type WorkGoal } from '../core/durable-work';
import { desktopRequestLane, scheduleDesktopRequest } from '../core/desktop-request-routing';
import { DesktopRequestQueue } from '../core/desktop-request-queue';
vi.mock('../core/webhook-service',async()=>({WebhookService:(await import('./fixtures/offline-webhooks')).OfflineWebhookFixture}));
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0))await close();});
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function fixture(workerProfile=false){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'orca-replacement-'))),root=join(home,'source'),data=join(home,'data');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString();
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'result.txt'),'initial\n');git('add','.');git('commit','-m','fixture');
  const service=new WorkbenchService(data,()=>{},{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'}),host=service as any;
  cleanups.push(async()=>{await service.close();rmSync(home,{recursive:true,force:true});});
  await service.dispatch('project.add',{path:root});
  const assigned=workerProfile?(await service.dispatch('profile.save',{name:'Worker',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}) as any).id:'default';
  await service.dispatch('profile.select',{id:'default'});host.preflightWorkOrca=()=>{};
  const calls:string[]=[],workers=new Map<string,{base:string;path:string}>();let starts=0,live=false,runtime='fixture-runtime',showHold:Promise<void>|undefined;
  host.helmOrca.options.connect=async()=>({runtimeId:'fixture-runtime',coordinator:'coordinator',repo:'repo',call:async(method:string,p:any)=>{
    calls.push(method);
    if(method==='orchestration.runCreate')return {run:{id:'run-'+(starts+1)}};
    if(method==='orchestration.workerStart'){
      starts++;const dispatch='dispatch-'+starts,path=join(home,'worker-'+starts);git('worktree','add','--detach',path,p.baseBranch);writeFileSync(join(path,'result.txt'),'worker '+starts+'\n');workers.set(dispatch,{base:p.baseBranch,path});
      return {state:'failed',dispatchId:dispatch}; // Explicit stopped process fixture, with unknown usage.
    }
    if(method==='orchestration.workerShow'){
      if(showHold)await showHold;const worker=workers.get(p.dispatch)!;
      return {dispatch:{id:p.dispatch},worker:{dispatchId:p.dispatch,runtimeEpoch:runtime,worktreeId:p.dispatch,startOptions:{baseBranch:worker.base}},observation:{exactWorker:true,status:live?'live':'exited'}};
    }
    if(method==='worktree.show'){const id=p.worktree.slice(3);return {worktree:{id,repoId:'repo',git:{path:workers.get(id)!.path}}};}
    if(method==='orchestration.workerStop')return {state:'stopped',dispatchId:p.dispatch};
    if(method==='orchestration.requestShow')throw new Error('No implicit old-request recovery in replacement fixture');
    throw new Error('Unexpected fixture method '+method);
  }});
  const goal=await service.dispatch('work.create',{root,profile:'default',objective:'Replace a failed coding attempt deliberately',maxConcurrent:1,maxTokens:10000,maxRounds:4,tasks:[{id:'fix',title:'Fix',prompt:'Produce checked output',profile:assigned,engine:{kind:'orca',agent:'codex'},writes:['result.txt'],acceptance:[{path:'result.txt',contains:'worker'}]}]}) as WorkGoal;
  const get=()=>service.dispatch('work.get',{id:goal.id,profile:'default'}) as Promise<WorkGoal>;
  const settled=async()=>{for(let i=0;i<400;i++){const saved=await get();if(saved.status!=='running'){await tick();return get();}await tick();}throw new Error('Fixture Work did not settle');};
  await service.dispatch('work.run',{id:goal.id,profile:'default'});const saved=await settled(),task=saved.tasks[0];
  if(task.engine?.kind!=='orca')throw new Error('Expected Orca');
  const args={id:goal.id,task:'fix',profile:'default',expectedRequestId:task.engine.requestId,expectedAttemptId:task.attempts!.at(-1)!.id};
  const scope={root,profile:assigned};
  const claim=(kind='orca-replace:'+args.expectedRequestId)=>{
    const db=new DatabaseSync(join(data,'work.sqlite')),id=randomUUID();
    try{db.prepare('INSERT INTO work_source_operations(id,root,profile,goal,task,kind,owner,started) VALUES(?,?,?,?,?,?,?,?)').run(id,root,'default',goal.id,'fix',kind,'fixture-crashed-owner',Date.now());}finally{db.close();}return id;
  };
  return {service,host,root,data,goal,get,settled,saved,args,scope,claim,calls,starts:()=>starts,setLive:(v:boolean)=>{live=v;},setRuntime:(v:string)=>{runtime=v;},holdShow:(v:Promise<void>|undefined)=>{showHold=v;}};
}
it('prepares one new identity, preserves unknown allocation and imported output, and requires new admission budget',async()=>{
  const f=await fixture();const imported:any=await f.service.dispatch('work.orca.import',{id:f.goal.id,task:'fix'});
  const verified:any=await f.service.dispatch('helm.verify',{id:imported.run.id,checks:[{command:process.execPath,args:['-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'worker 1\\n')"]}]});expect(verified.status).toBe('verified');
  const oldReview:any=await f.service.dispatch('helm.integration.prepare',{id:imported.run.id});
  const oldApply={id:imported.run.id,reviewId:oldReview.id,patchDigest:createHash('sha256').update(oldReview.patch).digest('hex')};
  const before=await f.get(),inspection:any=await f.service.dispatch('work.orca.replacement',f.args);
  expect(inspection).toMatchObject({eligible:true,requestId:f.args.expectedRequestId,attemptId:f.args.expectedAttemptId,budget:{reportedTokens:0,heldTokens:10000,availableTokens:0,attemptsUsed:1}});
  const prepared:any=await f.service.dispatch('work.orca.replace',f.args);
  expect(prepared.status).toBe('needs_review');expect(prepared.sourceOperations).toEqual([]);expect(f.starts()).toBe(1);
  expect(prepared.tasks[0].engine).toMatchObject({dispatchIntent:false});expect(prepared.tasks[0].engine.requestId).not.toBe(f.args.expectedRequestId);
  expect(prepared.tasks[0].attempts).toEqual(before.tasks[0].attempts);expect(prepared.tasks[0].orcaImports).toEqual(before.tasks[0].orcaImports);expect(prepared.tasks[0].reservedTokens).toBe(10000);expect(prepared.tokens).toBe(0);
  expect((await f.service.dispatch('work.orca.replace',f.args) as any).tasks[0].orcaReplacements).toEqual(prepared.tasks[0].orcaReplacements);
  // An old immutable snapshot stays inspectable, but cannot apply to the new attempt.
  await expect(f.service.dispatch('helm.integration.prepare',{id:imported.run.id})).rejects.toThrow(/no dispatched|does not belong|not verified/i);
  expect((await f.service.dispatch('helm.integration.get',oldApply) as any).id).toBe(oldReview.id);
  await expect(f.service.dispatch('helm.integration.apply',oldApply)).rejects.toThrow(/no dispatched|does not belong/i);
  await f.service.dispatch('work.resume',{id:f.goal.id});await f.settled();expect(f.starts()).toBe(1);expect((await f.get()).tasks[0].rounds).toBe(1);
  await f.service.dispatch('work.resume',{id:f.goal.id,maxTokens:20000});const after=await f.settled();
  expect(f.starts()).toBe(2);expect(after.tasks[0].rounds).toBe(2);expect(after.tasks[0].attempts?.at(-1)?.engineRequestId).toBe(prepared.tasks[0].engine.requestId);expect(after.tasks[0].reservedTokens).toBe(20000);
  await expect(f.service.dispatch('helm.integration.apply',oldApply)).rejects.toThrow(/does not belong/i);
  await expect(f.service.dispatch('work.orca.acceptance',{id:f.goal.id,task:'fix',runId:imported.run.id,reviewId:oldReview.id,sourceCheckId:'unused'})).rejects.toThrow(/does not belong/i);
  expect(readFileSync(join(f.root,'result.txt'),'utf8')).toBe('initial\n');
  const audit:any=await f.service.dispatch('work.audit.export',{id:f.goal.id});expect(JSON.stringify(audit)).toContain('task.orca_replaced');
});
it.each(['live','runtime','missing'] as const)('refuses %s authority without refund, seal or new worker',async(problem)=>{
  const f=await fixture();if(problem==='live')f.setLive(true);if(problem==='runtime')f.setRuntime('another-runtime');
  if(problem==='missing'){const db=new DatabaseSync(join(f.data,'orca-intents','intents.sqlite'));try{db.prepare('DELETE FROM attempts WHERE id=?').run(f.args.expectedRequestId);}finally{db.close();}}
  const inspected:any=await f.service.dispatch('work.orca.replacement',f.args);expect(inspected.eligible).toBe(false);expect(inspected.reason).toBeTruthy();
  await expect(f.service.dispatch('work.orca.replace',f.args)).rejects.toThrow();expect(f.starts()).toBe(1);expect((await f.get()).tasks[0]).toMatchObject({reservedTokens:10000,rounds:1,engine:{requestId:f.args.expectedRequestId}});
});
it('simultaneous confirmations choose one successor and retries are idempotent',async()=>{
  const f=await fixture(),hold=deferred();f.holdShow(hold.promise);
  const first=f.service.dispatch('work.orca.replace',f.args);
  await tick();await expect(f.service.dispatch('work.orca.replace',f.args)).rejects.toThrow(/operation.*active/i);
  hold.resolve();const result:any=await first;
  expect((await f.service.dispatch('work.orca.replace',f.args) as any).tasks[0].engine.requestId).toBe(result.tasks[0].engine.requestId);
  expect((await f.get()).tasks[0].orcaReplacements).toHaveLength(1);expect(f.starts()).toBe(1);
});
it('recovers after sealing before the Work checkpoint using the same successor',async()=>{
  const f=await fixture(),replace=vi.spyOn(f.host.work,'replaceOrca').mockImplementationOnce(()=>{throw new Error('Injected crash boundary after seal');});
  await expect(f.service.dispatch('work.orca.replace',f.args)).rejects.toThrow('Injected crash boundary');replace.mockRestore();
  const seal=f.host.helmOrca.get(f.scope,f.args.expectedRequestId).replacementSeal;expect(seal).toBeTruthy();expect((await f.get()).tasks[0].engine).toMatchObject({requestId:f.args.expectedRequestId});
  f.claim();const saved:any=await f.service.dispatch('work.orca.replace',f.args);expect(saved.tasks[0].engine.requestId).toBe(seal.successorId);expect(f.starts()).toBe(1);expect(await f.service.dispatch('work.source.status',{})).toEqual([]);
});
it('recovers an exact replacement metadata claim before proof, but retains an unrelated source claim',async()=>{
  const f=await fixture();f.claim('apply:unknown-review');
  await expect(f.service.dispatch('work.orca.replace',f.args)).rejects.toThrow(/operation.*active/i);expect(await f.service.dispatch('work.source.status',{})).toHaveLength(1);
  const db=new DatabaseSync(join(f.data,'work.sqlite'));try{db.prepare('DELETE FROM work_source_operations WHERE kind=?').run('apply:unknown-review');}finally{db.close();}
  f.claim();expect((await f.service.dispatch('work.orca.replace',f.args) as any).tasks[0].orcaReplacements).toHaveLength(1);expect(f.starts()).toBe(1);
});
it('Stop during termination inspection fences a late seal and replacement checkpoint',async()=>{
  const f=await fixture(),hold=deferred();f.holdShow(hold.promise);
  const pending=f.service.dispatch('work.orca.replace',f.args),rejection=expect(pending).rejects.toThrow();await tick();
  await f.service.dispatch('work.stop',{id:f.goal.id});hold.resolve();await rejection;
  expect(f.host.helmOrca.get(f.scope,f.args.expectedRequestId).replacementSeal).toBeUndefined();expect((await f.get()).tasks[0].engine).toMatchObject({requestId:f.args.expectedRequestId});expect(f.starts()).toBe(1);
});
it('Stop after a seal retains it without late rotation and a later explicit retry recovers it',async()=>{
  const f=await fixture(),original=f.host.helmOrca.sealForReplacement.bind(f.host.helmOrca);
  const stop=vi.spyOn(f.host.helmOrca,'sealForReplacement').mockImplementationOnce(async(...args:any[])=>{const seal=await original(...args);f.host.work.stop(f.goal.id,'default');return seal;});
  await expect(f.service.dispatch('work.orca.replace',f.args)).rejects.toThrow();stop.mockRestore();
  const seal=f.host.helmOrca.get(f.scope,f.args.expectedRequestId).replacementSeal;expect(seal).toBeTruthy();expect((await f.get()).tasks[0].engine).toMatchObject({requestId:f.args.expectedRequestId});
  const prepared:any=await f.service.dispatch('work.orca.replace',f.args);expect(prepared.tasks[0].engine.requestId).toBe(seal.successorId);expect(f.starts()).toBe(1);
});
it('clears only the completed metadata claim on a lost reply and validates current predecessor identities',async()=>{
  const f=await fixture();await f.service.dispatch('work.orca.replace',f.args);f.claim();
  await f.service.dispatch('work.orca.replace',f.args);expect(await f.service.dispatch('work.source.status',{})).toEqual([]);
  await expect(f.service.dispatch('work.orca.replace',{...f.args,expectedAttemptId:randomUUID()})).rejects.toThrow();expect((await f.get()).tasks[0].orcaReplacements).toHaveLength(1);
});
it('checks the goal owner independently from the assigned provider profile',async()=>{
  const f=await fixture(true);await expect(f.service.dispatch('work.orca.replace',{...f.args,profile:f.scope.profile})).rejects.toThrow(/another profile/i);
  const saved:any=await f.service.dispatch('work.orca.replace',f.args);expect(saved.tasks[0].orcaReplacements[0].seal.profile).toBe(f.scope.profile);expect(saved.profile).toBe('default');
});
it('cross-process metadata recovery fences the previous claim owner before its late callback',async()=>{
  const f=await fixture(),other=new DurableWork(join(f.data,'work.sqlite'),{root:()=>f.root,profile:()=>{},execute:async()=>{throw Error('No execution allowed');}}),hold=deferred(),entered=deferred();
  cleanups.unshift(async()=>{await other.close();});
  const expected={requestId:f.args.expectedRequestId,attemptId:f.args.expectedAttemptId};
  const late=f.host.work.withOrcaReplacement(f.goal.id,'default','fix',expected,async(_s:AbortSignal,guard:()=>void)=>{entered.resolve();await hold.promise;guard();});
  const rejected=expect(late).rejects.toThrow(/ownership|stopped|changed/i);await entered.promise;
  await other.withOrcaReplacement(f.goal.id,'default','fix',expected,async(signal,guard)=>{
    const seal=await f.host.helmOrca.sealForReplacement(f.scope,f.args.expectedRequestId,signal,guard);other.replaceOrca(f.goal.id,'default','fix',expected,seal,guard);
  });hold.resolve();await rejected;expect((await f.get()).tasks[0].orcaReplacements).toHaveLength(1);expect(f.starts()).toBe(1);
});
it('Stop removes a queued replacement in the real request router, scoped to its goal and profile',async()=>{
  const queue=new DesktopRequestQueue<{id:string;method:string;args:Record<string,unknown>}>(),hold=deferred(),handled:string[]=[],rejected:string[]=[];
  const blocker=queue.submit({id:'block',method:'fixture',args:{}},'serial',()=>hold.promise);
  const host={handle:async(r:{id:string})=>{handled.push(r.id);},rejected:(r:{id:string})=>{rejected.push(r.id);}};
  const replacement=scheduleDesktopRequest(queue,{id:'replace',method:'work.orca.replace',args:{id:'goal',profile:'default'}},host);
  const foreign=scheduleDesktopRequest(queue,{id:'foreign',method:'work.orca.replace',args:{id:'goal',profile:'other'}},host);
  await scheduleDesktopRequest(queue,{id:'stop',method:'work.stop',args:{id:'goal',profile:'default'}},host);await replacement;
  hold.resolve();await blocker;await foreign;await queue.close();
  expect(handled).toEqual(['stop','foreign']);expect(rejected).toEqual(['replace']);expect(desktopRequestLane('work.orca.replacement')).toBe('inspection');
});
it.each(['claim','seal','checkpoint'].flatMap(boundary=>[1,2,3].map(repetition=>({boundary,repetition}))))('recovers actual owned-host SIGKILL at $boundary boundary, repetition $repetition',async({boundary})=>{
  const f=await fixture(),record=f.host.helmOrca.get(f.scope,f.args.expectedRequestId),metadata=join(f.data,'crash-input.json'),script=join(f.data,'crash-child.mjs');
  writeFileSync(metadata,JSON.stringify({boundary,data:f.data,root:f.root,scope:f.scope,args:f.args,record}));
  writeFileSync(script,`
import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {DurableWork} from ${JSON.stringify(resolve('src/desktop/core/durable-work.ts'))};
import {HelmOrcaService} from ${JSON.stringify(resolve('src/desktop/core/helm-orca-service.ts'))};
const f=JSON.parse(readFileSync(process.argv[2],'utf8'));
const work=new DurableWork(join(f.data,'work.sqlite'),{root:()=>f.root,profile:()=>{},execute:async()=>{throw Error('No worker execution in crash child');}});
const service=new HelmOrcaService(join(f.data,'orca-intents'),{connect:async()=>({runtimeId:f.record.runtimeId,coordinator:'fixture',repo:'fixture',call:async(method,p)=>{
if(method!=='orchestration.workerShow')throw Error('No worker mutation in crash child');
return {dispatch:{id:p.dispatch},worker:{dispatchId:p.dispatch,runtimeEpoch:f.record.runtimeId,startOptions:{baseBranch:f.record.baseSha}},observation:{exactWorker:true,status:'exited'}};
}})});
const expected={requestId:f.args.expectedRequestId,attemptId:f.args.expectedAttemptId};
await work.withOrcaReplacement(f.args.id,'default','fix',expected,async(signal,guard)=>{
if(f.boundary==='claim')process.kill(process.pid,'SIGKILL');
const seal=await service.sealForReplacement(f.scope,expected.requestId,signal,guard);
if(f.boundary==='seal')process.kill(process.pid,'SIGKILL');
work.replaceOrca(f.args.id,'default','fix',expected,seal,guard);
process.kill(process.pid,'SIGKILL');
});
`);
  const child=spawn(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script,metadata],{stdio:['ignore','ignore','pipe']});
  cleanups.unshift(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}});
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  const [code,signal]=await once(child,'exit');expect({code,signal},stderr).toEqual({code:null,signal:'SIGKILL'});
  expect(await f.service.dispatch('work.source.status',{})).toMatchObject([{state:'unconfirmed',kind:'orca-replace:'+f.args.expectedRequestId}]);
  const beforeSeal=f.host.helmOrca.get(f.scope,f.args.expectedRequestId).replacementSeal;
  expect(!!beforeSeal).toBe(boundary!=='claim');
  const saved:any=await f.service.dispatch('work.orca.replace',f.args);
  expect(saved.tasks[0].orcaReplacements).toHaveLength(1);expect(saved.tasks[0].reservedTokens).toBe(10000);expect(saved.tasks[0].attempts).toEqual(f.saved.tasks[0].attempts);expect(f.starts()).toBe(1);
  if(beforeSeal)expect(saved.tasks[0].engine.requestId).toBe(beforeSeal.successorId);
  expect(await f.service.dispatch('work.source.status',{})).toEqual([]);
  await f.service.dispatch('work.resume',{id:f.goal.id,maxTokens:20000});const done=await f.settled();
  expect(f.starts()).toBe(2);expect(done.tasks[0].reservedTokens).toBe(20000);expect(done.tasks[0].attempts).toHaveLength(2);expect(done.tasks[0].attempts?.at(-1)?.engineRequestId).toBe(saved.tasks[0].engine.requestId);
  expect(readFileSync(join(f.root,'result.txt'),'utf8')).toBe('initial\n');
},15000);
