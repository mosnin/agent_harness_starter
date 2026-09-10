/* ------------------------------------------------------------------ *
 * provenance.ts — hash-chained, tamper-evident ledger for every Hades
 * backend-fleet lifecycle event (provision / hibernate / wake /
 * terminate / sweep / probe, plus their failure variants).
 *
 * This is the exact same append-only hash-chain pattern shipped in
 * `../browser/trace.ts` (`BrowserTraceLedger` / `verifyTraceChain` /
 * `traceCertificateFields`), retargeted at `BackendManager`'s lifecycle
 * instead of a browsing session's DOM actions: every record chains to
 * the previous one via `hash = sha256(canonicalRecordBytes(record))`,
 * where `canonicalRecordBytes` embeds `prevHash` itself (rather than
 * prefixing it separately), so mutating, reordering, deleting, or
 * forging any single record is detectable by re-deriving the whole
 * chain from the fixed genesis (`BackendProvenanceLedger.rootHash`).
 *
 * Locked import boundary: hashing goes through the REAL STYX
 * certificate engine's `sha256Hex` (`../styx`), never a local
 * reimplementation, so a backend-provenance hash is byte-identical
 * with every other STYX-rooted hash in this codebase (certificates,
 * the browser trace). `./manager` is imported TYPE-ONLY (just the
 * `BackendManagerEvent` union) — `ledgerEventSink` never imports or
 * calls any runtime code from `BackendManager`.
 *
 * Pure and deterministic: the ledger's only ambient time source is its
 * injectable `now` clock (default `Date.now`); `canonicalRecordBytes`
 * and the chain-verification logic below are ordinary pure functions
 * with no I/O and no hidden state. Two ledgers fed the identical event
 * sequence under the identical clock produce byte-identical hashes.
 * ------------------------------------------------------------------ */

import { sha256Hex } from "../styx";
import type { BackendManagerEvent } from "./manager";

// ===========================================================================
// Public contract (locked)
// ===========================================================================

/** Fixed literal hashed to derive every ledger's genesis (`rootHash`). */
export const BACKEND_TRACE_ROOT_PREIMAGE = "hades.backends.trace.v1";

export type BackendEventType =
  | "provision"
  | "provision-failed"
  | "hibernate"
  | "wake"
  | "wake-failed"
  | "terminate"
  | "sweep"
  | "probe";

export interface BackendLifecycleRecord {
  seq: number;
  at: number;
  type: BackendEventType;
  backend: string;
  workerId: string;
  nativeId?: string;
  /** Scalar-only (string | number | boolean) — enforced at append(); see canonicalRecordBytes. */
  detail?: Record<string, string | number | boolean>;
  prevHash: string;
  hash: string;
}

export interface BackendChainVerifyResult {
  ok: boolean;
  /** Index of the first record that failed to verify (present iff !ok). */
  brokenAt?: number;
  /** Machine-readable cause (present iff !ok): "malformed-record" |
   *  "seq-mismatch" | "genesis-mismatch" | "prevhash-mismatch" | "hash-mismatch". */
  reason?: string;
}

export interface BackendCertificateFields {
  traceRoot: string;
  head: string;
  length: number;
}

const BACKEND_EVENT_TYPES: ReadonlySet<string> = new Set<BackendEventType>([
  "provision",
  "provision-failed",
  "hibernate",
  "wake",
  "wake-failed",
  "terminate",
  "sweep",
  "probe",
]);

// ===========================================================================
// Canonicalization — the exact bytes that get hashed
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Canonicalize a `detail` map: object keys sorted lexicographically so two
 * semantically-identical detail objects with different property insertion
 * order serialize (and therefore hash) byte-identically. Every value MUST be
 * a string, a finite number, or a boolean — this is the scalar-only
 * enforcement point: nested objects, arrays, `null`, `undefined`, `NaN`/
 * `Infinity`, functions, bigints, and symbols all throw a descriptive
 * `TypeError` naming the offending key, rather than being silently coerced
 * or dropped.
 */
function canonicalizeDetail(detail: Record<string, string | number | boolean>, path: string): string {
  if (!isPlainObject(detail)) {
    throw new TypeError(`canonicalRecordBytes: ${path} must be a plain object`);
  }
  const keys = Object.keys(detail).sort();
  const parts = keys.map((k) => {
    const v = (detail as Record<string, unknown>)[k];
    const t = typeof v;
    let encoded: string;
    if (t === "string") {
      encoded = JSON.stringify(v);
    } else if (t === "number") {
      if (!Number.isFinite(v as number)) {
        throw new TypeError(`canonicalRecordBytes: ${path}.${k} is a non-finite number (NaN/Infinity)`);
      }
      encoded = JSON.stringify(v);
    } else if (t === "boolean") {
      encoded = v ? "true" : "false";
    } else {
      const kind = v === null ? "null" : Array.isArray(v) ? "array" : t === "object" ? "object" : t;
      throw new TypeError(
        `canonicalRecordBytes: ${path}.${k} must be a string, finite number, or boolean (got ${kind})`,
      );
    }
    return JSON.stringify(k) + ":" + encoded;
  });
  return "{" + parts.join(",") + "}";
}

