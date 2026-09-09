import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, unlinkSync, symlinkSync, existsSync, chmodSync, statSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HelmService } from '../core/helm-service.js';
import { HelmIntegration } from '../core/helm-integration.js';
let dir: string, root: string, service: HelmService, integration: HelmIntegration;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
const scope = () => ({root, owner: 'profile', parentSession: 'parent'});
const hash = (patch: string) => createHash('sha256').update(patch).digest('hex');
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'helm-integration-'))); root = join(dir, 'repo');
  execFileSync('git', ['init', root], {stdio:'pipe'}); git('config','user.name','QA'); git('config','user.email','qa@example.test');
  writeFileSync(join(root,'a.txt'),'base\n'); writeFileSync(join(root,'delete.txt'),'delete'); git('add','.');git('commit','-m','base');
  service = new HelmService(join(dir,'data'), () => {}, {runBuiltin: async input => {
    writeFileSync(join(input.root,'a.txt'),'changed\n'); unlinkSync(join(input.root,'delete.txt'));
    writeFileSync(join(input.root,'new.bin'), Buffer.from([0,1,255,3])); return {output:'done'};
  }});
  integration = new HelmIntegration(join(dir,'data'), service);
});
afterEach(async () => { await Promise.all(service.list().map(r => service.cancel(r.id))); service.close(); rmSync(dir,{recursive:true,force:true}); });
async function ready() {
  const run = await service.start({...scope(),agent:'hades',prompt:'fixture'});
  for(let i=0;i<300 && ['running','starting'].includes(service.get(run.id).status);i++) await new Promise(r=>setTimeout(r,10));
  await service.verify(run.id,[{command:process.execPath,args:['-e','process.exit(0)']}]);
  return run.id;
}
it('applies binary/addition/deletion once, preserves source index and flags fresh source checks', async () => {
  const id = await ready(); const indexBefore = git('diff','--cached');
  const review = await integration.prepare(id,scope());
  expect(review.patch).toContain('GIT binary patch');
  const [first, duplicate] = await Promise.all([integration.apply(review.id,scope(),hash(review.patch)),integration.apply(review.id,scope(),hash(review.patch))]);
  expect(first.status).toBe('applied');expect(duplicate.appliedAt).toBe(first.appliedAt);
  expect(first.requiresSourceChecks).toBe(true);expect(readFileSync(join(root,'a.txt'),'utf8')).toBe('changed\n');
  expect(readFileSync(join(root,'new.bin'))).toEqual(Buffer.from([0,1,255,3]));expect(existsSync(join(root,'delete.txt'))).toBe(false);
  expect(git('diff','--cached')).toBe(indexBefore);
  integration = new HelmIntegration(join(dir,'data'),service);
  expect((await integration.apply(review.id,scope(),hash(review.patch))).appliedAt).toBe(first.appliedAt);
});
it('preserves unrelated staged/dirty source changes',async()=>{
  const id=await ready(); writeFileSync(join(root,'local.txt'),'local');git('add','local.txt');
  const staged=git('diff','--cached');const review=await integration.prepare(id,scope());
  await integration.apply(review.id,scope(),hash(review.patch));expect(git('diff','--cached')).toBe(staged);
});
it('rejects source drift after review',async()=>{
  const review=await integration.prepare(await ready(),scope());writeFileSync(join(root,'local.txt'),'new change');
  await expect(integration.apply(review.id,scope(),hash(review.patch))).rejects.toThrow('Source changed');
  expect(readFileSync(join(root,'a.txt'),'utf8')).toBe('base\n');
});
it('rejects conflicting dirty tracked source without partial application',async()=>{
  const id=await ready();writeFileSync(join(root,'a.txt'),'source edit\n');
  await expect(integration.prepare(id,scope())).rejects.toThrow('conflicts');expect(existsSync(join(root,'delete.txt'))).toBe(true);
});
it('rejects untracked source collision without overwrite',async()=>{
  const id=await ready();writeFileSync(join(root,'new.bin'),'user data');
  await expect(integration.prepare(id,scope())).rejects.toThrow('conflicts');expect(readFileSync(join(root,'new.bin'),'utf8')).toBe('user data');
});
it('rejects changed task and stale checks',async()=>{
  const id=await ready();const review=await integration.prepare(id,scope());writeFileSync(join(service.get(id).workspace,'a.txt'),'later edit');
  await expect(integration.apply(review.id,scope(),hash(review.patch))).rejects.toThrow('Task changed');
});
it('refuses wrong scope and incorrect review hash',async()=>{
  const id=await ready();await expect(integration.prepare(id,{...scope(),owner:'other'})).rejects.toThrow('scope');
  const review=await integration.prepare(id,scope());
  await expect(integration.apply(review.id,{...scope(),parentSession:'other'},hash(review.patch))).rejects.toThrow('scope');
  await expect(integration.apply(review.id,scope(),'wrong')).rejects.toThrow('patch changed');
});
it('never retries an uncertain persisted apply after restart',async()=>{
  const review=await integration.prepare(await ready(),scope());
  const file=join(dir,'data','helm','integration',review.id+'.json');writeFileSync(file,JSON.stringify({...review,status:'applying'}));
  integration=new HelmIntegration(join(dir,'data'),service);
  await expect(integration.apply(review.id,scope(),hash(review.patch))).rejects.toThrow('uncertain');
  expect(readFileSync(join(root,'a.txt'),'utf8')).toBe('base\n');
});
it('refuses unverified tasks',async()=>{
  const id=await ready();writeFileSync(join(service.get(id).workspace,'a.txt'),'changed again');await service.diff(id);
  await expect(integration.prepare(id,scope())).rejects.toThrow('Verify');
});
it('rejects a symlink collision without touching its target',async()=>{
  const id=await ready();const outside=join(dir,'outside');writeFileSync(outside,'private');symlinkSync(outside,join(root,'new.bin'));
  await expect(integration.prepare(id,scope())).rejects.toThrow('conflicts');expect(readFileSync(outside,'utf8')).toBe('private');
});
it('serializes separate reviews and requires re-review after the first integration',async()=>{
  const id=await ready();const first=await integration.prepare(id,scope()),second=await integration.prepare(id,scope());
  const result=await Promise.allSettled([integration.apply(first.id,scope(),hash(first.patch)),integration.apply(second.id,scope(),hash(second.patch))]);
  expect(result[0].status).toBe('fulfilled');expect(result[1].status).toBe('rejected');
  expect(String((result[1] as PromiseRejectedResult).reason)).toContain('Source changed');
});
it('rejects source HEAD drift even when source bytes match the original review',async()=>{
  const review=await integration.prepare(await ready(),scope());git('commit','--allow-empty','-m','source advanced');
  await expect(integration.apply(review.id,scope(),hash(review.patch))).rejects.toThrow('Source changed');
});
it('rejects running tasks through the host contract',async()=>{
  const id=await ready();const guarded=new HelmIntegration(join(dir,'other-data'),{
    get: id=>({...service.get(id),status:'running'}),diff: id=>service.diff(id),ownsWorkspace: root=>service.ownsWorkspace(root),
  });
  await expect(guarded.prepare(id,scope())).rejects.toThrow('Verify');
});
it('disables repository fsmonitor and hooks during preparation and apply',async()=>{
  const id=await ready(), marker=join(dir,'hook-ran'), script=join(dir,'hook');
  writeFileSync(script,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});git('config','core.fsmonitor',script);git('config','core.hooksPath',dir);
  const review=await integration.prepare(id,scope());await integration.apply(review.id,scope(),hash(review.patch));expect(existsSync(marker)).toBe(false);
});
it('rejects configured clean filters before reading any diff or invoking the filter',async()=>{
  const id=await ready(),marker=join(dir,'filter-ran'),script=join(dir,'filter');
  writeFileSync(script,`#!/bin/sh\ntouch '${marker}'\ncat\n`,{mode:0o700});
  git('config','filter.danger.clean',script);writeFileSync(join(root,'.gitattributes'),'*.txt filter=danger\n');
  writeFileSync(join(service.get(id).workspace,'.gitattributes'),'*.txt filter=danger\n');
  await expect(integration.prepare(id,scope())).rejects.toThrow('filters');expect(existsSync(marker)).toBe(false);
});
it.each(['--skip-worktree','--assume-unchanged'])('rejects hidden source edits using %s',async flag=>{
  const id=await ready();git('update-index',flag,'a.txt');writeFileSync(join(root,'a.txt'),'hidden edit');
  await expect(integration.prepare(id,scope())).rejects.toThrow('flags');expect(readFileSync(join(root,'a.txt'),'utf8')).toBe('hidden edit');
});
it('lists uncertain receipts after restart and blocks a replacement review',async()=>{
  const id=await ready(),review=await integration.prepare(id,scope());
  writeFileSync(join(dir,'data','helm','integration',review.id+'.json'),JSON.stringify({...review,status:'applying'}));
  integration=new HelmIntegration(join(dir,'data'),service);
  expect(integration.list(id,scope())[0].status).toBe('applying');await expect(integration.prepare(id,scope())).rejects.toThrow('unresolved');
});
it('returns the accepted receipt when preparing an already integrated revision',async()=>{
  const id=await ready(),review=await integration.prepare(id,scope());await integration.apply(review.id,scope(),hash(review.patch));
  expect((await integration.prepare(id,scope())).id).toBe(review.id);
});
it('rejects source-only smudge attributes on a newly added task path without executing them',async()=>{
 const id=await ready(),marker=join(dir,'smudge-ran'),script=join(dir,'smudge');
 writeFileSync(script,`#!/bin/sh\ntouch '${marker}'\ncat\n`,{mode:0o700});git('config','filter.danger.smudge',script);
 writeFileSync(join(root,'.gitattributes'),'new.bin filter=danger\n');
 await expect(integration.prepare(id,scope())).rejects.toThrow('filters');expect(existsSync(marker)).toBe(false);
});
it('rejects new nested repositories staged as gitlinks',async()=>{
 const id=await ready(),workspace=service.get(id).workspace,nested=join(workspace,'nested');
 execFileSync('git',['init',nested],{stdio:'pipe'});execFileSync('git',['-C',nested,'-c','user.name=QA','-c','user.email=qa@example.test','commit','--allow-empty','-m','base'],{stdio:'pipe'});
 await service.verify(id,[{command:process.execPath,args:['-e','process.exit(0)']}]);
 await expect(integration.prepare(id,scope())).rejects.toThrow();
});
it('preserves executable-mode changes and literal symlink additions',async()=>{
 const id=await ready(),workspace=service.get(id).workspace;chmodSync(join(workspace,'a.txt'),0o755);symlinkSync('a.txt',join(workspace,'alias'));
 await service.verify(id,[{command:process.execPath,args:['-e','process.exit(0)']}]);
 const review=await integration.prepare(id,scope());await integration.apply(review.id,scope(),hash(review.patch));
 expect(statSync(join(root,'a.txt')).mode&0o111).toBe(0o111);expect(readlinkSync(join(root,'alias'))).toBe('a.txt');
});
