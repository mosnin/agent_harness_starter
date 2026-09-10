/**
 * FileLearningStatusStore — durability for {@link SwarmLearningStatus} across
 * process restarts.
 *
 * `SwarmLearningLoop` (`./swarm-learning.ts`) already owns every number that
 * ends up in a `SwarmLearningStatus` snapshot (arms come straight from
 * `CostAwareRouteBandit`, counts/recent come straight from
 * `SwarmOutcomeFeed`). This module never recomputes or reinterprets any of
 * those figures — it only serializes a snapshot to disk atomically and
 * deserializes it back with the same defensive, never-throws, per-field
 * validation discipline as `WorkerAttributionRegistry.fromState`
 * (`./worker-attribution.ts`) and `CostAwareRouteBandit.fromState`
 * (`./route-bandit.ts`): a malformed top-level shape or version yields
 * `undefined` (the loop reports "nothing recorded", never a guess), while an
 * individually malformed arm or `recent` entry is silently dropped so the
 * rest of a mostly-good file still loads.
 *
 * ## Atomicity
 *
 * `save()` writes to `${path}.tmp` and then renames that file onto `path`.
 * A crash (or injected failure) between those two steps leaves the
 * previously-persisted `path` completely untouched — never a half-written,
 * corrupt final file. `rename()` failing is reported as `{ saved: false,
 * error }`; it is NEVER thrown, mirroring `FleetSupervisor.persist()` /
 * `BanditRoutedProvisioner.persistSnapshot()`'s "persistence never breaks
 * the real work" discipline elsewhere in this codebase.
 */

import type { SwarmLearningEvent, SwarmLearningStatus } from "./swarm-learning";
import * as nodeFs from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Public types
// ===========================================================================

export const LEARNING_STATUS_VERSION = 1;

export interface PersistedLearningStatus {
  version: number;
  at: number;
  status: SwarmLearningStatus;
}

/**
 * Injectable filesystem seam. Defaults to the real `node:fs/promises`
 * below; tests inject a fake to exercise atomicity/validation without
 * touching disk.
 */
export interface LearningStatusFs {
  writeFile(path: string, data: string, enc: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string, enc: "utf8"): Promise<string>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
}

// ===========================================================================
// Internals
// ===========================================================================

const defaultFs: LearningStatusFs = {
  writeFile: (path, data, enc) => nodeFs.writeFile(path, data, enc),
  rename: (from, to) => nodeFs.rename(from, to),
  readFile: (path, enc) => nodeFs.readFile(path, enc),
  mkdir: (path, opts) => nodeFs.mkdir(path, opts),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Pulled off `SwarmLearningStatus` by indexed access rather than imported
// directly, so this module's imports stay limited to `./swarm-learning`
// (type-only), node builtins, and its own files — never `./route-bandit` or
// `./outcome-feed` directly.
type Arm = SwarmLearningStatus["arms"][string];
type RecentEntry = SwarmLearningStatus["recent"][number];
type Counts = SwarmLearningStatus["counts"];

/** Validate one raw `status.counts` value. Never throws; `undefined` means
 *  the whole top-level payload is untrustworthy (counts are load-bearing,
 *  not optional). */
function validateCounts(raw: unknown): Counts | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { recorded, skipped, duplicate } = raw;
  if (!isNonNegInt(recorded) || !isNonNegInt(skipped) || !isNonNegInt(duplicate)) return undefined;
  return { recorded, skipped, duplicate };
}

/** Validate one raw `status.arms[name]` value. Never throws; `undefined`
 *  means "drop this arm" while the rest of `arms` still loads. */
function validateArm(raw: unknown): Arm | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { pulls, verified, totalElapsedMs, totalUsd, meanReward, ucb } = raw;
  if (!isNonNegInt(pulls)) return undefined;
  if (!isNonNegInt(verified)) return undefined;
  if (!isFiniteNumber(totalElapsedMs)) return undefined;
  if (!isFiniteNumber(totalUsd)) return undefined;
  if (!isFiniteNumber(meanReward)) return undefined;
  if (ucb !== null && !isFiniteNumber(ucb)) return undefined;
  return { pulls, verified, totalElapsedMs, totalUsd, meanReward, ucb: ucb === null ? null : ucb };
}

/** Validate one raw `status.recent[i]` value. Per the locked contract this
 *  requires only a plain object with a string `type` field — a string or
 *  `null` entry is dropped for failing the plain-object check; the rest of
 *  the shape is passed through unchanged (it is opaque `OutcomeFeedEvent`
 *  detail this module never interprets). Never throws. */
function validateRecentEntry(raw: unknown): RecentEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.type !== "string") return undefined;
  return raw as unknown as RecentEntry;
}

