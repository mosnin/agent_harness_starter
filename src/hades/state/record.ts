/**
 * Canonical, hashable workspace-record format shared by every surface that
 * touches durable Hades state (CLI, desktop, sidecar, TUI). This module is
 * pure: no I/O, no randomness, no ambient clock. Every timestamp a caller
 * needs is threaded in explicitly (`updatedAt`), so the exact same inputs
 * always produce the exact same `WorkspaceRecord` and the exact same hash,
 * on any machine, in any process.
 *
 * ## Causality
 *
 * Each record carries a `VersionVector` clock keyed by `ActorKey`
 * (`"<kind>:<id>"`, see {@link actorKey}). `tickClock` advances one actor's
 * own counter; `mergeClocks` takes the entrywise max of two clocks (the
 * standard vector-clock join); `compareClocks` derives the Lamport partial
 * order from that join: `"before"` / `"after"` when one clock's entries
 * dominate the other's, `"equal"` when they match exactly, `"concurrent"`
 * when neither dominates (each has an entry strictly greater than the
 * other's).
 *
 * ## Hashing
 *
 * `canonicalJson` is the single deterministic serialization every hash in
 * this module (and the durable store built on top of it) is computed from:
 * object keys sorted at every level, array order preserved, and a
 * deliberately narrow acceptance of "valid JSON" that throws
 * {@link CanonicalJsonError} on anything that would silently misround-trip
 * (`NaN`, `±Infinity`, `undefined`, `bigint`, `-0`, or a circular
 * reference) rather than let it degrade into `null`/`0`/a dropped key. Two
 * structurally identical values ALWAYS canonicalize to byte-identical
 * strings regardless of property insertion order.
 *
 * `recordHash` hashes a record's full identity (domain, key, rev, clock,
 * updatedAt, actor, deleted, value) via the real `sha256Hex` from
 * `../styx/certificate` — never a hand-rolled hash. A tombstone
 * (`deleted: true`) always hashes to the empty string `""`: a delete
 * carries no payload to authenticate, and giving every tombstone the same
 * sentinel hash makes "is this a delete" a trivial O(1) check anywhere a
 * hash is compared, instead of requiring every caller to also inspect
 * `deleted`.
 *
 * ## Merge semantics (`mergeRecords`)
 *
 * Two records for the same `domain`/`key` are reconciled with
 * `compareClocks`:
 *
 *  - One side's clock causally dominates ("before"/"after"): the dominating
 *    side wins outright, returned completely unchanged (same `rev`, same
 *    `clock`, same `hash` — no rewrite, because the dominating clock IS
 *    already `mergeClocks(local.clock, remote.clock)` by construction of
 *    vector-clock domination).
 *  - Equal clocks with byte-identical content: `"identical"`, the local
 *    record is returned unchanged.
 *  - Equal clocks with DIVERGENT content (should not happen between honest
 *    actors, since ticking the clock is mandatory before any mutation, but
 *    handled defensively rather than asserted away) and genuine
 *    `"concurrent"` clocks are both resolved with the same deterministic
 *    tie-break, in this exact priority order:
 *      1. A tombstone never silently loses to a stale live record it did
 *         not causally observe — whichever side has `deleted: true` wins
 *         outright over a `deleted: false` opponent.
 *      2. Higher `updatedAt` wins.
 *      3. Lexicographically greater `hash` wins.
 *      4. Lexicographically greater `actor` wins.
 *    Whenever this tie-break path is taken, a REWRITE is required: the
 *    winner's `clock` becomes `mergeClocks(local.clock, remote.clock)`
 *    (a genuinely new causal position neither side had recorded), so its
 *    `rev` is bumped to `max(local.rev, remote.rev) + 1` and its `hash` is
 *    recomputed over the new `(rev, clock)` pair — otherwise the returned
 *    record's own `hash` would no longer authenticate its own fields. This
 *    is the ONLY case that mints a new `rev`; every other branch returns
 *    one of the two inputs completely untouched.
 */

import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const WORKSPACE_STATE_VERSION = 1;

export type WorkspaceDomain = "sessions" | "skills" | "memory" | "config";

export const WORKSPACE_DOMAINS: readonly WorkspaceDomain[] = ["sessions", "skills", "memory", "config"];

const WORKSPACE_DOMAIN_SET: ReadonlySet<string> = new Set(WORKSPACE_DOMAINS);

export function isWorkspaceDomain(v: unknown): v is WorkspaceDomain {
  return typeof v === "string" && WORKSPACE_DOMAIN_SET.has(v);
}

