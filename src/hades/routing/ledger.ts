/* ------------------------------------------------------------------ *
 * ledger.ts — a hash-chained, tamper-evident record of every ROUTING
 * decision a router makes, plus honest per-arm V-TPH$ attribution
 * derived from those records.
 *
 * Every routing decision (which arm was chosen, why, what it cost, what
 * it claimed, what the independent grader said) is appended as a
 * {@link RoutingLedgerEntry}: `hash = sha256Hex(prevHash + "\n" +
 * canonicalizeDecision(d) + "\n" + seq)`, chained to the previous
 * entry's `hash` (or, for the first entry, to {@link ROUTING_LEDGER_GENESIS}).
 * Mutating, reordering, truncating, inserting, or forging any single
 * field of any entry is detectable by re-deriving the chain from
 * scratch ({@link RoutingLedger.verifyChain}). This is the same
 * hash-chain shape already shipped in `src/hades/browser/trace.ts`,
 * applied to routing decisions instead of DOM actions — and, like that
 * module, hashing goes exclusively through the REAL STYX
 * `sha256Hex` (`../styx/certificate`); this file never reimplements a
 * hash function.
 *
 * `attribution()` reduces the ledger to one row per arm
 * ({@link ArmAttribution}): tasks routed to it, verified-correct count,
 * `silentWrong` (the trust-failure metric — `claimedVerified===true`
 * but the independent grader says `false`, so a lying arm earns ZERO
 * throughput credit for that task), declined count, spend, wall time,
 * and `vtph`/`vtphPerDollar` computed with the exact same formula as
 * `../bench/vtph`'s `runVtph` (`verifiedCorrect / hours`, `vtph /
 * max(usd, 1e-9)`) — restated here only because this module reduces
 * ledger ENTRIES, not a batch run through an `AgentRunner`; it is not a
 * second implementation of V-TPH$'s batch harness itself (see
 * `route-bench.ts` for the module that actually drives real batches
 * through the real `runVtph`/`compareVtph`).
 *
 * `serialize()`/`deserialize()` round-trip a ledger through JSON with a
 * versioned envelope. `deserialize` is hostile-input hardened: it never
 * returns a `RoutingLedger` for a chain that does not independently
 * verify, and it raises a distinct {@link RoutingLedgerError.code} for
 * each class of bad input (non-JSON, wrong version, wrong/missing
 * fields, non-finite numerics, non-contiguous `seq`,
 * prototype-pollution keys, and broken hash linkage) rather than
 * failing generically or succeeding silently on garbage.
 * ------------------------------------------------------------------ */

import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Public shapes (locked)
// ===========================================================================

export interface RoutingDecision {
  taskId: string;
  category: string;
  armId: string;
  reason: string;
  candidates: readonly string[];
  fannedOut: readonly string[];
  escalations: number;
  estimatedUsd: number;
  actualUsd: number;
  wallMs: number;
  claimedVerified: boolean;
  graded: boolean | null;
  pCorrect: number;
  certificateId: string | null;
  at: number;
}

export interface RoutingLedgerEntry extends RoutingDecision {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  code: "ok" | "hash-mismatch" | "prev-mismatch" | "seq-gap" | "genesis-mismatch" | "empty";
}

export interface ArmAttribution {
  armId: string;
  tasks: number;
  verifiedCorrect: number;
  silentWrong: number;
  declined: number;
  usd: number;
  wallMs: number;
  vtph: number;
  vtphPerDollar: number;
  escalatedInto: number;
}

/**
 * Thrown by {@link RoutingLedger.deserialize} (and by the constructor,
 * when handed an already-broken chain) for every class of untrusted
 * input this module refuses to accept. `code` is a stable,
 * machine-readable discriminator; `message` is the human-readable
 * detail. Deserializing a broken or malformed chain NEVER succeeds
 * silently — it always throws one of these.
 */
export class RoutingLedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RoutingLedgerError";
    this.code = code;
  }
}

// ===========================================================================
// Genesis
// ===========================================================================

/**
 * Genesis `prevHash` for the very first entry in a routing ledger.
 * Computed once, via the real STYX `sha256Hex`, over the fixed literal
 * `"hades.routing.ledger.v1"`.
 */
export const ROUTING_LEDGER_GENESIS: string = sha256Hex("hades.routing.ledger.v1");

const MS_PER_HOUR = 3_600_000;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ===========================================================================
// Canonicalization
// ===========================================================================

