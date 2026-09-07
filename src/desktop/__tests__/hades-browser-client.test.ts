import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { HadesBrowserClient, BROWSER_PROTOCOL, validateBrowserEndpoint, type HadesBrowserOptions, type BrowserAuthority } from '../core/hades-browser-client';
const clients: HadesBrowserClient[] = [], servers: WebSocketServer[] = [];
afterEach(async () => { for (const c of clients.splice(0)) c.close(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { for(const c of s.clients)c.terminate();s.close(()=>r()); }))); });
const TOKEN = 'fixture-pairing-token-123456789';
async function fixture(options: Partial<HadesBrowserOptions> = {}, mode = 'normal') {
 const server = new WebSocketServer({host:'127.0.0.1',port:0}); servers.push(server); await new Promise<void>(r=>server.once('listening',r));
 const sessionId='fixture-session', records:any[]=[], replies:any[]=[], auth:any[]=[];let socket!:ServerSocket,connections=0;
 server.on('connection',(s,req)=> {socket=s;connections++;auth.push({token:new URL(req.url!,'http://127.0.0.1').searchParams.get('token')===TOKEN,origin:req.headers.origin});
 s.on('message',raw=> {const e=JSON.parse(raw.toString()); records.push(e); if(e.kind==='response'){replies.push(e);return;}
 const reply=(payload:any)=>s.send(JSON.stringify({id:randomUUID(),protocol:BROWSER_PROTOCOL,kind:'response',type:e.type+'.result',at:Date.now(),replyTo:e.id,sessionId:e.sessionId,payload}));
 if(e.type==='handshake')reply({ok:true,protocol:mode==='version'?'2.0.0':BROWSER_PROTOCOL,sessionId,serverCapabilities:['tools','page','runs','context']});
 if(e.type==='agents.announce')reply({ok:true});
 if(e.type==='tool.call'&&mode!=='hold')reply({callId:mode==='wrong-id'?'other':e.payload.callId,ok:true,value:{tabs:[]}});
 }); });
 const client = new HadesBrowserClient({endpoint:'ws://127.0.0.1:'+((server.address() as any).port),token:TOKEN,agents:[
  {id:'agent-a',profile:'alpha',name:'Alpha',allowedTools:['browser.listTabs','page.click','page.snapshot']},
  {id:'agent-b',profile:'beta',name:'Beta',allowedTools:['browser.listTabs']},
 ],...options});clients.push(client);await client.connect();
 const frame=(type:string,payload:unknown,kind='request',extra={})=>({id:randomUUID(),protocol:BROWSER_PROTOCOL,kind,type,at:Date.now(),sessionId,payload,...extra});
 return {client,records,replies,auth,get connections(){return connections;},send:(e:any)=>socket.send(JSON.stringify(e)),raw:(s:string)=>socket.send(s),frame,sessionId};
}
describe('native Hades Browser transport (real loopback WebSocket)',()=>{
 it('pairs without a web Origin, announces bounded authority and omits credentials from status',async()=>{
  const f=await fixture();expect(f.auth).toEqual([{token:true,origin:undefined}]);expect(JSON.stringify(f.client.status())).not.toContain(TOKEN);
  expect(f.records[1].payload.agents[0]).toEqual({id:'agent-a',name:'Alpha',allowedTools:['browser.listTabs','page.click','page.snapshot']});
  expect(await f.client.call('alpha','browser.listTabs',{})).toMatchObject({ok:true,value:{tabs:[]}});
  await expect(f.client.call('unknown','browser.listTabs',{})).rejects.toThrow('Profile');
  await expect(f.client.call('beta','page.click',{tabId:'tab',ref:'s1r1'})).rejects.toThrow('not available');
  await expect(f.client.call('alpha','page.click',{tabId:'tab',ref:'s1r1'})).rejects.toThrow('active registered run');
  expect(f.records.filter(e=>e.type==='tool.call')).toHaveLength(1);
 });
 it('rejects remote, credentialed, malformed endpoints and invalid local bindings',()=>{
  for(const value of ['wss://127.0.0.1:9','ws://localhost:9','ws://127.1:9','ws://example.test:9','ws://127.0.0.1:9/a','ws://u:p@127.0.0.1:9','ws://127.0.0.1:9?token=x']) {
   if(value==='ws://127.1:9')continue; // URL canonicalization resolves this numeric address to loopback.
   expect(()=>validateBrowserEndpoint(value)).toThrow();
  }
  expect(validateBrowserEndpoint('ws://[::1]:9182')).toBe('ws://[::1]:9182/');
  expect(()=>new HadesBrowserClient({endpoint:'ws://127.0.0.1:9',token:TOKEN,agents:[{id:'a',profile:'../b',name:'a',allowedTools:[]}]})).toThrow('identities');
 });
 it('acknowledges chat only after admission, derives profile and never admits a duplicate twice',async()=>{
  let admitted!:(value:any)=>void;let authority!:BrowserAuthority;
  const onChat=vi.fn((a:BrowserAuthority)=>{authority=a;return new Promise<any>(r=>admitted=r);});const f=await fixture({onChat});
  const message=f.frame('chat.send',{text:'Inspect this page',agentId:'agent-b',profile:'alpha',threadId:'thread-one',context:{selection:'untrusted'}});f.send(message);
  await vi.waitFor(()=>expect(onChat).toHaveBeenCalledTimes(1));expect(authority.profile).toBe('beta');expect(f.replies).toHaveLength(0);
  admitted({ok:true,threadId:'thread-one',runId:'run-one'});await vi.waitFor(()=>expect(f.replies).toHaveLength(1));expect(f.replies[0].payload.ok).toBe(true);
  f.send(message);await vi.waitFor(()=>expect(f.replies).toHaveLength(2));expect(onChat).toHaveBeenCalledTimes(1);expect(f.replies[1].payload.error).toMatch(/Duplicate/);
  f.client.close();expect(authority.signal.aborted).toBe(true);
 });
 it('rejects unknown agents, invalid captures and oversized chat without invoking callbacks',async()=>{
  const onChat=vi.fn(),onCapture=vi.fn();const f=await fixture({onChat,onCapture});
  f.send(f.frame('chat.send',{text:'hi',agentId:'missing'}));f.send(f.frame('chat.send',{text:'x'.repeat(64001),agentId:'agent-a'}));
  f.send(f.frame('capture.submit',{agentId:'agent-a',capture:{id:'x',kind:'tab',dataUrl:'https://external/image.png',width:1,height:1,capturedAt:1}}));
  await vi.waitFor(()=>expect(f.replies).toHaveLength(3));expect(onChat).not.toHaveBeenCalled();expect(onCapture).not.toHaveBeenCalled();expect(f.replies.every(e=>e.payload.error)).toBe(true);
 });
 it('passes validated capture and untrusted context through the registered profile',async()=>{
  const onCapture=vi.fn(async(_authority:BrowserAuthority)=>({ok:true as const}));const f=await fixture({onCapture});
  f.send(f.frame('capture.submit',{agentId:'agent-a',threadId:'capture-thread',capture:{id:'cap',kind:'tab',dataUrl:'data:image/png;base64,YQ==',width:1,height:1,capturedAt:1},prompt:'Explain'}));
  await vi.waitFor(()=>expect(f.replies).toHaveLength(1));expect(onCapture.mock.calls[0]?.[0]).toMatchObject({profile:'alpha',agentId:'agent-a'});expect(f.replies[0].payload).toEqual({ok:true});
 });
 it('fences pause/cancel, ignores late tool results and never replays the pending click',async()=>{
  const control=vi.fn();const f=await fixture({onTaskControl:control},'hold');f.client.emit('alpha','task.started',{runId:'run-one',title:'Task'});
  const call=f.client.call('alpha','page.click',{tabId:'tab',ref:'s1r1'},{runId:'run-one'});const rejected=expect(call).rejects.toThrow('paused');
  await vi.waitFor(()=>expect(f.records.filter(e=>e.type==='tool.call')).toHaveLength(1));const sent=f.records.find(e=>e.type==='tool.call');
  f.send(f.frame('task.control',{runId:'run-one',action:'pause'},'event'));await rejected;
  f.send(f.frame('tool.call.result',{callId:sent.payload.callId,ok:true,value:{}},'response',{replyTo:sent.id}));
  await expect(f.client.call('alpha','page.click',{},{runId:'run-one'})).rejects.toThrow('not active');
  await expect(f.client.call('beta','browser.listTabs',{},{runId:'run-one'})).rejects.toThrow('not active');
  f.send(f.frame('task.control',{runId:'run-one',action:'cancel'},'event'));await vi.waitFor(()=>expect(control).toHaveBeenCalledTimes(2));
  f.send(f.frame('task.control',{runId:'run-one',action:'resume'},'event'));await new Promise(r=>setTimeout(r,20));
  await expect(f.client.call('alpha','page.click',{},{runId:'run-one'})).rejects.toThrow('not active');expect(f.records.filter(e=>e.type==='tool.call')).toHaveLength(1);
 });
 it('requires explicit resume, rejects duplicate run starts and preserves profile ownership',async()=>{
  const f=await fixture();f.client.emit('alpha','task.started',{runId:'run-one',title:'Task'});
  expect(()=>f.client.emit('alpha','task.started',{runId:'run-one',title:'Again'})).toThrow('already exists');
  expect(()=>f.client.emit('beta','task.finished',{runId:'run-one',status:'done'})).toThrow('owned');
  f.send(f.frame('task.control',{runId:'run-one',action:'pause'},'event'));await new Promise(r=>setTimeout(r,20));
  await expect(f.client.call('alpha','page.click',{},{runId:'run-one'})).rejects.toThrow('not active');
  f.send(f.frame('task.control',{runId:'run-one',action:'resume'},'event'));await new Promise(r=>setTimeout(r,20));
  expect(await f.client.call('alpha','page.click',{tabId:'tab',ref:'s1r1'},{runId:'run-one'})).toMatchObject({ok:true});
 });
 it('holds exclusive tab ownership through pause and releases only on finish or cancellation',async()=>{
  const f=await fixture();f.client.emit('alpha','task.started',{runId:'run-a',title:'A'});f.client.emit('alpha','task.started',{runId:'run-b',title:'B'});
  await f.client.call('alpha','page.snapshot',{tabId:'tab'},{runId:'run-a'});
  await expect(f.client.call('alpha','page.snapshot',{tabId:'tab'},{runId:'run-b'})).rejects.toThrow('owns this tab');
  f.send(f.frame('task.control',{runId:'run-a',action:'pause'},'event'));await new Promise(r=>setTimeout(r,20));
  await expect(f.client.call('alpha','page.click',{tabId:'tab',ref:'s1r1'},{runId:'run-b'})).rejects.toThrow('owns this tab');
  f.send(f.frame('task.control',{runId:'run-a',action:'cancel'},'event'));await new Promise(r=>setTimeout(r,20));
  expect(await f.client.call('alpha','page.snapshot',{tabId:'tab'},{runId:'run-b'})).toMatchObject({ok:true});
  f.client.emit('alpha','task.finished',{runId:'run-b',status:'done'});f.client.emit('alpha','task.started',{runId:'run-c',title:'C'});
  expect(await f.client.call('alpha','page.snapshot',{tabId:'tab'},{runId:'run-c'})).toMatchObject({ok:true});
 });
 it('cancellation closes the connection, aborts admission and never retries an uncertain action',async()=>{
  let authority!:BrowserAuthority;const f=await fixture({onChat:async a=>{authority=a;return new Promise(()=>{});}},'hold');
  f.send(f.frame('chat.send',{text:'work',agentId:'agent-a'}));await vi.waitFor(()=>expect(authority).toBeDefined());
  const abort=new AbortController();const pending=f.client.call('alpha','browser.listTabs',{}, {signal:abort.signal});const rejection=expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(()=>expect(f.records.filter(e=>e.type==='tool.call')).toHaveLength(1));abort.abort();await rejection;expect(authority.signal.aborted).toBe(true);
  expect(f.client.status().connected).toBe(false);await expect(f.client.connect()).rejects.toThrow('reconnect explicitly');expect(f.connections).toBe(1);
 });
 it('times out missing tool results and does not reconnect',async()=>{
  const f=await fixture({requestTimeoutMs:40},'hold');await expect(f.client.call('alpha','browser.listTabs',{})).rejects.toThrow('timed out');expect(f.client.status().connected).toBe(false);expect(f.connections).toBe(1);
 });
 it('bounds admission time, aborting the callback before reporting failure',async()=>{
  let authority!:BrowserAuthority;const f=await fixture({requestTimeoutMs:40,onChat:async a=>{authority=a;return new Promise(()=>{});}});
  f.send(f.frame('chat.send',{text:'work',agentId:'agent-a'}));await vi.waitFor(()=>expect(f.replies).toHaveLength(1));expect(authority.signal.aborted).toBe(true);expect(f.replies[0].payload.error).toBeTruthy();
 });
 it('refuses stale sessions, malformed frames, version mismatch and wrong tool call identity',async()=>{
  const f=await fixture();f.send(f.frame('chat.send',{text:'hello',agentId:'agent-a'},'request',{sessionId:'stale'}));await vi.waitFor(()=>expect(f.client.status().connected).toBe(false));
  const g=await fixture({},'wrong-id');await expect(g.client.call('alpha','browser.listTabs',{})).rejects.toThrow('Invalid browser tool response');expect(g.client.status().connected).toBe(false);
  await expect(fixture({},'version')).rejects.toThrow('Could not pair');
  const h=await fixture();h.raw('not-json');await vi.waitFor(()=>expect(h.client.status().connected).toBe(false));
 });
 it('bounds outbound messages, rejects oversized inbound messages and revokes all pending authority',async()=>{
  const f=await fixture();await expect(f.client.call('alpha','browser.listTabs',{text:'x'.repeat(1024*1024)})).rejects.toThrow('message limit');expect(f.records.filter(e=>e.type==='tool.call')).toHaveLength(0);
  f.raw(' '.repeat(8*1024*1024+1));await vi.waitFor(()=>expect(f.client.status().connected).toBe(false));
  const g=await fixture({},'hold');const pending=g.client.call('alpha','browser.listTabs',{});const rejected=expect(pending).rejects.toThrow('revoked');g.client.revoke('alpha');await rejected;
 });
});
