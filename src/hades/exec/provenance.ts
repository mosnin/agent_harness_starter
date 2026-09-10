/**
 * STYX provenance ledger — a hash-chained, tamper-evident log of the
 * per-RPC {@link ProvenanceEvent}s a `ToolRpcBridge` (see `./tool-rpc.ts`)
 * emits during a sandboxed run.
 *
 * This turns a bag of independent provenance events into a single canonical,
 * replayable trace: each event is bound into a hash chain (each record's
 * hash covers the previous record's hash plus a canonical serialization of
 * the event), so any edit, reorder, deletion, duplication, or splice
 * anywhere in the history changes every downstream hash and is detectable
 * by re-walking the chain. `ProvenanceLedger#traceSha256()` produces the
 * hex sha256 that callers drop directly into
 * `CertificatePayload.traceSha256` (see `src/hades/styx/certificate.ts`) —
 * the "this is exactly what ran" integrity leg of a Verification
 * Certificate.
 *
 * Hashing convention: identical to `styx/certificate.ts#sha256Hex` and
 * `exec/tool-rpc.ts#sha256Hex` — `createHash("sha256").update(data,
 * "utf8").digest("hex")`, lowercase hex. This file defines its own copy
 * (see LOCKED CONTRACT below) so it never imports runtime code from either
 * sibling module, only the `ProvenanceEvent` / `ToolRpcErrorCode` *types*
 * from `./tool-rpc`.
 *
 * REAL vs MOCK: everything here is real, deterministic, synchronous code.
 * No randomness, no wall-clock reads — every timestamp comes from the
 * `ProvenanceEvent`s the caller appends.
 */

import { createHash } from "node:crypto";
import type { ProvenanceEvent, ToolRpcErrorCode } from "./tool-rpc";

// ---------------------------------------------------------------------------
// Hashing — real node:crypto sha256, lowercase hex, UTF-8 bytes of the
// string. Defined locally (not imported from ./tool-rpc) so this module has
// zero runtime dependency on that file; the encoding is identical to
// `tool-rpc.ts#sha256Hex` and `styx/certificate.ts#sha256Hex` by convention.
// ---------------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

const GENESIS_SEED = "hades-provenance-v1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One link in the provenance hash chain: an event plus its chain binding. */
export interface ProvenanceRecord {
  event: ProvenanceEvent;
  prevSha256: string;
  recordSha256: string;
}

export interface LedgerVerification {
  ok: boolean;
  /** Number of records examined (the ledger length, regardless of ok). */
  length: number;
  /** The `seq` of the first record found to be inconsistent, if any. */
  firstBadSeq?: number;
  reason?: "hash_mismatch" | "chain_break" | "seq_gap" | "malformed";
}

// ---------------------------------------------------------------------------
// canonicalizeEvent — RFC-8785-style deterministic serialization of a
// ProvenanceEvent. Fixed key order, `error` omitted entirely when absent
// (never emitted as `null` or `"undefined"`), numbers serialized via
// `String(n)`. Strict input validation: throws TypeError on anything that
// would make the chain ambiguous or unsafe (non-integer/non-finite numeric
// fields, malformed hash fields, prototype-polluted or extra-key objects).
// ---------------------------------------------------------------------------

const HASH_HEX_RE = /^[0-9a-f]{64}$/;

const KNOWN_KEYS = new Set([
  "seq",
  "tool",
  "inputSha256",
  "outputSha256",
  "ok",
  "error",
  "startedAt",
  "elapsedMs",
]);

const KNOWN_ERROR_CODES: ReadonlySet<ToolRpcErrorCode> = new Set([
  "unknown_tool",
  "not_allowed",
  "tool_error",
  "timeout",
  "malformed_request",
  "call_budget_exceeded",
  "output_truncated",
]);

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(
      `canonicalizeEvent: ${field} must be a finite integer, got ${describe(value)}`,
    );
  }
  return value;
}

function requireHashHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_HEX_RE.test(value)) {
    throw new TypeError(
      `canonicalizeEvent: ${field} must be a 64-char lowercase hex sha256, got ${describe(value)}`,
    );
  }
  return value;
}

