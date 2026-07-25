/**
 * live-track-feed — attaches a real {@link GateTrackRecorder} to a live
 * `SwarmManager`'s raw `"task:verified"` / `"task:rejected"` event stream, so
 * genuine gate verdicts land in the hash-chained `skill-track.json` (see
 * `./track-record.ts`) automatically, exactly-once, with honest
 * skipped/duplicate/error accounting — without the manager ever knowing this
 * feed exists.
 *
 * This is the same seam `../backends/outcome-feed.ts` uses for the routing
 * learning loop: `SwarmManagerLike` is a purely structural `.on`/`.off`
 * event-emitter surface, imported from `outcome-feed.ts` rather than
 * redeclared here, so this module composes with the real `SwarmManager`
 * without ever importing it (and without two independently-drifting
 * definitions of "what a swarm manager looks like" existing in the codebase).
 *
 * ## What this module owns, and only this
 *
 * - **Mapping** one `(task, report)` pair off the manager's real event
 *   stream into one {@link GatedSkillUse} — `verdict: "accept"` for
 *   `"task:verified"` whose `report.verdict === "accept"` (the only shape
 *   the real `manager.ts` ever actually emits `"task:verified"` with — see
 *   its `evaluateResult`/`accumulateConsensus` call sites — but this module
 *   never assumes that; a `"task:verified"` delivered with anything else is
 *   an honestly-reported anomaly, never fabricated into an outcome), and
 *   `verdict: "reject"` for `"task:rejected"` unconditionally (a task can be
 *   rejected by the anti-rogue guardrail even when the gate's own report
 *   independently says `"accept"` — see `manager.ts`'s `blocked` branch —
 *   and the *event*, not the report's own verdict field, is what actually
 *   happened to this attempt).
 * - **`pCorrect`**: always `report.score` — the real gate's calibrated [0,1]
 *   grounding-score forecast, documented here honestly as exactly that and
 *   nothing more. This module performs no scoring of its own.
 * - **Exactly-once accounting** per `(taskId, task.attempts, event-kind)` —
 *   a task's later attempts (after a requeue bumps `task.attempts`) are
 *   distinct genuine gate verdicts and each is recorded once; a replayed
 *   delivery of the identical `(taskId, attempts, kind)` is reported
 *   `{type: "duplicate"}` and never re-recorded. This is a *bounded*,
 *   FIFO-evicted local guard (cap {@link DEDUPE_CAP} keys) — once a key
 *   ages out, the *second* line of defense is the real
 *   {@link GateTrackRecorder}/`SkillTrackRecordStore`'s own cert-based
 *   dedupe (any certed `GatedSkillUse` whose `certSha256` already appears in
 *   the store is skipped with reason `"duplicate"` regardless of this
 *   module's local set), so a certed use is never re-recorded even after
 *   local eviction. A certless use that ages out of the local set and is
 *   then replayed has no second line of defense (the store cannot dedupe
 *   what carries no certificate) and — being a genuinely new call to
 *   `recorder.record` — is recorded again; callers who need a real
 *   guarantee against that should supply `certFor`.
 * - **Total failure isolation**: every code path this module runs for one
 *   event (`resolveSkills`, `certFor`, and the real recorder/store) is
 *   wrapped so that nothing it does can ever throw into the manager's
 *   `emit()` call. A caught exception is reported `{type: "error"}` and the
 *   feed keeps working — the very next event is processed exactly as if
 *   nothing had gone wrong.
 * - **`attach()` may run once per instance** (a second call throws
 *   `RangeError`, mirroring `SwarmLearningLoop`'s `subscribeToSwarm`
 *   discipline in `../backends/swarm-learning.ts` — double-listening on the
 *   same manager would silently double-record every verdict). The returned
 *   `detach()` is idempotent and stops all recording immediately.
 *
 * ## What this module explicitly does NOT own
 *
 * - **Skill attribution.** `resolveSkills` is REQUIRED and caller-supplied.
 *   This module has no notion of a `WorkerTask`'s `_skills` convention (or
 *   any other convention) — the central integration point wires in
 *   `swarm-attribution.ts`'s `skillsForTask` (or whatever the caller
 *   chooses). An empty result is honestly reported `{type: "skipped"}` with
 *   nothing recorded, mirroring `SwarmOutcomeFeed.resolveBackend`'s
 *   never-guess discipline in `../backends/outcome-feed.ts`.
 * - **Certificate hashing.** `certFor`, when supplied, is called and its
 *   return value passed straight through as `GatedSkillUse.certSha256`.
 *   When omitted (or it returns `undefined`), the resulting use carries no
 *   certificate at all — this module never invents one.
 * - **Validation, hashing, chain-integrity, or persistence.** Every one of
 *   those is owned entirely by `GateTrackRecorder` / `SkillTrackRecordStore`
 *   (`./gate-track-hook.ts`, `./track-record.ts`). This module calls
 *   `recorder.record(use)` exactly once per real event and relays its
 *   `RecordReport` verbatim: every `recorded` row becomes a `"recorded"`
 *   feed event, every `skipped` row becomes a `"skipped"` feed event (a
 *   `skipped` row whose `reason === "duplicate"` — the store's own cert
 *   dedupe firing — becomes a `"duplicate"` feed event instead, so a caller
 *   watching `onEvent` sees one consistent `"duplicate"` vocabulary
 *   regardless of which line of defense caught it).
 *
 * REAL-VS-MOCK POLICY: this module imports and calls the real
 * `GateTrackRecorder` — never a mock of its recording logic. Tests drive it
 * over a real `SkillTrackRecordStore` backed by the in-memory `TrackRecordFs`
 * double `track-record.test.ts` uses (never a mock filesystem's *behaviour*,
 * only its backing bytes), so a feed record is durable by construction the
 * instant `recorder.record` returns.
 *
 * @module hades/skills/live-track-feed
 */

