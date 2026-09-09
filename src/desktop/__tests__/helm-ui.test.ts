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

it("restores keyboard focus and disclosure state through refresh without opening unrelated panels", async () => {
  const view = await mount();
  const advanced = host.querySelector<HTMLDetailsElement>(".helm-advanced")!;
  advanced.open = true;
  const refresh = host.querySelector<HTMLButtonElement>('[data-helm="refresh"]')!;
  refresh.focus();
  const id = refresh.id;
  await view.refresh();
  expect(document.activeElement?.id).toBe(id);
  expect(host.querySelector<HTMLDetailsElement>(".helm-advanced")!.open).toBe(true);
  click("note-new");
  expect(document.activeElement?.id).toBe("helm-note-title");
  input("helm-prompt", "Review task");
  submit("start"); await settle();
  expect(host.querySelector<HTMLDetailsElement>(".helm-project-context")!.open).toBe(true);
  expect(host.querySelector(".helm-advanced")).toBeNull();
});

it("distinguishes direct Code edits, task checkout and unverified model identity", async () => {
  await mount("code");
  expect(host.textContent).toContain("Code edits files directly in the selected project");
  expect(host.querySelector(".helm-scope")?.textContent).toContain("/project");
  expect(host.querySelector(".helm-scope")?.textContent).toContain("p1");
  click("destination-tasks");
  expect(host.textContent).toContain("Account and model access are not yet verified");
  expect(host.querySelector(".helm-dot")).toBeNull();
  input("helm-prompt", "Review task"); submit("start"); await settle();
  expect(host.textContent).toContain("Requested modelAgent configuration · actual model not reported");
  expect(host.textContent).toContain("Source project/project");
  expect(host.textContent).toContain("Task checkout/task");
});

it("labels completed tasks with failing checks without implying verification", async () => {
  const previous = run.checks;
  run.checks = [{ command: "node", args: ["--test"], startedAt: 1, finishedAt: 2, passed: false, exitCode: 1, output: "Failed assertion", revision: "abc" }];
  try {
    await mount(); input("helm-prompt", "Review task"); submit("start"); await settle();
    expect(host.textContent).toContain("Checks failed · review needed");
    expect(host.textContent).not.toContain("Checks passed");
  } finally { run.checks = previous; }
});

it("discards a diff response after switching projects", async () => {
  const view = await mount(); input("helm-prompt", "Review task"); submit("start"); await settle();
  let resolveDiff!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveDiff = resolve; }));
  host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
  await settle();
  await view.open({ root: "/other", profile: "p1", projects: ["/project", "/other"] });
  resolveDiff({ text: "OLD SECRET DIFF", stale: false }); await settle();
  expect(host.textContent).not.toContain("OLD SECRET DIFF");
  expect(host.querySelector(".helm-scope")?.textContent).toContain("/other");
});

it("shows local probe evidence and actionable account status without claiming model readiness", async () => {
  const view = await mount();
  rpc.mockImplementationOnce(async () => [{ id: "codex", installed: true, auth: "signed-in", readiness: { installed: true, auth: "signed-in", probe: "available", model: "unverified", checkedAt: 1, nextStep: "Complete a small task to verify this model." } }]);
  await view.refresh(true);
  expect(host.querySelector(".helm-readiness")?.textContent).toContain("Local login present");
  expect(host.querySelector(".helm-readiness")?.textContent).toContain("Model access unverified");
  expect(host.querySelector(".helm-readiness")?.textContent).toContain("Complete a small task");
  expect(rpc.mock.calls.some(([method]) => method === "helm.start")).toBe(false);
  rpc.mockImplementationOnce(async () => [{ id: "codex", installed: true, auth: "unknown", readiness: { installed: true, auth: "unknown", probe: "timed-out", model: "unverified", checkedAt: 2, nextStep: "Check the pending Keychain prompt." } }]);
  await view.refresh(true);
  expect(host.querySelector(".helm-readiness")?.textContent).toContain("Setup check timed out");
  expect(host.querySelector(".helm-readiness")?.textContent).toContain("Check the pending Keychain prompt");
  expect(host.querySelector<HTMLButtonElement>('[data-helm-form="start"] button[type="submit"]')!.disabled).toBe(false);
});