/**
 * Deterministic JSON serialization of one lifecycle record (everything
 * except `hash` — this string IS the hash's preimage). LOCKED field order:
 * `[seq, at, type, backend, workerId, nativeId?, detail?, prevHash]`.
 * `nativeId` and `detail` are omitted entirely when `undefined` (matching
 * their optional-field semantics, exactly like `payloadSha256` in
 * `../browser/trace.ts`'s `canonicalizeTraceEvent`); every other field, and
 * every value inside a present `detail`, must be well-typed or this throws
 * — never silently coerces.
 */
export function canonicalRecordBytes(r: Omit<BackendLifecycleRecord, "hash">): string {
  if (r === null || typeof r !== "object") {
    throw new TypeError("canonicalRecordBytes: record must be an object");
  }
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) {
    throw new TypeError("canonicalRecordBytes: seq must be a non-negative integer");
  }
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) {
    throw new TypeError("canonicalRecordBytes: at must be a finite number");
  }
  if (typeof r.type !== "string" || !BACKEND_EVENT_TYPES.has(r.type)) {
    throw new TypeError(`canonicalRecordBytes: type "${String(r.type)}" is not a recognised BackendEventType`);
  }
  if (typeof r.backend !== "string") {
    throw new TypeError("canonicalRecordBytes: backend must be a string");
  }
  if (typeof r.workerId !== "string") {
    throw new TypeError("canonicalRecordBytes: workerId must be a string");
  }
  if (r.nativeId !== undefined && typeof r.nativeId !== "string") {
    throw new TypeError("canonicalRecordBytes: nativeId must be a string when present");
  }
  if (typeof r.prevHash !== "string") {
    throw new TypeError("canonicalRecordBytes: prevHash must be a string");
  }

  const parts: string[] = [];
  parts.push('"seq":' + JSON.stringify(r.seq));
  parts.push('"at":' + JSON.stringify(r.at));
  parts.push('"type":' + JSON.stringify(r.type));
  parts.push('"backend":' + JSON.stringify(r.backend));
  parts.push('"workerId":' + JSON.stringify(r.workerId));
  if (r.nativeId !== undefined) parts.push('"nativeId":' + JSON.stringify(r.nativeId));
  if (r.detail !== undefined) parts.push('"detail":' + canonicalizeDetail(r.detail, "detail"));
  parts.push('"prevHash":' + JSON.stringify(r.prevHash));
  return "{" + parts.join(",") + "}";
}

// ===========================================================================
// Defensive copies
// ===========================================================================

function cloneRecord(r: BackendLifecycleRecord): BackendLifecycleRecord {
  const out: BackendLifecycleRecord = {
    seq: r.seq,
    at: r.at,
    type: r.type,
    backend: r.backend,
    workerId: r.workerId,
    prevHash: r.prevHash,
    hash: r.hash,
  };
  if (r.nativeId !== undefined) out.nativeId = r.nativeId;
  if (r.detail !== undefined) out.detail = { ...r.detail };
  return out;
}

// ===========================================================================
// Chain verification (shared by the instance method and fromRecords)
// ===========================================================================

