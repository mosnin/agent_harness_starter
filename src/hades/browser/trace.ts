/* ------------------------------------------------------------------ *
 * trace.ts — hash-chained, tamper-evident DOM-action trace ledger.
 *
 * Every navigate/act/screenshot/extract a browsing task performs is
 * appended as a `TracedEventRecord`: a small structured `detail` (url,
 * action kind, selector, status, passage count, ...) plus, when a
 * caller hands over a bulky payload (a screenshot PNG, extracted HTML,
 * page text), only that payload's sha256 — never the bytes themselves.
 * Each record is chained to the previous one exactly like a append-only
 * ledger / blockchain-lite: `hash = sha256(prevHash + "\n" +
 * canonicalize(event))`, so mutating, reordering, deleting, or forging
 * any single event is detectable by re-deriving the chain from
 * scratch (`verifyTraceChain`). `traceCertificateFields` turns a
 * verified chain into the small, fixed-shape object a STYX
 * `CertificatePayload` embeds as its browsing-trace leg.
 *
 * Locked import boundary: this module imports `sha256Hex` from the
 * REAL STYX certificate engine (`../styx/certificate`) — so trace
 * hashing is byte-identical with certificate hashing, and this file
 * never reimplements sha256 itself — plus Node built-ins only. No
 * other `src/hades/browser/*` file is imported here (and this module
 * must not be imported by them either, per the build's file-ownership
 * split for this phase).
 *
 * Pure and deterministic: no ambient `Date.now()` inside the ledger
 * except as the *default* clock — every timestamp source is
 * injectable, and `canonicalizeTraceEvent` / `verifyTraceChain` /
 * `traceCertificateFields` are ordinary pure functions with no I/O and
 * no hidden state.
 * ------------------------------------------------------------------ */

import { sha256Hex } from "../styx/certificate";
import { Buffer } from "node:buffer";

// ===========================================================================
// Public contract (locked)
// ===========================================================================

export type BrowserTraceKind = "navigate" | "act" | "screenshot" | "extract";

export interface BrowserTraceEvent {
  seq: number;
  at: number;
  kind: BrowserTraceKind;
  /**
   * Small structured facts only (url, action kind, selector, status,
   * passage count, ...). Bulky payloads (PNG base64, extracted text,
   * raw HTML) are NEVER stored here — pass them to
   * `BrowserTraceLedger.append`'s `payload` argument instead; only
   * their sha256 lands on the record, in `payloadSha256`.
   */
  detail: Record<string, unknown>;
  payloadSha256?: string;
}

export interface TracedEventRecord extends BrowserTraceEvent {
  prevHash: string;
  hash: string;
}

export type TraceVerifyResult =
  | { ok: true; rootHash: string; length: number }
  | {
      ok: false;
      index: number;
      reason: "malformed" | "seq-gap" | "genesis-mismatch" | "chain-break" | "hash-mismatch";
    };

export interface TraceCertificateFields {
  traceRoot: string;
  eventCount: number;
  firstAt: number;
  lastAt: number;
}

// ===========================================================================
// Genesis
// ===========================================================================

/**
 * Genesis `prevHash` for the very first record in a trace chain.
 *
 * Computed once at module load, via the real STYX certificate engine's
 * `sha256Hex`, over the fixed literal string `"hades.browser.trace.v1"`.
 * That literal's hex digest — documented here so the value is legible
 * without re-running the hash — is:
 *
 *   ba908ac3d279c9faef7f464346e9988d36c932bdf9d3f147344897475561cd8d
 *
 * (sha256 hex digests are 64 hex chars for 32 bytes; the extra-long
 * looking string above is exactly that — verify with
 * `node -e "console.log(require('crypto').createHash('sha256').update('hades.browser.trace.v1','utf8').digest('hex'))"`.)
 */
export const TRACE_GENESIS: string = sha256Hex("hades.browser.trace.v1");

