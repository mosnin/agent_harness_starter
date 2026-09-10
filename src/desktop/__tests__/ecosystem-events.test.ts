import {expect,it,vi} from 'vitest';
import {streamPluginEvents} from '../core/ecosystem-events';
const origin='https://fixture.invalid';
const fixture=(text:string)=>{const cancel=vi.fn();const fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));c.close();},cancel}),{headers:{'content-type':'text/event-stream'}}));return {fetcher,cancel};};
it('ignores payload authority and coalesces invalidations after initial catchup',async()=>{
 const f=fixture('event: change\ndata: {"url":"https://evil.invalid","token":"fake"}\n\nevent: change\ndata: {}\n\n');const change=vi.fn(async()=>{}),revoked=vi.fn();
 await streamPluginEvents(f.fetcher,[origin],origin+'/events','SECRET',new AbortController().signal,change,revoked);
 expect(change).toHaveBeenCalledTimes(2);expect(change.mock.calls.every(c=>c.length===0)).toBe(true);expect(revoked).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledOnce();
});
it('prioritizes revocation over a change in the same frame batch',async()=>{
 const f=fixture('event: change\ndata: {}\n\nevent: revoked\ndata: {}\n\n'),change=vi.fn(async()=>{}),revoked=vi.fn();
 await streamPluginEvents(f.fetcher,[origin],origin+'/events','SECRET',new AbortController().signal,change,revoked);expect(change).toHaveBeenCalledOnce();expect(revoked).toHaveBeenCalledOnce();
});
it('refuses unavailable events and oversized event payloads',async()=>{
 for(const text of ['event: unavailable\ndata: {}\n\n',`event: change\ndata: ${'x'.repeat(8193)}\n\n`]){const f=fixture(text);await expect(streamPluginEvents(f.fetcher,[origin],origin+'/events','SECRET',new AbortController().signal,async()=>{},()=>{})).rejects.toThrow();}
});
it('does not perform catchup for an already aborted request',async()=>{
 const f=fixture(''),change=vi.fn(async()=>{}),abort=new AbortController();abort.abort();await expect(streamPluginEvents(f.fetcher,[origin],origin+'/events','SECRET',abort.signal,change,()=>{})).rejects.toThrow();expect(change).not.toHaveBeenCalled();
});
it('refuses an unapproved event origin before transport',async()=>{
 const f=fixture('');await expect(streamPluginEvents(f.fetcher,[origin],'https://evil.invalid/events','SECRET',new AbortController().signal,async()=>{},()=>{})).rejects.toThrow('approved');expect(f.fetcher).not.toHaveBeenCalled();
});
it('cancels the active reader when the owning request aborts',async()=>{
 const cancel=vi.fn(),abort=new AbortController(),change=vi.fn(async()=>{});const fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({cancel}),{headers:{'content-type':'text/event-stream'}}));
 const job=streamPluginEvents(fetcher,[origin],origin+'/events','SECRET',abort.signal,change,()=>{});await vi.waitFor(()=>expect(change).toHaveBeenCalledOnce());abort.abort();await job.catch(()=>{});expect(cancel).toHaveBeenCalledOnce();
});
