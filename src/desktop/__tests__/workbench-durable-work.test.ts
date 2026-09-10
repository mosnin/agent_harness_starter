import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";

const roots: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); servers.splice(0).forEach(s => { s.closeAllConnections(); s.close(); }); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-work-integration-")); roots.push(root);
  const requests: any[] = [], events: any[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", data => body += data); req.on("end", () => {
      const input = JSON.parse(body); requests.push(input);
      const last = input.messages.at(-1).content;
      const content = /^TOOL_(RESULT|ERROR):/.test(last) ? "ANSWER: Completed the assigned task."
        : `TOOL: file_ops\nINPUT: ${JSON.stringify({ op: "write", path: input.model === "producer" ? "first.txt" : "second.txt", content: input.model === "producer" ? "FIRST" : "SECOND" })}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
    });
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const s = new WorkbenchService(join(root, "data"), e => events.push(e), { NODE_ENV: "test" }); services.push(s);
  await s.dispatch("project.add", { path: root });
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  await s.dispatch("profile.save", { id: "default", name: "Producer", provider: "local", model: "producer", baseUrl });
  const peer: any = await s.dispatch("profile.save", { name: "Reviewer", provider: "local", model: "reviewer", baseUrl });
  await s.dispatch("profile.select", { id: "default" });
  return { root, s, events, requests, peer: peer.id };
}
it("runs a dependent multi-profile plan through actual conversations, approvals and durable output checks", async () => {
  const { root, s, events, requests, peer } = await setup();
  const goal: any = await s.dispatch("work.create", { root, objective: "Produce two checked outputs", tasks: [
    { id: "first", title: "First", prompt: "Create FIRST", profile: "default" },
    { id: "second", title: "Second", prompt: "Verify first then create SECOND", profile: peer, dependsOn: ["first"] },
  ], acceptance: [{ path: "first.txt", contains: "FIRST" }, { path: "second.txt", contains: "SECOND" }] });
  await s.dispatch("work.run", { id: goal.id });
  await vi.waitFor(() => expect(events.filter(e => e.kind === "desktop.approval")).toHaveLength(1));
  expect(requests.every(r => r.model === "producer")).toBe(true);
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  await s.dispatch("approval.reply", { id: events.find(e => e.kind === "desktop.approval").id, allow: true });
  await vi.waitFor(() => expect(events.filter(e => e.kind === "desktop.approval")).toHaveLength(2));
  expect(requests.find(r => r.model === "reviewer").messages.some((m: any) => m.content.includes("Completed dependency reports"))).toBe(true);
  await s.dispatch("approval.reply", { id: events.filter(e => e.kind === "desktop.approval")[1].id, allow: true });
  await vi.waitFor(async () => expect(await s.dispatch("work.get", { id: goal.id })).toMatchObject({ status: "completed" }));
  const done: any = await s.dispatch("work.get", { id: goal.id });
  expect(done.tokens).toBe(60); expect(done.evidence).toHaveLength(2);
  expect(done.evidence.every((e: any) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
  expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("SECOND");
  await expect(s.dispatch("work.get", { id: goal.id, profile: peer })).rejects.toThrow("another profile");
  s.close();
  const restored = new WorkbenchService(join(root, "data"), () => {}, { NODE_ENV: "test" }); services.push(restored);
  expect(await restored.dispatch("work.get", { id: goal.id })).toMatchObject({ status: "completed", evidence: done.evidence });
  const transcript: any = await restored.dispatch("session.get", { id: done.tasks[0].session });
  expect(transcript.progress.tools.some((e: any) => e.tool === "file_ops" && e.status === "done")).toBe(true);
});
it("stopping a plan cancels its live approval and cannot authorize the write afterward", async () => {
  const { root, s, events } = await setup();
  const goal: any = await s.dispatch("work.create", { root, objective: "Stop before effect", tasks: [{ title: "First", prompt: "Create FIRST" }], acceptance: [{ path: "first.txt" }] });
  await s.dispatch("work.run", { id: goal.id });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.approval")).toBe(true));
  const approval = events.find(e => e.kind === "desktop.approval");
  await s.dispatch("work.stop", { id: goal.id });
  await s.dispatch("approval.reply", { id: approval.id, allow: true });
  await vi.waitFor(() => expect(events.some(e => e.kind === "desktop.done")).toBe(true));
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  expect(await s.dispatch("work.get", { id: goal.id })).toMatchObject({ status: "cancelled" });
});
