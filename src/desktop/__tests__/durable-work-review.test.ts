import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DurableWork, type WorkExecution } from '../core/durable-work';
const delay=()=>new Promise(r=>setTimeout(r,10));
it('independent review: nested project roots cannot reserve the same actual file concurrently',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hades-work-review-'));mkdirSync(join(root,'sub'));const path=join(root,'work.sqlite');const calls:WorkExecution[]=[];
 const deps={root:(p:string)=>p,profile:()=>{},execute:async(input:WorkExecution)=>{calls.push(input);return new Promise<{answer:string;tokens:number}>(()=>{});}};
 const a=new DurableWork(path,deps),b=new DurableWork(path,deps);
 try{const first=a.create({root,objective:'outer',tasks:[{id:'a',title:'outer',prompt:'edit',writes:['sub/shared.ts']}]},'p');const second=b.create({root:join(root,'sub'),objective:'inner',tasks:[{id:'b',title:'inner',prompt:'edit',writes:['shared.ts']}]},'p');a.run(first.id,'p');b.run(second.id,'p');await delay();expect(calls).toHaveLength(1);}
 finally{a.close();b.close();await delay();rmSync(root,{recursive:true,force:true});}
});
it('independent review: persistence failure cannot prevent shutdown cancellation of other active plans',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hades-work-review-'));const path=join(root,'work.sqlite');const signals:AbortSignal[]=[];
 const service=new DurableWork(path,{root:p=>p,profile:()=>{},execute:async(_input,signal)=>{signals.push(signal);return new Promise<{answer:string;tokens:number}>(()=>{});}});const db=new DatabaseSync(path);
 try{for(const id of ['a','b']){const goal=service.create({root,objective:id,tasks:[{id,title:id,prompt:'inspect',writes:[]}]},'p');service.run(goal.id,'p');}await delay();expect(signals).toHaveLength(2);db.exec("CREATE TRIGGER deny_review_update BEFORE UPDATE ON work_goals BEGIN SELECT RAISE(FAIL,'fixture persistence failure'); END;");try{service.close();}catch{}expect(signals.every(s=>s.aborted)).toBe(true);}
 finally{db.exec('DROP TRIGGER IF EXISTS deny_review_update');db.close();service.close();await delay();rmSync(root,{recursive:true,force:true});}
});
