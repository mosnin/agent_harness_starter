import { describe, expect, it } from "vitest";

import {
  VerifiedDeliveryRouter,
  formatDeliveryText,
  formatAbstentionNotice,
  type OutboundSender,
  type VerifiedDeliveryOptions,
} from "../delivery";
import type { JobDeliverer } from "../delivery";
import { ManualClock } from "../clock";
import { InMemoryJobStore, type NewJobInput, type RunOutcome, type ScheduledJob } from "../store";
import { SchedulerRunner, type JobExecutionContext, type JobExecutionResult, type JobExecutor } from "../runner";
import { ConformalGate, type CalibrationPoint, type GateDecision } from "../../styx/gate";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";
import { assessReply, type StampedReply } from "../../gateway/badge";
import type { PlatformConnector } from "../../gateway/connector";
import { InMemoryConnector } from "../../gateway/in-memory-connector";

// ===========================================================================
// Real STYX gate, calibrated on an EXPLICITLY SYNTHETIC labeled point set.
// This is real conformal-calibration code running for real — the labels
// below are hand-constructed fixtures, not a claim about any real verifier's
// real-world accuracy. See ../../styx/gate.ts for the calibration math.
// ===========================================================================

const GATE_EPSILON = 0.1;

/** SYNTHETIC calibration set: a clean high-score/correct cluster and a
 *  clean low-score/incorrect cluster, 40 points total (>= the gate's default
 *  minCalibration of 20). Not derived from any real benchmark run. */
const SYNTHETIC_CALIBRATION: CalibrationPoint[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ score: 0.8 + i * 0.001, correct: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ score: 0.1 + i * 0.01, correct: false })),
];

const gate = new ConformalGate({ epsilon: GATE_EPSILON });
gate.calibrate(SYNTHETIC_CALIBRATION);

// A score above every calibration score always clears whatever finite
// threshold the gate fit; a score of 0 always sits below every calibration
// score (the lowest is 0.10). Using the gate's own `decide()` output (rather
// than hardcoding an assumed threshold) is what keeps these tests honest
// about being driven by the real calibration math, not a guessed constant.
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

// ---------------------------------------------------------------------------
// Real ed25519 certificate authority (fixed RNG seed => deterministic keys).
// ---------------------------------------------------------------------------

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(17)));
const TRACE_JSON = JSON.stringify({ steps: [{ tool: "exec", ok: true }, { tool: "genrm", ok: true }] });

function makePayload(
  outputText: string,
  decision: GateDecision,
  overrides: Partial<CertificatePayload> = {},
): CertificatePayload {
  return {
    outputSha256: sha256Hex(outputText),
    taskId: "sched-job-0001",
    verifierTier: "T2-genrm",
    ensembleScore: decision.score,
    pCorrect: decision.pCorrectEstimate,
    epsilon: GATE_EPSILON,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["exec-oracle@1.0.0", "genrm-rubric@0.9.0"],
    issuedAt: 1_753_400_000_000,
    ...overrides,
  };
}

async function issueCert(
  outputText: string,
  decision: GateDecision,
  overrides: Partial<CertificatePayload> = {},
): Promise<VerificationCertificate> {
  return ca.issue(makePayload(outputText, decision, overrides));
}

// ---------------------------------------------------------------------------
// Job / store fixtures
// ---------------------------------------------------------------------------

function newStore(): InMemoryJobStore {
  return new InMemoryJobStore(new ManualClock(1_700_000_000_000));
}

function makeJob(store: InMemoryJobStore, overrides: Partial<NewJobInput> = {}): ScheduledJob {
  return store.add({
    name: "nightly digest",
    cron: "0 9 * * *",
    task: { kind: "digest", input: "run" },
    delivery: { platform: "slack", user: "U1", channel: "C1" },
    ...overrides,
  });
}

const CTX: JobExecutionContext = { scheduledFor: 1_700_000_000_000, firedAt: 1_700_000_000_000, manual: false };

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

