import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { HelmIntegration, type HelmIntegrationReview } from '../core/helm-integration.js';
import { HelmSourceChecks } from '../core/helm-source-checks.js';
let dir:string,root:string,service:HelmSourceChecks,review:HelmIntegrationReview,host:ConstructorParameters<typeof HelmSourceChecks>[1];
const scope=()=>({root,owner:'profile'});
const check=(script:string)=>({command:process.execPath,args:['-e',script]});
async function finish(id:string){for(let i=0;i<300;i++){const receipt=await service.get(id,scope());if(receipt.status!=='running')return receipt;await new Promise(r=>setTimeout(r,10));}throw Error('check did not finish');}
beforeEach(()=>{
 dir=realpathSync(mkdtempSync(join(tmpdir(),'helm-source-checks-')));root=join(dir,'repo');execFileSync('git',['init',root],{stdio:'pipe'});
 writeFileSync(join(root,'a.txt'),'source');execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','user.name=QA','-c','user.email=qa@example.test','commit','-m','source'],{stdio:'pipe'});
 review={id:'11111111-1111-4111-8111-111111111111',runId:'run',root,owner:'profile',revision:'task-rev',sourceRevision:'old-source',patch:'patch',files:['a.txt'],status:'applied',createdAt:1,requiresSourceChecks:true};
 const integration=new HelmIntegration(dir,{get:()=>{throw Error('unused');},diff:()=>{throw Error('unused');},ownsWorkspace:()=>false});
 host={review:(id,selected)=>{if(id!==review.id||selected.root!==root||selected.owner!==review.owner)throw Error('scope mismatch');return {...review};},fingerprint:project=>integration.sourceFingerprint(project)};
 service=new HelmSourceChecks(dir,host);
});
afterEach(async()=>{for(const receipt of await service.list(review.id,scope()))await service.cancel(receipt.id,scope());service.close();rmSync(dir,{recursive:true,force:true});});
it('retains passed actual source checks and invalidates them after later edits',async()=>{
 const started=await service.start(review.id,scope(),[check("if(require('fs').readFileSync('a.txt','utf8')!=='source')process.exit(1);console.log('checked')")]);expect(started.status).toBe('running');
 const receipt=await finish(started.id);expect(receipt.status).toBe('passed');expect(receipt.results[0].output).toContain('checked');expect(receipt.after).toBe(receipt.before);
 service=new HelmSourceChecks(dir,host);expect((await service.get(started.id,scope())).status).toBe('passed');writeFileSync(join(root,'a.txt'),'changed');expect((await service.get(started.id,scope())).status).toBe('stale');
});
it('invalidates a success if the command modifies source',async()=>{const started=await service.start(review.id,scope(),[check("require('fs').writeFileSync('a.txt','changed')")]);expect((await finish(started.id)).status).toBe('stale');});
it('reports failure and does not execute later checks',async()=>{const started=await service.start(review.id,scope(),[check('process.exit(7)'),check("require('fs').writeFileSync('should-not-exist','bad')")]);const receipt=await finish(started.id);expect(receipt.status).toBe('failed');expect(receipt.results).toHaveLength(1);expect(receipt.results[0].exitCode).toBe(7);expect(existsSync(join(root,'should-not-exist'))).toBe(false);});
it('rejects unknown scope, unapplied changes, and malformed commands',async()=>{
 await expect(service.start(review.id,{...scope(),owner:'other'},[check('')])).rejects.toThrow('scope');review.status='prepared';await expect(service.start(review.id,scope(),[check('')])).rejects.toThrow('Apply');review.status='applied';await expect(service.start(review.id,scope(),[{command:'x',args:['\0']}])).rejects.toThrow('bounded');
});
it('bounds cumulative duration and supports cancellation',async()=>{
 const slow=await service.start(review.id,scope(),[check('setTimeout(()=>{},10000)')],1);const timed=await finish(slow.id);expect(timed.status).toBe('failed');expect(timed.error).toContain('time limit');
 const cancellable=await service.start(review.id,scope(),[check('setTimeout(()=>{},10000)')]);const cancelled=await service.cancel(cancellable.id,scope());expect(cancelled.status).toBe('cancelled');
});
it('rejects duplicate simultaneous checks on one source',async()=>{const first=service.start(review.id,scope(),[check('setTimeout(()=>{},200)')]);await expect(service.start(review.id,scope(),[check('')])).rejects.toThrow('already running');await service.cancel((await first).id,scope());});
it('bounds output and uses literal argument arrays without shell expansion',async()=>{const receipt=await finish((await service.start(review.id,scope(),[{command:process.execPath,args:['-e',"console.log('x'.repeat(210000));console.log(process.argv[1])",'$(touch should-not-exist)']}])).id);expect(receipt.status).toBe('passed');expect(receipt.results[0].truncated).toBe(true);expect(receipt.results[0].output.length).toBeLessThanOrEqual(200000);expect(receipt.results[0].output).toContain('$(touch should-not-exist)');expect(existsSync(join(root,'should-not-exist'))).toBe(false);});
it('recovers a retained running receipt as interrupted without replay',async()=>{const started=await service.start(review.id,scope(),[check('')]);await finish(started.id);const path=join(dir,'helm','source-checks',started.id+'.json');const raw=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...raw,status:'running'}));service=new HelmSourceChecks(dir,host);expect((await service.get(started.id,scope())).status).toBe('interrupted');});
it('close kills active checks and retains interrupted state',async()=>{const started=await service.start(review.id,scope(),[check('setTimeout(()=>{},10000)')]);service.close();expect((await finish(started.id)).status).toBe('interrupted');await service.cancel(started.id,scope());expect((await service.get(started.id,scope())).status).toBe('interrupted');});
it.skipIf(process.platform==='win32'||process.env.HADES_TEST_NO_PROCESS_INSPECTION==='1')('cancellation terminates ordinary child process groups',async()=>{
 const marker=join(dir,'child-pid');const started=await service.start(review.id,scope(),[check(`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`)]);
 for(let i=0;i<100&&!existsSync(marker);i++)await new Promise(r=>setTimeout(r,10));expect(existsSync(marker)).toBe(true);const pid=readFileSync(marker,'utf8');
 await service.cancel(started.id,scope());let alive=false;try{alive=!execFileSync('ps',['-o','stat=','-p',pid],{stdio:['ignore','pipe','pipe']}).toString().trim().startsWith('Z');}catch(error){if((error as any).status!==1||String((error as any).stderr??'').trim())throw error;}expect(alive).toBe(false);
});
it.skipIf(process.platform==='win32'||process.env.HADES_TEST_NO_PROCESS_INSPECTION==='1')('watchdog terminates owned check descendants after host SIGKILL',async()=>{
 const marker=join(dir,'crash-child-pid'),script=join(dir,'host.mts');
 const command=`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`;
 writeFileSync(script,`import {HelmSourceChecks} from ${JSON.stringify(resolve('src/desktop/core/helm-source-checks.ts'))};const scope=${JSON.stringify(scope())};const review=${JSON.stringify(review)};const service=new HelmSourceChecks(${JSON.stringify(join(dir,'crash-data'))},{review:()=>review,fingerprint:async()=>"source"});await service.start(review.id,scope,[{command:process.execPath,args:['-e',${JSON.stringify(command)}]}]);setInterval(()=>{},1000);`);
 const child=spawn(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script],{stdio:'ignore'});
 try{
  for(let i=0;i<300&&!existsSync(marker);i++)await new Promise(r=>setTimeout(r,10));expect(existsSync(marker)).toBe(true);const pid=readFileSync(marker,'utf8');child.kill('SIGKILL');
  const alive=()=>{try{return !execFileSync('ps',['-o','stat=','-p',pid],{stdio:['ignore','pipe','pipe']}).toString().trim().startsWith('Z');}catch(error){if((error as any).status===1&&!String((error as any).stderr??'').trim())return false;throw error;}};
  for(let i=0;i<100&&alive();i++)await new Promise(r=>setTimeout(r,20));expect(alive()).toBe(false);
 }finally{child.kill('SIGKILL');}
});
it('revokes processes on close even when receipt inventory is corrupt',async()=>{
 const started=await service.start(review.id,scope(),[check('setTimeout(()=>{},10000)')]);const corrupt=join(dir,'helm','source-checks','99999999-9999-4999-8999-999999999999.json');writeFileSync(corrupt,'invalid');
 expect(()=>service.close()).not.toThrow();rmSync(corrupt);await service.cancel(started.id,scope());expect((await service.get(started.id,scope())).status).toBe('interrupted');
});
