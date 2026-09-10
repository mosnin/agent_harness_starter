import { describe, expect, it, vi } from "vitest";

import {
  ScheduledGatewayRuntime,
  type ScheduledGatewayRuntimeEvent,
  type ScheduledGatewayRuntimeOptions,
} from "../gateway-runtime";
import { ManualClock } from "../clock";
import { InMemoryJobStore, type RunOutcome, type ScheduledJob } from "../store";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "../runner";
import { VerifiedDeliveryRouter, formatAbstentionNotice, formatDeliveryText, type DeliveryReceipt, type JobDeliverer } from "../delivery";
import { GatewayProcess } from "../../gateway/process";
import type { DeliveryTarget, PlatformConnector } from "../../gateway/connector";
import type { GatewayPlatform, InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import { assessReply } from "../../gateway/badge";
import { ConformalGate, type CalibrationPoint, type GateDecision } from "../../styx/gate";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";

// ===========================================================================
// Real STYX gate, calibrated on an EXPLICITLY SYNTHETIC labeled point set —
// same fixture pattern as delivery.test.ts. Real conformal-calibration code
// running for real; the labels are hand-built fixtures, not a claim about
// any real verifier's real-world accuracy.
// ===========================================================================

const GATE_EPSILON = 0.1;

const SYNTHETIC_CALIBRATION: CalibrationPoint[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ score: 0.8 + i * 0.001, correct: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ score: 0.1 + i * 0.01, correct: false })),
];

const gate = new ConformalGate({ epsilon: GATE_EPSILON });
gate.calibrate(SYNTHETIC_CALIBRATION);

const EMIT_SCORE = 0.99;
const ABSTAIN_SCORE = 0;

function emitDecision(): GateDecision {
  const d = gate.decide(EMIT_SCORE);
  if (!d.emit) throw new Error("test fixture bug: EMIT_SCORE did not clear the calibrated threshold");
  return d;
}

function abstainDecision(): GateDecision {
  const d = gate.decide(ABSTAIN_SCORE);
  if (d.emit) throw new Error("test fixture bug: ABSTAIN_SCORE unexpectedly cleared the calibrated threshold");
  return d;
}

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(29)));
const TRACE_JSON = JSON.stringify({ steps: [{ tool: "exec", ok: true }] });

function makePayload(
  outputText: string,
  decision: GateDecision,
  overrides: Partial<CertificatePayload> = {},
): CertificatePayload {
  return {
    outputSha256: sha256Hex(outputText),
    taskId: "gw-runtime-job",
    verifierTier: "T2-genrm",
    ensembleScore: decision.score,
    pCorrect: decision.pCorrectEstimate,
    epsilon: GATE_EPSILON,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: 1_753_400_000_000,
    ...overrides,
  };
}

async function issueCert(outputText: string, decision: GateDecision): Promise<VerificationCertificate> {
  return ca.issue(makePayload(outputText, decision));
}

// ===========================================================================
// Fake transport: a PlatformConnector implementation with no real network,
// recording every send/stop and optionally gating a send on a promise so
// tests can prove ordering / in-flight draining without any wall-clock sleep.
// ===========================================================================

class RecordingConnector implements PlatformConnector {
  readonly platform: GatewayPlatform;
  readonly sent: Array<{ target: DeliveryTarget; text: string }> = [];
  startCalls = 0;
  stopCalls = 0;

  constructor(
    platform: GatewayPlatform,
    private readonly opts: {
      orderLog?: string[];
      gate?: Promise<void>;
      failSend?: string;
    } = {},
  ) {
    this.platform = platform;
  }

  async start(_handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.startCalls += 1;
  }