function describe(v: unknown): string {
  if (typeof v === "function") return "a function";
  if (typeof v === "symbol") return v.toString();
  try {
    const json = JSON.stringify(v);
    return json === undefined ? String(v) : json;
  } catch {
    return String(v);
  }
}

/**
 * Deterministically serialize a `ProvenanceEvent` for hashing. Fixed key
 * order `[seq, tool, inputSha256, outputSha256, ok, error, startedAt,
 * elapsedMs]`; `error` is omitted entirely (not written) when undefined so
 * that an event with `error: undefined` and an event that never had the key
 * canonicalize identically, while an event with a real error code
 * canonicalizes differently from one without. All numbers are serialized
 * via `String(n)`.
 *
 * Validation (throws `TypeError`):
 *  - `e` must be a plain, non-null, non-array object with no prototype
 *    pollution (`__proto__` as an own enumerable key, or a prototype other
 *    than `Object.prototype`/`null`) and no keys outside the locked
 *    `ProvenanceEvent` shape.
 *  - `seq`, `startedAt`, `elapsedMs` must be finite integers (no floats,
 *    `NaN`, or `Infinity`).
 *  - `tool` must be a non-empty string.
 *  - `inputSha256`/`outputSha256` must be exactly 64 lowercase hex chars.
 *  - `ok` must be a boolean.
 *  - `error`, if present, must be a known `ToolRpcErrorCode` or `undefined`.
 */
export function canonicalizeEvent(e: ProvenanceEvent): string {
  if (e === null || typeof e !== "object" || Array.isArray(e)) {
    throw new TypeError(`canonicalizeEvent: event must be a non-null object, got ${describe(e)}`);
  }

  const proto = Object.getPrototypeOf(e);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("canonicalizeEvent: event must be a plain object (unexpected prototype)");
  }
  if (Object.prototype.hasOwnProperty.call(e, "__proto__")) {
    throw new TypeError("canonicalizeEvent: event has a prototype-polluting own key");
  }

  const keys = Object.keys(e);
  for (const k of keys) {
    if (!KNOWN_KEYS.has(k)) {
      throw new TypeError(`canonicalizeEvent: unknown property "${k}" on event`);
    }
  }

  const obj = e as unknown as Record<string, unknown>;

  const seq = requireInteger(obj.seq, "seq");

  if (typeof obj.tool !== "string" || obj.tool.length === 0) {
    throw new TypeError(`canonicalizeEvent: tool must be a non-empty string, got ${describe(obj.tool)}`);
  }
  const tool = obj.tool;

  const inputSha256 = requireHashHex(obj.inputSha256, "inputSha256");
  const outputSha256 = requireHashHex(obj.outputSha256, "outputSha256");

  if (typeof obj.ok !== "boolean") {
    throw new TypeError(`canonicalizeEvent: ok must be a boolean, got ${describe(obj.ok)}`);
  }
  const ok = obj.ok;

  let error: ToolRpcErrorCode | undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "error") && obj.error !== undefined) {
    if (typeof obj.error !== "string" || !KNOWN_ERROR_CODES.has(obj.error as ToolRpcErrorCode)) {
      throw new TypeError(`canonicalizeEvent: error must be a known ToolRpcErrorCode, got ${describe(obj.error)}`);
    }
    error = obj.error as ToolRpcErrorCode;
  }

  const startedAt = requireInteger(obj.startedAt, "startedAt");
  const elapsedMs = requireInteger(obj.elapsedMs, "elapsedMs");

  const parts: string[] = [
    `"seq":${String(seq)}`,
    `"tool":${JSON.stringify(tool)}`,
    `"inputSha256":${JSON.stringify(inputSha256)}`,
    `"outputSha256":${JSON.stringify(outputSha256)}`,
    `"ok":${ok ? "true" : "false"}`,
  ];
  if (error !== undefined) {
    parts.push(`"error":${JSON.stringify(error)}`);
  }
  parts.push(`"startedAt":${String(startedAt)}`);
  parts.push(`"elapsedMs":${String(elapsedMs)}`);

  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Record-level canonical serialization (for toJSON / traceSha256). Fixed key