/**
 * Canonicalize one JSON-safe primitive/array value for hashing. Throws a
 * descriptive error naming the offending field path for anything that
 * is not JSON-hash-safe: non-finite numbers (`NaN`/`Infinity`), and any
 * value that is not a string, finite number, boolean, `null`, or an
 * array of such values (an array element itself may recurse through
 * this same check, e.g. `candidates`/`fannedOut` are arrays of
 * strings).
 */
function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalizeDecision: non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonicalizeValue(v, `${path}[${i}]`)).join(",") + "]";
  }
  throw new TypeError(`canonicalizeDecision: unsupported value of type "${t}" at ${path}`);
}

/**
 * Deterministic JSON serialization of a {@link RoutingDecision} with a
 * LOCKED, explicit field order: `taskId, category, armId, reason,
 * candidates, fannedOut, escalations, estimatedUsd, actualUsd, wallMs,
 * claimedVerified, graded, pCorrect, certificateId, at`.
 *
 * Because every field is read by NAME (never via `Object.keys(d)`),
 * the output is identical no matter what order the caller inserted
 * properties into `d` in — two decisions with the same field VALUES
 * canonicalize byte-identically regardless of construction order. This
 * is what makes the hash chain's tamper-evidence work: hashing depends
 * only on field values, never on incidental object shape.
 *
 * Exported for tests. Throws (before any hashing happens) on a
 * non-finite `escalations`/`estimatedUsd`/`actualUsd`/`wallMs`/
 * `pCorrect`/`at`, or on a `candidates`/`fannedOut` entry that is not a
 * plain string.
 */
export function canonicalizeDecision(d: RoutingDecision): string {
  if (d === null || typeof d !== "object") {
    throw new TypeError("canonicalizeDecision: decision must be an object");
  }
  const parts: string[] = [
    '"taskId":' + canonicalizeValue(d.taskId, "taskId"),
    '"category":' + canonicalizeValue(d.category, "category"),
    '"armId":' + canonicalizeValue(d.armId, "armId"),
    '"reason":' + canonicalizeValue(d.reason, "reason"),
    '"candidates":' + canonicalizeValue([...d.candidates], "candidates"),
    '"fannedOut":' + canonicalizeValue([...d.fannedOut], "fannedOut"),
    '"escalations":' + canonicalizeValue(d.escalations, "escalations"),
    '"estimatedUsd":' + canonicalizeValue(d.estimatedUsd, "estimatedUsd"),
    '"actualUsd":' + canonicalizeValue(d.actualUsd, "actualUsd"),
    '"wallMs":' + canonicalizeValue(d.wallMs, "wallMs"),
    '"claimedVerified":' + canonicalizeValue(d.claimedVerified, "claimedVerified"),
    '"graded":' + canonicalizeValue(d.graded, "graded"),
    '"pCorrect":' + canonicalizeValue(d.pCorrect, "pCorrect"),
    '"certificateId":' + canonicalizeValue(d.certificateId, "certificateId"),
    '"at":' + canonicalizeValue(d.at, "at"),
  ];
  return "{" + parts.join(",") + "}";
}

function cloneDecisionFields(d: RoutingDecision): RoutingDecision {
  return {
    taskId: d.taskId,
    category: d.category,
    armId: d.armId,
    reason: d.reason,
    candidates: [...d.candidates],
    fannedOut: [...d.fannedOut],
    escalations: d.escalations,
    estimatedUsd: d.estimatedUsd,
    actualUsd: d.actualUsd,
    wallMs: d.wallMs,
    claimedVerified: d.claimedVerified,
    graded: d.graded,
    pCorrect: d.pCorrect,
    certificateId: d.certificateId,
    at: d.at,
  };
}

function cloneEntry(e: RoutingLedgerEntry): RoutingLedgerEntry {
  return { ...cloneDecisionFields(e), seq: e.seq, prevHash: e.prevHash, hash: e.hash };
}

// ===========================================================================
// Chain verification (pure, re-derives every hash from scratch)
// ===========================================================================

/**
 * Pure re-verification of a routing ledger chain: re-derives every
 * entry's hash from scratch (no trust in stored `hash`/`prevHash`
 * beyond what gets recomputed), checks dense `seq` numbering from 0,
 * checks `prevHash` linkage from {@link ROUTING_LEDGER_GENESIS}
 * onward, and recomputes each entry's `hash` per the locked hash rule.
 * The first failure encountered (ascending `seq` order) wins. An empty
 * array verifies `ok: true` with `code: "empty"`.
 *
 * A recomputation that throws (e.g. a tampered field is now a
 * non-finite number, which {@link canonicalizeDecision} refuses to
 * hash) is reported as `"hash-mismatch"` at that entry's index — the
 * entry's stored hash can no longer be reconciled with its content,
 * which is exactly what tamper-evidence means to report.
 */
