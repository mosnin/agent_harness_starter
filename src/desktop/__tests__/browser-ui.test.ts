// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { BrowserView } from "../ui/browser";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
describe("browser pairing UI", () => {
  it("pairs only after Keychain admission and never sends a token through browser RPC", async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (method: string) => { calls.push(method); return method === "browser.status" ? {} : true; });
    const keychain = vi.fn(async () => { calls.push("keychain"); return true; });
    const host = document.createElement("div"), view = new BrowserView(rpc, keychain);
    view.mount(host); await view.open({ profile: "qa", root: "/tmp/qa", name: "QA" });
    for (const [id, value] of [["browser-endpoint", "ws://127.0.0.1:5000"], ["browser-token", "test-pairing-secret"]]) {
      const input = host.querySelector<HTMLInputElement>("#" + id)!; input.value = value; input.dispatchEvent(new Event("input"));
    }
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(keychain).toHaveBeenCalledWith("hades-browser", "test-pairing-secret");
    expect(calls.indexOf("keychain")).toBeLessThan(calls.indexOf("browser.connect"));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("test-pairing-secret");
    expect(host.querySelector<HTMLInputElement>("#browser-token")!.value).toBe("");
    expect(rpc).toHaveBeenCalledWith("browser.configure", { endpoint: "ws://127.0.0.1:5000", enabled: true, profile: "qa", root: "/tmp/qa" });
  });
  it("does not connect when the saved token is absent", async () => {
    const rpc = vi.fn(async (_method: string) => ({})), keychain = vi.fn(async () => false);
    const host = document.createElement("div"), view = new BrowserView(rpc, keychain);
    view.mount(host); await view.open({ profile: "qa", root: "/tmp/qa", name: "QA" });
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(rpc.mock.calls.some(([m]) => m === "browser.connect")).toBe(false);
    expect(host.textContent).toContain("Paste the pairing token");
  });
});
