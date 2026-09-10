// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
import { mountWorkbench } from "../ui/workbench";
import { ecosystemPlugins } from "../ui/ecosystem-plugins";

let root: HTMLElement, invoke: ReturnType<typeof vi.fn>, emit: (event: any) => void;
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const profile = { id: "profile", name: "Hades", provider: "codex", model: "model", permissionMode: "ask", systemPrompt: "", shell: [], mcp: [], persona: "", baseUrl: "" };
const framework = { enabled: false, autoUpdate: false, version: "1.2.3", sha256: "b".repeat(64), revision: "a".repeat(40), integrity: "verified", package: "@mosnin/companyos", runtime: "instructions-only", schedulingEnabled: false, rollbackAvailable: false, latest: { state: "not_checked" } };
const click = (selector: string) => { const button = root.querySelector<HTMLElement>(selector)!; expect(button).toBeTruthy(); button.focus(); button.click(); };

beforeEach(async () => {
  localStorage.clear(); root = document.createElement("main"); document.body.append(root);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  invoke = vi.fn(async (name, args) => {
    const method = args?.cmd?.method;
    if (method === "boot") return { result: { profiles: [profile], activeProfile: "profile", projects: [], sessions: [], active: [], jobs: [], terminals: [] } };
    if (method === "ecosystem.list") return { result: ecosystemPlugins.map(plugin => ({ ...plugin, origin: "https://accounts.example.test", description: "Account data", status: "disconnected", collections: [], agentRead: false, agentWrite: false, scopes: [], syncMode: "manual" })) };
    if (method === "ecosystem.connect") return { result: { authorizationUrl: "https://accounts.example.test/authorize?state=opaque", requestId: "request" } };
    if (method === "companyos.status") return { result: framework };
    return { result: [] };
  });
  vi.stubGlobal("__TAURI__", { core: { invoke }, event: { listen: vi.fn(async (_name, callback) => { emit = payload => callback({ payload }); return () => {}; }) } });
  mountWorkbench(root); await settle();
});
afterEach(() => { window.dispatchEvent(new Event("beforeunload")); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("opens every account as a native sidebar route and retains the Extensions management surface", async () => {
  const dropdown = root.querySelector<HTMLDetailsElement>(".sidebar-plugins")!;
  expect(dropdown.querySelector("summary")?.textContent).toBe("Plugins");
  expect(dropdown.querySelectorAll("button")).toHaveLength(7);
  dropdown.open = true;
  for (const plugin of ecosystemPlugins) {
    click(`[data-action="ecosystem-open"][data-plugin="${plugin.id}"]`); await settle();
    expect(root.querySelector(".breadcrumb")?.textContent).toBe(plugin.name);
    expect(root.querySelector("#ecosystem-host h1")?.textContent).toBe(plugin.name);
    expect(root.querySelector(`[data-plugin="${plugin.id}"]`)?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector("iframe")).toBeNull();
  }
  click('[data-action="nav"][data-view="tools"]'); await settle();
  click('[data-action="nav"][data-view="plugins"]'); await settle();
  expect(root.querySelector(".breadcrumb")?.textContent).toBe("Extensions");
  expect(root.textContent).toContain("Install a local Hades plugin manifest");
  expect(invoke.mock.calls.some(call => call[1]?.cmd?.method === "plugins.list")).toBe(true);
});

it("uses native unlock and URL opening commands without exposing credential values", async () => {
  click('[data-plugin="stored"]'); await settle(); click("#ecosystem-connect"); await settle();
  const unlockIndex = invoke.mock.calls.findIndex(call => call[0] === "hades_ecosystem_unlock");
  const connectIndex = invoke.mock.calls.findIndex(call => call[1]?.cmd?.method === "ecosystem.connect");
  const openIndex = invoke.mock.calls.findIndex(call => call[1]?.cmd?.method === "link.open");
  expect(unlockIndex).toBeGreaterThan(-1); expect(connectIndex).toBeGreaterThan(unlockIndex); expect(openIndex).toBeGreaterThan(connectIndex);
  expect(invoke.mock.calls[openIndex][1].cmd.args).toEqual({ url: "https://accounts.example.test/authorize?state=opaque" });
  expect(root.querySelector('input[type="password"]')).toBeNull(); expect(root.textContent).not.toContain("opaque");
});

it("preserves the Plugins disclosure and focused navigation across background shell updates", async () => {
  root.querySelector<HTMLDetailsElement>(".sidebar-plugins")!.open = true;
  const summary = root.querySelector<HTMLElement>("#plugins-dropdown")!; summary.focus();
  emit({ kind: "desktop.usage", tokensIn: 1, tokensOut: 1 }); await settle();
  expect(root.querySelector<HTMLDetailsElement>(".sidebar-plugins")!.open).toBe(true);
  expect(document.activeElement?.id).toBe("plugins-dropdown");
});

it("loads Company OS in native Settings and preserves other settings drafts", async () => {
  click('[data-action="settings"]'); await settle();
  expect(root.querySelector("#company-os-settings")?.textContent).toContain("Version 1.2.3");
  expect(root.querySelector("#company-os-enabled")?.getAttribute("role")).toBe("switch");
  expect(root.querySelector("#company-os-auto-update")).toBeTruthy();
  const name = root.querySelector<HTMLInputElement>("#settings-name")!; name.value = "Draft name"; name.focus();
  const appearance = [...root.querySelectorAll<HTMLDetailsElement>(".modal details")].find(item => item.querySelector("summary")?.textContent === "Appearance & preferences")!;
  appearance.open = true;
  root.querySelector<HTMLDetailsElement>("#company-os-settings details")!.open = true;
  emit({ kind: "desktop.usage", tokensIn: 2, tokensOut: 2 }); await settle();
  expect(root.querySelector<HTMLInputElement>("#settings-name")!.value).toBe("Draft name");
  expect(document.activeElement?.id).toBe("settings-name");
  expect([...root.querySelectorAll<HTMLDetailsElement>(".modal details")].find(item => item.querySelector("summary")?.textContent === "Appearance & preferences")!.open).toBe(true);
  expect(root.querySelector<HTMLDetailsElement>("#company-os-settings details")!.open).toBe(true);
});