function verifyRoutingChain(entries: readonly RoutingLedgerEntry[]): ChainCheck {
  if (entries.length === 0) {
    return { ok: true, entries: 0, brokenAt: null, code: "empty" };
  }

  let prevHash = ROUTING_LEDGER_GENESIS;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;

    if (typeof e?.seq !== "number" || !Number.isInteger(e.seq) || e.seq !== i) {
      return { ok: false, entries: entries.length, brokenAt: i, code: "seq-gap" };
    }

    if (i === 0) {
      if (e.prevHash !== ROUTING_LEDGER_GENESIS) {
        return { ok: false, entries: entries.length, brokenAt: i, code: "genesis-mismatch" };
      }
    } else if (e.prevHash !== prevHash) {
      return { ok: false, entries: entries.length, brokenAt: i, code: "prev-mismatch" };
    }

    let expectedHash: string;
    try {
      expectedHash = sha256Hex(e.prevHash + "\n" + canonicalizeDecision(e) + "\n" + e.seq);
    } catch {
      return { ok: false, entries: entries.length, brokenAt: i, code: "hash-mismatch" };
    }

    if (typeof e.hash !== "string" || expectedHash !== e.hash) {
      return { ok: false, entries: entries.length, brokenAt: i, code: "hash-mismatch" };
    }

    prevHash = e.hash;
  }

  return { ok: true, entries: entries.length, brokenAt: null, code: "ok" };
}

// ===========================================================================
// RoutingLedger
// ===========================================================================

export class RoutingLedger {
  private readonly _entries: RoutingLedgerEntry[];

  /**
   * Construct a ledger, optionally seeded from an existing entry array.
   * This does NOT validate or re-verify the chain — it just stores
   * (defensive-copied) whatever entries are given. That is deliberate:
   * it is what makes {@link RoutingLedger.verifyChain} independently
   * testable against a deliberately-tampered entry array (mutate a
   * clone from `entries()`, feed it back through `new RoutingLedger(...)`,
   * then call `verifyChain()` and inspect the result) without the
   * constructor pre-empting that by throwing. Untrusted, SERIALIZED
   * input should go through {@link RoutingLedger.deserialize} instead,
   * which DOES validate and throws {@link RoutingLedgerError} on a
   * broken or malformed chain.
   */
  constructor(entries?: readonly RoutingLedgerEntry[]) {
    this._entries = entries ? entries.map(cloneEntry) : [];
  }

  /**
   * Append one routing decision. `seq` is the ledger's current length,
   * `prevHash` is the previous entry's `hash` (or
   * {@link ROUTING_LEDGER_GENESIS} for the first entry), and `hash` is
   * computed per the locked rule. Throws (before mutating any state) if
   * `d` cannot be canonicalized — e.g. a non-finite `pCorrect`.
   */
  append(d: RoutingDecision): RoutingLedgerEntry {
    const seq = this._entries.length;
    const prevHash = seq === 0 ? ROUTING_LEDGER_GENESIS : this._entries[seq - 1]!.hash;
    const canon = canonicalizeDecision(d); // throws before any mutation on a bad decision
    const hash = sha256Hex(prevHash + "\n" + canon + "\n" + seq);
    const entry: RoutingLedgerEntry = { ...cloneDecisionFields(d), seq, prevHash, hash };
    this._entries.push(entry);
    return cloneEntry(entry);
  }

  /** Defensive copies — mutating the returned array/objects never corrupts the ledger. */
  entries(): readonly RoutingLedgerEntry[] {
    return this._entries.map(cloneEntry);
  }

  /** The last entry's hash, or {@link ROUTING_LEDGER_GENESIS} when empty. */
  head(): string {
    return this._entries.length === 0 ? ROUTING_LEDGER_GENESIS : this._entries[this._entries.length - 1]!.hash;
  }

  verifyChain(): ChainCheck {
    return verifyRoutingChain(this._entries);
  }