// ---------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * Who authored a record.
 *
 * `"cli" | "desktop" | "sidecar" | "tui"` are the four real surfaces, and
 * `"test"` is a real (if synthetic) durable writer used by the suites.
 *
 * `"draft"` is different in kind and MUST NOT be treated as a peer of the
 * others: it marks an in-memory, not-yet-attributed placeholder — an
 * `InMemoryMirror` draft awaiting materialization under a real actor
 * (`../state/sync.ts`), or a synthetic full-snapshot resync batch a feed
 * synthesizes when the journal cannot answer a delta
 * (`../state/feed.ts`). Nothing bearing a `draft:` actor may ever reach
 * durable storage: `WorkspaceStore` refuses to be constructed with one and
 * rejects any `applyRemote` candidate carrying one (see
 * {@link isDraftActorKey}). It exists as its own kind precisely so those
 * placeholders can never collide with — or be mistaken for — a genuine
 * `test:`/`sidecar:` writer's records.
 */
export type ActorKind = "cli" | "desktop" | "sidecar" | "tui" | "test" | "draft";

const ACTOR_KINDS: readonly ActorKind[] = ["cli", "desktop", "sidecar", "tui", "test", "draft"];
const ACTOR_KIND_SET: ReadonlySet<string> = new Set(ACTOR_KINDS);

/** The non-durable placeholder actor kind. See {@link ActorKind}. */
export const DRAFT_ACTOR_KIND = "draft" as const;

export function isActorKind(v: unknown): v is ActorKind {
  return typeof v === "string" && ACTOR_KIND_SET.has(v);
}

/**
 * True for any actor key attributed to the non-durable {@link
 * DRAFT_ACTOR_KIND}. Parses through {@link parseActorKey} rather than
 * prefix-matching the raw string, so an id that merely *starts* with
 * `"draft"` (e.g. `"cli:draftsman"`) is never misclassified.
 */
export function isDraftActorKey(k: string): boolean {
  const parsed = parseActorKey(k);
  return parsed !== null && parsed.kind === DRAFT_ACTOR_KIND;
}

export interface ActorId {
  kind: ActorKind;
  id: string;
}

/** `${kind}:${id}` — the flat string form used as a VersionVector key. */
export type ActorKey = string;

export function actorKey(a: ActorId): ActorKey {
  return `${a.kind}:${a.id}`;
}

/**
 * Inverse of {@link actorKey}. Splits at the FIRST colon only, so an actor
 * id may itself contain colons (e.g. a UUID-like id). Returns `null` for
 * anything that isn't a non-empty string of the form `"<kind>:<id>"` with a
 * recognized `kind` and a non-empty `id` — never throws.
 */
export function parseActorKey(k: string): ActorId | null {
  if (typeof k !== "string" || k.length === 0) return null;
  const idx = k.indexOf(":");
  if (idx <= 0) return null;
  const kind = k.slice(0, idx);
  const id = k.slice(idx + 1);
  if (id.length === 0) return null;
  if (!isActorKind(kind)) return null;
  return { kind, id };
}

// ---------------------------------------------------------------------------
// Version vectors
// ---------------------------------------------------------------------------

export type VersionVector = Readonly<Record<ActorKey, number>>;

/** Returns a NEW clock with `k`'s counter advanced by one. Never mutates `c`. */
export function tickClock(c: VersionVector, k: ActorKey): VersionVector {
  const current = c[k] ?? 0;
  return Object.freeze({ ...c, [k]: current + 1 });
}

/** Entrywise max ("join") of two clocks. Never mutates either input. */
export function mergeClocks(a: VersionVector, b: VersionVector): VersionVector {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  }
  return Object.freeze(out);
}

export function compareClocks(a: VersionVector, b: VersionVector): "before" | "after" | "equal" | "concurrent" {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  let aHasGreater = false;
  let bHasGreater = false;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aHasGreater = true;
    else if (bv > av) bHasGreater = true;
  }
  if (!aHasGreater && !bHasGreater) return "equal";
  if (aHasGreater && !bHasGreater) return "after"; // a dominates b
  if (!aHasGreater && bHasGreater) return "before"; // b dominates a
  return "concurrent";
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at
 * every level, array order preserved. Throws {@link CanonicalJsonError}
 * rather than silently mis-serializing `NaN`, `±Infinity`, `undefined`,
 * `bigint`, `-0` (ambiguous with `0` under `JSON.stringify`), or a
 * circular reference.
 */
export function canonicalJson(v: JsonValue): string {
  return stringifyCanonical(v, new Set());
}

