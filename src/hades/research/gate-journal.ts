/**
 * gate-journal — the CAPTURE half of the closed learning loop.
 *
 * ## Why this file exists
 *
 * Hades already ships every piece of skill evolution: `synthesizeSkill`
 * distils a SKILL.md from a trajectory, `refineSkill` grows it, the
 * hash-chained track record scores it, the demotion policy demotes it, and
 * the paired holdout gate promotes it. What it did NOT ship was a wire from
 * "a run just happened" to "here is the trajectory, and here is what the
 * verification gate decided about it". `hades skill list` was empty on every
 * install because nothing produced a source. This module is that wire.
 *
 * ## The differentiator, stated precisely
 *
 * The comparable product distils a reusable skill from any trajectory the
 * model *felt good about*. That is exactly the mechanism by which a
 * prompt-injection becomes a persistent, poisoned skill on disk: the model is
 * the thing being attacked, and it is also the thing deciding what to keep.
 *
 * Hades attaches an INDEPENDENT judgement to every captured trajectory — the
 * verification gate's terminal verdict — and the forge
 * (`../skills/forge.ts`) will only ever distil from `"verified"`. A trajectory
 * the gate declined or refuted is not a weaker skill source; it is not a skill
 * source at all. That refusal is a safety property a competitor without a gate
 * cannot copy, so this module treats the verdict as load-bearing data, not as
 * a hint.
 *
 * ## Three deliberate design decisions
 *
 * **1. The attestation is NOT a field on `GoalTrajectory`.** It would have
 * been convenient to add `trajectory.gate` and let `FileTrajectoryStore`
 * persist it for free. It would also have been a silent, permanent break:
 * `synthesize.ts` verifies a certificate by recomputing
 * `sha256Hex(canonicalTrajectoryJson(trajectory))` and demanding equality with
 * `certificate.payload.traceSha256`. Any field added to the trajectory object
 * AFTER the certificate was issued changes that hash, so every forge attempt
 * would fail `hash-mismatch` forever. {@link JournaledRun} therefore *wraps*
 * the trajectory — the trajectory bytes stay exactly what was signed.
 *
 * **2. The recorder is reused, not reinvented.** {@link GateJournal} composes
 * the existing {@link TrajectoryRecorder} and delegates every recording verb to
 * it. There is one trajectory format in this codebase and this module does not
 * add a second.
 *
 * **3. `outcome` is derived, never trusted.** {@link classifyGateVerdict} is
 * the single source of truth for `accept→verified`, `revise→declined`,
 * `reject→refuted`. {@link validateJournaledRun} re-derives it from the raw
 * verdict and REFUSES an entry whose stored label disagrees. A journal file is
 * on disk, editable by anything that can write a file; hand-editing
 * `"outcome": "verified"` onto a rejected run must not launder it into a
 * skill.
 *
 * That check alone is narrower than it looks, so it is not the only one.
 * Editing `outcome` AND `gateVerdict` together is no harder for whoever can
 * write the file and yields a perfectly consistent attestation. No hash
 * computed in this module helps — an editor can recompute anything this module
 * can, because nothing here is signed.
 *
 * What an editor cannot forge is the CERTIFICATE. It is signed by the trust
 * authority and binds the trajectory bytes, and the gate issues one only on
 * ACCEPT. So the laundering attack needs one specific shape to already exist on
 * disk: a NON-verified entry that nevertheless carries a valid certificate for
 * its own bytes. Flip its two verdict fields and it reads as a verified run
 * with a signature that genuinely verifies.
 *
 * That shape has no legitimate producer, so both doors that could WRITE it are
 * shut: {@link GateJournal.capture} refuses a certificate on a non-verified
 * verdict, and {@link GateJournal.attachCertificate} refuses to attach one to a
 * non-verified run. A declined or refuted run therefore never holds a real
 * certificate to promote, and `forgeFromVerified` already refuses a `verified`
 * entry that carries none. A HAND-WRITTEN certificate is not the same problem:
 * `verifyTrajectoryForSynthesis` checks the ed25519 signature, so a fabricated
 * one dies as `bad-signature`, and a genuine one for those bytes cannot exist
 * unless the gate accepted them.
 *
 * The honest limit: this is tamper DETECTION over a plaintext file, not tamper
 * prevention. It is structural, not cryptographic. Anyone holding the trust
 * signing key can mint whatever they like, and at that point nothing in this
 * repo is meaningful anyway.
 *
 * ## Capture is opt-in
 *
 * Nothing here runs unless asked. {@link resolveJournalPath} reads the
 * `HADES_TRAJECTORY_JOURNAL` environment variable; when it is unset, capture is
 * off and says so with an unmet-requirement reason naming the VARIABLE, never
 * a value. There is no default-on background recording of user work.
 *
 * REAL-VS-MOCK POLICY: this module has no LLM, no network, and no ambient
 * clock — every timestamp comes from the injectable `now` it shares with
 * `TrajectoryRecorder`. Filesystem access goes through the injectable
 * {@link JournalFs} (the same idiom as `HoldoutFs` / `TrackRecordFs`); the
 * default implementation is real `node:fs` with atomic tmp+rename writes. It
 * computes no scores and issues no certificates — a certificate is something
 * this module carries, never something it mints.
 *
 * @module hades/research/gate-journal
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { sha256Hex, type VerificationCertificate } from "../styx/certificate";
// `canonicalTrajectoryJson` is IMPORTED, never reimplemented. It is the exact
// function `synthesizeSkill` uses to recompute a certificate's trace hash, and
// a second copy here that drifted by one field would make every attached
// certificate silently unusable at forge time.
import { canonicalTrajectoryJson } from "../skills/synthesize";
import { TrajectoryRecorder, type GoalTrajectory, type ToolEvent } from "./recorder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The gate's raw terminal verdict vocabulary, mirrored structurally rather
 * than imported.
 *
 * `swarm-runtime` is the lower layer and `src/hades/**` must never be imported
 * from it — but the reverse dependency is allowed, so why not import `Verdict`?
 * Because this journal is also written by the STYX-side gates
 * (`../styx/gate.ts`, `../trust/unified-gate.ts`), which have their own
 * vocabularies, and pinning the journal's on-disk format to one layer's union
 * would make a format migration out of any of them. The same decoupling
 * `gate-track-hook.ts` documents for `GatedSkillUse.verdict`.
 */
