import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {EcosystemService} from '../core/ecosystem-service';import type {PluginDefinition,PluginConnection} from '../core/ecosystem-types';
const clean:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of clean.splice(0))await fn();});
const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const deferred=()=>{let done!:(v:any)=>void;const promise=new Promise<any>(r=>done=r);return {done,promise};};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ecosystem-review-'));let time=100000;const account={id:'account',tenantId:'tenant',name:'Fixture'};
 const snapshot=vi.fn(async()=>({records:[{id:'one',collection:'items',title:'First',revision:'1',data:{safe:true}}],cursor:'c1'}));
 const write=vi.fn(async(request:any,_a:any,input:any)=>request('https://fixture.invalid/write',{method:'POST',body:JSON.stringify(input)}));
 const definition:PluginDefinition={id:'stored',name:'Fixture',origin:'https://fixture.invalid',description:'Offline fixture',oauth:{issuer:'https://fixture.invalid',authorizationEndpoint:'https://fixture.invalid/authorize',tokenEndpoint:'https://fixture.invalid/token',userInfoEndpoint:'https://fixture.invalid/me',clientId:'native',scopes:['read','write'],readScopes:['read'],writeScopes:['write'],allowedOrigins:['https://fixture.invalid']},adapter:{account:v=>v as typeof account,snapshot,write}};
 const fetcher=vi.fn(async(url:any,_init?:any)=>response(String(url).endsWith('/token')?{token_type:'Bearer',access_token:'SECRET_ACCESS',refresh_token:'SECRET_REFRESH',expires_in:3600,scope:'read write'}:String(url).endsWith('/me')?account:{ok:true}));
 const service=new EcosystemService(dir,()=>{},[definition],fetcher,()=>time);service.unlock('a'.repeat(64));const store=(service as any).store;
 const seed=(profile='p')=>{const c:PluginConnection={profile,pluginId:'stored',generation:'generation-'+profile,status:'connected',account,agentRead:true,agentWrite:true,scopes:['read','write']};store.save(c,{accessToken:'SECRET_ACCESS',refreshToken:'SECRET_REFRESH',expiresAt:time+3600000,scopes:['read','write'],clientId:'native'});return c;};
 clean.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});return {dir,service,store,seed,fetcher,definition,account,snapshot,write,setTime:(v:number)=>time=v};
}