  /**
   * Reduce every entry to one row per arm, in deterministic order
   * (lexicographic by `armId`). The arm universe is the union of every
   * entry's `armId`, every id appearing in any entry's `candidates`,
   * and every id appearing in any entry's `fannedOut` — so an arm that
   * was only ever considered or fanned into (never actually chosen)
   * still gets a row, with `tasks: 0` and no `NaN`/`Infinity` anywhere
   * (zero-task/zero-cost/zero-duration arms report `vtph`/
   * `vtphPerDollar` as exactly `0`, guarded the same way
   * `../bench/vtph`'s `runVtph` guards divide-by-zero).
   *
   * Per arm (over entries where `armId === arm`):
   *   - `verifiedCorrect`: `claimedVerified===true && graded===true`
   *   - `silentWrong`: `claimedVerified===true && graded===false` — the
   *     trust-failure metric. A `graded===null` claimedVerified entry
   *     (ungraded) counts toward neither bucket, matching that `graded`
   *     is a genuine unknown, not a claim to audit yet.
   *   - `declined`: `claimedVerified===false`, regardless of `graded`.
   *   - `usd`/`wallMs`: summed `actualUsd`/`wallMs`.
   *   - `vtph = verifiedCorrect / hours` (`hours = wallMs / 3_600_000`,
   *     0 when `hours<=0`); `vtphPerDollar = vtph / max(usd, 1e-9)`.
   *
   * `escalatedInto` is independent of the arm's OWN entries: it is the
   * count of ledger entries (across the whole ledger, any `armId`)
   * whose `fannedOut` list contains this arm — how many routing
   * decisions fanned traffic into this arm, whether or not it was the
   * one ultimately chosen.
   */
  attribution(): ArmAttribution[] {
    const armIds = new Set<string>();
    for (const e of this._entries) {
      armIds.add(e.armId);
      for (const c of e.candidates) armIds.add(c);
      for (const f of e.fannedOut) armIds.add(f);
    }

    const sorted = [...armIds].sort((a, b) => a.localeCompare(b));

    return sorted.map((armId) => {
      let tasks = 0;
      let verifiedCorrect = 0;
      let silentWrong = 0;
      let declined = 0;
      let usd = 0;
      let wallMs = 0;

      for (const e of this._entries) {
        if (e.armId !== armId) continue;
        tasks += 1;
        usd += e.actualUsd;
        wallMs += e.wallMs;
        if (e.claimedVerified) {
          if (e.graded === true) verifiedCorrect += 1;
          else if (e.graded === false) silentWrong += 1;
        } else {
          declined += 1;
        }
      }

      const hours = wallMs / MS_PER_HOUR;
      const vtph = hours > 0 ? verifiedCorrect / hours : 0;
      const vtphPerDollar = vtph / Math.max(usd, 1e-9);
      const escalatedInto = this._entries.reduce(
        (n, e) => (e.fannedOut.includes(armId) ? n + 1 : n),
        0,
      );

      return { armId, tasks, verifiedCorrect, silentWrong, declined, usd, wallMs, vtph, vtphPerDollar, escalatedInto };
    });
  }

  /** Versioned JSON envelope: `{ version: 1, genesis, entries }`. */
  serialize(): string {
    return JSON.stringify({
      version: 1,
      genesis: ROUTING_LEDGER_GENESIS,
      entries: this._entries.map(cloneEntry),
    });
  }

