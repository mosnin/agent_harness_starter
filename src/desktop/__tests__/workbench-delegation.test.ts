import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
const roots: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); servers.splice(0).forEach(server => { server.closeAllConnections(); server.close(); }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const tool = (name: string, input: unknown) => `TOOL: ${name}\nINPUT: ${JSON.stringify(input)}`;
async function setup(reply: (request: any, events: any[]) => string) {
  const root = mkdtempSync(join(tmpdir(), "hades-delegation-e2e-")); roots.push(root);
  const events: any[] = [], requests: any[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      const request = JSON.parse(body); requests.push(request);
      const content = reply(request, events);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
    });
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const reopen = () => { const service = new WorkbenchService(join(root, "data"), event => events.push(event), { NODE_ENV: "test" }); services.push(service); return service; };
  const s = reopen(); await s.dispatch("project.add", { path: root });
  await s.dispatch("profile.save", { id: "default", name: "Test", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  const session: any = await s.dispatch("session.new", { root });
  return { root, s, session, events, requests, reopen };
}
function currentInput(request: any) { return request.messages.filter((message: any) => message.role === "user" && !/^TOOL_(RESULT|ERROR):/.test(message.content)).at(-1)?.content ?? ""; }
async function approval(s: WorkbenchService, events: any[], kind: string, allow = true, after = 0) {
  await vi.waitFor(() => expect(events.slice(after).some(e => e.kind === "desktop.approval" && e.tool === kind)).toBe(true), { timeout: 3000 });
  const event = events.slice(after).find(e => e.kind === "desktop.approval" && e.tool === kind);
  await s.dispatch("approval.reply", { id: event.id, allow });
  return event;
}
async function done(s: WorkbenchService, id: string) {
  await vi.waitFor(async () => expect((await s.dispatch("session.get", { id }) as any).progress?.running).toBe(false), { timeout: 3000 });
}
const checkedPlan = { objective: "Produce two checked files", tasks: [
  { id: "first", title: "First", prompt: "Produce FIRST" },
  { id: "second", title: "Second", prompt: "Produce SECOND after verifying first", dependsOn: ["first"] },
], acceptance: [{ path: "first.txt", contains: "FIRST" }, { path: "second.txt", contains: "SECOND" }] };

it("approves agent-created work and child writes independently, enforces dependencies, and persists evidence and lineage", async () => {
  const { root, s, session, events, requests, reopen } = await setup(request => {
    if (/^TOOL_(RESULT|ERROR):/.test(request.messages.at(-1).content)) return "ANSWER: Assigned task complete.";
    const input = currentInput(request);
    if (!input.startsWith("Work objective:")) return tool("delegate_work", checkedPlan);
    const second = input.includes("Your assigned task: Produce SECOND");
    return tool("file_ops", { op: "write", path: second ? "second.txt" : "first.txt", content: second ? "SECOND" : "FIRST" });
  });
  await s.dispatch("chat.send", { id: session.id, input: "Create a dependent work plan" });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval" && e.tool === "delegate_work")).toBe(true));
  expect(await s.dispatch("work.list", {})).toEqual([]);
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  await approval(s, events, "delegate_work");
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval" && e.tool === "file_ops")).toBe(true));
  expect(requests.some(r => currentInput(r).includes("Your assigned task: Produce SECOND"))).toBe(false);
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  const cursor = events.length;
  await approval(s, events, "file_ops");
  const secondApproval = await approval(s, events, "file_ops", true, cursor);
  expect(JSON.parse(secondApproval.input).path).toBe("second.txt");
  const plans: any[] = await s.dispatch("work.list", {}) as any[];
  expect(plans).toHaveLength(1);
  await vi.waitFor(async () => expect(await s.dispatch("work.get", { id: plans[0].id })).toMatchObject({ status: "completed" }), { timeout: 3000 });
  const goal: any = await s.dispatch("work.get", { id: plans[0].id });
  expect(goal.evidence).toHaveLength(2);
  expect(goal.evidence.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  expect(requests.find(r => currentInput(r).includes("Your assigned task: Produce SECOND")).messages.some((message: any) => message.content.includes("Completed dependency reports"))).toBe(true);
  expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("SECOND");
  await done(s, session.id); s.close();
  const restored = reopen();
  expect(await restored.dispatch("session.get", { id: session.id })).toMatchObject({ delegatedWork: [goal.id], delegationReserved: { goals: 1, tasks: 2, tokens: 150000, minutes: 15 } });
  for (const task of goal.tasks) expect(await restored.dispatch("session.get", { id: task.session })).toMatchObject({ workGoal: goal.id, workOwner: "default" });
  expect(await restored.dispatch("work.get", { id: goal.id })).toMatchObject({ status: "completed", evidence: goal.evidence });
});

it("declining delegation creates no work and no durable reservation", async () => {
  const { s, session, events } = await setup(request => /^TOOL_(RESULT|ERROR):/.test(request.messages.at(-1).content) ? "ANSWER: Declined." : tool("delegate_work", checkedPlan));
  await s.dispatch("chat.send", { id: session.id, input: "Delegate work" });
  await approval(s, events, "delegate_work", false); await done(s, session.id);
  expect(await s.dispatch("work.list", {})).toEqual([]);
  expect((await s.dispatch("session.get", { id: session.id }) as any).delegationReserved).toBeUndefined();
});

it("retains goal ownership and cumulative allocation limits across service restarts", async () => {
  let inspectGoal = "";
  const noop = { objective: "Bounded task", tasks: [{ id: "one", title: "Inspect", prompt: "NOOP" }] };
  const { s, session, events, reopen } = await setup(request => {
    if (/^TOOL_(RESULT|ERROR):/.test(request.messages.at(-1).content)) return "ANSWER: Recorded result.";
    const input = currentInput(request);
    if (input.startsWith("Work objective:")) return "ANSWER: Inspected.";
    return input === "STATUS" ? tool("delegation_status", { goal: inspectGoal }) : tool("delegate_work", noop);
  });
  let service = s;
  for (let turn = 0; turn < 3; turn++) {
    const cursor = events.length;
    await service.dispatch("chat.send", { id: session.id, input: `ALLOCATE ${turn}` });
    await approval(service, events, "delegate_work", true, cursor); await done(service, session.id);
    if (turn < 2) {
      const snapshot: any = await service.dispatch("session.get", { id: session.id });
      expect(snapshot.delegatedWork).toHaveLength(turn + 1);
      inspectGoal = snapshot.delegatedWork[0];
      await vi.waitFor(async () => expect((await service.dispatch("work.list", {}) as any[]).every(goal => goal.status !== "running")).toBe(true));
      service.close(); service = reopen();
      const statusCursor = events.length;
      await service.dispatch("chat.send", { id: session.id, input: "STATUS" }); await done(service, session.id);
      expect(events.slice(statusCursor).some(event => event.kind === "desktop.tool" && event.tool === "delegation_status" && event.status === "done" && event.ok)).toBe(true);
    }
  }
  expect(await service.dispatch("work.list", {})).toHaveLength(2);
  expect((await service.dispatch("session.get", { id: session.id }) as any).delegationReserved).toEqual({ goals: 2, tasks: 2, tokens: 150000, minutes: 30 });
  expect(events.some(event => event.kind === "desktop.tool" && event.tool === "delegate_work" && event.ok === false && event.output.includes("delegation budget"))).toBe(true);
});

it("child agents cannot recursively delegate or stop their parent even with a stop approval", async () => {
  let childCalls = 0;
  const noop = { objective: "Exercise child boundaries", tasks: [{ id: "one", title: "Inspect", prompt: "CHILD BOUNDARIES" }] };
  const { s, session, events, requests } = await setup((request, observed) => {
    const input = currentInput(request);
    if (!input.startsWith("Work objective:")) return /^TOOL_(RESULT|ERROR):/.test(request.messages.at(-1).content) ? "ANSWER: Delegated." : tool("delegate_work", noop);
    childCalls++;
    if (childCalls === 1) return tool("delegate_work", noop);
    if (childCalls === 2) return tool("delegation_stop", { goal: observed.find(event => event.kind === "desktop.work").id });
    return "ANSWER: Stayed inside child scope.";
  });
  await s.dispatch("chat.send", { id: session.id, input: "Delegate bounded child" });
  await approval(s, events, "delegate_work");
  await approval(s, events, "delegation_stop");
  await vi.waitFor(async () => expect((await s.dispatch("work.list", {}) as any[])[0]?.status).toBe("needs_review"));
  const plans: any[] = await s.dispatch("work.list", {}) as any[];
  expect(plans).toHaveLength(1); expect(plans[0].tasks[0].status).toBe("completed");
  expect(events.filter(event => event.kind === "desktop.approval" && event.tool === "delegate_work")).toHaveLength(1);
  expect(events.some(event => event.kind === "desktop.tool" && event.tool === "delegate_work" && event.ok === false && event.output.includes("unknown tool"))).toBe(true);
  expect(events.some(event => event.kind === "desktop.tool" && event.tool === "delegation_stop" && event.ok === false && event.output.includes("cannot stop"))).toBe(true);
  expect(requests.filter(request => currentInput(request).startsWith("Work objective:")).every(request => !request.messages[0].content.includes("Create and start a bounded dependent work plan"))).toBe(true);
});