class FakeSender implements OutboundSender {
  readonly platform: string;
  readonly sent: Array<{ target: { user: string; channel?: string }; text: string }> = [];
  callCount = 0;

  constructor(
    platform: string,
    private readonly onCall: (call: number) => void = () => {},
  ) {
    this.platform = platform;
  }

  async send(target: { user: string; channel?: string }, text: string): Promise<void> {
    this.callCount += 1;
    this.onCall(this.callCount);
    this.sent.push({ target, text });
  }
}

function failNTimesThenSucceed(n: number): (call: number) => void {
  return (call) => {
    if (call <= n) throw new Error(`transient failure on attempt ${call}`);
  };
}

function alwaysFail(message: string): (call: number) => void {
  return () => {
    throw new Error(message);
  };
}

function recordingBackoff(): { backoff: (attempt: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    backoff: async (attempt: number) => {
      calls.push(attempt);
    },
  };
}

function router(opts: Omit<VerifiedDeliveryOptions, "clock"> & { clock?: VerifiedDeliveryOptions["clock"] }): VerifiedDeliveryRouter {
  return new VerifiedDeliveryRouter({ clock: new ManualClock(1_700_000_000_000), ...opts });
}

// ===========================================================================
// Happy path
// ===========================================================================

describe("VerifiedDeliveryRouter — verified delivery", () => {
  it("delivers with badge 'verified', a correct certFingerprint, and the exact formatted text, in a single attempt", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "The swarm converged on 42 after 3 rounds of adversarial verification.";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack");
    const clock = new ManualClock(4_242);
    const r = new VerifiedDeliveryRouter({ senders: [sender], clock, backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.jobId).toBe(job.id);
    expect(receipt.badge).toBe("verified");
    expect(receipt.outcome).toBe("delivered");
    expect(receipt.attempts).toBe(1);
    expect(receipt.at).toBe(4_242);
    expect(receipt.target).toEqual(job.delivery);
    expect(receipt.detail).toBe(receipt.reason);

    // Independently recompute the ground-truth stamp and expected text —
    // proves the router's output is exactly what assessReply + formatDeliveryText
    // would produce, not something the router invented.
    const stamp = await assessReply(output, { decision, certificate: cert });
    const expectedText = formatDeliveryText(job, result, stamp);
    expect(receipt.deliveredText).toBe(expectedText);
    expect(receipt.deliveredText).toContain(sha256Hex(cert.signature).slice(0, 12));
    expect(receipt.deliveredText).toContain(cert.payload.pCorrect.toFixed(3));

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toBe(expectedText);
    expect(sender.sent[0].target).toEqual({ user: "U1", channel: "C1" });
  });
});

// ===========================================================================
// Adversarial breaks — every way "verified" must NOT happen
// ===========================================================================