// ===========================================================================
// Canonicalization
// ===========================================================================

const VALID_TRACE_KINDS: ReadonlySet<string> = new Set<BrowserTraceKind>([
  "navigate",
  "act",
  "screenshot",
  "extract",
]);

/**
 * Canonicalize a single JSON-safe value into deterministic JSON text:
 * object keys are sorted lexicographically at every level (recursively),
 * array element order is preserved, and every value is checked for
 * JSON-safety before being emitted. Throws a descriptive `Error` naming
 * the offending path (e.g. `detail.headers.0` or `detail.count`) for
 * any non-JSON-safe shape: `undefined`, functions, `bigint`, `symbol`,
 * non-finite numbers (`NaN`/`Infinity`/`-Infinity`), circular
 * references, or object instances other than plain objects/arrays
 * (e.g. `Date`, `Map`, `Set`, `RegExp`, class instances) — those are
 * ambiguous under JSON and must never be silently coerced.
 */
function canonicalizeValue(value: unknown, path: string, ancestors: Set<unknown>): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(
        `canonicalizeTraceEvent: non-JSON-safe number (NaN/Infinity) at ${path}`,
      );
    }
    return JSON.stringify(value);
  }

  if (t === "string") return JSON.stringify(value);

  if (t === "undefined") {
    throw new Error(`canonicalizeTraceEvent: undefined value at ${path}`);
  }

  if (t === "function") {
    throw new Error(`canonicalizeTraceEvent: function value at ${path}`);
  }

  if (t === "bigint") {
    throw new Error(`canonicalizeTraceEvent: bigint value at ${path}`);
  }

  if (t === "symbol") {
    throw new Error(`canonicalizeTraceEvent: symbol value at ${path}`);
  }

  // t === "object" from here on.
  if (ancestors.has(value)) {
    throw new Error(`canonicalizeTraceEvent: circular reference at ${path}`);
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      const parts = value.map((v, i) => canonicalizeValue(v, `${path}[${i}]`, ancestors));
      return "[" + parts.join(",") + "]";
    } finally {
      ancestors.delete(value);
    }
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    throw new Error(
      `canonicalizeTraceEvent: unsupported non-plain-object value (${ctorName}) at ${path}`,
    );
  }

  ancestors.add(value);
  try {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalizeValue(obj[k], `${path}.${k}`, ancestors),
    );
    return "{" + parts.join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deterministic JSON serialization of a `BrowserTraceEvent` with the
 * LOCKED top-level field order `[seq, at, kind, detail, payloadSha256]`
 * (`payloadSha256` omitted entirely when `undefined`, matching its
 * optional-field semantics — this is the one place "absent" is treated
 * as absent rather than thrown on; every value *inside* `detail`, and
 * `seq`/`at`/`kind`/`payloadSha256` themselves when present, must still
 * be JSON-safe or this throws). Object keys inside `detail` are sorted
 * recursively so identical events canonicalize byte-identically
 * regardless of property insertion order, across processes.
 */
export function canonicalizeTraceEvent(e: BrowserTraceEvent): string {
  if (e === null || typeof e !== "object") {
    throw new TypeError("canonicalizeTraceEvent: event must be an object");
  }

  const ancestors = new Set<unknown>();
  const parts: string[] = [];

  parts.push('"seq":' + canonicalizeValue(e.seq, "seq", ancestors));
  parts.push('"at":' + canonicalizeValue(e.at, "at", ancestors));
  parts.push('"kind":' + canonicalizeValue(e.kind, "kind", ancestors));
  parts.push('"detail":' + canonicalizeValue(e.detail, "detail", ancestors));

  if (e.payloadSha256 !== undefined) {
    parts.push('"payloadSha256":' + canonicalizeValue(e.payloadSha256, "payloadSha256", ancestors));
  }

  return "{" + parts.join(",") + "}";
}

// ===========================================================================
// Payload hashing
// ===========================================================================

