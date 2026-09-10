// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkGoalsView } from "../ui/work-goals";
import { HelmOrcaView } from "../ui/helm-orca";

const context = { profile: "owner", root: "/project", profiles: [{ id: "owner", name: "Planner" }, { id: "writer", name: "Writer" }] };
const clone = <T>(value: T): T => structuredClone(value);
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let host: HTMLElement;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  document.body.innerHTML = "<main></main>"; host = document.querySelector("main")!;
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("No network in this DOM fixture"); }));
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const control = (action: string) => host.querySelector<HTMLButtonElement>(`[data-work="${action}"]`);
const click = (action: string) => { const button = control(action); expect(button, action).not.toBeNull(); button!.click(); };
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

async function fixture() {
  const goal: any = {
    id: "goal", root: "/project", profile: "owner", objective: "Finish the parser", status: "needs_review",
    tokens: 5000, maxTokens: 30000, maxMinutes: 10, elapsedMs: 60000, maxRounds: 8, maxConcurrent: 2, acceptance: [],
    tasks: [{
      id: "task", title: "Fix parser", prompt: "Repair parsing", profile: "writer", status: "failed", dependsOn: [],
      engine: { kind: "orca", agent: "codex", requestId: "old-request", dispatchIntent: true },
      reservedTokens: 10000, rounds: 2, messages: [],
      attempts: [
        { id: "first-attempt", number: 1, status: "failed", startedAt: 1, finishedAt: 2, tokens: 5000, reservedTokens: 8000 },
        { id: "old-attempt", number: 2, status: "failed", startedAt: 3, finishedAt: 4, reservedTokens: 10000, engineRequestId: "old-request" },
      ],
    }],
  };
  const inspection: any = {
    goal: "goal", task: "task", attemptId: "old-attempt", requestId: "old-request", eligible: true,
    proof: { source: "fixture-only", state: "stopped" },
    budget: { reportedTokens: 5000, heldTokens: 10000, availableTokens: 15000, elapsedMs: 60000, remainingMs: 540000, maxAttempts: 8, attemptsUsed: 2 },
  };
  const f = { goal, inspection, overrides: new Map<string, (args: any) => any>() };
  function prepare() {
    f.goal.tasks[0].engine = { ...f.goal.tasks[0].engine, requestId: "successor", dispatchIntent: false };
    f.goal.tasks[0].status = "queued";
    f.goal.tasks[0].orcaReplacements = [{ fromRequestId: "old-request", fromAttemptId: "old-attempt", toRequestId: "successor", at: 5 }];
    return clone(f.goal);
  }
  const rpc = vi.fn(async (method: string, args: any = {}): Promise<any> => {
    if (f.overrides.has(method)) return f.overrides.get(method)!(args);
    if (method === "work.list") return args.profile === "owner" ? [clone(f.goal)] : [];
    if (method === "work.get") return clone(f.goal);
    if (method === "work.orca.replacement") return clone(f.inspection);
    if (method === "work.orca.replace") return prepare();
    if (method.startsWith("work.audit.")) return {};
    throw Error("Unexpected fixture RPC: " + method);
  });
  const view = new WorkGoalsView(rpc, () => {}, vi.fn(async () => {}));
  cleanup.push(() => (view as any).audit?.dispose());
  await view.open(context); view.mount(host); await view.selectGoal("goal");
  return { f, rpc, view, prepare };
}
function noStart(rpc: ReturnType<typeof vi.fn>) {
  expect(rpc.mock.calls.some(([method]) => ["work.run", "work.resume", "helm.orca.start", "helm.integration.apply", "work.orca.accept"].includes(String(method)))).toBe(false);
}

