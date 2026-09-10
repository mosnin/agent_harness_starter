/**
 * track-record — a durable, hash-chained, Brier-scored per-skill outcome
 * ledger.
 *
 * Every time a skill is used, the caller records a *forecast* (`predictedP`,
 * the calibrated probability the use would succeed) alongside the observed
 * outcome (`success`). This module persists that observation as an
 * append-only, per-skill hash chain — each entry binds cryptographically to
 * the one before it (`hash = sha256Hex(prevHash + canonicalEntryJson)`) — so
 * that later tampering with the on-disk ledger (flipping a `success` flag,
 * rewriting a forecast after the fact) is detectable, not just implausible.
 * {@link SkillTrackRecordStore.verifyChain} walks the chain and reports the
 * *exact* `{skillName, seq}` at which recorded reality first diverges from
 * the persisted hash, and {@link SkillTrackRecordStore.load} surfaces that
 * divergence rather than silently discarding or "fixing" it.
 *
 * On top of the raw ledger, {@link SkillTrackRecordStore.summary} reports the
 * calibration (Brier score — see {@link brierScore}) and reliability (Wilson
 * lower bound on the recent success rate — see {@link wilsonLowerBound}) of
 * each skill, both over the full history and over a trailing window, so a
 * caller (e.g. a skill-selection policy) can down-weight or demote a skill
 * whose track record does not support its own forecasts.
 *
 * REAL-VS-MOCK POLICY: persistence is REAL `node:fs` by default, using the
 * exact write-tmp-then-rename atomic-write pattern used elsewhere in Hades
 * (see `gateway/trust-store.ts`, `gateway/continuity.ts`,
 * `research/recorder.ts`) so a reader never observes a half-written file.
 * The filesystem is fully injectable (`TrackRecordStoreOptions.fs`) for
 * tests — including tests that need to hand-corrupt persisted bytes between
 * store instances to exercise tamper detection — and the clock is injectable
 * (`TrackRecordStoreOptions.now`). Hashing is REAL sha256 (via
 * `sha256Hex` from `../styx/certificate`, itself backed by `node:crypto`) —
 * no home-rolled crypto, no simulated hashes. This module never calls
 * `Date.now()` itself (only the injectable `now` default does) and never
 * reads `process.env` — the caller (the CLI) is responsible for deciding
 * where the store should live and passing that in as `opts.path`.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Types (locked contract)
// ---------------------------------------------------------------------------

/** One observed use of a skill: what was forecast, and what happened. */
export interface SkillOutcome {
  skillName: string;
  /** [0,1] forecast that the use would succeed, made before the outcome was known. */
  predictedP: number;
  success: boolean;
  at: number;
  /** hex sha256 of a verification certificate — present iff the use was gate-verified. */
  certSha256?: string;
  runId?: string;
}

/** A {@link SkillOutcome} sealed into the per-skill hash chain. */
export interface TrackRecordEntry extends SkillOutcome {
  /** 0-based position in this skill's chain. */
  seq: number;
  /** hash of the entry immediately before this one (or the genesis hash at seq 0). */
  prevHash: string;
  /** sha256Hex(prevHash + canonicalEntryJson), see {@link canonicalEntryJson}. */
  hash: string;
}

/** Calibration + reliability summary for one skill's track record. */
export interface SkillTrackSummary {
  skillName: string;
  /** total recorded outcomes. */
  n: number;
  /** of those, how many were gate-verified (carried a certSha256). */
  verifiedN: number;
  /** mean (predictedP - outcome)^2 over ALL entries. */
  brier: number;
  /** mean (predictedP - outcome)^2 over the trailing `window` entries. */
  recentBrier: number;
  successRate: number;
  recentSuccessRate: number;
  window: number;
  lastAt: number;
  /** 95% Wilson lower bound on the recent (trailing-window) success rate. */
  wilsonLower: number;
}