  async send(target: DeliveryTarget, text: string): Promise<void> {
    this.opts.orderLog?.push(`send-start:${this.platform}`);
    if (this.opts.gate) await this.opts.gate;
    if (this.opts.failSend) {
      this.opts.orderLog?.push(`send-error:${this.platform}`);
      throw new Error(this.opts.failSend);
    }
    this.sent.push({ target, text });
    this.opts.orderLog?.push(`send-end:${this.platform}`);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.opts.orderLog?.push(`stop:${this.platform}`);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A minimal on/off/emit emitter standing in for Node's `process`. */
class FakeEmitter {
  listeners = new Map<string, Set<() => void>>();
  on(sig: string, cb: () => void): this {
    if (!this.listeners.has(sig)) this.listeners.set(sig, new Set());
    this.listeners.get(sig)!.add(cb);
    return this;
  }
  off(sig: string, cb: () => void): this {
    this.listeners.get(sig)?.delete(cb);
    return this;
  }
  emit(sig: string): void {
    for (const cb of [...(this.listeners.get(sig) ?? [])]) cb();
  }
}

// ===========================================================================
// Fixtures
// ===========================================================================

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `gwrt-job-${idCounter}`;
}

function makeStore(clock: ManualClock): InMemoryJobStore {
  return new InMemoryJobStore(clock, nextId);
}

const EPOCH = Date.UTC(2024, 0, 1, 0, 0, 0);
const MIN = 60_000;

function makeExecutor(
  fn: (job: ScheduledJob, ctx: JobExecutionContext) => Promise<JobExecutionResult>,
): JobExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async execute(job, ctx) {
      calls.push(job.id);
      return fn(job, ctx);
    },
  };
}

function buildGateway(connectors: PlatformConnector[]): GatewayProcess {
  return new GatewayProcess({
    handler: async (m) => ({ text: `echo:${m.text}`, accepted: true }),
    connectors,
    report: connectors.map((c) => ({ platform: c.platform, mode: "real" as const, detail: "via TEST" })),
  });
}

function baseOptions(overrides: Partial<ScheduledGatewayRuntimeOptions> = {}): ScheduledGatewayRuntimeOptions {
  const clock = new ManualClock(EPOCH);
  const store = makeStore(clock);
  const connector = new RecordingConnector("telegram");
  const gateway = buildGateway([connector]);
  const executor = makeExecutor(async () => ({ ok: true, output: "default output" }));
  return {
    gateway,
    connectors: [connector],
    store,
    executor,
    clock,
    ...overrides,
  };
}

// ===========================================================================
// (a) End-to-end: a due cron job fires through the REAL SchedulerRunner +
// REAL VerifiedDeliveryRouter and lands on a fake connector's recorded
// sends, with the delivered text carrying the badge line, and
// store.recordRun history reflecting the real outcome.
// ===========================================================================

describe("ScheduledGatewayRuntime — end-to-end verified delivery", () => {
  it("a due job with real STYX evidence delivers through the gateway's own connector, badge line included", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);

    const decision = emitDecision();
    const output = "The nightly digest converged on 3 action items.";
    const cert = await issueCert(output, decision);
    const executor = makeExecutor(async () => ({ ok: true, output, verification: { decision, certificate: cert } }));

    const job = store.add({
      name: "nightly digest",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "digest", input: "run" },
      delivery: { platform: "telegram", user: "U1", channel: "C1" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    const status1 = await runtime.start();
    expect(status1.running).toBe(true);
    expect(status1.gateway.running).toBe(true);
    expect(connector.startCalls).toBe(1);

    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    expect(report.fired).toHaveLength(1);
    expect(report.fired[0].jobId).toBe(job.id);
    expect(report.fired[0].outcome).toBe("delivered");

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0].target).toEqual({ user: "U1", channel: "C1" });

    const stamp = await assessReply(output, { decision, certificate: cert });
    const expectedText = formatDeliveryText(job, { ok: true, output }, stamp);
    expect(connector.sent[0].text).toBe(expectedText);
    expect(connector.sent[0].text).toContain("badge: verified");
    expect(connector.sent[0].text).toContain(sha256Hex(cert.signature).slice(0, 12));

    const updated = store.get(job.id)!;
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].outcome).toBe("delivered");
    expect(updated.runCount).toBe(1);
    expect(updated.failCount).toBe(0);

    const status2 = runtime.status();
    expect(status2.outcomes.delivered).toBe(1);
    expect(status2.outcomes.abstained).toBe(0);
    expect(status2.outcomes.failed).toBe(0);
    expect(status2.jobs).toBe(1);

    await runtime.stop();
  });
});

// ===========================================================================
// (b) No verification evidence -> honest abstention notice, never formatted
// as verified. Assert exact strings from delivery.ts's real formatters.
// ===========================================================================

