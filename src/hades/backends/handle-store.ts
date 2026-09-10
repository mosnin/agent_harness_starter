/**
 * HandleStore — crash-consistent, versioned persistence for a backend
 * fleet's {@link RemoteHandle}s and their {@link LifecycleState}s.
 *
 * Conforms to the house atomic-JSON persistence pattern already established
 * by `JsonFileToolStateStore` (`../tools/manager.ts`) and `UserModelStore`
 * (`../memory/user-model-store.ts`): a versioned envelope on disk, writes
 * that go tmp-file-then-rename so a crash mid-write can never leave a
 * half-written file behind, `mkdir -p` the parent directory on demand, and a
 * `load()` that is deliberately paranoid — it never throws and never trusts
 * disk bytes at face value. A file that fails to parse, fails top-level
 * shape/version validation, or (partially) contains malformed entries is
 * never crashed on: the whole file is quarantined (renamed to
 * `<path>.corrupt-<ts>`) only when the TOP-LEVEL envelope itself is
 * unusable; an individual bad entry inside an otherwise-valid envelope
 * (e.g. one non-object item in the `handles` array) is simply dropped, so
 * one bad handle can never take down the whole fleet's persisted state.
 *
 * `reconcile()` is the other half of "survives a process restart": given a
 * freshly-loaded `PersistedFleet`, it probes every stored handle against the
 * REAL backend behind it (via a `RemoteBackendRegistry`) and reports which
 * handles came back clean (`restored`), which had their `state` field
 * silently drift from reality while the process was down (`corrected` —
 * probed truth always wins), and which could not be trusted at all
 * (`dropped` — unknown backend name, a throwing probe, or a structurally
 * malformed entry).
 */

import { dirname } from "node:path";
import * as nodeFsPromises from "node:fs/promises";

import type { RemoteBackendRegistry, RemoteHandle, RemoteState } from "./backend";
import { ALL_LIFECYCLE_STATES, type LifecycleState } from "./lifecycle";

// ===========================================================================
// fs facade
// ===========================================================================

/**
 * Minimal fs surface `HandleStore` needs, injectable so crash-consistency
 * (e.g. "rename throws after the tmp write succeeded") is fully testable
 * without touching a real filesystem. Defaults to `node:fs/promises`.
 */
export interface HandleStoreFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFs: HandleStoreFs = {
  async readFile(path, encoding) {
    return nodeFsPromises.readFile(path, encoding);
  },
  async writeFile(path, data, encoding) {
    await nodeFsPromises.writeFile(path, data, encoding);
  },
  async rename(oldPath, newPath) {
    await nodeFsPromises.rename(oldPath, newPath);
  },
  async mkdir(path, options) {
    await nodeFsPromises.mkdir(path, options);
  },
  async unlink(path) {
    await nodeFsPromises.unlink(path);
  },
};

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// Persisted shape
// ===========================================================================

export const HANDLE_STORE_VERSION = 1;

export interface PersistedFleet {
  version: number;
  savedAt: number;
  handles: RemoteHandle[];
  lifecycle: Record<string, LifecycleState>;
}

export interface HandleStoreOptions {
  /** JSON file the fleet is persisted to, e.g. `<dataDir>/fleet.json`. */
  path: string;
  /** Time source (ms) used to stamp `savedAt` and quarantine filenames.
   *  Injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable minimal fs facade. Default a thin wrapper over
   *  `node:fs/promises`. */
  fs?: HandleStoreFs;
  /** Called with a human-readable message whenever `load()` has to
   *  quarantine a corrupt/unreadable file or drop a malformed entry.
   *  Never throws on the store's behalf — purely observational. */
  onWarn?: (message: string) => void;
}

export interface ReconcileReport {
  /** Handles that were probed successfully and are now trusted, with
   *  `state` set to what the backend actually reported (probed truth). A
   *  handle whose stored state disagreed with the probe still appears here
   *  (corrected), in addition to being listed in `corrected`. */
  restored: RemoteHandle[];
  /** Handles whose persisted `state` disagreed with the live probe. */
  corrected: Array<{ workerId: string; stored: LifecycleState; probed: RemoteState }>;
  /** Handles that could not be trusted at all, and why. */
  dropped: Array<{ workerId: string; reason: string }>;
}

// ===========================================================================
// Canonical stable-key JSON
// ===========================================================================

