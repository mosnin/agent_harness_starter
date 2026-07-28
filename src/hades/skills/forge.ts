/**
 * forge — the FORGE half of the closed learning loop, and the place the safety
 * property is actually enforced.
 *
 * `../research/gate-journal.ts` captures a completed run's trajectory with the
 * verification gate's terminal verdict attached. This module turns those
 * journal entries into a candidate SKILL.md — and, far more importantly,
 * REFUSES to turn most of them into anything at all.
 *
 * ## The refusal is the product
 *
 * A closed learning loop that distils a skill from whatever trajectory the
 * model felt good about has a specific, well-understood failure mode: the
 * model is the thing an attacker is manipulating, so "the model liked this
 * run" is precisely the wrong admission criterion. One successful
 * prompt-injection becomes a poisoned SKILL.md that persists on disk and is
 * re-loaded into every subsequent run. The attack pays off forever.
 *
 * Hades admits a trajectory only when an INDEPENDENT verification gate
 * certified the run's answer. {@link forgeFromVerified} therefore does its
 * gate-outcome filter FIRST, before it looks at certificates, before it looks
 * at trajectory content, before `synthesizeSkill` is called at all:
 *
 *   - `declined` → refused, code `declined-by-gate`
 *   - `refuted`  → refused, code `refuted-by-gate`
 *
 * **A refused entry is refused even when it carries a certificate that
 * verifies.** That is not redundancy, it is the whole point. A certificate
 * attests "this payload was issued by the holder of this key over these exact
 * trace bytes" — it is an integrity claim, not a correctness claim, and
 * `certificate.ts` says so in its own header. If the forge admitted anything
 * whose signature checked out, an attacker holding (or an environment
 * misconfiguring) the issuing key could launder a refuted run into a
 * permanent skill. The gate verdict is the correctness leg; nothing may
 * substitute for it. There is a test named for this exact case, and it is the
 * most important test in this file's suite.
 *
 * ## What this module does NOT do
 *
 * It does not re-implement synthesis. Everything after the gate-outcome filter
 * is delegated verbatim to the already-locked `synthesizeSkill`, which does the
 * ed25519 verification, the independent trace-hash recomputation, the
 * conformal-consistency check on the certificate's own numbers, and the
 * prompt-injection / frontmatter-forgery scan. This module adds one admission
 * rule in front of that pipeline and an honest tally behind it.
 *
 * It does not promote. `forgeFromVerified` returns SKILL.md *content*; it never
 * writes to a skills directory, and the CLI surface (`hades skill forge`) writes
 * a CANDIDATE only. Promotion stays where it already lived: the paired holdout
 * exit gate (`./holdout.ts`), the hash-chained track record, and the demotion
 * trust policy. A learning loop that promotes on the strength of "we made a
 * skill" rather than "the skill measurably helped on held-out runs" is just
 * the same unverified-self-approval problem one layer up.
 *
 * REAL-VS-MOCK POLICY: no LLM, no network, no filesystem, no clock beyond the
 * injectable `now` passed through to synthesis. Every number in a
 * {@link ForgeReport} is a count of things that actually happened to actual
 * entries. Nothing is estimated and nothing is rounded up.
 *
 * @module hades/skills/forge
 */

import type { GateOutcome, JournaledRun } from "../research/gate-journal";
import {
  synthesizeSkill,
  type SkillProvenance,
  type SynthesisRejection,
  type VerifiedTrajectory,
} from "./synthesize";
import type { SkillManifest } from "./skill-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a journal entry did not become skill material.
 *
 * The first three codes are this module's own admission rules; the rest are
 * `SynthesisRejection["code"]` values passed through verbatim from
 * `synthesizeSkill` so a caller never has to guess which layer refused.
 */
export type ForgeRefusalCode =
  /** The gate asked for revision — it could not certify this answer. */
  | "declined-by-gate"
  /** The gate rejected this answer outright. */
  | "refuted-by-gate"
  /** No gate verdict is attached at all, so nothing certified this run. */
  | "no-gate-verdict"
  /** Verified by the gate, but with no certificate to bind the trajectory bytes. */
  | "uncertified"
  | SynthesisRejection["code"];

/** One refused entry, identified well enough to go find it. */
export interface ForgeRefusal {
  /** `trajectory.goalId`, or `"<entry N>"` when the entry was too malformed to have one. */
  goalId: string;
  code: ForgeRefusalCode;
  /**
   * The gate outcome that caused a gate-level refusal, so the reason text and
   * the machine-readable field always agree. Absent for synthesis-level
   * refusals, which happened after the gate filter already passed.
   */
  outcome?: GateOutcome;
  /** Human-readable. For a gate-level refusal this ALWAYS names the verdict. */
  detail: string;
}

