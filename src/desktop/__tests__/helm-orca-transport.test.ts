import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({socket:undefined as any}));
vi.mock('node:net',()=>({createConnection:()=>state.socket}));
import { orcaRequest } from '../core/helm-orca-transport';
beforeEach(()=>{const s=new EventEmitter() as any;s.setEncoding=vi.fn();s.destroy=vi.fn();s.write=vi.fn();state.socket=s;});
const meta={runtimeId:'r',pid:1,authToken:'fixture-secret',transports:[{kind:'unix',endpoint:'/fixture-only'}]};
function sent(){state.socket.emit('connect');return JSON.parse(state.socket.write.mock.calls[0][0]);}
describe('Orca public JSON-lines transport parser without sockets',()=>{
 it('sends pinned mutation envelope and parses fragmented frames',async()=>{const p=orcaRequest(meta,'orchestration.workerStart',{}, {requestId:'stable'});const q=sent();expect(q.orchestrationContractVersion).toBe(1);expect(q.orchestrationRequestId).toBe('stable');const frame=JSON.stringify({id:q.id,ok:true,_meta:{runtimeId:'r'},result:{state:'ready'}})+'\n';state.socket.emit('data',frame.slice(0,15));state.socket.emit('data',frame.slice(15));expect(await p).toEqual({state:'ready'});});
 it('refuses stale runtime response',async()=>{const p=orcaRequest(meta,'status.get',null);const q=sent();state.socket.emit('data',JSON.stringify({id:q.id,ok:true,_meta:{runtimeId:'other'},result:{}})+'\n');await expect(p).rejects.toThrow('identity');});
 it('cancellation destroys connection without retry',async()=>{const c=new AbortController();const p=orcaRequest(meta,'x',{}, {signal:c.signal});sent();c.abort();await expect(p).rejects.toThrow('unknown');expect(state.socket.destroy).toHaveBeenCalledOnce();expect(state.socket.write).toHaveBeenCalledOnce();});
 it('bounds response and sanitizes error content',async()=>{const p=orcaRequest(meta,'x',{});sent();state.socket.emit('data','x'.repeat(2*1024*1024+1));await expect(p).rejects.toThrow('bound');});
 it('keepalive does not extend total deadline',async()=>{vi.useFakeTimers();try{const p=orcaRequest(meta,'x',{}, {timeoutMs:20});const rejection=expect(p).rejects.toThrow('deadline');sent();state.socket.emit('data','{"_keepalive":true}\n');await vi.advanceTimersByTimeAsync(21);await rejection;}finally{vi.useRealTimers();}});
});
