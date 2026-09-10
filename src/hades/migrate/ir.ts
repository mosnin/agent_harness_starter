/**
 * The canonical migration intermediate representation (IR).
 *
 * Every "import from Hermes/OpenClaw" module in `src/hades/migrate/**`
 * speaks this shape and only this shape: whatever a vendor-specific reader
 * (`discovery.ts` finds the source, a sibling importer reads its bytes)
 * pulls off disk gets normalized into a flat list of {@link MigrationItem}s
 * inside a {@link MigrationBundle} before anything downstream (dedup,
 * conflict resolution, the actual write-into-Hades step) ever looks at it.
 *
 * Three invariants this module exists to enforce structurally, not by
 * convention:
 *
 *  1. **Content-addressing.** Every item's `hash` is `itemHash(kind, key,
 *     value)` -- a real sha256 (via `../styx/certificate`'s `sha256Hex`) over
 *     a canonical JSON encoding of `{kind, key, value}`. Two items with
 *     identical (kind, key, value) always hash identically regardless of
 *     which vendor, which file, or which process produced them. This is
 *     what makes `mergeBundles` able to detect "same logical fact, read
 *     twice" vs. "same key, conflicting values" without re-reading any file.
 *  2. **A closed key grammar.** `ITEM_KEY_SCHEMES` documents, and
 *     `validateBundle` enforces, that every item's `key` is prefixed by a
 *     fixed, kind-specific namespace (`memory:<hash16>`, `session:<id>`,
 *     `config:<dotted.path>`, ...). This is what lets `mergeBundles` compare
 *     keys across vendors/layouts as if they were a single flat namespace.
 *  3. **Secrets are descriptors, never material.** A `"secret"` item's
 *     `value` is allowed to say "there is a secret named OPENAI_API_KEY and
 *     here is where it lives" -- it is never allowed to carry anything that
 *     looks like the key itself. `validateBundle` runs a real (if
 *     necessarily heuristic) key-material detector over every secret value
 *     and refuses the whole bundle if it trips.
 *
 * `JsonValue` is imported type-only from `../state/record` (the shared,
 * already-hardened definition) rather than redeclared here, but
 * `canonicalJson` below is this module's own implementation -- the locked
 * contract for this build requires `ir.ts` to export it directly rather
 * than re-export `../state/record`'s.
 */

import type { JsonValue } from "../state/record";
import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Locked contract types
// ---------------------------------------------------------------------------

export type MigrateVendor = "hermes" | "openclaw";

export type ArtifactKind =
  | "config"
  | "model"
  | "memory"
  | "context-file"
  | "session"
  | "skill"
  | "secret"
  | "tool-state"
  | "unknown";

export interface MigrationItem {
  kind: ArtifactKind;
  key: string;
  value: JsonValue;
  origin: { path: string; locator?: string };
  hash: string;
  confidence: number;
  notes?: string[];
}

export interface MigrationBundle {
  vendor: MigrateVendor;
  layout: string;
  root: string;
  version?: string;
  items: MigrationItem[];
  unimportable: Array<{ path: string; kind: ArtifactKind; reason: string }>;
  readErrors: Array<{ path: string; reason: string }>;
  stats: { filesScanned: number; bytesRead: number; truncated: boolean };
}

// ---------------------------------------------------------------------------
// canonicalJson / itemHash
// ---------------------------------------------------------------------------

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Depth limit for {@link canonicalJson}: guards against both accidental deep
 * nesting and adversarially-crafted input trying to blow the (recursive)
 * stack. 64 nested containers is far beyond anything a real config/memory
 * fact/session record legitimately needs.
 */
export const CANONICAL_JSON_MAX_DEPTH = 64;

/**
 * Output-size limit for {@link canonicalJson}, in UTF-16 code units of the
 * produced string (a conservative proxy for bytes). 8 MiB is generous for a
 * single migration item's value while still bounding worst-case memory use
 * when hashing untrusted vendor data.
 */
export const CANONICAL_JSON_MAX_LENGTH = 8 * 1024 * 1024;

/**
 * Deterministic JSON serialization of a {@link JsonValue}: object keys
 * sorted lexicographically at every level (so insertion order never
 * affects the result), array element order preserved (order is meaningful
 * for arrays). Total over the declared type in the sense that every
 * well-formed `JsonValue` serializes without throwing, EXCEPT the
 * documented refusals below -- all of which indicate the input was not
 * actually a valid `JsonValue` (a `-0`, `NaN`, `bigint`, `undefined`, a
 * cyclic object) or exceeded the documented depth/size limits.
 *
 * Throws {@link CanonicalJsonError} for: `NaN`, `±Infinity`, `-0`
 * (ambiguous with `0` under `JSON.stringify`), `undefined`, `bigint`, a
 * circular reference, nesting deeper than {@link CANONICAL_JSON_MAX_DEPTH},
 * or output longer than {@link CANONICAL_JSON_MAX_LENGTH}.
 */
