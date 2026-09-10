import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { executeWorkOrca } from "../core/work-orca";
import {
  HelmOrcaService,
  type HelmOrcaRecord,
} from "../core/helm-orca-service";
import type { WorkExecution } from "../core/durable-work";
afterEach(() => vi.useRealTimers());
it("authority guard failure after recovery revokes and stops the exact owned worker once", async () => {
  let revoked = false;
  const record = {
    id: "request",
    state: "ready",
    active: true,
  } as HelmOrcaRecord;
  const service = {
    list: vi.fn(() => [record]),
    start: vi.fn(),
    recover: vi.fn(async () => {
      revoked = true;
      return record;
    }),
    status: vi.fn(),
    stop: vi.fn(async () => ({ ...record, state: "stopped" as const })),
  };
  const input = {
    root: "/fixture",
    profile: "p",
    prompt: "test",
    maxRuntimeMs: 10000,
    engine: {
      kind: "orca",
      agent: "codex",
      requestId: "request",
      dispatchIntent: true,
    },
    assertActive() {
      if (revoked) throw Error("Work lease revoked");
    },
    markDispatchIntent() {},
  } as unknown as WorkExecution;
  await expect(
    executeWorkOrca(
      { service, preflight() {} },
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Work lease revoked");
  expect(service.stop).toHaveBeenCalledExactlyOnceWith(
    { root: "/fixture", profile: "p" },
    "request",
  );
  expect(service.status).not.toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
});
it("an actual retained service operation stays maintenance-visible after caller timeout until its late reply settles", async () => {
  vi.useFakeTimers();
  const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "orca-deadline-review-")),
    ),
    scope = { root: dir, profile: "p" };
  let pending = false,
    resolve!: (v: any) => void;
  const call = vi.fn(async (method: string): Promise<any> => {
    if (method === "orchestration.runCreate") return { run: { id: "run" } };
    if (method === "orchestration.workerStart")
      return { state: "ready", dispatchId: "dispatch" };
    if (method === "orchestration.workerShow")
      return {
        dispatch: { id: "dispatch" },
        worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", startOptions: { baseBranch: "a".repeat(40) } },
        observation: { exactWorker: true, status: "exited" },
      };
    if (method === "orchestration.requestShow") {
      pending = true;
      return new Promise((r) => (resolve = r));
    }
    throw Error(method);
  });
  const service = new HelmOrcaService(join(dir, "state"), {
    resolveBase: async () => "a".repeat(40),
    connect: async () => ({
      runtimeId: "runtime",
      repo: "repo",
      coordinator: "coordinator",
      call,
    }),
  });
  try {
    const requestId = randomUUID();
    await service.start(scope, { requestId, prompt: "test", agent: "codex" });
    const before = await service.status(scope, requestId);
    expect(before.active).toBe(false);
    const input = {
      ...scope,
      prompt: "test",
      maxRuntimeMs: 100,
      engine: { kind: "orca", agent: "codex", requestId, dispatchIntent: true },
      assertActive() {},
      markDispatchIntent() {},
    } as unknown as WorkExecution;
    const result = executeWorkOrca(
        { service, preflight() {} },
        input,
        new AbortController().signal,
      ),
      rejected = expect(result).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(pending).toBe(true);
    const visible = service.hasActiveWork();
    resolve({ requestId: before.requestId, state: "absent" });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.hasActiveWork()).toBe(false);
    await service.close();
    expect(visible).toBe(true);
  } finally {
    if (resolve) resolve({ requestId: "ignored", state: "absent" });
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
