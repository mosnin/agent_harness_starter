import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {WorkbenchService,type WorkbenchEvent} from '../core/workbench-service';
import type {ChatRequest} from '../../hades/models/client';
vi.mock('../core/webhook-service',async()=>({WebhookService:(await import('./fixtures/offline-webhooks')).OfflineWebhookFixture}));
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(tool:string,input:object){
 const home=mkdtempSync(join(tmpdir(),'workbench-plugin-')),root=join(home,'project');mkdirSync(root);const events:WorkbenchEvent[]=[];
 const service=new WorkbenchService(join(home,'data'),event=>events.push(event),{NODE_ENV:'test',HADES_COMPANY_OS_BUNDLE:join(process.cwd(),'third_party/company-os/bundle.json')});cleanup.push(async()=>{await service.close();rmSync(home,{recursive:true,force:true});});
 await service.dispatch('project.add',{path:root});await service.dispatch('profile.save',{id:'default',name:'Offline',provider:'local',model:'fixture',baseUrl:'https://unused.invalid/v1'});
 const ec=(service as any).ecosystem;ec.unlock('a'.repeat(64));const account={id:'account',tenantId:'tenant',name:'Offline account'},write=vi.fn(async(..._args:unknown[])=>({applied:true}));
 ec.definitions=[{id:'stored',name:'Offline plugin',origin:'https://fixture.invalid',description:'Fixture',oauth:{issuer:'https://fixture.invalid',authorizationEndpoint:'https://fixture.invalid/authorize',tokenEndpoint:'https://fixture.invalid/token',userInfoEndpoint:'https://fixture.invalid/me',clientId:'native',scopes:['read','write'],readScopes:['read'],writeScopes:['write'],allowedOrigins:['https://fixture.invalid']},adapter:{account:(v:unknown)=>v,snapshot:async()=>({records:[]}),write}}];ec.fetcher=vi.fn(async()=>new Response(JSON.stringify(account),{headers:{'content-type':'application/json'}}));
 const c={profile:'default',pluginId:'stored',generation:'fixture',status:'connected',account,agentRead:true,agentWrite:true,scopes:['read','write']};ec.store.save(c,{accessToken:'FAKE',expiresAt:Date.now()+3600000,scopes:['read','write'],clientId:'native'});ec.store.commit(c,[{id:'one',collection:'items',title:'Only default profile',revision:'1',data:{}}],true);
 let calls=0;const chat=vi.fn(async()=>({text:++calls===1?`TOOL: ${tool}\nINPUT: ${JSON.stringify(input)}`:'ANSWER: Finished offline.',tokensIn:1,tokensOut:1,usd:0,model:'fixture',provider:'fixture',costMeasured:false}));vi.spyOn(service as any,'client').mockReturnValue({chat});
 const session=await service.dispatch('session.new',{root}) as {id:string};return {service,ec,write,events,chat,session,root};
}
const writeInput={pluginId:'stored',key:'stable-effect',collection:'items',id:'one',operation:'update',expectedRevision:'1',data:{name:'Changed'}};
const approval=async(f:Awaited<ReturnType<typeof fixture>>)=>{await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));return f.events.find(e=>e.kind==='desktop.approval')!;};
const done=async(f:Awaited<ReturnType<typeof fixture>>)=>vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));
it('actual conversation write waits for approval, then submits one scoped effect',async()=>{
 const f=await fixture('plugins_write',writeInput);await f.service.dispatch('chat.send',{id:f.session.id,input:'Update the fixture record.'});const a=await approval(f);expect(f.write).not.toHaveBeenCalled();await f.service.dispatch('approval.reply',{id:a.id,allow:true});await done(f);expect(f.write).toHaveBeenCalledOnce();expect(f.write.mock.calls[0][1]).toMatchObject({id:'account',tenantId:'tenant'});
});
it.each(['deny','stop'])('a %s at the approval gate prevents plugin writes',async action=>{
 const f=await fixture('plugins_write',writeInput);await f.service.dispatch('chat.send',{id:f.session.id,input:'Update the fixture record.'});const a=await approval(f);if(action==='deny')await f.service.dispatch('approval.reply',{id:a.id,allow:false});else await f.service.dispatch('chat.stop',{id:f.session.id});await done(f);expect(f.write).not.toHaveBeenCalled();
});
it('tool profile smuggling is refused and new profile has no other account records',async()=>{
 const f=await fixture('plugins_read',{pluginId:'stored',profile:'other'});await f.service.dispatch('profile.save',{id:'other',name:'Other',provider:'local',model:'fixture',baseUrl:'https://unused.invalid/v1'});expect(await f.service.dispatch('ecosystem.data',{profile:'other',pluginId:'stored'})).toMatchObject({total:0});await f.service.dispatch('chat.send',{id:f.session.id,profile:'default',input:'Read fixture data.'});await done(f);expect(JSON.stringify(f.events)).not.toContain('Only default profile');expect(JSON.stringify(f.chat.mock.calls)).toContain('Invalid plugin input');expect(f.write).not.toHaveBeenCalled();
});
it('disabled slash command refuses; enabled bundle supplies real framework and reader tool',async()=>{
 const f=await fixture('company_os_read',{});await expect(f.service.dispatch('chat.send',{id:f.session.id,input:'/company-os inspect'})).rejects.toThrow('Enable Company OS');expect(f.chat).not.toHaveBeenCalled();await f.service.dispatch('companyos.configure',{enabled:true});await f.service.dispatch('chat.send',{id:f.session.id,input:'/company-os inspect'});await done(f);const context=(f.service as any).companyOs.context('default');expect(JSON.stringify(f.chat.mock.calls)).toContain(JSON.stringify(context.content.slice(0,100)).slice(1,-1));expect(f.events.some(e=>e.kind==='desktop.tool'&&e.tool==='company_os_read'&&e.status==='done'&&e.ok)).toBe(true);
});
it('the real chat loop receives the complete bundled design skill through company_os_read',async()=>{
 const skill='company-os/ui-design-quality/vendor/emil-design-eng/SKILL.md';
 const f=await fixture('company_os_read',{skill});
 await f.service.dispatch('companyos.configure',{enabled:true});
 const expected=(f.service as any).companyOs.context('default',{skill,maxBytes:64000});
 expect(expected.bytes).toBeGreaterThan(24000);
 await f.service.dispatch('chat.send',{id:f.session.id,input:'/company-os review this interface using the installed design guidance.'});
 await done(f);
 const requests=f.chat.mock.calls as unknown as Array<[ChatRequest]>;
 expect(requests).toHaveLength(2);
 const observation=requests[1][0].messages.find(m=>m.content.startsWith('TOOL_RESULT: '));
 expect(observation).toBeDefined();
 const received=JSON.parse(observation!.content.slice('TOOL_RESULT: '.length));
 expect(received).toEqual(expected);
 expect(Buffer.byteLength(received.content)).toBe(expected.bytes);
 expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(false);
});
it('Workbench snapshot barrier drains plugin background work and blocks new chat admission',async()=>{
 const f=await fixture('plugins_list',{});f.ec.definitions[0].adapter.eventsEndpoint='https://fixture.invalid/events';const cancelled=vi.fn();f.ec.fetcher=vi.fn(async(url:string)=>url.endsWith('/events')?new Response(new ReadableStream({cancel:cancelled}),{headers:{'content-type':'text/event-stream'}}):new Response(JSON.stringify({id:'account',tenantId:'tenant',name:'Offline account'}),{headers:{'content-type':'application/json'}}));f.ec.tick();await vi.waitFor(()=>expect(f.ec.watches.size).toBe(1));
 let release!:()=>void;const waiting=new Promise<void>(r=>release=r);const operation=vi.fn(async()=>{expect(cancelled).toHaveBeenCalledOnce();await waiting;return 'snapshot-fixture';});const snapshot=(f.service as any).withMaintenanceSnapshot(operation);await vi.waitFor(()=>expect(operation).toHaveBeenCalledOnce());await expect(f.service.dispatch('chat.send',{id:f.session.id,input:'New work during backup'})).rejects.toThrow('backup');expect(f.chat).not.toHaveBeenCalled();release();expect(await snapshot).toBe('snapshot-fixture');await vi.waitFor(()=>expect(f.ec.watches.size).toBe(1));
});