export type RawGateVerdict = "accept" | "revise" | "reject";

/**
 * What the verification gate concluded about a run, in the journal's own
 * vocabulary.
 *
 *  - `verified` — the gate accepted the run's answer. The ONLY outcome the
 *    forge will distil a skill from.
 *  - `declined` — the gate could not certify the answer and asked for
 *    revision. Not a refutation, and still not a skill source: "we could not
 *    confirm this was right" is not evidence that a procedure is worth
 *    keeping.
 *  - `refuted` — the gate rejected the answer outright.
 */
export type GateOutcome = "verified" | "declined" | "refuted";

/**
 * The verification gate's judgement of one run, captured alongside its
 * trajectory.
 *
 * `certificate` is present only when the run was certificate-backed. Note
 * carefully that a certificate is NOT what makes an entry `verified` — the
 * verdict is. An attacker who can mint a valid signature over a rejected run's
 * trace still gets nothing: {@link JournaledRun}s are filtered on `outcome`
 * before their certificates are ever examined (see `../skills/forge.ts`).
 */
export interface GateAttestation {
  /** Derived from {@link gateVerdict} by {@link classifyGateVerdict} — never authored by hand. */
  outcome: GateOutcome;
  /** The gate's own terminal verdict string, retained verbatim for audit. */
  gateVerdict: RawGateVerdict;
  /** The gate's grounding/ensemble score in [0,1], as the gate reported it. */
  score: number;
  /** Why the gate landed there. Never empty — an unexplained verdict is not auditable. */
  reasons: string[];
  /** The signed certificate, when the run was certificate-backed. */
  certificate?: VerificationCertificate;
  /** The task whose result WAS the run's answer (the one the gate judged). */
  taskId?: string;
  /** When the gate decided. Caller-supplied; this module never calls Date.now(). */
  at: number;
}

