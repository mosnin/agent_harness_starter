import { describe, expect, test } from "vitest";

import { SwarmJobExecutor, SWARM_TASK_KIND, scheduledTurn } from "../swarm-executor";
import { InMemoryJobStore, type ScheduledJob } from "../store";
import { ManualClock } from "../clock";
import type { JobExecutionContext } from "../runner";

import { echoEngine, type AgentTurnResult, type GatewayAgentEngine } from "../../gateway/agent-handler";
import { probeGatewayEngine, type EngineProbe } from "../../gateway/engine-select";

import { ConformalGate, type CalibrationPoint, type GateDecision } from "../../styx/gate";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  verifyCertificate,
  type CertificatePayload,
  type VerificationCertificate,
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
  input = "run the goal",
  delivery?: { platform: string; user: string },
): ScheduledJob {
  return store.add({
    name: "swarm-goal job",
    cron: "0 9 * * *",
    task: { kind, input },
    delivery,
  });
}

function ctx(overrides: Partial<JobExecutionContext> = {}): JobExecutionContext {
  return { scheduledFor: 1_700_000_100_000, firedAt: 1_700_000_100_000, manual: false, ...overrides };
}

/** A manual timer seam: `setTimeoutFn`/`clearTimeoutFn` that never touch the
 *  real event loop. `fire()` synchronously invokes the last-scheduled
 *  callback, exactly as if the timeout had elapsed — no wall-clock sleep
 *  anywhere in this file. */
function fakeTimerSeam() {
  let scheduledCb: (() => void) | undefined;
  let clearCount = 0;
  const setTimeoutFn = (cb: () => void, _ms: number): unknown => {
    scheduledCb = cb;
    return "fake-timer-handle";
  };
  const clearTimeoutFn = (_h: unknown): void => {
    clearCount += 1;
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire: (): void => {
      scheduledCb?.();
    },
    clearCount: (): number => clearCount,
  };
}

// ===========================================================================
// scheduledTurn — pure, deterministic
// ===========================================================================

describe("scheduledTurn", () => {
  test("builds the exact locked AgentTurn shape", () => {
    const store = newStore();
    const job = store.add({
      name: "n",
      cron: "0 9 * * *",
      task: { kind: SWARM_TASK_KIND, input: "do the thing" },
      delivery: { platform: "slack", user: "u1" },
    });
    const c: JobExecutionContext = { scheduledFor: 1_700_000_500_000, firedAt: 1_700_000_600_000, manual: false };
    const turn = scheduledTurn(job, c);
    expect(turn).toEqual({
      sessionId: `sched:${job.id}:1700000500000`,
      identityId: `sched:${job.id}`,
      platform: "scheduler",
      user: "u1",
      text: "do the thing",
      switchedChannel: false,
    });
  });

  test("is pure: same job + same ctx -> identical AgentTurn on every call", () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal text");
    const c = ctx();
    const t1 = scheduledTurn(job, c);
    const t2 = scheduledTurn(job, c);
    expect(t2).toEqual(t1);
  });

  test("different scheduledFor -> different sessionId (same job, same identityId)", () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal text");
    const c1 = ctx({ scheduledFor: 1_700_000_100_000 });
    const c2 = ctx({ scheduledFor: 1_700_000_200_000 });
    const t1 = scheduledTurn(job, c1);
    const t2 = scheduledTurn(job, c2);
    expect(t1.sessionId).not.toBe(t2.sessionId);
    expect(t1.identityId).toBe(t2.identityId);
  });

  test("no delivery target -> user defaults to 'scheduler'", () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal text");
    const turn = scheduledTurn(job, ctx());
    expect(turn.user).toBe("scheduler");
  });

  test("firedAt does not participate in sessionId — only scheduledFor does", () => {
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal text");
    const t1 = scheduledTurn(job, ctx({ scheduledFor: 5, firedAt: 100 }));
    const t2 = scheduledTurn(job, ctx({ scheduledFor: 5, firedAt: 999 }));
    expect(t1.sessionId).toBe(t2.sessionId);
  });
});

// ===========================================================================
// execute() — task-kind gate
// ===========================================================================

