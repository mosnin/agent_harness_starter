/**
 * skill-trust-service — the desktop sidecar's read-only view over a skill's
 * persisted trust status, shaped as per-skill badge data the Skills view can
 * render.
 *
 * This is deliberately a *thin, read-only* adapter, not a re-implementation:
 * it reads `<dataDir>/skill-trust.json` via the real {@link parseTrustStates}
 * (`../../hades/skills/demotion`) and `<dataDir>/skill-track.json` via the
 * real {@link SkillTrackRecordStore} (`../../hades/skills/track-record`),
 * and verifies each requested skill's hash chain with the store's own
 * {@link SkillTrackRecordStore.verifyChain}. No trust decision is ever made
 * here — `demotion.ts` decides `active` -> `probation` -> `demoted` when
 * `hades skill trust` runs, and this module only ever *reads back* whatever
 * that decision persisted. A skill with real track-record history but no
 * persisted trust decision reports `"unscored"` with its real metrics
 * attached, exactly the read-only/never-re-decide separation the CLI's
 * `skill-evolve-command.ts` `trackStoreIssue` semantics establish: a missing
 * file means "genuinely never evaluated" and degrades to `"unscored"`; an
 * unparseable file, a broken hash chain, or a metrics mismatch against the
 * store's own recomputation all degrade to `"integrity-error"` instead,
 * since "we couldn't tell" must never be reported as "never evaluated".
 *
 * `SkillTrackRecordStore`'s injected `TrackRecordFs` is a *synchronous*
 * contract (see `track-record.ts`), but this module's own {@link
 * TrustFilesFs} is async (matching how the desktop sidecar talks to disk
 * over IPC). The bridge is: read both files asynchronously first, then hand
 * the store a tiny synchronous `TrackRecordFs` adapter that simply returns
 * the bytes already read — never a second, reimplemented parser, and never a
 * write (the adapter's `writeFile`/`mkdirp` throw; this module never calls
 * `store.record()`).
 *
 * REAL-VS-MOCK POLICY: every number in {@link SkillTrustBadgeData} is copied
 * verbatim from `SkillTrackRecordStore.summary()` or from the persisted
 * `SkillTrustState` — this module computes no calibration or reliability
 * metric of its own. `badges()` never throws: a rejected `fs.readFile`, a
 * corrupt file, or a broken chain all degrade to `"integrity-error"` (or, for
 * a genuinely absent file, `"unscored"`) rather than propagating.
 */

import { join } from "node:path";

import { parseTrustStates, type SkillTrustState } from "../../hades/skills/demotion";
import {
  SkillTrackRecordStore,
  brierScore,
  wilsonLowerBound,
  type SkillTrackSummary,
  type TrackRecordFs,
} from "../../hades/skills/track-record";

// ---------------------------------------------------------------------------
// Locked contract
// ---------------------------------------------------------------------------

export type SkillTrustBadgeStatus =
  | "active"
  | "probation"
  | "demoted"
  | "unscored"
  | "integrity-error";

export interface SkillTrustBadgeData {
  name: string;
  status: SkillTrustBadgeStatus;
  wilsonLower: number | null;
  recentBrier: number | null;
  n: number;
  verifiedN: number;
}

const BADGE_STATUSES: ReadonlySet<string> = new Set<SkillTrustBadgeStatus>([
  "active",
  "probation",
  "demoted",
  "unscored",
  "integrity-error",
]);

