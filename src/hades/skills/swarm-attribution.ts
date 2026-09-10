/**
 * swarm-attribution — durable, adversarially-safe skill attribution for
 * dispatched swarm tasks.
 *
 * A worker is bound to a set of skills before it is asked to execute a task.
 * Nothing in {@link WorkerTask} carries that binding forward, so once the
 * task is dispatched (and possibly requeued, revised, or replayed) there is
 * no way for a downstream consumer — the live track feed, the TUI, or a
 * provenance audit — to answer "which skills did this task use?" without
 * threading a new field through `SwarmManager` and `types.ts`.
 *
 * This module defines a **locked, additive convention** instead: skill names
 * ride inside {@link WorkerTask.input} under the reserved key
 * {@link SKILL_ATTRIBUTION_KEY} (`"_skills"`). Because
 * `SwarmManager.dispatch()` mutates `task.input` with a *shallow* spread —
 * `task.input = { ...task.input, _dependencies: ... }` (see
 * `src/swarm-runtime/manager/manager.ts`) — any other key already present on
 * `task.input`, including `_skills`, survives that mutation untouched. This
 * file's test suite replicates that exact spread (and a second, "requeue"
 * spread on top of it) to prove the convention actually holds against the
 * real dispatch code path, not just an idealized one.
 *
 * Two ways to attribute:
 *
 * 1. **Embedded** ({@link attributeInput}) — a task-construction site stamps
 *    `_skills` directly into `task.input` before the task is ever queued.
 *    This is the durable, wire-serializable form: it survives the swarm bus
 *    (`JSON.stringify`/`JSON.parse`), dispatch mutation, and requeue.
 * 2. **Sidecar ledger** ({@link SkillAttributionLedger}) — a planning engine
 *    that decides skill bindings *before* a `WorkerTask` object exists (or
 *    that cannot touch the task-construction call site) can instead `note()`
 *    the binding by task id in a bounded, in-memory, FIFO-evicting ledger and
 *    let consumers resolve it via {@link SkillAttributionLedger.forTask}.
 *
 * TRUST BOUNDARY: `task.input` is worker-influenced (or bus-replayed, or
 * hand-constructed by a future call site this module cannot see), so it must
 * be treated as hostile. {@link skillsForTask} — the read path every
 * downstream consumer should use — never throws and never returns
 * attacker-shaped data: on any malformed `_skills` payload it fails closed to
 * `[]`. {@link attributionIssue} exists purely so an integrator that *wants*
 * to log the malformation honestly (rather than silently swallow it) can ask
 * why the read came back empty.
 *
 * REAL-VS-MOCK POLICY: pure logic and types only. This module has no I/O —
 * no `node:fs`, no `Date.now()`, no network, no LLM call. It imports the
 * real {@link WorkerTask} type from `../../swarm-runtime/types` (structural,
 * via `Pick`) so its contracts stay honest against the real shape, but it
 * never imports `SwarmManager` and never touches any existing file, barrel,
 * or `ipc/contract.ts`.
 */

import type { WorkerTask } from "../../swarm-runtime/types";

// ---------------------------------------------------------------------------
// Locked contract: the key
// ---------------------------------------------------------------------------

/**
 * Reserved key under which skill attribution rides inside
 * `WorkerTask.input`. Locked — downstream consumers may depend on this exact
 * string.
 */
export const SKILL_ATTRIBUTION_KEY = "_skills";

// ---------------------------------------------------------------------------
// Validation limits
// ---------------------------------------------------------------------------

/** Maximum length of a single skill name, in UTF-16 code units. */
const MAX_NAME_LENGTH = 128;

/** Maximum number of distinct skill names attributable to one task. */
const MAX_NAMES = 32;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Reasons {@link attributeInput} / {@link SkillAttributionLedger.note} can reject input. */
export type SkillAttributionErrorReason =
  | "not-an-array"
  | "too-many-names"
  | "non-string-entry"
  | "empty-name"
  | "name-too-long"
  | "control-characters";

/**
 * Thrown by the *write* paths ({@link attributeInput},
 * {@link SkillAttributionLedger.note}) when the supplied skill names fail
 * validation. Never thrown by the read paths ({@link skillsForTask},
 * {@link attributionIssue}, {@link SkillAttributionLedger.forTask}) — those
 * fail closed instead, because they operate on data that may originate from
 * an adversarial or merely buggy source outside this module's control.
 */
export class SkillAttributionError extends Error {
  readonly reason: SkillAttributionErrorReason;

