import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HelmOrcaService } from "../core/helm-orca-service";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-replace-"))),
    directory = join(root, "state"),
    scope = { root, profile: "p" },
    input = {
      requestId: randomUUID(),
      prompt: "fixture",
      agent: "codex" as const,
    },
    base = "a".repeat(40);
  const call = vi.fn(
    async (method: string): Promise<any> =>
      method === "orchestration.runCreate"
        ? { run: { id: "run" } }
        : method === "orchestration.workerStart"
          ? { state: "ready", dispatchId: "dispatch" }
          : {
              dispatch: { id: "dispatch" },
              worker: {
                dispatchId: "dispatch",
                runtimeEpoch: "runtime",
                startOptions: { baseBranch: base },
              },
              observation: { exactWorker: true, status: "exited" },
            },
  );
  const connection = {
    runtimeId: "runtime",
    repo: "repo",
    coordinator: "coordinator",
    call,
  };
  const options = {
    connect: async () => connection,
    resolveBase: async () => base,
  };
  const service = new HelmOrcaService(directory, options),
    services = [service];
  cleanup.push(async () => {
    await Promise.all(services.map((s) => s.close()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    directory,
    scope,
    input,
    call,
    connection,
    service,
    other() {
      const next = new HelmOrcaService(directory, options);
      services.push(next);
      return next;
    },
  };
}
it("seals queued predispatch owner and prevents its late workerStart", async () => {
  const f = fixture();
  let finish!: (value: any) => void;
  f.call.mockImplementation(async (method) => {
    if (method === "orchestration.runCreate")
      return new Promise((r) => (finish = r));
    throw Error("Must not dispatch");
  });
  const starting = f.service.start(f.scope, f.input);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const inspected = await f
    .other()
    .inspectReplacement(f.scope, f.input.requestId);
  expect(inspected).toMatchObject({
    eligible: true,
    proof: { kind: "undispatched", stage: "run" },
  });
  const seal = await f.other().sealForReplacement(f.scope, f.input.requestId);
  finish({ run: { id: "late-run" } });
  expect((await starting).replacementSeal).toEqual(seal);
  expect(f.call.mock.calls.map((c) => c[0])).toEqual([
    "orchestration.runCreate",
  ]);
  expect(f.service.get(f.scope, f.input.requestId).active).toBe(false);
});
it("simultaneous seals choose one successor and reopening returns it without more calls", async () => {
  const f = fixture();
  await f.service.start(f.scope, f.input);
  const other = f.other();
  const [a, b] = await Promise.all([
    f.service.sealForReplacement(f.scope, f.input.requestId),
    other.sealForReplacement(f.scope, f.input.requestId),
  ]);
  expect(a).toEqual(b);
  expect(a.successorId).not.toBe(a.requestId);
  expect(a.proof.kind).toBe("exited");
  const count = f.call.mock.calls.length;
  const reopened = f.other();
  expect(await reopened.sealForReplacement(f.scope, f.input.requestId)).toEqual(
    a,
  );
  expect((await reopened.start(f.scope, f.input)).replacementSeal).toEqual(a);
  expect(
    (await reopened.recover(f.scope, f.input.requestId)).replacementSeal,
  ).toEqual(a);
  expect(
    (await reopened.status(f.scope, f.input.requestId)).replacementSeal,
  ).toEqual(a);
  expect(
    (await reopened.stop(f.scope, f.input.requestId)).replacementSeal,
  ).toEqual(a);
  expect(f.call).toHaveBeenCalledTimes(count);
});
it.each(["runtime", "dispatch", "worker", "base", "live", "inexact"])(
  "refuses unconfirmed exited identity: %s",
  async (kind) => {
    const f = fixture();
    await f.service.start(f.scope, f.input);
    if (kind === "runtime") f.connection.runtimeId = "foreign";
    else
      f.call.mockResolvedValue({
        dispatch: { id: kind === "dispatch" ? "foreign" : "dispatch" },
        worker: {
          dispatchId: kind === "worker" ? "foreign" : "dispatch",
          runtimeEpoch: "runtime",
          startOptions: {
            baseBranch: kind === "base" ? "b".repeat(40) : "a".repeat(40),
          },
        },
        observation: {
          exactWorker: kind !== "inexact",
          status: kind === "live" ? "live" : "exited",
        },
      });
    expect(
      (await f.service.inspectReplacement(f.scope, f.input.requestId)).eligible,
    ).toBe(false);
    await expect(
      f.service.sealForReplacement(f.scope, f.input.requestId),
    ).rejects.toThrow();
    expect(
      f.service.get(f.scope, f.input.requestId).replacementSeal,
    ).toBeUndefined();
  },
);
it("missing receipt, foreign scope and unknown dispatch stay unsealed", async () => {
  const f = fixture();
  await expect(
    f.service.inspectReplacement(f.scope, randomUUID()),
  ).rejects.toThrow("owned");
  f.call.mockImplementation(async (method) => {
    if (method === "orchestration.runCreate") return { run: { id: "run" } };
    throw Error("Lost dispatch ack");
  });
  await f.service.start(f.scope, f.input);
  expect(
    (await f.service.inspectReplacement(f.scope, f.input.requestId)).eligible,
  ).toBe(false);
  await expect(
    f.service.sealForReplacement(
      { ...f.scope, profile: "foreign" },
      f.input.requestId,
    ),
  ).rejects.toThrow("owned");
  expect(f.service.get(f.scope, f.input.requestId).active).toBe(true);
});
it("abort or authority revocation at final seal mutation preserves old active record", async () => {
  const f = fixture();
  await f.service.start(f.scope, f.input);
  const c = new AbortController();
  let count = 0;
  await expect(
    f.service.sealForReplacement(f.scope, f.input.requestId, c.signal, () => {
      if (++count === 3) c.abort();
    }),
  ).rejects.toThrow();
  expect(
    f.service.get(f.scope, f.input.requestId).replacementSeal,
  ).toBeUndefined();
  expect(f.service.get(f.scope, f.input.requestId).active).toBe(true);
});
it("unsupported OpenCode model consumes no intent or runtime call", async () => {
  const f = fixture();
  await expect(
    f.service.start(f.scope, {
      ...f.input,
      agent: "opencode",
      model: "custom",
    }),
  ).rejects.toThrow("OpenCode model selection is unsupported");
  expect(f.service.list(f.scope)).toEqual([]);
  expect(f.call).not.toHaveBeenCalled();
});
it("late pre-seal status response cannot overwrite the retirement seal", async () => {
  const f = fixture();
  await f.service.start(f.scope, f.input);
  let finish!: (v: any) => void;
  let calls = 0;
  f.call.mockImplementation(async () =>
    ++calls === 1
      ? new Promise((r) => (finish = r))
      : {
          dispatch: { id: "dispatch" },
          worker: {
            dispatchId: "dispatch",
            runtimeEpoch: "runtime",
            startOptions: { baseBranch: "a".repeat(40) },
          },
          observation: { exactWorker: true, status: "exited" },
        },
  );
  const status = f.service.status(f.scope, f.input.requestId);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const seal = await f.other().sealForReplacement(f.scope, f.input.requestId);
  finish({
    dispatch: { id: "dispatch" },
    observation: { exactWorker: true, status: "live" },
  });
  expect((await status).replacementSeal).toEqual(seal);
  expect(f.service.get(f.scope, f.input.requestId).active).toBe(false);
});