describe("VerifiedDeliveryRouter — honest abstention (never a forged 'verified')", () => {
  it("a certificate minted for DIFFERENT text yields an abstention notice, never the output", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "Result A: the answer is 7.";
    const certForOther = await issueCert("Result B: a completely different answer.", decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: certForOther } };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.badge).toBe("unverified");
    expect(receipt.outcome).toBe("abstained");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).not.toContain(output);
    expect(sender.sent[0].text).not.toContain("Result B");
    expect(receipt.deliveredText).toBe(sender.sent[0].text);
  });

  it("output text mutated after certification fails the sha256 binding -> abstention", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const originalOutput = "Certified answer: revenue grew 12% QoQ.";
    const cert = await issueCert(originalOutput, decision);
    const mutatedOutput = originalOutput + " (tampered after signing)";
    const result: JobExecutionResult = { ok: true, output: mutatedOutput, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.badge).toBe("unverified");
    expect(receipt.outcome).toBe("abstained");
    expect(sender.sent[0].text).not.toContain(mutatedOutput);
    expect(sender.sent[0].text).not.toContain(originalOutput);
  });

  it("gate decision emit:false wins even with a fully valid, matching certificate — the gate outranks the cert", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = abstainDecision();
    const output = "An answer the gate refused to certify for emission.";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.badge).toBe("abstained");
    expect(receipt.outcome).toBe("abstained");
    expect(receipt.reason).toContain("gate abstained");
    expect(sender.sent[0].text).not.toContain(output);
  });

  it("missing evidence entirely -> unverified -> abstention", async () => {
    const store = newStore();
    const job = makeJob(store);
    const result: JobExecutionResult = { ok: true, output: "No verification evidence was ever attached." };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.badge).toBe("unverified");
    expect(receipt.outcome).toBe("abstained");
    expect(sender.sent[0].text).not.toContain(result.output);
  });

  it("result.ok:false is never delivered, even with fully valid gate+certificate evidence", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "This would have been a verified answer.";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = {
      ok: false,
      output,
      detail: "executor crashed midway through tool execution",
      verification: { decision, certificate: cert },
    };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    // The evidence genuinely checks out — badge is honestly "verified" — but
    // the executor itself reported failure, so it must never be delivered.
    expect(receipt.badge).toBe("verified");
    expect(receipt.outcome).not.toBe("delivered");
    expect(receipt.outcome).toBe("abstained");
    expect(receipt.reason).toContain("result.ok=false");
    expect(receipt.reason).toContain("executor crashed midway through tool execution");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).not.toContain(output);
  });

  it("the abstention notice never leaks the unverified output text, across every non-verified cause", async () => {
    const store = newStore();
    const job = makeJob(store);
    const MARKER = "SECRET-MARKER-9f3d1c-do-not-leak";
    const emitted = emitDecision();
    const certForMarker = await issueCert(MARKER, emitted);

    const scenarios: JobExecutionResult[] = [
      { ok: true, output: MARKER }, // no evidence at all
      { ok: true, output: MARKER, verification: { decision: abstainDecision() } }, // gate abstained
      { ok: false, output: MARKER, verification: { decision: emitted, certificate: certForMarker } }, // executor failed
    ];

    for (const result of scenarios) {
      const sender = new FakeSender("slack");
      const r = router({ senders: [sender], backoff: async () => {} });
      const receipt = await r.deliver(job, result, CTX);

      expect(receipt.outcome).toBe("abstained");
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].text).not.toContain(MARKER);
      expect(receipt.deliveredText).not.toContain(MARKER);
    }
  });
});

// ===========================================================================
// onUnverified: "withhold"
// ===========================================================================

describe("VerifiedDeliveryRouter — onUnverified: 'withhold'", () => {
  it("sends zero messages yet returns a truthful receipt", async () => {
    const store = newStore();
    const job = makeJob(store);
    const result: JobExecutionResult = { ok: true, output: "unverifiable output that must stay withheld" };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], onUnverified: "withhold", backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.outcome).toBe("withheld");
    expect(receipt.badge).toBe("unverified");
    expect(receipt.attempts).toBe(0);
    expect(receipt.deliveredText).toBeUndefined();
    expect(receipt.target).toEqual(job.delivery);
    expect(sender.sent).toHaveLength(0);
    expect(receipt.reason.length).toBeGreaterThan(0);
  });

  it("also withholds a verified-evidence result whose job execution reported failure", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "would be verified";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: false, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack");
    const r = router({ senders: [sender], onUnverified: "withhold", backoff: async () => {} });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.outcome).toBe("withheld");
    expect(sender.sent).toHaveLength(0);
  });
});

// ===========================================================================
// Transport hardening
// ===========================================================================