function stringifyCanonical(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (t === "number") {
    const n = v as number;
    if (Number.isNaN(n)) throw new CanonicalJsonError("canonicalJson: NaN is not a valid JsonValue");
    if (!Number.isFinite(n)) throw new CanonicalJsonError("canonicalJson: Infinity/-Infinity is not a valid JsonValue");
    if (Object.is(n, -0)) throw new CanonicalJsonError("canonicalJson: -0 is ambiguous with 0 and is not a valid JsonValue");
    return JSON.stringify(n);
  }
  if (t === "undefined") throw new CanonicalJsonError("canonicalJson: undefined is not a valid JsonValue");
  if (t === "bigint") throw new CanonicalJsonError("canonicalJson: bigint is not a valid JsonValue");
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new CanonicalJsonError("canonicalJson: circular reference in array");
    seen.add(v);
    const out = "[" + v.map((x) => stringifyCanonical(x, seen)).join(",") + "]";
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
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + stringifyCanonical(rec[k], seen)).join(",") +
      "}";
    seen.delete(obj);
    return out;
  }
  throw new CanonicalJsonError(`canonicalJson: unsupported value of type ${t}`);
}

// ---------------------------------------------------------------------------
// Workspace records
// ---------------------------------------------------------------------------

export interface WorkspaceRecord {
  domain: WorkspaceDomain;
  key: string;
  rev: number;
  clock: VersionVector;
  updatedAt: number;
  actor: ActorKey;
  deleted: boolean;
  hash: string;
  value: JsonValue | null;
}

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

const MAX_KEY_BYTES = 256;

/**
 * Throws {@link InvalidKeyError} for: an empty string, more than 256 UTF-8
 * bytes, any `/`, `\`, or NUL character, the literal `"."` or `".."`
 * (path-traversal footguns even though keys never become filesystem path
 * segments in this module), or any C0/DEL control character. Returns
 * (void) silently for every valid key.
 */
export function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidKeyError("workspace key must be a non-empty string");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new InvalidKeyError(`workspace key exceeds ${MAX_KEY_BYTES} bytes (utf-8)`);
  }
  if (key.includes("/") || key.includes("\\") || key.includes("\u0000")) {
    throw new InvalidKeyError('workspace key must not contain "/", "\\", or NUL');
  }
  if (key === "." || key === "..") {
    throw new InvalidKeyError('workspace key must not be "." or ".."');
  }
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new InvalidKeyError("workspace key must not contain control characters");
    }
  }
}

function toJsonClock(c: VersionVector): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(c)) out[k] = c[k];
  return out;
}

/**
 * Hashes a record's full identity via the real `sha256Hex`. A tombstone
 * (`deleted: true`) always hashes to `""` — see the module doc.
 */
export function recordHash(r: Omit<WorkspaceRecord, "hash">): string {
  if (r.deleted) return "";
  const body: { [k: string]: JsonValue } = {
    domain: r.domain,
    key: r.key,
    rev: r.rev,
    clock: toJsonClock(r.clock),
    updatedAt: r.updatedAt,
    actor: r.actor,
    deleted: r.deleted,
    value: r.value,
  };
  return sha256Hex(canonicalJson(body));
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isVersionVector(v: unknown): v is VersionVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const parsed = parseActorKey(k);
    if (!parsed || actorKey(parsed) !== k) return false;
    if (typeof val !== "number" || !Number.isInteger(val) || val < 0) return false;
  }
  return true;
}

function isStrictJsonValue(v: unknown, seen: Set<object> = new Set()): v is JsonValue {
  if (v === null) return true;
  const t = typeof v;
  if (t === "boolean" || t === "string") return true;
  if (t === "number") {
    const n = v as number;
    return Number.isFinite(n) && !Object.is(n, -0);
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) return false;
    seen.add(v);
    return v.every((x) => isStrictJsonValue(x, seen));
  }
  if (t === "object") {
    if (seen.has(v as object)) return false;
    seen.add(v as object);
    return Object.values(v as Record<string, unknown>).every((x) => isStrictJsonValue(x, seen));
  }
  return false;
}