  constructor(reason: SkillAttributionErrorReason, message: string) {
    super(message);
    this.name = "SkillAttributionError";
    this.reason = reason;
    // Restore prototype chain for instanceof across ES5-target transpilation.
    Object.setPrototypeOf(this, SkillAttributionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a candidate list of skill names: trims each name,
 * rejects on the first invalid entry, dedupes (post-trim, case-sensitive —
 * see module docs on why no case-folding), and sorts lexicographically for a
 * deterministic, diff-friendly, order-independent representation.
 *
 * Throws {@link SkillAttributionError} — never silently drops or coerces a
 * bad entry — because this is the *write* path: a caller passing garbage
 * here has a bug, and should learn about it immediately rather than have it
 * silently attributed as `[]` later.
 */
function validateAndNormalize(skillNames: readonly string[]): string[] {
  if (!Array.isArray(skillNames)) {
    throw new SkillAttributionError(
      "not-an-array",
      "skillNames must be an array of strings",
    );
  }
  if (skillNames.length > MAX_NAMES) {
    throw new SkillAttributionError(
      "too-many-names",
      `skillNames has ${skillNames.length} entries, exceeding the maximum of ${MAX_NAMES}`,
    );
  }

  const seen = new Set<string>();
  for (const raw of skillNames) {
    if (typeof raw !== "string") {
      throw new SkillAttributionError(
        "non-string-entry",
        `skillNames must contain only strings, got ${typeof raw}`,
      );
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new SkillAttributionError(
        "empty-name",
        "skillNames must not contain empty or whitespace-only names",
      );
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new SkillAttributionError(
        "name-too-long",
        `skill name exceeds the maximum length of ${MAX_NAME_LENGTH} characters`,
      );
    }
    if (CONTROL_CHAR_RE.test(trimmed)) {
      throw new SkillAttributionError(
        "control-characters",
        "skill name must not contain control characters",
      );
    }
    seen.add(trimmed);
  }

  return Array.from(seen).sort();
}

// ---------------------------------------------------------------------------
// Write path: attributeInput
// ---------------------------------------------------------------------------

/**
 * Returns a **new** `input` object (never mutates `input`) with
 * {@link SKILL_ATTRIBUTION_KEY} set to the validated, deduped, sorted skill
 * names. Throws {@link SkillAttributionError} if `skillNames` is invalid.
 *
 * Safe to call before a task is queued, and safe to call again on an
 * already-dispatched task's `input` (e.g. to re-attribute on requeue) — it
 * always produces a fresh object, so it composes correctly with the
 * shallow-spread mutation `SwarmManager.dispatch()` performs
 * (`task.input = { ...task.input, _dependencies }`), in either order.
 */
export function attributeInput(
  input: Record<string, unknown>,
  skillNames: readonly string[],
): Record<string, unknown> {
  const normalized = validateAndNormalize(skillNames);
  return {
    ...input,
    [SKILL_ATTRIBUTION_KEY]: normalized,
  };
}

// ---------------------------------------------------------------------------
// Read path: skillsForTask / attributionIssue
// ---------------------------------------------------------------------------

type TaskLike = Pick<WorkerTask, "id" | "input">;

/**
 * Outcome of inspecting a raw `_skills` payload, shared by
 * {@link skillsForTask} and {@link attributionIssue} so the two never
 * disagree about why a payload was rejected.
 */
interface ReadResult {
  /** Validated names, or `[]` if absent/malformed. */
  names: string[];
  /** `null` if absent or well-formed; a human-readable reason otherwise. */
  issue: string | null;
}

function readRaw(input: Record<string, unknown>): ReadResult {
  if (!(SKILL_ATTRIBUTION_KEY in input)) {
    return { names: [], issue: null };
  }

  const raw = input[SKILL_ATTRIBUTION_KEY];

  if (!Array.isArray(raw)) {
    return {
      names: [],
      issue: `"${SKILL_ATTRIBUTION_KEY}" is present but is not an array (got ${describeType(raw)})`,
    };
  }

  if (raw.length > MAX_NAMES) {
    return {
      names: [],
      issue: `"${SKILL_ATTRIBUTION_KEY}" has ${raw.length} entries, exceeding the maximum of ${MAX_NAMES}`,
    };
  }

  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      return {
        names: [],
        issue: `"${SKILL_ATTRIBUTION_KEY}"[${i}] is not a string (got ${describeType(entry)})`,
      };
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      return {
        names: [],
        issue: `"${SKILL_ATTRIBUTION_KEY}"[${i}] is empty or whitespace-only`,
      };
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return {
        names: [],
        issue: `"${SKILL_ATTRIBUTION_KEY}"[${i}] exceeds the maximum length of ${MAX_NAME_LENGTH} characters`,
      };
    }
    if (CONTROL_CHAR_RE.test(trimmed)) {
      return {
        names: [],
        issue: `"${SKILL_ATTRIBUTION_KEY}"[${i}] contains control characters`,
      };
    }
    result.push(trimmed);
  }

  const deduped = Array.from(new Set(result)).sort();
  return { names: deduped, issue: null };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a nested array";
  return typeof value;
}

/**
 * Fail-safe read of the skill names attributed to a task via
 * {@link attributeInput}.
 *
 * - Absent key: returns `[]`.
 * - Well-formed key: returns the validated, deduped, sorted names.
 * - Malformed key (wrong shape, wrong entry types, oversize, forged
 *   objects such as `{ __proto__: [...] }` or array-likes): returns `[]`.
 *
 * This function **never throws**, regardless of what `task.input` contains
 * — it is the read path callers reach for when they cannot trust the
 * producer of `task.input` (which, for a swarm task, they generally cannot:
 * `input` is attacker- and bug-reachable).
 */
export function skillsForTask(task: TaskLike): string[] {
  try {
    return readRaw(task.input ?? {}).names;
  } catch {
    // Defense in depth: even a pathological getter on `input` (e.g. a
    // Proxy that throws) must not escape as an exception from a read path
    // whose whole contract is "never throws".
    return [];
  }
}

/**
 * Explains *why* {@link skillsForTask} returned `[]` when
 * {@link SKILL_ATTRIBUTION_KEY} is present but malformed, so an integrator
 * that wants to log the malformation honestly (rather than silently
 * swallow it) can. Returns `null` when the key is absent or well-formed.
 *
 * Like {@link skillsForTask}, this never throws.
 */
export function attributionIssue(task: TaskLike): string | null {
  try {
    return readRaw(task.input ?? {}).issue;
  } catch {
    return `"${SKILL_ATTRIBUTION_KEY}" could not be inspected (input access threw)`;
  }
}

// ---------------------------------------------------------------------------
// Sidecar ledger
// ---------------------------------------------------------------------------

interface LedgerOptions {
  /** Maximum number of task ids retained; oldest-inserted evicted first. Default 10_000. */
  maxEntries?: number;
}

/**
 * Bounded, in-memory, FIFO-evicting sidecar for engines that decide skill
 * bindings at plan time — before a `WorkerTask` object exists, or at a call
 * site that cannot embed {@link SKILL_ATTRIBUTION_KEY} into `task.input`
 * directly.
 *
 * This is deliberately *not* durable and *not* a substitute for
 * {@link attributeInput}: it lives only as long as the process, is not
 * threaded through the swarm bus, and does not survive a worker/manager
 * restart. Prefer {@link attributeInput} whenever the call site can reach
 * `task.input` directly; reach for the ledger only when it cannot.
 *
 * Eviction is exact FIFO by insertion order of the *task id* (re-`note`-ing
 * an existing task id updates its names but does **not** refresh its
 * position in the eviction order — inserting under a task id that was
 * previously evicted or never seen counts as a fresh insertion and can
 * itself trigger an eviction).
 */
export class SkillAttributionLedger {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, string[]>();

