import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Socket } from 'node:net';
import { helmEnv } from './helm-adapters';
import { HelmCodeStorage, HELM_STORAGE_LIMITS } from './helm-code-storage';

export interface HelmCodeRuntime { url: string; version: string; revision: string; fork: string; runtime: 'bundled-fork' | 'configured'; contextIncluded: boolean }
export interface HelmCodeStatus { state: 'closed' | 'starting' | 'ready' | 'failed'; runtime?: HelmCodeRuntime; error?: string }
export interface HelmCodeOptions { env?: NodeJS.ProcessEnv; assetsDirectory?: string; binary?: string; revision?: string; ownsWorkspace?: (candidate: string, sourceRoot: string, profile: string) => boolean; context?: (root: string) => string }
interface Entry { storage?: HelmCodeStorage; root: string; profile: string; directory: string; state: HelmCodeStatus; controller: AbortController; pending?: Promise<HelmCodeRuntime>; child?: ChildProcess; childDone?: Promise<void>; watchdog?: ChildProcess; gateway?: Server; sockets: Set<Socket>; backendPort?: number; password: string; cookie: string; cookieName: string; origin?: string }
const VERSION = '1.18.21';
const FORK = 'https://github.com/mosnin/opencode';
const API = /^\/(?:api|global|event|session|provider|config|path|project|file|find|pty|permission|question|mcp|lsp|vcs|command|agent|auth|skill|experimental|health|log|instance)(?:\/|$)/;
const equal = (a: string, b: string) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y); };
const inside = (root: string, candidate: string) => {const r=relative(root,candidate);return !r.startsWith('..'+requireSeparator()) && r!=='..' && !isAbsolute(r);};
function requireSeparator() { return process.platform==='win32'?'\\':'/'; }
/** Owns one private OpenCode data store and authenticated loopback runtime per
 * project/profile. No runtime starts until the user explicitly opens Code. */
