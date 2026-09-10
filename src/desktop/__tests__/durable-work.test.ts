import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableWork, type WorkExecution } from "../core/durable-work";

const homes: string[] = [], workers: DurableWork[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.close(); for (const home of homes.splice(0)) rmSync(home,{recursive:true,force:true}); });
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
type Result = {answer:string;tokens:number;error?:string};
const ok = {answer:"Verified task result",tokens:10};
function fixture(execute: (input:WorkExecution,signal:AbortSignal,bind:(session:string)=>void)=>Promise<Result> = async()=>ok) {
 const home=mkdtempSync(join(tmpdir(),"hades-work-test-")); homes.push(home);const root=join(home,"project");mkdirSync(root);writeFileSync(join(root,"result.txt"),"verified");
 let now=1000;const path=join(home,"work.db");
 const deps={execute,profile:(p:string)=>{if(!["owner","a","b"].includes(p))throw Error("Unknown profile");},root:(p:string)=>{if(resolve(p)!==root)throw Error("Unknown project");return root;},now:()=>now};
 const worker=new DurableWork(path,deps);workers.push(worker);
 const create=(extra:Record<string,unknown>={})=>worker.create({root,objective:"Produce a verified result",tasks:[{id:"a",title:"Build",prompt:"Build result",profile:"a"}],acceptance:[{path:"result.txt",contains:"verified"}],...extra},"owner");
 const second=()=>{const w=new DurableWork(path,deps);workers.push(w);return w;};
 return {home,root,path,worker,create,second,setNow:(n:number)=>{now=n;}};
}
async function settled(f:ReturnType<typeof fixture>,id:string) {
 for(let i=0;i<100;i++){const g=f.worker.get(id,"owner");if(g.status!=="running")return g;await new Promise(r=>setTimeout(r,5));}
 throw Error("Work did not settle");
}
// These executors only return reports. Tests that edit files declare paths.
const task=(id:string,profile="a",dependsOn:string[]=[])=>({id,title:id,prompt:`Complete ${id}`,profile,dependsOn,writes:[]});

