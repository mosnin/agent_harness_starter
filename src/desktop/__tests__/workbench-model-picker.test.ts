// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
import { mountWorkbench } from "../ui/workbench";
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
afterEach(() => { window.dispatchEvent(new Event("beforeunload")); document.body.replaceChildren(); vi.unstubAllGlobals(); localStorage.clear(); });
async function fixture() {
  localStorage.clear();
  const profile = { id: "p", name: "Hades", provider: "local", model: "old-model", baseUrl: "https://provider.invalid/v1", persona: "", shell: [], mcp: [] };
  const session = { id: "s", profile: "p", root: "/conversation", managedWorkspace: true, messages: [] };
  const calls: Array<{ method: string; args: any }> = [];
  let fail = false;
  const invoke = vi.fn(async (_command, params) => {
    const method = params?.cmd?.method, args = params?.cmd?.args; calls.push({ method, args });
    let result: any = [];
    if (method === "boot") result = { profiles: [profile], activeProfile: "p", projects: [], sessions: [], active: [], jobs: [], terminals: [] };
    if (method === "session.new" || method === "session.get") result = session;
    if (method === "codex.status") result = { connected: false };
    if (["models.list", "models.catalog", "codex.models"].includes(method)) {
      if (fail) return { error: "Provider temporarily unavailable" };
      result = ["available-a", "available-b"];
    }
    return { result };
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("__TAURI__", { core: { invoke }, event: { listen: async () => () => {} } });
  const host = document.createElement("div"); document.body.append(host); mountWorkbench(host); await settle();
  const click = async (selector: string) => { const element = host.querySelector<HTMLElement>(selector); expect(element).toBeTruthy(); element!.click(); await settle(); };
  return { host, calls, click, failCatalog: () => { fail = true; } };
}

it("uses provider-backed dropdowns in settings and chat and saves the selected model", async () => {
  const f = await fixture();
  await f.click('[data-action="settings"]');
  // happy-dom 20 misreads selected attributes; Chromium separately checks initial selection.
  f.host.querySelector<HTMLSelectElement>("#settings-provider")!.value = "local";
  await f.click('[data-action="settings-model-catalog"]');
  expect(f.host.querySelector("input#settings-model")).toBeNull();
  expect(f.host.querySelector("select#settings-model")?.textContent).toContain("available-b");
  expect(f.host.querySelector("select#settings-model")?.textContent).toContain("old-model — unavailable");
  expect(f.calls.filter(c => c.method === "models.catalog").at(-1)?.args, f.host.querySelector("#settings-provider")?.outerHTML).toMatchObject({ provider: "local", baseUrl: "https://provider.invalid/v1", profile: "p" });
  await f.click('[data-action="modal-close"]');
  await f.click('[data-action="model"]');
  const select = f.host.querySelector<HTMLSelectElement>("select#session-model")!;
  expect(select).toBeTruthy(); expect(f.host.querySelector("input#session-model")).toBeNull();
  select.value = "available-b";
  await f.click('[data-action="model-save"]');
  expect(f.calls.find(c => c.method === "session.new")?.args).not.toHaveProperty("root");
  expect(f.calls.find(c => c.method === "session.update")?.args.model).toBe("available-b");
});

it("keeps a dropdown and retry action when catalog loading fails", async () => {
  const f = await fixture(); f.failCatalog();
  await f.click('[data-action="model"]');
  expect(f.host.querySelector("#model-catalog")?.textContent).toContain("Catalog unavailable");
  expect(f.host.querySelector("select#session-model")).toBeTruthy();
  expect(f.host.querySelector("input#session-model")).toBeNull();
  expect(f.host.querySelector('[data-action="model-catalog"]')).toBeTruthy();
});
