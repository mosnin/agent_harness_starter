import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableWork, type WorkExecution } from "../core/durable-work";
import { executeWorkOrca, type WorkOrcaHost } from "../core/work-orca";
import type { HelmOrcaRecord } from "../core/helm-orca-service";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const tick = () => new Promise((r) => setTimeout(r, 2));
async function settled(work: DurableWork, id: string) {
  for (let n = 0; n < 100 && work.get(id, "owner").status === "running"; n++)
    await tick();
  await tick();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "work-orca-independent-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function host() {
  let records: HelmOrcaRecord[] = [];
  const service = {
    list: vi.fn((scope: { root: string; profile: string }) =>
      records.filter(
        (r) => r.root === scope.root && r.profile === scope.profile,
      ),
    ),
    start: vi.fn(
      async (
        scope: { root: string; profile: string },
        data: { requestId: string },
      ) => {
        const row = {
          ...scope,
          id: data.requestId,
          state: "unknown",
          active: true,
          error: "Lost acknowledgement",
        } as HelmOrcaRecord;
        records.push(row);
        return row;
      },
    ),
    recover: vi.fn(
      async (scope: { root: string; profile: string }, id: string) => {
        const row = records.find(
          (r) =>
            r.id === id && r.root === scope.root && r.profile === scope.profile,
        );
        if (!row) throw Error("No scoped receipt");
        return row;
      },
    ),
    status: vi.fn(async () => records[0]),
    stop: vi.fn(async () => records[0]),
  };
  return {
    service,
    h: { service, preflight: () => {}, wait: async () => {} } as WorkOrcaHost,
    set: (v: HelmOrcaRecord[]) => {
      records = v;
    },
  };
}
function input(): WorkExecution {
  return {
    goal: "goal",
    task: "task",
    profile: "owner",
    owner: "owner",
    root: "/fixture",
    prompt: "Review",
    attemptId: randomUUID(),
    engine: { kind: "orca", agent: "codex", requestId: randomUUID() },
    maxTokens: 1000,
    maxRuntimeMs: 1000,
    assertActive: () => {},
    markDispatchIntent: () => {},
  };
}
it.each([
  { orcaFirst: true, slots: 1 },
  { orcaFirst: true, slots: 2 },
  { orcaFirst: false, slots: 2 },
])(
  "independent Hades admission survives Orca preflight failure: %j",
  async ({ orcaFirst, slots }) => {
    const dir = fixture(),
      executed: string[] = [];
    const work = new DurableWork(join(dir, "work.sqlite"), {
      root: () => dir,
      profile: () => {},
      preflight: () => {
        throw Error("Fixture Orca artifact missing");
      },
      execute: async (i) => {
        executed.push(i.task);
        return { answer: "Independent inspection complete", tokens: 1 };
      },
    });
    cleanup.unshift(() => work.close());
    const tasks = [
      {
        id: "orca",
        title: "Orca",
        prompt: "Unavailable",
        engine: { kind: "orca", agent: "codex" },
        writes: [],
      },
      {
        id: "hades",
        title: "Hades",
        prompt: "Inspect independently",
        writes: [],
      },
    ];
    const goal = work.create(
      {
        root: dir,
        objective: "Mixed engines",
        maxConcurrent: slots,
        tasks: orcaFirst ? tasks : tasks.reverse(),
      },
      "owner",
    );
    work.run(goal.id, "owner");
    await settled(work, goal.id);
    expect(executed).toEqual(["hades"]);
    const saved = work.get(goal.id, "owner");
    expect(saved.tasks.find((t) => t.id === "hades")!.status).toBe("completed");
    const failed = saved.tasks.find((t) => t.id === "orca")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Fixture Orca artifact missing");
    expect(failed.rounds).toBe(0);
    expect(failed.attempts ?? []).toHaveLength(0);
    expect(failed.reservedTokens ?? 0).toBe(0);
  },
);
it("abort exactly after durable intent cannot call start or manufacture a stop receipt", async () => {
  const f = host(),
    i = input(),
    controller = new AbortController();
  i.markDispatchIntent = () => {
    if (i.engine?.kind === "orca") i.engine.dispatchIntent = true;
    controller.abort(Error("Stopped at durable boundary"));
  };
  await expect(executeWorkOrca(f.h, i, controller.signal)).rejects.toThrow(
    "Stopped at durable boundary",
  );
  expect(f.service.start).not.toHaveBeenCalled();
  expect(f.service.stop).not.toHaveBeenCalled();
  await expect(
    executeWorkOrca(f.h, i, new AbortController().signal),
  ).rejects.toThrow("no acknowledged service record");
  expect(f.service.start).not.toHaveBeenCalled();
});
it("restored request identity never reconciles a record belonging to another profile", async () => {
  const f = host(),
    i = input();
  if (i.engine?.kind !== "orca") throw Error();
  i.engine.dispatchIntent = true;
  f.set([
    {
      id: i.engine.requestId,
      root: i.root,
      profile: "foreign",
      state: "ready",
    } as HelmOrcaRecord,
  ]);
  await expect(
    executeWorkOrca(f.h, i, new AbortController().signal),
  ).rejects.toThrow("no acknowledged service record");
  expect(f.service.start).not.toHaveBeenCalled();
  expect(f.service.recover).not.toHaveBeenCalled();
  expect(f.service.stop).not.toHaveBeenCalled();
});
it("restart reconciliation preserves unknown reservation and requires explicit additional rounds", async () => {
  const dir = fixture(),
    f = host(),
    deps = {
      root: () => dir,
      profile: () => {},
      execute: (i: WorkExecution, s: AbortSignal) => executeWorkOrca(f.h, i, s),
    };
  let work = new DurableWork(join(dir, "work.sqlite"), deps);
  cleanup.unshift(() => work.close());
  const goal = work.create(
    {
      root: dir,
      objective: "Unknown Orca",
      maxTokens: 1000,
      maxRounds: 1,
      tasks: [
        {
          id: "orca",
          title: "Orca",
          prompt: "Inspect",
          engine: { kind: "orca", agent: "codex" },
          writes: [],
        },
      ],
    },
    "owner",
  );
  work.run(goal.id, "owner");
  await settled(work, goal.id);
  const reservation = work.get(goal.id, "owner").tasks[0].reservedTokens;
  expect(reservation).toBe(1000);
  work.close();
  work = new DurableWork(join(dir, "work.sqlite"), deps);
  work.resume(goal.id, "owner");
  await settled(work, goal.id);
  expect(f.service.start).toHaveBeenCalledTimes(1);
  expect(f.service.recover).not.toHaveBeenCalled();
  work.resume(goal.id, "owner", { maxRounds: 2 });
  await settled(work, goal.id);
  const task = work.get(goal.id, "owner").tasks[0];
  expect(f.service.start).toHaveBeenCalledTimes(1);
  expect(f.service.recover).toHaveBeenCalledTimes(1);
  expect(task.reservedTokens).toBe(reservation);
  expect(task.attempts?.at(-1)?.reservedTokens).toBe(0);
  expect(task.rounds).toBe(2);
  expect(task.status).not.toBe("completed");
});