it("requires explicit complete patch review before source apply and preserves unknown outcomes", async () => {
  const previous = run.status;
  run.status = "verified";
  try {
    await mount(); input("helm-prompt", "Review task"); submit("start"); await settle();
    host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click(); await settle();
    const review = { id: "review-1", runId: "r1", root: "/project", revision: "task-sha", sourceRevision: "source-sha", patch: "diff --git a/a b/a\n+<literal>\n", status: "prepared", requiresSourceChecks: true };
    rpc.mockImplementationOnce(async () => structuredClone(review));
    click("integration-prepare"); await settle();
    expect(rpc).toHaveBeenCalledWith("helm.integration.prepare", { id: "r1", profile: "p1" });
    expect(host.querySelector("#helm-integration-patch")?.textContent).toBe(review.patch);
    expect(rpc.mock.calls.some(([method]) => method === "helm.integration.apply")).toBe(false);
    const digest = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new Uint8Array([1, 255]).buffer);
    rpc.mockImplementationOnce(async () => { throw new Error("Acknowledgement lost"); });
    click("integration-apply"); await settle();
    expect(new TextDecoder().decode(digest.mock.calls[0][1] as ArrayBuffer)).toBe(review.patch);
    expect(rpc).toHaveBeenCalledWith("helm.integration.apply", { id: "r1", reviewId: "review-1", profile: "p1", patchDigest: "01ff" });
    expect(host.querySelector('[data-helm="integration-apply"]')).toBeNull();
    expect(host.textContent).toContain("Application outcome is uncertain");
    rpc.mockImplementationOnce(async () => ({ ...review, status: "applied" }));
    click("integration-status"); await settle();
    expect(rpc).toHaveBeenCalledWith("helm.integration.get", { id: "r1", reviewId: "review-1", profile: "p1" });
    expect(host.textContent).toContain("Applied to source. Run checks in the source project");
  } finally { run.status = previous; }
});

it("refuses to apply a patch if the displayed content is incomplete", async () => {
  const previous = run.status; run.status = "verified";
  try {
    await mount(); input("helm-prompt", "Review task"); submit("start"); await settle();
    host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click(); await settle();
    rpc.mockImplementationOnce(async () => ({ id: "review-2", runId: "r1", root: "/project", patch: "complete patch", status: "prepared" }));
    click("integration-prepare"); await settle();
    host.querySelector("#helm-integration-patch")!.textContent = "truncated";
    click("integration-apply"); await settle();
    expect(rpc.mock.calls.some(([method]) => method === "helm.integration.apply")).toBe(false);
    expect(host.textContent).toContain("Prepare and read the complete patch");
  } finally { run.status = previous; }
});

it("restores unresolved source application after remount and blocks another review", async () => {
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method, args) => {
    if (method === "helm.list") return [{ ...run, status: "verified" }];
    if (method === "helm.get") return { ...run, status: "verified" };
    if (method === "helm.integration.list") return [
      { id: "other", runId: "other-task", root: "/other", status: "prepared", patch: "out of scope" },
      { id: "durable-review", runId: "r1", root: "/project", status: "applying", patch: "preserved full patch", sourceRevision: "source", revision: "task" },
    ];
    return base(method, args);
  });
  try {
    await mount(); click("select"); await settle();
    host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click(); await settle();
    expect(host.querySelector("#helm-integration-patch")?.textContent).toBe("preserved full patch");
    expect(host.querySelector('[data-helm="integration-prepare"]')).toBeNull();
    expect(host.querySelector('[data-helm="integration-apply"]')).toBeNull();
    expect(host.querySelector('[data-helm="integration-status"]')).toBeTruthy();
    expect(host.textContent).not.toContain("out of scope");
    expect(rpc.mock.calls.some(([method]) => method === "helm.integration.apply")).toBe(false);
  } finally { rpc.mockImplementation(base); }
});

