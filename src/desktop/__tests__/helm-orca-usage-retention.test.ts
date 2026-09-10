import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HelmOrcaService } from "../core/helm-orca-service";
const dirs: string[] = [];
const services: HelmOrcaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function page(tokens = 2, eventId = "event") {
  const observation = {
    provider: "claude",
    identity: {
      sessionId: "session",
      runtimeId: "local",
      dispatchId: "message",
      acquisitionGeneration: "acq",
      fence: 7,
      providerSessionId: "provider",
      turnId: null,
    },
    eventId,
    scope: "provider-result",
    aggregation: "unknown",
    inputTokens: tokens,
    outputTokens: 3,
    reportedCostUsd: null,
    reportedTurns: null,
    cache: {
      readTokens: null,
      creationTokens: null,
      relationToInput: "unknown",
    },
    completeness: "partial",
  };
  return {
    version: 1,
    dispatchId: "dispatch",
    aggregation: "unknown",
    state: "available",
    sessionId: "session",
    observations: [
      {
        observation,
        observedAt: 1,
        observationKey: hash([
          "claude",
          eventId,
          "session",
          "provider",
          "message",
          "local",
          "acq",
          null,
        ]),
        payloadHash: hash(observation),
        conflict: false,
      },
    ],
    conflict: false,
    truncated: false,
  };
}
async function fixture(agent: "claude" | "codex" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "hades-usage-"));
  dirs.push(root);
  const scope = { root, profile: "profile" },
    directory = join(root, "state");
  const call = vi.fn(
    async (method: string): Promise<any> =>
      method === "orchestration.runCreate"
        ? { run: { id: "run" } }
        : { state: "ready", dispatchId: "dispatch" },
  );
  const options = {
    connect: async () => ({
      runtimeId: "runtime",
      repo: "repo",
      coordinator: "coordinator",
      call,
    }),
    resolveBase: async () => "a".repeat(40),
  };
  const service = new HelmOrcaService(directory, options);
  services.push(service);
  const record = await service.start(scope, {
    requestId: randomUUID(),
    prompt: "Task",
    agent,
  });
  const response = (usage: unknown = page()) => ({
    dispatch: {
      id: "dispatch",
      runId: "run",
      processIncarnation: "structured:session",
      hostScope: { kind: "local", hostId: "local" },
      assigneeHandle: "structworker_handle",
    },
    worker: {
      dispatchId: "dispatch",
      runtimeEpoch: "runtime",
      agentTerminalHandle: "structworker_handle",
      startOptions: { baseBranch: record.baseSha },
    },
    observation: { exactWorker: true, status: "live" },
    usage,
  });
  const poll = async (value: unknown) => {
    call.mockResolvedValue(value);
    return service.status(scope, record.id);
  };
  return { service, scope, record, call, response, poll, directory, options };
}
it("retains once across duplicate polls and a real database reopen", async () => {
  const f = await fixture();
  await f.poll(f.response());
  await f.poll(f.response());
  expect(f.service.usage(f.scope, f.record.id)).toMatchObject({
    state: "available",
    observations: [{ observation: { inputTokens: 2 } }],
    nextOffset: null,
  });
  await f.service.close();
  const next = new HelmOrcaService(f.directory, f.options);
  services.push(next);
  const retained = next.usage(f.scope, f.record.id) as any;
  expect(retained.observations).toHaveLength(1);
  expect(retained).not.toHaveProperty("totalTokens");
});
it("retains contradictory observations even when separate pages omit remote conflict flags", async () => {
  const f = await fixture();
  await f.poll(f.response(page(2)));
  await f.poll(f.response(page(9)));
  const retained = f.service.usage(f.scope, f.record.id) as any;
  expect(retained.conflict).toBe(true);
  expect(retained.observations).toHaveLength(2);
  expect(retained.observations.every((r: any) => r.conflict)).toBe(true);
});
it("preserves evidence on unavailable and malformed later polls without storing private usage fields", async () => {
  const f = await fixture();
  await f.poll(f.response());
  await f.poll(
    f.response({
      version: 1,
      dispatchId: "dispatch",
      aggregation: "unknown",
      state: "unavailable",
      reason: "journal_unavailable",
    }),
  );
  expect(f.service.usage(f.scope, f.record.id)).toMatchObject({
    lastRead: { state: "unavailable" },
    observations: [{}],
  });
  const record = await f.poll(
    f.response({ ...page(), privateProviderSecret: "DO_NOT_RETAIN" }),
  );
  expect(record.usageStatus?.state).toBe("malformed");
  expect(JSON.stringify(record)).not.toContain("DO_NOT_RETAIN");
  expect(record.receipt).not.toHaveProperty("usage");
  expect(
    (f.service.usage(f.scope, f.record.id) as any).observations,
  ).toHaveLength(1);
});
it.each(["runtime", "base", "run", "handle", "remote", "session", "exact"])(
  "refuses %s authority substitution",
  async (field) => {
    const f = await fixture();
    const result = f.response();
    if (field === "runtime") result.worker.runtimeEpoch = "other";
    if (field === "base")
      result.worker.startOptions.baseBranch = "b".repeat(40);
    if (field === "run") result.dispatch.runId = "other";
    if (field === "handle") result.dispatch.assigneeHandle = "other";
    if (field === "remote") result.dispatch.hostScope.kind = "ssh";
    if (field === "session")
      result.dispatch.processIncarnation = "structured:other";
    if (field === "exact") result.observation.exactWorker = false;
    await f.poll(result);
    expect(f.service.usage(f.scope, f.record.id)).toMatchObject({
      state: "mismatch",
    });
  },
);
it("does not expose another profile or permit session repinning", async () => {
  const f = await fixture();
  await f.poll(f.response());
  expect(() =>
    f.service.usage({ ...f.scope, profile: "other" }, f.record.id),
  ).toThrow("owned");
  const result = f.response();
  result.dispatch.processIncarnation = "structured:replacement";
  await f.poll(result);
  expect(f.service.usage(f.scope, f.record.id)).toMatchObject({
    sessionId: "session",
    lastRead: { state: "mismatch" },
  });
});
it("rolls back evidence when a concurrent status wins the intent revision", async () => {
  const f = await fixture();
  let reply!: (value: any) => void;
  const waiting = new Promise<void>((resolve) =>
    f.call.mockImplementationOnce(async () => {
      resolve();
      return new Promise((r) => {
        reply = r;
      });
    }),
  );
  const stale = f.service.status(f.scope, f.record.id);
  await waiting;
  await f.poll(f.response(page(2, "accepted")));
  reply(f.response(page(5, "stale")));
  await expect(stale).rejects.toThrow("revision changed");
  const retained = f.service.usage(f.scope, f.record.id) as any;
  expect(retained.observations.map((r: any) => r.observation.eventId)).toEqual([
    "accepted",
  ]);
});
it("old runtimes remain unsupported without manufacturing zero usage", async () => {
  const f = await fixture();
  const result = f.response();
  delete (result as any).usage;
  await f.poll(result);
  const retained = f.service.usage(f.scope, f.record.id);
  expect(retained).toMatchObject({ state: "unsupported" });
  expect(retained).not.toHaveProperty("observations");
});