describe("VerifiedDeliveryRouter — transport hardening", () => {
  it("a sender that throws twice then succeeds delivers, with attempts:3 and backoff called [1, 2]", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "retried into success";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack", failNTimesThenSucceed(2));
    const { backoff, calls } = recordingBackoff();
    const r = router({ senders: [sender], backoff, maxAttempts: 5 });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.outcome).toBe("delivered");
    expect(receipt.attempts).toBe(3);
    expect(calls).toEqual([1, 2]);
    expect(sender.sent).toHaveLength(1);
  });

  it("an always-throwing sender fails with attempts == default maxAttempts (3) and the last error in reason", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "will never send";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack", alwaysFail("boom-permanent-failure"));
    const { backoff, calls } = recordingBackoff();
    const r = router({ senders: [sender], backoff });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.outcome).toBe("failed");
    expect(receipt.badge).toBe("verified");
    expect(receipt.attempts).toBe(3);
    expect(receipt.reason).toContain("boom-permanent-failure");
    expect(receipt.detail).toBe(receipt.reason);
    expect(calls).toEqual([1, 2]);
    expect(receipt.deliveredText).toBeUndefined();
    expect(sender.sent).toHaveLength(0);
  });

  it("honors a custom maxAttempts for both success-path attempts count and failure-path attempts count", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "custom max attempts";
    const cert = await issueCert(output, decision);
    const result: JobExecutionResult = { ok: true, output, verification: { decision, certificate: cert } };
    const sender = new FakeSender("slack", alwaysFail("still failing"));
    const { backoff, calls } = recordingBackoff();
    const r = router({ senders: [sender], backoff, maxAttempts: 6 });

    const receipt = await r.deliver(job, result, CTX);

    expect(receipt.outcome).toBe("failed");
    expect(receipt.attempts).toBe(6);
    expect(calls).toEqual([1, 2, 3, 4, 5]);
  });

  it("an unknown platform in job.delivery fails fast: attempts 0, reason names the known platforms", async () => {
    const store = newStore();
    const job = makeJob(store, { delivery: { platform: "carrier-pigeon", user: "U9" } });
    const senderSlack = new FakeSender("slack");
    const senderDiscord = new FakeSender("discord");
    const { backoff, calls } = recordingBackoff();
    const r = router({ senders: [senderSlack, senderDiscord], backoff });

    const receipt = await r.deliver(job, { ok: true, output: "x" }, CTX);

    expect(receipt.outcome).toBe("failed");
    expect(receipt.attempts).toBe(0);
    expect(receipt.reason).toContain("carrier-pigeon");
    expect(receipt.reason).toContain("discord");
    expect(receipt.reason).toContain("slack");
    expect(calls).toEqual([]);
    expect(senderSlack.sent).toHaveLength(0);
    expect(senderDiscord.sent).toHaveLength(0);
  });

  it("a job with no delivery target configured fails fast with attempts 0", async () => {
    const store = newStore();
    const job = store.add({ name: "no target", cron: "0 * * * *", task: { kind: "noop", input: "x" } });
    const r = router({ senders: [new FakeSender("slack")], backoff: async () => {} });

    const receipt = await r.deliver(job, { ok: true, output: "z" }, CTX);

    expect(receipt.outcome).toBe("failed");
    expect(receipt.attempts).toBe(0);
    expect(receipt.target).toBeUndefined();
  });

  it("two senders registered are routed by platform exactly", async () => {
    const store = newStore();
    const jobSlack = makeJob(store, { delivery: { platform: "slack", user: "US" } });
    const jobDiscord = makeJob(store, { delivery: { platform: "discord", user: "UD" } });
    const senderSlack = new FakeSender("slack");
    const senderDiscord = new FakeSender("discord");
    const r = router({ senders: [senderSlack, senderDiscord], backoff: async () => {} });

    const decision = emitDecision();
    const outputSlack = "routed to slack";
    const outputDiscord = "routed to discord";
    const certSlack = await issueCert(outputSlack, decision);
    const certDiscord = await issueCert(outputDiscord, decision);

    await r.deliver(jobSlack, { ok: true, output: outputSlack, verification: { decision, certificate: certSlack } }, CTX);
    await r.deliver(jobDiscord, { ok: true, output: outputDiscord, verification: { decision, certificate: certDiscord } }, CTX);

    expect(senderSlack.sent).toHaveLength(1);
    expect(senderSlack.sent[0].text).toContain(outputSlack);
    expect(senderDiscord.sent).toHaveLength(1);
    expect(senderDiscord.sent[0].text).toContain(outputDiscord);
  });
});

