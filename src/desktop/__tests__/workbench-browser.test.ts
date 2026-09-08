import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchService } from '../core/workbench-service';
const services:WorkbenchService[]=[],servers:Server[]=[],websockets:WebSocketServer[]=[],roots:string[]=[];
afterEach(async()=>{services.splice(0).forEach(s=>s.close());servers.splice(0).forEach(s=>{s.closeAllConnections();s.close();});await Promise.all(websockets.splice(0).map(s=>new Promise<void>(r=>{for(const c of s.clients)c.terminate();s.close(()=>r());})));roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true}));});
async function fixture(mode='flow') {
 const root=mkdtempSync(join(tmpdir(),'hades-browser-integration-'));roots.push(root);const events:any[]=[],modelRequests:any[]=[],frames:any[]=[];let socket!:WebSocket;let sourceContent="Price: $10";
 const ws=new WebSocketServer({host:'127.0.0.1',port:0});websockets.push(ws);await new Promise<void>(r=>ws.once('listening',r));const endpoint='ws://127.0.0.1:'+(ws.address() as any).port;
 ws.on('connection',s=>{socket=s;s.on('message',raw=>{const e=JSON.parse(raw.toString());frames.push(e);if(e.kind!=='request')return;let payload:any;
 if(e.type==='handshake')payload={ok:true,sessionId:'browser-session',protocol:'1.0.0',serverCapabilities:['tools','page','runs','context']};
 if(e.type==='agents.announce')payload={ok:true};
 if(e.type==='tool.call')payload={callId:e.payload.callId,ok:true,value:e.payload.name==='browser.readPage'?{tabId:'tab',url:'https://example.test',title:'Source',content:sourceContent}:e.payload.name==='page.snapshot'?{tabId:'tab',nodes:[{ref:'s1r1',role:'button',name:'Save'}]}:{tabs:[{id:'tab',title:'Fixture',url:'https://example.test'}]}};
 s.send(JSON.stringify({id:randomUUID(),protocol:'1.0.0',kind:'response',type:e.type+'.result',at:Date.now(),sessionId:e.sessionId,replyTo:e.id,payload}));});});
 const server=createServer((req,res)=>{let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{const body=JSON.parse(raw);modelRequests.push(body);const index=modelRequests.length-1;
 let content='ANSWER: Completed the browser task.';
 if(mode==='flow'&&index<3)content='TOOL: hades_browser\nINPUT: '+JSON.stringify(index===0?{name:'browser.listTabs',args:{}}:index===1?{name:'page.snapshot',args:{tabId:'tab'}}:{name:'page.click',args:{tabId:'tab',ref:'s1r1'}});
 if(((mode==='research'||mode==='research-memory')&&index===0)||(mode==='watch'&&index%2===0))content='TOOL: hades_browser\nINPUT: '+JSON.stringify({name:'browser.readPage',args:{tabId:'tab'}});
 if(mode==='research-memory'&&index===1)content='TOOL: hades_browser\nINPUT: '+JSON.stringify({name:'context.write',args:{kind:'note',title:'Research',body:'Observed price'}});
 if(mode==='readonly'&&index===0)content='TOOL: hades_browser\nINPUT: '+JSON.stringify({name:'page.click',args:{tabId:'tab',ref:'s1r1'}});
 if(mode==='pause'&&index<2)content='TOOL: hades_browser\nINPUT: '+JSON.stringify({name:'page.click',args:{tabId:'tab',ref:'s1r1'}});
 if(mode==='scope-escape'&&index===0)content='TOOL: file_ops\nINPUT: '+JSON.stringify({op:'write',path:'escaped.txt',content:'must not write'});
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content}}],usage:{prompt_tokens:10,completion_tokens:5}})+'\n\ndata: [DONE]\n\n');});});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const env:NodeJS.ProcessEnv={NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'};const data=join(root,'data');const service=new WorkbenchService(data,e=>events.push(e),env);services.push(service);
 await service.dispatch('project.add',{path:root});await service.dispatch('profile.save',{id:'default',name:'Bound profile',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:'+(server.address() as any).port+'/v1'});
 await service.dispatch('browser.configure',{endpoint,enabled:true,profile:'default',root});await service.dispatch('key.set',{account:'hades-browser',key:'fixture-browser-token-123456789'});await service.dispatch('browser.connect',{});
 const send=(type:string,payload:any,kind='request')=>{const id=randomUUID();socket.send(JSON.stringify({id,protocol:'1.0.0',kind,type,at:Date.now(),sessionId:'browser-session',payload}));return id;};
 return {root,data,service,events,frames,modelRequests,send,env,endpoint,setSource:(value:string)=>{sourceContent=value;}};
}
it('admits browser chat into the bound durable native session and executes an approved browser task',async()=>{
 const f=await fixture();const request=f.send('chat.send',{agentId:'hades-default',threadId:'browser-thread',text:'Inspect and click Save',profile:'untrusted'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const ack=f.frames.find(e=>e.replyTo===request).payload;expect(ack).toMatchObject({ok:true,threadId:'browser-thread'});expect(ack.runId).toBeTruthy();
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const approval=f.events.find(e=>e.kind==='desktop.approval');
 expect(f.frames.filter(e=>e.type==='tool.call').map(e=>e.payload.name)).toEqual(['browser.listTabs','page.snapshot']);
 await f.service.dispatch('approval.reply',{id:approval.id,allow:true});await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 expect(f.frames.find(e=>e.type==='task.finished').payload.status).toBe('done');expect(f.frames.filter(e=>e.type==='tool.call').map(e=>e.payload.name)).toEqual(['browser.listTabs','page.snapshot','page.click']);
 const session:any=await f.service.dispatch('session.get',{id:approval.session});expect(session).toMatchObject({source:'browser',profile:'default',browserThread:'browser-thread',root:realpathSync(f.root)});
 expect(session.messages.at(-1).content).toContain('Completed');expect(f.frames.find(e=>e.type==='agent.message').payload.threadId).toBe('browser-thread');
 expect(readFileSync(join(f.data,'desktop.json'),'utf8')).not.toContain('fixture-browser-token');expect(statSync(join(f.data,'desktop.json')).mode&0o777).toBe(0o600);
 f.service.close();const restored=new WorkbenchService(f.data,()=>{},f.env);services.push(restored);expect(await restored.dispatch('browser.status',{})).toMatchObject({enabled:true,connected:false,profile:'default'});
 await expect(restored.dispatch('browser.connect',{})).rejects.toThrow('Keychain');expect((await restored.dispatch('session.get',{id:approval.session}) as any).messages).toEqual(session.messages);
});
it('pausing while approval waits prevents late effects; explicit resume requires a new approval',async()=>{
 const f=await fixture('pause');const request=f.send('chat.send',{agentId:'hades-default',threadId:'thread',text:'Click Save'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const runId=f.frames.find(e=>e.replyTo===request).payload.runId;
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const first=f.events.find(e=>e.kind==='desktop.approval');
 f.send('task.control',{runId,action:'pause'},'event');await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));await f.service.dispatch('approval.reply',{id:first.id,allow:true});
 expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(0);expect(await f.service.dispatch('browser.status',{})).toMatchObject({connected:true});
 f.send('task.control',{runId,action:'resume'},'event');await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.approval')).toHaveLength(2));
 const second=f.events.filter(e=>e.kind==='desktop.approval')[1];await f.service.dispatch('approval.reply',{id:second.id,allow:true});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(1);expect(f.modelRequests[1].messages.some((m:any)=>typeof m.content==='string'&&m.content.includes('explicitly resumed'))).toBe(true);
});
it('disconnecting before approval resolves stops the native turn and cannot authorize a late browser input',async()=>{
 const f=await fixture('pause');f.send('chat.send',{agentId:'hades-default',text:'Click Save'});await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const approval=f.events.find(e=>e.kind==='desktop.approval');
 await f.service.dispatch('browser.disconnect',{});await f.service.dispatch('approval.reply',{id:approval.id,allow:true});await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(0);expect(await f.service.dispatch('browser.status',{})).toMatchObject({connected:false});
});
it('keeps capture responses in their original thread and admits images into the selected native profile',async()=>{
 const f=await fixture('answer');const request=f.send('capture.submit',{agentId:'hades-default',threadId:'capture-original',capture:{id:'capture',kind:'tab',dataUrl:'data:image/png;base64,YQ==',width:1,height:1,capturedAt:1},prompt:'Explain this screenshot'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='agent.message')).toBe(true));
 expect(f.frames.find(e=>e.replyTo===request).payload.threadId).toBe('capture-original');expect(f.frames.find(e=>e.type==='agent.message').payload.threadId).toBe('capture-original');expect(JSON.stringify(f.modelRequests[0])).toContain('data:image/png;base64,YQ==');
});
it('does not expose the browser tool to a different profile or let maintenance race admission',async()=>{
 const f=await fixture('answer');const peer:any=await f.service.dispatch('profile.save',{name:'Other',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:'+(servers.at(-1)!.address() as any).port+'/v1'});
 const session:any=await f.service.dispatch('session.new',{root:f.root,profile:peer.id});await f.service.dispatch('chat.send',{id:session.id,profile:peer.id,input:'Say hello'});await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));expect(JSON.stringify(f.modelRequests[0])).not.toContain('hades_browser');
 (f.service as any).maintenanceBusy=true;const request=f.send('chat.send',{agentId:'hades-default',text:'New work during backup'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));expect(f.frames.find(e=>e.replyTo===request).payload.error).toBeTruthy();(f.service as any).maintenanceBusy=false;expect(f.modelRequests).toHaveLength(1);
});

it('mirrors approvals in the browser and binds answers to the exact pending action', async()=>{
 const f=await fixture();f.send('chat.send',{agentId:'hades-default',threadId:'approval-thread',text:'Inspect and click Save'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.needsInput')).toBe(true));
 const question=f.frames.find(e=>e.type==='task.needsInput').payload;
 expect(question.question.options).toEqual(['Allow once','Deny']);
 expect(question.question.id).toBe(f.events.find(e=>e.kind==='desktop.approval').id);
 const wrong=f.send('task.control',{runId:question.runId,action:'answer',questionId:'stale-approval',answer:'Allow once'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===wrong)).toBe(true));
 expect(f.frames.find(e=>e.replyTo===wrong).payload.error).toBeTruthy();
 expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(2);
 f.send('task.control',{runId:question.runId,action:'answer',questionId:question.question.id,answer:'Allow once'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(3);
});

it('enforces a browser-only tool registry, records its scope, and refuses an unselected model action',async()=>{
 const f=await fixture('scope-escape');
 await f.service.dispatch('profile.save',{id:'default',name:'Bound profile',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:'+(servers.at(-1)!.address() as any).port+'/v1',mcp:JSON.stringify([{name:'unselected',enabled:true,command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(join(f.root,'mcp-started'))},'started')`]}])});
 const session:any=await f.service.dispatch('session.new',{root:f.root});
 await f.service.dispatch('chat.send',{id:session.id,input:'Only use the browser',toolAllowlist:['hades_browser']});
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));
 const system=f.modelRequests[0].messages[0].content;
 expect(system).toContain('- hades_browser:');expect(system).not.toContain('- file_ops:');expect(system).not.toContain('- delegate_work:');expect(system).not.toContain('- calc:');
 expect(existsSync(join(f.root,'escaped.txt'))).toBe(false);expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(false);
 expect(existsSync(join(f.root,'mcp-started'))).toBe(false);
 expect(f.events.some(e=>e.kind==='desktop.tool'&&e.tool==='file_ops'&&e.ok===false&&e.output.includes('unknown tool'))).toBe(true);
 const context=join(f.data,'context',session.id);const receipt=JSON.parse(readFileSync(join(context,readdirSync(context)[0],'run.json'),'utf8'));
 expect(receipt.toolAllowlist).toEqual(['hades_browser']);expect(receipt.effectiveTools).toEqual(['hades_browser','context_read']);
 expect(receipt.modelBudgets).toHaveLength(2);expect(receipt.modelBudgets[1].usedTokens).toBe(15);
});

it('validates tool scopes before starting work and refuses unknown, duplicate, unavailable and unsupported names',async()=>{
 const f=await fixture('answer');const session:any=await f.service.dispatch('session.new',{root:f.root});
 for(const toolAllowlist of [[],['hades_browser','hades_browser'],['unknown'],['shell'],['delegate_work'],['mcp_unknown'],'hades_browser',[null]])
  await expect(f.service.dispatch('chat.send',{id:session.id,input:'Work',toolAllowlist})).rejects.toThrow(/Tool scope/);
 expect(f.modelRequests).toHaveLength(0);expect(f.events.some(e=>e.kind==='desktop.started')).toBe(false);expect(f.frames.some(e=>e.type==='task.started')).toBe(false);
});

it('inherits scope across normal continuation and restart, and refuses widening',async()=>{
 const f=await fixture('answer');const session:any=await f.service.dispatch('session.new',{root:f.root});
 await f.service.dispatch('chat.send',{id:session.id,input:'First',toolAllowlist:['hades_browser']});
 await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.done')).toHaveLength(1));
 await f.service.dispatch('chat.send',{id:session.id,input:'Continue'});
 await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.done')).toHaveLength(2));
 await expect(f.service.dispatch('chat.send',{id:session.id,input:'Widen',toolAllowlist:['hades_browser','file_ops']})).rejects.toThrow('cannot be widened');
 f.service.close();const restored=new WorkbenchService(f.data,e=>f.events.push(e),f.env);services.push(restored);
 expect(await restored.dispatch('session.get',{id:session.id})).toMatchObject({toolAllowlist:['hades_browser']});
 await expect(restored.dispatch('chat.send',{id:session.id,input:'Continue without connection'})).rejects.toThrow('unavailable');
 await restored.dispatch('key.set',{account:'hades-browser',key:'fixture-browser-token-123456789'});await restored.dispatch('browser.connect',{});
 await restored.dispatch('chat.send',{id:session.id,input:'Continue after restart'});
 await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.done')).toHaveLength(3));
 expect(f.modelRequests).toHaveLength(3);expect(f.modelRequests.every(r=>r.messages[0].content.includes('- hades_browser:')&&!r.messages[0].content.includes('- file_ops:'))).toBe(true);
});

it('preserves a scoped browser run during automatic pause/resume continuation',async()=>{
 const f=await fixture('pause');const session:any=await f.service.dispatch('session.new',{root:f.root});
 await f.service.dispatch('chat.send',{id:session.id,input:'Click Save',toolAllowlist:['hades_browser']});
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const runId=f.frames.find(e=>e.type==='task.started').payload.runId;
 f.send('task.control',{runId,action:'pause'},'event');await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));
 f.send('task.control',{runId,action:'resume'},'event');await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.approval')).toHaveLength(2));
 const approval=f.events.filter(e=>e.kind==='desktop.approval')[1];await f.service.dispatch('approval.reply',{id:approval.id,allow:true});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 expect(f.modelRequests.every(r=>r.messages[0].content.includes('- hades_browser:')&&!r.messages[0].content.includes('- file_ops:'))).toBe(true);
});

it('rejects invalid browser task budgets before a model starts and scopes valid tasks to browser tools',async()=>{
 const f=await fixture('answer');
 const bad=f.send('chat.send',{text:'Research',task:{goal:'Research',plan:[],budget:{maxTokens:-1,maxDurationMs:1000}}});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===bad)).toBe(true));expect(f.frames.find(e=>e.replyTo===bad).payload.error).toBeTruthy();expect(f.modelRequests).toHaveLength(0);
 f.send('chat.send',{text:'Research',task:{goal:'Bounded research',plan:[{id:'read',text:'Read sources',status:'pending'}],budget:{maxTokens:100000,maxDurationMs:10000},readOnly:true}});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));expect(f.frames.find(e=>e.type==='task.started').payload.task.goal).toBe('Bounded research');
 expect(f.modelRequests[0].messages[0].content).toContain('hades_browser');expect(f.modelRequests[0].messages[0].content).not.toContain('- shell:');
});
it('persists browser watch intent through the existing scheduler and disables it on cancellation',async()=>{
 const f=await fixture('answer');
 const request=f.send('recipe.schedule',{recipeId:'watch-one',name:'Watch pages',prompt:'Compare prices',workspaceId:'work',urls:['https://example.com'],budget:{maxTokens:100000,maxDurationMs:10000},intervalMinutes:60});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));expect(f.frames.find(e=>e.replyTo===request).payload).toMatchObject({ok:true,job:{recipeId:'watch-one',localOnly:true,enabled:true}});
 const persisted=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8'));expect(persisted.jobs).toHaveLength(1);expect(persisted.jobs[0].browser.task.readOnly).toBe(true);
 const list=f.send('recipe.list',{});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===list)).toBe(true));expect(f.frames.find(e=>e.replyTo===list).payload.jobs).toHaveLength(1);
 const cancel=f.send('recipe.cancel',{recipeId:'watch-one'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===cancel)).toBe(true));expect(f.frames.find(e=>e.replyTo===cancel).payload.job.enabled).toBe(false);
});
it('pairs using an ephemeral browser token without persisting the credential',async()=>{
 const f=await fixture('answer');await f.service.dispatch('browser.disconnect',{});
 await f.service.dispatch('browser.pair',{endpoint:f.endpoint,token:'fixture-ephemeral-token',root:f.root});
 expect(await f.service.dispatch('browser.status',{})).toMatchObject({connected:true});expect(readFileSync(join(f.data,'desktop.json'),'utf8')).not.toContain('fixture-ephemeral-token');
 expect(await f.service.dispatch('browser.readiness',{})).toMatchObject({providerReady:true,connected:true});
});
it('forwards actual read source excerpts and saves a source-linked notebook',async()=>{
 const f=await fixture('research');f.send('chat.send',{text:'Research the source'});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 expect(f.frames.find(e=>e.type==='agent.message').payload.citations).toMatchObject([{url:'https://example.test/',label:'Source',excerpt:'Price: $10'}]);
 expect(f.frames.find(e=>e.type==='task.finished').payload.notebook).toMatchObject({body:'Completed the browser task.',sources:[{url:'https://example.test/',title:'Source',excerpt:'Price: $10'}]});
});
it('blocks a read-only task model from requesting form effects even before approval',async()=>{
 const f=await fixture('readonly');f.send('chat.send',{text:'Observe',task:{goal:'Observe',plan:[],budget:{maxTokens:100000,maxDurationMs:10000},readOnly:true}});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(0);expect(f.events.filter(e=>e.kind==='desktop.approval')).toHaveLength(0);expect(JSON.stringify(f.modelRequests)).toContain('read-only');
});
it('a disconnected scheduled browser wake records failure and never falls back to native tools',async()=>{
 const f=await fixture('answer');const request=f.send('recipe.schedule',{recipeId:'watch-two',name:'Observe',prompt:'Observe prices',workspaceId:'work',urls:['https://example.com'],budget:{maxTokens:100000,maxDurationMs:10000},intervalMinutes:60});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const job=f.frames.find(e=>e.replyTo===request).payload.job;
 await f.service.dispatch('browser.disconnect',{});await f.service.dispatch('job.run',{id:job.id});
 const runs:any=await f.service.dispatch('job.runs',{id:job.id});expect(runs[0]).toMatchObject({status:'failed'});expect(runs[0].error).toContain('Browser is unavailable');expect(f.modelRequests).toHaveLength(0);
});
it('runs watches through durable wakes, establishes a baseline and suppresses duplicate notebooks',async()=>{
 const f=await fixture('watch');const request=f.send('recipe.schedule',{recipeId:'watch-three',name:'Observe',prompt:'Observe prices',workspaceId:'work',urls:['https://example.test'],budget:{maxTokens:100000,maxDurationMs:10000},intervalMinutes:60});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const job=f.frames.find(e=>e.replyTo===request).payload.job;
 for(let n=1;n<=3;n++){
  if(n===3) f.setSource('Price: $12');
  await f.service.dispatch('job.run',{id:job.id});
  await vi.waitFor(()=>expect(f.frames.filter(e=>e.type==='task.finished')).toHaveLength(n));
  await vi.waitFor(async()=>expect((await f.service.dispatch('job.runs',{id:job.id}) as any[]).filter(r=>r.status==='completed')).toHaveLength(n));
  const delivery=f.frames.filter(e=>e.type==='notebook.deliver').at(-1); if(delivery){const ack=f.send('notebook.ack',{runId:delivery.payload.runId});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===ack)).toBe(true));}
 }
 const finished=f.frames.filter(e=>e.type==='task.finished'),delivered=f.frames.filter(e=>e.type==='notebook.deliver');expect(delivered).toHaveLength(2);expect(finished[1].payload.notebook).toBeUndefined();expect(finished[1].payload.summary).toContain('No change');expect(delivered[1].payload.notebook.sources[0].excerpt).toBe('Price: $12');
 expect(f.frames.filter(e=>e.type==='task.started').every(e=>e.payload.task.readOnly&&e.payload.workspaceId==='work')).toBe(true);
 expect(f.modelRequests.every(request=>request.messages[0].content.includes('automatic ResearchNotebook storage'))).toBe(true);
});
it('recovery refuses mutation without a fresh snapshot even after approval',async()=>{
 const f=await fixture('readonly');f.send('chat.send',{text:'Resume remaining work',task:{goal:'Resume',plan:[],budget:{maxTokens:100000,maxDurationMs:10000},recovery:{previousRunId:'interrupted-run'}}});
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));await f.service.dispatch('approval.reply',{id:f.events.find(e=>e.kind==='desktop.approval').id,allow:true});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(0);expect(JSON.stringify(f.modelRequests)).toContain('Re-observe this tab');
});
it('pauses before an over-budget provider request and resumes only after an explicit bounded extension',async()=>{
 const f=await fixture('answer');f.send('chat.send',{text:'Research',task:{goal:'Research',plan:[],budget:{maxTokens:1000,maxDurationMs:10000}}});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.paused')).toBe(true));const paused=f.frames.find(e=>e.type==='task.paused').payload;expect(paused.reason).toBe('budget');expect(f.modelRequests).toHaveLength(0);
 const resume=f.send('task.control',{runId:paused.runId,action:'resume'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===resume)).toBe(true));expect(f.frames.find(e=>e.replyTo===resume).payload.error).toBeTruthy();
 const invalid=f.send('task.control',{runId:paused.runId,action:'extend',budget:{maxTokens:2000000,maxDurationMs:0}});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===invalid)).toBe(true));expect(f.frames.find(e=>e.replyTo===invalid).payload.error).toBeTruthy();expect(f.frames.filter(e=>e.type==='task.resumed')).toHaveLength(0);
 const extend=f.send('task.control',{runId:paused.runId,action:'extend',budget:{maxTokens:99000,maxDurationMs:0}});await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));expect(f.frames.find(e=>e.type==='task.resumed').payload.task.budget.maxTokens).toBe(100000);expect(f.frames.find(e=>e.type==='task.finished').payload).toMatchObject({runId:paused.runId,status:'done',budgetUsage:{tokens:15}});
});