export function canonicalJson(v: JsonValue): string {
  const out = stringifyCanonical(v, new Set<object>(), 0);
  if (out.length > CANONICAL_JSON_MAX_LENGTH) {
    throw new CanonicalJsonError(
      `canonicalJson: output length ${out.length} exceeds the ${CANONICAL_JSON_MAX_LENGTH}-character limit`,
    );
  }
  return out;
}

function stringifyCanonical(v: unknown, seen: Set<object>, depth: number): string {
  if (depth > CANONICAL_JSON_MAX_DEPTH) {
    throw new CanonicalJsonError(`canonicalJson: nesting exceeds max depth ${CANONICAL_JSON_MAX_DEPTH}`);
  }
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (t === "number") {
    const n = v as number;
    if (Number.isNaN(n)) throw new CanonicalJsonError("canonicalJson: NaN is not a valid JsonValue");
    if (!Number.isFinite(n)) {
      throw new CanonicalJsonError("canonicalJson: Infinity/-Infinity is not a valid JsonValue");
    }
    if (Object.is(n, -0)) {
      throw new CanonicalJsonError("canonicalJson: -0 is ambiguous with 0 and is not a valid JsonValue");
    }
    return JSON.stringify(n);
  }
  if (t === "undefined") throw new CanonicalJsonError("canonicalJson: undefined is not a valid JsonValue");
  if (t === "bigint") throw new CanonicalJsonError("canonicalJson: bigint is not a valid JsonValue");
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new CanonicalJsonError("canonicalJson: circular reference in array");
    seen.add(v);
    const out = "[" + v.map((x) => stringifyCanonical(x, seen, depth + 1)).join(",") + "]";
    seen.delete(v);
    return out;
  }
  if (t === "object") {
    const obj = v as object;
    if (seen.has(obj)) throw new CanonicalJsonError("canonicalJson: circular reference in object");
    seen.add(obj);
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const out =
      "{" + keys.map((k) => JSON.stringify(k) + ":" + stringifyCanonical(rec[k], seen, depth + 1)).join(",") + "}";
    seen.delete(obj);
    return out;
  }
  throw new CanonicalJsonError(`canonicalJson: unsupported value of type ${t}`);
}

/**
 * Real sha256 (via `../styx/certificate`'s `sha256Hex`, itself a thin
 * `node:crypto` wrapper) of the canonical encoding of `{kind, key, value}`.
 * Stable across key insertion order (canonicalJson sorts object keys) and
 * across process runs (no randomness, no clock, no environment involved).
 */
export function itemHash(kind: ArtifactKind, key: string, value: JsonValue): string {
  const payload: JsonValue = { kind, key, value };
  return sha256Hex(canonicalJson(payload));
}

/** Build a {@link MigrationItem}, computing its `hash` from the other fields. */
export function makeItem(input: Omit<MigrationItem, "hash">): MigrationItem {
  return { ...input, hash: itemHash(input.kind, input.key, input.value) };
}

// ---------------------------------------------------------------------------
// Key grammar
// ---------------------------------------------------------------------------

/**
 * The canonical key grammar, one entry per {@link ArtifactKind}, documented
 * as human-readable patterns. `validateBundle` enforces the corresponding
 * regular expressions in {@link KEY_GRAMMAR} below; keep the two in sync.
 */
export const ITEM_KEY_SCHEMES: Readonly<Record<ArtifactKind, string>> = Object.freeze({
  config: "config:<dotted.path>",
  model: "model:selection",
  memory: "memory:<sha256(fact)[0..15]>",
  "context-file": "context:<relPath>",
  session: "session:<sourceId>",
  skill: "skill:<name>",
  secret: "secret:<ENV_VAR>",
  "tool-state": "tool-state:<toolId>",
  unknown: "unknown:<opaque>",
});

/**
 * Enforced regular expressions behind {@link ITEM_KEY_SCHEMES}. `model` is
 * documented as the single literal key `model:selection` but the grammar
 * here is intentionally a hair wider (`model:<slug>`) so a future item like
 * `model:embedding-selection` remains valid without a contract change;
 * `model:selection` itself is always the canonical primary-selection key.
 */