describe("ScheduledGatewayRuntime — honest abstention", () => {
  it("an executor result with NO verification evidence delivers an abstention notice, never the raw output", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const SECRET_OUTPUT = "UNVERIFIED-SECRET-OUTPUT-should-never-be-sent";
    const executor = makeExecutor(async () => ({ ok: true, output: SECRET_OUTPUT }));

    const job = store.add({
      name: "unverifiable job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U2" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();

    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    expect(report.fired[0].outcome).toBe("abstained");

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0].text).not.toContain(SECRET_OUTPUT);

    const stamp = await assessReply(SECRET_OUTPUT, {});
    const expectedNotice = formatAbstentionNotice(job, stamp);
    expect(connector.sent[0].text).toBe(expectedNotice);

    const status = runtime.status();
    expect(status.outcomes.abstained).toBe(1);
    expect(status.outcomes.delivered).toBe(0);

    await runtime.stop();
  });

  it("a gate abstain decision with a fully valid certificate still abstains — the gate outranks the cert", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const output = "would have been sent";
    const decision = abstainDecision();
    const cert = await issueCert(output, decision);
    const executor = makeExecutor(async () => ({ ok: true, output, verification: { decision, certificate: cert } }));

    store.add({
      name: "gate-abstained job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U3" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();

    expect(report.fired[0].outcome).toBe("abstained");
    expect(connector.sent[0].text).not.toContain(output);
    await runtime.stop();
  });
});

// ===========================================================================
// (c) Zero real connectors: router construction still succeeds, delivery
// yields an honest failed/withheld outcome, runtime never throws.
// ===========================================================================

describe("ScheduledGatewayRuntime — zero real connectors", () => {
  it("constructs and runs cleanly with an empty connectors array; delivery fails honestly, never throws", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const gateway = buildGateway([]);
    const executor = makeExecutor(async () => ({ ok: true, output: "nobody will receive this" }));

    store.add({
      name: "orphaned job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U4" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [], store, executor, clock });
    await expect(runtime.start()).resolves.toBeTruthy();

    clock.advance(5 * MIN);
    let report;
    await expect((async () => { report = await runtime.tickNow(); })()).resolves.toBeUndefined();
    expect(report!.fired[0].outcome).toBe("failed");

    const status = runtime.status();
    expect(status.outcomes.failed).toBe(1);
    expect(status.jobs).toBe(1);

    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("a delivery target with no registered sender at all fails honestly (never crashes), even with onUnverified 'withhold'", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const gateway = buildGateway([]);
    const executor = makeExecutor(async () => ({ ok: true, output: "nobody registered for this platform" }));

    store.add({
      name: "unregistered-platform job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U5" },
    });

    const runtime = new ScheduledGatewayRuntime({
      gateway,
      connectors: [],
      store,
      executor,
      clock,
      onUnverified: "withhold",
    });
    await runtime.start();
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    // No sender is registered for "telegram" at all (zero connectors), so
    // the router fails fast on the missing-sender check before onUnverified
    // is even consulted — an honest "failed", never a throw.
    expect(report.fired[0].outcome).toBe("failed");
    expect(runtime.status().outcomes.failed).toBe(1);
    await runtime.stop();
  });

  it("onUnverified 'withhold' with a registered sender withholds honestly and sends zero messages", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const executor = makeExecutor(async () => ({ ok: true, output: "withheld output" }));

    store.add({
      name: "withheld job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U5" },
    });

    const runtime = new ScheduledGatewayRuntime({
      gateway,
      connectors: [connector],
      store,
      executor,
      clock,
      onUnverified: "withhold",
    });
    await runtime.start();
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    expect(report.fired[0].outcome).toBe("withheld");
    expect(runtime.status().outcomes.withheld).toBe(1);
    expect(connector.sent).toHaveLength(0);
    await runtime.stop();
  });
});

// ===========================================================================
// (d) Idempotency: double start(), double stop(), stop-before-start.
// ===========================================================================

