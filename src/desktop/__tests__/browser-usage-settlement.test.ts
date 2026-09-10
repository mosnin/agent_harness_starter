import {expect,it,vi} from 'vitest';
import {WorkbenchService} from '../core/workbench-service';
// Exercise the real event handler with injected transport/session storage; no listeners/providers.
function settle(usage:unknown, prior:Record<string,unknown>={tokens:7,runtimeMs:3,inFlight:true},state='running') {
 const host=Object.create(WorkbenchService.prototype) as any;
 const frames:Array<{type:string;payload:any}>=[];
 const browser={status:()=>({connected:true}),emit:(_profile:string,type:string,payload:any)=>frames.push({type,payload})};
 host.browser=browser;host.settings={sessionMeta:{session:{source:'browser',browserTaskUsage:{...prior}}},jobs:[]};
 host.progress=new Map([['session',{...(usage===undefined?{}:{usage})}]]);host.active=new Map();host.save=vi.fn();
 host.sessions=()=>({get:()=>({messages:[{role:'assistant',content:'Task result'}]})});
 host.browserRuns=new Map([['session',{client:browser,profile:'default',runId:'run',state,turnStartedAt:Date.now()-5,task:{goal:'Task',budget:{maxTokens:1000,maxDurationMs:10000}},evidence:{sources:[],artifacts:[]}}]]);
 host.forwardBrowserEvent({kind:'desktop.done',session:'session'});
 return {host,frames,consumed:host.settings.sessionMeta.session.browserTaskUsage};
}
for(const [name,usage] of [
 ['missing receipt',undefined],['missing counts',{usageComplete:true}],['negative count',{tokensIn:-1,tokensOut:3,usageComplete:true}],
 ['string count',{tokensIn:'10',tokensOut:3,usageComplete:true}],['NaN',{tokensIn:NaN,tokensOut:3,usageComplete:true}],
 ['overflow',{tokensIn:Number.MAX_SAFE_INTEGER,tokensOut:3,usageComplete:true}],
] as const) it(`marks ${name} unknown and refuses successful completion`,()=>{
 const {consumed,frames,host}=settle(usage);expect(consumed.usageUnknown).toBe(true);expect(consumed.tokens).toBe(7);
 expect(consumed.inFlight).toBe(false);expect(host.save).toHaveBeenCalled();
 expect(frames.find(f=>f.type==='task.finished')?.payload.status).toBe('failed');
});
it('adds complete nonnegative usage and accepts an actual zero report',()=>{
 for(const tokensIn of [0,10]){const {consumed,frames}=settle({tokensIn,tokensOut:0,usageComplete:true});expect(consumed.tokens).toBe(7+tokensIn);expect(consumed.usageUnknown).not.toBe(true);expect(frames.find(f=>f.type==='task.finished')?.payload.status).toBe('done');}
});
it('retains valid partial measurements while keeping unknown usage sticky',()=>{
 const partial=settle({tokensIn:10,tokensOut:5,usageComplete:false});expect(partial.consumed).toMatchObject({tokens:22,usageUnknown:true});
 const next=settle({tokensIn:1,tokensOut:2,usageComplete:true},partial.consumed);expect(next.consumed).toMatchObject({tokens:25,usageUnknown:true});
 expect(next.frames.find(f=>f.type==='task.finished')?.payload.status).toBe('failed');
});

it('cancellation preserves its status while retaining unknown usage',()=>{
 const {consumed,frames}=settle(undefined,undefined,'cancelled');expect(consumed.usageUnknown).toBe(true);
 expect(frames.find(f=>f.type==='task.finished')?.payload.status).toBe('cancelled');
});
it('refuses aggregate overflow without corrupting retained measurements',()=>{
 const {consumed,frames}=settle({tokensIn:1,tokensOut:0,usageComplete:true},{tokens:Number.MAX_SAFE_INTEGER,runtimeMs:0});
 expect(consumed.tokens).toBe(Number.MAX_SAFE_INTEGER);expect(consumed.usageUnknown).toBe(true);
 expect(frames.find(f=>f.type==='task.finished')?.payload.status).toBe('failed');
});
