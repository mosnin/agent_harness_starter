/**
 * Phase 9 checkpoint: cron parse -> tick fire -> gate-verify -> deliver (and
 * honest abstention), proved deterministically under a `ManualClock` through
 * the exact same composition `hades schedule` wires up — `InMemoryJobStore`
 * (parsing via `store.add`), `SchedulerRunner`, and `VerifiedDeliveryRouter`
 * — using ONLY those public exports plus a recording `OutboundSender` and a
 * test executor that attaches REAL STYX gate decisions and REAL ed25519
 * certificates (`../../styx/certificate`). No `Date.now()`, no sleeps, no
 * network, nothing mocked on the product side — every double here is a test
 * double standing in for a caller-supplied executor/sender, never a stand-in
 * for the scheduler engine or the delivery/verification logic itself.
 *
 * Storyline, one every-5-minutes UTC cron job (plus two siblings added at
 * the same instant to prove verified delivery, honest abstention, and
 * misfire catch-up all in the same real pipeline):
 *
 *   1. T0+4:59 tick  -> nothing due yet.
 *   2. T0+5:00 tick  -> the verified job fires once, scheduledFor exactly
 *      T0+5:00, and its real ed25519-certified output reaches the recording
 *      sender with badge "verified" and an independently-recomputable cert
 *      fingerprint. In the very same tick, a sibling job whose executor
 *      attaches TAMPERED evidence (a certificate signed over different text
 *      than it actually returns) abstains — the sender receives an honest
 *      notice that provably excludes the real output.
 *   3. +20 more minutes, one tick -> the verified/tampered jobs each have 4
 *      missed fires under misfire "skip" (3 skipped, latest fires); a third,
 *      catch-up-policy job (misfire "catch-up", limit 2) has 3 missed fires
 *      and fires exactly 2, reporting 1 skipped for a future tick.
 *
 * Final store history/counters are asserted exactly for all three jobs.
 */
import { describe, it, expect } from "vitest";

import { InMemoryJobStore, type ScheduledJob } from "../store";
import { ManualClock } from "../clock";
import { SchedulerRunner, type JobExecutionContext, type JobExecutionResult, type JobExecutor } from "../runner";
import { VerifiedDeliveryRouter, type OutboundSender } from "../delivery";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";
import type { GateDecision } from "../../styx/gate";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

// ===========================================================================
// Test doubles: a recording OutboundSender and a real-STYX-evidence executor
// ===========================================================================

class RecordingSender implements OutboundSender {
  readonly platform: string;
  readonly calls: { target: { user: string; channel?: string }; text: string }[] = [];
  constructor(platform: string) {
    this.platform = platform;
  }
  async send(target: { user: string; channel?: string }, text: string): Promise<void> {
    this.calls.push({ target: { ...target }, text });
  }
}

function certPayloadFor(outputText: string, ctx: JobExecutionContext): CertificatePayload {
  return {
    outputSha256: sha256Hex(outputText),
    taskId: "schedule-checkpoint",
    verifierTier: "T2-genrm",
    ensembleScore: 0.95,
    pCorrect: 0.97,
    epsilon: 0.02,
    traceSha256: sha256Hex(JSON.stringify({ scheduledFor: ctx.scheduledFor })),
    verifierVersions: ["exec-oracle@1.0.0"],
    issuedAt: ctx.firedAt,
  };
}

const REAL_DECISION: GateDecision = { emit: true, score: 0.95, threshold: 0.9, pCorrectEstimate: 0.97 };

const VERIFIED_OUTPUT = 'verified output for job "verified-job"';
const TAMPERED_OUTPUT = "tampered output text";

/**
 * Dispatches on `task.kind`:
 *  - "verified-note": real gate decision (emit:true) + a real ed25519
 *    certificate issued over THIS EXACT output text -> certifiesOutput
 *    matches -> badge "verified".
 *  - "tampered-note": real gate decision (emit:true) + a real ed25519
 *    certificate that is cryptographically valid but was issued over a
 *    DIFFERENT text than the one actually returned -> sha256 mismatch ->
 *    certifiesOutput fails -> badge can never read "verified" no matter how
 *    "real" the signature is.
 *  - anything else: a plain, evidence-free ok:true echo (used by the
 *    catch-up-policy job, which has no delivery target and exists purely to
 *    exercise misfire/catch-up counting).
 */
class StyxCheckpointExecutor implements JobExecutor {
  readonly lastCertificate = new Map<string, VerificationCertificate>();

  constructor(private readonly ca: CertificateAuthority) {}