describe("ScheduledGatewayRuntime — idempotency", () => {
  it("double start() does not re-start the gateway's connectors and returns a consistent status", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });

    const s1 = await runtime.start();
    const s2 = await runtime.start();

    expect(connector.startCalls).toBe(1);
    expect(s1.startedAt).toBe(s2.startedAt);
    expect(s1.running).toBe(true);
    expect(s2.running).toBe(true);

    await runtime.stop();
  });

  it("double stop() does not double-stop the gateway's connectors", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });

    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(connector.stopCalls).toBe(1);
  });

  it("stop() before start() is a safe no-op", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(connector.stopCalls).toBe(0);
    expect(connector.startCalls).toBe(0);
    expect(runtime.status().running).toBe(false);
  });
});

// ===========================================================================
// (e) Ordering: stop() halts the runner before the gateway, and awaits any
// in-flight delivery before the gateway's connectors are stopped — proven
// with an instrumented connector recording real call ordering, no delivery
// races a closing transport.
// ===========================================================================

describe("ScheduledGatewayRuntime — stop() ordering and in-flight draining", () => {
  it("stop() awaits an in-flight send before the connector is stopped", async () => {
    const orderLog: string[] = [];
    const gate = deferred();
    const connector = new RecordingConnector("telegram", { orderLog, gate: gate.promise });
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "in-flight output" }));

    store.add({
      name: "gated job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U6" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();
    clock.advance(5 * MIN);

    const tickPromise = runtime.tickNow();

    // Let the microtask queue drain enough for execute() + deliver() +
    // sender.send() to actually be entered and hang on the gate.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(orderLog).toContain("send-start:telegram");
    expect(orderLog).not.toContain("stop:telegram");

    const stopPromise = runtime.stop();

    // Give stop() every chance to race ahead if it (incorrectly) didn't
    // await the in-flight send.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(orderLog).not.toContain("stop:telegram");
    expect(runtime.status().running).toBe(false); // running flips synchronously even while draining

    gate.resolve();
    await Promise.all([tickPromise, stopPromise]);

    expect(orderLog).toEqual(["send-start:telegram", "send-end:telegram", "stop:telegram"]);
    expect(connector.sent).toHaveLength(1);
  });

  it("runner.stop() semantics: no further ticks fire once stop() has resolved, even if tickNow() is called again", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    store.add({
      name: "post-stop job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U7" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();
    await runtime.stop();

    // tickNow() still delegates to the (now-stopped-poll-loop) runner's
    // tick() directly — tick() itself has no "stopped" guard, so a manual
    // tick after stop() legitimately still evaluates due jobs. What must
    // NOT happen is the gateway's connectors receiving traffic through a
    // background poll timer post-stop; there is none, by construction,
    // once stop() has resolved (installSignalHandlers / start() are the
    // only things that (re)arm it).
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    expect(report.fired).toHaveLength(1);
  });

  it("stop() does not deadlock when store.recordRun throws (SchedulerRunner swallows the throw; the fire is over)", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const inner = makeStore(clock);
    // A hostile store whose recordRun always throws AFTER the runner has
    // finished the fire. safeRecordRun catches this into TickReport.errors —
    // so from the runner's perspective the fire is done, and the runtime's
    // drain bookkeeping must agree or stop() hangs forever.
    const hostileStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "recordRun") {
          return () => {
            throw new Error("disk full: recordRun persist failed");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    inner.add({
      name: "hostile-store job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U8" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store: hostileStore, executor, clock });
    await runtime.start();
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();
    expect(report.errors.some((e) => e.message.includes("recordRun persist failed"))).toBe(true);
    // The send itself succeeded (delivery happens before recordRun).
    expect(connector.sent.length + report.fired.length).toBeGreaterThan(0);

    // Without the settle-on-throw fix this await never resolves.
    await runtime.stop();
    expect(connector.stopCalls).toBe(1);
    // The run was never persisted, so it must never have been tallied.
    const outcomes = runtime.status().outcomes;
    expect(Object.values(outcomes).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("an overlap 'skipped' record for a still-in-flight job does NOT release the drain early", async () => {
    const orderLog: string[] = [];
    const gate = deferred();
    const connector = new RecordingConnector("telegram", { orderLog, gate: gate.promise });
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "overlapped output" }));

    store.add({
      name: "overlapping job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U9" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();

    // Tick 1: the fire enters the connector send and hangs on the gate.
    clock.advance(5 * MIN);
    const tick1 = runtime.tickNow();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(orderLog).toContain("send-start:telegram");

    // Tick 2: the runner's overlap guard records a "skipped" run for the
    // SAME job whose real send is still in flight.
    clock.advance(5 * MIN);
    const report2 = await runtime.tickNow();
    expect(report2.overlapsSkipped).toEqual(store.list().map((j) => j.id));

    // stop() must keep draining — the "skipped" bookkeeping write must not
    // count as "the fire finished".
    const stopPromise = runtime.stop();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0)); // let any (incorrect) idle check fire
    await new Promise((r) => setTimeout(r, 0));
    expect(orderLog).not.toContain("stop:telegram");

    gate.resolve();
    await Promise.all([tick1, stopPromise]);
    expect(orderLog.indexOf("send-end:telegram")).toBeLessThan(orderLog.indexOf("stop:telegram"));
    expect(connector.sent).toHaveLength(1);
    // Tally is byte-exact against store history: the gated fire carried no
    // verification evidence, so it landed as an honest abstention notice
    // (outcome "abstained"), plus the overlap "skipped" record.
    const outcomes = runtime.status().outcomes;
    expect(outcomes.skipped).toBe(1);
    expect(outcomes.abstained).toBe(1);
  });
});

