import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DesktopRequestQueue } from "../core/desktop-request-queue";
import { DESKTOP_CONTROL_METHODS, desktopRequestLane, scheduleDesktopRequest } from "../core/desktop-request-routing";
import { WorkbenchService, type WorkbenchEvent } from "../core/workbench-service";
vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Request = { id: string; method: string; args?: Record<string, unknown> };
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hades-request-route-")), events: WorkbenchEvent[] = [];
  const queue = new DesktopRequestQueue<Request>();
  const service = new WorkbenchService(home, event => events.push(event), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0", HADES_HELM_ORCA_ARTIFACTS: join(home, "missing-artifacts") });
  await service.dispatch("project.add", { path: home });
  const host = { handle: service.handle.bind(service), rejected: (request: Request, error: unknown) => { events.push({ kind: "desktop.response", id: request.id, error: String(error) }); } };
  const submit = (method: string, args: Record<string, unknown>, id = randomUUID()) => ({ id, result: scheduleDesktopRequest(queue, { id, method, args }, host) });
  cleanup.push(async () => { await Promise.all([queue.close(), service.close()]); rmSync(home, { recursive: true, force: true }); });
  return { home, events, queue, service, submit, scope: { root: home, profile: "default" } };
}
it("cancels an unadmitted Orca start without creating a fake stopped worker", async () => {
  const f = await fixture(), hold = deferred(), task = randomUUID();
  const first = f.queue.submit({ id: "blocker", method: "fixture" }, "serial", () => hold.promise);
  const start = f.submit("helm.orca.start", { ...f.scope, requestId: task, agent: "codex", prompt: "Never launch" });
  const stop = f.submit("helm.orca.stop", { ...f.scope, id: task }); await stop.result; await start.result;
  expect(f.events.find(event => event.id === stop.id)).toMatchObject({ result: { id: task, cancelledBeforeAdmission: true, workerState: "not_found_at_inspection" } });
  expect(f.events.find(event => event.id === start.id)?.error).toContain("before handler admission");
  hold.resolve(); await first; await f.queue.drain();
  expect(await f.service.dispatch("helm.orca.list", f.scope)).toEqual([]);
});
it("still stops a retained active worker when the removed queue item was a duplicate", async () => {
  const f = await fixture(), hold = deferred(), task = randomUUID(), calls: string[] = [];
  const orca = (f.service as any).helmOrca;
  orca.options.resolveBase=async()=>"a".repeat(40); // Explicit non-Git transport fixture; never importable.
  orca.options.connect = async () => ({ runtimeId: "fixture-runtime", coordinator: "coordinator", repo: "repo", call: async (method: string) => {
    calls.push(method);
    if (method === "orchestration.runCreate") return { run: { id: "run" } };
    if (method === "orchestration.workerStart") return { state: "ready", dispatchId: "dispatch" };
    if (method === "orchestration.workerStop") return { state: "stopped", dispatchId: "dispatch" };
    throw Error("Unexpected contract call");
  } });
  await orca.start(f.scope, { requestId: task, agent: "codex", prompt: "Retained task" });
  const first = f.queue.submit({ id: "blocker", method: "fixture" }, "serial", () => hold.promise);
  try {
  const duplicate = f.submit("helm.orca.start", { ...f.scope, requestId: task, agent: "codex", prompt: "Retained task" });
  const stop = f.submit("helm.orca.stop", { ...f.scope, id: task }); await stop.result; await duplicate.result;
  const result: any = f.events.find(event => event.id === stop.id)?.result;
  expect(result).toMatchObject({ id: task, state: "stopped", active: false }); expect(result.cancelledBeforeAdmission).toBeUndefined();
  expect(calls.filter(method => method === "orchestration.workerStart")).toHaveLength(1);
  expect(calls.filter(method => method === "orchestration.workerStop")).toHaveLength(1);
  } finally {hold.resolve(); await first;}
});
it("does not remove another profile's queued start or accept an untrusted cancellation hint", async () => {
  const f = await fixture(), hold = deferred(), task = randomUUID();
  const first = f.queue.submit({ id: "blocker", method: "fixture" }, "serial", () => hold.promise);
  const start = f.submit("helm.orca.start", { ...f.scope, requestId: task, agent: "codex", prompt: "Private task" });
  const stop = f.submit("helm.orca.stop", { ...f.scope, profile: "missing-profile", id: task }); await stop.result;
  expect(f.events.find(event => event.id === stop.id)?.error).toBeTruthy();
  const forged = f.submit("helm.orca.stop", { ...f.scope, id: randomUUID(), cancelledOrcaStartBeforeAdmission: true }); await forged.result;
  expect(f.events.find(event => event.id === forged.id)?.error).toBeTruthy();
  hold.resolve(); await first; await start.result;
  expect(f.events.find(event => event.id === start.id)?.error).toContain("not included");
});
it("a stopped Work plan cannot be restarted by an already queued Resume", async () => {
  const f = await fixture(), hold = deferred();
  const goal = await f.service.dispatch("work.create", { ...f.scope, objective: "Preserve cancellation", tasks: [{ id: "task", title: "Task", prompt: "Do not start", profile: "default" }] }) as { id: string };
  const first = f.queue.submit({ id: "blocker", method: "fixture" }, "serial", () => hold.promise);
  const run = f.submit("work.resume", { id: goal.id, profile: "default" });
  const stop = f.submit("work.stop", { id: goal.id, profile: "default" }); await stop.result; await run.result;
  hold.resolve(); await first; await f.queue.drain();
  expect(await f.service.dispatch("work.get", { id: goal.id, profile: "default" })).toMatchObject({ status: "cancelled", tasks: [{ rounds: 0 }] });
});
it("uses the same reserved controls in the native bridge and leaves startup serialized", () => {
  const source = readFileSync(join(import.meta.dirname, "../../..", "src-tauri/src/request_capacity.rs"), "utf8");
  const block = source.match(/pub const CONTROL_METHODS:[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1];
  expect(block).toBeTruthy();
  expect([...block!.matchAll(/"([a-z.]+)"/g)].map(match => match[1]).sort()).toEqual([...DESKTOP_CONTROL_METHODS].sort());
  for (const method of DESKTOP_CONTROL_METHODS) expect(desktopRequestLane(method)).toBe("control");
  for (const method of ["helm.orca.start", "work.resume", "helm.integration.apply"]) expect(desktopRequestLane(method)).toBe("serial");
  expect(desktopRequestLane("helm.orca.refresh")).toBe("inspection");
  expect(desktopRequestLane("work.orca.acceptance")).toBe("inspection");
  expect(desktopRequestLane("work.source.status")).toBe("inspection");
  for (const operation of ["start", "replay"]) expect(desktopRequestLane("spatial.workflow", { operation })).toBe("serial");
  for (const operation of ["stop", "cancel"]) expect(desktopRequestLane("spatial.workflow", { operation })).toBe("control");
  for (const operation of [["cancel"], ["stop"], null, {}]) expect(desktopRequestLane("spatial.workflow", { operation })).toBe("serial");
});
it.each(["work.orca.import","work.orca.accept"])("Stop revokes queued %s before host mutation",async method=>{
 const f=await fixture(),hold=deferred();
 const goal:any=await f.service.dispatch("work.create",{...f.scope,objective:"Preserve review cancellation",tasks:[{id:"task",title:"Task",prompt:"Inspect"}]});
 const first=f.queue.submit({id:"review-blocker",method:"fixture"},"serial",()=>hold.promise);
 try{
  const queued=f.submit(method,{id:goal.id,task:"task",profile:"default"});
  await f.submit("work.stop",{id:goal.id,profile:"default"}).result;await queued.result;
  expect(f.events.find(event=>event.id===queued.id)?.error).toContain("before handler admission");
 }finally{hold.resolve();await first;}
});
it.each(["helm.verify","helm.integration.prepare","helm.integration.apply","helm.source.start"])("Stop revokes queued Work-bound %s using exact scope",async method=>{
 const f=await fixture(),hold=deferred();
 const goal:any=await f.service.dispatch("work.create",{...f.scope,objective:"Preserve review cancellation",tasks:[{id:"task",title:"Task",prompt:"Inspect"}]});
 const first=f.queue.submit({id:"helm-review-blocker",method:"fixture"},"serial",()=>hold.promise);
 try{
  const queued=f.submit(method,{id:"imported-helm-run",workGoalId:goal.id,profile:"default"});
  await f.submit("work.stop",{id:goal.id,profile:"default"}).result;await queued.result;
  expect(f.events.find(event=>event.id===queued.id)?.error).toContain("before handler admission");
 }finally{hold.resolve();await first;}
});
