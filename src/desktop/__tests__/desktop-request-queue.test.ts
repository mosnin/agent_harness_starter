import { expect, it, vi } from 'vitest';
import { DesktopRequestQueue } from '../core/desktop-request-queue';
const deferred=()=>{let done!:(value?:any)=>void;const promise=new Promise<any>(r=>done=r);return {promise,done};};
const request=(id:string,args?:unknown)=>({id,method:'helm.orca.start',args});
it('lets reserved Stop bypass blocked start and inspection floods',async()=>{
 const q=new DesktopRequestQueue({serial:2,inspection:1,control:1}),hold=deferred(),seen:string[]=[];
 const start=q.submit(request('a'),'serial',()=>hold.promise);
 const inspection=q.submit(request('status'),'inspection',()=>hold.promise);
 await expect(q.submit(request('overflow'),'inspection',()=>{})).rejects.toMatchObject({code:'capacity'});
 await q.submit(request('stop'),'control',()=>seen.push('stop'));expect(seen).toEqual(['stop']);hold.done();await Promise.all([start,inspection]);await q.close();
});
it('cancels queued exact scoped starts while preserving another profile and active duplicate uncertainty',async()=>{
 const q=new DesktopRequestQueue(),hold=deferred(),called=vi.fn();
 const a=q.submit(request('active',{root:'/p',profile:'one',requestId:'same'}),'serial',()=>hold.promise);
 const b=q.submit(request('queued',{root:'/p',profile:'one',requestId:'same'}),'serial',called);const rejected=expect(b).rejects.toMatchObject({code:'cancelled_before_admission'});
 const c=q.submit(request('foreign',{root:'/p',profile:'two',requestId:'same'}),'serial',called);
 const cancelled=q.cancelQueued(r=>r.method==='helm.orca.start'&&JSON.stringify(r.args)===JSON.stringify({root:'/p',profile:'one',requestId:'same'}));
 expect(cancelled).toEqual({cancelledBeforeAdmission:1,requestIds:['queued']});await rejected;expect(called).not.toHaveBeenCalled();hold.done();await Promise.all([a,c]);expect(called).toHaveBeenCalledOnce();await q.close();
});
it('preserves mutation ordering after thrown and rejected handlers',async()=>{
 const q=new DesktopRequestQueue(),seen:number[]=[];
 const a=q.submit(request('a'),'serial',()=>{seen.push(1);throw Error('failure');});const failed=expect(a).rejects.toThrow('failure');
 const b=q.submit(request('b'),'serial',async()=>{seen.push(2);throw Error('rejected');});const rejected=expect(b).rejects.toThrow('rejected');
 const c=q.submit(request('c'),'serial',()=>seen.push(3));await Promise.all([failed,rejected,c]);expect(seen).toEqual([1,2,3]);await q.close();
});
it('enforces each lane capacity and closes queued work while waiting for every active lane',async()=>{
 const q=new DesktopRequestQueue({serial:2,inspection:1,control:1}),hold=deferred(),signals:AbortSignal[]=[];
 const handler=({signal}:{signal:AbortSignal})=>{signals.push(signal);return hold.promise;};
 const active=['serial','inspection','control'].map((lane,i)=>q.submit(request(String(i)),lane as any,(_r,c)=>handler(c)));
 const queued=q.submit(request('queued'),'serial',vi.fn());const rejection=expect(queued).rejects.toMatchObject({code:'closed'});
 await expect(q.submit(request('over'),'serial',()=>{})).rejects.toMatchObject({code:'capacity'});
 await expect(q.submit(request('over-control'),'control',()=>{})).rejects.toMatchObject({code:'capacity'});
 let closed=false;const closing=q.close().then(()=>closed=true);await rejection;expect(signals.every(s=>s.aborted)).toBe(true);expect(closed).toBe(false);
 await expect(q.submit(request('late'),'control',()=>{})).rejects.toMatchObject({code:'closed'});
 hold.done();await Promise.all(active);await closing;expect(closed).toBe(true);
});
it('does not interpret a duplicate request identity as safe to replay or already stopped',async()=>{
 const q=new DesktopRequestQueue(),handler=vi.fn(()=>({state:'unknown'}));
 expect(q.cancelQueued(()=>true)).toEqual({cancelledBeforeAdmission:0,requestIds:[]});
 await q.submit(request('same'),'serial',handler);await q.submit(request('same'),'serial',handler);
 expect(handler).toHaveBeenCalledTimes(2);await q.drain();expect(q.cancelQueued(()=>true).cancelledBeforeAdmission).toBe(0);await q.close();
});
