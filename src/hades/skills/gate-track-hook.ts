/**
 * gate-track-hook — turns real {@link VerificationGate}-style verdicts into
 * durable {@link SkillTrackRecordStore} history, automatically.
 *
 * Every other writer of the skill track record (`hades skill track`, see
 * `../cli/skill-evolve-command.ts`) is a human typing a `--p`/`--success`
 * flag by hand. This module is the machine path: given a
 * {@link GatedSkillUse} — the skill-attributed shape of one already-gated
 * task outcome (verdict, calibrated `pCorrect`, optional certificate hash) —
 * it appends the right {@link SkillOutcome} to the right skill's hash chain,
 * or explains in a typed, inspectable {@link RecordReport} exactly why it
 * did not.
 *
 * Three things this module refuses to ever do, by construction:
 *
 *  1. **Fabricate an outcome for an abstention.** `abstain` is not `reject`
 *     with extra steps — {@link gateUseToOutcome} maps it to `null`, and
 *     {@link GateTrackRecorder} reports it as a visible, counted
 *     `skipped` row (reason `"abstain"`) rather than silently dropping it
 *     or, worse, recording it as a success or failure.
 *  2. **Double-count a certificate.** A `certSha256` that already appears
 *     anywhere in `store.entries(skillName)` is idempotent: recording the
 *     same gate verdict twice (e.g. a retried write, two swarm runs
 *     replaying the same log) is a no-op reported as `"duplicate"`. This
 *     is derived by scanning the store's real persisted entries on every
 *     call — never from an in-memory `Set` alone — so idempotency survives
 *     process restarts and holds even across two independent
 *     {@link GateTrackRecorder} instances that happen to share the same
 *     underlying store bytes. Certless uses (no certificate — see
 *     {@link GatedSkillUse.certSha256}) cannot be deduped against the
 *     store this way (the persisted {@link TrackRecordEntry} carries no
 *     `taskId`), so `recordAll` additionally dedupes certless uses
 *     *within one batch* via the documented `(taskId, skillName, at)` key
 *     (see {@link GateTrackRecorder.recordAll}).
 *  3. **Write onto a chain it cannot verify.** Before any append this
 *     module reloads the store (`store.load()`) and checks the target
 *     skill's chain (`store.verifyChain(skillName)`), mirroring the
 *     `trackStoreIssue` discipline in `../cli/skill-evolve-command.ts`:
 *     - an **unreadable envelope** (bad JSON, wrong version, malformed
 *       entries — `store.load()` fails and no skill has any surviving
 *       data) means the whole store cannot be trusted, so every skill in
 *       the use is skipped with `"store-integrity"`. Calling
 *       `store.record()` here would create a brand-new chain from genesis
 *       and, on the very next `persist()`, atomically overwrite the
 *       corrupt file — destroying the only evidence of the original
 *       break. This module never does that.
 *     - a **tampered-but-parsed** envelope (`store.load()` fails but some
 *       skill still has data — a hash mismatch, not a parse failure) keeps
 *       its corrupted bytes exactly as loaded (the store's own contract),
 *       so writes to any *other, still-verifying* skill are safe and are
 *       allowed to proceed; only the specific skill(s) whose own chain
 *       fails `verifyChain` are skipped with `"store-integrity"`.
 *
 * REAL-VS-MOCK POLICY: all persistence goes through the real
 * `SkillTrackRecordStore` (tests inject an in-memory `TrackRecordFs`, the
 * exact double `track-record.test.ts` uses, never a mock of this module's
 * own logic). This module performs no scoring, calibration, or hashing of
 * its own — `gateUseToOutcome` is a pure, unconditional field mapping, and
 * every accept/reject/duplicate/integrity decision defers to the real
 * store's own validation (`store.record`, `store.load`, `store.verifyChain`)
 * or to a direct field check against `use` itself. This module never calls
 * `Date.now()` — every timestamp it writes (`SkillOutcome.at`) comes
 * straight from the caller-supplied `GatedSkillUse.at`.
 *
 * This file does not import, construct, or otherwise touch
 * `VerificationGate` itself — it consumes the *shape* a gate verdict is
 * expected to be adapted into (`GatedSkillUse`), decoupling this module
 * from the gate's own `Verdict` union (`"accept" | "revise" | "reject"`,
 * which has no `"abstain"`). Mapping a gate's `"revise"` (or any other
 * non-terminal signal) into `GatedSkillUse.verdict` is the integrator's
 * call at the run-loop boundary, not this module's.
 *
 * @module hades/skills/gate-track-hook
 */