describe("DurableWork real SQLite and filesystem integration",()=>{
 it("does not release a dependent task on a success message when its artifact check fails",async()=>{
  const calls:string[]=[];const f=fixture(async input=>{calls.push(input.task);return ok;});
  const g=f.create({tasks:[{...task("a"),acceptance:[{path:"missing.txt"}]},task("b","b",["a"])]});
  f.worker.run(g.id,"owner");const done=await settled(f,g.id);
  expect(calls).toEqual(["a"]);expect(done.status).toBe("needs_review");expect(done.tasks[0].status).toBe("failed");
 });
 it("keeps exact attempt identity and unmeasured reservations across stop and reopen",async()=>{
  const gate=deferred<Result>();let input!:WorkExecution;const f=fixture(async(i,_s,bind)=>{input=i;bind("persisted-session");return gate.promise;});
  const g=f.create();f.worker.run(g.id,"owner");f.worker.stop(g.id,"owner");
  const saved=f.second().get(g.id,"owner");expect(saved.tasks[0].attempts).toHaveLength(1);
  expect(saved.tasks[0].attempts![0]).toMatchObject({id:input.attemptId,status:"cancelled",session:"persisted-session",reservedTokens:300000});
  expect(saved.tasks[0].attempts![0].tokens).toBeUndefined();gate.resolve(ok);
 });
 it("admits a newly ready task while an independent slow task is still running",async()=>{
  const slow=deferred<Result>(),fast=deferred<Result>(),calls:string[]=[];
  const f=fixture(async input=>{calls.push(input.task);return input.task==="slow"?slow.promise:input.task==="fast"?fast.promise:ok;});
  const g=f.create({maxConcurrent:2,tasks:[{...task("slow"),writes:[]},{...task("fast"),writes:[]},{...task("child","a",["fast"]),writes:[]}]});
  f.worker.run(g.id,"owner");fast.resolve(ok);await new Promise(r=>setTimeout(r,25));expect(calls).toEqual(["slow","fast","child"]);
  slow.resolve(ok);expect((await settled(f,g.id)).status).toBe("completed");
 });
 it("serializes overlapping edit reservations across owners while allowing disjoint tasks",async()=>{
  const gates=[deferred<Result>(),deferred<Result>()],calls:string[]=[];
  const f=fixture(async input=>{calls.push(input.goal);return gates[calls.length-1]?.promise??ok;});
  const first=f.create({tasks:[{...task("a"),writes:["src"]}]}),second=f.create({tasks:[{...task("b"),writes:["src/ui"]}]});
  f.worker.run(first.id,"owner");f.second().run(second.id,"owner");expect(calls).toEqual([first.id]);
  gates[0].resolve(ok);await new Promise(r=>setTimeout(r,90));expect(calls).toEqual([first.id,second.id]);gates[1].resolve(ok);
  expect((await settled(f,second.id)).status).toBe("completed");
 });
 it("rejects stale dependency receipts before a resumed child can act",async()=>{
  const calls:string[]=[];const f=fixture(async input=>{calls.push(input.task);return input.task==="b"?{...ok,error:"Temporary failure"}:ok;});
  const g=f.create({tasks:[{...task("a"),acceptance:[{path:"result.txt",contains:"verified"}]},task("b","b",["a"])]});
  f.worker.run(g.id,"owner");await settled(f,g.id);writeFileSync(join(f.root,"result.txt"),"changed verified");
  f.worker.resume(g.id,"owner");const done=await settled(f,g.id);expect(calls).toEqual(["a","b"]);expect(done.status).toBe("needs_review");expect(done.error).toMatch(/changed|evidence/i);
 });
 it("bounds concurrency and validates declared edit paths and per-task output checks",()=>{
  const f=fixture();for(const maxConcurrent of [0,9,1.5])expect(()=>f.create({maxConcurrent})).toThrow();
  for(const writes of [["../other"],["/tmp"],["src/*"],"src"])expect(()=>f.create({tasks:[{...task("a"),writes}]})).toThrow();
  expect(()=>f.create({tasks:[{...task("a"),acceptance:[{path:"../outside"}]}]})).toThrow();
 });
 it("keeps the database and live SQLite sidecars private",()=>{
  const f=fixture();for(const path of [f.path,`${f.path}-wal`,`${f.path}-shm`])expect(statSync(path).mode & 0o777).toBe(0o600);
 });
 it("rejects malformed, cyclic, missing, duplicated and over-limit dependency plans",()=>{
  const f=fixture();for(const tasks of [[task("a","a",["missing"])],[task("a","a",["b"]),task("b","b",["a"])],[task("a"),task("a")],[{...task("a"),dependsOn:"b"}],[{...task("a"),dependsOn:Array(17).fill("a")}],Array.from({length:17},(_,i)=>task(`t${i}`))])expect(()=>f.create({tasks})).toThrow();
  expect(()=>f.create({maxMinutes:0})).toThrow();expect(()=>f.create({maxTokens:999})).toThrow();expect(()=>f.create({tasks:[task("a","unowned")]})).toThrow();
 });
 it("isolates every mutation and read by the goal's owning profile",()=>{
  const f=fixture(),g=f.create();expect(f.worker.list("a")).toEqual([]);
  for(const call of [()=>f.worker.get(g.id,"a"),()=>f.worker.run(g.id,"a"),()=>f.worker.stop(g.id,"a"),()=>f.worker.resume(g.id,"a"),()=>f.worker.message(g.id,"a","a","change")])expect(call).toThrow("another profile");
 });
 it("runs two different agents concurrently, then passes their reports to a dependent task",async()=>{
  const gates={a:deferred<Result>(),b:deferred<Result>()};const calls:WorkExecution[]=[];
  const f=fixture(async input=>{calls.push(input);return input.task in gates?gates[input.task as "a"|"b"].promise:ok;});
  const g=f.create({tasks:[task("a"),task("b","b"),task("c","a",["a","b"])]});f.worker.run(g.id,"owner");
  expect(calls.map(c=>c.task)).toEqual(["a","b"]);expect(calls[0].maxTokens).toBe(150000);
  gates.a.resolve({answer:"A evidence",tokens:20});await new Promise(r=>setTimeout(r,5));expect(calls).toHaveLength(2);gates.b.resolve({answer:"B evidence",tokens:30});
  const done=await settled(f,g.id);expect(done.status).toBe("completed");expect(done.tokens).toBe(60);expect(calls[2].prompt).toContain("A evidence");expect(calls[2].prompt).toContain("B evidence");expect(done.evidence?.[0]).toMatchObject({path:"result.txt",bytes:8});expect(done.evidence?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it("runs same-profile tasks in distinct sessions while leaving failed dependents unexecuted",async()=>{
  const calls:string[]=[];const gate=deferred<Result>();const f=fixture(async (input,_signal,bind)=>{calls.push(input.task);bind(`session-${input.task}`);return input.task==="a"?gate.promise:ok;});
  const g=f.create({tasks:[task("a"),task("b"),task("c","b",["a"])]});f.worker.run(g.id,"owner");expect(calls).toEqual(["a","b"]);
  gate.resolve({...ok,error:"Tests failed"});const done=await settled(f,g.id);expect(calls).toEqual(["a","b"]);expect(done.status).toBe("needs_review");expect(done.tasks[2].status).toBe("queued");expect(done.tasks[0].session).toBe("session-a");expect(done.tasks[1].session).toBe("session-b");
 });
 it("requires output checks and rejects missing contents, directories, oversized files and symlinks",async()=>{
  const f=fixture();for(const path of ["../outside","/tmp/outside",f.root])expect(()=>f.create({acceptance:[{path}]})).toThrow();
  mkdirSync(join(f.root,"folder"));writeFileSync(join(f.home,"outside.txt"),"verified");symlinkSync(join(f.home,"outside.txt"),join(f.root,"link.txt"));symlinkSync(f.home,join(f.root,"linked-dir"));writeFileSync(join(f.root,"large.txt"),Buffer.alloc(2000001));
  for(const acceptance of [[{path:"link.txt"}],[{path:"linked-dir/outside.txt"}]])expect(()=>f.create({acceptance})).toThrow(/symbolic/);
  for(const acceptance of [[],[{path:"result.txt",contains:"missing"}],[{path:"folder"}],[{path:"large.txt"}]]){
   const g=f.create({acceptance});f.worker.run(g.id,"owner");expect((await settled(f,g.id)).status).toBe("needs_review");
  }
 });
 it("retains steering arriving during execution for the next round",async()=>{
  const gate=deferred<Result>(),calls:WorkExecution[]=[];const f=fixture(async input=>{calls.push(input);return calls.length===1?gate.promise:ok;});
  const g=f.create();f.worker.message(g.id,"owner","a","First steering");f.worker.run(g.id,"owner");f.worker.message(g.id,"owner","a","Second steering");gate.resolve(ok);
  const done=await settled(f,g.id);expect(done.status).toBe("completed");expect(done.tasks[0].rounds).toBe(2);expect(calls[0].prompt).toContain("First steering");expect(calls[1].prompt).toContain("Second steering");expect(calls[1].prompt).not.toContain("First steering");expect(done.tasks[0].messages).toEqual([]);
 });
 it("caps pending messages and invalidates a revised task's transitive dependents",async()=>{
  const f=fixture(),g=f.create({tasks:[task("a"),task("b","b",["a"]),task("c","a",["b"])]});f.worker.run(g.id,"owner");await settled(f,g.id);
  const changed=f.worker.message(g.id,"owner","a","Revise build");expect(changed.status).toBe("draft");expect(changed.evidence).toBeUndefined();expect(changed.tasks.every(t=>t.status==="queued")).toBe(true);
  for(let i=0;i<31;i++)f.worker.message(g.id,"owner","a",`Message ${i}`);expect(()=>f.worker.message(g.id,"owner","a","overflow")).toThrow("too many");
 });
 it("fences Stop then Resume against late bind, result, elapsed time and old finally",async()=>{
  const old=deferred<Result>(),fresh=deferred<Result>();let oldBind!:(s:string)=>void;let calls=0;
  const f=fixture(async(_i,_s,bind)=>{calls++;bind(`session-${calls}`);if(calls===1){oldBind=bind;return old.promise;}return fresh.promise;});
  const g=f.create();f.worker.run(g.id,"owner");f.setNow(3000);f.worker.stop(g.id,"owner");expect(f.worker.get(g.id,"owner").elapsedMs).toBe(2000);
  f.worker.resume(g.id,"owner",{maxTokens:600000});oldBind("late-old-session");old.resolve({answer:"OLD LATE RESULT",tokens:999});await new Promise(r=>setTimeout(r,10));
  const running=f.worker.get(g.id,"owner");expect(running.status).toBe("running");expect(running.tasks[0].session).toBe("session-2");expect(running.tokens).toBe(0);expect(running.elapsedMs).toBe(2000);
  fresh.resolve(ok);expect((await settled(f,g.id)).status).toBe("completed");
 });
 it("enforces one worker owner and a global three-plan concurrency cap",async()=>{
  const gate=deferred<Result>(),f=fixture(async()=>gate.promise),other=f.second();const first=f.create();f.worker.run(first.id,"owner");expect(()=>other.run(first.id,"owner")).toThrow();
  f.worker.run(f.create().id,"owner");other.run(f.create().id,"owner");expect(()=>other.run(f.create().id,"owner")).toThrow(/three/);gate.resolve(ok);await settled(f,first.id);
 });
 it("recovers an expired lease as interrupted, never auto-executes, and only resumes explicitly",async()=>{
  let calls=0;let oldInput!:WorkExecution;const old=deferred<Result>();const f=fixture(async(input,_s,bind)=>{calls++;if(calls===1)oldInput=input;bind(`session-${calls}`);return calls===1?old.promise:ok;});
  const g=f.create();f.worker.run(g.id,"owner");f.setNow(62000);const other=f.second();
  const interrupted=other.get(g.id,"owner");expect(interrupted.status).toBe("needs_review");expect(interrupted.tasks[0].status).toBe("interrupted");expect(interrupted.elapsedMs).toBe(60000);expect(calls).toBe(1);expect(()=>oldInput.assertActive()).toThrow("lease was lost");
  other.resume(g.id,"owner",{maxTokens:600000});old.resolve({answer:"late",tokens:500});await new Promise(r=>setTimeout(r,10));const done=other.get(g.id,"owner");expect(done.status).toBe("completed");expect(done.tokens).toBe(10);expect(calls).toBe(2);
  f.worker.close();expect(other.get(g.id,"owner").status).toBe("completed");
 });
 it("requires explicit higher token and round budgets for continuation",async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {...ok,tokens:1100,error:calls===1?"Retry required":undefined};});
  const g=f.create({maxTokens:1000,maxRounds:1});f.worker.run(g.id,"owner");expect((await settled(f,g.id)).status).toBe("budget_exhausted");
  f.worker.resume(g.id,"owner");await settled(f,g.id);expect(calls).toBe(1);
  f.worker.resume(g.id,"owner",{maxTokens:3000,maxRounds:2});expect((await settled(f,g.id)).status).toBe("completed");expect(calls).toBe(2);
 });
 it("stops bounded steering loops until the round budget is explicitly raised",async()=>{
  let calls=0,goalId="";const f=fixture(async()=>{calls++;if(calls<3)f.worker.message(goalId,"owner","a",`Inspect iteration ${calls}`);return ok;});
  const g=f.create({maxRounds:2});goalId=g.id;f.worker.run(g.id,"owner");const stopped=await settled(f,g.id);expect(stopped.status).toBe("needs_review");expect(stopped.tasks[0].error).toContain("continuation limit");expect(calls).toBe(2);
  f.worker.resume(g.id,"owner");await settled(f,g.id);expect(calls).toBe(2);
  f.worker.resume(g.id,"owner",{maxRounds:3});expect((await settled(f,g.id)).status).toBe("completed");expect(calls).toBe(3);
 });
 it("reserves unknown interrupted usage and never resets it by repeatedly resuming",async()=>{
  const gate=deferred<Result>();let calls=0;const f=fixture(async()=>{calls++;return gate.promise;}),g=f.create({maxTokens:1000});
  f.worker.run(g.id,"owner");f.worker.stop(g.id,"owner");const stopped=f.worker.get(g.id,"owner");expect(stopped.tokens).toBe(0);expect(stopped.tasks[0].reservedTokens).toBe(1000);
  f.worker.resume(g.id,"owner");expect((await settled(f,g.id)).status).toBe("budget_exhausted");expect(calls).toBe(1);gate.resolve(ok);
 });
 it("records elapsed time on close and stops work whose elapsed budget is reached",async()=>{
  const gate=deferred<Result>(),f=fixture(async()=>gate.promise);const g=f.create({maxMinutes:1});f.worker.run(g.id,"owner");f.setNow(21000);f.worker.close();
  const reopened=f.second();expect(reopened.get(g.id,"owner")).toMatchObject({elapsedMs:20000,status:"needs_review"});
  reopened.resume(g.id,"owner",{maxTokens:600000});f.setNow(61000);reopened.close();
  const exhausted=f.second();expect(exhausted.get(g.id,"owner").elapsedMs).toBe(60000);
  exhausted.resume(g.id,"owner",{maxTokens:900000});await new Promise(r=>setTimeout(r,5));expect(exhausted.get(g.id,"owner").status).toBe("budget_exhausted");gate.resolve(ok);
 });
 it("refuses unknown token accounting instead of recording free successful work",async()=>{
  const f=fixture(async()=>({...ok,tokens:NaN})),g=f.create();f.worker.run(g.id,"owner");const done=await settled(f,g.id);expect(done.status).toBe("budget_exhausted");expect(done.tasks[0].error).toContain("valid token usage");expect(done.tokens).toBe(0);expect(done.tasks[0].reservedTokens).toBe(300000);
 });
});
