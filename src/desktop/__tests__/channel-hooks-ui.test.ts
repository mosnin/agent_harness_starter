// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ChannelsView } from "../ui/channels";
import { ShellHooksView } from "../ui/shell-hooks";
const context = { profile: "default", root: "/project", profiles: [{ id: "default", name: "Default" }], projects: ["/project"] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe("Native channel and hook management", () => {
  it("shows actual supported channels and approves only a displayed pending identity", async () => {
    const rpc = vi.fn(async (method: string) => method === "slack.status" ? { connection: "Disconnected" } : method === "channel.access.list" ? [{ id: "r1", account: "T1", channel: "C1", user: "U2", status: "pending", expiresAt: Date.now() + 10000 }] : {});
    const view = new ChannelsView(rpc, vi.fn()), host = document.createElement("div"); document.body.append(host); view.mount(host); await view.open(context);
    expect(host.textContent).toContain("Slack"); expect(host.textContent).toContain("Hades team chat"); expect(host.textContent).not.toContain("Telegram");
    host.querySelector<HTMLButtonElement>('[data-channel="approve"]')!.click(); await tick();
    expect(rpc).toHaveBeenCalledWith("channel.access.approve", { id: "r1", profile: "default" }); expect(host.textContent).toContain("fresh message"); host.remove();
  });
  it("requires the review checkbox before hook consent and never displays saved consent hashes", async () => {
    const rpc = vi.fn(async (method: string) => method === "hook.list" ? [{ id: "h1", name: "Check", status: "inactive", phase: "pre_tool", executable: "/project/check.sh", root: "/project", args: [], timeoutSeconds: 10 }] : {});
    const view = new ShellHooksView(rpc), host = document.createElement("div"); document.body.append(host); view.mount(host); await view.open(context);
    host.querySelector<HTMLButtonElement>('[data-hook="review"]')!.click(); const approve = host.querySelector<HTMLButtonElement>('[data-hook="approve"]')!; expect(approve.disabled).toBe(true); approve.click(); expect(rpc).not.toHaveBeenCalledWith("hook.consent", expect.anything());
    const check = host.querySelector<HTMLInputElement>("[data-consent-check]")!; check.checked = true; check.dispatchEvent(new Event("change")); expect(approve.disabled).toBe(false); approve.click(); await tick();
    expect(rpc).toHaveBeenCalledWith("hook.consent", { id: "h1", profile: "default", approved: true }); host.remove();
  });
  it("preserves a hook draft and focused input while refreshing status", async () => {
    const rpc = vi.fn(async () => []), view = new ShellHooksView(rpc), host = document.createElement("div"); document.body.append(host); view.mount(host); await view.open(context); host.querySelector<HTMLButtonElement>('[data-hook="new"]')!.click();
    const input = host.querySelector<HTMLInputElement>('[name="name"]')!; input.value = "My hook"; input.dispatchEvent(new Event("input")); input.focus(); await view.refresh(); expect(host.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe("My hook"); expect((document.activeElement as HTMLInputElement).name).toBe("name"); host.remove();
  });
});