export class HelmCodeService {
  private entries=new Map<string,Entry>();
  private directory:string;
  private env:NodeJS.ProcessEnv;
  private closed=false;
  constructor(dataDir:string,private options:HelmCodeOptions={}) {
    this.directory=join(resolve(dataDir),'code-runtime');mkdirSync(this.directory,{recursive:true,mode:0o700});this.directory=realpathSync(this.directory);
    this.env=helmEnv(options.env??process.env);
  }
  private identity(root:string,profile:string):{key:string;root:string} {
    if(typeof profile!=='string'||!profile.trim()||profile.length>200)throw new Error('Select a valid profile');
    const canonical=realpathSync(root);if(!lstatSync(canonical).isDirectory())throw new Error('Select a project folder');
    return {root:canonical,key:createHash('sha256').update(profile+'\0'+canonical).digest('hex')};
  }
  status(root:string,profile:string):HelmCodeStatus {const {key}=this.identity(root,profile);return structuredClone(this.entries.get(key)?.state??{state:'closed'});}
  async open(root:string,profile:string):Promise<HelmCodeRuntime> {
    if(this.closed)throw new Error('Code runtime is closed');const identity=this.identity(root,profile);const previous=this.entries.get(identity.key);
    if(previous?.pending)return previous.pending;
    if(previous?.state.state==='ready'&&previous.state.runtime)return structuredClone(previous.state.runtime);
    if([...this.entries.values()].filter(e=>['starting','ready'].includes(e.state.state)).length>=4)throw new Error('Close a Code workspace before opening another. Four runtimes can run at once.');
    const directory=join(this.directory,identity.key);mkdirSync(directory,{recursive:true,mode:0o700});
    const entry:Entry={root:identity.root,profile,directory,state:{state:'starting'},controller:new AbortController(),sockets:new Set(),password:randomBytes(32).toString('base64url'),cookie:randomBytes(32).toString('base64url'),cookieName:'helm_code_'+randomBytes(8).toString('hex')};
    this.entries.set(identity.key,entry);
    entry.pending=(async()=>{if(previous)await this.stop(previous);return this.launch(entry);})().catch(async error=>{await this.stop(entry);entry.state={state:'failed',error:this.safeError(error,entry)};throw new Error(entry.state.error);}).finally(()=>{entry.pending=undefined;});
    return entry.pending;
  }
  hasActiveWork():boolean{return [...this.entries.values()].some(e=>e.state.state==='starting'||e.state.state==='ready');}
  async closeWorkspace(root:string,profile:string):Promise<void>{const {key}=this.identity(root,profile);const entry=this.entries.get(key);if(!entry)return;entry.controller.abort();await entry.pending?.catch(()=>{});await this.stop(entry);this.entries.delete(key);}
  private safeError(error:unknown,entry:Entry):string {return String(error instanceof Error?error.message:error).replaceAll(entry.password,'[redacted]').replaceAll(entry.cookie,'[redacted]').slice(0,1000);}
  private childEnvironment(entry:Entry):NodeJS.ProcessEnv {
    const env={...this.env};
    // Inherited runtime addresses, database paths, config roots and telemetry
    // must never attach this project to a pre-existing global instance.
    for(const key of Object.keys(env))if(key.startsWith('OPENCODE_')||key.startsWith('OTEL_'))delete env[key];
    for(const [key,folder] of Object.entries({XDG_DATA_HOME:'data',XDG_CONFIG_HOME:'config',XDG_CACHE_HOME:'cache',XDG_STATE_HOME:'state'})){const path=join(entry.directory,folder);mkdirSync(path,{recursive:true,mode:0o700});env[key]=path;}
    // Seed each private account store once. Later account changes/removals
    // belong to this fork workspace and must survive reopening it.
    const auth=join(this.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'opencode','auth.json');
    const privateDirectory=join(env.XDG_DATA_HOME!,'opencode');mkdirSync(privateDirectory,{recursive:true,mode:0o700});
    const privateAuth=join(privateDirectory,'auth.json');
    if(!existsSync(privateAuth)){
      let value='{}';
      if(existsSync(auth)){const stat=lstatSync(auth);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw new Error('Existing OpenCode account file is not a regular bounded file');value=readFileSync(auth,'utf8');let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error('Existing OpenCode account file is invalid');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Existing OpenCode account file is invalid');}
      writeFileSync(privateAuth,value,{flag:'wx',mode:0o600,flush:true});
    }else{const stat=lstatSync(privateAuth);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw new Error('Private OpenCode account file is not a regular bounded file');}
    return {...env,OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_SERVER_PASSWORD:entry.password,OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_AUTO_SHARE:'false',OPENCODE_HELM_LOCAL_UI:'1',PWD:entry.root,INIT_CWD:entry.root};
  }
  private preferredPort(entry:Entry):number {
    const file=join(entry.directory,'gateway-port.json');const stat=lstatSync(file,{throwIfNoEntry:false});if(!stat)return 0;
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1000)throw new Error('Code gateway port preference is not a regular bounded file');
    let value:unknown;try{value=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('Code gateway port preference is invalid');}
    const port=(value as {port?:unknown})?.port;if(typeof port!=='number'||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Code gateway port preference is invalid');return port;
  }
  private savePort(entry:Entry,port:number):void {
    const file=join(entry.directory,'gateway-port.json'),temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
    writeFileSync(temporary,JSON.stringify({port})+'\n',{mode:0o600,flag:'wx',flush:true});renameSync(temporary,file);
  }
  private async launch(entry:Entry):Promise<HelmCodeRuntime> {
    entry.storage=new HelmCodeStorage(join(entry.directory,'ui-storage'));
    const requestedAssets=this.options.assetsDirectory??join(dirname(process.execPath),'helm-ui');
    if(!existsSync(join(requestedAssets,'index.html')))throw new Error('The local Helm Code interface is missing. Rebuild or reinstall Hades.');
    const assets=realpathSync(requestedAssets);
    if(!lstatSync(join(assets,'index.html')).isFile())throw new Error('The local Helm Code interface is missing. Rebuild or reinstall Hades.');
    const bundled=join(dirname(process.execPath),'helm-opencode');
    const binary=this.options.binary??bundled;
    if(!existsSync(binary))throw new Error('The bundled Helm Code runtime is missing. Rebuild or reinstall Hades; the Tasks CLI cannot replace the owned fork.');
    const provenance=this.options.binary?'configured':'bundled-fork';
    if(!this.options.binary){
      const manifest=join(assets,'helm-provenance.json');let digest:unknown;try{const stat=lstatSync(manifest);if(!stat.isFile()||stat.size>16000)throw new Error();digest=JSON.parse(readFileSync(manifest,'utf8')).runtimeSha256;}catch{throw new Error('Helm Code runtime provenance is missing. Rebuild or reinstall Hades.');}
      if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new Error('Helm Code runtime provenance is invalid. Rebuild or reinstall Hades.');
      const stat=lstatSync(binary);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Helm Code runtime must be the packaged fork binary');
      const actual=createHash('sha256');for await(const chunk of createReadStream(binary))actual.update(chunk);
      if(!equal(actual.digest('hex'),digest))throw new Error('Helm Code runtime does not match the packaged fork. Rebuild or reinstall Hades.');
    }
    const env=this.childEnvironment(entry);
    const context=this.options.context?.(entry.root)??'';if(typeof context!=='string'||Buffer.byteLength(context)>64000)throw new Error('Project context exceeds the 64 KB Code snapshot limit');
    const contextFile=join(entry.directory,'project-context.md');writeFileSync(contextFile,context,{mode:0o600,flush:true});
    env.OPENCODE_CONFIG_CONTENT=JSON.stringify({instructions:context.trim()?[contextFile]:[]});
    const version=await this.version(binary,entry.directory,env,entry.controller.signal);
    if(!new RegExp(`(^|[^0-9])${VERSION.replaceAll('.','\\.')}(?:[^0-9]|$)`).test(version))throw new Error(`Helm Code requires OpenCode ${VERSION}; this executable reports a different version.`);
    if(entry.controller.signal.aborted)throw new Error('Code runtime opening cancelled');
    const child=spawn(binary,['serve','--hostname','127.0.0.1','--port','0'],{cwd:entry.root,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],shell:false});entry.child=child;
    entry.childDone=new Promise(resolveDone=>child.once('close',()=>resolveDone()));
    if(child.pid&&process.platform!=='win32'){
      const watchdog=spawn(process.execPath,['-e',"const p=Number(process.argv[1]),g=Number(process.argv[2]);const stop=()=>{try{process.kill(-g,'SIGKILL')}catch{}process.exit(0)};process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();setInterval(()=>{try{process.kill(p,0)}catch{stop()}},250)",String(process.pid),String(child.pid)],{cwd:entry.directory,env:{...env,PWD:entry.directory,INIT_CWD:entry.directory,OPENCODE_AUTH_CONTENT:undefined,OPENCODE_SERVER_PASSWORD:undefined},detached:true,stdio:['pipe','ignore','ignore']});entry.watchdog=watchdog;watchdog.unref();watchdog.stdin?.on('error',()=>{});watchdog.on('error',()=>entry.controller.abort());
    }
    const abort=()=>this.kill(child);entry.controller.signal.addEventListener('abort',abort,{once:true});
    child.once('close',()=>{if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}entry.controller.signal.removeEventListener('abort',abort);entry.watchdog?.stdin?.end();entry.watchdog?.kill();entry.controller.abort();if(entry.state.state==='ready'){entry.state={state:'failed',error:'The Code runtime stopped. Open Code again to restart it.'};entry.gateway?.close();for(const socket of entry.sockets)socket.destroy();}});
    entry.backendPort=await new Promise<number>((resolvePort,rejectPort)=>{
      let output='';const timer=setTimeout(()=>finish(new Error('OpenCode did not start within 15 seconds. Check runtime and project folder access.')),15000);
      const finish=(error?:Error,port?:number)=>{clearTimeout(timer);child.stdout?.off('data',read);child.stderr?.off('data',read);entry.controller.signal.removeEventListener('abort',cancel);if(error)rejectPort(error);else resolvePort(port!);};
      const cancel=()=>finish(new Error('Code runtime opening cancelled'));
      const read=(data:Buffer)=>{output=(output+data.toString()).slice(-16000);const match=/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match){const port=Number(match[1]);if(port>0&&port<65536)finish(undefined,port);}};
      child.stdout?.on('data',read);child.stderr?.on('data',read);child.once('error',()=>finish(new Error('Could not launch the OpenCode runtime')));child.once('exit',()=>finish(new Error('OpenCode exited before startup completed')));entry.controller.signal.addEventListener('abort',cancel,{once:true});if(entry.controller.signal.aborted)cancel();
    });
    // Drain subsequent process output without retaining potentially private
    // account/provider messages in host status or UI errors.
    child.stdout?.resume();child.stderr?.resume();
    const health=await fetch(`http://127.0.0.1:${entry.backendPort}/global/health`,{headers:{Authorization:'Basic '+Buffer.from('opencode:'+entry.password).toString('base64')},signal:AbortSignal.any([entry.controller.signal,AbortSignal.timeout(5000)]),redirect:'error'});
    const healthBody=await health.text();let healthy=false;try{healthy=healthBody.length<8000&&JSON.parse(healthBody)?.healthy===true;}catch{}if(!health.ok||!healthy)throw new Error('OpenCode did not confirm authenticated readiness');
    const gateway=createServer((req,res)=>{void this.handle(entry,assets,req,res).catch(()=>{if(!res.headersSent)res.writeHead(502);res.end('Code request failed');});});entry.gateway=gateway;gateway.requestTimeout=15000;gateway.headersTimeout=10000;
    gateway.on('connection',socket=>{entry.sockets.add(socket);socket.once('close',()=>entry.sockets.delete(socket));});
    gateway.on('upgrade',(req,socket,head)=>this.upgrade(entry,req,socket as Socket,head));
    const listen=(port:number)=>new Promise<void>((resolveListen,rejectListen)=>{const failed=(error:Error)=>{gateway.off('listening',ready);rejectListen(error);};const ready=()=>{gateway.off('error',failed);resolveListen();};gateway.once('error',failed);gateway.once('listening',ready);gateway.listen(port,'127.0.0.1');});
    const preferred=this.preferredPort(entry);
    try{await listen(preferred);}catch(error){if(preferred&&(error as NodeJS.ErrnoException).code==='EADDRINUSE'){await listen(0);}else throw error;}

    if(entry.controller.signal.aborted)throw new Error('Code runtime opening cancelled');
    const address=gateway.address();if(!address||typeof address==='string')throw new Error('Code gateway failed to bind');entry.origin=`http://127.0.0.1:${address.port}`;this.savePort(entry,address.port);
    let revision=this.options.revision??'unknown';const manifest=join(assets,'helm-provenance.json');if(!this.options.revision&&existsSync(manifest)){const stat=lstatSync(manifest);if(stat.isFile()&&stat.size<16000){try{const value=JSON.parse(readFileSync(manifest,'utf8'));if(typeof value.revision==='string'&&value.revision.length<=200)revision=value.revision;}catch{}}}
    const runtime:HelmCodeRuntime={url:entry.origin+'/#helm_auth='+Buffer.from('opencode:'+entry.password).toString('base64')+'&helm_root='+encodeURIComponent(entry.root),version:VERSION,revision,fork:FORK,runtime:provenance,contextIncluded:!!context.trim()};entry.state={state:'ready',runtime};return structuredClone(runtime);
  }
  private version(binary:string,cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal):Promise<string>{return new Promise((resolveVersion,rejectVersion)=>{const child=spawn(binary,['--version'],{cwd,env:{...env,PWD:cwd,INIT_CWD:cwd},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});let output='';const watchdog=child.pid&&process.platform!=='win32'?spawn(process.execPath,['-e',"const p=Number(process.argv[1]),g=Number(process.argv[2]);const stop=()=>{try{process.kill(-g,'SIGKILL')}catch{}process.exit(0)};process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();setInterval(()=>{try{process.kill(p,0)}catch{stop()}},250)",String(process.pid),String(child.pid)],{cwd,env:{...env,OPENCODE_AUTH_CONTENT:undefined,OPENCODE_SERVER_PASSWORD:undefined},detached:true,stdio:['pipe','ignore','ignore']}):undefined;watchdog?.unref();watchdog?.stdin?.on('error',()=>{});watchdog?.on('error',()=>this.kill(child));const abort=()=>this.kill(child);const timer=setTimeout(abort,5000);signal.addEventListener('abort',abort,{once:true});child.stdout.on('data',b=>output=(output+b).slice(-500));child.stderr.resume();child.once('error',()=>rejectVersion(new Error('Could not check OpenCode version')));child.once('close',code=>{if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}watchdog?.stdin?.end();watchdog?.kill();clearTimeout(timer);signal.removeEventListener('abort',abort);if(code===0&&!signal.aborted)resolveVersion(output.trim());else rejectVersion(new Error('OpenCode version check failed or timed out'));});if(signal.aborted)abort();});}
  private kill(child:ChildProcess):void {try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}const timer=setTimeout(()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},250);timer.unref();}
  private url(entry:Entry,req:IncomingMessage):URL {
    if(req.headers.host!==new URL(entry.origin!).host)throw new Error('Foreign host');
    if(req.headers.origin&&req.headers.origin!==entry.origin)throw new Error('Foreign origin');
    const url=new URL(req.url??'/',entry.origin);if(url.origin!==entry.origin)throw new Error('Foreign target');
    const decoded=decodeURIComponent(url.pathname);if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').includes('..'))throw new Error('Invalid path');return url;
  }
  private authenticated(entry:Entry,req:IncomingMessage,url:URL,websocket=false):boolean {
    const expected=Buffer.from('opencode:'+entry.password).toString('base64');
    if(typeof req.headers.authorization==='string'&&equal(req.headers.authorization,'Basic '+expected))return true;
    if(websocket&&equal(url.searchParams.get('auth_token')??'',expected))return true;
    return websocket&&req.headers.origin===entry.origin&&String(req.headers.cookie??'').split(';').some(c=>equal(c.trim(),entry.cookieName+'='+entry.cookie));
  }
  private allowed(entry:Entry,value:string):void {
    if(!value||value.includes('\0'))throw new Error('Invalid directory');let path=resolve(entry.root,value);let cursor=path;const suffix:string[]=[];
    while(!existsSync(cursor)){const parent=dirname(cursor);if(parent===cursor)throw new Error('Invalid directory');suffix.unshift(cursor.slice(parent.length+1));cursor=parent;}
    path=resolve(realpathSync(cursor),...suffix);if(inside(entry.root,path))return;for(let candidate=path;;candidate=dirname(candidate)){if(this.options.ownsWorkspace?.(candidate,entry.root,entry.profile))return;if(dirname(candidate)===candidate)break;}throw new Error('Directory is outside this Code project');
  }
  private scope(entry:Entry,url:URL,req:IncomingMessage,body?:unknown):void {
    for(const [key,value]of url.searchParams){if(['directory','location','location[directory]','cwd','path','worktree'].includes(key))this.allowed(entry,value);}
    const header=req.headers['x-opencode-directory'];if(header){if(typeof header!=='string')throw new Error('Invalid directory');this.allowed(entry,decodeURIComponent(header));}
    const visit=(value:unknown,depth=0)=>{if(depth>30)throw new Error('Request is too deeply nested');if(Array.isArray(value)){for(const x of value)visit(x,depth+1);}else if(value&&typeof value==='object'){for(const [key,x]of Object.entries(value)){if(['directory','cwd','worktree','path','filePath'].includes(key)&&typeof x==='string')this.allowed(entry,x);else if(key==='location'&&typeof x==='string')this.allowed(entry,x);else if(key==='url'&&typeof x==='string'&&x.startsWith('file:'))this.allowed(entry,decodeURIComponent(new URL(x).pathname));else visit(x,depth+1);}}};visit(body);
  }
  private async handle(entry:Entry,assets:string,req:IncomingMessage,res:ServerResponse):Promise<void> {
    let url:URL;try{url=this.url(entry,req);}catch{res.writeHead(403);res.end('Foreign origin or invalid path');return;}
    if(url.pathname==='/helm-storage'){
      if(req.method!=='POST'){res.writeHead(405);res.end();return;}
      if(!this.authenticated(entry,req,url)){res.writeHead(401);res.end('Code authentication required');return;}
      if(!String(req.headers['content-type']).includes('application/json')){res.writeHead(400);res.end('Expected JSON');return;}
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>HELM_STORAGE_LIMITS.requestBytes){res.writeHead(413);res.end('Storage request exceeds limit');return;}chunks.push(chunk);}
      try{const result=entry.storage!.execute(JSON.parse(Buffer.concat(chunks).toString()));res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result));}
      catch{res.writeHead(400);res.end('Private storage request failed or exceeds limits');}return;
    }
    if(API.test(url.pathname)){
      if(!this.authenticated(entry,req,url)){res.writeHead(401);res.end('Code authentication required');return;}
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}const body=Buffer.concat(chunks);
      try{if(body.length&&!String(req.headers['content-type']).includes('application/json'))throw new Error('Expected JSON');this.scope(entry,url,req,body.length?JSON.parse(body.toString()):undefined);}catch{res.writeHead(403);res.end('Request exceeds this project scope');return;}
      res.setHeader('Set-Cookie',`${entry.cookieName}=${entry.cookie}; HttpOnly; SameSite=Strict; Path=/`);
      this.proxy(entry,req,res,url,body);return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const path=resolve(assets,'.'+decodeURIComponent(url.pathname));if(!inside(assets,path)){res.writeHead(403);res.end();return;}
    let file=path;if(!existsSync(file)||!lstatSync(file).isFile()){if(extname(url.pathname)){res.writeHead(404);res.end();return;}file=join(assets,'index.html');}
    if(!inside(assets,realpathSync(file))){res.writeHead(403);res.end();return;}
    const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm','.ico':'image/x-icon','.jpg':'image/jpeg','.webp':'image/webp'};
    res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }
  private headers(entry:Entry,req:IncomingMessage):Record<string,string|string[]|undefined>{const headers={...req.headers,host:`127.0.0.1:${entry.backendPort}`,authorization:'Basic '+Buffer.from('opencode:'+entry.password).toString('base64'),'x-opencode-directory':req.headers['x-opencode-directory']??encodeURIComponent(entry.root)};delete headers.cookie;delete headers.origin;return headers;}
  private proxy(entry:Entry,req:IncomingMessage,res:ServerResponse,url:URL,body:Buffer):void {
    const upstream=request({hostname:'127.0.0.1',port:entry.backendPort,path:url.pathname+url.search,method:req.method,headers:this.headers(entry,req)},response=>{const headers={...response.headers};delete headers['set-cookie'];delete headers['access-control-allow-origin'];res.writeHead(response.statusCode??502,headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Code runtime unavailable');});res.on('close',()=>upstream.destroy());upstream.end(body);
  }
  private upgrade(entry:Entry,req:IncomingMessage,socket:Socket,head:Buffer):void {
    let url:URL;try{url=this.url(entry,req);if(!API.test(url.pathname)||!this.authenticated(entry,req,url,true))throw new Error('Unauthorized');this.scope(entry,url,req);}catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const upstream=request({hostname:'127.0.0.1',port:entry.backendPort,path:url.pathname+url.search,headers:this.headers(entry,req)});
    upstream.on('upgrade',(response,remote,remoteHead)=>{socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', '):v}`).join('\r\n')}\r\n\r\n`);if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);socket.once('close',()=>remote.destroy());remote.once('error',()=>socket.destroy());});
    upstream.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode??502} Rejected\r\nConnection: close\r\n\r\n`);response.resume();});upstream.on('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());upstream.end();
  }
  private async stop(entry:Entry):Promise<void>{entry.controller.abort();for(const socket of entry.sockets)socket.destroy();if(entry.gateway)await new Promise<void>(r=>entry.gateway!.close(()=>r()));if(entry.child){this.kill(entry.child);await Promise.race([entry.childDone,new Promise(r=>setTimeout(r,1500))]);}entry.watchdog?.stdin?.end();entry.watchdog?.kill();entry.state={state:'closed'};}
  async close():Promise<void>{this.closed=true;await Promise.all([...this.entries.values()].map(async e=>{e.controller.abort();await e.pending?.catch(()=>{});await this.stop(e);}));}
}