it("receives Browser evidence as an explicit draft and dispatches only its server-bound id", async () => {
  const base = rpc.getMockImplementation()!;
  const draft = { id: "browser-draft", status: "draft", prompt: "Implement the researched feature", createdAt: 1, notebook: { id: "notebook-1", workspaceId: "browser-space", title: "Research result", body: "<literal evidence>", sources: [{ id: "s1", title: "Official source", url: "https://example.com/docs", retrievedAt: "2026-09-09", excerpt: "Evidence" }] } };
  rpc.mockImplementation(async (method, args) => method === "helm.handoff.list" ? [draft] : base(method, args));
  try {
    await mount();
    expect(host.textContent).toContain("From Hades Browser");
    expect(rpc.mock.calls.some(([method]) => method === "helm.start")).toBe(false);
    click("handoff-use");
    expect(host.querySelector<HTMLTextAreaElement>("#helm-prompt")?.value).toBe(draft.prompt);
    expect(host.textContent).toContain("Destination: /project · Hades profile: p1");
    expect(rpc.mock.calls.some(([method]) => method === "helm.start")).toBe(false);
    submit("start"); await settle();
    expect(rpc).toHaveBeenCalledWith("helm.start", expect.objectContaining({ handoffId: "browser-draft", title: "Research result", root: "/project", profile: "p1", agent: "codex" }));
    const args = rpc.mock.calls.find(([method]) => method === "helm.start")![1]!;
    expect(args.context).toBeUndefined(); expect(args.notebook).toBeUndefined();
  } finally { rpc.mockImplementation(base); }
});

it("blocks redispatch after a Browser draft start loses acknowledgement", async () => {
  const base = rpc.getMockImplementation()!;
  const draft = { id: "browser-draft", status: "draft", prompt: "Implement feature", createdAt: 1, notebook: { id: "n", workspaceId: "w", title: "Feature", body: "Evidence", sources: [] } };
  rpc.mockImplementation(async (method, args) => {
    if (method === "helm.handoff.list") return [draft];
    if (method === "helm.start") { draft.status = "unknown"; throw new Error("Acknowledgement lost"); }
    return base(method, args);
  });
  try {
    await mount(); click("handoff-use"); submit("start"); await settle();
    expect(host.textContent).toContain("Dispatch is pending or uncertain");
    expect(host.querySelector('[data-helm="handoff-use"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-helm-form="start"] button[type="submit"]')!.disabled).toBe(true);
    submit("start"); await settle();
    expect(rpc.mock.calls.filter(([method]) => method === "helm.start")).toHaveLength(1);
  } finally { rpc.mockImplementation(base); }
});

it("shows a human profile name and never labels agent refresh as starting a task", async () => {
  const view = await mount();
  await view.open({ root: "/project", profile: "uuid-id", profileName: "Daily coding", projects: ["/project"] });
  expect(host.querySelector(".helm-scope")?.textContent).toContain("Hades profile: Daily coding");
  let resolve!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  click("refresh");
  expect(host.querySelector('[data-helm-form="start"] button[type="submit"]')?.textContent).toBe("Please wait…");
  expect(rpc.mock.calls.some(([method]) => method === "helm.start")).toBe(false);
  resolve([{ id: "codex", installed: true }]); await settle();
});