  constructor(opts?: LedgerOptions) {
    const maxEntries = opts?.maxEntries ?? 10_000;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new SkillAttributionError(
        "too-many-names",
        `maxEntries must be a positive integer, got ${maxEntries}`,
      );
    }
    this.maxEntries = maxEntries;
  }

  /**
   * Records (or overwrites) the skill names attributed to `taskId`. Applies
   * the same validation as {@link attributeInput} and throws
   * {@link SkillAttributionError} on invalid names.
   *
   * If `taskId` is new and the ledger is at capacity, the oldest-inserted
   * entry (by task id) is evicted first, making room for this one.
   */
  note(taskId: string, skillNames: readonly string[]): void {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new SkillAttributionError(
        "empty-name",
        "taskId must be a non-empty string",
      );
    }
    const normalized = validateAndNormalize(skillNames);

    if (!this.entries.has(taskId) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }

    // Map preserves insertion order for iteration, but re-setting an
    // existing key does not move it — which is exactly the "no refresh on
    // update" FIFO semantics documented above.
    this.entries.set(taskId, normalized);
  }

  /**
   * Resolves the skill names for `task`, preferring the embedded
   * `task.input._skills` key over the ledger:
   *
   * 1. If the embedded key is present and well-formed and non-empty,
   *    return it.
   * 2. Otherwise (key absent, key present-but-empty, or key
   *    present-but-malformed) fall through to the ledger entry for
   *    `task.id`, if any.
   * 3. Otherwise return `[]`.
   *
   * Never throws.
   */
  forTask(task: TaskLike): string[] {
    const embedded = skillsForTask(task);
    if (embedded.length > 0) {
      return embedded;
    }
    try {
      return this.entries.get(task.id) ?? [];
    } catch {
      return [];
    }
  }

  /** Removes every entry from the ledger. */
  clear(): void {
    this.entries.clear();
  }

  /** Current number of distinct task ids held (test/introspection helper). */
  get size(): number {
    return this.entries.size;
  }
}
