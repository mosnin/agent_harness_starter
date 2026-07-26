/**
 * json-line.ts — the NaN-safe JSONL codec both hash-chained eval ledgers
 * persist through (`./history`'s `EvalHistoryLedger` and `./regression-gate`'s
 * `GateVerdictJournal`).
 *
 * ## Why this exists (a real defect, not a hypothetical)
 *
 * Both ledgers hash their records with a canonical serializer that is
 * deliberately NON-FINITE SAFE: `canonicalizeScorecard` (./scorecard) encodes
 * `NaN`/`±Infinity` as explicit tokens, and `stableStringify`
 * (./regression-gate) does the same. That is the whole point of this
 * subsystem's honesty rule — an unmeasured risk lane reports `NaN` rather
 * than a fabricated `0`, and a zero-spend `vtphPerDollar` reports `Infinity`
 * rather than a fabricated finite number.
 *
 * Plain `JSON.stringify`, however, silently encodes every non-finite number
 * as `null`. So a record whose HASH covered `NaN` was being persisted with
 * `null` on disk, and the very next read recomputed a different hash. The
 * observable product bug: a first `hades eval run` on a real install (no
 * `AdmitFn` wired -> honestly unmeasured risk lane -> `NaN` fields) wrote a
 * history chain that immediately failed its own `verifyChain()` with
 * `hash-mismatch`, and the gate journal did the same for any verdict carrying
 * a `NaN` metric delta. Four independent modules had papered over this in
 * their tests by forcing a measured risk lane; it is fixed here at the source
 * instead.
 *
 * ## The encoding (locked)
 *
 * A non-finite number is written as a one-key marker object:
 *
 *     NaN        ->  {"$hades:number":"NaN"}
 *     Infinity   ->  {"$hades:number":"Infinity"}
 *     -Infinity  ->  {"$hades:number":"-Infinity"}
 *
 * Round-tripping is EXACT for every value, including the adversarial case of
 * genuine data that happens to look like a marker. An object whose sole own
 * key collides with a reserved key is escaped as
 *
 *     {"$hades:escaped":{"key":<the colliding key>,"value":<the value>}}
 *
 * whose inner two-key payload can never itself be mistaken for a marker, so
 * the escape terminates and nests correctly. Neither reserved key occurs in
 * any real scorecard, entry or verdict; the escape exists so this codec is
 * TOTAL rather than merely adequate for today's shapes.
 *
 * Everything else is ordinary JSON, so a ledger line stays greppable and
 * every already-written finite-only file reads back byte-identically.
 */

const NUMBER_KEY = "$hades:number";
const ESCAPE_KEY = "$hades:escaped";
const RESERVED_KEYS: ReadonlySet<string> = new Set([NUMBER_KEY, ESCAPE_KEY]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The single own key of a plain object, or `undefined` if it does not have
 *  exactly one. Used only to detect the reserved-key collision. */
function soleOwnKey(v: Record<string, unknown>): string | undefined {
  const keys = Object.keys(v);
  return keys.length === 1 ? keys[0] : undefined;
}

function nonFiniteToken(n: number): "NaN" | "Infinity" | "-Infinity" | null {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  return null;
}

function tokenToNumber(tok: unknown): number | undefined {
  if (tok === "NaN") return Number.NaN;
  if (tok === "Infinity") return Number.POSITIVE_INFINITY;
  if (tok === "-Infinity") return Number.NEGATIVE_INFINITY;
  return undefined;
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === "number") {
    const tok = nonFiniteToken(value);
    return tok === null ? value : { [NUMBER_KEY]: tok };
  }
  if (isPlainObject(value)) {
    const only = soleOwnKey(value);
    // Genuine data shaped like one of our markers: escape it so decoding
    // cannot mistake it for one. The inner payload has two keys, so it is
    // never itself a marker — the escape terminates.
    if (only !== undefined && RESERVED_KEYS.has(only)) {
      return { [ESCAPE_KEY]: { key: only, value: value[only] } };
    }
  }
  return value;
}

function reviver(this: unknown, _key: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const only = soleOwnKey(value);
  if (only === NUMBER_KEY) {
    const n = tokenToNumber(value[NUMBER_KEY]);
    // An unrecognized token is left exactly as-is rather than guessed at —
    // a corrupt marker must surface as a shape/hash failure downstream, not
    // as a silently invented number.
    return n === undefined ? value : n;
  }
  if (only === ESCAPE_KEY) {
    const payload = value[ESCAPE_KEY];
    if (isPlainObject(payload) && typeof payload.key === "string" && "value" in payload) {
      return { [payload.key]: payload.value };
    }
    return value;
  }
  return value;
}

/**
 * Serialize one ledger record to a single JSONL line (no trailing newline).
 * Non-finite numbers survive verbatim, so the bytes on disk always decode
 * back to exactly the value that was hashed.
 */
export function encodeJsonLine(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/** Parse one JSONL line, restoring non-finite numbers. Throws on malformed
 *  JSON — callers that need the tolerant behavior use {@link tryDecodeJsonLine}. */
export function decodeJsonLine(text: string): unknown {
  return JSON.parse(text, reviver);
}

/** Tolerant parse used by both ledgers' readers: `undefined` on malformed
 *  JSON (a truncated final record is a normal crash shape, not corruption). */
export function tryDecodeJsonLine(text: string): unknown {
  try {
    return JSON.parse(text, reviver);
  } catch {
    return undefined;
  }
}