import {
  TrackRecordValidationError,
  type SkillOutcome,
  type SkillTrackRecordStore,
} from "./track-record";

// ---------------------------------------------------------------------------
// Types (locked contract)
// ---------------------------------------------------------------------------

/**
 * One already-gated, skill-attributed task outcome — the shape this module
 * consumes to produce durable track-record history. `skillNames` is plural
 * because a single gated task can draw on more than one skill; every named
 * skill receives its own recorded-or-skipped row.
 */
export interface GatedSkillUse {
  /** Skill(s) this gated use is attributed to. Empty means "attributed to nothing". */
  skillNames: readonly string[];
  /** The gate's terminal verdict for this use. `"abstain"` is not an outcome. */
  verdict: "accept" | "abstain" | "reject";
  /** The gate's calibrated probability-correct forecast, made before the outcome was known. */
  pCorrect: number;
  /** hex sha256 of the verification certificate, when this use was certificate-backed. */
  certSha256?: string;
  /** The task this use came from — part of the certless (taskId, skillName, at) dedupe key. */
  taskId: string;
  /** The goal this use's task belonged to, if any. Carried for context; not persisted. */
  goalId?: string;
  /** When this use happened (caller-supplied; this module never calls Date.now()). */
  at: number;
}

/** Why one skill's row from a {@link GatedSkillUse} was not recorded. */
export type SkipReason =
  | "abstain"
  | "duplicate"
  | "no-skills"
  | "invalid-p"
  | "invalid-use"
  | "store-integrity";

