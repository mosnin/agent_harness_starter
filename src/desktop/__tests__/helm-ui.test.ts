// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmView } from "../ui/helm";
import type { HelmRun } from "../core/helm-types";
let host: HTMLDivElement;
const run: HelmRun = {
  id: "r1",
  root: "/project",
  workspace: "/task",
  branch: "helm/task",
  baseSha: "abc123",
  agent: "codex",
  title: "Fix checkout",
  prompt: "Fix the checkout test",
  status: "needs_review",
  createdAt: 1,
  updatedAt: 2,
  output: "<script>unsafe</script>\nImplemented change",
  checks: [],
  maxMinutes: 30,
  sourceDirty: false,
  exclusions: [],
  contextSnapshot: "Saved constraint: keep public API stable",
};
const callbacks = {
  chooseProject: vi.fn(),
  selectProject: vi.fn(async () => {}),
  openWorkspace: vi.fn(async () => {}),
  openSession: vi.fn(),
};
const rpc = vi.fn(
  async (method: string, _args?: Record<string, unknown>): Promise<any> => {
    if (method === "helm.agents")
      return [
        { id: "codex", name: "Codex", installed: true, auth: "unknown" },
        {
          id: "claude",
          name: "Claude Code",
          installed: false,
          auth: "unknown",
        },
      ];
    if (method === "helm.list") return [];
    if (method === "helm.context.list")
      return [
        {
          id: "c1",
          title: "Stable API",
          kind: "constraint",
          body: "Keep public API",
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    if (
      method === "helm.start" ||
      method === "helm.get" ||
      method === "helm.verify"
    )
      return structuredClone(run);
    if (method === "helm.diff")
      return {
        text: "+ a change",
        files: ["file.ts"],
        revision: "abc",
        stale: false,
        truncated: false,
      };
    return {};
  },
);
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  rpc.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.dispatchEvent(new Event("beforeunload"));
  document.body.replaceChildren();
});
async function mount(destination = "tasks") {
  const view = new HelmView(rpc, callbacks);
  view.mount(host);
  await view.open({ root: "/project", profile: "p1", projects: ["/project"] });
  if (destination === "tasks") click("destination-tasks");
  return view;
}
function input(id: string, value: string) {
  const node = host.querySelector<HTMLInputElement>(`#${id}`)!;
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(action: string) {
  host.querySelector<HTMLButtonElement>(`[data-helm="${action}"]`)!.click();
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function submit(form: string) {
  host
    .querySelector<HTMLFormElement>(`[data-helm-form="${form}"]`)!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
it("starts an explicit native task with selected context and keeps the result visible", async () => {
  await mount();
  input("helm-prompt", "Fix the checkout test");
  const checkbox = host.querySelector<HTMLInputElement>(
    '[data-helm-context="c1"]',
  )!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  submit("start");
  await settle();
  expect(rpc).toHaveBeenCalledWith(
    "helm.start",
    expect.objectContaining({
      root: "/project",
      profile: "p1",
      agent: "codex",
      prompt: "Fix the checkout test",
      contextIds: ["c1"],
    }),
  );
  expect(host.textContent).toContain("Ready for review");
  expect(host.textContent).toContain("Review the changes");
});
it("keeps a failed start draft available and never presents it as running", async () => {
  const view = await mount();
  rpc.mockImplementationOnce(async () => {
    throw new Error("Account needs login");
  });
  input("helm-prompt", "Keep this draft");
  submit("start");
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Account needs login",
  );
  expect(host.querySelector<HTMLTextAreaElement>("#helm-prompt")?.value).toBe(
    "Keep this draft",
  );
  await view.refresh();
});
it("rejects shell command syntax before dispatching verification", async () => {
  await mount();
  input("helm-prompt", "Fix test");
  const check = host.querySelector<HTMLInputElement>("#helm-use-check")!;
  check.checked = true;
  check.dispatchEvent(new Event("change", { bubbles: true }));
  input("helm-check-command", "npm test && deploy");
  submit("start");
  await settle();
  expect(host.textContent).toContain("Enter one executable");
  expect(rpc.mock.calls.some(([method]) => method === "helm.start")).toBe(
    false,
  );
});
it("escapes live output and exposes the frozen task context", async () => {
  await mount();
  input("helm-prompt", "Fix test");
  submit("start");
  await settle();
  host.querySelector<HTMLButtonElement>('[data-tab="output"]')!.click();
  expect(host.querySelector("script")).toBeNull();
  expect(host.textContent).toContain("<script>unsafe</script>");
  host.querySelector<HTMLButtonElement>('[data-tab="context"]')!.click();
  expect(host.textContent).toContain(
    "Saved constraint: keep public API stable",
  );
  expect(
    rpc.mock.calls.some(([method]) => method === "helm.context.save"),
  ).toBe(false);
});
it("saves reviewed outcomes only after explicit edit and save", async () => {
  await mount();
  input("helm-prompt", "Fix test");
  submit("start");
  await settle();
  click("outcome");
  expect(
    rpc.mock.calls.some(([method]) => method === "helm.context.save"),
  ).toBe(false);
  input("helm-note-body", "Reviewed diff and checks. Accepted locally.");
  submit("note");
  await settle();
  expect(rpc).toHaveBeenCalledWith(
    "helm.context.save",
    expect.objectContaining({
      root: "/project",
      kind: "outcome",
      body: "Reviewed diff and checks. Accepted locally.",
    }),
  );
});

it("passes an optional model override only to this task", async () => {
  await mount();
  input("helm-prompt", "Fix test");
  input("helm-model", "supported-model");
  submit("start");
  await settle();
  expect(rpc).toHaveBeenCalledWith(
    "helm.start",
    expect.objectContaining({ model: "supported-model" }),
  );
  expect(rpc.mock.calls.some(([method]) => method.startsWith("profile."))).toBe(
    false,
  );
});
it("refreshes agent discovery explicitly and labels installed CLIs clearly", async () => {
  await mount();
  expect(host.querySelector("#helm-agent")?.textContent).toContain(
    "Claude Code · not installed",
  );
  click("refresh");
  await settle();
  expect(rpc).toHaveBeenCalledWith("helm.agents", { refresh: true });
});
it("includes the original context version when saving an edit", async () => {
  await mount();
  click("note-edit");
  input("helm-note-body", "Keep stable API and tests");
  submit("note");
  await settle();
  expect(rpc).toHaveBeenCalledWith(
    "helm.context.save",
    expect.objectContaining({
      id: "c1",
      expectedUpdatedAt: 1,
      body: "Keep stable API and tests",
    }),
  );
});
it("opens setup docs only when explicitly requested", async () => {
  await mount();
  expect(rpc.mock.calls.some(([method]) => method === "link.open")).toBe(false);
  click("docs");
  await settle();
  expect(rpc).toHaveBeenCalledWith("link.open", {
    url: "https://developers.openai.com/codex/cli/reference/",
  });
});

it("keeps programming fields literal and sends exact JSON arguments", async () => {
  await mount();
  for (const id of ["helm-model", "helm-check-command", "helm-check-args"]) {
    const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
  }
  input("helm-prompt", "Run literal check arguments");
  const checkbox = host.querySelector<HTMLInputElement>("#helm-use-check")!;
  checkbox.click();
  input("helm-check-command", "node");
  input("helm-check-args", '["--test"]');
  submit("start");
  await settle();
  expect(rpc).toHaveBeenCalledWith("helm.start", expect.objectContaining({ checks: [{ command: "node", args: ["--test"] }] }));
});

it("opens the actual fork only on request and preserves its frame across refresh and tabs", async () => {
  const setSource = vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(() => {});
  const view = await mount("code");
  expect(host.textContent).toContain("Code with Helm");
  expect(rpc.mock.calls.some(([method]) => method === "helm.code.open")).toBe(false);
  rpc.mockImplementationOnce(async () => ({ url: "http://127.0.0.1:4567/#helm_auth=dGVzdA==", version: "1.18.21", revision: "abc", fork: "https://github.com/mosnin/opencode" }));
  click("code-open"); await settle();
  const frame = document.querySelector("iframe")!;
  expect(frame).toBeTruthy();
  expect(setSource).toHaveBeenCalledWith("http://127.0.0.1:4567/#helm_auth=dGVzdA%3D%3D&helm_theme=light");
  expect(rpc).toHaveBeenCalledWith("helm.code.open", { root: "/project", profile: "p1" });
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  const post = (source: Window | null, origin: string, url: string) => window.dispatchEvent(new MessageEvent("message", { source, origin, data: { type: "helm.openExternal", url } }));
  post(window, "http://127.0.0.1:4567", "https://example.com/wrong-source");
  post(frame.contentWindow, "https://example.com", "https://example.com/wrong-origin");
  post(frame.contentWindow, "http://127.0.0.1:4567", "javascript:alert(1)");
  expect(rpc.mock.calls.some(([method]) => method === "link.open")).toBe(false);
  post(frame.contentWindow, "http://127.0.0.1:4567", "https://example.com/sign-in");
  expect(rpc).toHaveBeenCalledWith("link.open", { url: "https://example.com/sign-in" });
  await view.refresh();
  click("destination-tasks");
  expect(frame.hidden).toBe(true);
  click("destination-code");
  expect(document.querySelector("iframe")).toBe(frame);
  const replacement = document.createElement("div"); host.replaceWith(replacement); host = replacement;
  view.mount(host);
  expect(document.querySelector("iframe")).toBe(frame);
  click("code-close"); await settle();
  expect(rpc).toHaveBeenCalledWith("helm.code.close", { root: "/project", profile: "p1" });
  expect(document.querySelector("iframe")).toBeNull();
  expect(host.querySelector('[data-helm="code-open"]')).toBeTruthy();
  expect(host.textContent).toContain("Coding workspace closed");
});

it("reuses the previous task time limit without starting work", async () => {
  await mount();
  run.maxMinutes = 2;
  try {
  input("helm-prompt", "Original task");
  submit("start"); await settle();
  const starts = rpc.mock.calls.filter(([method]) => method === "helm.start").length;
  click("reuse");
  expect(host.querySelector<HTMLInputElement>("#helm-minutes")!.value).toBe("2");
  expect(rpc.mock.calls.filter(([method]) => method === "helm.start")).toHaveLength(starts);
  } finally { run.maxMinutes = 30; }
});

it("shows recorded preparation exclusions and execution settings in task overview", async () => {
  await mount();
  const previous = { sourceDirty: run.sourceDirty, exclusions: run.exclusions, model: run.model, maxMinutes: run.maxMinutes };
  Object.assign(run, { sourceDirty: true, exclusions: ["Uncommitted sum.js changes excluded", "<script>not markup</script>"], model: "gpt-5.6-sol", maxMinutes: 2 });
  try {
    input("helm-prompt", "Review isolated task");
    submit("start"); await settle();
    expect(host.textContent).toContain("Uncommitted changes in the original project were excluded");
    const notes = [...host.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent === "Preparation notes")!;
    expect(notes.textContent).toContain("Uncommitted sum.js changes excluded");
    expect(notes.querySelector("script")).toBeNull();
    expect(host.querySelector(".helm-facts")?.textContent).toContain("gpt-5.6-sol");
    expect(host.querySelector(".helm-facts")?.textContent).toContain("2 minutes");
  } finally { Object.assign(run, previous); }
});


it("keeps the coding composer inside a short native viewport", async () => {
  const { HelmCodeFrame } = await import("../ui/helm-code");
  vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(() => {});
  const anchor = document.createElement("div");
  document.body.append(anchor);
  anchor.getBoundingClientRect = () => ({ left: 250, top: 232, width: 900, height: 563, bottom: 795, right: 1150, x: 250, y: 232, toJSON() {} });
  const previousHeight = window.innerHeight;
  const code = new HelmCodeFrame();
  try {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    code.open("http://127.0.0.1:4567/", "viewport-test");
    code.attach(anchor);
    expect(document.querySelector<HTMLIFrameElement>("iframe")!.style.height).toBe("524px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 560 });
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelector<HTMLIFrameElement>("iframe")!.style.height).toBe("316px");
  } finally {
    code.dispose(); anchor.remove();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: previousHeight });
  }
});
