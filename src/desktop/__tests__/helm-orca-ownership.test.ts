import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({spawn:vi.fn(),request:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn}));
vi.mock('../core/helm-orca-transport',()=>({orcaRequest:mocks.request}));
import { HelmOrcaRuntime } from '../core/helm-orca-runtime';
const roots:string[]=[],runtimes:HelmOrcaRuntime[]=[];
afterEach(async()=>{runtimes.splice(0).forEach(runtime=>runtime.close());await new Promise(done=>setTimeout(done,110));roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));vi.clearAllMocks();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'orca-runtime-ownership-'));roots.push(root);const artifact=join(root,'artifact');mkdirSync(artifact);
  const files=['orcad.js','daemon-entry.js','parcel-watcher-process-entry.js'].map(path=>{const data='// inert test fixture';writeFileSync(join(artifact,path),data);return {path,sha256:createHash('sha256').update(data).digest('hex')};});
  const manifest={sourceRevision:'bf4e2705046cf9ef9c915929a9646da85717af07',platform:process.platform,arch:process.arch,files};
  const manifestPath=join(artifact,'helm-orca-build.json');writeFileSync(manifestPath,JSON.stringify(manifest));
  const runtime=new HelmOrcaRuntime(join(root,'runtime'),artifact);runtimes.push(runtime);
  return {root,artifact,manifest,manifestPath,runtime,scope:{root,profile:'p'}};
}

it('keeps one shared runtime alive when only one of its waiting tasks cancels',async()=>{
  const f=fixture(),kill=vi.fn(()=>true);let releaseStatus!:(value:unknown)=>void;
  mocks.spawn.mockImplementation((_exe,_args,options)=>{
    const child=Object.assign(new EventEmitter(),{pid:900001,kill});
    writeFileSync(join(options.env.ORCA_USER_DATA_PATH,'orca-runtime.json'),JSON.stringify({pid:child.pid,runtimeId:'owned-runtime',authToken:'fixture-only',transports:[{kind:'unix',endpoint:'inert-fixture'}]}));
    return child;
  });
  mocks.request.mockImplementation(async(_meta,method)=>{
    if(method==='status.get')return new Promise(done=>{releaseStatus=done;});
    if(method==='repo.add')return {repo:{id:'repo-owned'}};
    if(method==='worktree.create')return {worktree:{id:'worktree-owned'}};
    if(method==='terminal.create')return {terminal:{handle:'terminal-owned'}};
    throw new Error('Unexpected fixture RPC');
  });
  const first=new AbortController(),second=new AbortController();
  const cancelled=f.runtime.connect(f.scope,first.signal);
  const continuing=f.runtime.connect(f.scope,second.signal);
  first.abort();await expect(cancelled).rejects.toThrow();expect(kill).not.toHaveBeenCalled();
  releaseStatus({runtimeId:'owned-runtime',runtimeProtocolVersion:3,capabilities:['orchestration.contract.v1']});
  expect(await continuing).toMatchObject({runtimeId:'owned-runtime',coordinator:'terminal-owned',repo:'repo-owned'});
  expect(mocks.spawn).toHaveBeenCalledTimes(1);expect(kill).not.toHaveBeenCalled();
});

it.each(['duplicate','path escape','changed bytes','wrong platform'])('rejects %s artifacts before spawning',async condition=>{
  const f=fixture();
  if(condition==='duplicate')f.manifest.files.push(f.manifest.files[0]);
  if(condition==='path escape')f.manifest.files.push({...f.manifest.files[0],path:'../outside'});
  if(condition==='changed bytes')writeFileSync(join(f.artifact,'orcad.js'),'changed');
  if(condition==='wrong platform')(f.manifest as any).platform='not-this-platform';
  writeFileSync(f.manifestPath,JSON.stringify(f.manifest));
  await expect(f.runtime.connect(f.scope,new AbortController().signal)).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
