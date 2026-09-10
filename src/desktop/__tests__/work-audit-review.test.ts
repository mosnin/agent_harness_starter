import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DurableWork } from '../core/durable-work';
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(close=>close()));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'audit-review-')),path=join(root,'work.sqlite');
 const execute=vi.fn(async()=>({answer:'done',tokens:1}));
 const service=new DurableWork(path,{root:p=>p,profile:()=>{},execute}),db=new DatabaseSync(path);
 cleanup.push(()=>{service.close();db.close();rmSync(root,{recursive:true,force:true});});
 const goal=service.create({root,objective:'Check output',tasks:[{id:'build',title:'Build',prompt:'Write output',writes:[]}],acceptance:[{path:'output.txt',contains:'checked'}]},'owner');
 return {root,service,db,goal,execute};
}
it('refuses audit head and export when the current canonical payload changed outside the journal',()=>{
 const f=fixture();f.db.prepare("UPDATE work_goals SET payload=json_set(payload,'$.objective','unaudited change') WHERE id=?").run(f.goal.id);
 expect(()=>f.service.auditHead(f.goal.id,'owner')).toThrow();
 expect(()=>f.service.auditExport(f.goal.id,'owner')).toThrow();
});
it('denied read-only audit access does not reconcile or mutate another profile',()=>{
 const f=fixture();f.db.prepare('UPDATE work_goals SET owner=?,lease=?,started=? WHERE id=?').run('expired-worker',1,0,f.goal.id);
 const before=f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id);
 expect(()=>f.service.auditHead(f.goal.id,'foreign')).toThrow('another profile');
 expect(f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id)).toEqual(before);
});
it('rolls back initial plan admission when the audit append fails',()=>{
 const f=fixture();
 f.db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON work_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 const before=f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id);
 expect(()=>f.service.run(f.goal.id,'owner')).toThrow('audit unavailable');
 expect(f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id)).toEqual(before);
 expect(f.execute).not.toHaveBeenCalled();f.db.exec('DROP TRIGGER deny_audit');
});

it('atomically rolls back claimed attempts and token reservations on audit failure',()=>{
 const f=fixture();(f.service as any).edit(f.goal.id,(g:any)=>{g.status='running';});
 f.db.prepare('UPDATE work_goals SET owner=?,lease=? WHERE id=?').run('test-owner',Date.now()+60000,f.goal.id);
 const before=f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id);
 f.db.exec("CREATE TRIGGER deny_admission BEFORE INSERT ON work_audit_events BEGIN SELECT RAISE(ABORT,'admission audit unavailable'); END;");
 expect(()=>(f.service as any).claimReady(f.goal.id,'test-owner')).toThrow('admission audit unavailable');
 expect(f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id)).toEqual(before);
 expect(f.execute).not.toHaveBeenCalled();f.db.exec('DROP TRIGGER deny_admission');
 const first=(f.service as any).claimReady(f.goal.id,'test-owner');expect(first.claimed).toHaveLength(1);
 const head=f.service.auditHead(f.goal.id,'owner');
 const second=(f.service as any).claimReady(f.goal.id,'test-owner');expect(second.claimed).toHaveLength(0);
 expect(f.service.auditHead(f.goal.id,'owner')).toEqual(head);
});
it('serializes revisions across separate database owners and rejects foreign frozen heads',()=>{
 const f=fixture(), second=new DurableWork(join(f.root,'work.sqlite'),{root:p=>p,profile:()=>{},execute:f.execute});
 try {
  f.service.message(f.goal.id,'owner','build','First instruction');
  second.message(f.goal.id,'owner','build','Second instruction');
  const page=f.service.auditPage(f.goal.id,'owner');expect(page.events.map(e=>e.revision)).toEqual([0,1,2]);
  const head=f.service.auditHead(f.goal.id,'owner');
  expect(()=>f.service.auditPage(f.goal.id,'owner',{expectedHead:{...head,scope:{...head.scope,profile:'foreign'}}})).toThrow();
 } finally {second.close();}
});
it('keeps pure audit reads side-effect free and exports a frozen head across a later authorized edit',()=>{
 const f=fixture(), second=new DurableWork(join(f.root,'work.sqlite'),{root:p=>p,profile:()=>{},execute:f.execute});
 try {
  const before=f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id);
  const head=f.service.auditHead(f.goal.id,'owner');
  f.service.auditPage(f.goal.id,'owner');f.service.auditExport(f.goal.id,'owner');
  expect(f.db.prepare('SELECT * FROM work_goals WHERE id=?').get(f.goal.id)).toEqual(before);
  expect(f.service.auditHead(f.goal.id,'owner')).toEqual(head);
  const original=f.service.auditPage.bind(f.service);let edited=false;
  vi.spyOn(f.service,'auditPage').mockImplementation((...args)=>{
   if(!edited){edited=true;second.message(f.goal.id,'owner','build','Authorized later instruction');}
   return original(...args);
  });
  const bundle=f.service.auditExport(f.goal.id,'owner');
  expect(bundle.head).toEqual({sequence:head.sequence,hash:head.hash});
  expect(bundle.pages.flatMap(p=>p.events)).toHaveLength(1);
  expect(second.auditHead(f.goal.id,'owner').sequence).toBe(head.sequence+1);
  expect(second.get(f.goal.id,'owner').tasks[0].messages).toHaveLength(1);
 } finally {second.close();}
});
