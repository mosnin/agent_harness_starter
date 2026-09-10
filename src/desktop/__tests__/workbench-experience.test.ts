// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFocus, restoreFocus, dialogFocusable } from "../ui/focus";
const terminal = vi.hoisted(() => ({ focus: vi.fn(), options: {}, loadAddon: vi.fn(), open: vi.fn(), onData: vi.fn(), onResize: vi.fn(), onRender: vi.fn(() => ({ dispose() {} })), onWriteParsed: vi.fn(() => ({ dispose() {} })), refresh: vi.fn(), attachCustomKeyEventHandler: vi.fn(), write: vi.fn(), dispose: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class { constructor() { return terminal; } } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
import { mountWorkbench } from "../ui/workbench";
let root: HTMLDivElement;
let emit: (event: any) => void;
let restoredSession: any;
let restoredArtifacts: any[] = [];
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
      if (method === "project.add") return { result: args.cmd.args.path };
      if (method === "codex.status") return { result: { connected: false } };
      if (method === "session.get") return { result: structuredClone(restoredSession) };
      if (method === "artifacts.list") return { result: structuredClone(restoredArtifacts) };
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
beforeEach(() => { root = document.createElement("div"); document.body.append(root); localStorage.clear(); terminal.focus.mockClear(); restoredSession = undefined; restoredArtifacts = []; });
afterEach(() => { window.dispatchEvent(new Event("beforeunload")); document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe("workbench interaction experience", () => {
  it("opens the exact Work review in Helm, invalidates acceptance on Work events, and returns to the task", async () => {
    await mount();
    const goal = { id: "work-goal", root: "/project", profile: "p", objective: "Review delivery", status: "needs_review", maxTokens: 30000, maxMinutes: 10, tasks: [{ id: "work-task", title: "Reviewed parser", profile: "p", status: "failed", engine: { kind: "orca", agent: "codex", requestId: "intent", dispatchIntent: true }, attempts: [{ id: "attempt", number: 1, status: "failed", startedAt: 1 }], dependsOn: [] }] };
    const run = { id: "imported-run", root: "/project", owner: "p", workspace: "/review", agent: "codex", title: "Reviewed parser", prompt: "Inspect parser", status: "verified", updatedAt: 1, maxMinutes: 5, output: "", exclusions: [], orcaOrigin: { intentId: "intent", runId: "worker-run", dispatchId: "dispatch", revision: "snapshot" }, workOrigin: { goalId: goal.id, taskId: "work-task", ownerProfile: "p", taskProfile: "p", requestId: "intent", attemptId: "attempt" } };
    const review = { id: "review", runId: run.id, root: "/project", status: "applied", patch: "full patch", files: ["result.md"], sourceRevision: "before", revision: "snapshot" };
    const source = { id: "check", reviewId: "review", runId: run.id, root: "/project", status: "passed", after: "source", checks: [], results: [], maxSeconds: 30 };
    let eligible = true;
    const invoke = (globalThis as any).__TAURI__.core.invoke, original = invoke.getMockImplementation();
    invoke.mockImplementation(async (nativeMethod: string, args: any) => {
      const method = args?.cmd?.method;
      if (method === "work.list") return { result: [goal] };
      if (method === "work.get") return { result: goal };
      if (method === "work.orca.import") return { result: { goal, run } };
      if (method === "helm.get") return { result: run };
      if (method === "helm.integration.list") return { result: [review] };
      if (method === "helm.source.list") return { result: [source] };
      if (method === "helm.diff") return { result: { text: "full patch", files: ["result.md"], stale: false, truncated: false } };
      if (method === "work.orca.acceptance") return { result: { eligible, reasons: eligible ? [] : ["New instructions invalidate the previous result"], goalId: goal.id, taskId: "work-task", runId: run.id, reviewId: "review", sourceCheckId: "check", evidence: [] } };
      return original(nativeMethod, args);
    });
    click('[data-action="nav"][data-view="work"]'); await settle();
    click('[data-work="open"]'); await settle(); click('[data-work="orca-review"]');
    await vi.waitFor(() => expect(root.querySelector('[data-helm="work-accept"]')).toBeTruthy());
    expect(root.querySelector("#helm-selected-heading")?.textContent).toBe("Reviewed parser");
    const methodCalls = (method: string) => invoke.mock.calls.filter(([, args]: any[]) => args?.cmd?.method === method);
    expect(methodCalls("work.orca.import")[0][1].cmd.args).toEqual({ id: goal.id, task: "work-task", profile: "p" });
    const before = methodCalls("work.orca.acceptance").length;
    emit({ kind: "desktop.work", profile: "other" }); await settle(); expect(methodCalls("work.orca.acceptance")).toHaveLength(before);
    eligible = false; emit({ kind: "desktop.work", profile: "p" });
    expect(root.querySelector('[data-helm="work-accept"]')).toBeNull(); await settle();
    expect(root.querySelector(".helm-work-acceptance")?.textContent).toContain("New instructions invalidate");
    click('[data-helm="work-open"]'); await vi.waitFor(() => expect(root.querySelector('[data-work-task="work-task"]')).toBeTruthy()); await settle();
    expect((document.activeElement as HTMLElement)?.dataset.workTask).toBe("work-task");
    for (const method of ["helm.code.open", "helm.orca.start", "work.orca.accept", "work.resume"]) expect(methodCalls(method)).toHaveLength(0);
  });
  it("opens all new native management pages from Tools and connections", async () => {
    await mount();
    for (const [route, heading] of [["credentials", "Credentials"], ["channels", "Channels"], ["hooks", "Hooks"], ["maintenance", "Maintenance"]]) {
      click('[data-action="nav"][data-view="tools"]'); await settle();
      click(`[data-action="nav"][data-view="${route}"]`); await settle();
      expect(root.querySelector(".breadcrumb")?.textContent).toContain(heading);
      expect(root.querySelector(`#${route}-host`)?.textContent).toContain(heading);
      expect(root.querySelector('[role="alert"]')).toBeNull();
    }
  });

  it("renders a restored execution journal as completed tool calls with input and result", async () => {
    const journal = ["a", "b", "c"].flatMap(path => [{ kind: "desktop.tool", tool: "file_ops", status: "running", input: JSON.stringify({ op: "read", path }) }, { kind: "desktop.tool", tool: "file_ops", status: "done", ok: true, input: JSON.stringify({ op: "read", path }), output: "Contents " + path }]);
    restoredSession = { id: "saved", title: "Saved task", root: "/project", messages: [], progress: { journal: [{ kind: "desktop.started" }, ...journal, { kind: "desktop.done" }], tools: journal } };
    (boot.sessions as any[]).push({ id: "saved", title: "Saved task", profile: "p" });
    localStorage.setItem("hades.lastSession", "saved");
    try {
      await mount(); await settle();
      expect(root.querySelector(".activity summary")?.textContent).toBe("3 tool calls");
      expect(root.querySelectorAll(".tool-activity-card")).toHaveLength(3);
      expect(root.querySelector(".activity")?.textContent).not.toContain("Running");
      expect(root.querySelectorAll(".tool-activity-card pre")).toHaveLength(6);
      emit({ kind: "desktop.started", session: "saved" });
      emit({ kind: "desktop.tool", session: "saved", tool: "file_ops", status: "running", input: '{"op":"read","path":"d"}' });
      expect(root.querySelectorAll(".tool-activity-card")).toHaveLength(4);
      expect(root.querySelector(".tool-activity-card:last-child")?.textContent).toContain("Running");
      emit({ kind: "desktop.tool", session: "saved", tool: "file_ops", status: "done", input: '{"op":"read","path":"d"}', ok: false, output: "No such file" });
      expect(root.querySelector(".tool-activity-card:last-child")?.textContent).toContain("Failed");
      emit({ kind: "desktop.done", session: "saved" }); await settle();
      expect(root.querySelector(".activity summary")?.textContent).toBe("4 tool calls");
    } finally { boot.sessions.splice(0); }
  });
  it("restores task outputs and persisted failures immediately on native startup", async () => {
    restoredSession = { id: "saved", title: "Saved task", root: "/project", messages: [], progress: { interrupted: true, tools: [{ tool: "file_ops", status: "done", ok: false, output: "Denied by user" }] } };
    restoredArtifacts = [{ session: "saved", path: "report.md", at: Date.now() }, { session: "other", path: "private.md", at: Date.now() }];
    (boot.sessions as any[]).push({ id: "saved", title: "Saved task", profile: "p" });
    localStorage.setItem("hades.lastSession", "saved");
    try {
      await mount(); await settle();
      expect(root.querySelector(".task-inspector")?.textContent).toContain("report.md");
      expect(root.querySelector(".task-inspector")?.textContent).not.toContain("private.md");
      expect(root.querySelector(".activity")?.textContent).toContain("file_ops · Failed");
      expect(root.querySelector(".activity")?.textContent).toContain("Denied by user");
      expect(root.querySelector('[role="alert"]')?.textContent).toContain("interrupted");
    } finally { boot.sessions.splice(0); }
  });
  it("does not show an empty tab strip for conversations outside the current profile", async () => {
    localStorage.setItem("hades.tabs", JSON.stringify(["old-one", "old-two"]));
    await mount(); expect(root.querySelector(".tabs")).toBeNull();
  });
  it("preserves the chosen schedule and draft when routine fields update in the background", async () => {
    await mount(); click('[data-view="jobs"]'); await settle(); click('[data-action="job-new"]');
    const schedule = root.querySelector<HTMLSelectElement>("#job-schedule")!;
    expect(root.querySelector<HTMLElement>("#job-cron-fields")!.hidden).toBe(true);
    schedule.value = "cron"; schedule.dispatchEvent(new Event("change"));
    expect(root.querySelector<HTMLElement>("#job-interval-fields")!.hidden).toBe(true);
    root.querySelector<HTMLInputElement>("#job-name")!.value = "Morning review";
    root.querySelector<HTMLInputElement>("#job-cron")!.value = "0 9 * * 1-5";
    emit({ kind: "desktop.usage", tokensIn: 2, tokensOut: 3 });
    expect(root.querySelector<HTMLInputElement>("#job-name")!.value).toBe("Morning review");
    expect(root.querySelector<HTMLInputElement>("#job-cron")!.value).toBe("0 9 * * 1-5");
    expect(root.querySelector<HTMLElement>("#job-cron-fields")!.hidden).toBe(false);
  });
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
  it("keeps project folders expanded and sidebar scroll stable across updates", async () => {
    await mount(); const more = root.querySelector<HTMLDetailsElement>(".sidebar-projects")!; more.open = true;
    root.querySelector(".sidebar-content")!.scrollTop = 175;
    emit({ kind: "desktop.usage", tokensIn: 1, tokensOut: 1 });
    expect(root.querySelector<HTMLDetailsElement>(".sidebar-projects")!.open).toBe(true);
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
  it("clears the old inspector and reloads from the new project after switching roots", async () => {
    boot.projects.push("/other");
    try {
      await mount(); click('[data-action="files"]'); await settle();
      click('[data-action="file"][data-path="a.txt"]'); await settle();
      expect(root.querySelector("#file-content")).toBeTruthy();
      click('[data-action="project-select"][data-path="/other"]'); await settle();
      expect(root.querySelector("#file-content")).toBeNull();
      click('[data-action="files"]'); await settle();
      const calls = (window as any).__TAURI__.core.invoke.mock.calls;
      expect(calls.filter((call: any) => call[1]?.cmd?.method === "files.list").at(-1)[1].cmd.args.root).toBe("/other");
    } finally { boot.projects.splice(1); }
  });
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

it("opens Helm in the native workbench without replacing chat or workspace", async () => {
  await mount();
  click('[data-action="nav"][data-view="helm"]'); await settle();
  expect(root.querySelector(".breadcrumb")?.textContent).toContain("Helm");
  expect(root.querySelector("#helm-host")?.textContent).toContain("Code with Helm");
  expect(root.querySelector('[data-action="nav"][data-view="sessions"]')).toBeTruthy();
  expect(root.querySelector('[data-action="nav"][data-view="workspace"]')).toBeTruthy();
});

it("opens a typed project folder from Helm and stays in the coding workspace", async () => {
  await mount();
  click('[data-action="nav"][data-view="helm"]'); await settle();
  click('[data-helm="project"]'); await settle();
  const path = root.querySelector<HTMLInputElement>("#project-path")!;
  expect(path).toBeTruthy();
  expect(root.querySelector('[data-action="project-pick"]')?.textContent).toContain("Choose in Finder");
  path.value = "/typed-project";
  click('[data-action="project-add"]'); await settle();
  expect(root.querySelector("#project-path")).toBeNull();
  expect(root.querySelector(".breadcrumb")?.textContent).toContain("Helm");
  expect(root.querySelector("#helm-host")?.textContent).toContain("Code with Helm");
  const invoke = (globalThis as any).__TAURI__.core.invoke;
  expect(invoke).toHaveBeenCalledWith("hades_request", expect.objectContaining({ cmd: expect.objectContaining({ method: "project.add", args: { path: "/typed-project" } }) }));
  expect(invoke).toHaveBeenCalledWith("hades_request", expect.objectContaining({ cmd: expect.objectContaining({ method: "helm.list", args: expect.objectContaining({ root: "/typed-project" }) }) }));
});

it("keeps restored conversation errors in chat rather than the Helm workspace", async () => {
  restoredSession = { id: "saved", title: "Saved task", root: "/project", messages: [], progress: { error: "Run cancelled" } };
  (boot.sessions as any[]).push({ id: "saved", title: "Saved task", profile: "p" });
  localStorage.setItem("hades.lastSession", "saved");
  try {
    await mount(); await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Run cancelled");
    click('[data-action="nav"][data-view="helm"]'); await settle();
    expect(root.textContent).not.toContain("Run cancelled");
    click('[data-action="session"][data-id="saved"]'); await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Run cancelled");
  } finally { boot.sessions.splice(0); }
});