it('replays a durable pending notebook after restart and advances its baseline only after authenticated acknowledgement',async()=>{
 const f=await fixture('watch');const request=f.send('recipe.schedule',{recipeId:'durable-output',name:'Observe',prompt:'Observe prices',workspaceId:'work',urls:['https://example.test'],budget:{maxTokens:100000,maxDurationMs:10000},intervalMinutes:60});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const job=f.frames.find(e=>e.replyTo===request).payload.job;
 await f.service.dispatch('job.run',{id:job.id});await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='notebook.deliver')).toBe(true));
 const first=f.frames.find(e=>e.type==='notebook.deliver').payload;let settings=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8'));
 expect(settings.jobs[0].browser.baseline).toBeUndefined();expect(settings.jobs[0].browser.pendingOutput.runId).toBe(first.runId);
 f.service.close();const restored=new WorkbenchService(f.data,e=>f.events.push(e),f.env);services.push(restored);
 await restored.dispatch('browser.pair',{endpoint:f.endpoint,token:'fixture-reconnect-token'});
 await vi.waitFor(()=>expect(f.frames.filter(e=>e.type==='notebook.deliver')).toHaveLength(2));
 const second=f.frames.filter(e=>e.type==='notebook.deliver')[1].payload;expect(second).toEqual(first);
 const ack=f.send('notebook.ack',{runId:first.runId});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===ack)).toBe(true));expect(f.frames.find(e=>e.replyTo===ack).payload.ok).toBe(true);
 settings=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8'));expect(settings.jobs[0].browser.pendingOutput).toBeUndefined();expect(settings.jobs[0].browser.baseline).toBeTruthy();
 const duplicate=f.send('notebook.ack',{runId:first.runId});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===duplicate)).toBe(true));expect(f.frames.find(e=>e.replyTo===duplicate).payload.ok).toBe(true);
 await restored.dispatch('job.run',{id:job.id});await vi.waitFor(()=>expect(f.frames.filter(e=>e.type==='task.finished')).toHaveLength(2));expect(f.frames.filter(e=>e.type==='notebook.deliver')).toHaveLength(2);
});
it('retains pending output across a transport reconnect and refuses wrong acknowledgements or overwrite',async()=>{
 const f=await fixture('watch');const recipe={recipeId:'pending-transport',name:'Observe',prompt:'Observe prices',workspaceId:'work',urls:['https://example.test'],budget:{maxTokens:100000,maxDurationMs:10000},intervalMinutes:60};
 const request=f.send('recipe.schedule',recipe);await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===request)).toBe(true));const job=f.frames.find(e=>e.replyTo===request).payload.job;
 await f.service.dispatch('job.run',{id:job.id});await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='notebook.deliver')).toBe(true));const output=f.frames.find(e=>e.type==='notebook.deliver').payload;
 const wrong=f.send('notebook.ack',{runId:'wrong-run'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===wrong)).toBe(true));expect(f.frames.find(e=>e.replyTo===wrong).payload.error).toBeTruthy();
 const edit=f.send('recipe.schedule',{...recipe,prompt:'Overwrite this'});await vi.waitFor(()=>expect(f.frames.some(e=>e.replyTo===edit)).toBe(true));expect(f.frames.find(e=>e.replyTo===edit).payload.error).toContain('pending notebook');
 await f.service.dispatch('job.run',{id:job.id});await vi.waitFor(()=>expect(f.frames.filter(e=>e.type==='notebook.deliver')).toHaveLength(2));expect(f.modelRequests).toHaveLength(2);
 await f.service.dispatch('browser.disconnect',{});await f.service.dispatch('browser.pair',{endpoint:f.endpoint,token:'fixture-reconnect-token'});await vi.waitFor(()=>expect(f.frames.filter(e=>e.type==='notebook.deliver')).toHaveLength(3));
 expect(f.frames.filter(e=>e.type==='notebook.deliver').every(e=>JSON.stringify(e.payload)===JSON.stringify(output))).toBe(true);
 const persisted=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8')).jobs[0].browser;expect(persisted.baseline).toBeUndefined();expect(persisted.pendingOutput.notebook.sources[0].excerpt).toBe('Price: $10');
});
it('deducts consumed tokens and active time across explicit pause and resume',async()=>{
 const f=await fixture('pause');const task={goal:'Click Save',plan:[],budget:{maxTokens:100000,maxDurationMs:10000}};
 const request=f.send('chat.send',{threadId:'budget-thread',text:'Click Save',task});await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const first=f.events.find(e=>e.kind==='desktop.approval');const runId=f.frames.find(e=>e.replyTo===request).payload.runId;
 f.send('task.control',{runId,action:'pause'},'event');await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));
 let usage=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8')).sessionMeta[first.session].browserTaskUsage;expect(usage).toMatchObject({tokens:15,inFlight:false});expect(usage.runtimeMs).toBeGreaterThan(0);
 f.send('task.control',{runId,action:'resume'},'event');await vi.waitFor(()=>expect(f.events.filter(e=>e.kind==='desktop.approval')).toHaveLength(2));
 const current=(f.service as any).browserRuns.get(first.session);expect(current.turnStartedAt).toBeGreaterThan(0);
 const second=f.events.filter(e=>e.kind==='desktop.approval')[1];await f.service.dispatch('approval.reply',{id:second.id,allow:true});await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));
 usage=JSON.parse(readFileSync(join(f.data,'desktop.json'),'utf8')).sessionMeta[first.session].browserTaskUsage;expect(usage.tokens).toBe(45);expect(usage.inFlight).toBe(false);expect(f.frames.find(e=>e.type==='task.finished').payload.budgetUsage.tokens).toBe(45);
 const receipts=readdirSync(join(f.data,'context',first.session)).map(dir=>JSON.parse(readFileSync(join(f.data,'context',first.session,dir,'run.json'),'utf8')));expect(receipts.flatMap(r=>r.modelBudgets.map((b:any)=>b.maxTotalTokens))).toContain(99985);expect(f.modelRequests[1].messages[0].content).toContain('automatic ResearchNotebook storage');
});