describe("SwarmJobExecutor.execute — task kind gate", () => {
  test("rejects any task kind other than 'swarm.goal' honestly", async () => {
    const probe: EngineProbe = probeGatewayEngine({});
    const executor = new SwarmJobExecutor({ engine: echoEngine(), probe });
    const store = newStore();
    const job = makeJob(store, "note", "irrelevant");
    const result = await executor.execute(job, ctx());
    expect(result).toEqual({
      ok: false,
      output: "",
      detail: 'SwarmJobExecutor: task kind "note" is not "swarm.goal"; this executor only handles swarm goal tasks',
    });
  });

  test("accepts exactly SWARM_TASK_KIND", () => {
    expect(SWARM_TASK_KIND).toBe("swarm.goal");
  });
});

// ===========================================================================
// execute() — echoEngine (the honest mock) path
// ===========================================================================

describe("SwarmJobExecutor.execute — echoEngine path", () => {
  test("ok:true, output prefixed '[mock] ', NO verification field, detail names the mock engine", async () => {
    const probe: EngineProbe = probeGatewayEngine({}); // requested "echo", mode "mock"
    expect(probe.mode).toBe("mock");
    const executor = new SwarmJobExecutor({ engine: echoEngine(), probe });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "summarize my inbox");
    const c = ctx();
    const result = await executor.execute(job, c);

    const expectedTurn = scheduledTurn(job, c);
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("[mock] ")).toBe(true);
    expect(result.output).toBe(`[mock] ${expectedTurn.sessionId.slice(0, 8)} summarize my inbox`);
    // The mapping formula always sets the `verification` key (to `undefined`
    // when the engine returned neither a decision nor a certificate) rather
    // than omitting it — checked by value, not by `in`, for that reason.
    expect(result.verification).toBeUndefined();
    expect(result.detail).toBe(`engine=mock (${probe.detail})`);
  });
});

// ===========================================================================
// execute() — certified real-shape engine path (REAL certificate authority)
// ===========================================================================

describe("SwarmJobExecutor.execute — certified real engine path", () => {
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
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(211)));

  async function certFor(outputText: string, decision: GateDecision): Promise<VerificationCertificate> {
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(outputText),
      taskId: "swarm-goal-test",
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

  test("attaches a real, independently-verifiable certificate on success", async () => {
    const outputText = "the answer is 42";
    const decision = emitDecision();
    const certificate = await certFor(outputText, decision);

    const engine: GatewayAgentEngine = {
      mode: "real",
      async respond(): Promise<AgentTurnResult> {
        return { text: outputText, decision, certificate };
      },
    };
    const probe: EngineProbe = {
      requested: "swarm",
      mode: "real",
      detail: 'real verified swarm engine active via ANTHROPIC_API_KEY, model "test-model"',
    };
    const executor = new SwarmJobExecutor({ engine, probe });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "compute the answer");
    const result = await executor.execute(job, ctx());

    expect(result.ok).toBe(true);
    expect(result.output).toBe(outputText);
    expect(result.detail).toBe(`engine=real (${probe.detail})`);
    expect(result.verification).toBeDefined();
    expect(result.verification!.decision).toBe(decision);
    expect(result.verification!.certificate).toBe(certificate);

    // The signature is ACTUALLY checked here — no fabricated evidence.
    const signatureValid = await verifyCertificate(result.verification!.certificate!);
    expect(signatureValid).toBe(true);
  });

  test("a decision-without-certificate result still attaches verification honestly", async () => {
    const decision = emitDecision();
    const engine: GatewayAgentEngine = {
      mode: "real",
      async respond(): Promise<AgentTurnResult> {
        return { text: "partial result, no certificate issued", decision };
      },
    };
    const probe: EngineProbe = { requested: "swarm", mode: "real", detail: "real engine, no cert this turn" };
    const executor = new SwarmJobExecutor({ engine, probe });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal");
    const result = await executor.execute(job, ctx());

    expect(result.ok).toBe(true);
    expect(result.verification).toBeDefined();
    expect(result.verification!.decision).toBe(decision);
    expect(result.verification!.certificate).toBeUndefined();
  });

  test("a certificate over a DIFFERENT output text fails verification (sanity: real crypto, not fabricated)", async () => {
    const decision = emitDecision();
    const certificate = await certFor("the real committed answer", decision);
    // certifiesOutput-style check: this test proves the certificate is bound
    // to specific text, not accepted for any text.
    const { certifiesOutput } = await import("../../styx/certificate");
    const matchesWrongText = await certifiesOutput(certificate, "a different answer entirely");
    expect(matchesWrongText).toBe(false);
    const matchesRealText = await certifiesOutput(certificate, "the real committed answer");
    expect(matchesRealText).toBe(true);
  });
});