// ===========================================================================
// Constructor validation
// ===========================================================================

describe("VerifiedDeliveryRouter — construction", () => {
  it("throws if opts.senders is missing/not an array", () => {
    expect(
      () => new VerifiedDeliveryRouter({ senders: undefined as unknown as OutboundSender[], clock: new ManualClock(1) }),
    ).toThrow();
  });

  it("throws if opts.clock is missing", () => {
    expect(
      () => new VerifiedDeliveryRouter({ senders: [], clock: undefined as unknown as ManualClock }),
    ).toThrow();
  });
});

// ===========================================================================
// formatDeliveryText / formatAbstentionNotice — deterministic, exact-string,
// multi-line-safe formatters.
// ===========================================================================

describe("formatDeliveryText", () => {
  it("is deterministic, multi-line-safe, and matches an exact expected string", async () => {
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "line one\nline two — multi-line output";
    const cert = await issueCert(output, decision);
    const stamp = await assessReply(output, { decision, certificate: cert });
    const result: JobExecutionResult = { ok: true, output };

    const text1 = formatDeliveryText(job, result, stamp);
    const text2 = formatDeliveryText(job, result, stamp);
    expect(text1).toBe(text2);

    expect(text1).toBe(
      [
        output,
        "",
        `— verified result for job "${job.name}" (${job.id})`,
        `  badge: verified | certFingerprint: ${stamp.certFingerprint} | pCorrect: ${stamp.pCorrect!.toFixed(3)}`,
      ].join("\n"),
    );
    expect(text1.split("\n").length).toBe(output.split("\n").length + 3);
  });

  it("refuses to format a non-verified stamp as delivered", () => {
    const store = newStore();
    const job = makeJob(store);
    const badStamp: StampedReply = { badge: "unverified", reason: "certificate did not match this message" };
    expect(() => formatDeliveryText(job, { ok: true, output: "x" }, badStamp)).toThrow();
  });
});

describe("formatAbstentionNotice", () => {
  it("is deterministic, multi-line-safe, matches an exact expected string, and structurally cannot include the output", () => {
    const store = newStore();
    const job = makeJob(store);
    const stamp: StampedReply = { badge: "unverified", reason: "certificate did not match this message" };

    const notice1 = formatAbstentionNotice(job, stamp);
    const notice2 = formatAbstentionNotice(job, stamp);
    expect(notice1).toBe(notice2);

    expect(notice1).toBe(
      [
        `Job "${job.name}" (${job.id}) produced a result that could NOT be verified.`,
        `The output has been withheld — it was not delivered.`,
        `Status: unverified`,
        `Reason: certificate did not match this message`,
      ].join("\n"),
    );
    expect(notice1.split("\n")).toHaveLength(4);
  });
});

// ===========================================================================
// PlatformConnector structurally satisfies OutboundSender
// ===========================================================================

