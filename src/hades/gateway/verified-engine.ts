/**
 * The real brain, honestly gated.
 *
 * {@link verifiedSwarmEngine} is a {@link GatewayAgentEngine} — the same seam
 * {@link swarmEngine} (see ./agent-handler) fills with an *unverified* real
 * swarm — except every reply also carries a genuine STYX
 * {@link GateDecision} plus, when (and only when) the gate actually emits, a
 * real ed25519 {@link VerificationCertificate} bound to the exact reply text
 * via `authority.issue`. Nothing here is a demo: the gate and authority are
 * caller-supplied real STYX primitives (see ../styx/gate, ../styx/certificate),
 * never re-implemented or mocked in this module.
 *
 * ## Goal → text
 *
 * Text mapping is deliberately byte-for-byte the same honest semantics as
 * {@link swarmEngine}: a completed goal's synthesis (plus a contradiction
 * warning when any were found), an aborted goal's cancellation notice, or an
 * explicit "no verified answer" notice for anything else — including a
 * `startGoal`/`done` rejection. No branch ever spells a fabricated success.
 *
 * ## Goal → evidence
 *
 * The gate is asked to score *every* turn, success or failure — abstention
 * is itself honest evidence, and {@link BadgeStamper} (see ./badge) needs a
 * `decision` on every reply to render "abstained" rather than silently
 * showing nothing. A certificate is issued ONLY when `decision.emit` is
 * true; a failed/aborted/errored turn (which scores 0, see
 * {@link scoreGoalSignals}) always gets a non-emitting decision and never a
 * certificate.
 *
 * @module hades/gateway/verified-engine
 */

import { ConformalGate, type GateDecision } from "../styx/gate";
import { CertificateAuthority, sha256Hex, type CertificatePayload } from "../styx/certificate";
import type { GatewayManager } from "../../swarm-runtime/gateway/gateway";
import type { Goal } from "../../swarm-runtime/types";
import type { GatewayAgentEngine, AgentTurn, AgentTurnResult } from "./agent-handler";

// ---------------------------------------------------------------------------
// GoalEvidenceSignals — the honest, minimal correctness signal set
// ---------------------------------------------------------------------------

/**
 * The only correctness-relevant facts {@link extractGoalSignals} is willing
 * to claim about a finished {@link Goal}. Deliberately narrow: no field here
 * is anything other than a direct or provably-derived read of a real `Goal`
 * property.
 */
export interface GoalEvidenceSignals {
  completed: boolean;
  verifiedTasks: number;
  totalTasks: number;
  contradictionCount: number;
}

/** Always-0-signal reading for a turn that never produced a `Goal` at all. */
const NO_GOAL_SIGNALS: GoalEvidenceSignals = {
  completed: false,
  verifiedTasks: 0,
  totalTasks: 0,
  contradictionCount: 0,
};

/**
 * Read the correctness signals a `Goal` honestly carries — and nothing it
 * doesn't.
 *
 * `Goal` (see ../../swarm-runtime/types) has no per-task "verified count"
 * field distinct from its task list — but `SwarmManager` only ever flips a
 * goal's `status` to `"completed"` once *every one* of its tasks has reached
 * `WorkerTaskStatus === "verified"` (see swarm-runtime/manager/manager.ts,
 * `onProgress`: `tasks.every(t => t.status === "verified")`). That invariant
 * is the only honest bridge from a bare `Goal` to a verified/total ratio:
 *
 *  - `totalTasks`    = `goal.taskIds.length` — the real task count.
 *  - `verifiedTasks` = `totalTasks` when `completed`, else `0` — fail-closed:
 *    a goal we didn't see reach the all-verified state is credited with
 *    zero verified tasks, never an invented partial count.
 *  - `contradictionCount` = `goal.contradictions?.length ?? 0`.
 *
 * Never reads a clock, never touches randomness, never throws — a
 * malformed/partial `Goal` (missing `taskIds` or `contradictions`) degrades
 * to `0`, not a crash.
 */
export function extractGoalSignals(goal: Goal): GoalEvidenceSignals {
  const completed = goal.status === "completed";
  const totalTasks = Array.isArray(goal.taskIds) ? goal.taskIds.length : 0;
  const verifiedTasks = completed ? totalTasks : 0;
  const contradictionCount = Array.isArray(goal.contradictions) ? goal.contradictions.length : 0;
  return { completed, verifiedTasks, totalTasks, contradictionCount };
}

/**
 * Each cross-claim contradiction found across a goal's verified results
 * multiplies the score by this factor. 0.5 means one contradiction halves
 * the score, two quarters it, and so on — strictly decreasing, never zeroing
 * out a single-contradiction goal outright (a goal can still clear a loose
 * enough gate threshold with one contradiction; the point is monotone
 * distrust, not an on/off switch).
 */
const CONTRADICTION_PENALTY = 0.5;

/**
 * Map {@link GoalEvidenceSignals} to a single verifier score in `[0, 1]` for
 * the conformal gate — pure, documented, and monotone:
 *
 *  - `0` when the goal never completed, or `totalTasks === 0` (nothing to
 *    have verified in the first place — a ratio over zero tasks asserts
 *    nothing).
 *  - otherwise `clamp01(verifiedTasks / totalTasks) * CONTRADICTION_PENALTY
 *    ^ contradictionCount` — the verified ratio, multiplicatively penalized
 *    once per contradiction.
 *
 * Monotone in both directions: strictly non-decreasing in `verifiedTasks`
 * (for fixed `totalTasks`/`contradictionCount`), and strictly decreasing in
 * `contradictionCount` whenever the ratio is positive. Defensive against
 * hostile input — `NaN`, `Infinity`, negative counts, `verifiedTasks >
 * totalTasks` — by treating anything non-finite or out of range as its most
 * conservative (fail-closed) reading rather than propagating `NaN` or an
 * out-of-bounds score. Never reads a clock or randomness.
 */
