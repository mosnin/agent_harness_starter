import { afterEach, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
const roots: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(() => { services.splice(0).forEach(service => service.close()); servers.splice(0).forEach(server => { server.closeAllConnections(); server.close(); }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-maintenance-integration-")); roots.push(root);
  const data = join(root, "data"), destination = join(root, "exports"), project = join(root, "project");
  mkdirSync(destination); mkdirSync(project);
  const events: any[] = [];
  const service = new WorkbenchService(data, event => events.push(event), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0" }); services.push(service);
  await service.dispatch("project.add", { path: project });
  await service.dispatch("webhook.status", {});
  return { root, data, destination, project, service, events };
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => release = resolve); return { promise, release }; }
it("creates a real RPC backup, verifies and stages isolated history with fresh channel and hook authority", async () => {
  const { service, data, destination, project } = await setup();
  const session: any = await service.dispatch("session.new", { root: project });
  const created: any = await service.dispatch("maintenance.create", { destination });
  expect(created.privateHistory).toBe(true);
  const verified: any = await service.dispatch("maintenance.verify", { path: created.path });
  expect(verified.valid).toBe(true);
  const bundle = JSON.parse(readFileSync(created.path, "utf8"));
  expect(bundle.files.some((file: any) => file.path === "sessions.json")).toBe(true);
  expect(bundle.files.some((file: any) => ["shell-hooks.sqlite", "channel-access.sqlite"].includes(file.path))).toBe(false);
  expect(bundle.exclusions.join(" ")).toMatch(/Shell hook configuration and channel access approvals/);
  const staged: any = await service.dispatch("maintenance.stage", { path: created.path, destination, expectedSha256: verified.sha256 });
  expect(staged).toMatchObject({ staged: true, activated: false });
  expect(staged.path).not.toBe(data);
  expect(existsSync(join(staged.path, "shell-hooks.sqlite"))).toBe(false);
  expect(JSON.parse(readFileSync(join(staged.path, "desktop.json"), "utf8"))).toMatchObject({ projects: [], computerEnabled: false });
  expect(await service.dispatch("session.get", { id: session.id })).toMatchObject({ id: session.id, root: realpathSync(project) });
  expect(await service.dispatch("maintenance.list", {})).toHaveLength(1);
  const diagnostics: any = await service.dispatch("maintenance.diagnostics", {});
  expect(diagnostics.schemas.every((schema: any) => schema.integrity === "ok")).toBe(true);
  const support: any = await service.dispatch("maintenance.support", { destination });
  expect(readFileSync(support.path, "utf8")).not.toContain(project);
});
it("blocks new RPCs, advanced schedule admission and HTTP events during a barrier, then resumes without lost events", async () => {
  const { service, project } = await setup();
  const subscription: any = await service.dispatch("webhook.create", { name: "Fixture", root: project, prompt: "Inspect a fixture", events: ["test"] });
  const held = deferred(); const snapshot = (service as any).withMaintenanceSnapshot(() => held.promise);
  try {
    for (const method of ["profile.save", "project.add", "chat.send", "job.run", "work.create", "webhook.update", "key.set", "hook.create", "channel.access.approve"])
      await expect(service.dispatch(method, {})).rejects.toThrow("backup is in progress");
    const callback = vi.fn(async () => true);
    await expect(service.withMaintenanceAdmission(callback)).rejects.toThrow("backup is in progress"); expect(callback).not.toHaveBeenCalled();
    await expect(service.executeScheduled({ sourceId: "scheduled-during-backup", input: "Do not start", root: project })).rejects.toThrow("backup is in progress");
    const pump = vi.spyOn((service as any).wakes, "claim");
    await (service as any).tick(); await (service as any).pumpWakes(); expect(pump).not.toHaveBeenCalled();
    const response = await fetch(subscription.subscription.url, { method: "POST", headers: { authorization: `Bearer ${subscription.token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "one", event: "test", payload: {} }) });
    expect(response.status).toBe(503); expect((service as any).webhooks.events(subscription.subscription.id, "default")).toEqual([]);
  } finally { held.release(); await snapshot; }
  expect(await service.withMaintenanceAdmission(async () => "resumed")).toBe("resumed");
  expect(await service.dispatch("webhook.status", {})).toMatchObject({ admissionPaused: false, active: 0 });
});
it("rejects snapshots while an admitted legacy operation is pending and restores admission after snapshot failure", async () => {
  const { service, destination } = await setup(); const held = deferred();
  const operation = service.withMaintenanceAdmission(() => held.promise);
  await expect(service.dispatch("maintenance.create", { destination })).rejects.toThrow("active requests");
  expect(readdirSync(destination)).toEqual([]); held.release(); await operation;
  await expect((service as any).withMaintenanceSnapshot(async () => { throw new Error("Fixture snapshot failure"); })).rejects.toThrow("Fixture snapshot failure");
  expect(await service.dispatch("webhook.status", {})).toMatchObject({ admissionPaused: false });
  expect(await service.dispatch("maintenance.create", { destination })).toMatchObject({ privateHistory: true });
});
it("requires Slack disconnection and queued routine cancellation before a snapshot", async () => {
  const { service, destination, project } = await setup();
  const slack = (service as any).slack, status = slack.status();
  const spy = vi.spyOn(slack, "status").mockReturnValue({ ...status, enabled: true });
  await expect(service.dispatch("maintenance.create", { destination })).rejects.toThrow("Disconnect Slack"); spy.mockRestore();
  const wakes = (service as any).wakes;
  const wake = wakes.enqueue("test", "one", { job: "routine", profile: "default", root: project, name: "Pending", prompt: "No automatic run" });
  await expect(service.dispatch("maintenance.create", { destination })).rejects.toThrow("cancel queued");
  wakes.cancel(wake.id);
  expect(await service.dispatch("maintenance.create", { destination })).toMatchObject({ privateHistory: true });
});
it("rejects a backup while the actual agent awaits a tool decision, then backs up its interrupted journal after stop", async () => {
  const { service, destination, project, events } = await setup();
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'TOOL: file_ops\nINPUT: {"op":"write","path":"blocked.txt","content":"never"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await service.dispatch("profile.save", { id: "default", name: "Fixture", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  const session: any = await service.dispatch("session.new", { root: project });
  await service.dispatch("chat.send", { id: session.id, input: "Write a test file" });
  await vi.waitFor(() => expect(events.some(event => event.kind === "desktop.approval")).toBe(true));
  await expect(service.dispatch("maintenance.create", { destination })).rejects.toThrow("active requests");
  expect(readdirSync(destination)).toEqual([]);
  await service.dispatch("chat.stop", { id: session.id });
  await vi.waitFor(async () => expect((await service.dispatch("session.get", { id: session.id }) as any).progress.running).toBe(false));
  expect(existsSync(join(project, "blocked.txt"))).toBe(false);
  const backup: any = await service.dispatch("maintenance.create", { destination });
  expect(await service.dispatch("maintenance.verify", { path: backup.path })).toMatchObject({ valid: true });
});
it("rechecks admission for an HTTP body that started before the snapshot", async () => {
  const { service, project } = await setup();
  const configured: any = await service.dispatch("webhook.create", { name: "Slow fixture", root: project, prompt: "Inspect", events: ["test"] });
  const bodyEntered = deferred(), original = (service as any).webhooks.body.bind((service as any).webhooks);
  vi.spyOn((service as any).webhooks, "body").mockImplementation((req: any) => { bodyEntered.release(); return original(req); });
  let complete!: () => void;
  const received = new Promise<number>(resolve => {
    const request = httpRequest(configured.subscription.url, { method: "POST", headers: { authorization: `Bearer ${configured.token}`, "content-type": "application/json" } }, response => { response.resume(); resolve(response.statusCode!); });
    request.write('{"id":"slow","event":"test","payload":'); complete = () => request.end('{} }');
  });
  await bodyEntered.promise; const held = deferred(); const snapshot = (service as any).withMaintenanceSnapshot(() => held.promise);
  try { complete(); expect(await received).toBe(503); expect((service as any).webhooks.events(configured.subscription.id, "default")).toEqual([]); }
  finally { held.release(); await snapshot; }
});
it("defers shutdown until the snapshot finishes and then closes admission", async () => {
  const { service } = await setup(); const held = deferred();
  const snapshot = (service as any).withMaintenanceSnapshot(() => held.promise);
  service.close();
  expect((service as any).closed).toBe(false);
  await expect(service.dispatch("project.add", {})).rejects.toThrow("closing");
  held.release(); await snapshot;
  expect((service as any).closed).toBe(true);
});
it("rejects active work outside the UI list limit and rejects another Hades listener owner", async () => {
  const { service, data, destination } = await setup();
  const work = (service as any).work;
  const insert = work.db.prepare("INSERT INTO work_goals(id,profile,payload) VALUES(?,?,?)");
  insert.run("older-running-plan", "default", JSON.stringify({ id: "older-running-plan", status: "running", tasks: [] }));
  for (let i = 0; i < 201; i++) insert.run(`draft-${i}`, "default", JSON.stringify({ id: `draft-${i}`, status: "draft", tasks: [] }));
  expect(work.list("default")).toHaveLength(200);
  expect(work.list("default").some((goal: any) => goal.id === "older-running-plan")).toBe(false);
  await expect(service.dispatch("maintenance.create", { destination })).rejects.toThrow("active requests");
  work.db.exec("DELETE FROM work_goals");
  const second = new WorkbenchService(data, () => {}, { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0" }); services.push(second);
  await expect(second.dispatch("maintenance.create", { destination })).rejects.toThrow("Another Hades instance");
});
