import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelmOrcaService } from '../core/helm-orca-service';
import { HelmOrcaPreflightError } from '../core/helm-orca-errors';
const dirs:string[]=[];
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'helm-orca-'));dirs.push(root);const directory=join(root,'state'),scope={root,profile:'p'};const call=vi.fn(async(method:string):Promise<any>=>method==='orchestration.runCreate'?{run:{id:'run-1'}}:{state:'ready',dispatchId:'dispatch-1'});const c={runtimeId:'runtime-1',repo:'repo-1',coordinator:'terminal-1',call};const connect=vi.fn(async()=>c);return {root,directory,scope,call,c,connect,service:new HelmOrcaService(directory,{connect,resolveBase:async()=> 'a'.repeat(40)}),input:{requestId:randomUUID(),prompt:'Fix fixture',agent:'codex' as const}};}
describe('actual Orca RPC orchestration adapter intent',()=>{
 it('uses exact worker contract and disables setup',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);expect(r.state).toBe('ready');expect(f.call.mock.calls[1]).toEqual(['orchestration.workerStart',expect.objectContaining({from:'terminal-1',run:'run-1',repo:'repo-1',worktree:'new-top-level',setup:'skip'}),expect.objectContaining({requestId:expect.any(String)})]);});
 it('never duplicates a repeated request',async()=>{const f=fixture();await f.service.start(f.scope,f.input);await f.service.start(f.scope,f.input);expect(f.call).toHaveBeenCalledTimes(2);});
 it('refuses altered request and cross-profile read',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);await expect(f.service.start(f.scope,{...f.input,prompt:'Other'})).rejects.toThrow('identity');expect(()=>f.service.get({...f.scope,profile:'other'},r.id)).toThrow('owned');});
 it('retains lost acknowledgement and reconciles without replay',async()=>{const f=fixture();f.call.mockImplementation(async m=>{if(m==='orchestration.runCreate')return {run:{id:'run-1'}};throw new Error('lost ack');});const r=await f.service.start(f.scope,f.input);expect(r.state).toBe('unknown');f.call.mockResolvedValue({requestId:r.requestId,state:'completed',method:'orchestration.workerStart',receipt:{dispatchId:'dispatch-1',state:'ready',mutation:{requestId:r.requestId}}});expect((await f.service.recover(f.scope,r.id)).state).toBe('ready');expect(f.call.mock.calls.at(-1)?.[0]).toBe('orchestration.requestShow');});
 it('absent receipt remains unknown across restart',async()=>{const f=fixture();f.call.mockRejectedValue(new Error('lost'));const r=await f.service.start(f.scope,f.input);const next=new HelmOrcaService(f.directory,{connect:f.connect,resolveBase:async()=> 'a'.repeat(40)});f.call.mockResolvedValue({requestId:r.requestId,state:'absent'});expect((await next.recover(f.scope,r.id)).state).toBe('unknown');await next.start(f.scope,f.input);expect(f.call).toHaveBeenCalledTimes(2);});
 it('cancel before dispatch launches nothing and retains no intent',async()=>{const f=fixture(),c=new AbortController();c.abort();await expect(f.service.start(f.scope,f.input,c.signal)).rejects.toThrow();expect(f.service.list(f.scope)).toEqual([]);expect(f.call).not.toHaveBeenCalled();});
 it('rejects changed runtime authority on recovery',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);f.c.runtimeId='other';await expect(f.service.recover(f.scope,r.id)).rejects.toThrow('authority');expect(f.call).toHaveBeenCalledTimes(2);});
 it('stop requires matching acknowledged stopped verdict',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);f.call.mockResolvedValue({dispatchId:r.dispatchId,state:'stopped'});expect((await f.service.stop(f.scope,r.id)).state).toBe('stopped');});
 it('two service instances reserve only one dispatch',async()=>{const f=fixture();const other=new HelmOrcaService(f.directory,{connect:f.connect,resolveBase:async()=> 'a'.repeat(40)});await Promise.all([f.service.start(f.scope,f.input),other.start(f.scope,f.input)]);expect(f.call).toHaveBeenCalledTimes(2);});
 it('ready persistent workers block maintenance and durable capacity across instances',async()=>{const f=fixture();const other=new HelmOrcaService(f.directory,{connect:f.connect,resolveBase:async()=> 'a'.repeat(40)});for(let i=0;i<4;i++)await (i%2?other:f.service).start(f.scope,{...f.input,requestId:randomUUID()});expect(other.hasActiveWork()).toBe(true);await expect(other.start(f.scope,{...f.input,requestId:randomUUID()})).rejects.toThrow('Four Orca workers');expect(f.call).toHaveBeenCalledTimes(8);});
 it('concurrent instances cannot exceed four durable reservations',async()=>{const f=fixture();const other=new HelmOrcaService(f.directory,{connect:f.connect,resolveBase:async()=> 'a'.repeat(40)});const results=await Promise.allSettled(Array.from({length:6},(_,i)=>(i%2?other:f.service).start(f.scope,{...f.input,requestId:randomUUID()})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(4);expect(f.service.list(f.scope)).toHaveLength(4);});
 it('exact exited process releases capacity but remains needs_review',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);f.call.mockResolvedValue({dispatch:{id:r.dispatchId,status:'completed'},observation:{exactWorker:true,status:'exited'}});const status=await f.service.status(f.scope,r.id);expect(status.state).toBe('needs_review');expect(status.active).toBe(false);expect(f.service.hasActiveWork()).toBe(false);});
 it('completed dispatch report with live or unverifiable process still blocks maintenance',async()=>{const f=fixture();const r=await f.service.start(f.scope,f.input);f.call.mockResolvedValue({dispatch:{id:r.dispatchId,status:'completed'},observation:{exactWorker:true,status:'live'}});expect((await f.service.status(f.scope,r.id)).state).toBe('ready');expect(f.service.hasActiveWork()).toBe(true);f.call.mockResolvedValue({dispatch:{id:r.dispatchId,status:'completed'},observation:{exactWorker:false,status:'missing'}});expect((await f.service.status(f.scope,r.id)).state).toBe('unknown');expect(f.service.hasActiveWork()).toBe(true);});
 it('startup stop awaits request cancellation and returns unknown rather than stale starting',async()=>{const f=fixture();let entered!:()=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});f.call.mockImplementation(async(method:string,_p?:unknown,options?:any)=>{if(method==='orchestration.runCreate')return {run:{id:'run-1'}};entered();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('lost after cancel')),{once:true}));});const pending=f.service.start(f.scope,f.input);await enteredPromise;const stopped=await f.service.stop(f.scope,f.input.requestId);expect(stopped.state).toBe('unknown');expect(stopped.error).toContain('termination is unconfirmed');expect((await pending).state).toBe('unknown');expect(f.service.hasActiveWork()).toBe(true);});
 it('one Stop finishes after a late ready acknowledgement without redispatch',async()=>{const f=fixture();let finish!:(x:any)=>void;let entered!:()=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});f.call.mockImplementation(async(method:string)=>{if(method==='orchestration.runCreate')return {run:{id:'run-1'}};if(method==='orchestration.workerStop')return {state:'stopped',dispatchId:'late-dispatch'};entered();return new Promise(r=>{finish=r;});});const pending=f.service.start(f.scope,f.input);await enteredPromise;const stopping=f.service.stop(f.scope,f.input.requestId);finish({state:'ready',dispatchId:'late-dispatch'});expect((await stopping).state).toBe('stopped');await pending;expect(f.call.mock.calls.filter(c=>c[0]==='orchestration.workerStart')).toHaveLength(1);expect(f.call.mock.calls.filter(c=>c[0]==='orchestration.workerStop')).toHaveLength(1);expect(f.service.hasActiveWork()).toBe(false);});

 it('coalesces overlapping Stop requests without exposing another profile',async()=>{
  const f=fixture(),record=await f.service.start(f.scope,f.input);let finish!:(x:any)=>void;let entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;});f.call.mockImplementation(async()=>{entered();return new Promise(r=>{finish=r;});});
  const first=f.service.stop(f.scope,record.id);await started;const second=f.service.stop(f.scope,record.id);
  await expect(f.service.stop({...f.scope,profile:'other'},record.id)).rejects.toThrow('owned');
  finish({state:'stopped',dispatchId:record.dispatchId});expect(await first).toEqual(await second);
  expect(f.call.mock.calls.filter(c=>c[0]==='orchestration.workerStop')).toHaveLength(1);await f.service.close();
 });

 it('does not duplicate an uncertain Stop across service instances',async()=>{
  const f=fixture(),record=await f.service.start(f.scope,f.input),other=new HelmOrcaService(f.directory,{connect:f.connect,resolveBase:async()=> 'a'.repeat(40)});
  f.call.mockRejectedValue(new Error('lost stop receipt'));
  expect((await f.service.stop(f.scope,record.id)).state).toBe('unknown');
  await expect(other.stop(f.scope,record.id)).rejects.toThrow('Reconcile');
  expect(f.call.mock.calls.filter(c=>c[0]==='orchestration.workerStop')).toHaveLength(1);
  await Promise.all([f.service.close(),other.close()]);
 });

 it('cancels a queued coordinator request promptly without letting its successor overtake the owner',async()=>{
  const f=fixture();let release!:(value:any)=>void;
  f.call.mockImplementation(async method=>{
    if(method==='orchestration.runCreate'&&f.call.mock.calls.length===1)return new Promise(done=>{release=done;});
    return method==='orchestration.runCreate'?{run:{id:'run-next'}}:{state:'ready',dispatchId:'dispatch-next'};
  });
  const first=f.service.start(f.scope,f.input);await vi.waitFor(()=>expect(f.call).toHaveBeenCalledTimes(1));
  const signal=new AbortController(),second=f.service.start(f.scope,{...f.input,requestId:randomUUID()},signal.signal);
  await Promise.resolve();await Promise.resolve();signal.abort();
  const cancelled=await second;expect(cancelled).toMatchObject({state:'stopped',active:false});
  const third=f.service.start(f.scope,{...f.input,requestId:randomUUID()});await Promise.resolve();await Promise.resolve();
  expect(f.call).toHaveBeenCalledTimes(1);release({run:{id:'run-first'}});
  await Promise.all([first,third]);expect(f.call.mock.calls.map(call=>call[0])).toEqual(['orchestration.runCreate','orchestration.workerStart','orchestration.runCreate','orchestration.workerStart']);
  await f.service.close();
 });

 it('does not bootstrap a runtime while reconciling a never-dispatched intent',async()=>{
  const f=fixture();f.connect.mockRejectedValueOnce(new HelmOrcaPreflightError('Invalid local artifact'));
  const record=await f.service.start(f.scope,f.input);expect(record).toMatchObject({state:'failed',active:false,stage:'connect'});
  expect(await f.service.recover(f.scope,record.id)).toEqual(record);
  expect(f.connect).toHaveBeenCalledTimes(1);expect(f.call).not.toHaveBeenCalled();await f.service.close();
 });

 it('reconciles a created run without dispatching a worker or retaining worker capacity',async()=>{
  const f=fixture();f.call.mockRejectedValueOnce(new Error('Run receipt lost'));
  const record=await f.service.start(f.scope,f.input);expect(record.stage).toBe('run');
  f.call.mockResolvedValue({requestId:record.requestId,state:'completed',method:'orchestration.runCreate',receipt:{run:{id:'recovered-run'}}});
  expect(await f.service.recover(f.scope,record.id)).toMatchObject({runId:'recovered-run',state:'failed',active:false});
  expect(f.call.mock.calls.map(c=>c[0])).toEqual(['orchestration.runCreate','orchestration.requestShow']);await f.service.close();
 });

});
