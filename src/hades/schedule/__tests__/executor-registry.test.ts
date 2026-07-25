import { describe, expect, test, vi } from "vitest";

import { ExecutorRegistry } from "../executor-registry";
import { InMemoryJobStore, type ScheduledJob } from "../store";
import { ManualClock } from "../clock";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "../runner";

import { BuiltinNoteExecutor } from "../../cli/schedule-command";
import { SwarmJobExecutor, SWARM_TASK_KIND } from "../swarm-executor";
import { echoEngine, type GatewayAgentEngine } from "../../gateway/agent-handler";
import { probeGatewayEngine, type EngineProbe } from "../../gateway/engine-select";

import { VerifiedDeliveryRouter } from "../delivery";
import { InMemoryConnector } from "../../gateway/in-memory-connector";
import { ConformalGate, type CalibrationPoint, type GateDecision } from "../../styx/gate";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../styx/certificate";

// ===========================================================================
// Fixtures
// ===========================================================================

function newStore(): InMemoryJobStore {
  return new InMemoryJobStore(new ManualClock(1_700_000_000_000));
}

function makeJob(
  store: InMemoryJobStore,
  kind: string,
  input = "hello",
  overrides: Partial<{ delivery: { platform: string; user: string } }> = {},
): ScheduledJob {
  return store.add({
    name: "test job",
    cron: "0 9 * * *",
    task: { kind, input },
    delivery: overrides.delivery,
  });
}

function ctx(overrides: Partial<JobExecutionContext> = {}): JobExecutionContext {
  return { scheduledFor: 1_700_000_100_000, firedAt: 1_700_000_100_000, manual: false, ...overrides };
}

function stubExecutor(
  impl: (job: ScheduledJob, c: JobExecutionContext) => Promise<JobExecutionResult>,
): JobExecutor {
  return { execute: impl };
}

// ===========================================================================
// register()
// ===========================================================================

describe("ExecutorRegistry.register", () => {
  test("throws on an empty-string kind", () => {
    const reg = new ExecutorRegistry();
    expect(() => reg.register("", stubExecutor(async () => ({ ok: true, output: "" })))).toThrow(
      'ExecutorRegistry.register: kind must be a non-empty, non-whitespace string, got ""',
    );
  });

  test("throws on a whitespace-only kind", () => {
    const reg = new ExecutorRegistry();
    expect(() => reg.register("   ", stubExecutor(async () => ({ ok: true, output: "" })))).toThrow(
      'ExecutorRegistry.register: kind must be a non-empty, non-whitespace string, got "   "',
    );
  });

  test("throws on a duplicate kind, even with a different executor instance", () => {
    const reg = new ExecutorRegistry();
    reg.register("note", stubExecutor(async () => ({ ok: true, output: "first" })));
    expect(() => reg.register("note", stubExecutor(async () => ({ ok: true, output: "second" })))).toThrow(
      'ExecutorRegistry.register: an executor is already registered for kind "note"',
    );
    // The original registration must survive the failed second attempt.
    expect(reg.kinds()).toEqual(["note"]);
  });

  test("does not throw for two DIFFERENT kinds", () => {
    const reg = new ExecutorRegistry();
    reg.register("note", stubExecutor(async () => ({ ok: true, output: "" })));
    expect(() => reg.register("swarm.goal", stubExecutor(async () => ({ ok: true, output: "" })))).not.toThrow();
  });
});

// ===========================================================================
// kinds() / has()
// ===========================================================================

describe("ExecutorRegistry.kinds / has", () => {
  test("kinds() is empty for a fresh registry", () => {
    expect(new ExecutorRegistry().kinds()).toEqual([]);
  });

  test("kinds() returns registration keys sorted lexicographically", () => {
    const reg = new ExecutorRegistry();
    reg.register("zeta", stubExecutor(async () => ({ ok: true, output: "" })));
    reg.register("alpha", stubExecutor(async () => ({ ok: true, output: "" })));
    reg.register("mid.kind", stubExecutor(async () => ({ ok: true, output: "" })));
    expect(reg.kinds()).toEqual(["alpha", "mid.kind", "zeta"]);
  });

  test("has() is case-sensitive and exact", () => {
    const reg = new ExecutorRegistry();
    reg.register("Note", stubExecutor(async () => ({ ok: true, output: "" })));
    expect(reg.has("Note")).toBe(true);
    expect(reg.has("note")).toBe(false);
    expect(reg.has("Not")).toBe(false);
  });
});