import { GateTrackRecorder, type GatedSkillUse, type RecordReport } from "./gate-track-hook";
import type { SwarmManagerLike } from "../backends/outcome-feed";
import type { WorkerTask, VerificationReport } from "../../swarm-runtime/types";

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export type SkillTrackFeedEvent = {
  type: "recorded" | "skipped" | "duplicate" | "error";
  taskId: string;
  skillNames: readonly string[];
  verdict?: "accept" | "reject";
  at: number;
  detail?: string;
};

export interface SkillTrackFeedOptions {
  recorder: GateTrackRecorder;
  /**
   * Real task -> attributed-skill-name(s) mapping. REQUIRED. An empty
   * result means "unattributed" and is reported via
   * `onEvent({type: "skipped"})` with nothing recorded — never guessed.
   */
  resolveSkills: (task: WorkerTask) => readonly string[];
  /**
   * Real task+report -> verification-certificate hash, when this use is
   * certificate-backed. Omitted (or returning `undefined`) means the
   * recorded use carries no certificate — never fabricated.
   */
  certFor?: (task: WorkerTask, report: VerificationReport) => string | undefined;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  onEvent?: (e: SkillTrackFeedEvent) => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Bound on the local exactly-once dedupe set. FIFO-evicted once exceeded —
 *  see the file header for why a certed use is still never re-recorded past
 *  this cap (the store's own cert dedupe is the second line of defense). */
const DEDUPE_CAP = 50_000;

type EventKind = "verified" | "rejected";

function isWorkerTask(v: unknown): v is WorkerTask {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { goalId?: unknown }).goalId === "string" &&
    typeof (v as { attempts?: unknown }).attempts === "number" &&
    Number.isFinite((v as { attempts: number }).attempts)
  );
}

/** Best-effort structural narrowing only — this module never validates a
 *  report's own fields (that is `GateTrackRecorder`'s job via `pCorrect`
 *  range-checking); this just distinguishes "some report-shaped object was
 *  passed" from "nothing was passed at all". */
