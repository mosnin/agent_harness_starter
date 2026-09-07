// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFocus, restoreFocus, dialogFocusable } from "../ui/focus";
const terminal = vi.hoisted(() => ({ focus: vi.fn(), options: {}, loadAddon: vi.fn(), open: vi.fn(), onData: vi.fn(), onResize: vi.fn(), attachCustomKeyEventHandler: vi.fn(), write: vi.fn(), dispose: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class { constructor() { return terminal; } } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
import { mountWorkbench } from "../ui/workbench";
let root: HTMLDivElement;
let emit: (event: any) => void;
const profile = { id: "p", name: "Hades", provider: "codex", model: "model", permissionMode: "ask", systemPrompt: "", shell: [], mcp: [], persona: "", baseUrl: "" };
const boot = { profiles: [profile], activeProfile: "p", projects: ["/project"], sessions: [], active: [], jobs: [], terminals: [{ id: "t", root: "/project", output: "" }] };
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function click(selector: string) { const element = root.querySelector<HTMLElement>(selector)!; expect(element).toBeTruthy(); element.focus(); element.click(); }
function key(key: string, options: KeyboardEventInit = {}) { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options })); }
async function mount(compact = false) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: compact && query.includes("800px"), addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("__TAURI__", {
    core: { invoke: vi.fn(async (_method: string, args: any) => {
      const method = args?.cmd?.method;
      if (method === "boot") return { result: structuredClone(boot) };
      if (method === "codex.status") return { result: { connected: false } };
      if (method === "files.list") return { result: [{ name: "a.txt", path: "a.txt" }, { name: "b.txt", path: "b.txt" }] };
      if (method === "files.read") return { result: { path: args.cmd.args.path, text: args.cmd.args.path, revision: "v1" } };
      if (method === "git.status") return { result: { status: "clean", diff: "" } };
      if (method === "terminal.open") return { result: { id: "t", root: "/project", output: "" } };
      return { result: [] };
    }) },
    event: { listen: vi.fn(async (_name, callback) => { emit = (payload: any) => callback({ payload }); return () => {}; }) },
  });
  mountWorkbench(root); await settle();
  expect(root.querySelector("#composer")).toBeTruthy();
}
beforeEach(() => { root = document.createElement("div"); document.body.append(root); localStorage.clear(); terminal.focus.mockClear(); });
afterEach(() => { window.dispatchEvent(new Event("beforeunload")); document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe("workbench interaction experience", () => {
  it("focuses a dialog, excludes disabled and closed sections from Tab order, blocks background shortcuts, and returns focus", async () => {
    await mount(); click('[data-action="settings"]'); await settle();
    const dialog = root.querySelector<HTMLElement>(".modal")!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(root.querySelector<HTMLElement>(".workbench")!.inert).toBe(true);
    const candidates = dialogFocusable(dialog);
    expect(candidates.every(el => !el.matches(":disabled"))).toBe(true);
    candidates[0].focus(); key("Tab", { shiftKey: true }); expect(document.activeElement).toBe(candidates.at(-1));
    key("Tab"); expect(document.activeElement).toBe(candidates[0]);
    key("b", { metaKey: true }); expect(root.querySelector(".hide-sidebar")).toBeNull();
    key("Escape"); expect(root.querySelector(".modal")).toBeNull();
    expect(document.activeElement?.getAttribute("data-action")).toBe("settings");
    expect(root.querySelector<HTMLElement>(".workbench")!.inert).toBe(false);
  });
  it("preserves typed inspector drafts and selected text across background events", async () => {
    await mount(); click('[data-action="git"]'); await settle();
    const input = root.querySelector<HTMLInputElement>("#commit-message")!;
    input.value = "Explain the change"; input.focus(); input.setSelectionRange(2, 8, "backward");
    emit({ kind: "desktop.usage", tokensIn: 2, tokensOut: 3 });
    const restored = root.querySelector<HTMLInputElement>("#commit-message")!;
    expect(restored.value).toBe("Explain the change"); expect(document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd, restored.selectionDirection]).toEqual([2, 8, "backward"]);
  });
  it("does not let a terminal pane take focus from the composer or a dialog during background updates", async () => {
    await mount(); click('[data-action="terminal"]'); await settle(); expect(root.querySelector("#terminal-host")).toBeTruthy();
    const composer = root.querySelector<HTMLTextAreaElement>("#composer")!; composer.focus();
    terminal.focus.mockClear(); emit({ kind: "desktop.usage", tokensIn: 1, tokensOut: 1 });
    expect(document.activeElement?.id).toBe("composer"); expect(terminal.focus).not.toHaveBeenCalled();
    click('[data-action="settings"]'); await settle();
    terminal.focus.mockClear(); emit({ kind: "desktop.usage", tokensIn: 2, tokensOut: 2 });
    expect(root.querySelector(".modal")!.contains(document.activeElement)).toBe(true); expect(terminal.focus).not.toHaveBeenCalled();
  });
  it("keeps More expanded and sidebar scroll stable across updates", async () => {
    await mount(); const more = root.querySelector<HTMLDetailsElement>(".sidebar-more")!; more.open = true;
    root.querySelector(".sidebar-content")!.scrollTop = 175;
    emit({ kind: "desktop.usage", tokensIn: 1, tokensOut: 1 });
    expect(root.querySelector<HTMLDetailsElement>(".sidebar-more")!.open).toBe(true);
    expect(root.querySelector(".sidebar-content")!.scrollTop).toBe(175);
  });
  it("offers a working compact sidebar toggle and closes navigation after selecting a page", async () => {
    await mount(true); expect(root.querySelector(".hide-sidebar")).toBeTruthy();
    click("#toggle-sidebar"); expect(root.querySelector(".hide-sidebar")).toBeNull();
    expect(root.querySelector("#toggle-sidebar")?.getAttribute("aria-expanded")).toBe("true");
    click('[data-view="agents"]'); await settle(); expect(root.querySelector(".hide-sidebar")).toBeTruthy();
    click("#toggle-sidebar"); key("Escape"); expect(root.querySelector(".hide-sidebar")).toBeTruthy();
    expect(document.activeElement?.id).toBe("toggle-sidebar");
  });
});
describe("focus helpers", () => {
  it("skips hidden, disabled, and closed detail descendants while retaining disclosure controls", () => {
    root.innerHTML = '<button disabled>Disabled</button><div hidden><input></div><details><summary>Advanced</summary><input id="closed"></details><details open><summary>Open</summary><input id="open"></details><button id="last">Last</button>';
    expect(dialogFocusable(root).map(e => e.id || e.tagName)).toEqual(["SUMMARY", "SUMMARY", "open", "last"]);
  });
  it("restores a persistent editor node without needing an element id", () => {
    const editor = document.createElement("textarea"); root.append(editor); editor.value = "Draft"; editor.focus(); editor.setSelectionRange(1, 4);
    const focus = captureFocus(root); root.replaceChildren(); root.append(editor);
    expect(restoreFocus(root, focus)).toBe(true); expect(editor.selectionEnd).toBe(4);
  });
});

describe("inspector file ownership", () => {
  it("does not transfer a file draft to a different preview", async () => {
    await mount(); click('[data-action="files"]'); await settle();
    click('[data-action="file"][data-path="a.txt"]'); await settle();
    const text = root.querySelector<HTMLTextAreaElement>("#file-content")!; text.value = "unsaved A";
    emit({ kind: "desktop.usage", tokensIn: 1, tokensOut: 1 });
    expect(root.querySelector<HTMLTextAreaElement>("#file-content")!.value).toBe("unsaved A");
    click('[data-action="file"][data-path="b.txt"]'); await settle();
    expect(root.querySelector<HTMLTextAreaElement>("#file-content")!.value).toBe("b.txt");
  });
});