/** One completed run: the trajectory exactly as recorded, plus the gate's judgement of it. */
export interface JournaledRun {
  trajectory: GoalTrajectory;
  gate: GateAttestation;
}

/** Counts of what a journal holds, by outcome. Nothing here is estimated. */
export interface JournalTally {
  total: number;
  verified: number;
  declined: number;
  refuted: number;
  /** Entries that failed {@link validateJournaledRun} — malformed or self-contradictory. */
  invalid: number;
}

/** Why one journal entry was refused at load time. */
export interface JournalEntryProblem {
  /** 0-based position in the source array — the only stable identifier a malformed entry has. */
  index: number;
  code: "not-an-object" | "bad-trajectory" | "bad-attestation" | "verdict-mismatch";
  detail: string;
}

/** Minimal, injectable filesystem surface. Mirrors `HoldoutFs` / `TrackRecordFs`. */
export interface JournalFs {
  /** Returns file contents, or null if the file does not exist. */
  readFile(p: string): string | null;
  /** Writes file contents. The default implementation does this atomically (tmp + rename). */
  writeFile(p: string, c: string): void;
  /** Recursively creates a directory if it does not already exist. */
  mkdirp(d: string): void;
}

// ---------------------------------------------------------------------------
// Verdict classification — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Map a gate's raw terminal verdict onto the journal's outcome vocabulary.
 *
 * Total and pure. An unrecognized verdict maps to `"refuted"`, not
 * `"verified"`: the failure direction of this function must always be toward
 * refusing to learn. A future gate that grows a fourth verdict will be treated
 * as "do not distil from this" until someone deliberately teaches this
 * function what it means.
 */
export function classifyGateVerdict(verdict: string): GateOutcome {
  if (verdict === "accept") return "verified";
  if (verdict === "revise") return "declined";
  return "refuted";
}

/** True iff `verdict` is one of the three verdicts this journal understands. */
export function isKnownGateVerdict(verdict: unknown): verdict is RawGateVerdict {
  return verdict === "accept" || verdict === "revise" || verdict === "reject";
}

/**
 * Build a {@link GateAttestation} from a gate report's fields, deriving
 * `outcome` rather than accepting one. This is the ONLY constructor callers
 * should use — it makes "stored label agrees with raw verdict" true by
 * construction at the capture site, which is what lets
 * {@link validateJournaledRun} treat a disagreement at load time as evidence
 * of tampering rather than of a sloppy caller.
 */