// ===========================================================================
// execute() — unknown kind
// ===========================================================================

describe("ExecutorRegistry.execute — unknown kind", () => {
  test("empty registry: detail names the unknown kind and '(none registered)'", async () => {
    const reg = new ExecutorRegistry();
    const store = newStore();
    const job = makeJob(store, "mystery.kind");
    const result = await reg.execute(job, ctx());
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'ExecutorRegistry: no executor registered for task kind "mystery.kind" (registered kinds: (none registered))',
    });
  });

  test("populated registry: detail lists every registered kind sorted", async () => {
    const reg = new ExecutorRegistry();
    reg.register("zeta", stubExecutor(async () => ({ ok: true, output: "" })));
    reg.register("alpha", stubExecutor(async () => ({ ok: true, output: "" })));
    const store = newStore();
    const job = makeJob(store, "mystery.kind");
    const result = await reg.execute(job, ctx());
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'ExecutorRegistry: no executor registered for task kind "mystery.kind" (registered kinds: "alpha", "zeta")',
    });
  });

  test("routing is case-sensitive: 'Note' registered does not match 'note' job", async () => {
    const reg = new ExecutorRegistry();
    reg.register("Note", stubExecutor(async () => ({ ok: true, output: "wrong-match" })));
    const store = newStore();
    const job = makeJob(store, "note");
    const result = await reg.execute(job, ctx());
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      'ExecutorRegistry: no executor registered for task kind "note" (registered kinds: "Note")',
    );
  });
});

// ===========================================================================
// execute() — successful routing + verification pass-through
// ===========================================================================

describe("ExecutorRegistry.execute — successful delegate", () => {
  test("routes to the delegate registered for the job's exact kind", async () => {
    const reg = new ExecutorRegistry();
    let seenJobId: string | undefined;
    reg.register(
      "digest",
      stubExecutor(async (job) => {
        seenJobId = job.id;
        return { ok: true, output: `digested: ${job.task.input}` };
      }),
    );
    const store = newStore();
    const job = makeJob(store, "digest", "the news");
    const result = await reg.execute(job, ctx());
    expect(seenJobId).toBe(job.id);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("digested: the news");
  });

  test("verification field is passed through byte-identical (same reference) when present", async () => {
    const verification: JobExecutionResult["verification"] = {
      decision: { emit: true, score: 0.9, threshold: 0.5, pCorrectEstimate: 0.95 },
    };
    const delegateResult: JobExecutionResult = {
      ok: true,
      output: "hi",
      detail: "from delegate",
      verification,
    };
    const reg = new ExecutorRegistry();
    reg.register("note", stubExecutor(async () => delegateResult));
    const store = newStore();
    const job = makeJob(store, "note");
    const result = await reg.execute(job, ctx());
    expect(result).toBe(delegateResult);
    expect(result.verification).toBe(verification);
  });

  test("verification field is NEVER synthesized when the delegate omitted it", async () => {
    const delegateResult: JobExecutionResult = { ok: true, output: "hi", detail: "no evidence here" };
    const reg = new ExecutorRegistry();
    reg.register("note", stubExecutor(async () => delegateResult));
    const store = newStore();
    const job = makeJob(store, "note");
    const result = await reg.execute(job, ctx());
    expect("verification" in result).toBe(false);
    expect(result.verification).toBeUndefined();
  });
});

// ===========================================================================
// execute() — delegate throws (sync AND rejected promise)
// ===========================================================================