/** Recursively returns a structurally-equivalent value with every plain
 *  object's keys sorted alphabetically (arrays keep their element order).
 *  This is what makes `save()`'s output byte-stable across repeated
 *  save→load→save cycles regardless of property insertion order upstream. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

// ===========================================================================
// Defensive validation (never trust disk bytes)
// ===========================================================================

const REMOTE_STATES: ReadonlySet<string> = new Set<RemoteState>([
  "provisioning",
  "running",
  "hibernated",
  "stopped",
  "failed",
]);
const LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(ALL_LIFECYCLE_STATES);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate one raw `handles[]` entry into a `RemoteHandle`, or `undefined`
 *  if it's structurally untrustworthy. Never throws. */
function validateHandle(raw: unknown): RemoteHandle | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { workerId, backend, nativeId, endpoint, state, startedAt, meta } = raw as Record<string, unknown>;
  if (typeof workerId !== "string" || workerId.length === 0) return undefined;
  if (typeof backend !== "string" || backend.length === 0) return undefined;
  if (typeof nativeId !== "string" || nativeId.length === 0) return undefined;
  if (typeof state !== "string" || !REMOTE_STATES.has(state)) return undefined;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  if (endpoint !== undefined && typeof endpoint !== "string") return undefined;
  if (meta !== undefined && !isPlainObject(meta)) return undefined;

  const handle: RemoteHandle = {
    workerId,
    backend,
    nativeId,
    state: state as RemoteState,
    startedAt,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(meta !== undefined ? { meta: meta as Record<string, unknown> } : {}),
  };
  return handle;
}

/** Validate the raw `lifecycle` map, dropping any entry whose key isn't a
 *  non-empty string or whose value isn't a known `LifecycleState`. */
function validateLifecycleMap(raw: unknown): Record<string, LifecycleState> {
  const out: Record<string, LifecycleState> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string" || !LIFECYCLE_STATE_SET.has(value)) continue;
    out[key] = value as LifecycleState;
  }
  return out;
}

interface TopShapeResult {
  version: number;
  savedAt: number;
  rawHandles: unknown[];
  rawLifecycle: unknown;
}

/** Validate the envelope's own shape (NOT the entries inside it). Returns
 *  `undefined` if the top-level envelope itself is untrustworthy — that is
 *  the ONLY condition under which `load()` quarantines the whole file. */
function validateTopShape(parsed: unknown): TopShapeResult | undefined {
  if (!isPlainObject(parsed)) return undefined;
  const { version, savedAt, handles, lifecycle } = parsed as Record<string, unknown>;
  if (typeof version !== "number" || version !== HANDLE_STORE_VERSION) return undefined;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return undefined;
  if (!Array.isArray(handles)) return undefined;
  if (lifecycle !== undefined && !isPlainObject(lifecycle)) return undefined;
  return { version, savedAt, rawHandles: handles, rawLifecycle: lifecycle ?? {} };
}

// ===========================================================================
// HandleStore
// ===========================================================================

