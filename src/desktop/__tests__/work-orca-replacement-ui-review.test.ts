// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkGoalsView } from "../ui/work-goals";
let host: HTMLElement;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  host = document.querySelector("main")!;
});
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  document.body.replaceChildren();
});
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const clone = <T>(v: T): T => structuredClone(v);
const context = {
  root: "/project",
  profile: "p",
  profiles: [{ id: "p", name: "Owner" }],
};
const button = (action: string) =>
  host.querySelector<HTMLButtonElement>(`[data-work="${action}"]`);
const click = (action: string) => {
  expect(button(action), action).not.toBeNull();
  button(action)!.click();
};
async function fixture() {
  const goal: any = {
    id: "goal",
    root: "/project",
    profile: "p",
    objective: "Review goal",
    status: "needs_review",
    tokens: 5000,
    maxTokens: 30000,
    maxMinutes: 10,
    elapsedMs: 60000,
    maxRounds: 2,
    maxConcurrent: 2,
    acceptance: [],
    tasks: [
      {
        id: "task",
        title: "Fix parser",
        prompt: "repair",
        profile: "p",
        status: "failed",
        dependsOn: [],
        engine: {
          kind: "orca",
          agent: "codex",
          requestId: "old",
          dispatchIntent: true,
        },
        reservedTokens: 10000,
        rounds: 2,
        messages: [],
        attempts: [
          {
            id: "attempt",
            number: 2,
            status: "failed",
            startedAt: 1,
            finishedAt: 2,
            reservedTokens: 10000,
            engineRequestId: "old",
          },
        ],
      },
    ],
  };
  const overrides = new Map<string, (a: any) => unknown>();
  const rpc = vi.fn(async (method: string, args: any = {}) => {
    if (overrides.has(method)) return overrides.get(method)!(args);
    if (method === "work.list") return [clone(goal)];
    if (method === "work.get") return clone(goal);
    if (method === "work.orca.replacement")
      return {
        goal: "goal",
        task: "task",
        attemptId: "attempt",
        requestId: "old",
        eligible: true,
        budget: {
          reportedTokens: 5000,
          heldTokens: 10000,
          availableTokens: 15000,
          elapsedMs: 60000,
          remainingMs: 540000,
          maxAttempts: 2,
          attemptsUsed: 2,
        },
      };
    if (method === "work.stop") {
      goal.status = "cancelled";
      return clone(goal);
    }
    if (method === "work.resume") return clone(goal);
    throw Error(method);
  });
  const view = new WorkGoalsView(
    rpc,
    () => {},
    async () => {},
  );
  cleanup.push(() => (view as any).audit?.dispose());
  await view.open(context);
  view.mount(host);
  await view.selectGoal("goal");
  return { goal, overrides, rpc, view };
}
it("plain Resume never secretly raises exhausted token, time or round limits", async () => {
  const f = await fixture();
  Object.assign(f.goal, {
    status: "budget_exhausted",
    maxTokens: 15000,
    maxMinutes: 1,
  });
  await f.view.refresh();
  click("resume");
  await settle();
  const call = f.rpc.mock.calls.find(([m]) => m === "work.resume");
  expect(call).toBeDefined();
  const args = call![1];
  expect(args.maxTokens ?? f.goal.maxTokens).toBe(15000);
  expect(args.maxMinutes ?? f.goal.maxMinutes).toBe(1);
  expect(args.maxRounds ?? f.goal.maxRounds).toBe(2);
});
it("Stop remains available during replacement and late success cannot overwrite the stopped view", async () => {
  const f = await fixture();
  let complete!: (v: any) => void;
  f.overrides.set(
    "work.orca.replace",
    () => new Promise((r) => (complete = r)),
  );
  click("orca-replacement");
  await settle();
  click("orca-replace-confirm");
  await settle();
  expect(complete).toBeTypeOf("function");
  expect(button("stop")).not.toBeNull();
  expect(button("stop")!.disabled).toBe(false);
  click("stop");
  await settle();
  expect(f.rpc.mock.calls.filter(([m]) => m === "work.stop")).toHaveLength(1);
  const late = clone(f.goal);
  late.status = "draft";
  late.tasks[0].status = "queued";
  late.tasks[0].engine = {
    ...late.tasks[0].engine,
    requestId: "successor",
    dispatchIntent: false,
  };
  late.tasks[0].orcaReplacements = [
    {
      fromRequestId: "old",
      fromAttemptId: "attempt",
      toRequestId: "successor",
      at: 3,
    },
  ];
  complete(late);
  await settle();
  expect((f.view as any).selected.status).toBe("cancelled");
  expect(
    f.rpc.mock.calls.filter(([m]) => ["work.run", "work.resume"].includes(m)),
  ).toHaveLength(0);
});
it("late eligibility cannot survive a root change even when the profile stays the same", async () => {
  const f = await fixture();
  let complete!: (v: any) => void;
  f.overrides.set(
    "work.orca.replacement",
    () => new Promise((r) => (complete = r)),
  );
  click("orca-replacement");
  await settle();
  await f.view.open({ ...context, root: "/other" });
  complete({
    goal: "goal",
    task: "task",
    attemptId: "attempt",
    requestId: "old",
    eligible: true,
    budget: {
      reportedTokens: 0,
      heldTokens: 0,
      availableTokens: 1,
      elapsedMs: 0,
      remainingMs: 1,
      maxAttempts: 2,
      attemptsUsed: 1,
    },
  });
  await settle();
  expect(button("orca-replace-confirm")).toBeNull();
  expect(f.rpc.mock.calls.some(([m]) => m === "work.orca.replace")).toBe(false);
});
it("a late replacement settlement does not unlock Resume while Stop is still pending", async () => {
  const f = await fixture();
  let replace!: (v: unknown) => void, stop!: (v: unknown) => void;
  f.overrides.set(
    "work.orca.replace",
    () =>
      new Promise((r) => {
        replace = r;
      }),
  );
  f.overrides.set(
    "work.stop",
    () =>
      new Promise((r) => {
        stop = r;
      }),
  );
  click("orca-replacement");
  await settle();
  click("orca-replace-confirm");
  await settle();
  click("stop");
  await settle();
  replace(clone(f.goal));
  await settle();
  expect(button("resume")).not.toBeNull();
  button("resume")!.click();
  await settle();
  const resumeCalls = f.rpc.mock.calls.filter(
    ([m]) => m === "work.resume",
  ).length;
  stop(clone(f.goal));
  await settle();
  expect(resumeCalls).toBe(0);
});