export function attestGateVerdict(input: {
  verdict: RawGateVerdict;
  score: number;
  reasons: readonly string[];
  certificate?: VerificationCertificate;
  taskId?: string;
  at: number;
}): GateAttestation {
  const reasons = input.reasons.filter((r) => typeof r === "string" && r.trim() !== "");
  return {
    outcome: classifyGateVerdict(input.verdict),
    gateVerdict: input.verdict,
    score: input.score,
    // An unexplained verdict is not auditable, so synthesize the minimum
    // honest explanation rather than persisting an empty array.
    reasons: reasons.length > 0 ? [...reasons] : [`gate returned verdict "${input.verdict}" with no stated reason`],
    ...(input.certificate !== undefined ? { certificate: input.certificate } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    at: input.at,
  };
}

/**
 * Adapt a `VerificationReport`-shaped object (the swarm gate's own output)
 * into the input {@link GateJournal.completeGoal} takes.
 *
 * Structurally typed rather than importing `VerificationReport`, for the same
 * reason {@link RawGateVerdict} is: this journal is written by more than one
 * gate and must not depend on any single one of their modules. It exists so the
 * integration at a run loop's completion point is one line rather than a hand
 * re-mapping that could quietly get the verdict wrong.
 *
 * An unrecognized verdict becomes `"reject"` — the same fail-toward-refusing-to-
 * learn direction as {@link classifyGateVerdict} — and the original string is
 * preserved verbatim in `reasons` so the downgrade is visible rather than silent.
 */
export function gateReportToVerdict(report: {
  verdict: string;
  score: number;
  checks?: ReadonlyArray<{ name: string; passed: boolean; detail?: string }>;
  feedback?: string;
  taskId?: string;
  at?: number;
}): {
  verdict: RawGateVerdict;
  score: number;
  reasons: string[];
  taskId?: string;
  at?: number;
} {
  const verdict: RawGateVerdict = isKnownGateVerdict(report.verdict) ? report.verdict : "reject";
  const reasons: string[] = [];
  if (!isKnownGateVerdict(report.verdict)) {
    reasons.push(
      `gate returned unrecognized verdict ${JSON.stringify(report.verdict)}; treated as "reject" because an ` +
        `unrecognized verdict is never evidence that a run was certified.`
    );
  }
  for (const check of report.checks ?? []) {
    reasons.push(`${check.passed ? "pass" : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
  if (typeof report.feedback === "string" && report.feedback.trim() !== "") reasons.push(report.feedback);
  return {
    verdict,
    score: report.score,
    reasons,
    ...(report.taskId !== undefined ? { taskId: report.taskId } : {}),
    ...(report.at !== undefined ? { at: report.at } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation — a journal file is untrusted input
// ---------------------------------------------------------------------------

function looksLikeToolEvent(v: unknown): v is ToolEvent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.tool === "string" && typeof e.ok === "boolean" && typeof e.at === "number";
}

function looksLikeTrajectory(v: unknown): v is GoalTrajectory {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (typeof t.goalId !== "string" || t.goalId === "") return false;
  if (typeof t.objective !== "string") return false;
  if (typeof t.success !== "boolean") return false;
  if (typeof t.startedAt !== "number") return false;
  if (!Array.isArray(t.tasks)) return false;
  for (const task of t.tasks) {
    if (typeof task !== "object" || task === null || Array.isArray(task)) return false;
    const tt = task as Record<string, unknown>;
    if (typeof tt.taskId !== "string") return false;
    if (typeof tt.description !== "string") return false;
    if (typeof tt.success !== "boolean") return false;
    if (typeof tt.startedAt !== "number") return false;
    if (!Array.isArray(tt.tools)) return false;
    if (!tt.tools.every(looksLikeToolEvent)) return false;
  }
  return true;
}

/**
 * Validate one entry read back from a journal file.
 *
 * The `verdict-mismatch` check is the load-bearing one. Everything else here
 * is ordinary shape checking; that check is a tamper detector. `outcome` is a
 * derived field, so a stored `outcome` that disagrees with
 * `classifyGateVerdict(gateVerdict)` cannot have been produced by
 * {@link attestGateVerdict} — it was edited. Refusing the entry (rather than
 * silently recomputing the correct label) is deliberate: a file that has been
 * edited in the direction of "let this become a skill" is evidence about the
 * whole file, and quietly repairing it would hide that.
 */
export function validateJournaledRun(
  value: unknown,
  index = 0
): { ok: true; run: JournaledRun } | { ok: false; problem: JournalEntryProblem } {
  const problem = (code: JournalEntryProblem["code"], detail: string) =>
    ({ ok: false as const, problem: { index, code, detail } });

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return problem("not-an-object", "journal entry is not an object.");
  }
  const entry = value as Record<string, unknown>;

  if (!looksLikeTrajectory(entry.trajectory)) {
    return problem(
      "bad-trajectory",
      "journal entry has no well-formed `trajectory` (needs goalId, objective, success, startedAt, tasks[]…)."
    );
  }

  const gate = entry.gate;
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    return problem("bad-attestation", "journal entry has no `gate` attestation object.");
  }
  const g = gate as Record<string, unknown>;
  if (!isKnownGateVerdict(g.gateVerdict)) {
    return problem(
      "bad-attestation",
      `gate.gateVerdict must be one of "accept" | "revise" | "reject"; got ${JSON.stringify(g.gateVerdict)}.`
    );
  }
  if (typeof g.score !== "number" || !Number.isFinite(g.score)) {
    return problem("bad-attestation", "gate.score must be a finite number.");
  }
  if (!Array.isArray(g.reasons) || !g.reasons.every((r) => typeof r === "string")) {
    return problem("bad-attestation", "gate.reasons must be an array of strings.");
  }
  if (typeof g.at !== "number" || !Number.isFinite(g.at)) {
    return problem("bad-attestation", "gate.at must be a finite number.");
  }

  const derived = classifyGateVerdict(g.gateVerdict);
  if (g.outcome !== derived) {
    return problem(
      "verdict-mismatch",
      `gate.outcome is ${JSON.stringify(g.outcome)} but gate.gateVerdict ${JSON.stringify(
        g.gateVerdict
      )} classifies as "${derived}". \`outcome\` is a derived field — a disagreement means this entry was edited after capture, so it is refused rather than repaired.`
    );
  }

  // The SECOND tamper detector, and the one that closes the double-edit.
  //
  // Editing `outcome` alone is caught above. Editing `outcome` AND `gateVerdict`
  // together is no harder for whoever can write the file, and by itself it
  // produces a perfectly consistent attestation — so that check alone does not
  // stop laundering. Nothing in this file is signed, and no hash computed here
  // helps: an editor can recompute any hash this module could.
  //
  // What an editor CANNOT forge is the CERTIFICATE, which is signed by the
  // trust authority and binds the trajectory bytes. So the laundering attack
  // needs one specific shape to exist on disk first: a NON-verified entry that
  // nevertheless carries a valid certificate for its own bytes. Flip its two
  // verdict fields and the forge sees `verified` + a certificate that really
  // does verify.
  //
  // That shape has no legitimate producer — `UnifiedTrustGate` issues a
  // certificate only on ACCEPT — so the doors that could WRITE one are shut:
  // {@link GateJournal.capture} refuses a certificate on a non-verified verdict
  // and {@link GateJournal.attachCertificate} refuses a non-verified run. A
  // declined or refuted run therefore never holds a real certificate, and
  // `forgeFromVerified` refuses a `verified` entry carrying none.
  //
  // It is deliberately NOT refused HERE, on read. A hand-written certificate on
  // a declined entry is not a threat: `verifyTrajectoryForSynthesis` checks the
  // ed25519 signature, so a fabricated one dies as `bad-signature`, and a real
  // one for those bytes cannot exist unless the gate accepted them. Refusing
  // the entry at load would buy nothing and cost the diagnosis an operator
  // actually needs — "[declined-by-gate] this run was declined, here is the
  // gate's reason" is the message that explains their journal, and it is only
  // reachable if the entry loads.
  //
  // Also deliberately NOT checked: agreement between `trajectory.success` and
  // the verdict. `trajectory.success` is the EXECUTOR's opinion of its own run
  // and the gate verdict is the independent one; a run that believed it
  // succeeded and was refuted is a real, expected shape — it is the shape the
  // gate exists to catch — and refusing it would delete evidence rather than
  // protect anything.

  return {
    ok: true,
    run: {
      trajectory: entry.trajectory,
      gate: {
        outcome: derived,
        gateVerdict: g.gateVerdict,
        score: g.score,
        reasons: [...(g.reasons as string[])],
        ...(g.certificate !== undefined ? { certificate: g.certificate as VerificationCertificate } : {}),
        ...(typeof g.taskId === "string" ? { taskId: g.taskId } : {}),
        at: g.at,
      },
    },
  };
}

/** Validate a whole array, partitioning into usable runs and per-entry problems. */
export function validateJournal(values: readonly unknown[]): {
  runs: JournaledRun[];
  problems: JournalEntryProblem[];
} {
  const runs: JournaledRun[] = [];
  const problems: JournalEntryProblem[] = [];
  values.forEach((value, index) => {
    const result = validateJournaledRun(value, index);
    if (result.ok) runs.push(result.run);
    else problems.push(result.problem);
  });
  return { runs, problems };
}

/** Count a journal by outcome. Pure counting — nothing here is modelled. */
export function tallyJournal(runs: readonly JournaledRun[], invalid = 0): JournalTally {
  let verified = 0;
  let declined = 0;
  let refuted = 0;
  for (const run of runs) {
    if (run.gate.outcome === "verified") verified++;
    else if (run.gate.outcome === "declined") declined++;
    else refuted++;
  }
  return { total: runs.length, verified, declined, refuted, invalid };
}

// ---------------------------------------------------------------------------
// GateJournal — the capture surface
// ---------------------------------------------------------------------------

/**
 * Records trajectories and pairs each completed run with the verification
 * gate's verdict on it.
 *
 * Composes {@link TrajectoryRecorder} rather than extending or duplicating it:
 * `beginGoal`/`beginTask`/`recordTool`/`endTask` are straight delegations, so
 * the trajectory format, timestamp discipline, and unknown-goal tolerance are
 * exactly the recorder's. The one added verb is {@link completeGoal}, which
 * closes the goal and attaches the attestation.
 *
 * In-memory only. Persist with {@link saveJournal} (or hand `entries()` to
 * whatever store you already have) — keeping I/O out of the hot path means a
 * run that fails to write its journal never fails the run.
 */
export class GateJournal {
  private readonly entries_: JournaledRun[] = [];

  /**
   * @param recorder Trajectory recorder to delegate to. Defaults to a fresh
   *   one sharing this journal's clock. Injectable so a caller that already
   *   records trajectories for other reasons keeps ONE recorder.
   * @param now Injectable clock, used only when an attestation omits `at`.
   */
  constructor(
    private readonly recorder: TrajectoryRecorder = new TrajectoryRecorder(),
    private readonly now: () => number = () => Date.now()
  ) {}

  beginGoal(goalId: string, objective: string, model?: string): void {
    this.recorder.beginGoal(goalId, objective, model);
  }
  beginTask(goalId: string, taskId: string, description: string, capability?: string): void {
    this.recorder.beginTask(goalId, taskId, description, capability);
  }
  recordTool(goalId: string, taskId: string, event: Omit<ToolEvent, "at">): void {
    this.recorder.recordTool(goalId, taskId, event);
  }
  endTask(goalId: string, taskId: string, success: boolean): void {
    this.recorder.endTask(goalId, taskId, success);
  }

  /**
   * Close a goal and journal it with the gate's verdict attached.
   *
   * The trajectory's own `success` flag is taken from the gate verdict
   * (`verified` ⇒ true) rather than from a caller-supplied boolean, because a
   * run the gate did not accept is not a successful run no matter what the
   * executor thought. That keeps `trajectory.success` and `gate.outcome` from
   * ever disagreeing, which matters because `synthesize.ts` checks
   * `trajectory.success` independently.
   *
   * Returns `undefined` — journaling nothing — when the goal is unknown to the
   * recorder, matching `TrajectoryRecorder.endGoal`'s tolerance rather than
   * throwing inside a run's completion path.
   */
  completeGoal(
    goalId: string,
    verdict: {
      verdict: RawGateVerdict;
      score: number;
      reasons: readonly string[];
      certificate?: VerificationCertificate;
      taskId?: string;
      at?: number;
    }
  ): JournaledRun | undefined {
    const outcome = classifyGateVerdict(verdict.verdict);
    const trajectory = this.recorder.endGoal(goalId, outcome === "verified");
    if (!trajectory) return undefined;
    const run: JournaledRun = {
      trajectory,
      gate: attestGateVerdict({ ...verdict, at: verdict.at ?? this.now() }),
    };
    this.entries_.push(run);
    return run;
  }

  /**
   * Journal an already-completed trajectory (one closed by a recorder this
   * journal does not own). Same attestation discipline, no recorder state.
   *
   * REFUSES — and journals nothing — when a NON-verified verdict arrives with a
   * certificate. That pairing has no legitimate producer (`UnifiedTrustGate`
   * issues a certificate only on ACCEPT) and it is the exact shape a later
   * hand-edit of `gate.outcome` + `gate.gateVerdict` could turn into a
   * clean-looking `verified` run carrying a signature that really does verify.
   * `completeGoal` cannot create that shape because it derives everything from
   * one verdict; `capture` takes both from a caller, so it is the door that has
   * to be closed. {@link validateJournaledRun} refuses the same shape on read,
   * so a file written by something other than this class cannot smuggle one in
   * either.
   *
   * Note what is NOT refused: a trajectory whose own `success` flag disagrees
   * with the verdict. That is a real run — the executor thought it worked and
   * the gate did not — and it is precisely the case the gate exists to catch.
   */
  capture(
    trajectory: GoalTrajectory,
    verdict: {
      verdict: RawGateVerdict;
      score: number;
      reasons: readonly string[];
      certificate?: VerificationCertificate;
      taskId?: string;
      at?: number;
    }
  ): { ok: true; run: JournaledRun } | { ok: false; reason: string } {
    const outcome = classifyGateVerdict(verdict.verdict);
    if (outcome !== "verified" && verdict.certificate !== undefined && verdict.certificate !== null) {
      return {
        ok: false,
        reason:
          `refusing to journal goal "${trajectory?.goalId ?? "<unknown>"}": gate verdict ` +
          `"${verdict.verdict}" classifies as "${outcome}" but a verification certificate was supplied. ` +
          `Certificates are issued only on ACCEPT, so this pairing did not come from the gate — and it is ` +
          `the one shape a later edit of the verdict fields could launder into a skill.`,
      };
    }
    const run: JournaledRun = {
      trajectory,
      gate: attestGateVerdict({ ...verdict, at: verdict.at ?? this.now() }),
    };
    this.entries_.push(run);
    return { ok: true, run };
  }

  /**
   * Bind an issued certificate to an already-journaled run.
   *
   * This exists because of an ordering fact that is easy to get wrong: a
   * certificate's `traceSha256` covers the FINALIZED trajectory bytes, so it
   * cannot be issued until `completeGoal` has closed the goal — which means it
   * cannot be passed to `completeGoal`. Rather than let callers reach in and
   * assign `run.gate.certificate` (where a mismatched certificate would sit
   * undetected until `hades skill forge` failed with a baffling
   * `hash-mismatch`), this method independently recomputes the hash and
   * REFUSES a certificate that does not bind these exact bytes.
   *
   * It checks the binding only — it does NOT verify the signature and it does
   * not upgrade the gate verdict.
   *
   * It DOES refuse to attach a certificate to a run the gate did not verify.
   * That used to be allowed on the reasoning that it "changes nothing about
   * whether that run can become a skill", which is true of the run as written
   * and false of the run as EDITED: a refuted entry holding a valid certificate
   * is one two-field edit away from a verified entry holding a valid
   * certificate, and nothing downstream could tell the difference. Since the
   * gate only ever issues a certificate on ACCEPT, refusing here costs no real
   * capability and removes the only material a laundering edit needs.
   */
  attachCertificate(goalId: string, certificate: VerificationCertificate): { ok: boolean; reason?: string } {
    const run = this.entries_.find((e) => e.trajectory.goalId === goalId);
    if (!run) return { ok: false, reason: `no journaled run with goalId "${goalId}".` };
    if (run.gate.outcome !== "verified") {
      return {
        ok: false,
        reason:
          `run "${goalId}" has gate outcome "${run.gate.outcome}", not "verified". A certificate is issued ` +
          `only on ACCEPT; storing one against a non-verified run creates the exact shape a later edit of ` +
          `the verdict fields could launder into a skill.`,
      };
    }
    const claimed =
      typeof certificate?.payload?.traceSha256 === "string" ? certificate.payload.traceSha256.toLowerCase() : "";
    const recomputed = sha256Hex(canonicalTrajectoryJson(run.trajectory));
    if (claimed !== recomputed) {
      return {
        ok: false,
        reason:
          `certificate does not bind this trajectory: payload.traceSha256=${claimed || "(absent)"} ` +
          `but the recomputed trace hash is ${recomputed}.`,
      };
    }
    run.gate.certificate = certificate;
    return { ok: true };
  }

  entries(): JournaledRun[] {
    return [...this.entries_];
  }
  /** Only the runs the gate certified — the forge's entire input set. */
  verified(): JournaledRun[] {
    return this.entries_.filter((e) => e.gate.outcome === "verified");
  }
  tally(): JournalTally {
    return tallyJournal(this.entries_);
  }
  size(): number {
    return this.entries_.length;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Real `node:fs` with atomic tmp+rename writes — the same pattern the track record uses. */
export const realJournalFs: JournalFs = {
  readFile(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile(p: string, content: string): void {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
  },
  mkdirp(d: string): void {
    mkdirSync(d, { recursive: true });
  },
};

/** What {@link loadJournal} found. A missing file is `exists: false`, not an error. */
export interface JournalLoad {
  exists: boolean;
  runs: JournaledRun[];
  problems: JournalEntryProblem[];
  /** Set only when the file exists but is not a parseable JSON array. */
  error?: string;
}

/**
 * Read a journal file. Never throws: a missing file, malformed JSON, and
 * individually-bad entries are three distinct, reportable states, and the
 * caller decides what each one means. Good entries in a file with some bad
 * ones are still returned — refusing an entire journal because one row was
 * corrupt would lose real verified work — but the bad ones are always
 * surfaced, never dropped silently.
 */
export function loadJournal(path: string, fs: JournalFs = realJournalFs): JournalLoad {
  const raw = fs.readFile(path);
  if (raw === null) return { exists: false, runs: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      exists: true,
      runs: [],
      problems: [],
      error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { exists: true, runs: [], problems: [], error: "journal must be a JSON array of entries." };
  }
  const { runs, problems } = validateJournal(parsed);
  return { exists: true, runs, problems };
}

/** Write a journal file atomically. Entries are persisted verbatim — no re-derivation, no filtering. */
export function saveJournal(path: string, runs: readonly JournaledRun[], fs: JournalFs = realJournalFs): void {
  fs.mkdirp(dirname(path));
  fs.writeFile(path, JSON.stringify(runs, null, 2));
}

/**
 * Append runs to a journal file, preserving what is already there.
 *
 * Existing entries are re-read and re-written verbatim, INCLUDING ones that
 * failed validation: this function's job is to add, not to quietly garbage
 * collect evidence someone else may need to look at. It refuses (returns
 * `appended: 0` with a reason) when the existing file is unparseable, rather
 * than overwriting it.
 */
export function appendJournal(
  path: string,
  runs: readonly JournaledRun[],
  fs: JournalFs = realJournalFs
): { appended: number; total: number; reason?: string } {
  const raw = fs.readFile(path);
  let existing: unknown[] = [];
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        appended: 0,
        total: 0,
        reason: `refusing to append: existing journal at the target path is not parseable JSON (${
          err instanceof Error ? err.message : String(err)
        }); it would be destroyed by an atomic overwrite.`,
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        appended: 0,
        total: 0,
        reason: "refusing to append: existing journal at the target path is not a JSON array; it would be destroyed by an atomic overwrite.",
      };
    }
    existing = parsed;
  }
  const merged = [...existing, ...runs];
  fs.mkdirp(dirname(path));
  fs.writeFile(path, JSON.stringify(merged, null, 2));
  return { appended: runs.length, total: merged.length };
}

// ---------------------------------------------------------------------------
// Opt-in capture path
// ---------------------------------------------------------------------------

/** The environment variable that opts a deployment in to trajectory capture. */
export const JOURNAL_PATH_ENV = "HADES_TRAJECTORY_JOURNAL";

/** Whether capture is configured, and — when it is not — the unmet requirement. */
export interface JournalPathResolution {
  enabled: boolean;
  path?: string;
  /** Names the environment VARIABLE, never its value. Present only when disabled. */
  unmetRequirement?: string;
}

/**
 * Resolve the opt-in journal path from the environment.
 *
 * Capture is off by default and stays off: an agent harness that silently
 * starts recording every run to disk because it was installed is not a harness
 * anyone should trust. When the variable is unset (or blank), this returns an
 * unmet requirement naming the VARIABLE so a status line can say what is
 * missing without printing anyone's paths.
 */
export function resolveJournalPath(env: Record<string, string | undefined> = process.env): JournalPathResolution {
  const raw = env[JOURNAL_PATH_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      enabled: false,
      unmetRequirement: `trajectory capture is opt-in and $${JOURNAL_PATH_ENV} is not set — no run is journaled, so there is nothing to forge a skill from.`,
    };
  }
  return { enabled: true, path: raw.trim() };
}