function validateStatus(raw: unknown): SwarmLearningStatus | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { attached, counts, arms, recent } = raw;
  if (typeof attached !== "boolean") return undefined;
  const validatedCounts = validateCounts(counts);
  if (!validatedCounts) return undefined;
  if (!isPlainObject(arms)) return undefined;
  const validatedArms: Record<string, Arm> = {};
  for (const [name, rawArm] of Object.entries(arms)) {
    const arm = validateArm(rawArm);
    if (arm) validatedArms[name] = arm;
  }
  if (!Array.isArray(recent)) return undefined;
  const validatedRecent: RecentEntry[] = [];
  for (const rawEntry of recent) {
    const entry = validateRecentEntry(rawEntry);
    if (entry) validatedRecent.push(entry);
  }
  return { attached, counts: validatedCounts, arms: validatedArms, recent: validatedRecent };
}

function validatePersisted(raw: unknown): PersistedLearningStatus | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { version, at, status } = raw;
  if (typeof version !== "number" || version !== LEARNING_STATUS_VERSION) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const validatedStatus = validateStatus(status);
  if (!validatedStatus) return undefined;
  return { version, at, status: validatedStatus };
}

// ===========================================================================
// FileLearningStatusStore
// ===========================================================================

export class FileLearningStatusStore {
  private readonly path: string;
  private readonly fs: LearningStatusFs;
  private readonly now: () => number;

  constructor(opts: { path: string; fs?: LearningStatusFs; now?: () => number }) {
    if (!opts || typeof opts.path !== "string" || opts.path.trim().length === 0) {
      throw new RangeError("FileLearningStatusStore: opts.path must be a non-empty string");
    }
    this.path = opts.path;
    this.fs = opts.fs ?? defaultFs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Atomically persist `status`: `mkdir -p` the parent directory, write the
   * full envelope to `${path}.tmp`, then `rename()` that file onto `path`.
   * A crash between those two steps (or an injected `rename` failure)
   * leaves whatever was previously at `path` completely untouched. NEVER
   * throws — every failure mode (mkdir, write, or rename) is reported as
   * `{ saved: false, error }`.
   */
  async save(status: SwarmLearningStatus): Promise<{ saved: boolean; error?: string }> {
    try {
      const persisted: PersistedLearningStatus = { version: LEARNING_STATUS_VERSION, at: this.now(), status };
      const dir = dirname(this.path);
      if (dir) await this.fs.mkdir(dir, { recursive: true });
      const tmpPath = `${this.path}.tmp`;
      await this.fs.writeFile(tmpPath, JSON.stringify(persisted), "utf8");
      await this.fs.rename(tmpPath, this.path);
      return { saved: true };
    } catch (err) {
      return { saved: false, error: errorMessage(err) };
    }
  }

  /**
   * Load and field-by-field validate the persisted status at `path`. A
   * missing file, unreadable file, truncated/invalid JSON, wrong top-level
   * shape, wrong `version`, or non-finite `at` all yield `undefined` — the
   * caller's honest signal that nothing trustworthy is recorded. NEVER
   * throws.
   */
  async load(): Promise<PersistedLearningStatus | undefined> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    try {
      return validatePersisted(parsed);
    } catch {
      // Defensive only: validatePersisted is pure/never-throwing by
      // construction, but load() itself must never throw regardless.
      return undefined;
    }
  }
}

// ===========================================================================
// persistingOnEvent
// ===========================================================================

export interface PersistingOnEventHandle {
  onEvent: (e: SwarmLearningEvent) => void;
  /** Force any pending debounced save to run now and await it (or await an
   *  already in-flight save); a no-op resolving `{ saved: true }` when
   *  nothing is pending or in flight. */
  flush(): Promise<{ saved: boolean; error?: string }>;
  /** Cancel any pending debounce timer. Idempotent. After `dispose()`,
   *  `onEvent` is a no-op. */
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * A composable {@link SwarmLearningEvent} handler the central integrator
 * passes into `SwarmLearningLoop.attach`'s `onEvent` (composed alongside any
 * other handlers — this function never wires itself to a loop directly).
 * Debounces `"feed"` events (bursty by nature — one per recorded/skipped/
 * duplicate outcome) so a hot loop doesn't hammer disk, and saves
 * immediately, bypassing the debounce, on `"detached"` (the loop is going
 * away; the last save must not be dropped on the floor).
 */
export function persistingOnEvent(
  store: FileLearningStatusStore,
  getStatus: () => SwarmLearningStatus,
  opts: {
    debounceMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  } = {}
): PersistingOnEventHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let pending: Promise<{ saved: boolean; error?: string }> | undefined;
  let disposed = false;

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function saveNow(): Promise<{ saved: boolean; error?: string }> {
    const p = store.save(getStatus());
    pending = p;
    void p.finally(() => {
      if (pending === p) pending = undefined;
    });
    return p;
  }

  return {
    onEvent(e: SwarmLearningEvent) {
      if (disposed) return;
      if (e.type === "detached") {
        cancelTimer();
        void saveNow();
      } else if (e.type === "feed") {
        cancelTimer();
        timer = setTimer(() => {
          timer = undefined;
          void saveNow();
        }, debounceMs);
      }
    },
    async flush() {
      if (timer !== undefined) {
        cancelTimer();
        return saveNow();
      }
      if (pending) return pending;
      return { saved: true };
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