/**
 * Real sha256 (via the certificate engine's `sha256Hex`, never
 * reimplemented) of a payload's exact bytes, as lowercase hex.
 *
 * `sha256Hex` only accepts a UTF-8 string, but payloads may be raw
 * binary (`Uint8Array`, e.g. PNG screenshot bytes) that is not valid
 * UTF-8 text — decoding it naively would silently mangle bytes
 * (invalid sequences become U+FFFD) and corrupt the hash. To stay
 * exact for arbitrary bytes while still routing through `sha256Hex`,
 * every payload is first normalized to its base64 text encoding (a
 * lossless, bijective text form of any byte sequence) and *that* text
 * is what gets hashed. A `string` payload is treated as its UTF-8
 * bytes before base64-encoding, so a string and the `Uint8Array` of
 * that same string's UTF-8 encoding always produce the same
 * `payloadSha256`.
 */
function hashPayload(payload: string | Uint8Array): string {
  const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
  const base64 = Buffer.from(bytes).toString("base64");
  return sha256Hex(base64);
}

// ===========================================================================
// Ledger
// ===========================================================================

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = deepClone(obj[k]);
  return out as T;
}

function cloneRecord(r: TracedEventRecord): TracedEventRecord {
  const cloned: TracedEventRecord = {
    seq: r.seq,
    at: r.at,
    kind: r.kind,
    detail: deepClone(r.detail),
    prevHash: r.prevHash,
    hash: r.hash,
  };
  if (r.payloadSha256 !== undefined) cloned.payloadSha256 = r.payloadSha256;
  return cloned;
}

/**
 * Append-only, hash-chained ledger of `BrowserTraceEvent`s. `seq`
 * starts at 0 and increments densely with every `append`; `at` comes
 * from the injected clock (`opts.now`, default `Date.now`). Every
 * record's `hash` chains to the previous record's `hash` (or, for the
 * first record, to `TRACE_GENESIS`), so the whole sequence can later be
 * independently re-verified with `verifyTraceChain`.
 */
export class BrowserTraceLedger {
  private readonly clock: () => number;
  private readonly _records: TracedEventRecord[] = [];

  constructor(opts?: { now?: () => number }) {
    this.clock = opts?.now ?? Date.now;
  }

  /**
   * Append one traced event. `detail` must be JSON-safe (see
   * `canonicalizeTraceEvent`) or this throws before mutating ledger
   * state. `payload`, if given, is hashed (never stored) and its
   * sha256 lands in the record's `payloadSha256`.
   */
  append(
    kind: BrowserTraceKind,
    detail: Record<string, unknown>,
    payload?: string | Uint8Array,
  ): TracedEventRecord {
    if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
      throw new TypeError("BrowserTraceLedger.append: detail must be a plain object");
    }

    const seq = this._records.length;
    const at = this.clock();
    const clonedDetail = deepClone(detail);

    const event: BrowserTraceEvent =
      payload !== undefined
        ? { seq, at, kind, detail: clonedDetail, payloadSha256: hashPayload(payload) }
        : { seq, at, kind, detail: clonedDetail };

    const prevHash = this._records.length === 0 ? TRACE_GENESIS : this._records[this._records.length - 1]!.hash;
    const hash = sha256Hex(prevHash + "\n" + canonicalizeTraceEvent(event));

    const record: TracedEventRecord = { ...event, prevHash, hash };
    this._records.push(record);
    return cloneRecord(record);
  }

  /** Defensive copies — mutating the returned array/objects never corrupts the ledger. */
  records(): TracedEventRecord[] {
    return this._records.map((r) => cloneRecord(r));
  }

  /** Last record's hash, or `TRACE_GENESIS` when the ledger is empty. */
  rootHash(): string {
    return this._records.length === 0 ? TRACE_GENESIS : this._records[this._records.length - 1]!.hash;
  }

  get length(): number {
    return this._records.length;
  }
}

