// @vitest-environment happy-dom
// Renderer/RPC fixtures only: no workers, command execution, listeners or native control.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmView } from "../ui/helm";
import { HelmOrcaView } from "../ui/helm-orca";
import { WorkGoalsView } from "../ui/work-goals";

const context = { root: "/project", profile: "owner", projects: ["/project"], profiles: [{ id: "owner", name: "Planner" }, { id: "writer", name: "Writer" }] };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const clones = <T>(value: T): T => structuredClone(value);
const dispose: Array<() => void> = [];
let workHost: HTMLElement, helmHost: HTMLElement;
const click = (host: HTMLElement, action: string, prefix = "helm") => host.querySelector<HTMLButtonElement>(`[data-${prefix}="${action}"]`)!.click();
const input = (host: HTMLElement, id: string, value: string) => { const field = host.querySelector<HTMLInputElement>(`#${id}`)!; field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); };
const tab = (value: string) => helmHost.querySelector<HTMLButtonElement>(`[data-helm="tab"][data-tab="${value}"]`)!.click();
const submit = (value: string) => helmHost.querySelector<HTMLFormElement>(`[data-helm-form="${value}"]`)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = '<main id="work"></main><main id="helm"></main>';
  workHost = document.querySelector("#work")!; helmHost = document.querySelector("#helm")!;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is outside this UI fixture"); }));
});
afterEach(() => { dispose.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function fixture() {
  const origin = { intentId: "intent", runtimeId: "runtime", runId: "orca-run", dispatchId: "dispatch", worktreeId: "worktree", root: "/project", profile: "writer", baseSha: "a".repeat(40), revision: "b".repeat(64), workspace: "/orca-checkout", workspaceIdentity: { dev: 1, ino: 2, gitFileDigest: "git" }, sourceIdentity: { dev: 1, ino: 3, commonDir: "/project/.git", commonDev: 1, commonIno: 4 } };
  const workOrigin = { goalId: "goal", taskId: "task", ownerProfile: "owner", taskProfile: "writer", requestId: "intent", attemptId: "attempt" };
  const run: any = { id: "helm-run", root: "/project", owner: "owner", workspace: "/review-checkout", branch: "", baseSha: origin.baseSha, agent: "codex", title: "Fix parser", prompt: "Fix the parser", status: "needs_review", createdAt: 1, updatedAt: 2, output: "Worker exited", checks: [], maxMinutes: 5, sourceDirty: false, exclusions: [], orcaOrigin: origin, workOrigin };
  const goal: any = { id: "goal", root: "/project", profile: "owner", objective: "Ship checked output", status: "needs_review", tokens: 0, maxTokens: 30000, maxMinutes: 10, maxRounds: 8, maxConcurrent: 2, acceptance: [], tasks: [
    { id: "task", title: "Fix parser", prompt: "Fix parser", profile: "writer", status: "failed", engine: { kind: "orca", agent: "codex", requestId: "intent", dispatchIntent: true }, dependsOn: [], acceptance: [{ path: "result.md" }], attempts: [{ id: "attempt", number: 1, status: "failed", startedAt: 1 }], reservedTokens: 10000 },
    { id: "next", title: "Package result", profile: "writer", status: "queued", dependsOn: ["task"], engine: { kind: "hades" } },
  ] };
  const review: any = { id: "review", runId: run.id, root: run.root, owner: "owner", status: "applied", revision: origin.revision, sourceRevision: "source-before", patch: "diff --git a/result.md b/result.md\n+checked <literal>\n", files: ["result.md"], requiresSourceChecks: true, createdAt: 1 };
  const source: any = { id: "source-check", runId: run.id, reviewId: review.id, root: run.root, owner: "owner", status: "passed", before: "before", after: "c".repeat(64), createdAt: 1, finishedAt: 2, checks: [{ command: "node", args: ["--test"] }], results: [{ command: "node", args: ["--test"], exitCode: 0, output: "1 test passed (fixture)", truncated: false }], maxSeconds: 30 };
  const eligibility: any = { eligible: true, reasons: [], goalId: goal.id, taskId: "task", runId: run.id, reviewId: review.id, sourceCheckId: source.id, evidence: [{ path: "result.md", bytes: 9, sha256: "d".repeat(64) }], sourceRevision: source.after, accepted: false };
  const f = { run, goal, review, source, eligibility, overrides: new Map<string, (args: any) => any>(), imported: 0 };
  const acceptedGoal = () => { const next = clones(goal); next.tasks[0].status = "completed"; next.tasks[0].evidence = clones(eligibility.evidence); next.tasks[0].orcaAcceptance = { runId: run.id, requestId: "intent", reviewId: review.id, sourceCheckId: source.id, sourceRevision: source.after, patchDigest: "e".repeat(64), acceptedAt: 3 }; return next; };
  const rpc = vi.fn(async (method: string, args: any = {}): Promise<any> => {
    if (f.overrides.has(method)) return f.overrides.get(method)!(args);
    if (method === "work.list") return [clones(f.goal)];
    if (method === "work.get") return clones(f.goal);
    if (method === "work.orca.import") { f.imported++; return { goal: clones(f.goal), run: clones(f.run) }; }
    if (method === "helm.orca.import") { f.imported++; return clones(f.run); }
    if (method === "helm.orca.info") return { state: "packaged", message: "Fixture artifact", sourceRevision: "fixture" };
    if (method === "helm.orca.list") return [];
    if (method === "helm.agents") return [{ id: "codex", name: "Codex", installed: true }];
    if (["helm.list", "helm.context.list", "helm.handoff.list", "helm.preview.list"].includes(method)) return [];
    if (method === "helm.get") return clones(f.run);
    if (method === "helm.integration.list") return f.review ? [clones(f.review)] : [];
    if (method === "helm.source.list") return f.source ? [clones(f.source)] : [];
    if (method === "helm.diff") return { text: review.patch, files: review.files, revision: origin.revision, stale: false, truncated: false };
    if (method === "helm.verify") { f.run.status = "verified"; f.run.verificationRevision = origin.revision; return clones(f.run); }
    if (method === "helm.integration.prepare") { f.review = { ...review, status: "prepared" }; return clones(f.review); }
    if (method === "helm.integration.apply") { f.review.status = "applied"; return clones(f.review); }
    if (method === "helm.source.start") { f.source = clones(source); return clones(f.source); }
    if (method === "work.orca.acceptance") return clones(f.eligibility);
    if (method === "work.orca.accept") { f.goal = acceptedGoal(); f.eligibility.accepted = true; f.eligibility.eligible = false; return clones(f.goal); }
    if (method.startsWith("work.audit.")) return {};
    throw new Error("Unexpected fixture RPC: " + method);
  });
  return { f, rpc, acceptedGoal };
}
async function helmFixture(options = fixture()) {
  const openWork = vi.fn(async () => {});
  const view = new HelmView(options.rpc, { chooseProject: () => {}, selectProject: async () => {}, openWorkspace: async () => {}, openSession: () => {}, openWork });
  dispose.push(() => (view as any).orca.dispose());
  view.mount(helmHost); await view.open(context);
  return { ...options, view, openWork };
}

it("connects Work import to the existing full review, explicit apply, source checks and acceptance", async () => {
  const h = await helmFixture(); h.f.review = undefined; h.f.source = undefined;
  const openReview = vi.fn(async run => h.view.selectRun(run));
  const work = new WorkGoalsView(h.rpc, () => {}, openReview); await work.open(context); work.mount(workHost); await work.selectGoal("goal");
  expect(h.f.imported).toBe(0);
  click(workHost, "orca-review", "work"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("work.orca.import", { id: "goal", task: "task", profile: "owner" });
  expect(openReview).toHaveBeenCalledOnce(); expect(helmHost.textContent).toContain("Review snapshot");
  expect(helmHost.textContent).toContain("result.md"); expect(helmHost.querySelector('[data-helm="integration-prepare"]')).toBeNull();
  tab("checks"); const check = helmHost.querySelector<HTMLInputElement>("#helm-use-check")!; check.checked = true; check.dispatchEvent(new Event("input", { bubbles: true }));
  input(helmHost, "helm-check-command", "node"); input(helmHost, "helm-check-args", '["--test"]'); submit("verify"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("helm.verify", expect.objectContaining({ id: "helm-run", profile: "owner", workGoalId: "goal" }));
  tab("changes"); await settle(); click(helmHost, "integration-prepare"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("helm.integration.prepare", { id: "helm-run", profile: "owner", workGoalId: "goal" });
  expect(helmHost.querySelector("#helm-integration-patch")?.textContent).toBe(h.f.review.patch);
  expect(h.rpc.mock.calls.some(([method]) => method === "helm.integration.apply")).toBe(false);
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new Uint8Array(32).fill(1).buffer);
  click(helmHost, "integration-apply"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("helm.integration.apply", { id: "helm-run", reviewId: "review", profile: "owner", patchDigest: "01".repeat(32), workGoalId: "goal" });
  expect(h.rpc.mock.calls.some(([method]) => method === "helm.source.start")).toBe(false);
  submit("source-checks"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("helm.source.start", expect.objectContaining({ id: "helm-run", profile: "owner", workGoalId: "goal" }));
  expect(helmHost.textContent).toContain("1 test passed (fixture)"); expect(helmHost.textContent).toContain("SHA-256 " + "d".repeat(64));
  expect(h.rpc.mock.calls.some(([method]) => method === "work.orca.accept")).toBe(false);
  click(helmHost, "work-accept"); await settle();
  expect(h.rpc).toHaveBeenCalledWith("work.orca.accept", { id: "goal", task: "task", profile: "owner", runId: "helm-run", reviewId: "review", sourceCheckId: "source-check" });
  expect(helmHost.textContent).toContain("Task result accepted"); expect(document.activeElement?.id).toBe("helm-work-acceptance-status");
  expect(h.rpc.mock.calls.some(([method]) => method === "work.resume" || method === "work.run" || method === "helm.orca.start")).toBe(false);
  click(helmHost, "work-open"); await settle(); expect(h.openWork).toHaveBeenCalledWith({ goalId: "goal", taskId: "task", ownerProfile: "owner", root: "/project" });
  await work.refresh(); expect(workHost.textContent).toContain("10,000 tokens reserved"); expect(workHost.textContent).toContain("Dependent tasks can be considered when Work resumes: Package result");
});

it("does not import an unadmitted or active Work task and opens the retained accepted run", async () => {
  const { f, rpc, acceptedGoal } = fixture(), openReview = vi.fn(async () => {});
  const work = new WorkGoalsView(rpc, () => {}, openReview); await work.open(context); work.mount(workHost);
  f.goal.tasks[0].engine.dispatchIntent = false; await work.selectGoal("goal"); expect(workHost.querySelector('[data-work="orca-review"]')).toBeNull();
  f.goal.tasks[0].engine.dispatchIntent = true; f.goal.tasks[0].status = "running"; await work.refresh(); expect(workHost.querySelector('[data-work="orca-review"]')).toBeNull();
  f.goal = acceptedGoal(); await work.refresh(); click(workHost, "orca-review", "work"); await settle();
  expect(rpc).toHaveBeenCalledWith("helm.get", { id: "helm-run", profile: "owner" }); expect(f.imported).toBe(0); expect(openReview).toHaveBeenCalledOnce();
});

it("deduplicates a pending Work import and ignores a late result after profile change", async () => {
  const { f, rpc } = fixture(), openReview = vi.fn(async () => {}); let finish!: (value: any) => void;
  f.overrides.set("work.orca.import", () => new Promise(resolve => { finish = resolve; }));
  const work = new WorkGoalsView(rpc, () => {}, openReview); await work.open(context); work.mount(workHost); await work.selectGoal("goal");
  const button = workHost.querySelector<HTMLButtonElement>('[data-work="orca-review"]')!; button.click(); button.click();
  expect(rpc.mock.calls.filter(([method]) => method === "work.orca.import")).toHaveLength(1);
  f.overrides.set("work.list", () => []); await work.open({ ...context, profile: "other" }); finish({ goal: f.goal, run: f.run }); await settle();
  expect(openReview).not.toHaveBeenCalled(); expect(workHost.textContent).not.toContain("Fix parser");
});

it("refuses an imported Work snapshot for another task or attempt", async () => {
  const { f, rpc } = fixture(), openReview = vi.fn(async () => {});
  f.run.workOrigin.attemptId = "another-attempt";
  const work = new WorkGoalsView(rpc, () => {}, openReview); await work.open(context); work.mount(workHost); await work.selectGoal("goal");
  click(workHost, "orca-review", "work"); await settle();
  expect(openReview).not.toHaveBeenCalled(); expect(workHost.textContent).toContain("did not match this Work task and attempt");
});

it("imports a stopped direct Orca worker only explicitly and checks its identity", async () => {
  const { f, rpc } = fixture(), openReview = vi.fn(async () => {}); f.run.workOrigin = undefined;
  const worker = { ...context, id: "intent", runtimeId: "runtime", runId: "orca-run", dispatchId: "dispatch", state: "needs_review", active: false, input: { prompt: "Fix parser", agent: "codex" } };
  f.overrides.set("helm.orca.list", () => [worker]);
  const view = new HelmOrcaView(rpc, openReview); dispose.push(() => view.dispose()); view.setScope(context); view.mount(helmHost); await view.open(); click(helmHost, "select", "orca"); await settle();
  expect(f.imported).toBe(0); click(helmHost, "import", "orca"); await settle();
  expect(rpc).toHaveBeenCalledWith("helm.orca.import", { root: "/project", profile: "owner", id: "intent" }); expect(openReview).toHaveBeenCalledOnce();
  f.run.orcaOrigin.dispatchId = "foreign"; click(helmHost, "import", "orca"); await settle();
  expect(openReview).toHaveBeenCalledOnce(); expect(helmHost.textContent).toContain("did not match this Orca worker");
});

it.each(["ready", "unknown", "stopping"])("keeps direct Orca %s state outside review import", async state => {
  const { f, rpc } = fixture(); f.overrides.set("helm.orca.list", () => [{ ...context, id: "intent", runId: "orca-run", dispatchId: "dispatch", state, active: true, input: { prompt: "Fix parser", agent: "codex" } }]);
  const view = new HelmOrcaView(rpc, vi.fn(async () => {})); dispose.push(() => view.dispose()); view.setScope(context); view.mount(helmHost); await view.open(); click(helmHost, "select", "orca"); await settle();
  expect(helmHost.querySelector('[data-orca="import"]')).toBeNull(); expect(f.imported).toBe(0);
});

it.each(["stale", "failed", "interrupted"])("cannot accept %s source checks even if a malformed server verdict says eligible", async status => {
  const h = await helmFixture(); h.f.source.status = status; await h.view.selectRun(h.f.run);
  expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull(); expect(h.rpc.mock.calls.some(([method]) => method === "work.orca.accept")).toBe(false);
});

it.each(["goalId", "taskId", "runId", "reviewId", "sourceCheckId"])("rejects acceptance status with a foreign %s", async field => {
  const h = await helmFixture(); h.f.eligibility[field] = "foreign"; await h.view.selectRun(h.f.run);
  expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull(); expect(helmHost.textContent).toContain("Acceptance status did not match");
});

it("shows missing file evidence as a reason without inventing acceptance", async () => {
  const h = await helmFixture(); Object.assign(h.f.eligibility, { eligible: false, evidence: [], reasons: ["Required output result.md has not passed its file check."] }); await h.view.selectRun(h.f.run);
  expect(helmHost.textContent).toContain("Required output result.md"); expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull();
});

it("preserves an uncertain acceptance and reconciles without replay or resume", async () => {
  const h = await helmFixture(); await h.view.selectRun(h.f.run);
  h.f.overrides.set("work.orca.accept", () => { throw new Error("Reply lost"); }); click(helmHost, "work-accept"); await settle();
  expect(helmHost.textContent).toContain("Acceptance unconfirmed"); expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull();
  h.f.eligibility.accepted = true; h.f.eligibility.eligible = false; click(helmHost, "work-acceptance-refresh"); await settle();
  expect(helmHost.textContent).toContain("Task result accepted"); expect(h.rpc.mock.calls.filter(([method]) => method === "work.orca.accept")).toHaveLength(1);
  expect(h.rpc.mock.calls.some(([method]) => method === "work.resume")).toBe(false);
});

it("does not call a malformed acceptance acknowledgment a completed task", async () => {
  const h = await helmFixture(); await h.view.selectRun(h.f.run);
  h.f.overrides.set("work.orca.accept", () => h.f.goal); click(helmHost, "work-accept"); await settle();
  expect(helmHost.textContent).toContain("Acceptance unconfirmed"); expect(helmHost.textContent).not.toContain("Task result accepted");
});

it("invalidates cached acceptance immediately on a Work change and ignores an older success reply", async () => {
  const h = await helmFixture(); await h.view.selectRun(h.f.run); let finish!: (value: any) => void;
  h.f.overrides.set("work.orca.accept", () => new Promise(resolve => { finish = resolve; })); click(helmHost, "work-accept"); await settle();
  h.f.eligibility.eligible = false; h.f.eligibility.reasons = ["Task instructions changed; this acceptance is no longer current."];
  await h.view.refreshWorkAcceptance(); finish(h.acceptedGoal()); await settle();
  expect(helmHost.textContent).toContain("Task instructions changed"); expect(helmHost.textContent).not.toContain("Task result accepted"); expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull();
});

it("ignores late private acceptance status after switching project and profile", async () => {
  const h = await helmFixture(); let finish!: (value: any) => void;
  h.f.overrides.set("work.orca.acceptance", () => new Promise(resolve => { finish = resolve; }));
  const pending = h.view.selectRun(h.f.run); await settle();
  await h.view.open({ root: "/other", profile: "other", projects: ["/other"] });
  finish({ ...h.f.eligibility, reasons: ["Private old reason"] }); await pending;
  expect(helmHost.textContent).not.toContain("Private old reason"); expect(helmHost.textContent).not.toContain("Fix parser"); expect(helmHost.querySelector('[data-helm="work-accept"]')).toBeNull();
});

it("retains disclosure and keyboard focus through acceptance refresh and escapes output metadata", async () => {
  const h = await helmFixture(); h.f.eligibility.evidence[0].path = '<img src=x onerror="bad()">'; await h.view.selectRun(h.f.run);
  const disclosure = helmHost.querySelector<HTMLDetailsElement>(".helm-acceptance-evidence")!; disclosure.open = true;
  const refresh = helmHost.querySelector<HTMLButtonElement>('[data-helm="work-acceptance-refresh"]')!; refresh.focus(); refresh.click(); await settle();
  expect(helmHost.querySelector<HTMLDetailsElement>(".helm-acceptance-evidence")!.open).toBe(true);
  expect((document.activeElement as HTMLElement)?.dataset.helm).toBe("work-acceptance-refresh"); expect(helmHost.querySelector("img")).toBeNull();
});

it("checks an unconfirmed apply only explicitly and retains its held state until the server clears it", async () => {
  const { f, rpc } = fixture(); f.goal.sourceOperations = [{ id: "saved-operation-id", root: "/project", goal: "goal", task: "task", kind: "apply:review", started: 1, cancelled: true, state: "unconfirmed" }];
  const view = new WorkGoalsView(rpc, () => {}); await view.open(context); view.mount(workHost); await view.selectGoal("goal");
  expect(workHost.textContent).toContain("Applying reviewed changes"); expect(workHost.textContent).toContain("Outcome unconfirmed · Stop requested");
  expect(workHost.textContent).not.toContain("apply:review"); expect(workHost.textContent).not.toContain("saved-operation-id");
  expect(rpc.mock.calls.some(([method]) => method === "work.source.reconcile")).toBe(false);
  f.overrides.set("work.source.reconcile", () => ({ state: "unconfirmed" })); click(workHost, "source-reconcile", "work"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.source.reconcile", { id: "saved-operation-id", profile: "owner" }); expect(workHost.textContent).toContain("The project stays reserved");
  f.overrides.set("work.source.reconcile", () => { f.goal.sourceOperations = []; return {}; }); click(workHost, "source-reconcile", "work"); await settle();
  expect(workHost.querySelector('[data-work="source-reconcile"]')).toBeNull();
  expect(rpc.mock.calls.some(([method]) => method === "helm.integration.apply" || method === "work.resume")).toBe(false);
});

it("offers no apply reconciliation for active operations, other operation kinds, or another scope", async () => {
  const { f, rpc } = fixture(); f.goal.sourceOperations = [
    { id: "active", root: "/project", goal: "goal", task: "task", kind: "apply:review", started: 1, state: "active" },
    { id: "other-kind", root: "/project", goal: "goal", task: "task", kind: "verify:review", started: 1, state: "unconfirmed" },
    { id: "foreign", root: "/foreign", goal: "foreign", task: "task", kind: "apply:review", started: 1, state: "unconfirmed" },
  ];
  const view = new WorkGoalsView(rpc, () => {}); await view.open(context); view.mount(workHost); await view.selectGoal("goal");
  expect(workHost.textContent).toContain("In progress"); expect(workHost.querySelector('[data-work="source-reconcile"]')).toBeNull();
  expect(rpc.mock.calls.some(([method]) => method === "work.source.reconcile")).toBe(false);
});
