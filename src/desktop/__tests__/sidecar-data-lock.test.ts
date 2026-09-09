import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { acquireSidecarDataLock, type SidecarDataLock } from '../core/sidecar-data-lock.js';
let directory: string;
const leases: SidecarDataLock[] = [], children: ChildProcess[] = [];
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'hades-data-owner-'));});
afterEach(async()=>{
 for(const child of children.splice(0)) { if(child.exitCode===null && child.signalCode===null) { const ended=once(child,'exit');child.kill('SIGKILL');await ended; } }
 for(const lease of leases.splice(0)) lease.release();rmSync(directory,{recursive:true,force:true});
});
function lock(path=directory) { const result=acquireSidecarDataLock(path);leases.push(result);return result; }
it('prevents overlapping ownership and permits a clean release without deleting the lock inode',()=>{
 const first=lock(),path=join(directory,'desktop-owner.sqlite'),inode=statSync(path).ino;
 expect(statSync(path).mode&0o777).toBe(0o600);
 expect(()=>lock()).toThrow('already using');first.release();first.release();
 lock();expect(statSync(path).ino).toBe(inode);
});
it('canonicalizes folder aliases and leaves unrelated data folders independent',()=>{
 const actual=join(directory,'actual'),alias=join(directory,'alias');lock(actual);symlinkSync(actual,alias);
 expect(()=>lock(alias)).toThrow('already using');expect(lock(join(directory,'other')).directory).toBe(realpathSync(join(directory,'other')));
});
it('rejects redirected ownership files without touching their targets',()=>{
 const outside=join(directory,'outside');writeFileSync(outside,'do not alter');symlinkSync(outside,join(directory,'desktop-owner.sqlite'));
 expect(()=>lock()).toThrow('private regular file');expect(statSync(outside).size).toBe(12);
});
it('retains corrupt lock files for inspection instead of deleting or overwriting them',()=>{
 const file=join(directory,'desktop-owner.sqlite');writeFileSync(file,'not a sqlite database');
 expect(()=>lock()).toThrow();expect(statSync(file).size).toBe(21);
});
async function childOwner() {
 const module=resolve('src/desktop/core/sidecar-data-lock.ts');
 const script=`const { acquireSidecarDataLock } = require(${JSON.stringify(module)}); const lock=acquireSidecarDataLock(process.argv[1]); process.stdout.write('OWNED\\n'); setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--require','tsx/cjs','-e',script,directory],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});children.push(child);
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Child lock timeout')),5000);
  child.stdout!.once('data',chunk=>{clearTimeout(timer);String(chunk).includes('OWNED')?resolve():reject(new Error('Unexpected child output'));});
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Child exited ${code}`));});
 });return child;
}
it('uses a real OS lock across processes and recovers immediately after SIGKILL without PID cleanup',async()=>{
 const child=await childOwner();expect(()=>lock()).toThrow('already using');
 const file=join(directory,'desktop-owner.sqlite'),inode=statSync(file).ino;
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 expect(existsSync(file)).toBe(true);lock();expect(statSync(file).ino).toBe(inode);
});
it('does not unlock another owner when a failed contender closes its connection',async()=>{
 await childOwner();expect(()=>lock()).toThrow('already using');expect(()=>lock()).toThrow('already using');
});
it('returns actionable native boot RPC failure without constructing a second workspace',async()=>{
 lock();
 const script=resolve('src/desktop/sidecar-entry.ts');
 const child=spawn(process.execPath,['--require','tsx/cjs',script],{cwd:process.cwd(),env:{...process.env,HADES_DATA_DIR:directory},stdio:['pipe','pipe','pipe']});children.push(child);
 const answer=new Promise<any>((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(new Error('Native boot rejection timed out')),5000);
  child.stdout!.on('data',chunk=>{buffer+=String(chunk);for(const line of buffer.split('\n')){try{const value=JSON.parse(line);if(value.kind==='desktop.response'){clearTimeout(timer);resolve(value);}}catch{}}});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
 });
 child.stdin!.write(JSON.stringify({kind:'desktop.request',id:'boot-test',method:'boot',args:{}})+'\n');
 const response=await answer;expect(response).toMatchObject({kind:'desktop.response',id:'boot-test',error:expect.stringContaining('Close the other Hades application')});
 expect(existsSync(join(directory,'desktop.json'))).toBe(false);expect(existsSync(join(directory,'runs.json'))).toBe(false);
 const exited=once(child,'exit');child.stdin!.end();await exited;expect(child.exitCode).toBe(0);
});
it('bounds rejected-instance lines and never treats malformed input as a request',async()=>{
 const {serveSidecarLockFailure,SidecarDataInUseError}=await import('../core/sidecar-data-lock.js');
 const output:string[]=[];
 async function* input(){yield 'x'.repeat(70000);yield '\ninvalid\n';yield JSON.stringify({kind:'desktop.request',id:'safe',method:'shell.exec'})+'\n';}
 await serveSidecarLockFailure(input(),line=>output.push(line),new SidecarDataInUseError());
 expect(output).toHaveLength(1);expect(JSON.parse(output[0])).toMatchObject({id:'safe',error:expect.stringContaining('already using')});
});
