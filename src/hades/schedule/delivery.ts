/**
 * The delivery router for `src/hades/schedule/**` — the beyond-Hermes moat
 * for Phase 9: turns a completed scheduled-job execution into a message on a
 * real messaging surface, but ONLY ever labels a message "verified" when the
 * REAL STYX gate + certificate evidence for THAT EXACT output text says so.
 *
 * ## The one invariant this module exists to enforce
 *
 * There is no code path in this file that can deliver unverified content
 * while claiming it is verified. The badge is never a string this module
 * writes by hand — it is always the return value of {@link assessReply}
 * (`../gateway/badge`), which itself never trusts a caller-supplied verdict:
 * it recomputes sha256(outputText), re-verifies the ed25519 signature over
 * the certificate's canonical payload, and lets the gate's `emit:false`
 * outrank even a cryptographically perfect certificate. This module's own
 * job is narrower and stricter than "format a nice message" — it is the
 * last gate between that honest verdict and an actual outbound send:
 *
 *   - `badge === "verified"` AND `result.ok === true`  -> deliver the real
 *     output, stamped with the badge, cert fingerprint, and pCorrect.
 *   - anything else (`"abstained"`, `"unverified"`, or a `badge === "verified"`
 *     evidence pair riding on a job the executor itself reported as failed)
 *     -> the raw output is NEVER sent. Depending on `onUnverified`, either an
 *     honest abstention notice goes out (naming the job, quoting the real
 *     verification reason, never the output text) or nothing goes out at all.
 *
 * `result.ok === false` is deliberately folded into the same "cannot be
 * delivered" branch as a failed verification, even on the vanishingly rare
 * path where the attached evidence happens to check out cryptographically —
 * an executor that reported failure has nothing trustworthy to certify in
 * the first place, and "the crypto checks out" is not the same claim as "the
 * executor believes this answer is right". Silence (or an abstention notice)
 * is always the honest choice there, never a "verified" delivery.
 *
 * ## Transport
 *
 * Sending is delegated to injected {@link OutboundSender}s, keyed by
 * `job.delivery.platform`. The existing `PlatformConnector` (`../gateway/connector`)
 * already satisfies this interface structurally — see the compile-time proof
 * below — so any live gateway connector (Slack, Discord, Telegram, ...) can be
 * registered here as-is with zero adapter code. Sends are retried up to
 * `maxAttempts` times through an injectable `backoff`, so production gets real
 * exponential backoff while tests stay deterministic and sleep-free.
 */

import { assessReply } from "../gateway/badge";
import type { BadgeEvidence, StampedReply, TrustBadge } from "../gateway/badge";
import type { PlatformConnector } from "../gateway/connector";
import type { ScheduledJob, DeliverySpec } from "./store";
import type { Clock } from "./clock";
import type { JobExecutionResult, JobExecutionContext } from "./runner";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface DeliveryReceipt {
  jobId: string;
  outcome: "delivered" | "abstained" | "withheld" | "failed";
  badge: TrustBadge;
  reason: string;
  target?: DeliverySpec;
  deliveredText?: string;
  attempts: number;
  at: number;
  /**
   * Mirrors `reason` exactly. Not part of the locked field list, but kept so
   * that `SchedulerRunner` (`./runner.ts`, out of scope for this workstream —
   * see the module doc there: "runner.ts only takes a type-only dependency
   * on `./delivery`") can read `receipt.detail` the way it already does for
   * both the tick and `runOnce` paths. Always populated, never diverges from
   * `reason` — there is no second source of truth here.
   */
  detail: string;
}

export interface JobDeliverer {
  deliver(job: ScheduledJob, result: JobExecutionResult, ctx: JobExecutionContext): Promise<DeliveryReceipt>;
}

export interface OutboundSender {
  readonly platform: string;
  send(target: { user: string; channel?: string }, text: string): Promise<void>;
}

