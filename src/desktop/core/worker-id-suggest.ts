/**
 * Collision-aware worker-id suggestion — the desktop fleet surface's
 * pure, zero-dependency companion to the provision form's ad-hoc
 * `worker-${counter}` placeholder (`../ui/fleet-provision-view.ts`).
 *
 * Three pieces:
 *
 *  - {@link validateWorkerId} — the single source of truth for what a legal
 *    worker id looks like (charset, length, dash placement), with a precise
 *    machine- and human-readable reason on failure. Nothing else in this
 *    module reimplements the charset rule; every other function here calls
 *    through to this one.
 *  - {@link suggestWorkerId} — a pure, deterministic "lowest free `<base>-N`"
 *    generator, aware of an arbitrary `taken` set (live worker ids, restored
 *    ids, already-conflicted ids — the caller decides what "taken" means)
 *    via case-insensitive comparison and an `O(taken)` `Set` lookup. The
 *    value it returns is ALWAYS a value `validateWorkerId` accepts, even
 *    when the caller-supplied `base` itself is not (it falls back to the
 *    literal string `"worker"`) or is long enough that appending `-N` would
 *    overflow the 63-character limit (the base is truncated just enough to
 *    make room, never silently returning an over-length id).
 *  - {@link WorkerIdSuggester} — a tiny stateful wrapper around
 *    `suggestWorkerId` for UI call sites (like the provision form) that need
 *    consecutive suggestions to never repeat: every id it hands out is
 *    immediately folded into its own "taken" set.
 */

// ===========================================================================
// validateWorkerId
// ===========================================================================

const WORKER_ID_MAX_LENGTH = 63;
const VALID_WORKER_ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const VALID_WORKER_ID_CHAR = /[a-z0-9-]/;