const KEY_GRAMMAR: Readonly<Record<ArtifactKind, RegExp>> = Object.freeze({
  config: /^config:[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)*$/,
  model: /^model:[A-Za-z][A-Za-z0-9_-]*$/,
  memory: /^memory:[0-9a-f]{16}$/,
  "context-file": /^context:\S+$/,
  session: /^session:\S+$/,
  skill: /^skill:[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  secret: /^secret:[A-Z][A-Z0-9_]*$/,
  "tool-state": /^tool-state:[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
  unknown: /^unknown:\S+$/,
});

const ALL_KINDS: readonly ArtifactKind[] = Object.freeze([
  "config",
  "model",
  "memory",
  "context-file",
  "session",
  "skill",
  "secret",
  "tool-state",
  "unknown",
]);

// ---------------------------------------------------------------------------
// Secret-material heuristics
// ---------------------------------------------------------------------------

/**
 * Patterns that flag a string as plausible KEY MATERIAL rather than a
 * descriptor. This is deliberately conservative (biased toward
 * false-positives over false-negatives): a `"secret"` item's `value` should
 * only ever carry metadata (which env var, whether it's present, where it
 * was found, a redacted preview like `"sk-...ab12"`), never the material
 * itself, so tripping this heuristic on an innocuous-looking-but-long
 * opaque string is the safe failure mode.
 *
 * Covers: PEM key blocks, common vendor-prefixed API key formats
 * (OpenAI-style `sk-...`, Anthropic-style `sk-ant-...`, AWS access key ids,
 * GitHub PATs, Slack tokens, Google API keys), JWT-shaped strings, and
 * generic high-entropy base64/hex blobs long enough to plausibly be a raw
 * secret (as opposed to a short opaque id).
 */
const KEY_MATERIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT-shaped
  /\b[0-9a-fA-F]{32,}\b/, // long hex blob
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 blob
]);

/** True if `s` contains anything that looks like raw key material. */
function stringLooksLikeKeyMaterial(s: string): boolean {
  return KEY_MATERIAL_PATTERNS.some((re) => re.test(s));
}

/** Recursively scan a JsonValue tree's strings for key-material patterns. */
function containsKeyMaterial(v: JsonValue, seen: Set<object> = new Set()): boolean {
  if (typeof v === "string") return stringLooksLikeKeyMaterial(v);
  if (v === null || typeof v !== "object") return false;
  if (seen.has(v)) return false; // canonicalJson already rejects real cycles; stay defensive here too
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => containsKeyMaterial(x, seen));
  return Object.values(v).some((x) => containsKeyMaterial(x, seen));
}

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

const VALID_VENDORS: ReadonlySet<string> = new Set<MigrateVendor>(["hermes", "openclaw"]);

/**
 * Validates every structural invariant a {@link MigrationBundle} must hold
 * before anything downstream trusts it: vendor/layout/root well-formedness,
 * per-item hash correctness (`itemHash` recomputed and compared, not
 * trusted), key-grammar conformance, confidence range, duplicate keys, and
 * secret-material leakage. Returns every violation found rather than
 * failing fast on the first one, so a caller can report (or fix) them all
 * at once.
 */
