/**
 * The audit layer for `src/hades/schedule/**`: a durable, hash-chained,
 * tamper-evident ledger of every {@link DeliveryReceipt} a job delivery ever
 * produces, plus {@link LedgeredDeliverer} — a `JobDeliverer` decorator that
 * interposes on any inner deliverer (in production: the real
 * `VerifiedDeliveryRouter` from `./delivery`) and records its receipts
 * without ever touching what actually gets sent.
 *
 * ## Why this exists
 *
 * `VerifiedDeliveryRouter` already refuses to *send* anything unless the
 * real STYX gate + certificate say it may. That is a claim about a single
 * moment in time. This module turns "job X delivered as verified" into a
 * claim that survives afterward: every receipt is appended to an
 * append-only, hash-chained record so that later, independently, anyone can
 * recompute the chain from the persisted bytes and detect any edit,
 * deletion, reorder, or forged tail record. The ledger does not decide what
 * is verified — it only ever records, honestly and unforgeably, what the
 * deliverer already decided.
 *
 * ## Hash chain (locked mechanics)
 *
 * `RECEIPT_LEDGER_GENESIS_SEED` is a fixed literal. The chain root — the
 * `prevHash` of the very first record (`seq === 0`) — is
 * `sha256Hex(RECEIPT_LEDGER_GENESIS_SEED)`, computed once via the REAL
 * `sha256Hex` from `../styx/certificate` (never reimplemented here; this is
 * the same hash primitive `../browser/trace.ts`'s ledger uses, for exactly
 * the same reason: one hash implementation for the whole codebase).
 *
 * Every record's `hash` is `sha256Hex(canonical)`, where `canonical` is a
 * **fixed-field-order** JSON-ish serialization of every `ReceiptRecord`
 * field EXCEPT `hash` itself. Mirroring `../browser/trace.ts`'s
 * canonicalization discipline (explicit, documented, order-independent-of-
 * insertion field order so two structurally identical records always
 * canonicalize byte-for-byte identically), the LOCKED field order is:
 *
 * ```
 * seq, prevHash, at, jobId, jobName, outcome, reason, badge,
 * platform, user, certFingerprint, textSha256, attempts
 * ```
 *
 * Each field is emitted as `"<name>":<JSON.stringify(value)>` and joined
 * with commas inside a single `{...}` object literal — see
 * `canonicalizeReceiptFields` below for the exact implementation. Because
 * every field here is a scalar (string, finite number, or null — never a
 * nested object/array), a plain explicit-field JSON.stringify per value is
 * exactly as deterministic as recursive key-sorting would be, without the
 * complexity `trace.ts` needs for its free-form `detail` bag.
 *
 * `prevHash` for `seq === 0` is the genesis root; for every later record it
 * is the exact `hash` of the record immediately before it. `seq` is dense
 * and strictly monotonic from `0`. Any deviation — a hash that does not
 * recompute, a `prevHash` that does not match the prior record's `hash`, a
 * `seq` that skips or repeats, a deleted/reordered/forged record — is
 * caught by {@link DeliveryReceiptLedger.verifyChain}, which recomputes
 * every hash from scratch rather than trusting any stored value.
 *
 * ## Privacy (locked)
 *
 * The delivered text itself is NEVER written to a `ReceiptRecord` or to
 * disk. Only `sha256Hex(deliveredText)` is kept, in `textSha256` (`null`
 * when nothing was sent). `certFingerprint` is lifted from the receipt's
 * own badge stamp — concretely, `VerifiedDeliveryRouter.formatDeliveryText`
 * embeds the real `stamp.certFingerprint` as a `certFingerprint: <hex>`
 * token inside the delivered text for a verified delivery (see
 * `./delivery.ts`); this module extracts that token with a regex rather
 * than re-deriving or fabricating one, and only when `badge === "verified"`
 * — every other outcome (including "abstained", whose notice text carries
 * no such token) always records `certFingerprint: null`.
 *
 * ## Persistence (locked)
 *
 * With no `path`, the ledger is in-memory only. With a `path`, every
 * successful `append` rewrites the FULL versioned envelope
 * (`{ version: 1, records: [...] }`) atomically: a fixed `.tmp` sibling is
 * written first, then `renameSync`'d over the target — the exact discipline
 * `JsonFileJobStore` (`./store.ts`) uses, so a crash between those two steps
 * can only ever leave the untouched previous file or an orphaned `.tmp`
 * sibling, never a half-written target. If the rename step itself fails,
 * the in-memory append is rolled back (so the ledger's own state never
 * drifts from what is actually durable) and the error propagates to the
 * caller — for {@link LedgeredDeliverer} that means `onLedgerError` fires
 * and the original file is left completely intact.
 *
 * Construction with a `path` re-verifies the ENTIRE chain of whatever is on
 * disk before trusting it — a missing file is just an empty ledger; a file
 * that fails to parse, has the wrong shape, or whose chain does not
 * independently re-verify is never silently accepted and never silently
 * discarded: it is renamed aside to `<path>.corrupt-<epoch>[-N]` (bad bytes
 * preserved for forensics) and a fresh empty chain starts, honestly
 * reported via `loadReport()` as `{ recovered: true, warning }`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sha256Hex } from "../styx/certificate";
import type { DeliveryReceipt, JobDeliverer } from "./delivery";
import type { ScheduledJob } from "./store";
import type { JobExecutionContext, JobExecutionResult } from "./runner";
import type { Clock } from "./clock";
import { systemClock } from "./clock";

// ===========================================================================
// Locked public types
// ===========================================================================

/** Fixed literal the chain root is derived from — see the module doc. */
export const RECEIPT_LEDGER_GENESIS_SEED = "hades.schedule.receipts.v1";