function isStructurallySoundRecord(r: unknown): r is BackendLifecycleRecord {
  if (r === null || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return false;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return false;
  if (typeof o.type !== "string" || !BACKEND_EVENT_TYPES.has(o.type)) return false;
  if (typeof o.backend !== "string") return false;
  if (typeof o.workerId !== "string") return false;
  if (o.nativeId !== undefined && typeof o.nativeId !== "string") return false;
  if (o.detail !== undefined && !isPlainObject(o.detail)) return false;
  if (typeof o.prevHash !== "string") return false;
  if (typeof o.hash !== "string") return false;
  return true;
}

/**
 * Pure re-verification of an entire lifecycle chain, given the genesis
 * (`rootHash`) it should be rooted at: re-derives every record's hash from
 * scratch (no trust in stored `hash`/`prevHash` beyond what is
 * recomputed), checks dense `seq` numbering from 0, checks `prevHash`
 * linkage from `genesis` onward, and recomputes each record's `hash` via
 * `canonicalRecordBytes` + the real STYX `sha256Hex`. The first failure
 * encountered (ascending index order) wins; an empty array verifies
 * `ok: true`.
 */
function verifyRecordChain(records: readonly unknown[], genesis: string): BackendChainVerifyResult {
  if (!Array.isArray(records)) {
    return { ok: false, brokenAt: 0, reason: "malformed-record" };
  }

  let prevHash = genesis;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];

    if (!isStructurallySoundRecord(r)) {
      return { ok: false, brokenAt: i, reason: "malformed-record" };
    }
    if (r.seq !== i) {
      return { ok: false, brokenAt: i, reason: "seq-mismatch" };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, brokenAt: i, reason: i === 0 ? "genesis-mismatch" : "prevhash-mismatch" };
    }

    let expectedHash: string;
    try {
      const pre: Omit<BackendLifecycleRecord, "hash"> = {
        seq: r.seq,
        at: r.at,
        type: r.type,
        backend: r.backend,
        workerId: r.workerId,
        ...(r.nativeId !== undefined ? { nativeId: r.nativeId } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        prevHash: r.prevHash,
      };
      expectedHash = sha256Hex(canonicalRecordBytes(pre));
    } catch {
      return { ok: false, brokenAt: i, reason: "malformed-record" };
    }

    if (expectedHash !== r.hash) {
      return { ok: false, brokenAt: i, reason: "hash-mismatch" };
    }

    prevHash = r.hash;
  }

  return { ok: true };
}

// ===========================================================================
// Ledger
// ===========================================================================

/**
 * Append-only, hash-chained ledger of backend lifecycle events. `seq`
 * starts at 0 and increments densely with every `append`; `at` comes from
 * the injected clock (`opts.now`, default `Date.now`). Every record's
 * `hash` chains to the previous record's `hash` (or, for the first record,
 * to `rootHash`), so the whole sequence can later be independently
 * re-verified with `verifyChain()` — including from a plain array of
 * records via the static `fromRecords`.
 */
export class BackendProvenanceLedger {
  /** sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE) — the fixed genesis every chain roots at. */
  readonly rootHash: string;

  private readonly clock: () => number;
  private readonly _records: BackendLifecycleRecord[] = [];

  constructor(opts?: { now?: () => number }) {
    this.clock = opts?.now ?? (() => Date.now());
    this.rootHash = sha256Hex(BACKEND_TRACE_ROOT_PREIMAGE);
  }

  /**
   * Append one lifecycle event. `detail`, if given, must be scalar-only
   * (string | number | boolean values) or this throws BEFORE mutating
   * ledger state — a rejected append never partially lands.
   */
  append(e: {
    type: BackendEventType;
    backend: string;
    workerId: string;
    nativeId?: string;
    detail?: Record<string, string | number | boolean>;
  }): BackendLifecycleRecord {
    if (e === null || typeof e !== "object") {
      throw new TypeError("BackendProvenanceLedger.append: event must be an object");
    }
    if (typeof e.type !== "string" || !BACKEND_EVENT_TYPES.has(e.type)) {
      throw new TypeError(`BackendProvenanceLedger.append: unrecognised event type "${String(e.type)}"`);
    }
    if (typeof e.backend !== "string") {
      throw new TypeError("BackendProvenanceLedger.append: backend must be a string");
    }
    if (typeof e.workerId !== "string") {
      throw new TypeError("BackendProvenanceLedger.append: workerId must be a string");
    }
    if (e.nativeId !== undefined && typeof e.nativeId !== "string") {
      throw new TypeError("BackendProvenanceLedger.append: nativeId must be a string when present");
    }

    const seq = this._records.length;
    const at = this.clock();
    const prevHash = this.head();

    const pre: Omit<BackendLifecycleRecord, "hash"> = {
      seq,
      at,
      type: e.type,
      backend: e.backend,
      workerId: e.workerId,
      ...(e.nativeId !== undefined ? { nativeId: e.nativeId } : {}),
      ...(e.detail !== undefined ? { detail: { ...e.detail } } : {}),
      prevHash,
    };

    // Throws (scalar-only violation, bad type, ...) before any state mutation.
    const bytes = canonicalRecordBytes(pre);
    const hash = sha256Hex(bytes);

    const record: BackendLifecycleRecord = { ...pre, hash };
    this._records.push(record);
    return cloneRecord(record);
  }

  /** Defensive copies — mutating the returned array/records never corrupts the ledger. */
  records(): readonly BackendLifecycleRecord[] {
    return this._records.map((r) => cloneRecord(r));
  }

