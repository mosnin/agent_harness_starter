import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableWork, type WorkExecution } from "../core/durable-work";
import { executeWorkOrca, type WorkOrcaHost } from "../core/work-orca";
import {
  HelmOrcaService,
  type HelmOrcaRecord,
} from "../core/helm-orca-service";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function host() {
  let records: HelmOrcaRecord[] = [];
  const service = {
    list: vi.fn(() => records),
    start: vi.fn(async (scope: any, input: any) => {
      const r = {
        ...scope,
        id: input.requestId,
        input,
        state: "unknown",
        active: true,
        stage: "dispatch",
      } as HelmOrcaRecord;
      records.push(r);
      return r;
    }),
    recover: vi.fn(async () => records[0]),
    status: vi.fn(async () => ({
      ...records[0],
      state: "needs_review" as const,
      active: false,
    })),
    stop: vi.fn(async () => ({
      ...records[0],
      state: "stopped" as const,
      active: false,
    })),
  };
  const h: WorkOrcaHost = { service, preflight: vi.fn(), wait: async () => {} };
  return {
    h,
    service,
    set: (r: HelmOrcaRecord[]) => {
      records = r;
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
    prompt: "Fixture",
    attemptId: randomUUID(),
    engine: { kind: "orca", agent: "codex", requestId: randomUUID() },
    maxTokens: 1000,
    maxRuntimeMs: 1000,
    assertActive: vi.fn(),
    markDispatchIntent: vi.fn(),
  };
}
for (let trial = 1; trial <= 3; trial++) {
  it(`retains one intent after lost acknowledgement and only reconciles on restart trial ${trial}`, async () => {
    const f = host(),
      i = input();
    i.markDispatchIntent = () => {
      if (i.engine?.kind === "orca") i.engine.dispatchIntent = true;
    };
    const first = await executeWorkOrca(f.h, i, new AbortController().signal);
    expect(Number.isNaN(first.tokens)).toBe(true);
    const restarted = structuredClone({
      ...i,
      assertActive: undefined,
      markDispatchIntent: undefined,
    });
    await executeWorkOrca(
      f.h,
      {
        ...restarted,
        assertActive: () => {},
        markDispatchIntent: () => {
          throw Error("must not allocate");
        },
      },
      new AbortController().signal,
    );
    expect(f.service.start).toHaveBeenCalledTimes(1);
    expect(f.service.recover).toHaveBeenCalledTimes(1);
  });
  it(`crash after durable intent but before service allocation never dispatches trial ${trial}`, async () => {
    const f = host(),
      i = input();
    if (i.engine?.kind === "orca") i.engine.dispatchIntent = true;
    await expect(
      executeWorkOrca(f.h, i, new AbortController().signal),
    ).rejects.toThrow("no acknowledged");
    expect(f.service.start).not.toHaveBeenCalled();
  });
}
it("missing artifacts fail before marking or dispatch without fallback", async () => {
  const f = host(),
    i = input();
  f.h.preflight = () => {
    throw Error("Missing packaged Orca");
  };
  await expect(
    executeWorkOrca(f.h, i, new AbortController().signal),
  ).rejects.toThrow("Missing");
  expect(i.markDispatchIntent).not.toHaveBeenCalled();
  expect(f.service.start).not.toHaveBeenCalled();
});
it("ready then exited requires review and unknown usage, never success", async () => {
  const f = host(),
    i = input();
  if (i.engine?.kind !== "orca") throw Error();
  f.set([{ id: i.engine.requestId, state: "ready" } as HelmOrcaRecord]);
  const result = await executeWorkOrca(f.h, i, new AbortController().signal);
  expect(result.error).toContain("unchecked");
  expect(Number.isNaN(result.tokens)).toBe(true);
  expect(f.service.status).toHaveBeenCalledOnce();
});
it("cancellation after dispatch stops only the owned UUID", async () => {
  const f = host(),
    i = input(),
    c = new AbortController();
  if (i.engine?.kind !== "orca") throw Error();
  f.set([{ id: i.engine.requestId, state: "ready" } as HelmOrcaRecord]);
  f.h.wait = async () => {
    c.abort();
    c.signal.throwIfAborted();
  };
  await expect(executeWorkOrca(f.h, i, c.signal)).rejects.toThrow();
  expect(f.service.stop).toHaveBeenCalledExactlyOnceWith(
    { root: i.root, profile: i.profile },
    i.engine.requestId,
  );
});
it("durable engine intent and attempt survive reopen; unknown usage blocks dependent completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-orca-review-"));
  const f = host();
  let work: DurableWork;
  const deps = {
    profile: () => {},
    root: () => dir,
    execute: (i: WorkExecution, s: AbortSignal) => executeWorkOrca(f.h, i, s),
  };
  work = new DurableWork(join(dir, "work.db"), deps);
  cleanup.push(() => {
    work.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const goal = work.create(
    {
      root: dir,
      objective: "Fixture",
      tasks: [
        {
          id: "a",
          title: "Build",
          prompt: "Build",
          engine: { kind: "orca", agent: "codex" },
        },
        { id: "b", title: "Check", prompt: "Check", dependsOn: ["a"] },
      ],
      maxTokens: 4000,
    },
    "owner",
  );
  work.run(goal.id, "owner");
  for (
    let n = 0;
    n < 40 && work.get(goal.id, "owner").status === "running";
    n++
  )
    await new Promise((r) => setTimeout(r, 2));
  const saved = work.get(goal.id, "owner");
  expect(["needs_review", "budget_exhausted"]).toContain(saved.status);
  expect(saved.tasks[1].status).toBe("queued");
  expect(saved.tokens).toBe(0);
  expect(saved.tasks[0].reservedTokens).toBeGreaterThan(0);
  expect(saved.tasks[0].attempts![0].engineRequestId).toBe(
    (saved.tasks[0].engine as any).requestId,
  );
  work.close();
  work = new DurableWork(join(dir, "work.db"), deps);
  work.resume(goal.id, "owner");
  for (
    let n = 0;
    n < 40 && work.get(goal.id, "owner").status === "running";
    n++
  )
    await new Promise((r) => setTimeout(r, 2));
  expect(f.service.start).toHaveBeenCalledTimes(1);
  expect(f.service.recover).toHaveBeenCalledTimes(1);
});

