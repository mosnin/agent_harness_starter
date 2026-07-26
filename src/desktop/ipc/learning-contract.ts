/**
 * Hades desktop learning wire protocol.
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the swarm
 * learning loop (`hades learning`, `src/hades/backends/swarm-learning.ts`):
 * a single-shot `learning.get` request answered by either a `learning.status`
 * snapshot or a `learning.error`. The `LearningCommand` union flows
 * renderer -> sidecar, `LearningEvent` flows sidecar -> renderer, exactly
 * like `Command`/`AppEvent`.
 *
 * This module mirrors `./contract.ts` / `./fleet-contract.ts` conventions
 * exactly (same guard shapes, same codec error-message style) so it is ready
 * to be merged into the `Command`/`AppEvent` unions there. It is
 * intentionally standalone: pure, deterministic, dependency-free — it does
 * not import from `./contract.ts` or `./fleet-contract.ts` (or anywhere
 * else) so the merge can happen without introducing a coupling in either
 * direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One routing arm's learning-loop state, as the desktop UI understands it.
 * `meanReward` and `ucb` are `null` iff `pulls === 0` — the engine itself
 * stores a `0` mean reward for a never-pulled arm (see
 * `src/hades/backends/route-bandit.ts`'s `BanditArm`), and this view never
 * forwards that stored zero as though it were a real measurement.
 */
export interface LearningArmView {
  name: string;
  pulls: number;
  verified: number;
  /** `null` iff `pulls === 0` — never a fake `0.00`. */
  meanReward: number | null;
  ucb: number | null;
}

/** Outcome-feed counters, passed through unaltered from the engine. */
export interface LearningCountsView {
  recorded: number;
  skipped: number;
  duplicate: number;
}

/**
 * A full learning-loop status snapshot for the desktop fleet view.
 *
 * `source`/`savedAt` are the honesty markers: `"live"` means this came
 * straight from an attached `SwarmLearningLoop` in the running process
 * (`savedAt: null` — there is no save time, it is happening right now);
 * `"snapshot"` means it was reconstituted from a persisted
 * `FileLearningStatusStore` record (`savedAt` is that record's save time),
 * so a snapshot can never be mistaken for a live read.
 */
export interface LearningStatusView {
  attached: boolean;
  source: "live" | "snapshot";
  /** Snapshot save time; `null` for `source: "live"`. */
  savedAt: number | null;
  counts: LearningCountsView;
  /** Every tracked arm, sorted by name. */
  arms: LearningArmView[];
  /**
   * Verbatim `elapsedMsNote`/`usdNote` strings pulled from recent outcome
   * events, newest last, capped at 20.
   */
  recentNotes: string[];
  at: number;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type LearningCommand = { kind: "learning.get" };

export type LearningEvent =
  | { kind: "learning.status"; status: LearningStatusView }
  | { kind: "learning.error"; message: string; at: number };

export const LEARNING_COMMAND_KINDS = [
  "learning.get",
] as const satisfies readonly LearningCommand["kind"][];

export const LEARNING_EVENT_KINDS = [
  "learning.status",
  "learning.error",
] as const satisfies readonly LearningEvent["kind"][];

// Compile-time exhaustiveness: fails to type-check if a kind is added to the
// `LearningCommand`/`LearningEvent` unions without adding it to the tuples
// above (or vice versa) — a mismatch in either direction breaks these
// assignments.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [
  Union,
] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<LearningCommand["kind"], typeof LEARNING_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<LearningEvent["kind"], typeof LEARNING_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive type helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isOneOf<T extends string>(x: unknown, values: readonly T[]): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// View model guards
// ---------------------------------------------------------------------------

const LEARNING_SOURCES = ["live", "snapshot"] as const;

export function isLearningArmView(x: unknown): x is LearningArmView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.name) &&
    isNumber(x.pulls) &&
    isNumber(x.verified) &&
    isNullableNumber(x.meanReward) &&
    isNullableNumber(x.ucb)
  );
}

function isLearningCountsView(x: unknown): x is LearningCountsView {
  if (!isPlainObject(x)) return false;
  return isNumber(x.recorded) && isNumber(x.skipped) && isNumber(x.duplicate);
}

export function isLearningStatusView(x: unknown): x is LearningStatusView {
  if (!isPlainObject(x)) return false;
  return (
    isBoolean(x.attached) &&
    isOneOf(x.source, LEARNING_SOURCES) &&
    isNullableNumber(x.savedAt) &&
    isLearningCountsView(x.counts) &&
    Array.isArray(x.arms) &&
    x.arms.every(isLearningArmView) &&
    isStringArray(x.recentNotes) &&
    isNumber(x.at)
  );
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

export function isLearningCommand(x: unknown): x is LearningCommand {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "learning.get":
      return true;
    default:
      return false;
  }
}

export function isLearningEvent(x: unknown): x is LearningEvent {
  if (!isPlainObject(x)) return false;
  const kind = x.kind;
  switch (kind) {
    case "learning.status":
      return isLearningStatusView(x.status);
    case "learning.error":
      return isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function parseLine(line: string, label: "command" | "event"): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error(`bad ${label}: empty line`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`bad ${label}: invalid JSON`);
  }
}

export function encodeLearningEvent(e: LearningEvent): string {
  return JSON.stringify(e) + "\n";
}

export function decodeLearningCommand(raw: string): LearningCommand {
  const parsed = parseLine(raw, "command");
  if (!isPlainObject(parsed) || typeof parsed.kind !== "string") {
    throw new Error("bad command: missing kind");
  }
  if (!(LEARNING_COMMAND_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`bad command: unknown kind "${parsed.kind}"`);
  }
  if (!isLearningCommand(parsed)) {
    throw new Error(`bad command: missing or invalid fields for kind "${parsed.kind}"`);
  }
  return parsed;
}
