import { afterEach, expect, it, vi } from "vitest";
import { executeWorkOrca, type WorkOrcaHost } from "../core/work-orca";
import type { WorkExecution } from "../core/durable-work";
import type { HelmOrcaRecord } from "../core/helm-orca-service";
afterEach(() => vi.useRealTimers());
for (const held of ["start", "recover", "status"] as const) {
  for (const cause of ["deadline", "abort"] as const) {
    it(`bounds held ${held} on ${cause}, ignores late replies and requests one owned Stop`, async () => {
      vi.useFakeTimers();
      let resolve!: (record: HelmOrcaRecord) => void;
      const pending = new Promise<HelmOrcaRecord>(r => { resolve = r; });
      const record = { id: "request", state: "ready", active: true } as HelmOrcaRecord;
      const records: HelmOrcaRecord[] = held === "start" ? [] : [record];
      const service = {
        list: vi.fn(() => records),
        start: vi.fn(async () => { records.push(record); return pending; }),
        recover: vi.fn(() => held === "recover" ? pending : Promise.resolve(record)),
        status: vi.fn(() => pending),
        stop: vi.fn(() => new Promise<HelmOrcaRecord>(() => {})),
      };
      const input = { root: "/fixture", profile: "owner", prompt: "work", maxRuntimeMs: 100,
        engine: { kind: "orca", agent: "codex", requestId: "request", dispatchIntent: held !== "start" },
        assertActive: vi.fn(), markDispatchIntent: vi.fn(),
      } as unknown as WorkExecution;
      const host: WorkOrcaHost = { service, preflight: vi.fn(), wait: async () => {} };
      const controller = new AbortController();
      const result = executeWorkOrca(host, input, controller.signal);
      const rejected = expect(result).rejects.toThrow(cause === "deadline" ? "deadline" : "cancelled");
      await vi.advanceTimersByTimeAsync(0);
      expect(service[held]).toHaveBeenCalledTimes(1);
      if (cause === "abort") controller.abort(new Error("cancelled"));
      else await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(service.stop).toHaveBeenCalledTimes(1);
      const statusCalls = service.status.mock.calls.length;
      resolve(record);
      await vi.advanceTimersByTimeAsync(500);
      expect(service.stop).toHaveBeenCalledTimes(1);
      expect(service.status).toHaveBeenCalledTimes(statusCalls);
      expect(service.start).toHaveBeenCalledTimes(held === "start" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
}
it("does not invent Stop for a missing retained intent", async () => {
  const service = { list: () => [], start: vi.fn(), recover: vi.fn(), status: vi.fn(), stop: vi.fn() };
  const input = { root: "/fixture", profile: "owner", maxRuntimeMs: 100, engine: { kind: "orca", requestId: "missing", dispatchIntent: true }, assertActive() {}, markDispatchIntent() {} } as unknown as WorkExecution;
  await expect(executeWorkOrca({ service, preflight() {} }, input, new AbortController().signal)).rejects.toThrow("no acknowledged");
  expect(service.stop).not.toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
});
it("stops a late-published owned start once without replaying or waiting for Stop", async () => {
  vi.useFakeTimers();
  let resolve!: (r: HelmOrcaRecord) => void;
  const pending = new Promise<HelmOrcaRecord>(r => { resolve = r; });
  const records: HelmOrcaRecord[] = [];
  const service = { list: () => records, start: vi.fn(() => pending), recover: vi.fn(), status: vi.fn(), stop: vi.fn(() => new Promise<HelmOrcaRecord>(() => {})) };
  const input = { root: "/fixture", profile: "owner", maxRuntimeMs: 100, engine: { kind: "orca", agent: "codex", requestId: "late" }, assertActive() {}, markDispatchIntent() {} } as unknown as WorkExecution;
  const result = executeWorkOrca({ service, preflight() {} }, input, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(service.stop).not.toHaveBeenCalled();
  const record = { id: "late", state: "ready" } as HelmOrcaRecord;
  records.push(record); resolve(record);
  await vi.advanceTimersByTimeAsync(0);
  expect(service.stop).toHaveBeenCalledExactlyOnceWith({ root: "/fixture", profile: "owner" }, "late");
  expect(service.status).not.toHaveBeenCalled();
  expect(service.start).toHaveBeenCalledTimes(1);
});
