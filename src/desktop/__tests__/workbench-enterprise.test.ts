import { expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchService, type WorkbenchEvent } from "../core/workbench-service";
vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hades-enterprise-workbench-"));
  const root = join(home, "project"); mkdirSync(root);
  const events: WorkbenchEvent[] = [];
  const service = new WorkbenchService(join(home, "data"), event => events.push(event), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0", HADES_HELM_ORCA_ARTIFACTS: join(home, "missing-runtime") });
  return { root, home, events, service, async close() { await service.close(); rmSync(home, { recursive: true, force: true }); } };
}

it("does not advertise or allocate an Orca worker when the packaged engine is absent", async () => {
  const f = fixture();
  try {
    await f.service.dispatch("project.add", {path: f.root});
    expect(await f.service.dispatch("helm.orca.info", {root:f.root})).toMatchObject({state:"missing"});
    await expect(f.service.dispatch("helm.orca.start", {root:f.root,requestId:crypto.randomUUID(),prompt:"Build an output",agent:"codex"})).rejects.toThrow("not included");
    expect(await f.service.dispatch("helm.orca.list", {root:f.root})).toEqual([]);
    await expect(f.service.dispatch("helm.orca.list", {root:f.home})).rejects.toThrow();
  } finally { await f.close(); }
});

it("keeps a completed file result while blocking post-tool effects after authority revocation", async () => {
  const f = fixture();
  try {
    await f.service.dispatch("project.add", {path:f.root});
    await f.service.dispatch("profile.save", {id:"default",name:"Deterministic fixture",provider:"local",model:"fixture",baseUrl:"https://unused.invalid/v1"});
    let calls = 0, authorized = true;
    // In-process deterministic model fixture, deliberately no HTTP or provider.
    vi.spyOn(f.service as any, "client").mockReturnValue({ chat: async () => ({ text: ++calls === 1 ? 'TOOL: file_ops\nINPUT: {"op":"write","path":"result.txt","content":"completed once"}' : "ANSWER: Inspected the result.", tokensIn:10,tokensOut:10,usd:0,model:"fixture",provider:"fixture",costMeasured:false }) });
    const session = await f.service.dispatch("session.new", {root:f.root}) as {id:string};
    (f.service as any).effectGuards.set(session.id, () => {if (!authorized) throw new Error("Fixture lease revoked");});
    const hookPath = join(f.root, "post.sh"); writeFileSync(hookPath, "#!/bin/sh\ntouch forbidden-post\n", {mode:0o700});
    const hook = await f.service.dispatch("hook.save", {name:"post",phase:"post_tool",root:f.root,profile:"default",executable:hookPath,matcher:"file_ops",timeoutSeconds:3}) as {id:string};
    await f.service.dispatch("hook.consent", {id:hook.id,profile:"default",approved:true});
    const checkpoints = (f.service as any).checkpoints, finish = checkpoints.finish.bind(checkpoints);
    vi.spyOn(checkpoints,"finish").mockImplementation((...args:any[]) => {finish(...args);authorized=false;});
    await f.service.dispatch("chat.send", {id:session.id,input:"Write the output once."});
    await vi.waitFor(() => expect(f.events.some(event => event.kind === "desktop.approval")).toBe(true));
    await f.service.dispatch("approval.reply", {id:f.events.find(event => event.kind === "desktop.approval")!.id,allow:true});
    await vi.waitFor(() => expect(f.events.some(event => event.kind === "desktop.done")).toBe(true));
    expect(readFileSync(join(f.root,"result.txt"),"utf8")).toBe("completed once");
    expect(existsSync(join(f.root,"forbidden-post"))).toBe(false);
    expect(f.events.find(event => event.kind === "desktop.tool" && event.status === "done")).toMatchObject({ok:true});
    expect(f.events.find(event => event.kind === "desktop.hook" && event.phase === "post_tool")).toMatchObject({status:"cancelled",ok:false});
  } finally { await f.close(); }
});
