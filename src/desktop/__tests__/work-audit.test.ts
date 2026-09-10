import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { WorkAuditJournal, WORK_AUDIT_GENESIS, hashWorkAuditSnapshot, verifyWorkAuditExport, verifyWorkAuditBundle, type WorkAuditScope } from "../core/work-audit";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const s: WorkAuditScope = {goalId:"goal-1",profile:"profile-1",root:"/workspace"};
const goal = (status="draft") => ({id:s.goalId,profile:s.profile,root:s.root,status,prompt:"PRIVATE PROMPT",answer:"PRIVATE ANSWER",credential:"PRIVATE KEY"});
function setup() {
 const db=new DatabaseSync(":memory:");databases.push(db);const journal=new WorkAuditJournal(db);
 const append=(n:number,before:unknown,after:unknown,revision=n)=>journal.append({scope:s,transitionId:`transition-${n}`,actor:{kind:"system",id:"scheduler"},kind:"goal.changed",at:100+n,revision,before,after});
 return {db,journal,append};
}
describe("Work audit journal",()=>{
 it("hashes canonical snapshots, retains no body or sensitive freeform metadata",()=>{
  const {db,journal,append}=setup();const one=append(1,undefined,goal());
  expect(hashWorkAuditSnapshot({b:2,a:1,optional:undefined})).toBe(hashWorkAuditSnapshot({a:1,b:2}));
  expect(one.afterHash).toBe(hashWorkAuditSnapshot(goal()));
  const serialized=JSON.stringify(db.prepare("SELECT * FROM work_audit_events").all());
  for(const secret of ["PRIVATE PROMPT","PRIVATE ANSWER","PRIVATE KEY"]) expect(serialized).not.toContain(secret);
  expect(verifyWorkAuditExport(journal.export(s),{scope:s,head:journal.head(s)}).hash).toBe(one.hash);
 });
 it("keeps sequence contiguous while revisions may skip lease-only updates",()=>{
  const {journal,append}=setup();append(1,undefined,goal(),0);append(2,goal(),goal("running"),4);
  expect(journal.read(s).events.map(e=>[e.sequence,e.revision])).toEqual([[1,0],[2,4]]);
 });
 it("rolls back authoritative mutations and audit rows together, including genesis scope",()=>{
  const {db,journal,append}=setup();db.exec("CREATE TABLE plans(id TEXT PRIMARY KEY,status TEXT); BEGIN IMMEDIATE");
  db.prepare("INSERT INTO plans VALUES(?,?)").run("goal-1","draft");append(1,undefined,goal());db.exec("ROLLBACK");
  expect(db.prepare("SELECT * FROM plans").all()).toEqual([]);expect(journal.head(s).sequence).toBe(0);
  expect(db.prepare("SELECT * FROM work_audit_scopes").all()).toEqual([]);
  db.exec("BEGIN IMMEDIATE");db.prepare("INSERT INTO plans VALUES(?,?)").run("goal-1","draft");append(1,undefined,goal());db.exec("COMMIT");
  expect(journal.head(s).sequence).toBe(1);expect(db.prepare("SELECT count(*) AS n FROM plans").get()).toEqual({n:1});
 });
 it("rolls back only its savepoint after an append error, leaving caller transaction controllable",()=>{
  const {db,journal,append}=setup();append(1,undefined,goal());db.exec("BEGIN IMMEDIATE");
  expect(()=>append(2,goal("wrong"),goal("running"))).toThrow(/snapshot/);
  append(2,goal(),goal("running"));db.exec("ROLLBACK");expect(journal.head(s).sequence).toBe(1);
 });
 it("refuses duplicate source transitions, stale revisions, missing before and wrong snapshot scope",()=>{
  const {journal,append}=setup();append(1,undefined,goal());
  expect(()=>append(1,goal(),goal("running"),2)).toThrow(/already audited/);
  expect(()=>append(2,goal(),goal("running"),1)).toThrow(/revision/);
  expect(()=>append(2,undefined,goal("running"))).toThrow(/snapshot/);
  expect(()=>append(2,goal(),{...goal(),profile:"other"})).toThrow(/does not match/);
  expect(journal.head(s).sequence).toBe(1);
 });
 it("rejects cross-profile/root read, append and export verification",()=>{
  const {journal,append}=setup();append(1,undefined,goal());
  for(const bad of [{...s,profile:"other"},{...s,root:"/other"}]) {
   expect(()=>journal.read(bad)).toThrow(/does not match/);
   expect(()=>journal.append({scope:bad,transitionId:"bad",actor:{kind:"user",id:"user"},kind:"changed",at:1,revision:2,before:goal(),after:goal()})).toThrow(/does not match/);
   expect(()=>verifyWorkAuditExport(journal.export(s),{scope:bad,head:journal.head(s)})).toThrow(/does not match/);
  }
 });
 it("enforces append-only rows and immutable scope at SQLite level, including OR REPLACE",()=>{
  const {db,append}=setup();append(1,undefined,goal());
  for(const sql of ["DELETE FROM work_audit_events","UPDATE work_audit_events SET revision=2","DELETE FROM work_audit_scopes","UPDATE work_audit_scopes SET profile='other'","INSERT OR REPLACE INTO work_audit_scopes VALUES('goal-1','other','/workspace')", "INSERT OR REPLACE INTO work_audit_events SELECT goal_id,2,transition_id,2,event_hash,after_hash,after_hash,event_hash,event_json FROM work_audit_events"]) expect(()=>db.exec(sql)).toThrow();
  expect(db.prepare("SELECT count(*) AS n FROM work_audit_events").get()).toEqual({n:1});
 });
 it("exports bounded pages against frozen head and requires independent predecessor for suffix",()=>{
  const {journal,append}=setup();append(1,undefined,goal());append(2,goal(),goal("running"));const frozen=journal.head(s);
  append(3,goal("running"),goal("completed"));
  const first=journal.export(s,{limit:1,expectedHead:frozen});expect(first.hasMore).toBe(true);
  expect(()=>verifyWorkAuditExport(first,{scope:s,head:frozen})).toThrow(/expected head/);
  const second=journal.export(s,{afterSequence:1,limit:1,expectedHead:frozen});expect(second.hasMore).toBe(false);
  expect(()=>verifyWorkAuditExport(second,{scope:s,head:frozen})).toThrow(/predecessor/);
  expect(verifyWorkAuditExport(second,{scope:s,head:frozen,predecessor:first.end}).sequence).toBe(2);
  const joined={...second,predecessor:first.predecessor,events:[...first.events,...second.events]};
  expect(verifyWorkAuditExport(joined,{scope:s,head:frozen}).sequence).toBe(2);
 });
 it("detects altered events, omitted/reordered events, head truncation and replaced scope",()=>{
  const {journal,append}=setup();append(1,undefined,goal());append(2,goal(),goal("running"));append(3,goal("running"),goal("completed"));
  const original=journal.export(s),head=journal.head(s);
  const changed=structuredClone(original);changed.events[1].actor.id="attacker";
  const missing=structuredClone(original);missing.events.splice(1,1);
  const reordered=structuredClone(original);reordered.events.reverse();
  const truncated=journal.export(s,{limit:2});truncated.head=truncated.end;truncated.hasMore=false;
  for(const bad of [changed,missing,reordered,truncated]) expect(()=>verifyWorkAuditExport(bad,{scope:s,head})).toThrow();
  const badHead={...head,hash:"a".repeat(64)};expect(()=>journal.read(s,{expectedHead:badHead})).toThrow(/head/);
 });
 it("rejects unsafe data and metadata without changing the journal",()=>{
  const {journal}=setup();
  const base={scope:s,transitionId:"t",actor:{kind:"user" as const,id:"user"},kind:"created",at:1,revision:0,after:goal()};
  for(const metadata of [{prompt:"secret"},{reasonCode:"x".repeat(10000)},{tokens:Infinity},{status:"secret"},{taskCount:-1}]) expect(()=>journal.append({...base,metadata} as Parameters<typeof journal.append>[0])).toThrow();
  expect(()=>journal.append({...base,after:{...goal(),large:"x".repeat(4*1024*1024)}})).toThrow(/byte limit/);
  const cycle:Record<string,unknown>={};cycle.self=cycle;expect(()=>hashWorkAuditSnapshot(cycle)).toThrow(/Cyclic/);
  expect(()=>hashWorkAuditSnapshot([undefined])).toThrow(/JSON/);
  expect(journal.head(s).sequence).toBe(0);
 });
 it("detects missing stored events even when an administrator bypasses triggers",()=>{
  const {db,journal,append}=setup();append(1,undefined,goal());append(2,goal(),goal("running"));append(3,goal("running"),goal("completed"));const head=journal.head(s);
  db.exec("DROP TRIGGER work_audit_no_delete; DELETE FROM work_audit_events WHERE sequence=2");
  expect(()=>journal.read(s,{expectedHead:head})).toThrow(/missing/);
 });
 it("validates cursor/size and empty genesis without fabricating events",()=>{
  const {journal}=setup();expect(verifyWorkAuditExport(journal.export(s),{scope:s,head:{sequence:0,hash:WORK_AUDIT_GENESIS}}).sequence).toBe(0);
  expect(()=>journal.read(s,{limit:501})).toThrow(/500/);expect(()=>journal.read(s,{afterSequence:1})).toThrow(/beyond/);
 });
});