describe("ExecutorRegistry.execute — delegate throws", () => {
  test("a SYNCHRONOUS throw from the delegate is caught and mapped to ok:false; onError fires", async () => {
    const onError = vi.fn();
    const reg = new ExecutorRegistry({ onError });
    const throwingExecutor: JobExecutor = {
      execute(): Promise<JobExecutionResult> {
        throw new Error("kaboom-sync");
      },
    };
    reg.register("throws-sync", throwingExecutor);
    const store = newStore();
    const job = makeJob(store, "throws-sync");
    const c = ctx();
    const result = await reg.execute(job, c);
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'ExecutorRegistry: executor registered for task kind "throws-sync" threw: kaboom-sync',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(job.id, "throws-sync", "kaboom-sync");
  });

  test("a REJECTED promise from the delegate is caught and mapped to ok:false; onError fires", async () => {
    const onError = vi.fn();
    const reg = new ExecutorRegistry({ onError });
    reg.register(
      "throws-async",
      stubExecutor(async () => {
        throw new Error("kaboom-async");
      }),
    );
    const store = newStore();
    const job = makeJob(store, "throws-async");
    const result = await reg.execute(job, ctx());
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'ExecutorRegistry: executor registered for task kind "throws-async" threw: kaboom-async',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(job.id, "throws-async", "kaboom-async");
  });

  test("a non-Error throw (e.g. a plain string) is stringified honestly", async () => {
    const onError = vi.fn();
    const reg = new ExecutorRegistry({ onError });
    const throwingExecutor: JobExecutor = {
      execute(): Promise<JobExecutionResult> {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain-string-failure";
      },
    };
    reg.register("throws-string", throwingExecutor);
    const store = newStore();
    const job = makeJob(store, "throws-string");
    const result = await reg.execute(job, ctx());
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'ExecutorRegistry: executor registered for task kind "throws-string" threw: plain-string-failure',
    });
    expect(onError).toHaveBeenCalledWith(job.id, "throws-string", "plain-string-failure");
  });

  test("execute() itself never throws, even without an onError handler configured", async () => {
    const reg = new ExecutorRegistry();
    reg.register(
      "throws-no-handler",
      stubExecutor(async () => {
        throw new Error("no one is listening");
      }),
    );
    const store = newStore();
    const job = makeJob(store, "throws-no-handler");
    await expect(reg.execute(job, ctx())).resolves.toMatchObject({ ok: false });
  });
});

// ===========================================================================
// Interop: the REAL BuiltinNoteExecutor + a REAL SwarmJobExecutor, both
// routed through one registry.
// ===========================================================================

describe("ExecutorRegistry — interop with real executors", () => {
  test("routes 'note' to BuiltinNoteExecutor and 'swarm.goal' to SwarmJobExecutor correctly", async () => {
    const reg = new ExecutorRegistry();
    reg.register("note", new BuiltinNoteExecutor());

    const probe: EngineProbe = probeGatewayEngine({});
    reg.register(SWARM_TASK_KIND, new SwarmJobExecutor({ engine: echoEngine(), probe }));

    const store = newStore();
    const noteJob = makeJob(store, "note", "hello world");
    const swarmJob = makeJob(store, SWARM_TASK_KIND, "do the thing");

    const noteResult = await reg.execute(noteJob, ctx());
    expect(noteResult.ok).toBe(true);
    expect(noteResult.output).toBe("hello world");
    expect("verification" in noteResult).toBe(false);

    const swarmResult = await reg.execute(swarmJob, ctx());
    expect(swarmResult.ok).toBe(true);
    expect(swarmResult.output.startsWith("[mock] ")).toBe(true);
    expect(swarmResult.verification).toBeUndefined();
    expect(swarmResult.detail).toContain("engine=mock");

    // A kind neither executor claims is still an honest, sorted failure.
    const strayJob = makeJob(store, "unregistered.kind");
    const strayResult = await reg.execute(strayJob, ctx());
    expect(strayResult).toEqual({
      ok: false,
      output: "",
      detail: `ExecutorRegistry: no executor registered for task kind "unregistered.kind" (registered kinds: "note", "swarm.goal")`,
    });
  });
});

// ===========================================================================
// End-to-end honesty proof: a registry-wrapped SwarmJobExecutor result run
// through the REAL VerifiedDeliveryRouter. Real evidence -> "delivered" with
// a verified badge line. A mock engine's result -> ALWAYS "abstained" — a
// mock scheduled job can never be delivered as verified, by construction.
// ===========================================================================