export type WorkerIdValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates a worker id against the fleet's locked charset rule:
 * `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, length 1..63. On failure, `reason` is a
 * precise, single human-readable sentence identifying exactly what's wrong
 * (empty string, over length, a leading or trailing dash, or the first
 * offending character's index) — never a generic "invalid worker id".
 *
 * Checks run in a fixed order so the diagnosis is deterministic even when a
 * string violates more than one rule at once: empty -> too long -> leading
 * dash -> trailing dash -> first bad character. A single `"-"` is reported
 * as a leading dash (checked before trailing), not a bad character, since
 * dash is otherwise a legal interior character.
 */
export function validateWorkerId(id: string): WorkerIdValidation {
  if (id.length === 0) {
    return { ok: false, reason: "workerId must not be empty" };
  }
  if (id.length > WORKER_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: `workerId is too long: ${id.length} chars (max ${WORKER_ID_MAX_LENGTH})`,
    };
  }
  if (VALID_WORKER_ID.test(id)) {
    return { ok: true };
  }
  if (id.startsWith("-")) {
    return { ok: false, reason: "workerId must not start with a dash" };
  }
  if (id.endsWith("-")) {
    return { ok: false, reason: "workerId must not end with a dash" };
  }
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (!VALID_WORKER_ID_CHAR.test(ch)) {
      return {
        ok: false,
        reason: `workerId has an invalid character at index ${i}: ${JSON.stringify(
          ch
        )} (only lowercase a-z, 0-9, and interior "-" are allowed)`,
      };
    }
  }
  // Structurally unreachable given the checks above (the regex only rejects
  // strings that are empty, contain a disallowed character, or misplace a
  // dash at one of the two ends — all covered), but kept as a defensive,
  // never-silent fallback rather than an unsound "return ok" default.
  return { ok: false, reason: "workerId does not match the required pattern" };
}

// ===========================================================================
// suggestWorkerId
// ===========================================================================

const DEFAULT_BASE = "worker";

/** `base`, sanitized: used as-is when it already validates; otherwise falls
 *  back to the literal `"worker"` (no partial repair attempted — a
 *  half-fixed base is more surprising than an honest, documented fallback). */
function sanitizeBase(base: string | undefined): string {
  const requested = base ?? DEFAULT_BASE;
  return validateWorkerId(requested).ok ? requested : DEFAULT_BASE;
}

/** `base` truncated (dropping any resulting trailing dash) just enough that
 *  `${result}${suffix}` is guaranteed to be <= 63 chars, so a long
 *  caller-supplied base can never make `suggestWorkerId` produce an
 *  over-length id. Falls back to `"worker"` (itself re-truncated if needed)
 *  in the astronomical-suffix edge case where even one character of base
 *  wouldn't fit. */
function fitBase(base: string, suffix: string): string {
  const budget = WORKER_ID_MAX_LENGTH - suffix.length;
  if (base.length <= budget) return base;
  if (budget <= 0) return "";
  const truncated = base.slice(0, budget).replace(/-+$/, "");
  if (truncated.length > 0) return truncated;
  // The truncated base collapsed entirely (e.g. it was all dashes past the
  // budget) — fall back to a truncated "worker" rather than an empty base.
  return DEFAULT_BASE.slice(0, budget);
}

/**
 * Deterministically suggests the lowest-numbered free `"<base>-N"` id
 * (`N` starting at 1), comparing against `taken` case-insensitively via an
 * `O(taken)` `Set`. `base` defaults to `"worker"` and is sanitized through
 * {@link validateWorkerId} first — an unsalvageable base (empty, too long,
 * bad characters, misplaced dash) silently falls back to `"worker"` rather
 * than throwing, since this is a *suggestion*, not a validator.
 *
 * The returned id is guaranteed to satisfy `validateWorkerId(...).ok`: if
 * `base` is long enough that appending `-N` would overflow 63 characters,
 * the base is truncated to make room rather than ever returning an
 * over-length id.
 */
export function suggestWorkerId(opts: { base?: string; taken: Iterable<string> }): string {
  const takenLower = new Set<string>();
  for (const id of opts.taken) takenLower.add(id.toLowerCase());

  const sanitizedBase = sanitizeBase(opts.base);

  for (let n = 1; ; n++) {
    const suffix = `-${n}`;
    const fittedBase = fitBase(sanitizedBase, suffix);
    const candidate = `${fittedBase}${suffix}`;
    if (takenLower.has(candidate.toLowerCase())) continue;
    if (validateWorkerId(candidate).ok) return candidate;
    // Structurally unreachable (fitBase guarantees a fitting, non-empty,
    // non-dash-terminated base), but never loop forever on an unexpected
    // shape — keep advancing n rather than returning something invalid.
  }
}

// ===========================================================================
// WorkerIdSuggester
// ===========================================================================

/**
 * Stateful convenience wrapper around {@link suggestWorkerId} for call sites
 * (e.g. the provision form) that need a running "what's already spoken for"
 * set: every id handed out by {@link next} is immediately marked taken, so
 * consecutive calls never repeat even before the caller has confirmed
 * anything with the real registry.
 */
export class WorkerIdSuggester {
  private readonly takenLower = new Set<string>();

  /** @param seed Initial taken ids (e.g. every currently-live/restored/conflicted worker id). */
  constructor(seed?: Iterable<string>) {
    if (seed) {
      for (const id of seed) this.takenLower.add(id.toLowerCase());
    }
  }

  /** Marks `id` as taken (case-insensitively) for all future {@link next}/{@link isTaken} calls. */
  markTaken(id: string): void {
    this.takenLower.add(id.toLowerCase());
  }

  /** Whether `id` is already marked taken (case-insensitive). */
  isTaken(id: string): boolean {
    return this.takenLower.has(id.toLowerCase());
  }

  /**
   * Suggests the next free `"<base>-N"` id (see {@link suggestWorkerId} for
   * the exact rules) and marks it taken before returning, so a second call
   * with the same `base` never repeats the first call's answer.
   */
  next(base?: string): string {
    const suggestion = suggestWorkerId({ base, taken: this.takenLower });
    this.markTaken(suggestion);
    return suggestion;
  }
}