  async execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult> {
    if (job.task.kind === "verified-note") {
      const cert = await this.ca.issue(certPayloadFor(VERIFIED_OUTPUT, ctx));
      this.lastCertificate.set(job.id, cert);
      return {
        ok: true,
        output: VERIFIED_OUTPUT,
        detail: "executed",
        verification: { decision: REAL_DECISION, certificate: cert },
      };
    }
    if (job.task.kind === "tampered-note") {
      const cert = await this.ca.issue(certPayloadFor("not the real output", ctx));
      this.lastCertificate.set(job.id, cert);
      return {
        ok: true,
        output: TAMPERED_OUTPUT,
        detail: "executed",
        verification: { decision: REAL_DECISION, certificate: cert },
      };
    }
    return { ok: true, output: job.task.input, detail: "note executed" };
  }
}

// ===========================================================================
// The checkpoint
// ===========================================================================

describe("Phase 9 checkpoint: cron parse -> tick fire -> gate-verify -> deliver / abstain", () => {
  it("proves the full pipeline deterministically under a ManualClock", async () => {
    const clock = new ManualClock(T0);
    let counter = 0;
    const store = new InMemoryJobStore(clock, () => `job-${++counter}`);

    const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(42)));
    const executor = new StyxCheckpointExecutor(ca);
    const sender = new RecordingSender("testchat");
    const deliverer = new VerifiedDeliveryRouter({ senders: [sender], clock });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    // --- parse (via store.add) --------------------------------------------
    const verifiedJob = store.add({
      name: "verified-job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "verified-note", input: "n/a" },
      delivery: { platform: "testchat", user: "alice" },
      misfire: "skip",
    });
    const tamperedJob = store.add({
      name: "tampered-job",
      cron: "*/5 * * * *",
      timeZone: "UTC",
      task: { kind: "tampered-note", input: "n/a" },
      delivery: { platform: "testchat", user: "bob" },
      misfire: "skip",
    });
    const catchupJob = store.add({
      name: "catchup-job",
      cron: "*/7 * * * *",
      timeZone: "UTC",
      task: { kind: "note", input: "catchup payload" },
      misfire: "catch-up",
      catchUpLimit: 2,
    });

    expect(verifiedJob.id).toBe("job-1");
    expect(tamperedJob.id).toBe("job-2");
    expect(catchupJob.id).toBe("job-3");

    // --- 1. T0+4:59 -> nothing due yet --------------------------------------
    clock.advance(4 * MIN + 59_000);
    const report1 = await runner.tick();
    expect(report1.evaluated).toBe(3);
    expect(report1.fired).toEqual([]);
    expect(report1.misfiresSkipped).toEqual([]);
    expect(report1.overlapsSkipped).toEqual([]);
    expect(report1.errors).toEqual([]);
    expect(sender.calls).toHaveLength(0);

    // --- 2. T0+5:00 -> verified delivers, tampered abstains -----------------
    clock.advance(1_000);
    expect(clock.now()).toBe(T0 + 5 * MIN);
    const T0_5 = T0 + 5 * MIN;

    const report2 = await runner.tick();
    expect(report2.fired).toEqual([
      { jobId: verifiedJob.id, scheduledFor: T0_5, outcome: "delivered" },
      { jobId: tamperedJob.id, scheduledFor: T0_5, outcome: "abstained" },
    ]);
    expect(report2.misfiresSkipped).toEqual([]);
    expect(report2.overlapsSkipped).toEqual([]);
    expect(report2.errors).toEqual([]);

    expect(sender.calls).toHaveLength(2);

    // Verified delivery: real output, real badge, independently-recomputable
    // cert fingerprint.
    const cert1 = executor.lastCertificate.get(verifiedJob.id)!;
    const fingerprint1 = sha256Hex(cert1.signature).slice(0, 12);
    expect(sender.calls[0].target).toEqual({ user: "alice", channel: undefined });
    expect(sender.calls[0].text).toContain(VERIFIED_OUTPUT);
    expect(sender.calls[0].text).toContain("badge: verified");
    expect(sender.calls[0].text).toContain(`certFingerprint: ${fingerprint1}`);
    expect(sender.calls[0].text).toContain(`pCorrect: ${cert1.payload.pCorrect.toFixed(3)}`);

    // Tampered evidence: honest abstention, output provably excluded.
    expect(sender.calls[1].target).toEqual({ user: "bob", channel: undefined });
    expect(sender.calls[1].text).not.toContain(TAMPERED_OUTPUT);
    expect(sender.calls[1].text).toContain('Job "tampered-job"');
    expect(sender.calls[1].text).toContain("could NOT be verified");
    expect(sender.calls[1].text).toContain("withheld");
    expect(sender.calls[1].text).toContain("Status: unverified");
    expect(sender.calls[1].text).toContain("certificate did not match this message");

    // Store state after tick 2.
    const v2 = store.get(verifiedJob.id)!;
    expect(v2.runCount).toBe(1);
    expect(v2.failCount).toBe(0);
    expect(v2.abstainCount).toBe(0);
    expect(v2.lastFireAt).toBe(T0_5);
    expect(v2.history).toEqual([
      { firedAt: T0_5, scheduledFor: T0_5, outcome: "delivered", detail: v2.history[0].detail, durationMs: v2.history[0].durationMs },
    ]);
    expect(v2.history[0].detail).toContain("certificate cryptographically matches this reply");

    const t2 = store.get(tamperedJob.id)!;
    expect(t2.runCount).toBe(1);
    expect(t2.failCount).toBe(0);
    expect(t2.abstainCount).toBe(1);
    expect(t2.lastFireAt).toBe(T0_5);
    expect(t2.history[0].outcome).toBe("abstained");
    expect(t2.history[0].detail).toContain("certificate did not match this message");

    const c2 = store.get(catchupJob.id)!;
    expect(c2.runCount).toBe(0);
    expect(c2.lastFireAt).toBeUndefined();

    // --- 3. +20 more minutes, one tick --------------------------------------
    clock.advance(20 * MIN);
    expect(clock.now()).toBe(T0 + 25 * MIN);
    const T0_7 = T0 + 7 * MIN;
    const T0_14 = T0 + 14 * MIN;
    const T0_25 = T0 + 25 * MIN;

    const report3 = await runner.tick();

    expect(report3.fired).toEqual([
      { jobId: verifiedJob.id, scheduledFor: T0_25, outcome: "delivered" },
      { jobId: tamperedJob.id, scheduledFor: T0_25, outcome: "abstained" },
      { jobId: catchupJob.id, scheduledFor: T0_7, outcome: "delivered" },
      { jobId: catchupJob.id, scheduledFor: T0_14, outcome: "delivered" },
    ]);
    // verified/tampered: 4 due (10,15,20,25) under misfire "skip" -> 3 missed
    // each. catch-up job: 3 due (7,14,21) under catch-up limit 2 -> fires
    // exactly 2, reports exactly 1 skipped.
    expect(report3.misfiresSkipped).toEqual([
      { jobId: verifiedJob.id, missed: 3 },
      { jobId: tamperedJob.id, missed: 3 },
      { jobId: catchupJob.id, missed: 1 },
    ]);
    expect(report3.overlapsSkipped).toEqual([]);
    expect(report3.errors).toEqual([]);

    // Two more sends (verified + abstain); the catch-up job has no delivery
    // target, so it never touches the sender.
    expect(sender.calls).toHaveLength(4);
    const cert2 = executor.lastCertificate.get(verifiedJob.id)!;
    const fingerprint2 = sha256Hex(cert2.signature).slice(0, 12);
    expect(sender.calls[2].text).toContain(`certFingerprint: ${fingerprint2}`);
    expect(sender.calls[2].text).toContain("badge: verified");
    expect(sender.calls[3].text).not.toContain(TAMPERED_OUTPUT);
    expect(sender.calls[3].text).toContain("Status: unverified");

    // --- Final store history/counters, asserted exactly ---------------------
    const vFinal = store.get(verifiedJob.id)!;
    expect(vFinal.runCount).toBe(2);
    expect(vFinal.failCount).toBe(0);
    expect(vFinal.abstainCount).toBe(0);
    expect(vFinal.lastFireAt).toBe(T0_25);
    expect(vFinal.history.map((h) => ({ firedAt: h.firedAt, scheduledFor: h.scheduledFor, outcome: h.outcome }))).toEqual([
      { firedAt: T0_5, scheduledFor: T0_5, outcome: "delivered" },
      { firedAt: T0_25, scheduledFor: T0_25, outcome: "delivered" },
    ]);

    const tFinal = store.get(tamperedJob.id)!;
    expect(tFinal.runCount).toBe(2);
    expect(tFinal.failCount).toBe(0);
    expect(tFinal.abstainCount).toBe(2);
    expect(tFinal.lastFireAt).toBe(T0_25);
    expect(tFinal.history.map((h) => ({ firedAt: h.firedAt, scheduledFor: h.scheduledFor, outcome: h.outcome }))).toEqual([
      { firedAt: T0_5, scheduledFor: T0_5, outcome: "abstained" },
      { firedAt: T0_25, scheduledFor: T0_25, outcome: "abstained" },
    ]);

    const cFinal = store.get(catchupJob.id)!;
    expect(cFinal.runCount).toBe(2);
    expect(cFinal.failCount).toBe(0);
    expect(cFinal.abstainCount).toBe(0);
    // lastFireAt only ever advances to the last FIRED instant (14m), never
    // the still-pending, catch-up-limited 21m mark — that is what leaves the
    // remaining backlog for a future tick instead of losing it.
    expect(cFinal.lastFireAt).toBe(T0_14);
    expect(cFinal.history.map((h) => ({ firedAt: h.firedAt, scheduledFor: h.scheduledFor, outcome: h.outcome, detail: h.detail }))).toEqual([
      { firedAt: T0_25, scheduledFor: T0_7, outcome: "delivered", detail: "no delivery target — result stored only" },
      { firedAt: T0_25, scheduledFor: T0_14, outcome: "delivered", detail: "no delivery target — result stored only" },
    ]);
  });
});