function isNullableFiniteNumber(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isNonNegativeInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Total structural guard for {@link SkillTrustBadgeData}: safe on `null`,
 * arrays, prototype-less objects, and any other hostile shape. Rejects
 * `NaN`/`Infinity` metrics (the locked contract requires JSON-plain numbers:
 * nullable numbers are `null`, never `NaN`/`undefined`), non-integer or
 * negative counts, and any status string outside the fixed five-value union
 * — including every status accepted round-tripped through
 * `JSON.parse(JSON.stringify(...))`.
 */
export function isSkillTrustBadgeData(x: unknown): x is SkillTrustBadgeData {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== "string") return false;
  if (typeof o.status !== "string" || !BADGE_STATUSES.has(o.status)) return false;
  if (!isNullableFiniteNumber(o.wilsonLower)) return false;
  if (!isNullableFiniteNumber(o.recentBrier)) return false;
  if (!isNonNegativeInteger(o.n)) return false;
  if (!isNonNegativeInteger(o.verifiedN)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Injectable filesystem
// ---------------------------------------------------------------------------

export interface TrustFilesFs {
  /** Returns file contents, or `null` on ENOENT. */
  readFile(path: string): Promise<string | null>;
}

/** Real `node:fs/promises`-backed {@link TrustFilesFs} for production use. */
export function nodeTrustFilesFs(): TrustFilesFs {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        const fs = await import("node:fs/promises");
        return await fs.readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SkillTrustServiceOptions {
  /** Data directory; defaults to `$HADES_DATA_DIR` or `.hades` (matching `skills-service.ts`). */
  dataDir?: string;
  /** Injected filesystem; defaults to {@link nodeTrustFilesFs}. */
  fs?: TrustFilesFs;
  env?: Record<string, string | undefined>;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function defaultDataDir(env: Record<string, string | undefined>): string {
  return env.HADES_DATA_DIR ?? ".hades";
}

function closeEnough(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) < 1e-9;
}

const READ_ONLY_WRITE_ERROR =
  "SkillTrustService is read-only: refusing to write to the skill-track store.";

/** The outcome of trying to read one of the two persisted files. */
type FileRead = { content: string | null } | { error: string };

/** The outcome of parsing `skill-trust.json`'s contents (or absence). */
interface TrustFileParse {
  ok: boolean;
  states: Map<string, SkillTrustState>;
  error?: string;
}

export class SkillTrustService {
  private readonly dataDir: string;
  private readonly fs: TrustFilesFs;

  constructor(opts?: SkillTrustServiceOptions) {
    const env = opts?.env ?? process.env;
    this.dataDir = opts?.dataDir ?? defaultDataDir(env);
    this.fs = opts?.fs ?? nodeTrustFilesFs();
  }

  /**
   * Per-skill trust badge data for `names`, in the same order. Never throws
   * — a rejected read, corrupt JSON, or a broken hash chain all degrade to a
   * per-skill (or, for a globally corrupt file, all-skill) `"integrity-error"`
   * rather than propagating.
   */
  async badges(names: readonly string[]): Promise<SkillTrustBadgeData[]> {
    try {
      const trustPath = join(this.dataDir, "skill-trust.json");
      const trackPath = join(this.dataDir, "skill-track.json");

      const [trustRead, trackRead] = await Promise.all([
        this.safeRead(trustPath),
        this.safeRead(trackPath),
      ]);

      const trustParse = SkillTrustService.parseTrustFile(trustRead);
      const store = SkillTrustService.buildTrackStore(trackPath, trackRead);
      const loadResult = store.load();
      // A globally corrupt/unreadable skill-track.json resets the store to
      // empty AND fails `load()`. A hash-chain break confined to one skill's
      // chain also fails `load()`, but the (tampered) data stays loaded —
      // `summaries().length > 0` is exactly what distinguishes the two, and
      // is the same test `SkillTrustReader` (`trust-selection.ts`) uses.
      const trackGlobalFailure = !loadResult.ok && store.summaries().length === 0;

      return names.map((name) =>
        SkillTrustService.rowFor(name, trustParse, store, trackGlobalFailure),
      );
    } catch {
      // Should be unreachable given the try/catches below, but `badges()`
      // must never throw regardless of what future changes might add here.
      return names.map((name) => ({
        name,
        status: "integrity-error" as const,
        wilsonLower: null,
        recentBrier: null,
        n: 0,
        verifiedN: 0,
      }));
    }
  }

  private async safeRead(path: string): Promise<FileRead> {
    try {
      const content = await this.fs.readFile(path);
      return { content };
    } catch (err) {
      return { error: errMsg(err) };
    }
  }

  private static parseTrustFile(read: FileRead): TrustFileParse {
    if ("error" in read) {
      return { ok: false, states: new Map(), error: `failed to read skill-trust.json: ${read.error}` };
    }
    if (read.content === null) {
      // No trust-state file yet: every skill is simply un-evaluated, not an
      // integrity failure.
      return { ok: true, states: new Map() };
    }
    const parsed = parseTrustStates(read.content);
    if (!parsed.ok) {
      return { ok: false, states: new Map(), error: parsed.error ?? "unknown parse failure" };
    }
    return { ok: true, states: parsed.states };
  }

  /**
   * Builds a `SkillTrackRecordStore` over a synchronous, pre-loaded, and
   * read-only `TrackRecordFs` adapter: `readFile` returns the bytes already
   * fetched by `safeRead` (rethrowing whatever error the async read hit, so
   * the store's own `load()` catch path — which already knows how to turn an
   * unreadable file into `{ok:false}` — handles it identically to a real
   * ENOENT/permission failure), and `writeFile`/`mkdirp` throw: this module
   * never calls `store.record()`, so they should never be reachable.
   */
  private static buildTrackStore(trackPath: string, trackRead: FileRead): SkillTrackRecordStore {
    const fs: TrackRecordFs = {
      readFile(): string | null {
        if ("error" in trackRead) throw new Error(trackRead.error);
        return trackRead.content;
      },
      writeFile(): void {
        throw new Error(READ_ONLY_WRITE_ERROR);
      },
      mkdirp(): void {
        throw new Error(READ_ONLY_WRITE_ERROR);
      },
    };
    return new SkillTrackRecordStore({ path: trackPath, fs, now: () => 0 });
  }

  /**
   * The badge row for one skill. Status is only ever READ from the persisted
   * trust state, never re-decided: track data with no persisted trust
   * decision surfaces as `"unscored"` with its real numbers attached.
   */
  private static rowFor(
    name: string,
    trustParse: TrustFileParse,
    store: SkillTrackRecordStore,
    trackGlobalFailure: boolean,
  ): SkillTrustBadgeData {
    let summary: SkillTrackSummary | null = null;
    let chainBroken = false;
    let metricsDiverge = false;

    if (!trackGlobalFailure) {
      const chainCheck = store.verifyChain(name);
      if (!chainCheck.ok) {
        chainBroken = true;
      } else {
        summary = store.summary(name);
        if (summary) {
          // Second, independent line of defense (same cross-check
          // `skill-evolve-command.ts` runs): re-derive the summary's metrics
          // from `store.entries()` via the exported `brierScore`/
          // `wilsonLowerBound` and compare back. A mismatch is treated as
          // `"integrity-error"`, not silently trusted.
          const entries = store.entries(name);
          const recent = entries.slice(-summary.window);
          const recentSuccesses = recent.reduce((acc, e) => acc + (e.success ? 1 : 0), 0);
          const agree =
            closeEnough(brierScore(entries), summary.brier) &&
            closeEnough(brierScore(recent), summary.recentBrier) &&
            closeEnough(wilsonLowerBound(recentSuccesses, recent.length), summary.wilsonLower);
          if (!agree) metricsDiverge = true;
        }
      }
    }

    const trustEntry = trustParse.ok ? trustParse.states.get(name) : undefined;
    const integrityError = !trustParse.ok || trackGlobalFailure || chainBroken || metricsDiverge;

    let status: SkillTrustBadgeStatus;
    if (integrityError) {
      status = "integrity-error";
    } else if (trustEntry) {
      status = trustEntry.status;
    } else {
      status = "unscored";
    }

    return {
      name,
      status,
      wilsonLower: summary ? summary.wilsonLower : null,
      recentBrier: summary ? summary.recentBrier : null,
      n: summary ? summary.n : 0,
      verifiedN: summary ? summary.verifiedN : 0,
    };
  }
}