it("refuses caller-selected request identity before persisting a Work task", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-orca-authority-"));
  const work = new DurableWork(join(dir, "work.db"), {
    profile: () => {},
    root: () => dir,
    execute: async () => ({ answer: "", tokens: 0 }),
  });
  cleanup.push(() => {
    work.close();
    rmSync(dir, { recursive: true, force: true });
  });
  expect(() =>
    work.create(
      {
        root: dir,
        objective: "Fixture",
        tasks: [
          {
            title: "Build",
            prompt: "Build",
            engine: { kind: "orca", agent: "codex", requestId: randomUUID() },
          },
        ],
      },
      "owner",
    ),
  ).toThrow("authority");
  expect(work.list("owner")).toEqual([]);
});

for (let trial = 1; trial <= 3; trial++)
  it(`actual Orca journal lost worker acknowledgement reconciles without workerStart replay ${trial}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "work-orca-journal-"));
    const i = input();
    i.root = dir;
    let calls = 0;
    const connect = async () => ({
      runtimeId: "fixture-runtime",
      coordinator: "fixture-coordinator",
      repo: "fixture-repo",
      call: async (method: string, _params: any, options?: any) => {
        if (method === "orchestration.runCreate")
          return { run: { id: "fixture-run" } };
        if (method === "orchestration.workerStart") {
          calls++;
          throw Error("Lost worker acknowledgement");
        }
        if (method === "orchestration.requestShow")
          return { requestId: _params.request, state: "unknown" };
        throw Error("Unexpected " + method);
      },
    });
    let service = new HelmOrcaService(join(dir, "orca"), { connect, resolveBase: async () => 'a'.repeat(40) });
    i.markDispatchIntent = () => {
      if (i.engine?.kind === "orca") i.engine.dispatchIntent = true;
    };
    try {
      await executeWorkOrca(
        { service, preflight: () => {} },
        i,
        new AbortController().signal,
      );
      await service.close();
      service = new HelmOrcaService(join(dir, "orca"), { connect, resolveBase: async () => 'a'.repeat(40) });
      const result = await executeWorkOrca(
        { service, preflight: () => {} },
        i,
        new AbortController().signal,
      );
      expect(result.error).toContain("unknown");
      expect(calls).toBe(1);
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