// ===========================================================================
// Verification
// ===========================================================================

function isMalformedRecord(r: unknown): boolean {
  if (r === null || typeof r !== "object") return true;
  const o = r as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return true;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return true;
  if (typeof o.kind !== "string" || !VALID_TRACE_KINDS.has(o.kind)) return true;
  if (o.detail === null || typeof o.detail !== "object" || Array.isArray(o.detail)) return true;
  if (o.payloadSha256 !== undefined && typeof o.payloadSha256 !== "string") return true;
  if (typeof o.prevHash !== "string") return true;
  if (typeof o.hash !== "string") return true;
  return false;
}

/**
 * Pure re-verification of an entire trace chain: re-derives every
 * record's hash from scratch (no trust in stored `hash`/`prevHash`
 * fields beyond what gets recomputed), checks dense `seq` numbering
 * from 0, checks `prevHash` linkage from `TRACE_GENESIS` onward, and
 * recomputes each record's `hash`. The first failure encountered (in
 * ascending index order) wins and is returned with its index; an empty
 * array verifies `ok: true` with `rootHash === TRACE_GENESIS`.
 */
export function verifyTraceChain(records: readonly TracedEventRecord[]): TraceVerifyResult {
  if (!Array.isArray(records)) {
    return { ok: false, index: 0, reason: "malformed" };
  }

  let prevHash = TRACE_GENESIS;

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;

    if (isMalformedRecord(r)) {
      return { ok: false, index: i, reason: "malformed" };
    }

    if (r.seq !== i) {
      return { ok: false, index: i, reason: "seq-gap" };
    }

    if (i === 0) {
      if (r.prevHash !== TRACE_GENESIS) {
        return { ok: false, index: i, reason: "genesis-mismatch" };
      }
    } else if (r.prevHash !== prevHash) {
      return { ok: false, index: i, reason: "chain-break" };
    }

    const event: BrowserTraceEvent =
      r.payloadSha256 !== undefined
        ? { seq: r.seq, at: r.at, kind: r.kind, detail: r.detail, payloadSha256: r.payloadSha256 }
        : { seq: r.seq, at: r.at, kind: r.kind, detail: r.detail };

    let expectedHash: string;
    try {
      expectedHash = sha256Hex(r.prevHash + "\n" + canonicalizeTraceEvent(event));
    } catch {
      return { ok: false, index: i, reason: "malformed" };
    }

    if (expectedHash !== r.hash) {
      return { ok: false, index: i, reason: "hash-mismatch" };
    }

    prevHash = r.hash;
  }

  return {
    ok: true,
    rootHash: records.length === 0 ? TRACE_GENESIS : records[records.length - 1]!.hash,
    length: records.length,
  };
}

// ===========================================================================
// Certificate embedding
// ===========================================================================

/**
 * Reduce a verified trace chain to the fixed-shape object a STYX
 * `CertificatePayload` embeds as its browsing-trace leg. Never
 * certifies a broken chain: throws if `verifyTraceChain(records)` does
 * not report `ok: true`. Also throws on an empty chain — there is no
 * honest, non-fabricated `firstAt`/`lastAt` to report when zero events
 * occurred, and this function's return type requires real numbers, not
 * placeholders.
 */
export function traceCertificateFields(records: readonly TracedEventRecord[]): TraceCertificateFields {
  const result = verifyTraceChain(records);
  if (!result.ok) {
    throw new Error(
      `traceCertificateFields: refusing to certify a broken trace chain (index ${result.index}, reason "${result.reason}")`,
    );
  }
  if (records.length === 0) {
    throw new Error("traceCertificateFields: cannot derive certificate fields from an empty trace (no events)");
  }

  const first = records[0]!;
  const last = records[records.length - 1]!;

  return {
    traceRoot: result.rootHash,
    eventCount: records.length,
    firstAt: first.at,
    lastAt: last.at,
  };
}