describe("ExecutorRegistry + SwarmJobExecutor + VerifiedDeliveryRouter — honesty proof", () => {
  const GATE_EPSILON = 0.1;
  // SYNTHETIC calibration set (>= the gate's default minCalibration of 20),
  // not derived from any real benchmark run — see ../../styx/gate.ts.
  const SYNTHETIC_CALIBRATION: CalibrationPoint[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ score: 0.8 + i * 0.001, correct: true })),
    ...Array.from({ length: 10 }, (_, i) => ({ score: 0.1 + i * 0.01, correct: false })),
  ];
  const gate = new ConformalGate({ epsilon: GATE_EPSILON });
  gate.calibrate(SYNTHETIC_CALIBRATION);

  function emitDecision(): GateDecision {
    const d = gate.decide(0.99);
    if (!d.emit) throw new Error("test fixture bug: score did not clear the calibrated threshold");
    return d;
  }

  function fixedRng(fill: number): (bytes: number) => Uint8Array {
    return (bytes: number) => new Uint8Array(bytes).fill(fill);
  }
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(73)));

  async function realVerificationFor(outputText: string, decision: GateDecision) {
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(outputText),
      taskId: "sched-swarm-goal-e2e",
      verifierTier: "T2-genrm",
      ensembleScore: decision.score,
      pCorrect: decision.pCorrectEstimate,
      epsilon: GATE_EPSILON,
      traceSha256: sha256Hex(JSON.stringify({ steps: [{ tool: "exec", ok: true }] })),
      verifierVersions: ["genrm@test-1"],
      issuedAt: 1_700_000_000_000,
    };
    return ca.issue(payload);
  }

  test("real evidence: engine result flows through registry -> real router -> 'delivered' with a verified badge", async () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "compute the quarterly summary", {
      delivery: { platform: "generic", user: "operator" },
    });

    const outputText = "Q3 revenue is up 12% quarter over quarter.";
    const decision = emitDecision();
    const certificate = await realVerificationFor(outputText, decision);

    const realEngine: GatewayAgentEngine = {
      mode: "real",
      async respond() {
        return { text: outputText, decision, certificate };
      },
    };
    const probe: EngineProbe = { requested: "swarm", mode: "real", detail: 'real verified swarm engine active via ANTHROPIC_API_KEY, model "test-model"' };

    const registry = new ExecutorRegistry();
    registry.register(SWARM_TASK_KIND, new SwarmJobExecutor({ engine: realEngine, probe }));

    const execCtx = ctx();
    const execResult = await registry.execute(job, execCtx);
    expect(execResult.ok).toBe(true);
    expect(execResult.verification).toBeDefined();

    const connector = new InMemoryConnector("generic");
    const router = new VerifiedDeliveryRouter({ senders: [connector], clock: new ManualClock(1_700_000_200_000) });

    const receipt = await router.deliver(job, execResult, execCtx);
    expect(receipt.outcome).toBe("delivered");
    expect(receipt.badge).toBe("verified");
    expect(receipt.deliveredText).toContain(outputText);
    expect(receipt.deliveredText).toContain("badge: verified");
    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.text).toBe(receipt.deliveredText);
  });

  test("mock engine: a scheduled job can NEVER be delivered as verified — always 'abstained'", async () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "compute the quarterly summary", {
      delivery: { platform: "generic", user: "operator" },
    });

    const probe: EngineProbe = probeGatewayEngine({});
    const registry = new ExecutorRegistry();
    registry.register(SWARM_TASK_KIND, new SwarmJobExecutor({ engine: echoEngine(), probe }));

    const execCtx = ctx();
    const execResult = await registry.execute(job, execCtx);
    expect(execResult.ok).toBe(true);
    expect(execResult.verification).toBeUndefined();

    const connector = new InMemoryConnector("generic");
    const router = new VerifiedDeliveryRouter({ senders: [connector], clock: new ManualClock(1_700_000_200_000) });

    const receipt = await router.deliver(job, execResult, execCtx);
    expect(receipt.outcome).toBe("abstained");
    expect(receipt.badge).toBe("unverified");
    // The raw (unverified) mock output must NEVER be the delivered text.
    expect(receipt.deliveredText).not.toContain(execResult.output);
    expect(connector.sent).toHaveLength(1);
  });
});