/** Minimal, injectable filesystem surface this store needs. */
export interface TrackRecordFs {
  /** Returns file contents, or null if the file does not exist. */
  readFile(p: string): string | null;
  /** Writes file contents. The default implementation does this atomically (tmp + rename). */
  writeFile(p: string, c: string): void;
  /** Recursively creates a directory if it does not already exist. */
  mkdirp(d: string): void;
}

export interface TrackRecordStoreOptions {
  /**
   * A caller-provided path used only to derive the directory the store
   * lives in: the store persists to `<dirname(path)>/skill-track.json`.
   * Defaults to `process.cwd()` when omitted. This module never reads
   * `process.env` itself — resolving the right directory (e.g. from a
   * config file or environment) is the caller's job.
   */
  path?: string;
  /** Trailing-window size for `recentBrier` / `recentSuccessRate` / `wilsonLower`. Default 20. */
  window?: number;
  /** Injectable clock; defaults to `() => Date.now()`. Never called internally except via this. */
  now?: () => number;
  /** Injectable filesystem; defaults to real `node:fs` with atomic tmp+rename writes. */
  fs?: TrackRecordFs;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by {@link SkillTrackRecordStore.record} when an outcome fails validation. Never persisted. */
export class TrackRecordValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "TrackRecordValidationError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Mean squared error between forecast and outcome (0/1), i.e. the classic
 * Brier score for binary events: mean over `entries` of
 * `(predictedP - (success ? 1 : 0))^2`. Lower is better; 0 is perfect
 * calibration, 1 is maximally wrong (confidently predicting the opposite of
 * what happened every time). Returns `NaN` for an empty input — the mean of
 * an empty set is undefined, and callers (`summary`) never invoke this with
 * zero entries.
 */
export function brierScore(
  entries: ReadonlyArray<{ predictedP: number; success: boolean }>,
): number {
  if (entries.length === 0) return NaN;
  let sumSquaredError = 0;
  for (const e of entries) {
    const outcome = e.success ? 1 : 0;
    const error = e.predictedP - outcome;
    sumSquaredError += error * error;
  }
  return sumSquaredError / entries.length;
}

/**
 * 95%-by-default Wilson score interval lower bound for a binomial
 * proportion `successes / n`, evaluated with the standard closed-form
 * formula (no normal-approximation shortcuts, so no approximation drift):
 *
 *   p̂ = successes / n
 *   centre = p̂ + z²/(2n)
 *   margin = z * sqrt( p̂(1-p̂)/n + z²/(4n²) )
 *   denom  = 1 + z²/n
 *   lower  = (centre - margin) / denom
 *
 * `wilsonLowerBound(0, 0)` is defined to be exactly `0` (n=0 carries no
 * information; the formula itself is undefined at n=0 since every term
 * divides by n). Monotonically increasing in `n` for fixed proportion.
 */
export function wilsonLowerBound(
  successes: number,
  n: number,
  z = 1.96,
): number {
  if (n <= 0) return 0;
  const pHat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = pHat + z2 / (2 * n);
  const margin = z * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n));
  return (centre - margin) / denom;
}

// ---------------------------------------------------------------------------
// Hash-chain internals
// ---------------------------------------------------------------------------

const GENESIS_PREFIX = "hades.skill-track.v1:";

function genesisHash(skillName: string): string {
  return sha256Hex(GENESIS_PREFIX + skillName);
}

/**
 * Deterministic (sorted-key, `undefined`-valued keys omitted) JSON
 * serialization, so two structurally-equal entries always canonicalize to
 * the same string regardless of property insertion order — this is what
 * both `record` and `verifyChain` hash, so it must be exactly reproducible
 * from an entry loaded back off disk.
 */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

/** The fields hashed for one entry: the full entry minus its own `hash`. */
type EntryPreimage = Omit<TrackRecordEntry, "hash">;

function canonicalEntryJson(preimage: EntryPreimage): string {
  return canonicalStringify(preimage);
}

function computeEntryHash(preimage: EntryPreimage): string {
  return sha256Hex(preimage.prevHash + canonicalEntryJson(preimage));
}

