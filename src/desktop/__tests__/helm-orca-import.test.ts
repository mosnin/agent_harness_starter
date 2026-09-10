import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { HelmOrcaService } from '../core/helm-orca-service';
import { orcaImportGit as git, materializeOrcaImport, assertOrcaImportDescriptor } from '../core/helm-orca-import';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'orca-import-test-')));dirs.push(dir);
 await git(dir,['init']);await git(dir,['config','user.email','fixture@example.invalid']);await git(dir,['config','user.name','Fixture']);
 writeFileSync(join(dir,'file.txt'),'before');writeFileSync(join(dir,'deleted.txt'),'remove');await git(dir,['add','.']);await git(dir,['commit','-m','base']);
 const workspace=join(dir,'../'+randomUUID());dirs.push(workspace);await git(dir,['worktree','add','--detach',workspace]);
 let base='',live=false;
 const calls:string[]=[];
 const call=async(method:string,params:any)=>{calls.push(method);if(method==='orchestration.runCreate')return {run:{id:'run'}};if(method==='orchestration.workerStart'){base=params.baseBranch;return {state:'ready',dispatchId:'dispatch'};}
 if(method==='worktree.show')return {worktree:{id:'worktree',repoId:'repo',git:{path:workspace}}};
 return {dispatch:{id:'dispatch'},worker:{dispatchId:'dispatch',runtimeEpoch:'runtime',startOptions:{baseBranch:base},worktreeId:'worktree'},observation:{exactWorker:true,status:live?'live':'exited'}};};
 const service=new HelmOrcaService(join(dir,'.state'),{connect:async()=>({runtimeId:'runtime',repo:'repo',coordinator:'coordinator',call})});
 const scope={root:dir,profile:'p'},id=randomUUID();await service.start(scope,{requestId:id,prompt:'fix',agent:'codex'});
 return {dir,workspace,service,scope,id,calls,setLive:(value:boolean)=>{live=value;}};
}
it('pins real base and imports changed, new binary and deleted bytes without mutating source',async()=>{
 const f=await fixture();try{
 writeFileSync(join(f.workspace,'file.txt'),'after');chmodSync(join(f.workspace,'file.txt'),0o755);rmSync(join(f.workspace,'deleted.txt'));writeFileSync(join(f.workspace,'image.bin'),Buffer.from([0,255,1]));
 const d=await f.service.prepareImport(f.scope,f.id);expect(d.baseSha).toMatch(/^[a-f0-9]{40}$/);
 const target=join(f.dir,'../'+randomUUID());dirs.push(target);await materializeOrcaImport(d,target);
 expect(readFileSync(join(target,'file.txt'),'utf8')).toBe('after');expect(existsSync(join(target,'deleted.txt'))).toBe(false);expect(statSync(join(target,'file.txt')).mode&0o111).not.toBe(0);expect(readFileSync(join(target,'image.bin'))).toEqual(Buffer.from([0,255,1]));expect(readFileSync(join(f.dir,'file.txt'),'utf8')).toBe('before');
 expect(f.calls.filter(x=>x==='orchestration.workerStart')).toHaveLength(1);
 }finally{await f.service.close();}
});
it('refuses live workers and cross-profile import',async()=>{const f=await fixture();try{f.setLive(true);await expect(f.service.prepareImport(f.scope,f.id)).rejects.toThrow('unconfirmed');await expect(f.service.prepareImport({...f.scope,profile:'other'},f.id)).rejects.toThrow('owned');}finally{await f.service.close();}});
it.each([1,2,3])('rejects output drift before materialization on repeated boundary %i',async()=>{const f=await fixture();try{const d=await f.service.prepareImport(f.scope,f.id);writeFileSync(join(f.workspace,'file.txt'),'changed');await expect(assertOrcaImportDescriptor(d)).rejects.toThrow('changed');}finally{await f.service.close();}});
it('pre-aborted import has no bridge calls',async()=>{const f=await fixture();try{const before=f.calls.length,controller=new AbortController();controller.abort();await expect(f.service.prepareImport(f.scope,f.id,controller.signal)).rejects.toThrow();expect(f.calls).toHaveLength(before);}finally{await f.service.close();}});
it('refuses local clean filters before processing content',async()=>{const f=await fixture();try{await git(f.dir,['config','filter.danger.clean','touch SHOULD_NOT_EXIST']);writeFileSync(join(f.workspace,'.gitattributes'),'* filter=danger');await expect(f.service.prepareImport(f.scope,f.id)).rejects.toThrow('filters');expect(existsSync(join(f.workspace,'SHOULD_NOT_EXIST'))).toBe(false);}finally{await f.service.close();}});
it('refuses legacy/synthetic records without dispatch-time source identity',async()=>{const f=await fixture();const service=new HelmOrcaService(join(f.dir,'.legacy'),{resolveBase:async()=> 'a'.repeat(40),connect:async()=>({runtimeId:'r',repo:'p',coordinator:'c',call:async method=>method==='orchestration.runCreate'?{run:{id:'run'}}:{state:'ready',dispatchId:'d'}})});try{const id=randomUUID();await service.start(f.scope,{requestId:id,prompt:'legacy',agent:'codex'});await expect(service.prepareImport(f.scope,id)).rejects.toThrow('provenance');}finally{await service.close();await f.service.close();}});