it('keeps the original active-time allocation when a paused task resumes',async()=>{
 const f=await fixture('pause');const request=f.send('chat.send',{text:'Click Save',task:{goal:'Click Save',plan:[],budget:{maxTokens:100000,maxDurationMs:1000}}});
 await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.approval')).toBe(true));const runId=f.frames.find(e=>e.replyTo===request).payload.runId;
 await new Promise(resolve=>setTimeout(resolve,600));f.send('task.control',{runId,action:'pause'},'event');await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='desktop.done')).toBe(true));
 f.send('task.control',{runId,action:'resume'},'event');await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.paused'&&e.payload.reason==='budget')).toBe(true));
 const pause=f.frames.find(e=>e.type==='task.paused').payload;expect(pause.budgetUsage.runtimeMs).toBeGreaterThanOrEqual(1000);expect(pause.budgetUsage.runtimeMs).toBeLessThan(1700);expect(f.frames.filter(e=>e.type==='tool.call')).toHaveLength(0);
});
it('Codex readiness checks actual account state and never returns account identity',async()=>{
 const f=await fixture('answer');await f.service.dispatch('profile.save',{id:'default',name:'Codex',provider:'codex',model:'gpt-5.6-sol'});
 const status=vi.spyOn((f.service as any).codex,'status').mockResolvedValue({connected:false,email:'private@example.com'});
 const models=vi.spyOn((f.service as any).codex,'models').mockResolvedValue(['gpt-5.6-sol']);
 const missing:any=await f.service.dispatch('browser.readiness',{});expect(missing.providerReady).toBe(false);expect(JSON.stringify(missing)).not.toContain('private@example.com');expect(models).not.toHaveBeenCalled();
 status.mockResolvedValue({connected:true,email:'private@example.com'});expect(await f.service.dispatch('browser.readiness',{})).toMatchObject({providerReady:true});
 models.mockResolvedValue(['gpt-5.5']);const unavailable:any=await f.service.dispatch('browser.readiness',{});expect(unavailable.providerReady).toBe(false);expect(unavailable.providerMessage).toContain('not listed');
 models.mockRejectedValue(new Error('sensitive-provider-error'));const failed:any=await f.service.dispatch('browser.readiness',{});expect(failed.providerReady).toBe(false);expect(JSON.stringify(failed)).not.toContain('sensitive-provider-error');
});