it("retained pagination stays bounded and exposes upstream truncation independently", async () => {
  const f = await fixture();
  for (let n = 0; n < 101; n++) {
    const report = page(2, `event-${String(n).padStart(3, "0")}`);
    report.truncated = true;
    await f.poll(f.response(report));
  }
  const first = f.service.usage(f.scope, f.record.id) as any,
    second = f.service.usage(f.scope, f.record.id, first.nextOffset) as any;
  expect(first.observations).toHaveLength(100);
  expect(first.nextOffset).toBe(100);
  expect(first.lastRead.truncated).toBe(true);
  expect(second.observations).toHaveLength(1);
  expect(second.nextOffset).toBeNull();
  expect(second.lastRead.truncated).toBe(true);
  expect(() => f.service.usage(f.scope, f.record.id, -1)).toThrow("offset");
});

it("rejects evidence for a different provider or execution host", async () => {
  const codex = await fixture("codex");
  await codex.poll(codex.response());
  expect(codex.service.usage(codex.scope, codex.record.id)).toMatchObject({
    state: "mismatch",
  });
  const local = await fixture();
  const result = local.response();
  result.dispatch.hostScope.hostId = "different-host";
  await local.poll(result);
  expect(local.service.usage(local.scope, local.record.id)).toMatchObject({
    state: "mismatch",
  });
});