function asReportOrUndefined(v: unknown): VerificationReport | undefined {
  if (!v || typeof v !== "object") return undefined;
  return v as VerificationReport;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dedupeKey(taskId: string, attempts: number, kind: EventKind): string {
  return `${taskId} ${attempts} ${kind}`;
}

// ---------------------------------------------------------------------------
// SkillTrackFeed
// ---------------------------------------------------------------------------

export class SkillTrackFeed {
  private readonly recorder: GateTrackRecorder;
  private readonly resolveSkillsFn: (task: WorkerTask) => readonly string[];
  private readonly certForFn?: (task: WorkerTask, report: VerificationReport) => string | undefined;
  private readonly now: () => number;
  private readonly onEventCb?: (e: SkillTrackFeedEvent) => void;

  /** Bounded, FIFO-evicted set of `(taskId, attempts, kind)` keys already
   *  processed by this instance — see file header + {@link DEDUPE_CAP}. */
  private readonly seenKeys = new Set<string>();
  private readonly seenOrder: string[] = [];

  private readonly countsState = { recorded: 0, skipped: 0, duplicate: 0, errors: 0 };

  private attachedOnce = false;

  constructor(opts: SkillTrackFeedOptions) {
    if (!opts || !(opts.recorder instanceof GateTrackRecorder)) {
      throw new RangeError("SkillTrackFeed: opts.recorder must be a GateTrackRecorder instance");
    }
    if (typeof opts.resolveSkills !== "function") {
      throw new RangeError("SkillTrackFeed: opts.resolveSkills must be a function");
    }
    if (opts.certFor !== undefined && typeof opts.certFor !== "function") {
      throw new RangeError("SkillTrackFeed: opts.certFor, when provided, must be a function");
    }
    this.recorder = opts.recorder;
    this.resolveSkillsFn = opts.resolveSkills;
    this.certForFn = opts.certFor;
    this.now = opts.now ?? (() => Date.now());
    this.onEventCb = opts.onEvent;
  }

  /** Exact running counts of every {@link SkillTrackFeedEvent} type emitted
   *  by this instance so far — a plain tally of `onEvent` calls, nothing
   *  independently recomputed. */
  counts(): { recorded: number; skipped: number; duplicate: number; errors: number } {
    return { ...this.countsState };
  }

  /**
   * Attach to a real (or structurally-compatible) `SwarmManager`. Listens
   * only to `"task:verified"` and `"task:rejected"` — nothing else, so this
   * feed never needs to reason about dispatch, requeue, or failure events
   * directly. Returns an idempotent `detach()`.
   *
   * May be called exactly once per instance — a second call throws
   * `RangeError` before touching `m` at all, matching
   * `SwarmLearningLoop.subscribeToSwarm`'s double-listen guard in
   * `../backends/swarm-learning.ts`.
   */
  attach(m: SwarmManagerLike): () => void {
    if (this.attachedOnce) {
      throw new RangeError(
        "SkillTrackFeed: attach() may only be called once per instance; double-listening would double-record every verdict",
      );
    }
    if (!m || typeof m.on !== "function") {
      throw new RangeError("SkillTrackFeed: attach(m) requires a SwarmManagerLike (an .on(event, listener) emitter)");
    }
    this.attachedOnce = true;

    let detached = false;

    const onVerified = (...args: unknown[]) => {
      if (detached) return;
      this.handleEvent("verified", args[0], args[1]);
    };
    const onRejected = (...args: unknown[]) => {
      if (detached) return;
      this.handleEvent("rejected", args[0], args[1]);
    };

    m.on("task:verified", onVerified);
    m.on("task:rejected", onRejected);

    return () => {
      if (detached) return;
      detached = true;
      if (m.off) {
        m.off("task:verified", onVerified);
        m.off("task:rejected", onRejected);
      }
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private emit(fields: Omit<SkillTrackFeedEvent, "at">): void {
    const e: SkillTrackFeedEvent = { at: this.now(), ...fields };
    if (e.type === "recorded") this.countsState.recorded += 1;
    else if (e.type === "skipped") this.countsState.skipped += 1;
    else if (e.type === "duplicate") this.countsState.duplicate += 1;
    else this.countsState.errors += 1;
    this.onEventCb?.(e);
  }

  /** `true` if `key` was already seen (and does not itself insert it). */
  private hasSeen(key: string): boolean {
    return this.seenKeys.has(key);
  }

  /** Records `key` as seen, evicting the oldest key once past
   *  {@link DEDUPE_CAP} (FIFO — documented in the file header). */
  private markSeen(key: string): void {
    this.seenKeys.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > DEDUPE_CAP) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seenKeys.delete(evicted);
    }
  }

  /** Best-effort `resolveSkills` call for an already-duplicate event, purely
   *  to make the emitted `"duplicate"` event's `skillNames` informative. A
   *  throw here is swallowed (not surfaced as a separate `"error"` event —
   *  the event being reported is genuinely a duplicate; that fact does not
   *  change because a decorative lookup failed). */
  private bestEffortSkillNames(task: WorkerTask): readonly string[] {
    try {
      return this.resolveSkillsFn(task) ?? [];
    } catch {
      return [];
    }
  }

  private handleEvent(kind: EventKind, taskArg: unknown, reportArg: unknown): void {
    let taskIdForError = "unknown";
    try {
      if (!isWorkerTask(taskArg)) {
        // Not a well-formed WorkerTask — nothing this feed's documented
        // event vocabulary describes; silently ignored, exactly as
        // `SwarmOutcomeFeed` treats a malformed dispatch/terminal payload.
        return;
      }
      const task = taskArg;
      taskIdForError = task.id;
      const report = asReportOrUndefined(reportArg);

      const key = dedupeKey(task.id, task.attempts, kind);
      if (this.hasSeen(key)) {
        this.emit({
          type: "duplicate",
          taskId: task.id,
          skillNames: this.bestEffortSkillNames(task),
          verdict: kind === "verified" ? "accept" : "reject",
          detail: `duplicate delivery of taskId="${task.id}" attempts=${task.attempts} kind="${kind}"; not re-processed.`,
        });
        return;
      }
      // Mark seen before any further branching: a replay of THIS exact
      // delivery — whatever this first processing decides to do with it —
      // must be reported as "duplicate" on its next occurrence, not
      // reprocessed and independently skipped/recorded/errored again.
      this.markSeen(key);

      if (kind === "verified") {
        if (!report || report.verdict !== "accept") {
          this.emit({
            type: "skipped",
            taskId: task.id,
            skillNames: [],
            detail: `"task:verified" fired with report.verdict=${JSON.stringify(
              report?.verdict,
            )} (expected "accept"); refusing to fabricate an outcome for an abstain-shaped/anomalous verified event.`,
          });
          return;
        }
      } else if (!report) {
        this.emit({
          type: "skipped",
          taskId: task.id,
          skillNames: [],
          detail: `"task:rejected" fired with no VerificationReport for taskId="${task.id}"; nothing to attribute pCorrect from.`,
        });
        return;
      }

      // At this point `report` is guaranteed defined for both branches.
      const verified = report as VerificationReport;
      const verdict: "accept" | "reject" = kind === "verified" ? "accept" : "reject";

      const skillNames = this.resolveSkillsFn(task) ?? [];
      if (skillNames.length === 0) {
        this.emit({
          type: "skipped",
          taskId: task.id,
          skillNames: [],
          verdict,
          detail: `resolveSkills returned no skills for taskId="${task.id}"; unattributed, never guessed.`,
        });
        return;
      }

      const certSha256 = this.certForFn?.(task, verified);

      const use: GatedSkillUse = {
        skillNames,
        verdict,
        pCorrect: verified.score,
        taskId: task.id,
        goalId: task.goalId,
        at: this.now(),
        ...(certSha256 !== undefined ? { certSha256 } : {}),
      };

      const recordReport: RecordReport = this.recorder.record(use);

      for (const r of recordReport.recorded) {
        this.emit({
          type: "recorded",
          taskId: task.id,
          skillNames: [r.skillName],
          verdict,
          ...(r.certSha256 !== undefined ? { detail: `certSha256=${r.certSha256}` } : {}),
        });
      }
      for (const s of recordReport.skipped) {
        this.emit({
          type: s.reason === "duplicate" ? "duplicate" : "skipped",
          taskId: task.id,
          skillNames: s.skillName ? [s.skillName] : [],
          verdict,
          detail: s.detail,
        });
      }
    } catch (err) {
      // The one hard rule this whole module exists to enforce: nothing it
      // does may ever throw into the manager's emit() call site.
      this.emit({
        type: "error",
        taskId: taskIdForError,
        skillNames: [],
        detail: errorMessage(err),
      });
    }
  }
}