export function validateBundle(b: MigrationBundle): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!VALID_VENDORS.has(b.vendor)) errors.push(`invalid vendor: ${JSON.stringify(b.vendor)}`);
  if (typeof b.layout !== "string" || b.layout.length === 0) errors.push("layout must be a non-empty string");
  if (typeof b.root !== "string" || b.root.length === 0) errors.push("root must be a non-empty string");
  if (b.version !== undefined && (typeof b.version !== "string" || b.version.length === 0)) {
    errors.push("version, if present, must be a non-empty string");
  }

  if (!Array.isArray(b.items)) {
    errors.push("items must be an array");
  } else {
    const seenKeys = new Map<string, number>(); // "kind\u0000key" -> first index
    b.items.forEach((item, i) => {
      const where = `items[${i}] (kind=${JSON.stringify(item?.kind)}, key=${JSON.stringify(item?.key)})`;

      if (!ALL_KINDS.includes(item.kind)) {
        errors.push(`${where}: invalid kind`);
        return; // grammar checks below are meaningless without a valid kind
      }
      if (typeof item.key !== "string" || item.key.length === 0) {
        errors.push(`${where}: key must be a non-empty string`);
      } else {
        const grammar = KEY_GRAMMAR[item.kind];
        if (!grammar.test(item.key)) {
          errors.push(
            `${where}: key does not match the required grammar for kind "${item.kind}" (expected shape "${ITEM_KEY_SCHEMES[item.kind]}")`,
          );
        }
        if (item.kind === "context-file" && /(^|\/)\.\.(\/|$)/.test(item.key)) {
          errors.push(`${where}: context-file key contains a ".." path-traversal segment`);
        }
        const dedupeKey = `${item.kind}\u0000${item.key}`;
        const firstIndex = seenKeys.get(dedupeKey);
        if (firstIndex === undefined) {
          seenKeys.set(dedupeKey, i);
        } else {
          errors.push(`${where}: duplicate item key, already used at items[${firstIndex}]`);
        }
      }

      if (typeof item.confidence !== "number" || Number.isNaN(item.confidence)) {
        errors.push(`${where}: confidence must be a number`);
      } else if (item.confidence < 0 || item.confidence > 1) {
        errors.push(`${where}: confidence ${item.confidence} is out of range [0,1]`);
      }

      if (!item.origin || typeof item.origin.path !== "string" || item.origin.path.length === 0) {
        errors.push(`${where}: origin.path must be a non-empty string`);
      }

      let recomputedHash: string | undefined;
      try {
        recomputedHash = itemHash(item.kind, item.key, item.value);
      } catch (err) {
        errors.push(`${where}: value is not a valid JsonValue (${(err as Error).message})`);
      }
      if (recomputedHash !== undefined && item.hash !== recomputedHash) {
        errors.push(`${where}: hash mismatch (stored "${item.hash}", recomputed "${recomputedHash}")`);
      }

      if (item.kind === "secret" && containsKeyMaterial(item.value)) {
        errors.push(
          `${where}: secret item value appears to contain raw key material -- "secret" items must carry descriptors only (env var name, presence, redacted preview), never the key itself`,
        );
      }
    });
  }

  if (!Array.isArray(b.unimportable)) {
    errors.push("unimportable must be an array");
  } else {
    b.unimportable.forEach((u, i) => {
      if (typeof u.path !== "string" || u.path.length === 0) errors.push(`unimportable[${i}].path must be non-empty`);
      if (!ALL_KINDS.includes(u.kind)) errors.push(`unimportable[${i}].kind is invalid`);
      if (typeof u.reason !== "string" || u.reason.length === 0) {
        errors.push(`unimportable[${i}].reason must be non-empty`);
      }
    });
  }

  if (!Array.isArray(b.readErrors)) {
    errors.push("readErrors must be an array");
  } else {
    b.readErrors.forEach((e, i) => {
      if (typeof e.path !== "string" || e.path.length === 0) errors.push(`readErrors[${i}].path must be non-empty`);
      if (typeof e.reason !== "string" || e.reason.length === 0) {
        errors.push(`readErrors[${i}].reason must be non-empty`);
      }
    });
  }

  if (!b.stats || typeof b.stats !== "object") {
    errors.push("stats must be present");
  } else {
    if (!Number.isFinite(b.stats.filesScanned) || b.stats.filesScanned < 0) {
      errors.push("stats.filesScanned must be a non-negative finite number");
    }
    if (!Number.isFinite(b.stats.bytesRead) || b.stats.bytesRead < 0) {
      errors.push("stats.bytesRead must be a non-negative finite number");
    }
    if (typeof b.stats.truncated !== "boolean") errors.push("stats.truncated must be a boolean");
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// mergeBundles
// ---------------------------------------------------------------------------

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUniqueStrings(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort(cmpStr);
}

/**
 * Merge N bundles into one. Designed to be genuinely order-independent
 * (`mergeBundles([a, b])` deep-equals `mergeBundles([b, a])`) rather than
 * "usually similar":
 *
 *  - The result's `vendor`/`layout`/`root`/`version` are taken from whichever
 *    input bundle sorts first under `(vendor, layout, root, version ?? "")`
 *    lexicographic order -- a deterministic choice that never depends on
 *    array position, so it is stable regardless of how the caller ordered
 *    `bundles`. (In the common case all inputs share the same
 *    vendor/layout/root -- e.g. bundles built from the same discovered
 *    source in separate passes -- this is simply that shared value.)
 *  - `items` are unioned by `(kind, key)`. Two items sharing a `(kind, key)`
 *    with an IDENTICAL hash are the same fact observed twice and collapse to
 *    one entry (their `notes` and `origin` are combined, not dropped).
 *    Two items sharing a `(kind, key)` with DIFFERENT hashes are a genuine
 *    collision: the one with higher `confidence` wins the `items` slot
 *    (ties broken by the lexicographically smaller `origin.path`, then by
 *    hash, for full determinism), and every losing occurrence is recorded
 *    in `unimportable` with `reason` explaining the collision -- never
 *    silently dropped.
 *  - `unimportable` and `readErrors` are unioned and de-duplicated
 *    (identical entries collapse), then sorted for a stable order.
 *  - `stats` fields are summed (`filesScanned`, `bytesRead`) or OR'd
 *    (`truncated`) across inputs -- both commutative, so naturally
 *    order-independent.
 *
 * Throws `RangeError` if `bundles` is empty -- there is no sensible single
 * `MigrationBundle` to represent "the merge of nothing".
 */
export function mergeBundles(bundles: MigrationBundle[]): MigrationBundle {
  if (bundles.length === 0) {
    throw new RangeError("mergeBundles: cannot merge an empty array of bundles");
  }

  const primary = [...bundles].sort((a, b) => {
    return (
      cmpStr(a.vendor, b.vendor) ||
      cmpStr(a.layout, b.layout) ||
      cmpStr(a.root, b.root) ||
      cmpStr(a.version ?? "", b.version ?? "")
    );
  })[0];

  type Occurrence = { item: MigrationItem; bundleIndex: number };
  const byKey = new Map<string, Occurrence[]>();
  for (let bi = 0; bi < bundles.length; bi++) {
    for (const item of bundles[bi].items) {
      const k = `${item.kind}\u0000${item.key}`;
      const arr = byKey.get(k);
      if (arr) arr.push({ item, bundleIndex: bi });
      else byKey.set(k, [{ item, bundleIndex: bi }]);
    }
  }

  const mergedItems: MigrationItem[] = [];
  const collisionUnimportable: Array<{ path: string; kind: ArtifactKind; reason: string }> = [];

  const sortedGroupKeys = Array.from(byKey.keys()).sort(cmpStr);
  for (const groupKey of sortedGroupKeys) {
    const occurrences = byKey.get(groupKey)!;
    const distinctHashes = sortedUniqueStrings(occurrences.map((o) => o.item.hash));

    if (distinctHashes.length === 1) {
      // Same fact observed possibly-many times: collapse, union notes.
      const sorted = [...occurrences].sort((a, b) => cmpStr(a.item.origin.path, b.item.origin.path));
      const base = sorted[0].item;
      const notes = sortedUniqueStrings(sorted.flatMap((o) => o.item.notes ?? []));
      mergedItems.push({
        ...base,
        confidence: Math.max(...sorted.map((o) => o.item.confidence)),
        notes: notes.length ? notes : undefined,
      });
      continue;
    }

    // Genuine collision: same (kind,key), conflicting values/hashes.
    const ranked = [...occurrences].sort((a, b) => {
      return (
        b.item.confidence - a.item.confidence ||
        cmpStr(a.item.origin.path, b.item.origin.path) ||
        cmpStr(a.item.hash, b.item.hash)
      );
    });
    const winner = ranked[0].item;
    mergedItems.push(winner);
    for (const loser of ranked.slice(1)) {
      collisionUnimportable.push({
        path: loser.item.origin.path,
        kind: loser.item.kind,
        reason: `merge collision: kind "${loser.item.kind}" key "${loser.item.key}" has conflicting values across sources (hash ${loser.item.hash} lost to ${winner.hash} from ${winner.origin.path})`,
      });
    }
  }

  const allUnimportable = [
    ...bundles.flatMap((b) => b.unimportable),
    ...collisionUnimportable,
  ];
  const dedupedUnimportable = dedupeBy(allUnimportable, (u) => `${u.path}\u0000${u.kind}\u0000${u.reason}`).sort(
    (a, b) => cmpStr(a.path, b.path) || cmpStr(a.kind, b.kind) || cmpStr(a.reason, b.reason),
  );

  const allReadErrors = bundles.flatMap((b) => b.readErrors);
  const dedupedReadErrors = dedupeBy(allReadErrors, (e) => `${e.path}\u0000${e.reason}`).sort(
    (a, b) => cmpStr(a.path, b.path) || cmpStr(a.reason, b.reason),
  );

  const stats = bundles.reduce(
    (acc, b) => ({
      filesScanned: acc.filesScanned + b.stats.filesScanned,
      bytesRead: acc.bytesRead + b.stats.bytesRead,
      truncated: acc.truncated || b.stats.truncated,
    }),
    { filesScanned: 0, bytesRead: 0, truncated: false },
  );

  mergedItems.sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(a.key, b.key));

  return {
    vendor: primary.vendor,
    layout: primary.layout,
    root: primary.root,
    version: primary.version,
    items: mergedItems,
    unimportable: dedupedUnimportable,
    readErrors: dedupedReadErrors,
    stats,
  };
}

function dedupeBy<T>(xs: T[], keyOf: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = keyOf(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}