  /** Last record's hash, or `rootHash` when the ledger is empty. */
  head(): string {
    return this._records.length === 0 ? this.rootHash : this._records[this._records.length - 1]!.hash;
  }

  /** Full recompute from `rootHash`: seq monotonicity, prevHash linkage, per-record hash recompute. */
  verifyChain(): BackendChainVerifyResult {
    return verifyRecordChain(this._records, this.rootHash);
  }

  toCertificateFields(): BackendCertificateFields {
    return { traceRoot: this.rootHash, head: this.head(), length: this._records.length };
  }

  /**
   * Reconstitute a ledger from a plain record array (e.g. a persisted
   * fleet report). Verifies the FULL chain before accepting — throws a
   * descriptive `Error` (naming the broken index + reason) on any tamper,
   * never silently accepting a corrupted history.
   */
  static fromRecords(records: BackendLifecycleRecord[], opts?: { now?: () => number }): BackendProvenanceLedger {
    if (!Array.isArray(records)) {
      throw new TypeError("BackendProvenanceLedger.fromRecords: records must be an array");
    }
    const ledger = new BackendProvenanceLedger(opts);
    const result = verifyRecordChain(records, ledger.rootHash);
    if (!result.ok) {
      throw new Error(
        `BackendProvenanceLedger.fromRecords: refusing to accept a broken chain (brokenAt ${result.brokenAt}, reason "${result.reason}")`,
      );
    }
    for (const r of records) ledger._records.push(cloneRecord(r));
    return ledger;
  }
}

// ===========================================================================
// BackendManager event adapter
// ===========================================================================

/** Direct, LOCKED mapping from a `BackendManagerEvent.type` to its ledger `BackendEventType`. */
const MANAGER_EVENT_TYPE_MAP: Readonly<Record<string, BackendEventType>> = {
  probe: "probe",
  provisioned: "provision",
  "provision-failed": "provision-failed",
  hibernated: "hibernate",
  woken: "wake",
  terminated: "terminate",
  swept: "sweep",
};

function sanitizeScalar(value: unknown): string | number | boolean {
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "boolean") return value as boolean;
  if (t === "number") return Number.isFinite(value as number) ? (value as number) : String(value);
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** Flatten an arbitrary `Record<string, unknown>` detail bag to the ledger's scalar-only shape. */
function sanitizeDetail(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (v === undefined) continue; // an absent key stays absent — never fabricate "undefined"
    out[k] = sanitizeScalar(v);
  }
  return out;
}

/**
 * Adapter mapping `BackendManager`'s `BackendManagerEvent` stream onto
 * `ledger.append()`. Direct mapping: `provisioned` -> "provision",
 * `provision-failed` -> "provision-failed", `hibernated` -> "hibernate",
 * `woken` -> "wake", `terminated` -> "terminate", `swept` -> "sweep",
 * `probe` -> "probe". Any OTHER event type (`registered`, `selected`, or
 * any future type this adapter doesn't yet know) is never dropped
 * silently: it lands as a "probe"-class record whose `detail` carries the
 * original `BackendManagerEvent.type` under `originalEventType`, so the
 * full manager event history is always represented in the ledger even as
 * `BackendManager` grows new event kinds.
 *
 * `manager.ts` is imported TYPE-ONLY (see the file header) — this
 * function never calls into `BackendManager` runtime code; it only reads
 * the plain-object `BackendManagerEvent` values it's handed.
 */
export function ledgerEventSink(ledger: BackendProvenanceLedger): (e: BackendManagerEvent) => void {
  return (e: BackendManagerEvent) => {
    if (e === null || typeof e !== "object" || typeof e.type !== "string") return;

    const isKnown = Object.prototype.hasOwnProperty.call(MANAGER_EVENT_TYPE_MAP, e.type);
    const type: BackendEventType = isKnown ? MANAGER_EVENT_TYPE_MAP[e.type]! : "probe";

    const backend = typeof e.backend === "string" ? e.backend : "";
    const workerId = typeof e.workerId === "string" ? e.workerId : "";

    const rawDetail: Record<string, unknown> =
      e.detail !== undefined && e.detail !== null && typeof e.detail === "object" && !Array.isArray(e.detail)
        ? { ...(e.detail as Record<string, unknown>) }
        : {};
    if (!isKnown) {
      rawDetail.originalEventType = e.type;
    }

    let nativeId: string | undefined;
    if (typeof rawDetail.nativeId === "string") {
      nativeId = rawDetail.nativeId;
      delete rawDetail.nativeId;
    }

    const detail = sanitizeDetail(rawDetail);

    ledger.append({
      type,
      backend,
      workerId,
      ...(nativeId !== undefined ? { nativeId } : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  };
}
