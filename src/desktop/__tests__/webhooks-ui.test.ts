// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksView } from "../ui/webhooks";
let host: HTMLElement, view: WebhooksView, rows: any[];
let rpc = vi.fn<(method: string, args?: any) => Promise<any>>();
let open = vi.fn<(id: string) => void>();
const context = { profile: "p", root: "/project", profiles: [{ id: "p", name: "Hades" }], projects: ["/project"] };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function click(action: string) { host.querySelector<HTMLButtonElement>(`[data-webhook="${action}"]`)!.click(); }
function fill(name: string, value: string) { const field = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!; field.value = value; field.dispatchEvent(new Event("input")); }
beforeEach(async () => {
  document.body.innerHTML = "<main></main>"; host = document.querySelector("main")!; rows = []; open = vi.fn();
  rpc = vi.fn(async (method, args) => {
    if (method === "webhook.status") return { running: true, baseUrl: "http://127.0.0.1:48847" };
    if (method === "webhook.list") return structuredClone(rows);
    if (method === "webhook.create") { const subscription = { ...args, id: "w", url: "http://127.0.0.1:48847/webhooks/w" }; rows.push(subscription); return { subscription, token: "one-time-secret" }; }
    if (method === "webhook.events") return [{ event: "build.finished", eventId: "e1", status: "completed", session: "s", at: Date.now() }];
    return {};
  });
  view = new WebhooksView(rpc, id => open(id)); await view.open(context); view.mount(host);
});
describe("native webhook configuration", () => {
  it("saves a structured subscription, shows its token once, and never embeds it in the endpoint", async () => {
    click("new"); fill("name", "Build report"); fill("prompt", "Summarize results"); fill("events", "build.finished\nreport.requested");
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(rpc).toHaveBeenCalledWith("webhook.create", { name: "Build report", root: "/project", profile: "p", prompt: "Summarize results", events: ["build.finished", "report.requested"], enabled: true });
    expect(host.querySelector<HTMLInputElement>('[name="issuedToken"]')?.value).toBe("one-time-secret");
    expect(host.querySelector(".webhook-url")?.textContent).not.toContain("one-time-secret");
    click("dismiss-token"); await view.refresh(); expect(host.querySelector('[name="issuedToken"]')).toBeNull();
    click("events"); await settle(); click("session"); expect(open).toHaveBeenCalledWith("s");
  });
  it("preserves the form draft and focus while status events arrive", async () => {
    click("new"); fill("prompt", "Keep this draft"); const field = host.querySelector<HTMLTextAreaElement>('[name="prompt"]')!; field.focus(); field.setSelectionRange(2, 5);
    await view.refresh(); const restored = host.querySelector<HTMLTextAreaElement>('[name="prompt"]')!;
    expect(restored.value).toBe("Keep this draft"); expect(document.activeElement).toBe(restored); expect(restored.selectionStart).toBe(2);
  });
  it("uses scoped enable, disable and removal APIs without transmitting an external event", async () => {
    rows.push({ id: "w", profile: "p", name: "Build", events: ["build.finished"], enabled: true, url: "http://127.0.0.1:48847/webhooks/w" });
    await view.refresh(); click("toggle"); await settle(); expect(rpc).toHaveBeenCalledWith("webhook.update", { id: "w", profile: "p", enabled: false });
    click("remove"); await settle(); expect(rpc).toHaveBeenCalledWith("webhook.remove", { id: "w", profile: "p" });
    expect(rpc.mock.calls.every(call => !call[0].includes("execute"))).toBe(true);
  });
});