/**
 * Full structural + range validation of an arbitrary value as a
 * {@link WorkspaceRecord}: correct `domain` enum member, a `key` that
 * passes {@link validateKey}, an integer `rev >= 1`, a well-formed
 * `VersionVector` clock (every key round-trips through
 * {@link parseActorKey}/{@link actorKey}, every value a non-negative
 * integer), a finite non-negative integer `updatedAt`, an `actor` that
 * round-trips the same way, a boolean `deleted`, a `hash` that is either
 * `""` (iff `deleted`) or 64 lowercase hex chars (iff not `deleted`), and a
 * `value` that is `null` (iff `deleted`) or a strict {@link JsonValue}
 * (iff not `deleted`) — strict in the same sense {@link canonicalJson}
 * enforces (no `NaN`/`±Infinity`/`-0`/cycles), so a record that passes
 * this guard is always safe to pass to {@link recordHash}.
 *
 * This does NOT recompute/verify the hash against the value — that is an
 * integrity check callers with access to the real fields perform
 * separately (e.g. `WorkspaceStore` does it when loading records off
 * disk or from a remote peer); this guard only checks *shape*.
 */
export function isWorkspaceRecord(v: unknown): v is WorkspaceRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;

  if (!isWorkspaceDomain(r.domain)) return false;

  if (typeof r.key !== "string") return false;
  try {
    validateKey(r.key);
  } catch {
    return false;
  }

  if (typeof r.rev !== "number" || !Number.isInteger(r.rev) || r.rev < 1) return false;

  if (!isVersionVector(r.clock)) return false;

  if (
    typeof r.updatedAt !== "number" ||
    !Number.isFinite(r.updatedAt) ||
    !Number.isInteger(r.updatedAt) ||
    r.updatedAt < 0
  ) {
    return false;
  }

  if (typeof r.actor !== "string") return false;
  const parsedActor = parseActorKey(r.actor);
  if (!parsedActor || actorKey(parsedActor) !== r.actor) return false;

  if (typeof r.deleted !== "boolean") return false;

  if (typeof r.hash !== "string") return false;
  if (r.deleted) {
    if (r.hash !== "") return false;
    if (r.value !== null) return false;
  } else {
    if (!SHA256_HEX_RE.test(r.hash)) return false;
    if (!isStrictJsonValue(r.value)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export type MergeReason = "local-newer" | "remote-newer" | "identical" | "concurrent-tiebreak";

function recordsContentEqual(a: WorkspaceRecord, b: WorkspaceRecord): boolean {
  if (a.deleted !== b.deleted) return false;
  if (a.rev !== b.rev || a.updatedAt !== b.updatedAt || a.actor !== b.actor) return false;
  if (a.deleted) return true; // tombstones carry no hash/value to compare further
  return a.hash === b.hash;
}

/**
 * Deterministically reconciles two records for the SAME `domain`/`key`.
 * See the module doc for the exact algorithm and the precise rule for
 * when `rev` is bumped. Throws `RangeError` if `local`/`remote` disagree
 * on `domain` or `key` — this function only ever resolves two views of
 * the SAME logical record.
 */
export function mergeRecords(
  local: WorkspaceRecord,
  remote: WorkspaceRecord,
): { winner: WorkspaceRecord; reason: MergeReason } {
  if (local.domain !== remote.domain || local.key !== remote.key) {
    throw new RangeError(
      `mergeRecords: local (${local.domain}/${local.key}) and remote (${remote.domain}/${remote.key}) do not reference the same record`,
    );
  }

  const cmp = compareClocks(local.clock, remote.clock);

  if (cmp === "after") {
    return { winner: local, reason: "local-newer" };
  }
  if (cmp === "before") {
    return { winner: remote, reason: "remote-newer" };
  }
  if (cmp === "equal" && recordsContentEqual(local, remote)) {
    return { winner: local, reason: "identical" };
  }

  // Genuine concurrency, or equal clocks with divergent content (defensive
  // — should not happen between honest actors). Both resolved with the
  // same deterministic tie-break; see the module doc for the priority
  // order. Tombstones never silently lose to a stale live record.
  let content: WorkspaceRecord;
  if (local.deleted !== remote.deleted) {
    content = local.deleted ? local : remote;
  } else if (local.updatedAt !== remote.updatedAt) {
    content = local.updatedAt > remote.updatedAt ? local : remote;
  } else if (local.hash !== remote.hash) {
    content = local.hash > remote.hash ? local : remote;
  } else if (local.actor !== remote.actor) {
    content = local.actor > remote.actor ? local : remote;
  } else {
    content = local;
  }

  const mergedClock = mergeClocks(local.clock, remote.clock);
  const maxRev = Math.max(local.rev, remote.rev);

  const rewritten: Omit<WorkspaceRecord, "hash"> = {
    domain: content.domain,
    key: content.key,
    rev: maxRev + 1,
    clock: mergedClock,
    updatedAt: content.updatedAt,
    actor: content.actor,
    deleted: content.deleted,
    value: content.value,
  };
  return { winner: { ...rewritten, hash: recordHash(rewritten) }, reason: "concurrent-tiebreak" };
}