// ===========================================================================
// execute() — respond() rejection
// ===========================================================================

describe("SwarmJobExecutor.execute — engine.respond() rejection", () => {
  test("maps a rejection to ok:false carrying the real error message", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(): Promise<AgentTurnResult> {
        throw new Error("engine exploded");
      },
    };
    const probe: EngineProbe = { requested: "echo", mode: "mock", detail: "d" };
    const executor = new SwarmJobExecutor({ engine, probe });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal");
    const result = await executor.execute(job, ctx());
    expect(result).toEqual({ ok: false, output: "", detail: "engine exploded" });
  });

  test("a non-Error rejection is stringified honestly", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond(): Promise<AgentTurnResult> {
        return Promise.reject("string rejection");
      },
    };
    const probe: EngineProbe = { requested: "echo", mode: "mock", detail: "d" };
    const executor = new SwarmJobExecutor({ engine, probe });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal");
    const result = await executor.execute(job, ctx());
    expect(result).toEqual({ ok: false, output: "", detail: "string rejection" });
  });
});

// ===========================================================================
// execute() — timeout path, driven entirely by the injected timer seam
// ===========================================================================

describe("SwarmJobExecutor.execute — timeout path (no wall-clock sleeps)", () => {
  test("times out honestly when the engine never resolves before the injected timer fires", async () => {
    const seam = fakeTimerSeam();
    let resolveEngine!: (r: AgentTurnResult) => void;
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond: () =>
        new Promise<AgentTurnResult>((resolve) => {
          resolveEngine = resolve;
        }),
    };
    const probe: EngineProbe = { requested: "echo", mode: "mock", detail: "d" };
    const executor = new SwarmJobExecutor({
      engine,
      probe,
      timeoutMs: 5_000,
      setTimeoutFn: seam.setTimeoutFn,
      clearTimeoutFn: seam.clearTimeoutFn,
    });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "a goal that never returns");
    const c = ctx();
    const expectedSessionId = scheduledTurn(job, c).sessionId;

    const pending = executor.execute(job, c);
    seam.fire();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      output: "",
      detail: `SwarmJobExecutor: engine.respond() timed out after 5000ms for session "${expectedSessionId}"`,
    });

    // A LATE engine resolution, arriving after the timeout already settled
    // this execution, must be a silent no-op: it must not throw, must not
    // produce an unhandled rejection, and — since `result` was already
    // captured above — cannot retroactively change what the caller received.
    expect(() => resolveEngine({ text: "too late" })).not.toThrow();
    // Flush the microtask queue (no timers, no wall-clock wait) so the late
    // `.then` handler inside raceWithTimeout actually runs before we assert.
    await Promise.resolve();
    await Promise.resolve();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  test("uses the default 120_000ms timeout when none is configured", async () => {
    const seam = fakeTimerSeam();
    let capturedMs: number | undefined;
    const wrappedSetTimeout = (cb: () => void, ms: number): unknown => {
      capturedMs = ms;
      return seam.setTimeoutFn(cb, ms);
    };
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond: () => new Promise<AgentTurnResult>(() => {}),
    };
    const probe: EngineProbe = { requested: "echo", mode: "mock", detail: "d" };
    const executor = new SwarmJobExecutor({
      engine,
      probe,
      setTimeoutFn: wrappedSetTimeout,
      clearTimeoutFn: seam.clearTimeoutFn,
    });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal");
    void executor.execute(job, ctx());
    expect(capturedMs).toBe(120_000);
  });

  test("a successful resolution BEFORE the timer fires clears the timer and never rejects", async () => {
    const seam = fakeTimerSeam();
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(): Promise<AgentTurnResult> {
        return { text: "answered in time" };
      },
    };
    const probe: EngineProbe = { requested: "echo", mode: "mock", detail: "d" };
    const executor = new SwarmJobExecutor({
      engine,
      probe,
      timeoutMs: 5_000,
      setTimeoutFn: seam.setTimeoutFn,
      clearTimeoutFn: seam.clearTimeoutFn,
    });
    const store = newStore();
    const job = makeJob(store, SWARM_TASK_KIND, "goal");
    const result = await executor.execute(job, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toBe("answered in time");
    expect(seam.clearCount()).toBe(1);
  });
});