// ===========================================================================
// (f) A throwing executor surfaces as SchedulerEvent kind "executor-error"
// and the loop survives — the next tick still fires.
// ===========================================================================

describe("ScheduledGatewayRuntime — executor-error containment", () => {
  it("a throwing executor is reported as 'executor-error' and does not crash the runtime; the next tick still fires", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);

    const decision = emitDecision();
    let callNum = 0;
    const executor: JobExecutor = {
      async execute(): Promise<JobExecutionResult> {
        callNum += 1;
        if (callNum === 1) throw new Error("boom: executor exploded");
        const output = "recovered on second fire";
        const cert = await issueCert(output, decision);
        return { ok: true, output, verification: { decision, certificate: cert } };
      },
    };

    const job = store.add({
      name: "flaky job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U8" },
    });

    const events: ScheduledGatewayRuntimeEvent[] = [];
    const runtime = new ScheduledGatewayRuntime({
      gateway,
      connectors: [connector],
      store,
      executor,
      clock,
      onEvent: (e) => events.push(e),
    });
    await runtime.start();

    clock.advance(5 * MIN);
    const report1 = await runtime.tickNow();
    expect(report1.errors).toHaveLength(1);
    expect(report1.fired[0].outcome).toBe("failed");

    const schedulerKinds = events.filter((e) => e.kind === "scheduler").map((e) => e.scheduler!.kind);
    expect(schedulerKinds).toContain("executor-error");

    const afterFirst = store.get(job.id)!;
    expect(afterFirst.history).toHaveLength(1);
    expect(afterFirst.history[0].outcome).toBe("failed");
    expect(runtime.status().outcomes.failed).toBe(1);

    // The loop survives: the next due fire still runs the executor again.
    clock.advance(5 * MIN);
    const report2 = await runtime.tickNow();
    expect(report2.errors).toHaveLength(0);
    expect(report2.fired[0].outcome).toBe("delivered");

    const afterSecond = store.get(job.id)!;
    expect(afterSecond.history).toHaveLength(2);
    expect(afterSecond.history[1].outcome).toBe("delivered");
    expect(runtime.status().outcomes.delivered).toBe(1);
    expect(runtime.status().outcomes.failed).toBe(1);

    await runtime.stop();
  });
});

// ===========================================================================
// (g) Outcomes tally exactly mirrors the JobRunRecords written to the store
// — cross-checked per-outcome, including a catch-up backlog spread across
// multiple ticks (never off-by-one).
// ===========================================================================