it('reset snapshot discards revoked rows and resumes its newer checkpoint',async()=>{
 const f=fixture();f.seed();await f.service.sync('p','stored');const calls:string[]=[];
 f.snapshot.mockResolvedValueOnce({records:[{id:'fresh',collection:'items',title:'New snapshot',revision:'5',data:{safe:true}}],cursor:'c5'});
 f.definition.adapter!.changes=async(_r,_a,cursor)=>{calls.push(cursor!);if(cursor==='c1')return {resetSnapshot:true,cursor:'c2',hasMore:true,changes:[{record:{id:'one',collection:'items',title:'Revoked old row',data:{}}}]};if(cursor==='c5')return {cursor:'c6',changes:[{record:{id:'fresh',collection:'items',title:'Concurrent newer write',revision:'6',data:{}}}]};throw Error('Old feed replay');};
 await f.service.sync('p','stored');expect(calls).toEqual(['c1','c5']);expect(f.service.data('p','stored').records.map(r=>r.title)).toEqual(['Concurrent newer write']);expect(f.store.get('p','stored').cursor).toBe('c6');
});
it('rejects inconsistent paginated checkpoint without replacing cached rows',async()=>{
 const f=fixture();f.seed();await f.service.sync('p','stored');let count=0;
 f.snapshot.mockImplementation(async()=>++count===1?{records:[],cursor:'new1',nextPage:'page2'}:{records:[],cursor:'new2'});
 await expect(f.service.sync('p','stored')).rejects.toThrow('checkpoint changed');expect(f.store.get('p','stored').cursor).toBe('c1');expect(f.service.data('p','stored').total).toBe(1);
});
it('pre-aborted JSON does not dispatch even a fixture transport',async()=>{
 const {boundedPluginJson}=await import('../core/ecosystem-http');const abort=new AbortController();abort.abort();const fetcher=vi.fn(async()=>new Response(null,{status:204}));await expect(boundedPluginJson(fetcher,['https://fixture.invalid'],'https://fixture.invalid/write',{method:'POST',signal:abort.signal})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
it('pauses and drains an active stream with no late reconnect, then resumes explicitly',async()=>{
 const f=fixture();f.seed();f.definition.adapter!.eventsEndpoint='https://fixture.invalid/events';const cancelled=vi.fn();
 f.fetcher.mockImplementation(async(url:any)=>String(url).endsWith('/events')?new Response(new ReadableStream({cancel:cancelled}),{headers:{'content-type':'text/event-stream'}}):response(f.account));
 f.service.tick();await vi.waitFor(()=>expect(f.snapshot).toHaveBeenCalledOnce());await f.service.pauseBackground();expect(cancelled).toHaveBeenCalledOnce();const count=f.fetcher.mock.calls.length;f.service.tick();expect(f.fetcher).toHaveBeenCalledTimes(count);expect((f.service as any).reconnects.size).toBe(0);
 f.service.resumeBackground();await vi.waitFor(()=>expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/events'))).toHaveLength(2));await f.service.close();expect((f.service as any).reconnects.size).toBe(0);const final=f.fetcher.mock.calls.length;f.service.resumeBackground();f.service.tick();expect(f.fetcher).toHaveBeenCalledTimes(final);
});
it('HTTP401 stream invalidates agent permissions and never reconnects after pause',async()=>{
 const f=fixture();f.seed();f.definition.adapter!.eventsEndpoint='https://fixture.invalid/events';f.fetcher.mockResolvedValue(new Response(null,{status:401}));f.service.tick();await vi.waitFor(()=>expect(f.service.list('p')[0].status).toBe('error'));expect(f.service.list('p')[0]).toMatchObject({agentRead:false,agentWrite:false});await f.service.pauseBackground();expect((f.service as any).reconnects.size).toBe(0);
});
it('cancels a pending JSON reader rather than leaving shutdown waiting for bytes',async()=>{
 const {boundedPluginJson}=await import('../core/ecosystem-http');const abort=new AbortController(),cancel=vi.fn();const fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}}));const reading=boundedPluginJson(fetcher,['https://fixture.invalid'],'https://fixture.invalid/data',{signal:abort.signal});const settled=reading.catch(error=>error);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());abort.abort();await expect(settled).resolves.toBeInstanceOf(Error);expect(cancel).toHaveBeenCalledOnce();
});
it('a delayed watch rejection after pause cannot revoke grants or schedule replay',async()=>{
 const f=fixture();f.seed();f.definition.adapter!.eventsEndpoint='https://fixture.invalid/events';const hold=deferred();f.fetcher.mockImplementationOnce(async()=>hold.promise);f.service.tick();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());const paused=f.service.pauseBackground();hold.done(new Response(null,{status:401}));await paused;expect(f.service.list('p')[0]).toMatchObject({status:'connected',agentRead:true,agentWrite:true});expect((f.service as any).reconnects.size).toBe(0);
});
it('disconnect cancels reconnect while prior remote revocation is pending',async()=>{
 const f=fixture();f.seed();f.definition.oauth!.revocationEndpoint='https://fixture.invalid/revoke';const hold=deferred();f.fetcher.mockImplementationOnce(async()=>hold.promise);
 const connecting=f.service.connect('p','stored');await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());await f.service.disconnect('p','stored');hold.done(response({}));
 await expect(connecting).rejects.toThrow('changed');expect(f.service.list('p')[0].status).toBe('disconnected');
});
it('a newer connect supersedes an older connect waiting for revocation',async()=>{
 const f=fixture();f.seed();f.definition.oauth!.revocationEndpoint='https://fixture.invalid/revoke';const hold=deferred();f.fetcher.mockImplementationOnce(async()=>hold.promise);
 const older=f.service.connect('p','stored');await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());const newer=await f.service.connect('p','stored');hold.done(response({}));
 await expect(older).rejects.toThrow('changed');expect(f.store.get('p','stored').generation).toBe(newer.requestId);
});