// order `[event, prevSha256, recordSha256]`, with `event` itself serialized
// via the same fixed-key-order rule as `canonicalizeEvent` (re-derived here
// rather than re-validated, since every record already went through
// `append`/chain verification).
// ---------------------------------------------------------------------------

function canonicalizeEventForOutput(e: ProvenanceEvent): string {
  // Records already inside the ledger were validated at append/verify time;
  // this just needs the same fixed key order for stable output, so reuse
  // canonicalizeEvent's rules directly (it re-validates, which is cheap and
  // guarantees toJSON can never emit something fromJSON would reject as
  // malformed for a reason other than genuine tampering).
  return canonicalizeEvent(e);
}

function canonicalizeRecord(r: ProvenanceRecord): string {
  return (
    "{" +
    `"event":${canonicalizeEventForOutput(r.event)},` +
    `"prevSha256":${JSON.stringify(r.prevSha256)},` +
    `"recordSha256":${JSON.stringify(r.recordSha256)}` +
    "}"
  );
}

function canonicalizeRecords(records: readonly ProvenanceRecord[]): string {
  return "[" + records.map((r) => canonicalizeRecord(r)).join(",") + "]";
}

// ---------------------------------------------------------------------------
// Chain verification core — shared by ProvenanceLedger#verify(),
// ProvenanceLedger.fromJSON, and ProvenanceLedger.verifyJSON so the three
// entry points can never disagree about what counts as tampering.
// ---------------------------------------------------------------------------

function verifyChain(records: readonly ProvenanceRecord[], genesis: string): LedgerVerification {
  let prev = genesis;
  let expectedSeq = 1;

  for (const r of records) {
    if (
      r === null ||
      typeof r !== "object" ||
      typeof r.prevSha256 !== "string" ||
      typeof r.recordSha256 !== "string" ||
      r.event === null ||
      typeof r.event !== "object"
    ) {
      return {
        ok: false,
        length: records.length,
        firstBadSeq: typeof r?.event?.seq === "number" ? r.event.seq : expectedSeq,
        reason: "malformed",
      };
    }

    let canonicalEvent: string;
    try {
      canonicalEvent = canonicalizeEvent(r.event);
    } catch {
      return {
        ok: false,
        length: records.length,
        firstBadSeq: typeof r.event.seq === "number" ? r.event.seq : expectedSeq,
        reason: "malformed",
      };
    }

    if (r.event.seq !== expectedSeq) {
      return {
        ok: false,
        length: records.length,
        firstBadSeq: r.event.seq,
        reason: "seq_gap",
      };
    }

    if (r.prevSha256 !== prev) {
      return {
        ok: false,
        length: records.length,
        firstBadSeq: r.event.seq,
        reason: "chain_break",
      };
    }

    const expectedRecordSha256 = sha256Hex(prev + "\n" + canonicalEvent);
    if (r.recordSha256 !== expectedRecordSha256) {
      return {
        ok: false,
        length: records.length,
        firstBadSeq: r.event.seq,
        reason: "hash_mismatch",
      };
    }

    prev = r.recordSha256;
    expectedSeq += 1;
  }

  return { ok: true, length: records.length };
}

// ---------------------------------------------------------------------------
// ProvenanceLedger
// ---------------------------------------------------------------------------

export class ProvenanceLedger {
  private readonly genesis: string;
  private readonly recs: ProvenanceRecord[] = [];

  constructor(opts?: { genesis?: string }) {
    this.genesis = opts?.genesis !== undefined ? opts.genesis : sha256Hex(GENESIS_SEED);
  }