  /**
   * Parse a {@link RoutingLedger.serialize}-produced (or hostile)
   * string back into a `RoutingLedger`. Hardened against untrusted
   * input: raises a distinct {@link RoutingLedgerError.code} for each
   * failure class below, and NEVER returns a ledger for a chain that
   * does not independently re-verify.
   *
   *   - `"invalid-json"` — input is not a string, or not valid JSON.
   *   - `"malformed"` — the top-level payload, `entries`, or an
   *     individual entry is not the expected plain-object/array shape.
   *   - `"bad-version"` — `version !== 1`.
   *   - `"genesis-mismatch"` — the envelope's `genesis` field does not
   *     equal {@link ROUTING_LEDGER_GENESIS} (or the first entry's
   *     `prevHash` doesn't, once chain verification runs).
   *   - `"unsafe-key"` — a `__proto__`/`constructor`/`prototype` key
   *     anywhere in the payload (prototype-pollution guard).
   *   - `"missing-field"` — a required field is absent or the wrong
   *     JSON type (including non-string `candidates`/`fannedOut`
   *     elements).
   *   - `"invalid-number"` — a numeric field is `NaN`/`Infinity`, or a
   *     non-integer/negative `seq`/`escalations`.
   *   - `"seq-gap"` — `seq` is not contiguous from `0`.
   *   - `"prev-mismatch"` / `"hash-mismatch"` — the parsed chain does
   *     not independently re-verify.
   */
  static deserialize(text: string): RoutingLedger {
    if (typeof text !== "string") {
      throw new RoutingLedgerError("invalid-json", "deserialize: input must be a string");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new RoutingLedgerError(
        "invalid-json",
        `deserialize: input is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!isPlainObject(parsed)) {
      throw new RoutingLedgerError("malformed", "deserialize: top-level payload must be a plain object");
    }
    assertNoUnsafeKeys(parsed, "root");

    if (parsed.version !== 1) {
      throw new RoutingLedgerError(
        "bad-version",
        `deserialize: unsupported version ${JSON.stringify(parsed.version)} (expected 1)`,
      );
    }

    if (typeof parsed.genesis !== "string" || parsed.genesis !== ROUTING_LEDGER_GENESIS) {
      throw new RoutingLedgerError(
        "genesis-mismatch",
        "deserialize: envelope's genesis field does not match ROUTING_LEDGER_GENESIS",
      );
    }

    if (!Array.isArray(parsed.entries)) {
      throw new RoutingLedgerError("malformed", "deserialize: entries must be an array");
    }

    const entries: RoutingLedgerEntry[] = parsed.entries.map((raw, i) => parseEntry(raw, i));

    const check = verifyRoutingChain(entries);
    if (!check.ok) {
      throw new RoutingLedgerError(
        check.code,
        `deserialize: chain verification failed at seq ${check.brokenAt} (code "${check.code}")`,
      );
    }

    return new RoutingLedger(entries);
  }
}

// ===========================================================================
// Hostile-input parsing helpers
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertNoUnsafeKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (UNSAFE_KEYS.has(key)) {
      throw new RoutingLedgerError("unsafe-key", `deserialize: ${where} contains a disallowed key "${key}"`);
    }
  }
}

function parseEntry(raw: unknown, index: number): RoutingLedgerEntry {
  if (!isPlainObject(raw)) {
    throw new RoutingLedgerError("malformed", `deserialize: entries[${index}] must be a plain object`);
  }
  assertNoUnsafeKeys(raw, `entries[${index}]`);

  const field = (key: string): unknown => raw[key];

  const str = (key: string): string => {
    const v = field(key);
    if (typeof v !== "string") {
      throw new RoutingLedgerError("missing-field", `deserialize: entries[${index}].${key} must be a string`);
    }
    return v;
  };

  const strOrNull = (key: string): string | null => {
    const v = field(key);
    if (v === null) return null;
    if (typeof v !== "string") {
      throw new RoutingLedgerError(
        "missing-field",
        `deserialize: entries[${index}].${key} must be a string or null`,
      );
    }
    return v;
  };

  const boolField = (key: string): boolean => {
    const v = field(key);
    if (typeof v !== "boolean") {
      throw new RoutingLedgerError("missing-field", `deserialize: entries[${index}].${key} must be a boolean`);
    }
    return v;
  };

  const boolOrNull = (key: string): boolean | null => {
    const v = field(key);
    if (v === null) return null;
    if (typeof v !== "boolean") {
      throw new RoutingLedgerError(
        "missing-field",
        `deserialize: entries[${index}].${key} must be a boolean or null`,
      );
    }
    return v;
  };

  const numField = (key: string): number => {
    const v = field(key);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new RoutingLedgerError(
        "invalid-number",
        `deserialize: entries[${index}].${key} must be a finite number (received ${JSON.stringify(v)})`,
      );
    }
    return v;
  };

  const nonNegIntField = (key: string): number => {
    const v = numField(key);
    if (!Number.isInteger(v) || v < 0) {
      throw new RoutingLedgerError(
        "invalid-number",
        `deserialize: entries[${index}].${key} must be a non-negative integer (received ${v})`,
      );
    }
    return v;
  };

  const strArray = (key: string): string[] => {
    const v = field(key);
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new RoutingLedgerError(
        "missing-field",
        `deserialize: entries[${index}].${key} must be an array of strings`,
      );
    }
    return [...v];
  };

  const seq = nonNegIntField("seq");
  if (seq !== index) {
    throw new RoutingLedgerError(
      "seq-gap",
      `deserialize: entries[${index}].seq (${seq}) does not match its position ${index}`,
    );
  }

  return {
    taskId: str("taskId"),
    category: str("category"),
    armId: str("armId"),
    reason: str("reason"),
    candidates: strArray("candidates"),
    fannedOut: strArray("fannedOut"),
    escalations: nonNegIntField("escalations"),
    estimatedUsd: numField("estimatedUsd"),
    actualUsd: numField("actualUsd"),
    wallMs: numField("wallMs"),
    claimedVerified: boolField("claimedVerified"),
    graded: boolOrNull("graded"),
    pCorrect: numField("pCorrect"),
    certificateId: strOrNull("certificateId"),
    at: numField("at"),
    seq,
    prevHash: str("prevHash"),
    hash: str("hash"),
  };
}