it('bounds the combined Codex account and catalog readiness check to five seconds',async()=>{
 const f=await fixture('answer');await f.service.dispatch('profile.save',{id:'default',name:'Codex',provider:'codex',model:'gpt-5.6-sol'});
 vi.spyOn((f.service as any).codex,'status').mockResolvedValue({connected:true});vi.spyOn((f.service as any).codex,'models').mockImplementation(()=>new Promise(()=>{}));
 vi.useFakeTimers();try{const pending=f.service.dispatch('browser.readiness',{});await vi.advanceTimersByTimeAsync(5000);expect(await pending).toMatchObject({providerReady:false,providerMessage:'Codex account and model availability could not be checked. Try again.'});}finally{vi.useRealTimers();}
});

it('explains host notebook persistence on every research turn and keeps memory writes blocked',async()=>{
 const f=await fixture('research-memory');f.send('chat.send',{text:'Research and save a notebook',task:{goal:'Research and save a notebook',plan:[],budget:{maxTokens:100000,maxDurationMs:10000},readOnly:true}});
 await vi.waitFor(()=>expect(f.frames.some(e=>e.type==='task.finished')).toBe(true));expect(f.modelRequests).toHaveLength(3);
 for(const request of f.modelRequests){expect(request.messages[0].content).toContain('automatic ResearchNotebook storage');expect(request.messages[0].content).toContain('A refused memory write does not mean ResearchNotebook saving failed');}
 expect(JSON.stringify(f.modelRequests[2])).toContain('no context.write is needed');expect(f.frames.filter(e=>e.type==='tool.call').map(e=>e.payload.name)).toEqual(['browser.readPage']);
 expect(f.frames.find(e=>e.type==='task.finished').payload.notebook.sources[0].excerpt).toBe('Price: $10');
});
