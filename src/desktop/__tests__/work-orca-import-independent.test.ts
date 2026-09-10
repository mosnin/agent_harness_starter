import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DurableWork } from '../core/durable-work';
const deps={root:(p:string)=>p,profile:()=>{},execute:async()=>({answer:'unused',tokens:0})};
it('clean shutdown cancellation before any source effect must not strand a permanent reservation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'work-import-review-')),file=join(dir,'work.sqlite');const work=new DurableWork(file,deps);let effect=false;
 const pending=work.withSourceOperation(dir,'p','fixture-no-effect',undefined,async signal=>{
   await new Promise<void>((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});effect=true;
 });
 const outcome=pending.catch(()=>{});await Promise.resolve();work.close();await outcome;
 const reopened=new DurableWork(file,deps);
 try{expect(effect).toBe(false);expect(reopened.sourceOperationStatus('p')).toEqual([]);}
 finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});
it('active source reservation blocks a second desktop and disappears after normal settlement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'work-import-review-')),file=join(dir,'work.sqlite'),a=new DurableWork(file,deps),b=new DurableWork(file,deps);let release!:()=>void;
 const pending=a.withSourceOperation(dir,'p','fixture',undefined,async(_signal,guard)=>{await new Promise<void>(resolve=>{release=resolve;});guard();});
 try{await Promise.resolve();await expect(b.withSourceOperation(dir,'p','other',undefined,async()=>{})).rejects.toThrow('unconfirmed');release();await pending;await expect(b.withSourceOperation(dir,'p','next',undefined,async()=>true)).resolves.toBe(true);}
 finally{release?.();await pending.catch(()=>{});a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

it('import binding rechecks revoked authority inside its write transaction',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'work-import-review-')),work=new DurableWork(join(dir,'work.sqlite'),{...deps,execute:async input=>{input.markDispatchIntent();return {answer:'inspect',tokens:NaN,error:'review required'};}});
 try{
  const goal=work.create({root:dir,objective:'fixture',tasks:[{id:'t',title:'task',prompt:'fix',engine:{kind:'orca',agent:'codex'},writes:[]}]},'p');work.run(goal.id,'p');
  await vi.waitFor(()=>expect(['needs_review','budget_exhausted']).toContain(work.get(goal.id,'p').status));
  const {engine,attempt}=work.orcaTask(goal.id,'p','t');let calls=0;
  const guard=()=>{if(++calls>=2)throw new Error('authority revoked before atomic edit');};
  expect(()=>work.bindOrcaImport(goal.id,'p','t',{runId:'run',requestId:engine.requestId,attemptId:attempt.id,revision:'a'.repeat(64),importedAt:1},guard)).toThrow('revoked');
  expect(work.get(goal.id,'p').tasks[0].orcaImports).toBeUndefined();
 }finally{await work.close();rmSync(dir,{recursive:true,force:true});}
});

it('acceptance rollback preserves unknown usage when its atomic guard is revoked',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'work-import-review-'));writeFileSync(join(dir,'result.txt'),'reviewed');
 const work=new DurableWork(join(dir,'work.sqlite'),{...deps,execute:async input=>{input.markDispatchIntent();return {answer:'inspect',tokens:NaN,error:'review required'};}});
 try{
  const goal=work.create({root:dir,objective:'fixture',tasks:[{id:'t',title:'task',prompt:'fix',engine:{kind:'orca',agent:'codex'},writes:[],acceptance:[{path:'result.txt',contains:'reviewed'}]}]},'p');work.run(goal.id,'p');
  await vi.waitFor(()=>expect(['needs_review','budget_exhausted']).toContain(work.get(goal.id,'p').status));
  const {engine,attempt}=work.orcaTask(goal.id,'p','t');
  work.bindOrcaImport(goal.id,'p','t',{runId:'run',requestId:engine.requestId,attemptId:attempt.id,revision:'a'.repeat(64),importedAt:1},()=>{});
  const before=work.get(goal.id,'p').tasks[0];let calls=0;
  expect(()=>work.acceptOrca(goal.id,'p','t',{runId:'run',requestId:engine.requestId,reviewId:'review',sourceCheckId:'check',sourceRevision:'a'.repeat(64),patchDigest:'b'.repeat(64)},()=>{if(++calls===3)throw new Error('revoked inside transaction');})).toThrow('revoked');
  const after=work.get(goal.id,'p').tasks[0];expect(after.orcaAcceptance).toBeUndefined();expect(after.reservedTokens).toBe(before.reservedTokens);expect(after.attempts).toEqual(before.attempts);
 }finally{await work.close();rmSync(dir,{recursive:true,force:true});}
});
