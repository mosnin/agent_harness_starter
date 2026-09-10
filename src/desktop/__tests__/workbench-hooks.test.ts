import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchService, type WorkbenchEvent } from "../core/workbench-service";
const roots: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(async () => { services.splice(0).forEach(s => s.close()); servers.splice(0).forEach(s => { s.closeAllConnections(); s.close(); }); await new Promise(r => setTimeout(r, 30)); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error("Integration timed out"); await new Promise(r => setTimeout(r, 10)); } }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hades-workbench-hooks-")); roots.push(root); const project = join(root, "project"), data = join(root, "data"); mkdirSync(project); writeFileSync(join(project, "sentinel.txt"), "KEEP");
  const server = createServer((request, response) => { let body = ""; request.on("data", data => body += data); request.on("end", () => { const parsed = JSON.parse(body), last = parsed.messages.at(-1).content; const content = /^TOOL_(RESULT|ERROR):/.test(last) ? "ANSWER: Finished reviewing the tool result." : 'TOOL: file_ops\nINPUT: {"op":"write","path":"sentinel.txt","content":"CHANGED"}'; response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); }); }); servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const events: WorkbenchEvent[] = [], create = () => { const s = new WorkbenchService(data, e => events.push(e), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0" }); services.push(s); return s; }, service = create();
  await service.dispatch("project.add", { path: project }); await service.dispatch("profile.save", { id: "default", name: "Hook fixture", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
  const session = await service.dispatch("session.new", { root: project, profile: "default" }) as any;
  const hook = async (phase: string, script: string) => { const path = join(project, `${phase}.sh`); writeFileSync(path, "#!/bin/sh\n" + script, { mode: 0o700 }); const row = await service.dispatch("hook.save", { name: phase, phase, root: project, profile: "default", executable: path, matcher: "file_ops", timeoutSeconds: 3 }) as any; await service.dispatch("hook.consent", { id: row.id, profile: "default", approved: true }); return row; };
  const start = async () => { await service.dispatch("chat.send", { id: session.id, profile: "default", input: "Write CHANGED to sentinel.txt" }); await until(() => events.some(e => e.kind === "desktop.approval")); return events.find(e => e.kind === "desktop.approval")!; };
  const finish = () => until(() => events.some(e => e.kind === "desktop.done")); return { service, create, session, project, events, hook, start, finish };
}
describe("Native hook ordering through Workbench and a deterministic HTTP provider fixture", () => {
  it("does not run hooks for denied tools", async () => { const f = await fixture(); await f.hook("pre_tool", "touch hook-ran"); const approval = await f.start(); expect(existsSync(join(f.project, "hook-ran"))).toBe(false); await f.service.dispatch("approval.reply", { id: approval.id, allow: false }); await f.finish(); expect(existsSync(join(f.project, "hook-ran"))).toBe(false); expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("KEEP"); expect(f.events.some(e => e.kind === "desktop.hook")).toBe(false); });
  it("blocks effects after a failing pre hook", async () => { const f = await fixture(); await f.hook("pre_tool", "printf blocked; exit 7"); const approval = await f.start(); await f.service.dispatch("approval.reply", { id: approval.id, allow: true }); await f.finish(); expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("KEEP"); expect(f.events.find(e => e.kind === "desktop.hook")).toMatchObject({ phase: "pre_tool", status: "failed", ok: false }); expect(f.events.find(e => e.kind === "desktop.tool" && e.status === "done")).toMatchObject({ ok: false, output: expect.stringContaining("Pre-tool hook stopped") }); });
  it("persists separate post failure receipts without changing successful tool status or replaying after restart", async () => { const f = await fixture(); await f.hook("pre_tool", "cat >/dev/null; printf pre >> hook-calls"); await f.hook("post_tool", "printf post >> hook-calls; exit 8"); const approval = await f.start(); await f.service.dispatch("approval.reply", { id: approval.id, allow: true }); await f.finish(); expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("CHANGED"); expect(f.events.find(e => e.kind === "desktop.tool" && e.status === "done")).toMatchObject({ ok: true }); expect(f.events.filter(e => e.kind === "desktop.hook")).toEqual([expect.objectContaining({ phase: "pre_tool", ok: true }), expect.objectContaining({ phase: "post_tool", ok: false })]);
    f.service.close(); const restored = f.create(), record = await restored.dispatch("session.get", { id: f.session.id, profile: "default" }) as any; expect(record.progress.journal.filter((e: any) => e.kind === "desktop.hook")).toHaveLength(2); expect(record.progress.tools.find((e: any) => e.status === "done").ok).toBe(true); expect(readFileSync(join(f.project, "hook-calls"), "utf8")).toBe("prepost");
  });
  it("rechecks cancellation after a pre hook before touching the tool target", async () => { const f = await fixture(); await f.hook("pre_tool", "touch hook-started; sleep 10"); const approval = await f.start(); await f.service.dispatch("approval.reply", { id: approval.id, allow: true }); await until(() => existsSync(join(f.project, "hook-started"))); await f.service.dispatch("chat.stop", { id: f.session.id, profile: "default" }); await f.finish(); expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("KEEP"); expect(f.events.some(e => e.kind === "desktop.hook" && e.status === "cancelled")).toBe(true); });
  it("rechecks the work effect guard after an approved pre hook", async () => {
    const f = await fixture(); let revoked = false;
    (f.service as any).effectGuards.set(f.session.id, () => { if (revoked) throw new Error("Work lease revoked"); });
    await f.hook("pre_tool", 'touch hook-started; while [ ! -f release-hook ]; do sleep 0.05; done');
    const approval = await f.start(); await f.service.dispatch("approval.reply", { id: approval.id, allow: true }); await until(() => existsSync(join(f.project, "hook-started")));
    revoked = true; writeFileSync(join(f.project, "release-hook"), "release"); await f.finish();
    expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("KEEP"); expect(f.events.find(e => e.kind === "desktop.tool" && e.status === "done")).toMatchObject({ ok: false, output: expect.stringContaining("Work lease revoked") });
  });

  it("preserves a successful file effect when checkpoint finalization fails and blocks later effects", async () => {
    const f = await fixture(); await f.hook("post_tool", "touch forbidden-post");
    vi.spyOn((f.service as any).checkpoints, "finish").mockImplementation(() => { throw new Error("fixture disk full"); });
    const approval = await f.start(); await f.service.dispatch("approval.reply", { id: approval.id, allow: true }); await f.finish();
    expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("CHANGED");
    expect(f.events.find(e => e.kind === "desktop.tool" && e.status === "done")).toMatchObject({ ok: true });
    expect(f.events.some(e => e.kind === "desktop.error" && String(e.message).includes("checkpoint could not be finalized"))).toBe(true);
    expect(existsSync(join(f.project, "forbidden-post"))).toBe(false);
    const approvals = f.events.filter(e => e.kind === "desktop.approval").length, completed = f.events.filter(e => e.kind === "desktop.done").length;
    await f.service.dispatch("chat.send", { id: f.session.id, profile: "default", input: "Repeat the change" });
    await until(() => f.events.filter(e => e.kind === "desktop.done").length > completed);
    expect(f.events.filter(e => e.kind === "desktop.approval")).toHaveLength(approvals);
    expect(readFileSync(join(f.project, "sentinel.txt"), "utf8")).toBe("CHANGED");
  });

});