/** The honest accounting of one forge attempt. */
export interface ForgeReport {
  ok: boolean;
  /** Journal entries handed to this call. */
  considered: number;
  /** Entries whose gate outcome was `verified` — the only ones synthesis ever saw. */
  eligible: number;
  /** Entries synthesis actually accepted as sources for the emitted skill. */
  used: number;
  /** Every refusal, gate-level and synthesis-level, in entry order. */
  refused: ForgeRefusal[];
  /** Counts by gate outcome across everything considered. */
  byOutcome: Record<GateOutcome | "missing", number>;
  manifest?: SkillManifest;
  /** The SKILL.md bytes. Present iff `ok`. */
  content?: string;
  provenance?: SkillProvenance;
}

/** Knobs, forwarded to `synthesizeSkill` unchanged. */
export interface ForgeOptions {
  name?: string;
  version?: string;
  /** Minimum distinct successful tools across ALL accepted sources. Default 2 (synthesis's own default). */
  minSuccessfulTools?: number;
  /** Injectable clock for `synthesizedAt`. Default `Date.now()`. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * The gate-outcome admission rule, isolated so it can be tested and read on
 * its own.
 *
 * Deliberately looks at exactly one thing: `run.gate.outcome`. It does not
 * consult the certificate, `trajectory.success`, the score, or the reasons —
 * a rule with more inputs is a rule with more ways to be talked around, and
 * this is the rule the whole safety story rests on.
 */
export function admitForForge(
  run: JournaledRun,
  index = 0
): { ok: true } | { ok: false; refusal: ForgeRefusal } {
  const goalId = run?.trajectory?.goalId ?? `<entry ${index}>`;
  const outcome = run?.gate?.outcome;

  if (outcome === "verified") return { ok: true };

  if (outcome === "declined") {
    return {
      ok: false,
      refusal: {
        goalId,
        code: "declined-by-gate",
        outcome: "declined",
        detail:
          `refusing to forge a skill from goal "${goalId}": the verification gate returned verdict "declined" ` +
          `(raw gate verdict "${run.gate.gateVerdict}") — it could not certify this answer. Only a "verified" ` +
          `trajectory may become a skill, no matter what else the entry carries.` +
          reasonSuffix(run),
      },
    };
  }

  if (outcome === "refuted") {
    return {
      ok: false,
      refusal: {
        goalId,
        code: "refuted-by-gate",
        outcome: "refuted",
        detail:
          `refusing to forge a skill from goal "${goalId}": the verification gate returned verdict "refuted" ` +
          `(raw gate verdict "${run.gate.gateVerdict}") — it rejected this answer. Only a "verified" trajectory ` +
          `may become a skill, no matter what else the entry carries.` +
          reasonSuffix(run),
      },
    };
  }

  return {
    ok: false,
    refusal: {
      goalId,
      code: "no-gate-verdict",
      detail:
        `refusing to forge a skill from goal "${goalId}": the entry carries no gate verdict ` +
        `(gate.outcome=${JSON.stringify(outcome)}). An unjudged run is not a verified run.`,
    },
  };
}

function reasonSuffix(run: JournaledRun): string {
  const reasons = run.gate?.reasons ?? [];
  return reasons.length > 0 ? ` Gate said: ${reasons.join("; ")}` : "";
}

// ---------------------------------------------------------------------------
// forgeFromVerified
// ---------------------------------------------------------------------------

/**
 * Forge a candidate SKILL.md from gate-verified journal entries.
 *
 * Order of operations is the contract:
 *
 *  1. **Gate-outcome filter** ({@link admitForForge}) over every entry. This
 *     runs before anything else touches the entry, so a declined/refuted run's
 *     certificate is never even examined.
 *  2. **Certificate presence.** A verified-but-certificate-less entry is
 *     refused `uncertified` here rather than being handed to synthesis, purely
 *     so the refusal can name its `goalId` (synthesis reports rejections
 *     without entry identity).
 *  3. **`synthesizeSkill`** on what survives — ed25519 verification,
 *     independent trace-hash recomputation, conformal-consistency check,
 *     injection scan, deterministic distillation.
 *
 * Never throws; every failure mode is a populated {@link ForgeReport}. An empty
 * input is `ok: false` with `considered: 0`, not a thrown error and certainly
 * not an empty skill.
 */
export async function forgeFromVerified(
  runs: readonly JournaledRun[],
  opts: ForgeOptions = {}
): Promise<ForgeReport> {
  const considered = Array.isArray(runs) ? runs.length : 0;
  const refused: ForgeRefusal[] = [];
  const byOutcome: Record<GateOutcome | "missing", number> = {
    verified: 0,
    declined: 0,
    refuted: 0,
    missing: 0,
  };

  const empty = (): ForgeReport => ({
    ok: false,
    considered,
    eligible: 0,
    used: 0,
    refused,
    byOutcome,
  });

  if (considered === 0) {
    refused.push({
      goalId: "<none>",
      code: "too-thin",
      detail: "no journal entries were supplied, so there is nothing to forge from.",
    });
    return empty();
  }

  // ---- 1. Gate-outcome filter (the moat) --------------------------------
  const admitted: { run: JournaledRun; index: number }[] = [];
  runs.forEach((run, index) => {
    const outcome = run?.gate?.outcome;
    if (outcome === "verified" || outcome === "declined" || outcome === "refuted") byOutcome[outcome]++;
    else byOutcome.missing++;

    const verdict = admitForForge(run, index);
    if (verdict.ok) admitted.push({ run, index });
    else refused.push(verdict.refusal);
  });

  const eligible = admitted.length;
  if (eligible === 0) {
    return { ...empty(), eligible: 0 };
  }

  // ---- 2. Certificate presence ------------------------------------------
  const sources: VerifiedTrajectory[] = [];
  for (const { run, index } of admitted) {
    const certificate = run.gate.certificate;
    if (certificate === undefined || certificate === null) {
      refused.push({
        goalId: run.trajectory?.goalId ?? `<entry ${index}>`,
        code: "uncertified",
        outcome: "verified",
        detail:
          `refusing to forge from goal "${run.trajectory?.goalId ?? `<entry ${index}>`}": the gate verdict is ` +
          `"verified" but the entry carries no verification certificate, so the trajectory bytes are not bound ` +
          `to that verdict by anything checkable.`,
      });
      continue;
    }
    sources.push({ trajectory: run.trajectory, certificate });
  }

  if (sources.length === 0) {
    return { ...empty(), eligible };
  }

  // ---- 3. Delegate to the locked synthesis pipeline ----------------------
  const result = await synthesizeSkill(sources, {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.minSuccessfulTools !== undefined ? { minSuccessfulTools: opts.minSuccessfulTools } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  // Synthesis stamps every PER-SOURCE rejection with the goalId it is actually
  // about (`SynthesisRejection.sourceGoalId`); AGGREGATE verdicts — `too-thin`
  // counts distinct tools across the whole accepted set — deliberately carry no
  // goalId, and are reported as `<synthesis>`.
  //
  // This must never be re-derived by POSITION. Synthesis emits one rejection per
  // REJECTED source, so `rejections[i]` corresponds to `sources[i]` only when
  // every source was rejected; on the common partial rejection the positional
  // guess pins a real failure detail onto an innocent goal (one that may be the
  // very source the forge went on to ACCEPT) and never names the goal that
  // actually failed. Reporting the wrong identity is a fabrication, so an
  // unstamped rejection is reported without a goal rather than with a guess.
  for (const rejection of result.rejections) {
    refused.push({
      goalId: rejection.sourceGoalId ?? "<synthesis>",
      code: rejection.code,
      detail: rejection.detail,
    });
  }

  if (!result.ok || !result.manifest || !result.content || !result.provenance) {
    return { ...empty(), eligible };
  }

  return {
    ok: true,
    considered,
    eligible,
    used: result.provenance.sourceCount,
    refused,
    byOutcome,
    manifest: result.manifest,
    content: result.content,
    provenance: result.provenance,
  };
}

/**
 * One-line, machine-greppable summary of a forge attempt.
 *
 * Prints counts only — never a rate, never a projection. `considered`,
 * `eligible`, and `used` are three genuinely different numbers and collapsing
 * them into a single "success rate" would hide exactly the thing an operator
 * needs to see: how much of their recorded work the gate refused to certify.
 */
export function summarizeForge(report: ForgeReport): string {
  const o = report.byOutcome;
  return (
    `forge: considered=${report.considered} eligible=${report.eligible} used=${report.used} ` +
    `refused=${report.refused.length} ` +
    `[verified=${o.verified} declined=${o.declined} refuted=${o.refuted} no-verdict=${o.missing}]`
  );
}