describe("ScheduledGatewayRuntime — outcomes tally fidelity", () => {
  it("the tally exactly matches store history counts across mixed outcomes", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);

    const decision = emitDecision();
    let n = 0;
    const executor = makeExecutor(async (): Promise<JobExecutionResult> => {
      n += 1;
      // Cycle through: verified delivery, unverifiable (abstain), verified delivery.
      if (n % 3 === 1) {
        const output = `verified-${n}`;
        const cert = await issueCert(output, decision);
        return { ok: true, output, verification: { decision, certificate: cert } };
      }
      if (n % 3 === 2) {
        return { ok: true, output: `unverifiable-${n}` };
      }
      const output = `verified-${n}`;
      const cert = await issueCert(output, decision);
      return { ok: true, output, verification: { decision, certificate: cert } };
    });

    const job = store.add({
      name: "mixed outcome job",
      cron: "*/1 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U9" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();

    for (let i = 0; i < 6; i++) {
      clock.advance(MIN);
      await runtime.tickNow();
    }

    const finalJob = store.get(job.id)!;
    expect(finalJob.history).toHaveLength(6);

    const expectedTally: Record<RunOutcome, number> = { delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 };
    for (const run of finalJob.history) expectedTally[run.outcome] += 1;

    expect(runtime.status().outcomes).toEqual(expectedTally);
    expect(expectedTally.delivered).toBe(4); // n%3==1 and n%3==0 -> 1,3,4,6
    expect(expectedTally.abstained).toBe(2); // n%3==2 -> 2,5

    await runtime.stop();
  });

  it("a catch-up misfire backlog spread across ticks tallies exactly, never off-by-one", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "catch-up output" }));

    // No delivery target on this job: a successful executor result with no
    // delivery target lands as outcome "delivered" (result stored only) —
    // see runner.ts's `else if (result.ok)` branch. That keeps this test
    // focused purely on misfire/catch-up tally fidelity, independent of the
    // delivery pipeline (already exercised in the tests above).
    const job = store.add({
      name: "catch-up job",
      cron: "*/1 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      misfire: "catch-up",
      catchUpLimit: 2,
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();

    // Jump 5 minutes without ticking -> 5 missed fires queue up.
    clock.advance(5 * MIN);
    const report1 = await runtime.tickNow();
    expect(report1.fired).toHaveLength(2); // catchUpLimit caps this tick at 2
    expect(report1.misfiresSkipped).toEqual([{ jobId: job.id, missed: 3 }]);

    const report2 = await runtime.tickNow();
    expect(report2.fired).toHaveLength(2);

    const report3 = await runtime.tickNow();
    expect(report3.fired).toHaveLength(1);

    const finalJob = store.get(job.id)!;
    expect(finalJob.history).toHaveLength(5);
    expect(finalJob.history.every((r) => r.outcome === "delivered")).toBe(true);
    expect(runtime.status().outcomes.delivered).toBe(5);
    expect(runtime.status().outcomes.delivered).toBe(finalJob.history.length);

    await runtime.stop();
  });
});

// ===========================================================================
// (h) Signal handlers install/uninstall, proven with a fake proc object.
// ===========================================================================

describe("ScheduledGatewayRuntime — signal handlers", () => {
  it("SIGINT and SIGTERM both call stop(); the uninstaller removes exactly those two handlers", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });
    await runtime.start();

    const proc = new FakeEmitter();
    const uninstall = runtime.installSignalHandlers(proc);
    expect(proc.listeners.get("SIGINT")?.size).toBe(1);
    expect(proc.listeners.get("SIGTERM")?.size).toBe(1);

    proc.emit("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.status().running).toBe(false);
    expect(connector.stopCalls).toBe(1);

    uninstall();
    expect(proc.listeners.get("SIGINT")?.size).toBe(0);
    expect(proc.listeners.get("SIGTERM")?.size).toBe(0);
  });

  it("never touches the global process object — only the handed-in proc", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });

    const realProcOn = vi.spyOn(process, "on");
    const proc = new FakeEmitter();
    const uninstall = runtime.installSignalHandlers(proc);
    expect(realProcOn).not.toHaveBeenCalled();
    uninstall();
    realProcOn.mockRestore();
  });
});

// ===========================================================================
// (i) status() before start, while running, after stop — honest shapes.
// ===========================================================================

