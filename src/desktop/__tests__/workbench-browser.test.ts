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
 const root=mkdtempSync(join(tmpdir(),'hades-browser-integration-'));roots.push(root);const events:any[]=[],modelRequests:any[]=[],frames:any[]=[];let socket!:WebSocket;
 const ws=new WebSocketServer({host:'127.0.0.1',port:0});websockets.push(ws);await new Promise<void>(r=>ws.once('listening',r));const endpoint='ws://127.0.0.1:'+(ws.address() as any).port;
 ws.on('connection',s=>{socket=s;s.on('message',raw=>{const e=JSON.parse(raw.toString());frames.push(e);if(e.kind!=='request')return;let payload:any;
 if(e.type==='handshake')payload={ok:true,sessionId:'browser-session',protocol:'1.0.0',serverCapabilities:['tools','page','runs','context']};
 if(e.type==='agents.announce')payload={ok:true};
 if(e.type==='tool.call')payload={callId:e.payload.callId,ok:true,value:e.payload.name==='page.snapshot'?{tabId:'tab',nodes:[{ref:'s1r1',role:'button',name:'Save'}]}:{tabs:[{id:'tab',title:'Fixture',url:'https://example.test'}]}};
 s.send(JSON.stringify({id:randomUUID(),protocol:'1.0.0',kind:'response',type:e.type+'.result',at:Date.now(),sessionId:e.sessionId,replyTo:e.id,payload}));});});
 const server=createServer((req,res)=>{let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{const body=JSON.parse(raw);modelRequests.push(body);const index=modelRequests.length-1;
 let content='ANSWER: Completed the browser task.';
 if(mode==='flow'&&index<3)content='TOOL: hades_browser\nINPUT: '+JSON.stringify(index===0?{name:'browser.listTabs',args:{}}:index===1?{name:'page.snapshot',args:{tabId:'tab'}}:{name:'page.click',args:{tabId:'tab',ref:'s1r1'}});
 if(mode==='pause'&&index<2)content='TOOL: hades_browser\nINPUT: '+JSON.stringify({name:'page.click',args:{tabId:'tab',ref:'s1r1'}});
 if(mode==='scope-escape'&&index===0)content='TOOL: file_ops\nINPUT: '+JSON.stringify({op:'write',path:'escaped.txt',content:'must not write'});
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content}}],usage:{prompt_tokens:10,completion_tokens:5}})+'\n\ndata: [DONE]\n\n');});});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const env:NodeJS.ProcessEnv={NODE_ENV:'test',HADES_WEBHOOK_PORT:'0'};const data=join(root,'data');const service=new WorkbenchService(data,e=>events.push(e),env);services.push(service);
 await service.dispatch('project.add',{path:root});await service.dispatch('profile.save',{id:'default',name:'Bound profile',provider:'local',model:'fixture',baseUrl:'http://127.0.0.1:'+(server.address() as any).port+'/v1'});
 await service.dispatch('browser.configure',{endpoint,enabled:true,profile:'default',root});await service.dispatch('key.set',{account:'hades-browser',key:'fixture-browser-token-123456789'});await service.dispatch('browser.connect',{});
 const send=(type:string,payload:any,kind='request')=>{const id=randomUUID();socket.send(JSON.stringify({id,protocol:'1.0.0',kind,type,at:Date.now(),sessionId:'browser-session',payload}));return id;};
 return {root,data,service,events,frames,modelRequests,send,env,endpoint};
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