describe("OutboundSender / PlatformConnector compatibility", () => {
  it("a real PlatformConnector can be used directly as an OutboundSender (compile-time and at runtime)", async () => {
    const connector: PlatformConnector = new InMemoryConnector("slack");
    const sender: OutboundSender = connector; // compiles only because PlatformConnector structurally satisfies OutboundSender

    await sender.send({ user: "u1", channel: "c1" }, "hello via connector");

    expect((connector as InMemoryConnector).sent).toEqual([
      { target: { user: "u1", channel: "c1" }, text: "hello via connector" },
    ]);

    // A live VerifiedDeliveryRouter accepts it with zero adapter code.
    const store = newStore();
    const job = makeJob(store);
    const decision = emitDecision();
    const output = "delivered straight through a real connector";
    const cert = await issueCert(output, decision);
    const r = new VerifiedDeliveryRouter({ senders: [connector], clock: new ManualClock(1), backoff: async () => {} });
    const receipt = await r.deliver(job, { ok: true, output, verification: { decision, certificate: cert } }, CTX);

    expect(receipt.outcome).toBe("delivered");
    expect((connector as InMemoryConnector).sent).toHaveLength(2);
  });
});

// ===========================================================================
// Runner-level integration — receipt outcomes must be real store RunOutcome
// values, and must actually flow through SchedulerRunner into job history.
// ===========================================================================

describe("SchedulerRunner integration", () => {
  it("a verified execution flows through tick() into store history as 'delivered'", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new InMemoryJobStore(clock);
    const job = store.add({
      name: "integration job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "digest", input: "x" },
      delivery: { platform: "slack", user: "U1" },
    });

    const decision = emitDecision();
    const output = "integration verified output";
    const cert = await issueCert(output, decision);
    const executor: JobExecutor = {
      async execute(): Promise<JobExecutionResult> {
        return { ok: true, output, verification: { decision, certificate: cert } };
      },
    };
    const sender = new FakeSender("slack");
    const deliverer: JobDeliverer = new VerifiedDeliveryRouter({ senders: [sender], clock, backoff: async () => {} });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(5 * 60_000);
    const report = await runner.tick();

    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: report.fired[0].scheduledFor, outcome: "delivered" }]);

    const updated = store.get(job.id)!;
    expect(updated.history).toHaveLength(1);
    const outcome: RunOutcome = updated.history[0].outcome; // DeliveryReceipt.outcome must be assignable to RunOutcome
    expect(outcome).toBe("delivered");
    expect(updated.runCount).toBe(1);
    expect(updated.failCount).toBe(0);
    expect(updated.abstainCount).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("an unverifiable execution flows through tick() into store history as 'abstained' and bumps abstainCount", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new InMemoryJobStore(clock);
    const job = store.add({
      name: "integration abstain job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "digest", input: "x" },
      delivery: { platform: "slack", user: "U1" },
    });

    const executor: JobExecutor = {
      async execute(): Promise<JobExecutionResult> {
        return { ok: true, output: "no evidence attached to this run" };
      },
    };
    const sender = new FakeSender("slack");
    const deliverer: JobDeliverer = new VerifiedDeliveryRouter({ senders: [sender], clock, backoff: async () => {} });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(5 * 60_000);
    await runner.tick();

    const updated = store.get(job.id)!;
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].outcome).toBe("abstained");
    expect(updated.abstainCount).toBe(1);
    expect(updated.failCount).toBe(0);
  });

  it("a delivery whose sender always throws flows through tick() into store history as 'failed' and bumps failCount", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new InMemoryJobStore(clock);
    const job = store.add({
      name: "integration failed job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "digest", input: "x" },
      delivery: { platform: "slack", user: "U1" },
    });

    const decision = emitDecision();
    const output = "would deliver but the sender is broken";
    const cert = await issueCert(output, decision);
    const executor: JobExecutor = {
      async execute(): Promise<JobExecutionResult> {
        return { ok: true, output, verification: { decision, certificate: cert } };
      },
    };
    const sender = new FakeSender("slack", alwaysFail("sender is down"));
    const deliverer: JobDeliverer = new VerifiedDeliveryRouter({ senders: [sender], clock, backoff: async () => {} });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(5 * 60_000);
    await runner.tick();

    const updated = store.get(job.id)!;
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].outcome).toBe("failed");
    expect(updated.failCount).toBe(1);
  });
});