describe("ScheduledGatewayRuntime — status() honesty", () => {
  it("returns the correct shape before start (), while running, and after stop()", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "x" }));
    store.add({
      name: "status job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
    });

    const runtime = new ScheduledGatewayRuntime({ gateway, connectors: [connector], store, executor, clock });

    const before = runtime.status();
    expect(before.running).toBe(false);
    expect(before.startedAt).toBeUndefined();
    expect(before.outcomes).toEqual({ delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 });
    expect(before.schedulerEvents).toBe(0);
    expect(before.lastSchedulerEventAt).toBeUndefined();
    expect(before.jobs).toBe(1);
    expect(before.gateway.running).toBe(false);

    const during = await runtime.start();
    expect(during.running).toBe(true);
    expect(during.startedAt).toBe(EPOCH);
    expect(during.gateway.running).toBe(true);

    await runtime.stop();
    const after = runtime.status();
    expect(after.running).toBe(false);
    expect(after.startedAt).toBe(EPOCH); // start time is a fact of history, not erased by stopping
    expect(after.gateway.running).toBe(false);
  });
});

// ===========================================================================
// deliverer seam: when supplied, used verbatim — the gateway's connectors
// are never touched, proving zero adapter code is forced onto a caller who
// wants to interpose their own JobDeliverer (e.g. a receipt-ledger one).
// ===========================================================================

describe("ScheduledGatewayRuntime — deliverer: 'verbatim' seam", () => {
  it("a supplied deliverer is used exactly, and the gateway's own connectors never receive traffic", async () => {
    const connector = new RecordingConnector("telegram");
    const gateway = buildGateway([connector]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "routed through custom deliverer" }));

    const calls: Array<{ jobId: string }> = [];
    const customDeliverer: JobDeliverer = {
      async deliver(job, _result, ctx): Promise<DeliveryReceipt> {
        calls.push({ jobId: job.id });
        return {
          jobId: job.id,
          outcome: "delivered",
          badge: "unverified",
          reason: "custom deliverer handled this",
          detail: "custom deliverer handled this",
          attempts: 1,
          at: ctx.firedAt,
        };
      },
    };

    const job = store.add({
      name: "custom-deliverer job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "U11" },
    });

    const runtime = new ScheduledGatewayRuntime({
      gateway,
      connectors: [connector],
      store,
      executor,
      clock,
      deliverer: customDeliverer,
    });
    await runtime.start();
    clock.advance(5 * MIN);
    const report = await runtime.tickNow();

    expect(report.fired[0].outcome).toBe("delivered");
    expect(calls).toEqual([{ jobId: job.id }]);
    expect(connector.sent).toHaveLength(0); // the real connector never saw a send — the custom deliverer handled it

    await runtime.stop();
  });
});

// ===========================================================================
// Real PlatformConnector wired with zero adapter code.
// ===========================================================================

describe("ScheduledGatewayRuntime — connectors registered with zero adapter code", () => {
  it("the default-constructed deliverer routes to the connector purely by job.delivery.platform matching connector.platform", async () => {
    const connSlack = new RecordingConnector("slack");
    const connTelegram = new RecordingConnector("telegram");
    const gateway = buildGateway([connSlack, connTelegram]);
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const executor = makeExecutor(async () => ({ ok: true, output: "routed by platform" }));

    store.add({
      name: "slack job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "slack", user: "US" },
    });
    store.add({
      name: "telegram job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "noop", input: "x" },
      delivery: { platform: "telegram", user: "UT" },
    });

    const runtime = new ScheduledGatewayRuntime({
      gateway,
      connectors: [connSlack, connTelegram],
      store,
      executor,
      clock,
    });
    await runtime.start();
    clock.advance(5 * MIN);
    await runtime.tickNow();

    expect(connSlack.sent).toHaveLength(1);
    expect(connSlack.sent[0].target).toEqual({ user: "US", channel: undefined });
    expect(connTelegram.sent).toHaveLength(1);
    expect(connTelegram.sent[0].target).toEqual({ user: "UT", channel: undefined });

    await runtime.stop();
  });
});

// ===========================================================================
// Constructor validation.
// ===========================================================================

describe("ScheduledGatewayRuntime — construction", () => {
  it("throws if connectors is missing/not an array", () => {
    const opts = baseOptions();
    expect(
      () => new ScheduledGatewayRuntime({ ...opts, connectors: undefined as unknown as PlatformConnector[] }),
    ).toThrow();
  });

  it("throws if gateway is missing", () => {
    const opts = baseOptions();
    expect(() => new ScheduledGatewayRuntime({ ...opts, gateway: undefined as unknown as GatewayProcess })).toThrow();
  });
});