// Compile-time proof (exercised operationally too, in delivery.test.ts) that
// the real PlatformConnector already structurally satisfies OutboundSender:
// any registered gateway connector can be handed to VerifiedDeliveryRouter
// with zero adapter code. If connector.ts's `send` signature ever drifts,
// this line stops compiling instead of silently rotting.
type ConnectorSatisfiesOutboundSender = PlatformConnector extends OutboundSender ? true : false;
const _connectorSatisfiesOutboundSender: ConnectorSatisfiesOutboundSender = true;
void _connectorSatisfiesOutboundSender;

export interface VerifiedDeliveryOptions {
  senders: OutboundSender[];
  clock: Clock;
  /** What to do when the output cannot be delivered as verified. Default "notify". */
  onUnverified?: "notify" | "withhold";
  /** Max send attempts per delivery (1 initial + retries). Default 3. */
  maxAttempts?: number;
  /**
   * Called between failed send attempts, `attempt` = the attempt number that
   * just failed (1-indexed), called `min(maxAttempts, attempts) - 1` times
   * total for a given delivery. Defaults to a real exponential backoff
   * (250ms * 2^(attempt-1)) for production; tests inject a fast/no-op
   * function so no suite ever sleeps on the wall clock.
   */
  backoff?: (attempt: number) => Promise<void>;
}

