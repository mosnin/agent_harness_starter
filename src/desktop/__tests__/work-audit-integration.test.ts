import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DurableWork } from '../core/durable-work';
import { verifyWorkAuditBundle, hashWorkAuditSnapshot } from '../core/work-audit';
const cleanup:Array<()=>void>=[];
afterEach(async()=>{cleanup.splice(0).forEach(close=>close());await new Promise(done=>setTimeout(done,10));});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'work-audit-integration-')),path=join(root,'work.sqlite');
  const execute=vi.fn(async()=>({answer:'The checked artifact is ready.',tokens:12}));
  const service=new DurableWork(path,{root:p=>p,profile:()=>{},execute}),db=new DatabaseSync(path);
  cleanup.push(()=>{service.close();db.close();rmSync(root,{recursive:true,force:true});});
  const create=()=>service.create({root,objective:'Produce an output',tasks:[{id:'build',title:'Build',prompt:'Write the output',writes:[]}],acceptance:[{path:'output.txt',contains:'checked'}]},'owner');
  return {root,path,service,db,execute,create};
}
it('records a complete checked run as an export bound to the saved head without retaining task text',async()=>{
  const f=fixture();writeFileSync(join(f.root,'output.txt'),'checked');const goal=f.create();f.service.run(goal.id,'owner');
  await vi.waitFor(()=>expect(f.service.get(goal.id,'owner').status).toBe('completed'));
  // Wait for elapsed-time settlement, which is itself an audited state change.
  await vi.waitFor(()=>expect(f.service.hasActiveWork).toBe(false));
  const head=f.service.auditHead(goal.id,'owner'),bundle=f.service.auditExport(goal.id,'owner');
  expect(verifyWorkAuditBundle(bundle,{scope:head.scope,head})).toMatchObject(head);
  const events=bundle.pages.flatMap(page=>page.events);
  expect(events.map(event=>event.kind)).toEqual(expect.arrayContaining(['work.created','work.started','tasks.admitted','task.settled']));
  expect(events.at(-1)?.afterHash).toBe(hashWorkAuditSnapshot(f.service.get(goal.id,'owner')));
  expect(JSON.stringify(bundle)).not.toContain('Write the output');expect(JSON.stringify(bundle)).not.toContain('The checked artifact is ready.');
  expect(()=>f.service.auditExport(goal.id,'foreign')).toThrow('another profile');
});
it('rolls back authoritative start admission when its audit event cannot persist',()=>{
  const f=fixture(),goal=f.create(),head=f.service.auditHead(goal.id,'owner');
  f.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON work_audit_events BEGIN SELECT RAISE(ABORT,'fixture audit persistence failed'); END;");
  expect(()=>f.service.run(goal.id,'owner')).toThrow('fixture audit');
  expect(f.service.get(goal.id,'owner').status).toBe('draft');expect(f.service.auditHead(goal.id,'owner')).toEqual(head);
  expect(f.execute).not.toHaveBeenCalled();expect(f.service.hasActiveWork).toBe(false);
  f.db.exec('DROP TRIGGER fixture_audit_failure');
});
it('rolls back creating a plan when its first audit event cannot persist',()=>{
  const f=fixture();f.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON work_audit_events BEGIN SELECT RAISE(ABORT,'fixture audit persistence failed'); END;");
  expect(f.create).toThrow('fixture audit');expect(f.service.list('owner')).toEqual([]);
  f.db.exec('DROP TRIGGER fixture_audit_failure');
});
it('rejects unaudited state alteration before a worker can start',()=>{
  const f=fixture(),goal=f.create();
  f.db.prepare("UPDATE work_goals SET payload=json_set(payload,'$.objective','altered outside the journal') WHERE id=?").run(goal.id);
  expect(()=>f.service.run(goal.id,'owner')).toThrow('Before snapshot');expect(f.execute).not.toHaveBeenCalled();expect(f.service.hasActiveWork).toBe(false);
});
it('labels the initial retained snapshot of a legacy plan instead of inventing prior history',()=>{
  const f=fixture(),original=f.create();
  const legacy={...original,id:'legacy-goal'};
  f.db.prepare('INSERT INTO work_goals(id,profile,payload,revision) VALUES(?,?,?,?)').run(legacy.id,legacy.profile,JSON.stringify(legacy),7);
  expect(f.service.auditHead(legacy.id,'owner').sequence).toBe(0);
  f.service.message(legacy.id,'owner','build','Review the output.');
  const head=f.service.auditHead(legacy.id,'owner'),bundle=f.service.auditExport(legacy.id,'owner');
  expect(bundle.pages[0].events.map(event=>[event.kind,event.revision])).toEqual([['work.baseline',7],['task.steered',8]]);
  expect(verifyWorkAuditBundle(bundle,{scope:head.scope,head})).toMatchObject(head);
});
