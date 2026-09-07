import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchService, type WorkbenchEvent } from "../core/workbench-service";

// Real loopback HTTP ingress, SSE transport, Hades tools and journal. The model
// responses below are deterministic fixtures; this is not model-quality proof.
const roots: string[] = [], services: WorkbenchService[] = [], servers: Server[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  servers.splice(0).forEach(server => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => setTimeout(resolve, 20));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("Timed out waiting for webhook integration"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-webhook-workbench-")); roots.push(root);
  const project = join(root, "project"), data = join(root, "data"); mkdirSync(project); writeFileSync(join(project, "sentinel.txt"), "KEEP");
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => body += chunk);
    request.on("end", () => {
      const parsed = JSON.parse(body); requests.push(parsed);
      const last = parsed.messages.at(-1).content;
      const answer = /^TOOL_(RESULT|ERROR):/.test(last)
        ? last.startsWith("TOOL_ERROR:") ? "ANSWER: The requested write was denied; the file is unchanged." : "ANSWER: The approved write finished."
        : 'TOOL: file_ops\nINPUT: {"op":"write","path":"sentinel.txt","content":"CHANGED"}';
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 9) } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(9) } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const events: WorkbenchEvent[] = [];
  const create = () => { const service = new WorkbenchService(data, event => events.push(event), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0" }); services.push(service); return service; };
  const service = create();
  await service.dispatch("project.add", { path: project });
  await service.dispatch("profile.save", { id: "default", name: "Webhook fixture", provider: "local", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
  const listener = await service.dispatch("webhook.status", {}) as any;
  expect(listener.running).toBe(true);
  const created = await service.dispatch("webhook.create", { name: "Write sentinel", root: project, profile: "default", prompt: "Write CHANGED to sentinel.txt, with ordinary approval.", events: ["fixture.requested"] }) as any;
  const payload = { id: "delivery-1", event: "fixture.requested", payload: { note: "External event data" } };
  const send = async (url = created.subscription.url) => {
    const result = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + created.token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { status: result.status, body: await result.json() as any };
  };
  const history = async (instance: WorkbenchService) => await instance.dispatch("webhook.events", { id: created.subscription.id, profile: "default" }) as any[];
  return { service, create, created, project, events, requests, send, history };
}
describe("webhook ingress through the real native workbench runner", () => {
  it.each([true, false])("preserves file approval allow=%s, journal and durable delivery identity after restart", async allow => {
    const { service, create, created, project, events, requests, send, history } = await setup();
    const accepted = await send(); expect(accepted.status).toBe(202);
    await until(() => events.some(event => event.kind === "desktop.approval"));
    const approval = events.find(event => event.kind === "desktop.approval")!;
    expect(approval.tool).toBe("file_ops"); expect(readFileSync(join(project, "sentinel.txt"), "utf8")).toBe("KEEP");
    expect((await history(service))[0].status).toBe("running");
    expect(JSON.stringify(requests[0])).toContain("untrusted data");
    await service.dispatch("approval.reply", { id: approval.id, allow });
    await until(async () => ["completed", "failed"].includes((await history(service))[0].status));
    const receipt = (await history(service))[0];
    // Completed means the turn returned; the journal separately preserves a
    // denied tool and the assistant explains that no write occurred.
    expect(receipt.status).toBe("completed");
    expect(receipt.session).toBe(approval.session);
    expect(readFileSync(join(project, "sentinel.txt"), "utf8")).toBe(allow ? "CHANGED" : "KEEP");
    const current = await service.dispatch("session.get", { id: receipt.session, profile: "default" }) as any;
    expect(current.sourceId).toBe(`webhook:${created.subscription.id}:${accepted.body.id}`);
    expect(current.source).toBe("webhook");
    expect(current.progress.tools.some((tool: any) => tool.status === "done" && tool.ok === allow)).toBe(true);
    expect(current.messages.at(-1).content).toContain(allow ? "approved write finished" : "write was denied");
    const before = requests.length; service.close();
    const reopened = create(); await reopened.dispatch("webhook.status", {});
    const restored = await reopened.dispatch("session.get", { id: receipt.session, profile: "default" }) as any;
    expect(restored.progress.tools.some((tool: any) => tool.status === "done" && tool.ok === allow)).toBe(true);
    expect(restored.progress.approval).toBeUndefined();
    const subscription = (await reopened.dispatch("webhook.list", { profile: "default" }) as any[])[0];
    const duplicate = await send(subscription.url);
    expect(duplicate).toMatchObject({ status: 200, body: { id: accepted.body.id, duplicate: true, status: receipt.status } });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(requests).toHaveLength(before);
    expect(readFileSync(join(project, "sentinel.txt"), "utf8")).toBe(allow ? "CHANGED" : "KEEP");
  });
  it("records interruption while approval is pending and never replays the request after restart", async () => {
    const { service, create, project, events, requests, send, history } = await setup();
    const accepted = await send(); await until(() => events.some(event => event.kind === "desktop.approval"));
    const approval = events.find(event => event.kind === "desktop.approval")!;
    service.close(); await new Promise(resolve => setTimeout(resolve, 30));
    const reopened = create(); await reopened.dispatch("webhook.status", {});
    const restored = await reopened.dispatch("session.get", { id: approval.session, profile: "default" }) as any;
    expect(restored.progress.approval).toBeUndefined();
    const subscription = (await reopened.dispatch("webhook.list", { profile: "default" }) as any[])[0];
    expect((await send(subscription.url)).body).toMatchObject({ id: accepted.body.id, duplicate: true, status: "interrupted" });
    expect((await history(reopened))[0].status).toBe("interrupted");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests).toHaveLength(1); expect(readFileSync(join(project, "sentinel.txt"), "utf8")).toBe("KEEP");
  });
});