export class HandleStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly fs: HandleStoreFs;
  private readonly onWarn?: (message: string) => void;

  constructor(opts: HandleStoreOptions) {
    if (!opts || typeof opts.path !== "string" || opts.path.length === 0) {
      throw new TypeError("HandleStore: opts.path must be a non-empty string");
    }
    this.path = opts.path;
    this.now = opts.now ?? (() => Date.now());
    this.fs = opts.fs ?? defaultFs;
    this.onWarn = opts.onWarn;
  }

  private warn(message: string): void {
    this.onWarn?.(message);
  }

  /**
   * Persist `handles`/`lifecycle` as the canonical, stable-key JSON envelope.
   * Atomic: writes `<path>.tmp` then renames it over `path`. If `rename`
   * throws (simulating a crash between the two steps), the original file at
   * `path` is left completely untouched — the tmp file may be left behind,
   * but `path` itself was never opened for writing at all.
   */
  async save(handles: RemoteHandle[], lifecycle: Record<string, LifecycleState>): Promise<void> {
    const fleet: PersistedFleet = {
      version: HANDLE_STORE_VERSION,
      savedAt: this.now(),
      handles: [...handles],
      lifecycle: { ...lifecycle },
    };

    await this.fs.mkdir(dirname(this.path), { recursive: true });

    const tmpPath = `${this.path}.tmp`;
    const json = canonicalJson(fleet);
    await this.fs.writeFile(tmpPath, json, "utf8");
    await this.fs.rename(tmpPath, this.path);
  }

  /**
   * Load the persisted fleet. Never throws.
   *
   * - Missing file -> `undefined`, no warning (there is nothing wrong).
   * - Unreadable for another reason (permissions, etc.) -> `undefined`, with
   *   a warning (nothing to quarantine — we could not even read it).
   * - Invalid JSON, or JSON whose top-level shape/version doesn't match
   *   `PersistedFleet` -> the file is quarantined to `<path>.corrupt-<ts>`,
   *   `undefined` is returned, and a warning is emitted.
   * - Valid envelope with individually-malformed `handles[]` entries or
   *   `lifecycle` values -> those entries are silently dropped (each via a
   *   warning), the rest of the fleet loads normally.
   */
  async load(): Promise<PersistedFleet | undefined> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path, "utf8");
    } catch (err) {
      if (isEnoent(err)) return undefined;
      this.warn(`HandleStore: failed to read ${this.path}: ${errMsg(err)}`);
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await this.quarantine(`invalid JSON (${errMsg(err)})`);
      return undefined;
    }

    const top = validateTopShape(parsed);
    if (!top) {
      await this.quarantine(
        `envelope failed shape/version validation (expected version ${HANDLE_STORE_VERSION})`,
      );
      return undefined;
    }

    const handles: RemoteHandle[] = [];
    for (const [i, rawHandle] of top.rawHandles.entries()) {
      const handle = validateHandle(rawHandle);
      if (handle) {
        handles.push(handle);
      } else {
        this.warn(`HandleStore: dropped malformed handles[${i}] entry while loading ${this.path}`);
      }
    }

    const lifecycle = validateLifecycleMap(top.rawLifecycle);

    return {
      version: top.version,
      savedAt: top.savedAt,
      handles,
      lifecycle,
    };
  }

  /**
   * Probe every handle in `fleet` against the live backend behind it (via
   * `registry`), reconciling stored belief against runtime truth. Never
   * throws: a probe failure or an unknown backend name drops that one
   * handle (with a reason) rather than aborting the whole reconciliation.
   */
  async reconcile(fleet: PersistedFleet, registry: RemoteBackendRegistry): Promise<ReconcileReport> {
    const report: ReconcileReport = { restored: [], corrected: [], dropped: [] };
    const rawHandles = Array.isArray(fleet?.handles) ? fleet.handles : [];

    for (const rawHandle of rawHandles) {
      const handle = validateHandle(rawHandle);
      if (!handle) {
        const workerId =
          isPlainObject(rawHandle) && typeof rawHandle.workerId === "string" ? rawHandle.workerId : "<unknown>";
        report.dropped.push({ workerId, reason: "malformed handle entry" });
        continue;
      }

      const backend = registry.get(handle.backend);
      if (!backend) {
        report.dropped.push({ workerId: handle.workerId, reason: `unknown backend: ${handle.backend}` });
        continue;
      }

      let probed: RemoteState;
      try {
        probed = await backend.status(handle);
      } catch (err) {
        report.dropped.push({
          workerId: handle.workerId,
          reason: `status probe threw: ${errMsg(err)}`,
        });
        continue;
      }

      const restoredHandle: RemoteHandle = { ...handle, state: probed };
      report.restored.push(restoredHandle);

      if (probed !== handle.state) {
        report.corrected.push({ workerId: handle.workerId, stored: handle.state, probed });
      }
    }

    return report;
  }

  /**
   * Rename the unreadable/corrupt file out of the way to
   * `<path>.corrupt-<ts>` (preserving the bad bytes for forensics rather
   * than clobbering or silently discarding them). If the rename itself
   * fails (e.g. the file vanished out from under us), that failure is only
   * ever surfaced through `onWarn` — quarantining is always best-effort and
   * must never turn a corrupt-file load into a thrown exception.
   */
  private async quarantine(reason: string): Promise<void> {
    const target = `${this.path}.corrupt-${this.now()}`;
    try {
      await this.fs.rename(this.path, target);
      this.warn(`HandleStore: quarantined corrupt file ${this.path} -> ${target} (${reason})`);
    } catch (err) {
      this.warn(`HandleStore: file at ${this.path} could not be quarantined (${reason}); rename failed: ${errMsg(err)}`);
    }
  }
}