/** What {@link GateTrackRecorder.record} / `.recordAll` did with one or more {@link GatedSkillUse}s. */
export interface RecordReport {
  recorded: Array<{ skillName: string; certSha256?: string }>;
  skipped: Array<{ skillName: string; reason: SkipReason; detail: string }>;
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

/**
 * Pure, unconditional mapping from one gated use + a skill it is attributed
 * to, to the {@link SkillOutcome} `track-record.ts` expects — or `null` when
 * the use is an abstention (an abstention is a refusal to have an opinion,
 * not an observation that the skill succeeded or failed, so it can never
 * become a `SkillOutcome`).
 *
 * Deliberately performs **no validation**: an out-of-range or non-finite
 * `pCorrect` passes straight through as `predictedP` unchanged. Validating
 * (and, on failure, skipping) is {@link GateTrackRecorder}'s job — this
 * function's only contract is "if this were valid, here is what it would
 * mean", which is what makes it safe to unit-test in complete isolation
 * from any store.
 */
export function gateUseToOutcome(use: GatedSkillUse, skillName: string): SkillOutcome | null {
  if (use.verdict === "abstain") return null;
  return {
    skillName,
    predictedP: use.pCorrect,
    success: use.verdict === "accept",
    at: use.at,
    ...(use.certSha256 !== undefined ? { certSha256: use.certSha256 } : {}),
  };
}

// ---------------------------------------------------------------------------
// Structural validation of a GatedSkillUse
// ---------------------------------------------------------------------------

/**
 * Structural ("is this even a well-formed `GatedSkillUse`?") validation,
 * distinct from the semantic `pCorrect`-range check below: a `pCorrect` of
 * the *wrong type* (not a `number` at all) is a malformed use
 * (`"invalid-use"`); a `pCorrect` of the right type but out of `[0,1]` (or
 * `NaN`/`Infinity`) is a well-formed use making an invalid forecast
 * (`"invalid-p"`) — see {@link GateTrackRecorder}. Returns a human-readable
 * problem description, or `null` when the use is structurally sound.
 */
function structuralIssue(use: GatedSkillUse): string | null {
  if (typeof use !== "object" || use === null) {
    return "GatedSkillUse must be an object.";
  }
  if (typeof use.taskId !== "string" || use.taskId.trim().length === 0) {
    return `taskId must be a non-empty string, got ${JSON.stringify(use.taskId)}.`;
  }
  if (use.verdict !== "accept" && use.verdict !== "abstain" && use.verdict !== "reject") {
    return `verdict must be one of "accept" | "abstain" | "reject", got ${JSON.stringify(
      (use as { verdict?: unknown }).verdict,
    )}.`;
  }
  if (typeof use.at !== "number" || !Number.isFinite(use.at)) {
    return `at must be a finite timestamp, got ${JSON.stringify(use.at)}.`;
  }
  if (!Array.isArray(use.skillNames)) {
    return `skillNames must be an array, got ${JSON.stringify(use.skillNames)}.`;
  }
  for (const s of use.skillNames) {
    if (typeof s !== "string" || s.trim().length === 0) {
      return `skillNames must contain only non-empty strings; found ${JSON.stringify(s)}.`;
    }
  }
  if (use.goalId !== undefined && typeof use.goalId !== "string") {
    return `goalId, when present, must be a string.`;
  }
  if (use.certSha256 !== undefined && (typeof use.certSha256 !== "string" || use.certSha256.trim().length === 0)) {
    return `certSha256, when present, must be a non-empty string.`;
  }
  if (typeof use.pCorrect !== "number") {
    return `pCorrect must be a number, got ${JSON.stringify((use as { pCorrect?: unknown }).pCorrect)}.`;
  }
  return null;
}

/** `true` iff `p` is a finite number within `[0,1]` — the store's own forecast rule. */
function isValidP(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= 1;
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export class GateTrackRecorder {
  private readonly store: SkillTrackRecordStore;

  constructor(opts: { store: SkillTrackRecordStore }) {
    this.store = opts.store;
  }

  /** Records one {@link GatedSkillUse} — one row per named skill, recorded or skipped. */
  record(use: GatedSkillUse): RecordReport {
    return this.recordOne(use, new Set<string>());
  }

  /**
   * Records a batch of {@link GatedSkillUse}s in order, one row per
   * `(use, skillName)` pair across the whole batch. Certless uses
   * (no `certSha256`) additionally dedupe *within this batch* against each
   * other via a `(taskId, skillName, at)` key — the persisted
   * {@link TrackRecordEntry} carries no `taskId`, so this is the only place
   * a certless duplicate can ever be caught; certed uses keep deriving
   * idempotency from the real store contents on every single use, exactly
   * as `record` does, so a certed duplicate is caught whether it appears
   * twice in one batch, across two batches, or across two independent
   * recorder instances sharing the same store bytes.
   */
  recordAll(uses: readonly GatedSkillUse[]): RecordReport {
    const recorded: RecordReport["recorded"] = [];
    const skipped: RecordReport["skipped"] = [];
    const seenCertless = new Set<string>();
    for (const use of uses) {
      const r = this.recordOne(use, seenCertless);
      recorded.push(...r.recorded);
      skipped.push(...r.skipped);
    }
    return { recorded, skipped };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private recordOne(use: GatedSkillUse, seenCertless: Set<string>): RecordReport {
    const recorded: RecordReport["recorded"] = [];
    const skipped: RecordReport["skipped"] = [];

    const structural = structuralIssue(use);
    if (structural) {
      skipped.push({ skillName: "", reason: "invalid-use", detail: structural });
      return { recorded, skipped };
    }

    if (use.skillNames.length === 0) {
      skipped.push({
        skillName: "",
        reason: "no-skills",
        detail: `GatedSkillUse for task "${use.taskId}" names no skills; there is nothing to attribute this outcome to.`,
      });
      return { recorded, skipped };
    }

    // An abstention is never an outcome, regardless of what pCorrect says —
    // checked before the pCorrect range check so a garbage forecast on an
    // abstention is still honestly reported as "abstain", not "invalid-p".
    if (use.verdict === "abstain") {
      for (const skillName of use.skillNames) {
        skipped.push({
          skillName,
          reason: "abstain",
          detail: `verdict is "abstain" for task "${use.taskId}"; an abstention carries no outcome and is never recorded.`,
        });
      }
      return { recorded, skipped };
    }

    if (!isValidP(use.pCorrect)) {
      for (const skillName of use.skillNames) {
        skipped.push({
          skillName,
          reason: "invalid-p",
          detail: `pCorrect must be a finite number in [0,1], got ${use.pCorrect}; refusing to clamp or guess.`,
        });
      }
      return { recorded, skipped };
    }

    // ── Integrity, before any append. ─────────────────────────────────────
    const loadResult = this.store.load();
    if (!loadResult.ok) {
      const anySurvivingData = this.store.summaries().length > 0;
      if (!anySurvivingData) {
        // Unreadable envelope: nothing can be trusted, and recording now
        // would create fresh genesis chains that atomically overwrite (and
        // so destroy) whatever the corrupt file still held on next persist.
        const detail = `track-record store failed to load (${
          loadResult.error ?? "unknown load failure"
        }); refusing to write and risk destroying the corrupt file's remaining history.`;
        for (const skillName of use.skillNames) {
          skipped.push({ skillName, reason: "store-integrity", detail });
        }
        return { recorded, skipped };
      }
      // Tampered-but-parsed: some skill's data survived load() intact in
      // memory. Scope the check per skill below — writes to any skill whose
      // own chain still verifies are safe.
    }

    for (const skillName of use.skillNames) {
      const chainCheck = this.store.verifyChain(skillName);
      if (!chainCheck.ok) {
        const brokenAt = chainCheck.brokenAt;
        skipped.push({
          skillName,
          reason: "store-integrity",
          detail: `hash chain for skill "${skillName}" failed integrity verification${
            brokenAt ? ` at seq=${brokenAt.seq}` : ""
          }; refusing to append onto a broken chain.`,
        });
        continue;
      }

      if (use.certSha256 !== undefined) {
        const existing = this.store.entries(skillName).find((e) => e.certSha256 === use.certSha256);
        if (existing) {
          skipped.push({
            skillName,
            reason: "duplicate",
            detail: `certSha256 "${use.certSha256}" is already recorded for skill "${skillName}" (seq=${existing.seq}); skipping to stay idempotent.`,
          });
          continue;
        }
      } else {
        const batchKey = `${use.taskId}\u0000${skillName}\u0000${use.at}`;
        if (seenCertless.has(batchKey)) {
          skipped.push({
            skillName,
            reason: "duplicate",
            detail: `a certless outcome for task "${use.taskId}" / skill "${skillName}" at ${use.at} was already recorded earlier in this batch.`,
          });
          continue;
        }
        seenCertless.add(batchKey);
      }

      const outcome = gateUseToOutcome(use, skillName);
      if (!outcome) {
        // Unreachable — verdict !== "abstain" was already established above
        // — kept as an honest fallback rather than a non-null assertion.
        skipped.push({
          skillName,
          reason: "abstain",
          detail: `gateUseToOutcome returned null for a non-abstain verdict on skill "${skillName}"; treating as an abstention rather than fabricating an outcome.`,
        });
        continue;
      }

      try {
        const entry = this.store.record(outcome);
        recorded.push({
          skillName,
          ...(entry.certSha256 !== undefined ? { certSha256: entry.certSha256 } : {}),
        });
      } catch (err) {
        if (err instanceof TrackRecordValidationError) {
          skipped.push({
            skillName,
            reason: "invalid-use",
            detail: `store rejected this outcome for skill "${skillName}": ${err.message} (field=${err.field}).`,
          });
        } else {
          throw err;
        }
      }
    }

    return { recorded, skipped };
  }
}
