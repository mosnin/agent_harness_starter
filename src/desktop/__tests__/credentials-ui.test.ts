// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { CredentialsView } from "../ui/credentials";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
describe("native credential management", () => {
  it("saves the secret only through Keychain before enabling metadata", async () => {
    const calls: string[] = [], keychain = vi.fn(async () => { calls.push("keychain"); });
    const rpc = vi.fn(async (method: string) => { calls.push(method); return method === "credential.add" ? { id: "one", account: "pool:p:openrouter:one" } : []; });
    const host = document.createElement("div"); document.body.append(host);
    const view = new CredentialsView(rpc, keychain); view.mount(host); await view.open("p");
    host.querySelector<HTMLButtonElement>('[data-credential="add"]')!.click();
    for (const [name, value] of [["label", "Primary"], ["key", "test-only-secret"]]) { const field = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!; field.value = value; field.dispatchEvent(new Event("input")); }
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(keychain).toHaveBeenCalledWith("pool:p:openrouter:one", "test-only-secret");
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("test-only-secret");
    expect(calls.indexOf("keychain")).toBeLessThan(calls.indexOf("credential.update"));
    expect(host.innerHTML).not.toContain("test-only-secret"); host.remove();
  });
  it("does not enable a key when Keychain rejects the save", async () => {
    const rpc = vi.fn(async (method: string) => method === "credential.add" ? { id: "one", account: "pool:p:openrouter:one" } : []);
    const host = document.createElement("div"), view = new CredentialsView(rpc, async () => { throw new Error("Keychain unavailable"); }); view.mount(host); await view.open("p");
    host.querySelector<HTMLButtonElement>('[data-credential="add"]')!.click();
    for (const name of ["label", "key"]) { const field = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!; field.value = "test-secret"; field.dispatchEvent(new Event("input")); }
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(rpc.mock.calls.some(([method]) => method === "credential.update")).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[name="key"]')!.value).toBe("");
    expect(host.textContent).toContain("Keychain unavailable");
  });
});