export interface ReceiptRecord {
  seq: number;
  prevHash: string;
  hash: string;
  at: number;
  jobId: string;
  jobName: string;
  outcome: "delivered" | "abstained" | "withheld" | "failed";
  reason: string;
  badge: string;
  platform: string | null;
  user: string | null;
  certFingerprint: string | null;
  textSha256: string | null;
  attempts: number;
}

export interface ReceiptChainVerification {
  ok: boolean;
  length: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

export interface ReceiptLedgerLoadReport {
  path: string | null;
  recovered: boolean;
  warning: string | null;
}

export interface ReceiptTally {
  delivered: number;
  abstained: number;
  withheld: number;
  failed: number;
}

export interface ReceiptLedgerOptions {
  path?: string;
  clock?: Clock;
}

// ===========================================================================
// Small pure helpers
// ===========================================================================

const GENESIS_ROOT = sha256Hex(RECEIPT_LEDGER_GENESIS_SEED);

const RECEIPT_OUTCOMES: ReadonlySet<string> = new Set(["delivered", "abstained", "withheld", "failed"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The LOCKED canonical serialization of every `ReceiptRecord` field except
 * `hash`, in the fixed order documented at the top of this file. Every
 * value here is a scalar (string, finite number, or null), so a plain
 * `JSON.stringify` per named field — always emitted in the same order
 * regardless of the input object's own property insertion order — is
 * exactly as deterministic as `trace.ts`'s recursive key-sorting, without
 * needing that machinery for a fixed, flat shape. Throws if `seq`, `at`, or
 * `attempts` is not a finite number — a non-finite value here would
 * silently canonicalize to `"null"` via `JSON.stringify(NaN)` and corrupt
 * the hash's meaning without any visible error, which is exactly the kind
 * of silent corruption this whole module exists to make impossible.
 */
function canonicalizeReceiptFields(r: Omit<ReceiptRecord, "hash">): string {
  if (!Number.isFinite(r.seq)) {
    throw new TypeError(`canonicalizeReceiptFields: seq must be a finite number, got ${String(r.seq)}`);
  }
  if (!Number.isFinite(r.at)) {
    throw new TypeError(`canonicalizeReceiptFields: at must be a finite number, got ${String(r.at)}`);
  }
  if (!Number.isFinite(r.attempts)) {
    throw new TypeError(`canonicalizeReceiptFields: attempts must be a finite number, got ${String(r.attempts)}`);
  }

  const parts: string[] = [
    '"seq":' + JSON.stringify(r.seq),
    '"prevHash":' + JSON.stringify(r.prevHash),
    '"at":' + JSON.stringify(r.at),
    '"jobId":' + JSON.stringify(r.jobId),
    '"jobName":' + JSON.stringify(r.jobName),
    '"outcome":' + JSON.stringify(r.outcome),
    '"reason":' + JSON.stringify(r.reason),
    '"badge":' + JSON.stringify(r.badge),
    '"platform":' + JSON.stringify(r.platform),
    '"user":' + JSON.stringify(r.user),
    '"certFingerprint":' + JSON.stringify(r.certFingerprint),
    '"textSha256":' + JSON.stringify(r.textSha256),
    '"attempts":' + JSON.stringify(r.attempts),
  ];
  return "{" + parts.join(",") + "}";
}

/**
 * Recompute a record's `hash` from its other fields via
 * `canonicalizeReceiptFields`. Never trusts the stored `hash` — that is the
 * whole point of tamper evidence.
 */
function computeRecordHash(r: Omit<ReceiptRecord, "hash">): string {
  return sha256Hex(canonicalizeReceiptFields(r));
}

/**
 * Structural shape validation for a `ReceiptRecord` loaded off disk (or
 * otherwise untrusted). Deliberately strict: every field's type and, where
 * meaningful, its value domain is checked, so a record that merely "looks
 * like JSON" but has the wrong shape is rejected before it ever reaches
 * hash verification.
 */
function isValidReceiptRecordShape(v: unknown): v is ReceiptRecord {
  if (!isPlainRecord(v)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.prevHash !== "string") return false;
  if (typeof v.hash !== "string") return false;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return false;
  if (typeof v.jobId !== "string") return false;
  if (typeof v.jobName !== "string") return false;
  if (typeof v.outcome !== "string" || !RECEIPT_OUTCOMES.has(v.outcome)) return false;
  if (typeof v.reason !== "string") return false;
  if (typeof v.badge !== "string") return false;
  if (v.platform !== null && typeof v.platform !== "string") return false;
  if (v.user !== null && typeof v.user !== "string") return false;
  if (v.certFingerprint !== null && typeof v.certFingerprint !== "string") return false;
  if (v.textSha256 !== null && typeof v.textSha256 !== "string") return false;
  if (typeof v.attempts !== "number" || !Number.isInteger(v.attempts) || v.attempts < 0) return false;
  return true;
}

/**
 * Pure re-verification of an entire receipt chain: for every record (in
 * ascending index order), checks shape, dense `seq` numbering from `0`,
 * `prevHash` linkage back to the genesis root (or the prior record's real
 * `hash`), and recomputes `hash` from scratch. The first failure wins and
 * is reported with its `seq` and a reason naming exactly what failed
 * ("malformed record", "seq gap", "prevHash mismatch", or "hash mismatch")
 * — never a generic "chain broken". An empty chain verifies `ok: true`.
 */
function verifyReceiptRecords(records: readonly ReceiptRecord[]): ReceiptChainVerification {
  let prevHash = GENESIS_ROOT;

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;

    if (!isValidReceiptRecordShape(r)) {
      return { ok: false, length: records.length, brokenAtSeq: i, reason: `malformed record at index ${i}` };
    }

    if (r.seq !== i) {
      return {
        ok: false,
        length: records.length,
        brokenAtSeq: i,
        reason: `seq gap at index ${i}: expected seq ${i}, got seq ${r.seq}`,
      };
    }

    if (r.prevHash !== prevHash) {
      return {
        ok: false,
        length: records.length,
        brokenAtSeq: r.seq,
        reason: `prevHash mismatch at seq ${r.seq}: expected ${prevHash}, got ${r.prevHash}`,
      };
    }

    let expectedHash: string;
    try {
      expectedHash = computeRecordHash(r);
    } catch (err) {
      return {
        ok: false,
        length: records.length,
        brokenAtSeq: r.seq,
        reason: `malformed record at seq ${r.seq}: ${errorMessage(err)}`,
      };
    }

    if (expectedHash !== r.hash) {
      return {
        ok: false,
        length: records.length,
        brokenAtSeq: r.seq,
        reason: `hash mismatch at seq ${r.seq}: stored hash does not match the recomputed hash of its fields`,
      };
    }

    prevHash = r.hash;
  }

  return { ok: true, length: records.length, brokenAtSeq: null, reason: null };
}

/**
 * Lift the real cert fingerprint token `VerifiedDeliveryRouter.
 * formatDeliveryText` embeds in a verified delivery's outbound text
 * (`certFingerprint: <hex>`), never fabricating one. Returns `null` when no
 * such token is present — including for every non-verified delivery, whose
 * text (an abstention notice, or nothing at all) never contains this token.
 */
function extractCertFingerprint(text: string): string | null {
  const match = /certFingerprint:\s*([^\s|]+)/.exec(text);
  return match ? match[1]! : null;
}

// ===========================================================================
// DeliveryReceiptLedger
// ===========================================================================

interface PersistedReceiptFile {
  version: 1;
  records: ReceiptRecord[];
}

export class DeliveryReceiptLedger {
  private readonly path: string | null;
  private readonly clock: Clock;
  private _records: ReceiptRecord[] = [];
  private readonly report: ReceiptLedgerLoadReport;

  constructor(opts?: ReceiptLedgerOptions) {
    this.path = opts?.path ?? null;
    this.clock = opts?.clock ?? systemClock;
    this.report = this.path ? this.loadFromDisk(this.path) : { path: null, recovered: false, warning: null };
  }

  /**
   * Append a `DeliveryReceipt` for `job`. Derives every `ReceiptRecord`
   * field per the locked mapping (see module doc), computes `seq` /
   * `prevHash` / `hash`, and — when this ledger has a `path` — persists the
   * full updated envelope atomically before returning. On a persistence
   * failure, the in-memory append is rolled back (so `records()` never
   * reports something that isn't durable) and the error is re-thrown to
   * the caller; `LedgeredDeliverer` is the one that turns that throw into
   * `onLedgerError` plus an unaffected delivery result.
   */
  append(job: ScheduledJob, receipt: DeliveryReceipt): ReceiptRecord {
    if (!job || typeof job.id !== "string" || typeof job.name !== "string") {
      throw new TypeError("DeliveryReceiptLedger.append: job must be a ScheduledJob with string id/name");
    }
    if (!receipt || !RECEIPT_OUTCOMES.has(receipt.outcome)) {
      throw new TypeError(
        `DeliveryReceiptLedger.append: receipt.outcome must be one of delivered/abstained/withheld/failed, got ${JSON.stringify(receipt?.outcome)}`,
      );
    }

    const seq = this._records.length;
    const prevHash = seq === 0 ? GENESIS_ROOT : this._records[seq - 1]!.hash;
    const at = this.clock.now();
    const platform = receipt.target?.platform ?? null;
    const user = receipt.target?.user ?? null;
    const textSha256 = receipt.deliveredText !== undefined ? sha256Hex(receipt.deliveredText) : null;
    const certFingerprint =
      receipt.badge === "verified" && receipt.deliveredText !== undefined
        ? extractCertFingerprint(receipt.deliveredText)
        : null;

    const withoutHash: Omit<ReceiptRecord, "hash"> = {
      seq,
      prevHash,
      at,
      jobId: job.id,
      jobName: job.name,
      outcome: receipt.outcome,
      reason: receipt.reason,
      badge: receipt.badge,
      platform,
      user,
      certFingerprint,
      textSha256,
      attempts: receipt.attempts,
    };
    const hash = computeRecordHash(withoutHash);
    const record: ReceiptRecord = { ...withoutHash, hash };

    this._records.push(record);
    if (this.path) {
      try {
        this.persist(this.path);
      } catch (err) {
        this._records.pop();
        throw err;
      }
    }

    return { ...record };
  }

  /**
   * Defensive copies, optionally filtered by exact `jobId` and/or capped to
   * the last `limit` matching records (most recent, chain order preserved
   * — i.e. "the last N receipts for this job", not an arbitrary subset).
   * `limit` must be a non-negative integer when provided; `limit: 0`
   * returns an empty array.
   */
  records(filter?: { jobId?: string; limit?: number }): ReceiptRecord[] {
    let out = this._records;
    if (filter?.jobId !== undefined) {
      out = out.filter((r) => r.jobId === filter.jobId);
    }
    if (filter?.limit !== undefined) {
      const limit = filter.limit;
      if (!Number.isInteger(limit) || limit < 0) {
        throw new RangeError(`DeliveryReceiptLedger.records: limit must be a non-negative integer, got ${limit}`);
      }
      out = limit === 0 ? [] : out.slice(Math.max(0, out.length - limit));
    }
    return out.map((r) => ({ ...r }));
  }

  /** Outcome counts across every appended record (filter never applies). */
  tally(): ReceiptTally {
    const t: ReceiptTally = { delivered: 0, abstained: 0, withheld: 0, failed: 0 };
    for (const r of this._records) {
      t[r.outcome] += 1;
    }
    return t;
  }

  /** Independent re-verification of the current in-memory chain. */
  verifyChain(): ReceiptChainVerification {
    return verifyReceiptRecords(this._records);
  }

  loadReport(): ReceiptLedgerLoadReport {
    return { ...this.report };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadFromDisk(path: string): ReceiptLedgerLoadReport {
    if (!existsSync(path)) {
      return { path, recovered: false, warning: null };
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      return this.quarantine(path, `unreadable receipt ledger file: ${errorMessage(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this.quarantine(path, `invalid JSON in receipt ledger file: ${errorMessage(err)}`);
    }

    if (!isPlainRecord(parsed)) {
      return this.quarantine(path, "receipt ledger file did not contain a JSON object");
    }
    if (parsed.version !== 1) {
      return this.quarantine(path, `unsupported receipt ledger version: ${JSON.stringify(parsed.version)}`);
    }
    if (!Array.isArray(parsed.records)) {
      return this.quarantine(path, 'receipt ledger file\'s "records" field is not an array');
    }
    for (const candidate of parsed.records) {
      if (!isValidReceiptRecordShape(candidate)) {
        return this.quarantine(path, "receipt ledger file contains a malformed receipt record");
      }
    }

    const verification = verifyReceiptRecords(parsed.records as ReceiptRecord[]);
    if (!verification.ok) {
      return this.quarantine(
        path,
        `receipt ledger chain verification failed at seq ${String(verification.brokenAtSeq)}: ${verification.reason}`,
      );
    }

    this._records = (parsed.records as ReceiptRecord[]).map((r) => ({ ...r }));
    return { path, recovered: false, warning: null };
  }

  /**
   * Never lets a corrupt/tampered/unparseable file crash construction: the
   * file is renamed aside to `<path>.corrupt-<epoch>[-N]` (never silently
   * deleted, so the bad bytes stay available for forensics) and the ledger
   * starts as a fresh, empty chain. If even the rename fails, that failure
   * is folded into the warning and the ledger still starts empty in memory
   * rather than throwing out of the constructor.
   */
  private quarantine(path: string, reason: string): ReceiptLedgerLoadReport {
    const ts = this.clock.now();
    let target = `${path}.corrupt-${ts}`;
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = `${path}.corrupt-${ts}-${suffix}`;
    }

    this._records = [];
    try {
      renameSync(path, target);
      return { path, recovered: true, warning: `${reason}; quarantined to ${target}` };
    } catch (renameErr) {
      return {
        path,
        recovered: true,
        warning: `${reason}; could not quarantine (${errorMessage(renameErr)}), starting empty in memory`,
      };
    }
  }

  /**
   * Atomic write of the full envelope: `mkdir -p` the parent, write the
   * fixed `.tmp` sibling, then `renameSync` it over the target — identical
   * discipline to `JsonFileJobStore.persist` (`./store.ts`). The tmp path
   * is fixed (not unique per write), so a stale tmp left behind by an
   * earlier crash is simply overwritten by the next write.
   */
  private persist(path: string): void {
    const payload: PersistedReceiptFile = { version: 1, records: this._records };
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpPath, path);
  }
}

// ===========================================================================
// LedgeredDeliverer
// ===========================================================================

/**
 * A `JobDeliverer` decorator: awaits `inner.deliver`, appends the resulting
 * receipt to `ledger`, and returns the SAME receipt object `inner` produced
 * — unaltered, by reference. The ledger is purely an observer:
 *
 *  - If `inner.deliver` rejects, that rejection propagates untouched and
 *    NOTHING is appended — there is no receipt to record, and fabricating
 *    one to keep the chain "complete" would be a lie the ledger exists to
 *    prevent.
 *  - If `inner.deliver` resolves but `ledger.append` throws (a bad shape,
 *    or a persistence failure such as a failed atomic rename),
 *    `onLedgerError` — if provided — is called with the error's message,
 *    and the real receipt is still returned. A broken audit trail must
 *    never be allowed to corrupt, delay, or hide a real delivery outcome.
 */
export class LedgeredDeliverer implements JobDeliverer {
  constructor(
    private readonly inner: JobDeliverer,
    private readonly ledger: DeliveryReceiptLedger,
    private readonly onLedgerError?: (message: string) => void,
  ) {}

  async deliver(job: ScheduledJob, result: JobExecutionResult, ctx: JobExecutionContext): Promise<DeliveryReceipt> {
    const receipt = await this.inner.deliver(job, result, ctx);

    try {
      this.ledger.append(job, receipt);
    } catch (err) {
      if (this.onLedgerError) {
        this.onLedgerError(errorMessage(err));
      }
    }

    return receipt;
  }
}
