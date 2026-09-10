import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {HelmCodeService} from '../core/helm-code-service';
let dir:string,root:string,assets:string,binary:string,service:HelmCodeService;
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'helm-code-'));root=join(dir,'project');assets=join(dir,'assets');mkdirSync(root);mkdirSync(assets);writeFileSync(join(assets,'index.html'),'<html>Owned Helm fork</html>');writeFileSync(join(assets,'app.js'),'console.log("local")');
 const auth=join(dir,'existing','opencode');mkdirSync(auth,{recursive:true});writeFileSync(join(auth,'auth.json'),JSON.stringify({fixture:{type:'api',key:'DO_NOT_OUTPUT'}}));
 binary=join(dir,'opencode');writeFileSync(binary,`#!${process.execPath}
 if(process.argv.includes('--version')){console.log('1.18.21');process.exit(0)}
 const fs=require('fs'),http=require('http'),crypto=require('crypto');
 const count=process.env.HADES_CODE_TEST_COUNT;let n=0;try{n=Number(fs.readFileSync(count))}catch{}fs.writeFileSync(count,String(n+1));
 const expected='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
 const server=http.createServer((req,res)=>{if(req.headers.authorization!==expected){res.writeHead(401);res.end();return;}if(req.url.startsWith('/global/health')){res.setHeader('content-type','application/json');res.end(JSON.stringify({healthy:true}));return;}if(req.url.startsWith('/event')){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: owned-event\\n\\n');return;}let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url,directory:req.headers['x-opencode-directory'],cwd:process.cwd(),data:process.env.XDG_DATA_HOME,config:process.env.XDG_CONFIG_HOME,authImported:!!process.env.OPENCODE_AUTH_CONTENT,accountCount:Object.keys(JSON.parse(fs.readFileSync(process.env.XDG_DATA_HOME+'/opencode/auth.json','utf8'))).length,localUi:process.env.OPENCODE_HELM_LOCAL_UI,context:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||'{}').instructions?.map(p=>fs.readFileSync(p,'utf8')),body:body?JSON.parse(body):null}));});});
 server.on('upgrade',(req,socket)=>{if(req.headers.authorization!==expected){socket.end('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');return;}const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');socket.on('data',b=>{if((b[0]&15)===8){socket.end(Buffer.from([136,0]));return;}socket.write(Buffer.from([129,4,112,111,110,103]));});});
 server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
 `,{mode:0o700});
 service=new HelmCodeService(join(dir,'data'),{assetsDirectory:assets,binary,revision:'fixture-revision',env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
});
afterEach(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
const connection=(url:string)=>{const u=new URL(url);return {origin:u.origin,token:new URLSearchParams(u.hash.slice(1)).get('helm_auth')!,headers:{Authorization:'Basic '+new URLSearchParams(u.hash.slice(1)).get('helm_auth')}};};
it('starts only explicitly, coalesces opening and reports exact owned runtime provenance',async()=>{
 expect(service.status(root,'p').state).toBe('closed');const [a,b]=await Promise.all([service.open(root,'p'),service.open(root,'p')]);expect(a).toEqual(b);expect(new URL(a.url).pathname).toBe('/');expect(new URLSearchParams(new URL(a.url).hash.slice(1)).get('helm_root')).toBe(realpathSync(root));expect(readFileSync(join(dir,'count'),'utf8')).toBe('1');expect(a).toMatchObject({version:'1.18.21',revision:'fixture-revision',fork:'https://github.com/mosnin/opencode',runtime:'configured'});expect(service.status(root,'p').state).toBe('ready');
 const c=connection(a.url);expect(await(await fetch(c.origin+'/anything/session')).text()).toContain('Owned Helm fork');expect(await(await fetch(c.origin+'/app.js')).text()).toContain('local');expect((await fetch(c.origin+'/session')).status).toBe(401);
 const response=await fetch(c.origin+'/session',{headers:c.headers});expect(response.headers.get('set-cookie')).toContain('HttpOnly');const value=await response.json();expect(value.cwd).toBe(realpathSync(root));expect(value.authImported).toBe(false);expect(value.accountCount).toBe(1);expect(value.localUi).toBe('1');expect(value.data).toContain('/code-runtime/');expect(value.data).not.toBe(join(dir,'existing'));expect(JSON.stringify(service.status(root,'p'))).not.toContain('DO_NOT_OUTPUT');
});
it('isolates profile runtimes and private stores',async()=>{const a=connection((await service.open(root,'a')).url),b=connection((await service.open(root,'b')).url);expect(a.origin).not.toBe(b.origin);expect((await fetch(b.origin+'/session',{headers:a.headers})).status).toBe(401);const av=await(await fetch(a.origin+'/session',{headers:a.headers})).json(),bv=await(await fetch(b.origin+'/session',{headers:b.headers})).json();expect(av.data).not.toBe(bv.data);});
it('rejects foreign origins, encoded traversal and directory escapes in queries, headers and JSON',async()=>{
 const c=connection((await service.open(root,'p')).url);expect((await fetch(c.origin+'/',{headers:{Origin:'https://foreign.invalid'}})).status).toBe(403);
 for(const path of ['/session?directory=%2Fetc','/api/session?location%5Bdirectory%5D=%2Fetc','/file?path=..%2Foutside','/assets/%2e%2e%2foutside'])expect((await fetch(c.origin+path,{headers:c.headers})).status).toBe(403);
 expect((await fetch(c.origin+'/session',{headers:{...c.headers,'x-opencode-directory':'/etc'}})).status).toBe(403);
 expect((await fetch(c.origin+'/api/session',{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify({location:{directory:'/etc'}})})).status).toBe(403);
 expect((await fetch(c.origin+'/session',{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify({parts:[{url:'file:///etc/passwd'}]})})).status).toBe(403);
});
it('preserves SSE and authenticates real WebSocket upgrade traffic',async()=>{
 const c=connection((await service.open(root,'p')).url);expect(await(await fetch(c.origin+'/event',{headers:c.headers})).text()).toBe('data: owned-event\n\n');
 for(const route of ['/pty/test/connect?directory=','/api/pty/test/connect?location[directory]=']){
 const ws=new WebSocket(c.origin.replace('http:','ws:')+route+encodeURIComponent(root)+'&auth_token='+encodeURIComponent(c.token));
 const message=await new Promise<string>((resolveMessage,reject)=>{ws.onopen=()=>ws.send('ping');ws.onmessage=e=>resolveMessage(String(e.data));ws.onerror=()=>reject(new Error('WebSocket failed'));});expect(message).toBe('pong');ws.close();
 }
});
it('shuts down owned gateways and prevents reopening after close',async()=>{const c=connection((await service.open(root,'p')).url);await service.close();expect(service.status(root,'p').state).toBe('closed');await expect(fetch(c.origin+'/')).rejects.toThrow();await expect(service.open(root,'p')).rejects.toThrow('closed');});
it('reports missing assets and incompatible runtime without remote fallback',async()=>{await service.close();service=new HelmCodeService(join(dir,'missing'),{assetsDirectory:join(dir,'no-assets'),binary});await expect(service.open(root,'p')).rejects.toThrow('local Helm Code interface is missing');expect(service.status(root,'p').state).toBe('failed');await service.close();writeFileSync(binary,`#!${process.execPath}\nconsole.log('9.9.9')\n`,{mode:0o700});service=new HelmCodeService(join(dir,'wrong-version'),{assetsDirectory:assets,binary,env:{...process.env,XDG_DATA_HOME:join(dir,'existing')}});await expect(service.open(root,'p')).rejects.toThrow('requires OpenCode 1.18.21');});

it('limits owned runtimes, exposes maintenance activity and closes one workspace',async()=>{
 expect(service.hasActiveWork()).toBe(false);await Promise.all(['a','b','c','d'].map(p=>service.open(root,p)));expect(service.hasActiveWork()).toBe(true);await expect(service.open(root,'fifth')).rejects.toThrow('Four runtimes');
 await service.closeWorkspace(root,'a');expect(service.status(root,'a').state).toBe('closed');await service.open(root,'fifth');expect(service.status(root,'b').state).toBe('ready');await service.close();expect(service.hasActiveWork()).toBe(false);
});
it('freezes bounded project context through official private instructions configuration',async()=>{
 await service.close();let notes='Keep public exports stable';service=new HelmCodeService(join(dir,'context-runtime'),{assetsDirectory:assets,binary,context:()=>notes,env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
 const runtime=await service.open(root,'p');expect(runtime.contextIncluded).toBe(true);notes='Changed after open';const c=connection(runtime.url);const value=await(await fetch(c.origin+'/session',{headers:c.headers})).json();expect(value.context).toEqual(['Keep public exports stable']);
 await service.closeWorkspace(root,'p');notes='x'.repeat(64001);await expect(service.open(root,'p')).rejects.toThrow('64 KB');
});
it('rejects filesystem symlink escapes while allowing explicitly owned task workspace descendants',async()=>{
 await service.close();const outside=join(dir,'outside'),owned=join(dir,'owned');mkdirSync(outside);mkdirSync(owned);symlinkSync(outside,join(root,'link'));
 service=new HelmCodeService(join(dir,'scoped-runtime'),{assetsDirectory:assets,binary,ownsWorkspace:(p,source,profile)=>p===realpathSync(owned)&&source===realpathSync(root)&&profile==='p',env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
 const c=connection((await service.open(root,'p')).url);expect((await fetch(c.origin+'/file?path=link%2Fsecret',{headers:c.headers})).status).toBe(403);
 expect((await fetch(c.origin+'/file?path='+encodeURIComponent(join(owned,'new.ts')),{headers:c.headers})).status).toBe(200);
 const other=connection((await service.open(root,'other')).url);expect((await fetch(other.origin+'/file?path='+encodeURIComponent(join(owned,'new.ts')),{headers:other.headers})).status).toBe(403);
});
it('cancels a pending version check on close without automatic restart',async()=>{
 await service.close();writeFileSync(binary,`#!${process.execPath}\nsetInterval(()=>{},1000)\n`,{mode:0o700});service=new HelmCodeService(join(dir,'slow'),{assetsDirectory:assets,binary,env:{...process.env,XDG_DATA_HOME:join(dir,'existing')}});
 const opening=service.open(root,'p');const rejection=expect(opening).rejects.toThrow();await service.closeWorkspace(root,'p');await rejection;expect(service.hasActiveWork()).toBe(false);expect(service.status(root,'p').state).toBe('closed');
});

it('seeds private accounts once and preserves account removal on reopen',async()=>{
 const c=connection((await service.open(root,'p')).url);const value=await(await fetch(c.origin+'/session',{headers:c.headers})).json();const auth=join(value.data,'opencode','auth.json');expect(lstatSync(auth).mode&0o777).toBe(0o600);writeFileSync(auth,'{}');await service.closeWorkspace(root,'p');
 const next=connection((await service.open(root,'p')).url);const after=await(await fetch(next.origin+'/session',{headers:next.headers})).json();expect(after.accountCount).toBe(0);expect(after.authImported).toBe(false);expect(Object.keys(JSON.parse(readFileSync(join(dir,'existing/opencode/auth.json'),'utf8')))).toEqual(['fixture']);
});
it('encodes non-ASCII directory headers and accepts bounded image-sized JSON payloads',async()=>{
 const unicode=join(dir,'project-雪');mkdirSync(unicode);const c=connection((await service.open(unicode,'p')).url);const value=await(await fetch(c.origin+'/session',{headers:c.headers})).json();expect(value.directory).toBe(encodeURIComponent(realpathSync(unicode)));
 const response=await fetch(c.origin+'/session',{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify({parts:[{url:'data:image/png;base64,'+'a'.repeat(3*1024*1024)}]})});expect(response.status).toBe(200);await response.arrayBuffer();
});

it('does not substitute an installed or environment CLI when the bundled fork is missing',async()=>{
 await service.close();service=new HelmCodeService(join(dir,'no-bundle'),{assetsDirectory:assets,env:{...process.env,HADES_HELM_OPENCODE_BIN:binary,XDG_DATA_HOME:join(dir,'existing')}});
 await expect(service.open(root,'p')).rejects.toThrow('bundled Helm Code runtime is missing');expect(service.status(root,'p').state).toBe('failed');
});

it.skipIf(process.platform==='win32')('kills the owned backend on watchdog pipe EOF even while the parent PID still exists',async()=>{
 const c=connection((await service.open(root,'p')).url);const entry=[...(service as any).entries.values()][0];expect(entry.watchdog.stdin).toBeTruthy();entry.watchdog.stdin.end();
 for(let n=0;n<100&&service.status(root,'p').state==='ready';n++)await new Promise(r=>setTimeout(r,10));
 expect(service.status(root,'p').state).toBe('failed');expect(()=>process.kill(process.pid,0)).not.toThrow();await expect(fetch(c.origin+'/')).rejects.toThrow();
});

it.skipIf(process.platform==='win32'||process.env.HADES_TEST_NO_PROCESS_INSPECTION==='1')('kills a resistant same-group descendant when the backend exits itself',async()=>{
 await service.close();const original=readFileSync(binary,'utf8');const pidFile=join(dir,'resistant.pid');
 const injection=`const resistant=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(resistant.pid));`;
 writeFileSync(binary,original.replace("const expected=",injection+"\nconst expected=").replace("if(req.url.startsWith('/global/health'))", "if(req.url==='/session/exit'){res.end('bye');setTimeout(()=>process.exit(0),10);return;}if(req.url.startsWith('/global/health'))"),{mode:0o700});
 service=new HelmCodeService(join(dir,'exit-runtime'),{assetsDirectory:assets,binary,env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
 const c=connection((await service.open(root,'p')).url);const pid=Number(readFileSync(pidFile,'utf8'));await fetch(c.origin+'/session/exit',{headers:c.headers});
 const alive=()=>{try{return !execFileSync('ps',['-o','stat=','-p',String(pid)],{stdio:['ignore','pipe','pipe']}).toString().trim().startsWith('Z');}catch(error){if((error as any).status===1&&!String((error as any).stderr??'').trim())return false;throw error;}};
 try{for(let n=0;n<100&&alive();n++)await new Promise(r=>setTimeout(r,10));expect(alive()).toBe(false);expect(service.status(root,'p').state).toBe('failed');}finally{try{process.kill(pid,'SIGKILL');}catch{}}
});

it('preserves origin across restart while rotating authentication and retaining a credential-free port record',async()=>{
 const first=connection((await service.open(root,'p')).url);await service.close();service=new HelmCodeService(join(dir,'data'),{assetsDirectory:assets,binary,env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
 const next=connection((await service.open(root,'p')).url);expect(next.origin).toBe(first.origin);expect(next.token).not.toBe(first.token);expect((await fetch(next.origin+'/session',{headers:first.headers})).status).toBe(401);expect((await fetch(next.origin+'/session',{headers:next.headers})).status).toBe(200);
 const entry=[...(service as any).entries.values()][0];const record=join(entry.directory,'gateway-port.json');expect(JSON.parse(readFileSync(record,'utf8'))).toEqual({port:Number(new URL(next.origin).port)});expect(lstatSync(record).mode&0o777).toBe(0o600);
});
it('binds a different owned gateway when another server occupies the saved port',async()=>{
 const first=connection((await service.open(root,'p')).url);await service.closeWorkspace(root,'p');const foreign=createServer((_req,res)=>res.end('foreign owner'));await new Promise<void>(r=>foreign.listen(Number(new URL(first.origin).port),'127.0.0.1',r));
 try{const next=connection((await service.open(root,'p')).url);expect(next.origin).not.toBe(first.origin);expect(await(await fetch(first.origin)).text()).toBe('foreign owner');const result=await(await fetch(next.origin+'/session',{headers:next.headers})).json();expect(result.cwd).toBe(realpathSync(root));await service.closeWorkspace(root,'p');const reopened=connection((await service.open(root,'p')).url);expect(reopened.origin).toBe(next.origin);}finally{foreign.closeAllConnections();await new Promise<void>(r=>foreign.close(()=>r()));}
});
it('rejects malformed or redirected port preferences',async()=>{
 await service.open(root,'p');const entry=[...(service as any).entries.values()][0],record=join(entry.directory,'gateway-port.json');await service.closeWorkspace(root,'p');writeFileSync(record,JSON.stringify({port:80}));await expect(service.open(root,'p')).rejects.toThrow('port preference is invalid');
 await service.closeWorkspace(root,'p');rmSync(record);const outside=join(dir,'outside-port.json');writeFileSync(outside,JSON.stringify({port:50000}));symlinkSync(outside,record);await expect(service.open(root,'p')).rejects.toThrow('regular bounded file');
});
it('persists private UI storage across service restart with new authentication and profile isolation',async()=>{
 const original=connection((await service.open(root,'storage')).url);
 const call=(c:ReturnType<typeof connection>,body:unknown)=>fetch(c.origin+'/helm-storage',{method:'POST',headers:{...c.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
 expect((await fetch(original.origin+'/helm-storage',{method:'POST'})).status).toBe(401);
 expect((await call(original,{action:'set',bucket:'draft',key:'session:key',value:'retained'})).status).toBe(200);
 await service.close();service=new HelmCodeService(join(dir,'data'),{assetsDirectory:assets,binary,env:{...process.env,XDG_DATA_HOME:join(dir,'existing'),HADES_CODE_TEST_COUNT:join(dir,'count')}});
 const reopened=connection((await service.open(root,'storage')).url);expect(reopened.origin).toBe(original.origin);
 expect((await call(original,{action:'get',bucket:'draft',key:'session:key'})).status).toBe(401);
 expect(await (await call(reopened,{action:'get',bucket:'draft',key:'session:key'})).json()).toEqual({value:'retained'});
 const other=connection((await service.open(root,'other-storage')).url);
 expect(await (await call(other,{action:'get',bucket:'draft',key:'session:key'})).json()).toEqual({value:null});
 expect((await call(reopened,{action:'set',bucket:'ui',key:'a',value:'x',root:'/tmp'})).status).toBe(400);
});