export function scoreGoalSignals(s: GoalEvidenceSignals): number {
  if (!s || !s.completed) return 0;

  const total = s.totalTasks;
  if (!Number.isFinite(total) || total <= 0) return 0;

  const verifiedRaw = s.verifiedTasks;
  const verified = Number.isFinite(verifiedRaw) ? Math.max(0, Math.min(verifiedRaw, total)) : 0;
  const ratio = verified / total;

  const contradictionsRaw = s.contradictionCount;
  const contradictions =
    Number.isFinite(contradictionsRaw) && contradictionsRaw > 0 ? Math.floor(contradictionsRaw) : 0;
  const penalty = Math.pow(CONTRADICTION_PENALTY, contradictions);

  // ratio and penalty are each already within [0, 1] given the guards above;
  // clamp once more anyway so a future change to those guards can never leak
  // an out-of-range score past this function.
  return Math.max(0, Math.min(1, ratio * penalty));
}

// ---------------------------------------------------------------------------
// Goal -> reply text (byte-for-byte swarmEngine's honest semantics)
// ---------------------------------------------------------------------------

function formatGoalReplyText(goal: Goal): string {
  if (goal.status === "completed") {
    const synth = typeof goal.synthesis === "string" ? goal.synthesis : JSON.stringify(goal.synthesis);
    const warn =
      goal.contradictions && goal.contradictions.length
        ? ` (${goal.contradictions.length} contradiction(s) detected across results)`
        : "";
    return `${synth}${warn}`;
  }
  if (goal.status === "aborted") {
    return "The goal was cancelled or ran out of budget before completing.";
  }
  // "failed", or a done-promise that resolved without ever reaching a
  // terminal success state — never spelled as a success.
  return `The swarm could not produce a verified answer for this goal (status: ${goal.status}).`;
}

/** Deterministic, fixed-key JSON of the exact signals a certificate's trace is bound to. */
function canonicalSignalsJson(s: GoalEvidenceSignals): string {
  return JSON.stringify({
    completed: s.completed,
    verifiedTasks: s.verifiedTasks,
    totalTasks: s.totalTasks,
    contradictionCount: s.contradictionCount,
  });
}

// ---------------------------------------------------------------------------
// verifiedSwarmEngine
// ---------------------------------------------------------------------------

export interface VerifiedSwarmEngineOptions {
  /** MUST already be calibrated by the caller (via `.calibrate(...)`). */
  gate: ConformalGate;
  authority: CertificateAuthority;
  /** Passed through to `manager.startGoal` exactly like {@link swarmEngine}. */
  timeoutMs?: number;
  /** Certificate `issuedAt` source. Default `Date.now`. */
  now?: () => number;
  /**
   * Certificate `taskId` for a turn. Default: the real `goalId` returned by
   * `startGoal` (falling back to `turn.sessionId` if a goal id was never
   * obtained, e.g. `startGoal` itself threw before returning one).
   */
  taskIdFor?: (turn: AgentTurn) => string;
}

/**
 * Build the real, verified engine: drives `manager` exactly like
 * {@link swarmEngine} for the reply text, then scores the finished (or
 * failed) turn through the real `ConformalGate` and attaches a real
 * ed25519 certificate whenever — and only whenever — the gate emits.
 *
 * `respond()` never throws for a normal goal outcome (completed / aborted /
 * failed / a rejected `done`/`startGoal`) — those all degrade to an honest
 * reply text with a non-emitting decision and no certificate, exactly like
 * a failed/aborted goal is handled by {@link swarmEngine}. It does propagate
 * if `opts.gate` violates its documented precondition of having already been
 * calibrated (a caller/integration bug, not a per-turn condition).
 */
export function verifiedSwarmEngine(manager: GatewayManager, opts: VerifiedSwarmEngineOptions): GatewayAgentEngine {
  const now = opts.now ?? (() => Date.now());

  return {
    mode: "real",
    async respond(turn: AgentTurn): Promise<AgentTurnResult> {
      let goal: Goal | undefined;
      let goalId: string | undefined;
      let replyText: string;

      try {
        const started = await manager.startGoal(turn.text, { timeoutMs: opts.timeoutMs });
        goalId = started.goalId;
        goal = await started.done;
        replyText = formatGoalReplyText(goal);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        replyText = `The swarm could not complete this goal: ${reason}`;
      }

      const signals = goal ? extractGoalSignals(goal) : NO_GOAL_SIGNALS;
      const score = scoreGoalSignals(signals);
      const decision: GateDecision = opts.gate.decide(score);

      if (!decision.emit) {
        // Fail-closed: an abstained (or never-scored-verified) turn attaches
        // its honest, non-emitting decision and NO certificate — badge.ts
        // renders this as "abstained", never "verified".
        return { text: replyText, decision };
      }

      const taskId = opts.taskIdFor ? opts.taskIdFor(turn) : goalId ?? turn.sessionId;
      const payload: CertificatePayload = {
        outputSha256: sha256Hex(replyText),
        taskId,
        verifierTier: "T4-goal-consistency",
        ensembleScore: score,
        pCorrect: decision.pCorrectEstimate,
        epsilon: opts.gate.stats().epsilon,
        traceSha256: sha256Hex(canonicalSignalsJson(signals)),
        verifierVersions: ["gateway.verified-engine.v1"],
        issuedAt: now(),
      };
      const certificate = await opts.authority.issue(payload);

      return { text: replyText, decision, certificate };
    },
  };
}