// ---------------------------------------------------------------------------
// Default (real) filesystem
// ---------------------------------------------------------------------------

/** Real `node:fs`-backed {@link TrackRecordFs}: atomic tmp+rename writes, ENOENT → null reads. */
const realFs: TrackRecordFs = {
  readFile(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile(p: string, content: string): void {
    // Unique tmp suffix from real crypto randomness — deliberately not
    // Date.now()-derived, per the "no Date.now() outside the injectable
    // `now`" rule.
    const suffix = randomBytes(8).toString("hex");
    const tmp = `${p}.${suffix}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
  },
  mkdirp(d: string): void {
    mkdirSync(d, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// Persisted envelope shape
// ---------------------------------------------------------------------------

interface PersistedEnvelopeV1 {
  version: 1;
  chains: Record<string, TrackRecordEntry[]>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural (not cryptographic) validation of one loaded entry's shape. */
function isWellFormedEntry(v: unknown): v is TrackRecordEntry {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.skillName === "string" &&
    v.skillName.length > 0 &&
    typeof v.predictedP === "number" &&
    Number.isFinite(v.predictedP) &&
    typeof v.success === "boolean" &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    typeof v.seq === "number" &&
    Number.isInteger(v.seq) &&
    typeof v.prevHash === "string" &&
    typeof v.hash === "string" &&
    (v.certSha256 === undefined || typeof v.certSha256 === "string") &&
    (v.runId === undefined || typeof v.runId === "string")
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SkillTrackRecordStore {
  private readonly window: number;
  private readonly clock: () => number;
  private readonly fs: TrackRecordFs;
  private readonly filePath: string;
  private chains = new Map<string, TrackRecordEntry[]>();
  /**
   * Per-skill cache of already-serialized entry JSON strings, in the same
   * order as `chains`. `persist`/`serialize` join these directly instead of
   * re-running `JSON.stringify` (a full object-graph walk) over every prior
   * entry on every single `record()` call — appending one entry only ever
   * costs one new `JSON.stringify(entry)` (O(1) in the entry's own size),
   * not O(n) in the chain's length. This is what keeps `record()` itself
   * free of any accidental O(n) (let alone O(n²)) re-hash/re-serialize
   * work as a skill's chain grows; the *disk write itself* is still
   * necessarily proportional to total on-disk size (an atomic full-file
   * tmp+rename write has no other way to be durable), which is the one
   * remaining, unavoidable, honestly-O(n)-per-call cost.
   */
  private entryJsonCache = new Map<string, string[]>();

  constructor(opts: TrackRecordStoreOptions = {}) {
    const window = opts.window ?? 20;
    if (!Number.isInteger(window) || window <= 0) {
      throw new TrackRecordValidationError(
        `window must be a positive integer, got ${window}`,
        "window",
      );
    }
    this.window = window;
    this.clock = opts.now ?? (() => Date.now());
    this.fs = opts.fs ?? realFs;
    const dir = opts.path ? dirname(opts.path) : process.cwd();
    this.filePath = join(dir, "skill-track.json");
    this.load();
  }

  /**
   * Validates and appends one outcome to `o.skillName`'s hash chain,
   * persisting immediately. Throws {@link TrackRecordValidationError}
   * (never partially persisting) on:
   *  - non-finite / out-of-[0,1] `predictedP`
   *  - non-finite `at`
   *  - empty/whitespace-only `skillName`
   *  - an `at` that is earlier than the skill's last recorded `at`
   *    (timestamps must be non-decreasing within a skill's chain)
   */
  record(o: SkillOutcome): TrackRecordEntry {
    if (typeof o.skillName !== "string" || o.skillName.trim().length === 0) {
      throw new TrackRecordValidationError(
        "skillName must be a non-empty string",
        "skillName",
      );
    }
    if (!Number.isFinite(o.predictedP) || o.predictedP < 0 || o.predictedP > 1) {
      throw new TrackRecordValidationError(
        `predictedP must be a finite number in [0,1], got ${o.predictedP}`,
        "predictedP",
      );
    }
    if (!Number.isFinite(o.at)) {
      throw new TrackRecordValidationError(
        `at must be a finite timestamp, got ${o.at}`,
        "at",
      );
    }

    const chain = this.chains.get(o.skillName) ?? [];
    const last = chain.length > 0 ? chain[chain.length - 1] : undefined;
    if (last && o.at < last.at) {
      throw new TrackRecordValidationError(
        `at (${o.at}) is earlier than this skill's last recorded at (${last.at}); timestamps must be non-decreasing`,
        "at",
      );
    }

    const prevHash = last ? last.hash : genesisHash(o.skillName);
    const seq = chain.length;

    const preimage: EntryPreimage = {
      skillName: o.skillName,
      predictedP: o.predictedP,
      success: o.success,
      at: o.at,
      seq,
      prevHash,
      ...(o.certSha256 !== undefined ? { certSha256: o.certSha256 } : {}),
      ...(o.runId !== undefined ? { runId: o.runId } : {}),
    };
    const hash = computeEntryHash(preimage);
    const entry: TrackRecordEntry = Object.freeze({ ...preimage, hash });

    const nextChain = chain.length > 0 ? chain : [];
    if (chain.length === 0) this.chains.set(o.skillName, nextChain);
    nextChain.push(entry);

    let cache = this.entryJsonCache.get(o.skillName);
    if (!cache) {
      cache = [];
      this.entryJsonCache.set(o.skillName, cache);
    }
    cache.push(JSON.stringify(entry));

    this.persist();
    return entry;
  }

  /** Read-only, defensively-copied view of one skill's chain, oldest first. */
  entries(skillName: string): readonly TrackRecordEntry[] {
    return [...(this.chains.get(skillName) ?? [])];
  }

  /** Calibration/reliability summary for one skill, or null if it has no recorded outcomes. */
  summary(skillName: string): SkillTrackSummary | null {
    const chain = this.chains.get(skillName);
    if (!chain || chain.length === 0) return null;

    const n = chain.length;
    const verifiedN = chain.reduce((acc, e) => acc + (e.certSha256 !== undefined ? 1 : 0), 0);
    const successes = chain.reduce((acc, e) => acc + (e.success ? 1 : 0), 0);
    const recent = chain.slice(-this.window);
    const recentSuccesses = recent.reduce((acc, e) => acc + (e.success ? 1 : 0), 0);

    return {
      skillName,
      n,
      verifiedN,
      brier: brierScore(chain),
      recentBrier: brierScore(recent),
      successRate: successes / n,
      recentSuccessRate: recentSuccesses / recent.length,
      window: this.window,
      lastAt: chain[chain.length - 1].at,
      wilsonLower: wilsonLowerBound(recentSuccesses, recent.length),
    };
  }

  /** Summaries for every skill with at least one recorded outcome, sorted by skill name. */
  summaries(): SkillTrackSummary[] {
    const names = [...this.chains.keys()].sort();
    const out: SkillTrackSummary[] = [];
    for (const name of names) {
      const s = this.summary(name);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Walks the hash chain for `skillName` (or every skill, if omitted),
   * recomputing each entry's hash from its own fields and comparing it both
   * to the entry's stored `hash` and to the following entry's `prevHash`.
   * Returns the exact `{skillName, seq}` of the first entry where reality
   * (the recomputed hash) diverges from what is stored — this is what makes
   * tampering detectable rather than merely implausible.
   */
  verifyChain(skillName?: string): { ok: boolean; brokenAt?: { skillName: string; seq: number } } {
    const names = skillName !== undefined ? [skillName] : [...this.chains.keys()];
    for (const name of names) {
      const chain = this.chains.get(name) ?? [];
      let expectedPrevHash = genesisHash(name);
      for (let i = 0; i < chain.length; i++) {
        const e = chain[i];
        if (e.skillName !== name || e.seq !== i || e.prevHash !== expectedPrevHash) {
          return { ok: false, brokenAt: { skillName: name, seq: i } };
        }
        const { hash, ...preimage } = e;
        const expectedHash = computeEntryHash(preimage as EntryPreimage);
        if (expectedHash !== hash) {
          return { ok: false, brokenAt: { skillName: name, seq: i } };
        }
        expectedPrevHash = hash;
      }
    }
    return { ok: true };
  }

  /**
   * (Re)loads the store from disk. Distinguishes two failure modes:
   *
   *  - **Unreadable envelope** (missing file → fresh empty store, ok:true;
   *    invalid JSON, wrong version, or structurally malformed entries →
   *    `{ok:false}` with the parse/shape error, and the in-memory store is
   *    reset to empty-but-usable — never a partial/inconsistent load).
   *  - **Tamper detected**: the envelope parses and every entry is
   *    structurally well-formed, but the hash chain does not verify (a
   *    field was altered after the fact). The corrupted data is kept
   *    in-memory exactly as read — `load` surfaces this, it does not
   *    silently repair or discard it — so `verifyChain`/`entries` can be
   *    used afterward to pinpoint and inspect the break, and `{ok:false}`
   *    names the exact skill/seq in `error`.
   */
  load(): { ok: boolean; migrated: boolean; error?: string } {
    let raw: string | null;
    try {
      raw = this.fs.readFile(this.filePath);
    } catch (err) {
      this.resetToEmpty();
      return { ok: false, migrated: false, error: `failed to read track-record store: ${(err as Error).message}` };
    }

    if (raw === null) {
      this.resetToEmpty();
      return { ok: true, migrated: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.resetToEmpty();
      return { ok: false, migrated: false, error: `invalid JSON in track-record store: ${(err as Error).message}` };
    }

    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.chains)) {
      this.resetToEmpty();
      return { ok: false, migrated: false, error: "unrecognized track-record envelope (expected {version:1, chains:{...}})" };
    }

    const envelope = parsed as unknown as PersistedEnvelopeV1;
    const newChains = new Map<string, TrackRecordEntry[]>();
    const newCache = new Map<string, string[]>();
    for (const [name, entries] of Object.entries(envelope.chains)) {
      if (!Array.isArray(entries) || !entries.every(isWellFormedEntry)) {
        this.resetToEmpty();
        return { ok: false, migrated: false, error: `malformed chain entries for skill "${name}"` };
      }
      newChains.set(name, entries);
      newCache.set(
        name,
        entries.map((e) => JSON.stringify(e)),
      );
    }

    this.chains = newChains;
    this.entryJsonCache = newCache;

    const verification = this.verifyChain();
    if (!verification.ok) {
      // Keep the (tampered) data loaded and visible — do not repair or drop it.
      const at = verification.brokenAt!;
      return {
        ok: false,
        migrated: false,
        error: `hash chain integrity check failed at skillName="${at.skillName}" seq=${at.seq}`,
      };
    }

    return { ok: true, migrated: false };
  }

  /**
   * Versioned envelope `{version:1, chains:{...}}`, exactly what is
   * persisted to disk. Built from the per-skill cached entry-JSON strings
   * (see {@link entryJsonCache}) rather than re-running `JSON.stringify`
   * over the full in-memory object graph, so a skill's already-serialized
   * history is never re-walked just to append one more entry.
   */
  serialize(): string {
    const chainParts: string[] = [];
    for (const name of this.chains.keys()) {
      const cached = this.entryJsonCache.get(name) ?? [];
      chainParts.push(`${JSON.stringify(name)}:[${cached.join(",")}]`);
    }
    return `{"version":1,"chains":{${chainParts.join(",")}}}`;
  }

  private resetToEmpty(): void {
    this.chains = new Map();
    this.entryJsonCache = new Map();
  }

  private persist(): void {
    this.fs.mkdirp(dirname(this.filePath));
    this.fs.writeFile(this.filePath, this.serialize());
  }
}
