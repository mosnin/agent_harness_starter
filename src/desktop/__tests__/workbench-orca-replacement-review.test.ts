// Independent adversarial cases; offline/real-Git fixture adapted from the author route suite.
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchService } from '../core/workbench-service';
import { DurableWork, type WorkGoal } from '../core/durable-work';
import { desktopRequestLane, scheduleDesktopRequest } from '../core/desktop-request-routing';
import { DesktopRequestQueue } from '../core/desktop-request-queue';
vi.mock('../core/webhook-service',async()=>({WebhookService:(await import('./fixtures/offline-webhooks')).OfflineWebhookFixture}));
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0))await close();});
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function fixture(workerProfile=false, unsupportedModel=false){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'orca-replacement-'))),root=join(home,'source'),data=join(home,'data');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString();
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'result.txt'),'initial\n');git('add','.');git('commit','-m','fixture');
  const service=new WorkbenchService(data,()=>{},{NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'}),host=service as any;
  cleanups.push(async()=>{await service.close();rmSync(home,{recursive:true,force:true});});
  await service.dispatch('project.add',{path:root});
  const assigned=workerProfile?(await service.dispatch('profile.save',{name:'Worker',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'}) as any).id:'default';
  await service.dispatch('profile.select',{id:'default'});host.helmOrcaRuntime.validateArtifacts=()=>{};
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
  const goal=await service.dispatch('work.create',{root,profile:'default',objective:'Replace a failed coding attempt deliberately',maxConcurrent:1,maxTokens:10000,maxRounds:4,tasks:[{id:'fix',title:'Fix',prompt:'Produce checked output',profile:assigned,engine:unsupportedModel?{kind:'orca',agent:'opencode',model:'unsupported'}:{kind:'orca',agent:'codex'},writes:['result.txt'],acceptance:[{path:'result.txt',contains:'worker'}]}]}) as WorkGoal;
  const get=()=>service.dispatch('work.get',{id:goal.id,profile:'default'}) as Promise<WorkGoal>;
  const settled=async()=>{for(let i=0;i<400;i++){const saved=await get();if(saved.status!=='running'){await tick();return get();}await tick();}throw new Error('Fixture Work did not settle');};
  await service.dispatch('work.run',{id:goal.id,profile:'default'});const saved=await settled(),task=saved.tasks[0];
  if(task.engine?.kind!=='orca')throw new Error('Expected Orca');
  const args={id:goal.id,task:'fix',profile:'default',expectedRequestId:task.engine.requestId,expectedAttemptId:task.attempts?.at(-1)?.id??'not-admitted'};
  const scope={root,profile:assigned};
  const claim=(kind='orca-replace:'+args.expectedRequestId)=>{
    const db=new DatabaseSync(join(data,'work.sqlite')),id=randomUUID();
    try{db.prepare('INSERT INTO work_source_operations(id,root,profile,goal,task,kind,owner,started) VALUES(?,?,?,?,?,?,?,?)').run(id,root,'default',goal.id,'fix',kind,'fixture-crashed-owner',Date.now());}finally{db.close();}return id;
  };
  return {service,host,root,data,goal,get,settled,saved,args,scope,claim,calls,starts:()=>starts,setLive:(v:boolean)=>{live=v;},setRuntime:(v:string)=>{runtime=v;},holdShow:(v:Promise<void>|undefined)=>{showHold=v;}};
}
it('does not return fresh replacement eligibility after a source claim appears during inspection',async()=>{
  const f=await fixture(),hold=deferred();f.holdShow(hold.promise);
  const pending=f.service.dispatch('work.orca.replacement',f.args);
  await tick(); f.claim('apply:newly-unconfirmed'); hold.resolve();
  const result:any=await pending;
  expect(result.eligible).toBe(false);
  expect(result.reason).toMatch(/operation|source/i);
  expect(f.starts()).toBe(1);
});
it('does not return stale budget after Work is changed during termination inspection',async()=>{
  const f=await fixture(),hold=deferred();f.holdShow(hold.promise);
  const pending=f.service.dispatch('work.orca.replacement',f.args);
  await tick(); await f.service.dispatch('work.stop',{id:f.goal.id}); hold.resolve();
  const result:any=await pending;
  expect(result.eligible).toBe(false);
  expect(f.starts()).toBe(1);
});
it('rejects unsupported OpenCode model before allocating a dispatch intent or unknown usage',async()=>{
 const f=await fixture(false,true),goal=await f.get(),task=goal.tasks[0];
 expect(f.starts()).toBe(0); expect(goal.status).toBe('needs_review');
 expect({status:task.status,rounds:task.rounds,reservedTokens:task.reservedTokens??0,dispatchIntent:task.engine?.kind==='orca'&&!!task.engine.dispatchIntent}).toEqual({status:'failed',rounds:0,reservedTokens:0,dispatchIntent:false});
});
it('refuses a fresh inspector result when a foreign-profile overlapping claim appears',async()=>{
 const f=await fixture(),hold=deferred();f.holdShow(hold.promise);
 const pending=f.service.dispatch('work.orca.replacement',f.args);await tick();
 const db=new DatabaseSync(join(f.data,'work.sqlite'));
 try{db.prepare('INSERT INTO work_source_operations(id,root,profile,goal,task,kind,owner,started) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),f.root,'foreign','foreign-goal','foreign-task','apply:foreign','other',Date.now());}finally{db.close();}
 hold.resolve();expect((await pending as any).eligible).toBe(false);expect(f.starts()).toBe(1);
});