it("does not request worktree integration during task preparation", async () => {
  const previous = run.status; run.status = "starting";
  try {
    await mount(); input("helm-prompt", "Prepare task"); submit("start"); await settle();
    expect(rpc.mock.calls.some(([method]) => method === "helm.integration.list")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally { run.status = previous; }
});

it("requires explicit source checks, restores their status, and never changes the task verdict", async () => {
  const base = rpc.getMockImplementation()!;
  const review = { id: "applied-review", runId: "r1", root: "/project", status: "applied", patch: "full patch", revision: "task", sourceRevision: "source" };
  const receipt = { id: "source-check", reviewId: review.id, runId: "r1", root: "/project", status: "running", checks: [{ command: "node", args: ["--test"] }], results: [], maxSeconds: 45, createdAt: 1, before: "before" };
  let results: unknown[] = [];
  rpc.mockImplementation(async (method, args) => {
    if (method === "helm.list") return [{ ...run, status: "verified" }];
    if (method === "helm.get") return { ...run, status: "verified", requestedChecks: receipt.checks };
    if (method === "helm.integration.list") return [review];
    if (method === "helm.source.list") return results;
    if (method === "helm.source.start") { results = [receipt]; return receipt; }
    if (method === "helm.source.cancel") return { ...receipt, status: "cancelled" };
    return base(method, args);
  });
  try {
    await mount(); click("select"); await settle();
    host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click(); await settle();
    expect(host.textContent).toContain("Source not checked yet");
    expect(rpc.mock.calls.some(([method]) => method === "helm.source.start")).toBe(false);
    input("helm-source-seconds", "45"); submit("source-checks"); await settle();
    expect(rpc).toHaveBeenCalledWith("helm.source.start", { id: "r1", reviewId: review.id, profile: "p1", checks: receipt.checks, maxSeconds: 45 });
    expect(host.textContent).toContain("Source checks running");
    click("source-cancel"); await settle();
    expect(host.textContent).toContain("Source checks stopped");
    results = [{ ...receipt, status: "stale", error: "Source changed after checks" }];
    click("source-refresh"); await settle();
    expect(host.textContent).toContain("Source changed · fresh checks needed");
    expect(host.querySelector(".helm-status")?.textContent).toBe("Checks passed");
    expect(rpc.mock.calls.filter(([method]) => method === "helm.source.start")).toHaveLength(1);
  } finally { rpc.mockImplementation(base); }
});

it("opens a Browser-origin preview only explicitly and reuses its request identity", async () => {
  const base = rpc.getMockImplementation()!;
  const review = { id: "review", runId: "r1", root: "/project", status: "applied", patch: "patch", revision: "task", sourceRevision: "source" };
  const source = { id: "source-check", reviewId: "review", runId: "r1", root: "/project", status: "passed", checks: [], results: [], maxSeconds: 300, createdAt: 1 };
  let saved: any[] = [];
  rpc.mockImplementation(async (method, args) => {
    if (method === "helm.list" || method === "helm.get") { const task = { ...run, status: "verified", handoffId: "browser-draft" }; return method === "helm.list" ? [task] : task; }
    if (method === "helm.integration.list") return [review];
    if (method === "helm.source.list") return [source];
    if (method === "helm.preview.list") return saved;
    if (method === "helm.preview.open") { saved = [{ id: args!.requestId, runId: "r1", root: "/project", sourceCheckId: "source-check", url: args!.url, status: "opened", tabId: "tab-1" }]; return saved[0]; }
    return base(method, args);
  });
  try {
    const view = await mount(); click("select"); await settle();
    host.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click(); await settle();
    expect(rpc.mock.calls.some(([method]) => method === "helm.preview.open")).toBe(false);
    input("helm-preview-url", "https://remote.example:3000"); submit("preview"); await settle();
    expect(rpc.mock.calls.some(([method]) => method === "helm.preview.open")).toBe(false);
    input("helm-preview-url", "http://localhost:3000"); submit("preview"); await settle();
    const first = rpc.mock.calls.find(([method]) => method === "helm.preview.open")![1]!;
    expect(first).toEqual(expect.objectContaining({ id: "r1", profile: "p1", sourceCheckId: "source-check", url: "http://localhost:3000/", requestId: expect.any(String) }));
    expect(host.textContent).toContain("Tab opened; inspect the page to verify behavior");
    await view.refresh(); submit("preview"); await settle();
    expect(rpc.mock.calls.filter(([method]) => method === "helm.preview.open")[1][1]!.requestId).toBe(first.requestId);
    source.status = "stale"; click("source-refresh"); await settle();
    expect(host.querySelector('[data-helm-form="preview"]')).toBeNull();
    expect(host.textContent).toContain("Pass fresh source checks");
  } finally { rpc.mockImplementation(base); }
});