it("keeps exhausted stored limits exact and sends no unedited Resume overrides", async () => {
  const { f, rpc, view } = await fixture();
  Object.assign(f.goal, { status: "budget_exhausted", maxTokens: 15000, maxMinutes: 1, maxRounds: 2 });
  f.overrides.set("work.resume", () => clone(f.goal));
  await view.refresh();
  for (const [name, value] of [["resumeTokens", "15000"], ["resumeMinutes", "1"], ["resumeRounds", "2"], ["resumeConcurrent", "2"]]) {
    expect(host.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value).toBe(value);
  }
  expect(host.textContent).toContain("Stored limits stay unchanged");
  click("resume"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.resume", { id: "goal", profile: "owner" });
});

it("preserves explicit limit drafts through refresh and submits only changed values", async () => {
  const { f, rpc, view } = await fixture();
  f.overrides.set("work.resume", () => clone(f.goal));
  for (const [name, value] of [["resumeRounds", "12"], ["resumeConcurrent", "3"]]) {
    const field = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    field.value = value; field.dispatchEvent(new Event("input"));
  }
  await view.refresh();
  expect(host.querySelector<HTMLInputElement>('[name="resumeRounds"]')!.value).toBe("12");
  click("resume"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.resume", { id: "goal", profile: "owner", maxRounds: 12, maxConcurrent: 3 });
});

it("drops budget edits when selecting another goal", async () => {
  const { f, rpc, view } = await fixture();
  const field = host.querySelector<HTMLInputElement>('[name="resumeTokens"]')!;
  field.value = "90000"; field.dispatchEvent(new Event("input"));
  f.goal.id = "other-goal"; await view.selectGoal("other-goal");
  f.overrides.set("work.resume", () => clone(f.goal));
  expect(host.querySelector<HTMLInputElement>('[name="resumeTokens"]')!.value).toBe("30000");
  click("resume"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.resume", { id: "other-goal", profile: "owner" });
});

it("stops pending replacement immediately and ignores a late acknowledgement until a fresh saved read", async () => {
  const { f, rpc, view, prepare } = await fixture(), pending = deferred(), stopped = deferred();
  f.overrides.set("work.orca.replace", () => pending.promise);
  f.overrides.set("work.stop", () => stopped.promise);
  click("orca-replacement"); await settle(); click("orca-replace-confirm");
  expect(control("stop")?.disabled).toBe(false);
  expect(control("stop")?.textContent).toBe("Stop preparation");
  const stop = control("stop")!; stop.click(); stop.click();
  expect(rpc.mock.calls.filter(([method]) => method === "work.stop")).toEqual([["work.stop", { id: "goal", profile: "owner" }]]);
  f.goal.status = "cancelled"; stopped.resolve(clone(f.goal)); await settle();
  expect(host.textContent).toContain("Replacement outcome unconfirmed");
  pending.resolve(prepare()); await settle();
  expect(host.textContent).not.toContain("Replacement ready");
  expect((view as any).selected.status).toBe("cancelled");
  await view.refresh(); expect(host.textContent).toContain("Replacement ready");
  noStart(rpc);
});

it("retains the Stop error and uncertain outcome without accepting late prepared output", async () => {
  const { f, rpc, prepare } = await fixture(), pending = deferred();
  f.overrides.set("work.orca.replace", () => pending.promise);
  f.overrides.set("work.stop", () => { throw Error("Stop acknowledgement lost"); });
  click("orca-replacement"); await settle(); click("orca-replace-confirm"); click("stop"); await settle();
  expect(host.textContent).toContain("Stop acknowledgement lost");
  pending.resolve(prepare()); await settle();
  expect(host.textContent).toContain("Replacement outcome unconfirmed");
  expect(host.textContent).not.toContain("Replacement ready"); noStart(rpc);
});

it("keeps cancellation controls active until both Stop and the pending request settle", async () => {
  const { f, rpc, prepare } = await fixture(), pending = deferred(), stopped = deferred();
  f.overrides.set("work.orca.replace", () => pending.promise); f.overrides.set("work.stop", () => stopped.promise);
  click("orca-replacement"); await settle(); click("orca-replace-confirm"); click("stop");
  pending.resolve(prepare()); await settle();
  expect(control("resume")?.disabled).toBe(true);
  expect(host.textContent).not.toContain("Replacement ready");
  f.goal.status = "cancelled"; stopped.resolve(clone(f.goal)); await settle();
  expect(host.textContent).toContain("Replacement ready");
  expect(control("resume")?.disabled).toBe(false); noStart(rpc);
});

it("labels replacement metadata accurately and recovers only the exact saved historical IDs", async () => {
  const { f, rpc, view, prepare } = await fixture(); prepare();
  f.goal.sourceOperations = [{ id: "metadata-claim", goal: "goal", root: "/project", task: "task", kind: "orca-replace:old-request", started: 1, cancelled: false, state: "unconfirmed" }];
  f.overrides.set("work.orca.replace", () => { f.goal.sourceOperations = []; return clone(f.goal); });
  await view.refresh();
  expect(host.textContent).toContain("Preparing a replacement worker");
  expect(host.textContent).toContain("saved worker request metadata");
  expect(host.textContent).toContain("Replacement saved");
  expect(host.textContent).not.toContain("Replacement ready");
  click("orca-replacement-reconcile"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.orca.replace", { id: "goal", task: "task", profile: "owner", expectedRequestId: "old-request", expectedAttemptId: "old-attempt" });
  expect(rpc.mock.calls.some(([method]) => method === "work.source.reconcile")).toBe(false);
  expect(host.textContent).toContain("Replacement ready"); noStart(rpc);
});

it("does not recover foreign or mismatched replacement metadata claims", async () => {
  const { f, rpc, view, prepare } = await fixture(); prepare();
  const claim = { id: "metadata", goal: "goal", root: "/project", task: "task", kind: "orca-replace:old-request", started: 1, state: "unconfirmed" };
  for (const change of [{ goal: "foreign" }, { root: "/foreign" }, { task: "foreign" }, { kind: "orca-replace:foreign" }]) {
    f.goal.sourceOperations = [{ ...claim, ...change }]; await view.refresh();
    expect(control("orca-replacement-reconcile")).toBeNull();
  }
  noStart(rpc); expect(rpc.mock.calls.some(([method]) => method === "work.orca.replace")).toBe(false);
});

it.each(["orca-replace:old-request", "apply:review"]) ("offers Stop for retained %s activity in a stopped goal", async kind => {
  const { f, rpc, view } = await fixture();
  f.goal.sourceOperations = [{ id: "claim", goal: "goal", root: "/project", task: "task", kind, started: 1, state: "active" }];
  f.overrides.set("work.stop", () => { f.goal.sourceOperations[0].cancelled = true; return clone(f.goal); });
  await view.refresh(); click("stop"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.stop", { id: "goal", profile: "owner" }); noStart(rpc);
});

it.each(["control", "operation"])("keeps another source action busy when the %s request settles first", async first => {
  const { f, view } = await fixture(), checked = deferred(), stopped = deferred();
  f.goal.sourceOperations = [{ id: "claim", goal: "goal", root: "/project", task: "task", kind: "apply:review", started: 1, state: "unconfirmed" }];
  f.overrides.set("work.source.reconcile", () => checked.promise); f.overrides.set("work.stop", () => stopped.promise);
  await view.refresh(); click("source-reconcile"); click("stop");
  (first === "control" ? stopped : checked).resolve(clone(f.goal)); await settle();
  expect(control("resume")?.disabled).toBe(true);
  (first === "control" ? checked : stopped).resolve(clone(f.goal)); await settle();
  expect(control("resume")?.disabled).toBe(false);
});

it("drops late Stop and mutation responses when changing root within the same profile", async () => {
  const { f, view, prepare, rpc } = await fixture(), pending = deferred(), stopped = deferred();
  f.overrides.set("work.orca.replace", () => pending.promise); f.overrides.set("work.stop", () => stopped.promise);
  click("orca-replacement"); await settle(); click("orca-replace-confirm"); click("stop");
  f.overrides.set("work.list", () => []); await view.open({ ...context, root: "/other" });
  stopped.resolve(clone(f.goal)); pending.resolve(prepare()); await settle();
  expect(host.textContent).not.toContain("Replacement ready");
  expect(host.textContent).not.toContain("Stop requested");
  expect(host.textContent).not.toContain("Fix parser"); noStart(rpc);
});

it("separates reported usage, held allocation, host time and historical attempt allocations", async () => {
  await fixture();
  expect(host.textContent).toContain("Reported provider tokens: 5,000");
  expect(host.textContent).toContain("Host token allocation: 30,000");
  expect(host.textContent).toContain("Host time budget: 10 min");
  expect(host.textContent).toContain("10,000 tokens reserved for calls whose usage is not yet known");
  expect(host.textContent).toContain("does not enforce an upstream provider token cap");
  const attempts = host.querySelectorAll(".work-attempt");
  expect(attempts[0].textContent).toContain("5,000 reported tokens");
  expect(attempts[0].textContent).toContain("Original allocation: 8,000 reserved tokens at admission");
  expect(attempts[0].textContent).not.toContain("currently held");
  expect(attempts[1].textContent).toContain("Usage unknown");
  expect(attempts[1].textContent).not.toContain("0 reported tokens");
  expect(host.querySelector('[name="resumeRounds"]')?.closest("label")?.textContent).toContain("Work attempts per task");
});

it("uses host allocation and Work attempt labels in the new-work form", async () => {
  await fixture(); click("back"); await settle(); click("new");
  expect(host.querySelector('[name="maxTokens"]')?.closest("label")?.textContent).toContain("Host token allocation");
  expect(host.querySelector('[name="maxMinutes"]')?.closest("label")?.textContent).toContain("Host time budget");
  expect(host.querySelector('[name="maxRounds"]')?.closest("label")?.textContent).toContain("Work attempts per task");
  expect(host.textContent).toContain("do not count an Orca agent’s internal turns");
});

it("checks exact eligibility and requires explicit confirmation before preparing, never starting", async () => {
  const { f, rpc } = await fixture();
  expect(rpc.mock.calls.some(([method]) => method === "work.orca.replacement")).toBe(false);
  click("orca-replacement"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.orca.replacement", { id: "goal", task: "task", profile: "owner" });
  expect(rpc.mock.calls.some(([method]) => method === "work.orca.replace")).toBe(false);
  expect(host.textContent).toContain("Available host allocation");
  expect(host.textContent).toContain("15,000 tokens");
  expect(host.textContent).toContain("9 min");
  expect(document.activeElement?.id).toBe("work-replacement-status-task");
  click("orca-replace-confirm"); await settle();
  expect(rpc).toHaveBeenCalledWith("work.orca.replace", { id: "goal", task: "task", profile: "owner", expectedRequestId: "old-request", expectedAttemptId: "old-attempt" });
  expect(host.textContent).toContain("Replacement ready");
  expect(host.textContent).toContain("Resume Work to start the new worker");
  expect(host.textContent).toContain("old-request → successor");
  expect(host.textContent).toContain("old-attempt");
  expect(f.goal.tasks[0].reservedTokens).toBe(10000);
  expect(f.goal.tasks[0].attempts).toHaveLength(2);
  expect(control("orca-replacement")).toBeNull();
  expect(document.activeElement?.id).toBe("work-replacement-status-task");
  noStart(rpc);
});

it("keeps unknown worker reasons visible and leaves reconciliation available without replacement", async () => {
  const { f, rpc } = await fixture();
  f.inspection.eligible = false; f.inspection.reason = "Termination is unconfirmed. Reconcile the saved request. <img src=x>";
  click("orca-replacement"); await settle();
  expect(host.textContent).toContain(f.inspection.reason);
  expect(host.querySelector("img")).toBeNull();
  expect(control("orca-replace-confirm")).toBeNull();
  expect(control("resume")).not.toBeNull();
  noStart(rpc);
});

it.each([
  { goal: "foreign" }, { task: "foreign" }, { attemptId: "foreign" },
  { requestId: "foreign" }, { eligible: "true" }, { budget: { reportedTokens: 0 } },
])("refuses mismatched or malformed inspection %j", async change => {
  const { f, rpc } = await fixture(); Object.assign(f.inspection, change);
  click("orca-replacement"); await settle();
  expect(host.textContent).toContain("did not match this task and attempt");
  expect(control("orca-replace-confirm")).toBeNull();
  expect(rpc.mock.calls.some(([method]) => method === "work.orca.replace")).toBe(false);
});

it("deduplicates inspection clicks and discards the reply after closing its panel", async () => {
  const { f, rpc } = await fixture(), pending = deferred();
  f.overrides.set("work.orca.replacement", () => pending.promise);
  const original = control("orca-replacement")!; original.click(); original.click();
  expect(rpc.mock.calls.filter(([method]) => method === "work.orca.replacement")).toHaveLength(1);
  click("orca-replacement-close"); pending.resolve(f.inspection); await settle();
  expect(host.querySelector('[aria-label="Prepare Orca replacement"]')).toBeNull();
  expect(control("orca-replace-confirm")).toBeNull();
});

it.each(["profile", "root"])("ignores private inspection replies after a %s switch", async kind => {
  const { f, view } = await fixture(), pending = deferred();
  f.overrides.set("work.orca.replacement", () => pending.promise);
  click("orca-replacement");
  f.overrides.set("work.list", () => []);
  await view.open({ ...context, [kind]: "/other" });
  pending.resolve({ ...f.inspection, eligible: false, reason: "Private prior result" }); await settle();
  expect(host.textContent).not.toContain("Private prior result");
  expect(host.textContent).not.toContain("Fix parser");
  expect(control("orca-replace-confirm")).toBeNull();
});

it("invalidates an older inspection immediately when Work refreshes", async () => {
  const { f, rpc, view } = await fixture(), pending = deferred();
  f.overrides.set("work.orca.replacement", () => pending.promise);
  click("orca-replacement"); await view.refresh();
  pending.resolve(f.inspection); await settle();
  expect(host.textContent).toContain("Work changed. Check replacement status again.");
  expect(control("orca-replace-confirm")).toBeNull();
  f.overrides.delete("work.orca.replacement"); f.inspection.eligible = false; f.inspection.reason = "Host allocation is exhausted.";
  click("orca-replacement"); await settle();
  expect(host.textContent).toContain("Host allocation is exhausted"); noStart(rpc);
});

it("deduplicates confirmation while preserving exact expected identities", async () => {
  const { f, rpc, prepare } = await fixture(), pending = deferred();
  click("orca-replacement"); await settle();
  f.overrides.set("work.orca.replace", () => pending.promise);
  const original = control("orca-replace-confirm")!; original.click(); original.click();
  expect(rpc.mock.calls.filter(([method]) => method === "work.orca.replace")).toHaveLength(1);
  pending.resolve(prepare()); await settle();
  expect(host.textContent).toContain("Replacement ready"); noStart(rpc);
});

it("reconciles a lost mutation acknowledgement through saved history without replay", async () => {
  const { f, rpc, view, prepare } = await fixture();
  click("orca-replacement"); await settle();
  f.overrides.set("work.orca.replace", () => { prepare(); throw Error("Acknowledgement lost"); });
  click("orca-replace-confirm"); await settle();
  expect(host.textContent).toContain("Replacement outcome unconfirmed");
  expect(control("orca-replace-confirm")).toBeNull();
  await view.refresh();
  expect(host.textContent).toContain("Replacement ready");
  expect(rpc.mock.calls.filter(([method]) => method === "work.orca.replace")).toHaveLength(1);
  noStart(rpc);
});

it("does not accept a changed engine without the exact saved replacement linkage", async () => {
  const { f, rpc } = await fixture();
  click("orca-replacement"); await settle();
  f.overrides.set("work.orca.replace", () => {
    const result = clone(f.goal); result.tasks[0].engine.requestId = "successor"; result.tasks[0].engine.dispatchIntent = false; return result;
  });
  click("orca-replace-confirm"); await settle();
  expect(host.textContent).toContain("replacement reply was not confirmed");
  expect(host.textContent).not.toContain("Replacement ready"); noStart(rpc);
});

it("discards a late mutation reply after profile change", async () => {
  const { f, rpc, view, prepare } = await fixture(), pending = deferred();
  click("orca-replacement"); await settle(); f.overrides.set("work.orca.replace", () => pending.promise);
  click("orca-replace-confirm"); await view.open({ ...context, profile: "other" });
  pending.resolve(prepare()); await settle();
  expect(host.textContent).not.toContain("Replacement ready"); expect(host.textContent).not.toContain("Fix parser"); noStart(rpc);
});

it("keeps a refreshed in-flight mutation unconfirmed until saved history is reloaded", async () => {
  const { f, rpc, view, prepare } = await fixture(), pending = deferred();
  click("orca-replacement"); await settle(); f.overrides.set("work.orca.replace", () => pending.promise);
  click("orca-replace-confirm"); await view.refresh();
  pending.resolve(prepare()); await settle();
  expect(host.textContent).toContain("Replacement outcome unconfirmed");
  expect(host.textContent).not.toContain("Preparing replacement…");
  await view.refresh(); expect(host.textContent).toContain("Replacement ready"); noStart(rpc);
});

it("does not offer replacement for active, completed, undispatched or historical attempts", async () => {
  const { f, view, rpc } = await fixture();
  f.goal.status = "running"; await view.refresh(); expect(control("orca-replacement")).toBeNull();
  f.goal.status = "needs_review"; f.goal.tasks[0].status = "completed"; await view.refresh(); expect(control("orca-replacement")).toBeNull();
  f.goal.tasks[0].status = "failed"; f.goal.tasks[0].engine.dispatchIntent = false; await view.refresh(); expect(control("orca-replacement")).toBeNull();
  f.goal.tasks[0].engine.dispatchIntent = true; f.goal.tasks[0].attempts.at(-1).status = "running"; await view.refresh(); expect(control("orca-replacement")).toBeNull();
  noStart(rpc);
});

it("names Orca worker capacity as a slot separately from Work token allocation", async () => {
  const row = { root: "/project", profile: "owner", id: "worker", state: "stopped", active: false, input: { prompt: "Inspect parser", agent: "codex" }, dispatchId: "dispatch" };
  const rpc = vi.fn(async (method: string) => method === "helm.orca.info" ? { state: "packaged" } : method === "helm.orca.list" ? [row] : row);
  const view = new HelmOrcaView(rpc); cleanup.push(() => view.dispose());
  view.setScope(context); view.mount(host); await view.open();
  host.querySelector<HTMLButtonElement>('[data-orca="select"]')!.click(); await settle();
  expect(host.textContent).toContain("Worker slot"); expect(host.textContent).not.toContain("Worker reservation");
  expect(host.textContent).toContain("Released");
});

async function orcaForm() {
  const rpc = vi.fn(async (method: string, args: any = {}) => {
    if (method === "helm.orca.info") return { state: "packaged" };
    if (method === "helm.orca.list") return [];
    return { root: context.root, profile: context.profile, id: args.requestId, state: "unknown", active: true, input: clone(args) };
  });
  const view = new HelmOrcaView(rpc); cleanup.push(() => view.dispose());
  view.setScope(context); view.mount(host); await view.open();
  const fill = (name: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#orca-${name}`)!;
    input.value = value; input.dispatchEvent(new Event("input"));
  };
  const submit = () => host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  return { rpc, view, fill, submit };
}

it("uses the Helm provider default and never forwards a stale model after switching agents", async () => {
  const { rpc, fill, submit } = await orcaForm();
  fill("prompt", "Repair parser"); fill("model", "requested-codex-model");
  fill("agent", "opencode");
  expect(host.querySelector("#orca-model")).toBeNull();
  expect(host.textContent).toContain("Uses the provider default in this Orca version");
  submit(); await settle();
  const args = rpc.mock.calls.find(([method]) => method === "helm.orca.start")![1];
  expect(args).toMatchObject({ agent: "opencode", prompt: "Repair parser" });
  expect(args).not.toHaveProperty("model");
});

it("clears the hidden model choice when returning to an override-capable agent", async () => {
  const { rpc, fill, submit } = await orcaForm();
  fill("prompt", "Repair parser"); fill("model", "old-choice");
  fill("agent", "opencode"); fill("agent", "claude");
  expect(host.querySelector<HTMLInputElement>("#orca-model")!.value).toBe("");
  fill("model", "new-choice"); submit(); await settle();
  expect(rpc.mock.calls.find(([method]) => method === "helm.orca.start")![1]).toMatchObject({ agent: "claude", model: "new-choice" });
});

it("preserves an already-retained request's exact input during retry", async () => {
  const { rpc, view, submit } = await orcaForm();
  const pending = { requestId: "retained", prompt: "Retained task", agent: "opencode", model: "historical-choice" };
  const state = (view as any).state;
  state.agent = pending.agent; state.model = pending.model; state.prompt = pending.prompt; state.pending = clone(pending);
  (view as any).render();
  expect(host.querySelector<HTMLInputElement>("#orca-model")!.disabled).toBe(true);
  submit(); await settle();
  expect(rpc.mock.calls.find(([method]) => method === "helm.orca.start")![1]).toEqual({ root: context.root, profile: context.profile, ...pending });
});