  /**
   * Append a new event. Requires `e.seq === this.length() + 1` — the bridge
   * that produces `ProvenanceEvent`s already guarantees a monotone,
   * gap-free seq starting at 1, so any mismatch here indicates a caller bug
   * (dropped event, out-of-order append, re-ingested duplicate) and is
   * rejected loudly rather than silently renumbered.
   */
  append(e: ProvenanceEvent): ProvenanceRecord {
    const expectedSeq = this.recs.length + 1;
    if (e.seq !== expectedSeq) {
      throw new RangeError(
        `ProvenanceLedger.append: expected seq ${expectedSeq}, got ${describe((e as { seq?: unknown })?.seq)}`,
      );
    }
    const prevSha256 = this.headSha256();
    const canonicalEvent = canonicalizeEvent(e);
    const recordSha256 = sha256Hex(prevSha256 + "\n" + canonicalEvent);
    const record: ProvenanceRecord = { event: { ...e }, prevSha256, recordSha256 };
    this.recs.push(record);
    return record;
  }

  /** Defensive copy of every record appended so far, in seq order. */
  records(): ProvenanceRecord[] {
    return this.recs.map((r) => ({ event: { ...r.event }, prevSha256: r.prevSha256, recordSha256: r.recordSha256 }));
  }

  length(): number {
    return this.recs.length;
  }

  /** The recordSha256 of the last record, or the genesis hash if empty. */
  headSha256(): string {
    return this.recs.length === 0 ? this.genesis : this.recs[this.recs.length - 1].recordSha256;
  }

  /**
   * hex sha256 over the canonical JSON of the full record array. This is
   * the value callers place into `CertificatePayload.traceSha256`.
   */
  traceSha256(): string {
    return sha256Hex(canonicalizeRecords(this.recs));
  }

  /**
   * Serialize the full ledger (genesis + records) to JSON. Round-trips
   * byte-identically through `fromJSON` -> `toJSON`.
   */
  toJSON(): string {
    return JSON.stringify({ genesis: this.genesis, records: this.recs });
  }

  /** Re-walk the full chain from genesis and report the structured verdict. */
  verify(): LedgerVerification {
    return verifyChain(this.recs, this.genesis);
  }

  /**
   * Parse a ledger previously produced by `toJSON()` and re-verify the
   * entire chain. Throws on ANY tamper (hash mismatch, chain break, seq
   * gap, malformed shape) or malformed JSON — a caller that gets a
   * `ProvenanceLedger` back from this can trust it without re-checking.
   */
  static fromJSON(json: string): ProvenanceLedger {
    const parsed = parseLedgerJSON(json);
    const verdict = verifyChain(parsed.records, parsed.genesis);
    if (!verdict.ok) {
      throw new Error(
        `ProvenanceLedger.fromJSON: tampered or corrupt ledger (reason=${verdict.reason ?? "unknown"}` +
          (verdict.firstBadSeq !== undefined ? `, firstBadSeq=${verdict.firstBadSeq}` : "") +
          ")",
      );
    }
    const ledger = new ProvenanceLedger({ genesis: parsed.genesis });
    for (const r of parsed.records) {
      ledger.recs.push({ event: { ...r.event }, prevSha256: r.prevSha256, recordSha256: r.recordSha256 });
    }
    return ledger;
  }

  /**
   * Parse-and-verify without throwing: malformed JSON or an unparseable
   * shape reports as `{ ok: false, length: 0, reason: "malformed" }` rather
   * than raising.
   */
  static verifyJSON(json: string): LedgerVerification {
    let parsed: { genesis: string; records: ProvenanceRecord[] };
    try {
      parsed = parseLedgerJSON(json);
    } catch {
      return { ok: false, length: 0, reason: "malformed" };
    }
    return verifyChain(parsed.records, parsed.genesis);
  }
}

function parseLedgerJSON(json: string): { genesis: string; records: ProvenanceRecord[] } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new Error(`ProvenanceLedger: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ProvenanceLedger: expected a JSON object with { genesis, records }");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.genesis !== "string") {
    throw new Error("ProvenanceLedger: missing/invalid genesis field");
  }
  if (!Array.isArray(obj.records)) {
    throw new Error("ProvenanceLedger: missing/invalid records field");
  }
  return { genesis: obj.genesis, records: obj.records as ProvenanceRecord[] };
}