// ===========================================================================
// Small pure helpers
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultBackoff(attempt: number): Promise<void> {
  const delayMs = 250 * 2 ** Math.max(0, attempt - 1);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

interface SendOutcome {
  success: boolean;
  attempts: number;
  lastError?: string;
}

// ===========================================================================
// formatDeliveryText / formatAbstentionNotice — deterministic, exact-string,
// multi-line-safe formatters. Neither constructs or overrides a badge; both
// take the already-assessed StampedReply as-is.
// ===========================================================================

/**
 * Format the outbound text for a VERIFIED delivery: the real output, plus a
 * badge line carrying the cert fingerprint and calibrated pCorrect. Throws
 * if handed a non-"verified" stamp — this function is only ever called by
 * `VerifiedDeliveryRouter` after it has confirmed `stamp.badge === "verified"`,
 * and refusing to format an unverified stamp as if it were verified is the
 * same fail-closed posture the rest of this module holds everywhere else.
 */
export function formatDeliveryText(job: ScheduledJob, result: JobExecutionResult, stamp: StampedReply): string {
  if (stamp.badge !== "verified" || stamp.certFingerprint === undefined || stamp.pCorrect === undefined) {
    throw new Error(
      `formatDeliveryText: refusing to format a non-verified stamp as delivered (badge=${stamp.badge})`,
    );
  }
  return [
    result.output,
    "",
    `— verified result for job "${job.name}" (${job.id})`,
    `  badge: verified | certFingerprint: ${stamp.certFingerprint} | pCorrect: ${stamp.pCorrect.toFixed(3)}`,
  ].join("\n");
}

/**
 * Format an honest abstention notice: names the job, states plainly that the
 * result was withheld because it could not be verified, and quotes the real
 * verification reason — and NEVER includes the underlying (unverified)
 * output text, by construction (this function is never handed it).
 */
export function formatAbstentionNotice(job: ScheduledJob, stamp: StampedReply): string {
  return [
    `Job "${job.name}" (${job.id}) produced a result that could NOT be verified.`,
    `The output has been withheld — it was not delivered.`,
    `Status: ${stamp.badge}`,
    `Reason: ${stamp.reason}`,
  ].join("\n");
}

// ===========================================================================
// VerifiedDeliveryRouter
// ===========================================================================

export class VerifiedDeliveryRouter implements JobDeliverer {
  private readonly sendersByPlatform: Map<string, OutboundSender>;
  private readonly clock: Clock;
  private readonly onUnverified: "notify" | "withhold";
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => Promise<void>;

  constructor(opts: VerifiedDeliveryOptions) {
    if (!opts || !Array.isArray(opts.senders)) {
      throw new TypeError("VerifiedDeliveryRouter: opts.senders must be an array of OutboundSender");
    }
    if (!opts.clock) {
      throw new TypeError("VerifiedDeliveryRouter: opts.clock is required");
    }
    this.sendersByPlatform = new Map(opts.senders.map((s) => [s.platform, s] as const));
    this.clock = opts.clock;
    this.onUnverified = opts.onUnverified ?? "notify";
    const rawMaxAttempts = opts.maxAttempts ?? 3;
    this.maxAttempts =
      Number.isInteger(rawMaxAttempts) && rawMaxAttempts >= 1 ? rawMaxAttempts : 3;
    this.backoff = opts.backoff ?? defaultBackoff;
  }

  async deliver(job: ScheduledJob, result: JobExecutionResult, _ctx: JobExecutionContext): Promise<DeliveryReceipt> {
    const at = this.clock.now();

    // The ONLY producer of the badge: the real STYX evidence for this exact
    // output text, re-derived every time, never trusted from a caller.
    const evidence: BadgeEvidence = (result.verification ?? {}) as BadgeEvidence;
    const stamp = await assessReply(result.output, evidence);

    const target = job.delivery;
    if (!target) {
      return this.receipt(job.id, "failed", stamp, "job has no delivery target configured; nothing to deliver", undefined, undefined, 0, at);
    }

    const sender = this.sendersByPlatform.get(target.platform);
    if (!sender) {
      const known = [...this.sendersByPlatform.keys()].sort().join(", ") || "none";
      return this.receipt(
        job.id,
        "failed",
        stamp,
        `no sender registered for platform "${target.platform}" (known platforms: ${known})`,
        target,
        undefined,
        0,
        at,
      );
    }

    const verified = result.ok && stamp.badge === "verified";

    if (verified) {
      const text = formatDeliveryText(job, result, stamp);
      const send = await this.sendWithRetry(sender, target, text);
      if (send.success) {
        return this.receipt(job.id, "delivered", stamp, stamp.reason, target, text, send.attempts, at);
      }
      return this.receipt(
        job.id,
        "failed",
        stamp,
        send.lastError ?? "send failed with an unknown error",
        target,
        undefined,
        send.attempts,
        at,
      );
    }

    // Not deliverable as verified: either the evidence itself didn't clear
    // (abstained/unverified) or the executor reported failure outright. The
    // reason is always honest about WHICH of those it was, even though the
    // badge field always carries the real, unmodified assessReply verdict.
    const reason = result.ok
      ? stamp.reason
      : `job execution reported failure (result.ok=false)${result.detail ? `: ${result.detail}` : ""}; verification: ${stamp.reason}`;

    if (this.onUnverified === "withhold") {
      return this.receipt(job.id, "withheld", stamp, reason, target, undefined, 0, at);
    }

    const notice = formatAbstentionNotice(job, stamp);
    const send = await this.sendWithRetry(sender, target, notice);
    if (send.success) {
      return this.receipt(job.id, "abstained", stamp, reason, target, notice, send.attempts, at);
    }
    return this.receipt(
      job.id,
      "failed",
      stamp,
      send.lastError ?? "abstention notice send failed with an unknown error",
      target,
      undefined,
      send.attempts,
      at,
    );
  }

  private receipt(
    jobId: string,
    outcome: DeliveryReceipt["outcome"],
    stamp: StampedReply,
    reason: string,
    target: DeliverySpec | undefined,
    deliveredText: string | undefined,
    attempts: number,
    at: number,
  ): DeliveryReceipt {
    return {
      jobId,
      outcome,
      badge: stamp.badge,
      reason,
      detail: reason,
      target,
      deliveredText,
      attempts,
      at,
    };
  }

  /**
   * Attempt `sender.send()` up to `maxAttempts` times, awaiting the injected
   * `backoff` between failed attempts (never after the final attempt). The
   * returned `attempts` is however many calls were actually made — 1 on a
   * first-try success, up to `maxAttempts` on total failure.
   */
  private async sendWithRetry(
    sender: OutboundSender,
    target: { user: string; channel?: string },
    text: string,
  ): Promise<SendOutcome> {
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await sender.send({ user: target.user, channel: target.channel }, text);
        return { success: true, attempts: attempt };
      } catch (err) {
        lastError = errorMessage(err);
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
        }
      }
    }
    return { success: false, attempts: this.maxAttempts, lastError };
  }
}
