import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DurableWork, type WorkExecution } from '../core/durable-work';

it('reuses spare capacity when a foreign reservation ends while a local worker is still running', async () => {
  const root=mkdtempSync(join(tmpdir(),'hades-work-scheduling-'));
  const running=new Map<string, (result:{answer:string;tokens:number})=>void>();
  const observed:string[]=[];
  const deps={root:(path:string)=>path,profile:()=>{},execute:async(input:WorkExecution)=>{
    observed.push(input.task);return new Promise<{answer:string;tokens:number}>(done=>running.set(input.task,done));
  }};
  const a=new DurableWork(join(root,'work.sqlite'),deps),b=new DurableWork(join(root,'work.sqlite'),deps);
  const task=(id:string,writes:string[])=>({id,title:id,prompt:id,writes});
  try {
    const foreign=a.create({root,objective:'first owner',tasks:[task('foreign',['shared.ts'])]},'p');
    const local=b.create({root,objective:'parallel team',maxConcurrent:2,tasks:[task('slow',[]),task('waiting',['shared.ts'])]},'p');
    a.run(foreign.id,'p');b.run(local.id,'p');
    expect(observed).toEqual(['foreign','slow']);
    running.get('foreign')!({answer:'released',tokens:1});
    const deadline=Date.now()+500;
    while(!observed.includes('waiting')&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
    expect(observed).toEqual(['foreign','slow','waiting']);
    expect(b.get(local.id,'p').tasks.find(task=>task.id==='slow')?.status).toBe('running');
  } finally {
    a.close();b.close();await new Promise(done=>setTimeout(done,10));rmSync(root,{recursive:true,force:true});
  }
});