it("detects altered SQLite shadow columns after privileged trigger removal",()=>{
 const {db,journal,append}=setup();append(1,undefined,goal());
 db.exec("DROP TRIGGER work_audit_no_update; UPDATE work_audit_events SET event_hash='"+"a".repeat(64)+"'");
 expect(()=>journal.head(s)).toThrow(/row fields/);
});

it("keeps goal chains independently scoped, without requiring global sequence continuity",()=>{
 const {journal,append}=setup();append(1,undefined,goal());
 const other={...s,goalId:"goal-2"};
 journal.append({scope:other,transitionId:"transition-1",actor:{kind:"worker",id:"worker-1"},kind:"goal.created",at:1,revision:0,after:{...goal(),id:"goal-2"}});
 expect(journal.head(other).sequence).toBe(1);expect(journal.read(s).events).toHaveLength(1);
 expect(()=>verifyWorkAuditExport(journal.export(other),{scope:s,head:journal.head(s)})).toThrow(/does not match/);
});


it("verifies complete frozen bundles and rejects missing/reordered/final pages or self-declared heads",()=>{
 const {journal,append}=setup();append(1,undefined,goal());append(2,goal(),goal("running"));append(3,goal("running"),goal("completed"));
 const head=journal.head(s);const pages=[0,1,2].map(afterSequence=>journal.export(s,{afterSequence,limit:1,expectedHead:head}));
 const bundle={schema:"hades.work-audit-bundle.v1",scope:s,head,pages};
 expect(verifyWorkAuditBundle(bundle,{scope:s,head})).toEqual(head);
 const missingMiddle={...bundle,pages:[pages[0],pages[2]]};
 const missingFinal={...bundle,pages:pages.slice(0,2)};
 const missingStart={...bundle,pages:pages.slice(1)};
 const reordered={...bundle,pages:[pages[1],pages[0],pages[2]]};
 const selfDeclared={...missingFinal,head:pages[1].end,pages:pages.slice(0,2).map(p=>({...p,head:pages[1].end,hasMore:p.end.sequence<2}))};
 const wrongPageHead={...bundle,pages:[pages[0],{...pages[1],head:pages[1].end},pages[2]]};
 for(const value of [missingMiddle,missingFinal,missingStart,reordered,selfDeclared,wrongPageHead]) expect(()=>verifyWorkAuditBundle(value,{scope:s,head})).toThrow();
 expect(()=>verifyWorkAuditBundle({...bundle,pages:Array.from({length:11},()=>pages[0])},{scope:s,head})).toThrow(/ten pages/);
 expect(()=>verifyWorkAuditBundle({...bundle,unexpected:"x".repeat(8*1024*1024)},{scope:s,head})).toThrow(/byte limit/);
});

it("allows only one empty genesis bundle page",()=>{
 const {journal}=setup();const head=journal.head(s),page=journal.export(s);
 expect(verifyWorkAuditBundle({schema:"hades.work-audit-bundle.v1",scope:s,head,pages:[page]},{scope:s,head}).sequence).toBe(0);
 expect(()=>verifyWorkAuditBundle({schema:"hades.work-audit-bundle.v1",scope:s,head,pages:[page,page]},{scope:s,head})).toThrow();
});
