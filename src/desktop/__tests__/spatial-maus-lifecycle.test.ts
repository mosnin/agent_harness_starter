import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MausCompanion} from '../core/maus-companion';
const owned:Array<{dir:string;maus:MausCompanion;started:string}>=[];
afterEach(async()=>{for(const item of owned.splice(0)){const pid=(item.maus as unknown as {child?:{pid?:number}}).child?.pid ?? (existsSync(item.started)?JSON.parse(readFileSync(item.started,'utf8')).pid:undefined);item.maus.close();if(pid){await vi.waitFor(()=>{let alive=true;try{process.kill(pid,0);}catch{alive=false;}expect(alive).toBe(false);},{timeout:2000});}rmSync(item.dir,{recursive:true,force:true});}});
function fixture(mode='delayed'){
 const dir=mkdtempSync(join(tmpdir(),'maus-lifecycle-')),app=join(dir,'HadesMaus.app'),bin=join(app,'Contents','MacOS'),runtime=join(dir,'runtime'),started=join(dir,'started'),bridgeStarted=join(dir,'bridge-started');mkdirSync(bin,{recursive:true});mkdirSync(runtime,{mode:0o700});
 const appScript=`#!${process.execPath}
 const fs=require('node:fs'),path=require('node:path'),runtime=${JSON.stringify(runtime)},mode=${JSON.stringify(mode)};
 fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),parent:process.env.HADES_MAUS_PARENT,home:process.env.HOME}));
 if(mode==='exit')process.exit(7);
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
 setTimeout(()=>{fs.writeFileSync(path.join(runtime,'port'),mode==='invalid'?'999999':'19801',{mode:0o600});},mode==='delayed'?300:50);
 `;
 const bridgeScript=`#!${process.execPath}
 const fs=require('node:fs'),rl=require('node:readline'),path=require('node:path');
 const args=process.argv.slice(2),runtime=args[args.indexOf('--runtime-directory')+1];
 fs.writeFileSync(${JSON.stringify(bridgeStarted)},JSON.stringify({args,port:fs.existsSync(path.join(runtime||'/nonexistent','port'))?fs.readFileSync(path.join(runtime,'port'),'utf8'):null}));
 if(!args.includes('--no-launch')||runtime!==${JSON.stringify(runtime)}||!fs.existsSync(path.join(runtime,'port')))process.exit(8);
 rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'hadesmaus_get_context',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'Owned fixture response'}],structuredContent:{captures:[{captureId:'cap_01ARZ3NDEKTSV4RRFFQ69G5FAV',createdAt:'2026-09-10T00:00:00Z'}]}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
 `;
 for(const [name,body]of [['HadesMaus',appScript],['hadesmaus-mcp-bridge',bridgeScript]]){writeFileSync(join(bin,name),body);chmodSync(join(bin,name),0o700);}
 const maus=new MausCompanion({...process.env,NODE_ENV:'test',HADES_MAUS_APP:app},runtime);owned.push({dir,maus,started});
 return {dir,runtime,maus,started,bridgeStarted,capture:(signal=new AbortController().signal)=>maus.capture(dir,signal,undefined,'latest','Fixture')};
}
it('waits for owned publication and passes no-launch with the explicit private runtime to the real bridge process',async()=>{
 const f=fixture();const pending=f.capture();await vi.waitFor(()=>expect(existsSync(f.started)).toBe(true));expect(existsSync(f.bridgeStarted)).toBe(false);
 const result=await pending;expect(result.context.captureId).toBe('cap_01ARZ3NDEKTSV4RRFFQ69G5FAV');expect(result.images).toEqual([]);
 expect(JSON.parse(readFileSync(f.bridgeStarted,'utf8'))).toEqual({args:['--no-launch','--runtime-directory',f.runtime],port:'19801'});
 const startup=JSON.parse(readFileSync(f.started,'utf8'));expect(startup.args).toEqual(['--hades-embedded']);expect(startup.parent).toBe(String(process.pid));expect(startup.home).toBe(process.env.HOME);
});
it('refuses an existing publication before spawning either process',async()=>{
 const f=fixture();writeFileSync(join(f.runtime,'port'),'19801');expect(f.maus.status().available).toBe(false);await expect(f.capture()).rejects.toThrow(/standalone|discovery/);expect(existsSync(f.started)).toBe(false);expect(existsSync(f.bridgeStarted)).toBe(false);
});
it('cancelled startup cannot launch a late bridge when its helper later publishes',async()=>{
 const f=fixture(),abort=new AbortController(),pending=f.capture(abort.signal),rejected=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(existsSync(f.started)).toBe(true));abort.abort();await rejected;
 await vi.waitFor(()=>expect(existsSync(join(f.runtime,'port'))).toBe(true));expect(existsSync(f.bridgeStarted)).toBe(false);
});
it('close during startup cancels pending work and prevents a late bridge',async()=>{
 const f=fixture(),pending=f.capture(),rejected=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(existsSync(f.started)).toBe(true));f.maus.close();await rejected;expect(existsSync(f.bridgeStarted)).toBe(false);await expect(f.capture()).rejects.toThrow(/closing/);
});
it('child exit before publication refuses the request without a bridge',async()=>{
 const f=fixture('exit');await expect(f.capture()).rejects.toThrow(/exited/);expect(existsSync(f.bridgeStarted)).toBe(false);
});
it('invalid publication cannot start the bridge',async()=>{
 const f=fixture('invalid');await expect(f.capture()).rejects.toThrow(/Invalid Maus/);expect(existsSync(f.bridgeStarted)).toBe(false);
});
it('a dangling discovery symlink is an existing publication and refuses before spawning',async()=>{
 const f=fixture();symlinkSync(join(f.runtime,'missing'),join(f.runtime,'port'));await expect(f.capture()).rejects.toThrow();expect(f.maus.status().running).toBe(false);expect(existsSync(f.started)).toBe(false);expect(existsSync(f.bridgeStarted)).toBe(false);
});
