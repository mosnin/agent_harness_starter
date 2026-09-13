import { expect, it, vi } from "vitest";
import { delegationTools, type DelegationScope } from "../core/delegation-tools";
import type { WorkGoal } from "../core/durable-work";
function goal(id = "child"): WorkGoal {
  return { id, root: "/trusted", profile: "p", objective: "Build", status: "running", tasks: [{ id: "one", title: "Implement", profile: "p", prompt: "Implement", dependsOn: [], status: "running", rounds: 1, messages: [] }], maxConcurrent: 2, maxRounds: 2, tokens: 0, maxTokens: 25000, maxMinutes: 15, elapsedMs: 0, createdAt: 0, updatedAt: 0, acceptance: [] };
}
function fixture(overrides: Partial<DelegationScope> = {}) {
  const controller = new AbortController();
  const scope: DelegationScope = { root: "/trusted", profile: "p", signal: controller.signal, depth: 0,
    reserve: vi.fn(), rememberGoal: vi.fn(), create: vi.fn(async () => goal()), run: vi.fn(async () => goal()), get: vi.fn(async () => goal()), message: vi.fn(async () => goal()), stop: vi.fn(async () => ({ ...goal(), status: "cancelled" as const })), ...overrides };
  const tools = delegationTools(scope);
  const run = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.run(JSON.stringify(input));
  return { scope, controller, tools, run };
}
const plan = { objective: "Implement and check", tasks: [{ id: "one", title: "Implement", prompt: "Implement" }, { id: "two", title: "Verify", prompt: "Independently test", dependsOn: ["one"] }] };
it("creates a scoped DAG after reserving durably and records ownership before starting", async () => {
  const order: string[] = [];
  const { scope, run } = fixture({ reserve: () => { order.push("reserve"); }, create: async () => { order.push("create"); return goal(); }, rememberGoal: () => { order.push("remember"); }, run: async () => { order.push("run"); return goal(); } });
  expect((await run("delegate_work", plan)).ok).toBe(true);
  expect(order).toEqual(["reserve", "create", "remember", "run"]);
  expect((await run("delegation_status", { goal: "child" })).ok).toBe(true);
  expect(scope.get).toHaveBeenCalledWith("child");
});
it("rejects authority overrides, malformed/cyclic plans and budgets before callbacks", async () => {
  const { scope, run } = fixture();
  for (const bad of [{ ...plan, root: "/outside" }, { ...plan, tasks: [{ ...plan.tasks[0], profile: "admin" }] }, { ...plan, maxTokens: 300_001 }, { ...plan, maxMinutes: 16 }, { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["one"] }] }]) {
    expect((await run("delegate_work", bad)).ok).toBe(false);
  }
  expect(scope.reserve).not.toHaveBeenCalled(); expect(scope.create).not.toHaveBeenCalled();
  await run("delegate_work", plan);
  expect(scope.create).toHaveBeenCalledWith(expect.objectContaining({ root: "/trusted", profile: "p", maxRounds: 2, tasks: expect.arrayContaining([expect.objectContaining({ profile: "p" })]) }));
});
it("limits cumulative allocations and respects persisted reservation refusals on later turns", async () => {
  let spent = 0;
  const reserve = vi.fn(({ tokens }: { tokens: number }) => { if (spent + tokens > 150_000) throw new Error("Durable budget exhausted"); spent += tokens; });
  const first = fixture({ reserve }); expect((await first.run("delegate_work", plan)).ok).toBe(true);
  const later = fixture({ reserve, ownedGoals: ["child"] });
  expect(await later.run("delegate_work", plan)).toMatchObject({ ok: false, output: "Durable budget exhausted" });
  expect(later.scope.create).not.toHaveBeenCalled();
  const local = fixture({ maxGoals: 1 }); await local.run("delegate_work", plan);
  expect((await local.run("delegate_work", plan)).ok).toBe(false);
  expect(local.scope.reserve).toHaveBeenCalledTimes(1);
});
it("restricts recovered ownership and removes recursive spawning from child agents", async () => {
  const { tools, run, scope } = fixture({ depth: 1, ownedGoals: ["parent"] });
  expect(tools.some(tool => tool.name === "delegate_work")).toBe(false);
  expect((await run("delegation_status", { goal: "foreign" })).ok).toBe(false);
  expect((await run("delegation_message", { goal: "foreign", task: "one", input: "hello" })).ok).toBe(false);
  expect((await run("delegation_stop", { goal: "foreign" })).ok).toBe(false);
  expect(scope.get).not.toHaveBeenCalled(); expect(scope.message).not.toHaveBeenCalled(); expect(scope.stop).not.toHaveBeenCalled();
  expect((await run("delegation_message", { goal: "parent", task: "one", input: "Verify the result" })).ok).toBe(true);
  expect(scope.message).toHaveBeenCalledWith("parent", "one", "Verify the result");
});
it("propagates stop policy and suppresses start when cancelled after allocation", async () => {
  const policy = fixture({ ownedGoals: ["parent"], stop: async () => { throw new Error("A child cannot stop its parent plan"); } });
  expect(await policy.run("delegation_stop", { goal: "parent" })).toMatchObject({ ok: false, output: "A child cannot stop its parent plan" });
  const controller = new AbortController();
  const stopped = fixture({ signal: controller.signal, create: async () => { controller.abort(); return goal(); } });
  expect((await stopped.run("delegate_work", plan)).ok).toBe(false);
  expect(stopped.scope.run).not.toHaveBeenCalled();
});
it("waits for actual status changes, remains bounded, and aborts promptly", async () => {
  vi.useFakeTimers();
  try {
    const pending = fixture({ ownedGoals: ["child"] });
    const waiting = pending.run("delegation_wait", { goal: "child", seconds: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await waiting;
    expect(result.ok).toBe(true); expect(JSON.parse(result.output).status).toBe("running");
    expect(JSON.parse(result.output).completion).toContain("not passed");
    expect((await pending.run("delegation_wait", { goal: "child", seconds: 31 })).ok).toBe(false);
    const aborting = pending.run("delegation_wait", { goal: "child", seconds: 30 });
    await vi.advanceTimersByTimeAsync(1); pending.controller.abort();
    expect(await aborting).toMatchObject({ ok: false, output: "Delegation cancelled" });
  } finally { vi.useRealTimers(); }
});

it("only exposes resume to the owning parent within the existing plan", async () => {
 const resume=vi.fn(async()=>goal());
 const parent=fixture({resume,ownedGoals:["child"]});
 expect((await parent.run("delegation_resume",{goal:"foreign"})).ok).toBe(false);
 expect((await parent.run("delegation_resume",{goal:"child",maxTokens:999999})).ok).toBe(false);
 expect(resume).not.toHaveBeenCalled();
 expect((await parent.run("delegation_resume",{goal:"child"})).ok).toBe(true);
 expect(resume).toHaveBeenCalledWith("child");
 expect(fixture({resume,depth:1}).tools.some(t=>t.name==="delegation_resume")).toBe(false);
});
it("binds inbox reads to the trusted worker identity without consuming messages", async () => {
 const state=goal();state.tasks[0].messages=[{id:"message",input:"Peer: verify the output",at:1}];
 const worker=fixture({depth:1,taskId:"one",ownedGoals:["child"],get:async()=>state});
 const result=await worker.run("delegation_inbox",{goal:"child"});
 expect(JSON.parse(result.output)).toMatchObject({task:"one",messages:[{id:"message",input:"Peer: verify the output",at:1}]});
 expect(state.tasks[0].messages).toHaveLength(1);
 expect((await worker.run("delegation_inbox",{goal:"child",task:"two"})).ok).toBe(false);
 expect((await worker.run("delegation_inbox",{goal:"foreign"})).ok).toBe(false);
});

it("rejects nonviable team budgets before reserving or creating workers", async () => {
 const f=fixture();
 for (const maxTokens of [2000,8000,49999]) expect((await f.run("delegate_work",{...plan,maxTokens})).ok).toBe(false);
 expect(f.scope.reserve).not.toHaveBeenCalled();
 expect((await f.run("delegate_work",plan)).ok).toBe(true);
 expect(f.scope.create).toHaveBeenCalledWith(expect.objectContaining({maxTokens:150000}));
});
it('discovers only trusted owned plans and worker identity without accepting caller IDs', async()=>{
 const get=vi.fn(async(id:string)=>goal(id));const worker=fixture({depth:1,taskId:'one',ownedGoals:['owned'],get});
 const result=await worker.run('delegation_context',{});
 expect(JSON.parse(result.output)).toMatchObject({taskId:'one',goals:[{id:'owned',tasks:[{id:'one'}]}]});
 expect(get).toHaveBeenCalledWith('owned');
 expect((await worker.run('delegation_context',{goal:'foreign'})).ok).toBe(false);
 expect(get).toHaveBeenCalledTimes(1);
});

it('restricts result review to the owning parent with an exact digest',async()=>{
 const acceptResult=vi.fn(async()=>goal()),f=fixture({acceptResult,ownedGoals:['child']});
 expect((await f.run('delegation_accept_result',{goal:'foreign',summary:'Checked',digest:'a'.repeat(64)})).ok).toBe(false);
 expect((await f.run('delegation_accept_result',{goal:'child',summary:'Checked',digest:'bad'})).ok).toBe(false);
 expect(acceptResult).not.toHaveBeenCalled();
 expect((await f.run('delegation_accept_result',{goal:'child',summary:'Checked',digest:'a'.repeat(64)})).ok).toBe(true);
 expect(acceptResult).toHaveBeenCalledWith('child','Checked','a'.repeat(64));
 expect(fixture({acceptResult,depth:1}).tools.some(t=>t.name==='delegation_accept_result')).toBe(false);
});

it('exposes report truncation and scoped pages through the exact last character',async()=>{
 const state=goal();state.tasks[0].answer='a'.repeat(4000)+'FINAL_EVIDENCE';
 const f=fixture({ownedGoals:['child'],get:async()=>state});
 const status=JSON.parse((await f.run('delegation_status',{goal:'child'})).output);
 expect(status.tasks[0]).toMatchObject({answerTruncated:true,answerCharacters:4014});
 const first=JSON.parse((await f.run('delegation_report',{goal:'child',task:'one'})).output);
 expect(first.nextOffset).toBe(4000);expect(first.answer).toHaveLength(4000);
 const last=JSON.parse((await f.run('delegation_report',{goal:'child',task:'one',offset:first.nextOffset})).output);
 expect(last.answer).toBe('FINAL_EVIDENCE');expect(last.nextOffset).toBeNull();expect(last.resultDigest).toBe(status.resultDigest);
 expect((await f.run('delegation_report',{goal:'foreign',task:'one'})).ok).toBe(false);
 expect((await f.run('delegation_report',{goal:'child',task:'foreign'})).ok).toBe(false);
});
