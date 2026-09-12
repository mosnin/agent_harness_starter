import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
import { chatGuidance } from "../core/chat-guidance";
import type { ChatRequest } from "../../hades/models/client";

vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hades-chat-guidance-")), root = join(home, "project");
  mkdirSync(root);
  const events: any[] = [], requests: ChatRequest[] = [];
  const service = new WorkbenchService(join(home, "data"), e => events.push(e), { NODE_ENV: "test", HADES_BROWSER_RUNTIME: "0" });
  cleanup.push(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.dispatch("project.add", { path: root });
  await service.dispatch("profile.save", { id: "default", name: "Fixture", provider: "local", model: "fixture", baseUrl: "https://unused.invalid/v1" });
  vi.spyOn(service as any, "client").mockReturnValue({ chat: async (request: ChatRequest) => {
    requests.push(request);
    return { text: "ANSWER: Fixture response.", tokensIn: 1, tokensOut: 1, usd: 0, model: "fixture", provider: "fixture", costMeasured: false };
  } });
  const session: any = await service.dispatch("session.new", { root });
  return { service, session, events, requests };
}

it("makes coding and team capabilities available in ordinary chat without changing the saved message", async () => {
  const f = await fixture(), input = "Improve the checkout experience";
  await f.service.dispatch("chat.send", { id: f.session.id, input });
  await vi.waitFor(() => expect(f.events.some(e => e.kind === "desktop.done")).toBe(true));
  expect(f.requests[0].messages.filter(m => m.role === "user").at(-1)?.content).toBe(input);
  const system = f.requests[0].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
  expect(system).toContain("Do not direct the user to a Work or Helm tab");
  expect(system).toContain("Helm coding is available here through helm_delegate");
  expect(system).toContain("use delegate_work");
  const stored: any = await f.service.dispatch("session.get", { id: f.session.id });
  expect(stored.messages.find((m: any) => m.role === "user").content).toBe(input);
  expect(await f.service.dispatch("work.list", {})).toEqual([]);
});

it("does not advertise unavailable delegation or widen a restricted tool scope", () => {
  const guidance = chatGuidance(["file_ops"]);
  expect(guidance).not.toContain("through helm_delegate");
  expect(guidance).not.toContain("use delegate_work");
  expect(guidance).toContain("Tool permissions and budgets still apply");
});

it("starts ordinary chat without a project and isolates each conversation workspace", async () => {
  const f = await fixture();
  const first: any = await f.service.dispatch("session.new", {});
  const second: any = await f.service.dispatch("session.new", { root: "" });
  expect(first.managedWorkspace).toBe(true);
  expect(first.root).not.toBe(second.root);
  expect(statSync(first.root).isDirectory()).toBe(true);
  await f.service.dispatch("chat.send", { id: first.id, input: "Help me plan my day" });
  await vi.waitFor(() => expect(f.events.some(e => e.kind === "desktop.done" && e.session === first.id)).toBe(true));
  expect(f.requests[0].messages.filter(m => m.role === "user").at(-1)?.content).toBe("Help me plan my day");
  expect(await f.service.dispatch("session.get", { id: first.id })).toMatchObject({ root: first.root, managedWorkspace: true });
  await expect(f.service.dispatch("session.new", { root: "/" })).rejects.toThrow("Open this project first");
});

it("loads the ChatGPT model picker before saving a new provider profile", async () => {
  const f = await fixture();
  const models = vi.spyOn((f.service as any).codex, "models").mockResolvedValue(["account-model"]);
  expect(await f.service.dispatch("codex.models", {})).toEqual(["account-model"]);
  expect(models).toHaveBeenCalledOnce();
  expect((await f.service.dispatch("boot", {}) as any).profiles[0].provider).toBe("local");
});

it("previews provider models without forwarding a saved key to a draft endpoint", async () => {
  const f = await fixture();
  await f.service.dispatch("key.set", { account: "default:local", key: "fixture-only-key" });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "one" }, { id: "one" }, null, { id: "two" }, { id: 42 }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await f.service.dispatch("models.catalog", { provider: "local", baseUrl: "https://different.invalid/v1" })).toEqual(["one", "two"]);
  expect((fetcher.mock.calls as any)[0][1].headers.Authorization).toBeUndefined();
  expect((fetcher.mock.calls as any)[0][1].redirect).toBe("error");
  await f.service.dispatch("models.catalog", { provider: "local", baseUrl: "https://unused.invalid/v1" });
  expect((fetcher.mock.calls as any)[1][1].headers.Authorization).toBe("Bearer fixture-only-key");
  await expect(f.service.dispatch("models.catalog", { provider: "local", baseUrl: "http://remote.invalid" })).rejects.toThrow("Use HTTPS");
  expect(fetcher).toHaveBeenCalledTimes(2);
});


it("resolves a skill and saves a goal while preserving the typed command", async () => {
  const f = await fixture();
  await f.service.dispatch("chat.send", {id:f.session.id,input:"/goal Build a useful calendar"});
  await vi.waitFor(() => expect(f.events.some(e => e.kind === "desktop.done")).toBe(true));
  expect((await f.service.dispatch("session.get",{id:f.session.id}) as any).conversationGoal).toBe("Build a useful calendar");
  expect(f.requests[0].messages.find(m=>m.role==="user")?.content).toBe("/goal Build a useful calendar");
  await f.service.dispatch("chat.send",{id:f.session.id,input:"/skill ponytail Improve this implementation"});
  await vi.waitFor(() => expect(f.requests.length).toBe(2));
  expect(f.requests[1].messages.filter(m=>m.role==="system").map(m=>m.content).join("\n")).toContain("The ladder");
  await vi.waitFor(() => expect(f.events.filter(e => e.kind === "desktop.done").length).toBe(2));
  await expect(f.service.dispatch("chat.send",{id:f.session.id,input:"/skill absent task"})).rejects.toThrow("not installed");
  expect(f.requests).toHaveLength(2);
});

it("delegates externally once and keeps profile ownership across retries", async () => {
  const f=await fixture();
  const request={operation:"delegate",requestId:"request-one",input:"Read the project",root:f.session.root};
  const result:any=await f.service.dispatch("external.conversation",request);
  expect(result.admission).toBe("started");
  await vi.waitFor(()=>expect(f.events.some(e=>e.kind==="desktop.done"&&e.session===result.sessionId)).toBe(true));
  const again:any=await f.service.dispatch("external.conversation",request);
  expect(again.id).toBe(result.id);expect(f.requests).toHaveLength(1);
  await expect(f.service.dispatch("external.conversation",{...request,input:"Different"})).rejects.toThrow("different instructions");
  await expect(f.service.dispatch("external.conversation",{operation:"status",id:f.session.id})).rejects.toThrow("not found");
  await expect(f.service.dispatch("external.conversation",{operation:"approval.reply",id:result.id})).rejects.toThrow("Unknown");
});
