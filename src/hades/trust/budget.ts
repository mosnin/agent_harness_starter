/**
 * The global trust budget: a durable, hash-chained, tamper-evident ledger of
 * every unit of residual risk (`P(wrong)`) the agent has ever spent by
 * emitting a certified output.
 *
 * ## Why this exists
 *
 * `../styx/gate.ts` / `./unified-gate.ts` already refuse to *emit* anything
 * the calibrated evidence does not support. That is a claim about a single
 * decision. This module turns "the agent has been admitting risky outputs"
 * into a claim that survives afterward and cannot be quietly understated:
 * every admission spends `risk = 1 - P(correct)` from a capped budget, and
 * every spend is appended to an append-only, hash-chained record so that,
 * independently and later, anyone can recompute the chain from the
 * persisted bytes and detect any edit, deletion, reorder, or forged tail
 * record. A tampered ledger never silently resets to a fresh, "safe-looking"
 * empty budget — it refuses to authorize any further spending until the
 * discrepancy is resolved by an operator. Silently starting over is exactly
 * the failure mode a trust-budget ledger exists to prevent: it would let an
 * agent that has already exhausted its risk mass simply erase the evidence
 * and keep spending.
 *
 * `TrustBudgetLedger.quote`/`.spend` are structurally identical to
 * `./unified-gate.ts`'s `TrustBudgetPort` (same request/response shapes) so
 * this class satisfies that port by structural typing alone — this module
 * deliberately never imports `./unified-gate` (dependency inversion: the
 * gate depends on the port, the port does not depend on any one ledger).
 *
 * ## Hash chain (locked mechanics)
 *
 * `TRUST_BUDGET_GENESIS` is `sha256Hex("hades.trust.budget.v1")`, computed
 * once via the REAL `sha256Hex` from `../styx/certificate` (never
 * reimplemented here — one hash implementation for the whole codebase, the
 * same discipline `../schedule/receipt-ledger.ts` and `../browser/trace.ts`
 * follow). The chain root — `prevSha256` of the very first entry
 * (`seq === 0`) — is `TRUST_BUDGET_GENESIS`.
 *
 * Every entry's `entrySha256` is `sha256Hex(canonical)`, where `canonical`
 * is a fixed-field-order serialization of every `TrustBudgetEntry` field
 * EXCEPT `entrySha256` itself, in the LOCKED order:
 *
 * ```
 * seq, domain, taskId, risk, subjectSha256, issuedAt, prevSha256
 * ```
 *
 * `seq` is dense and strictly monotonic from `0` for the FULL lifetime of
 * the ledger — a window roll (see below) never resets it and never removes
 * an entry, so the chain stays one continuous, independently verifiable
 * sequence across every roll. Any deviation — a stored hash that does not
 * recompute, a `prevSha256` that does not match the entry immediately
 * before it, a `seq` that skips or repeats, a deleted/reordered/forged
 * entry, a truncated/half-written file — is caught by
 * {@link TrustBudgetLedger.verifyChain}, which recomputes every hash from
 * scratch rather than trusting any stored value, and is reported through
 * exactly the LOCKED `ChainVerification` shape.
 *
 * ## Refuse-to-spend on tamper (locked behavior — the whole point)
 *
 * `TrustBudgetLedger.open` re-verifies the ENTIRE on-disk chain before
 * trusting it. A missing file is just an empty, fresh ledger. A file that
 * fails to parse, has the wrong envelope shape, or whose chain does not
 * independently re-verify is NEVER silently discarded and NEVER silently
 * accepted: the ledger loads whatever it can recover (for forensics, via
 * `entries()`) but `quote()` and `spend()` unconditionally refuse from that
 * point on, and `report()` fails safe by reporting the budget as fully
 * spent / exhausted rather than trusting numbers that may have been edited
 * to look safer than they are. The only way out is an operator fixing or
 * replacing the file with something that re-verifies clean.
 *
 * ## Windows (locked semantics)
 *
 * `{ kind: "session" }` never rolls: `windowStartedAt` is fixed at the
 * moment the ledger is first created (or, on reopen, at whatever was last
 * persisted) and every entry ever appended counts toward the budget.
 *
 * `{ kind: "fixed-ms", ms }` rolls automatically, checked on every
 * `quote`/`spend`/`report` call against the injected clock: whenever
 * `now() - windowStartedAt >= ms`, `windowStartedAt` advances to the start
 * of the window the clock is actually in — `floor(elapsed / ms) * ms` in one
 * O(1) step, so a clock that jumps forward by a year over a 1 ms window
 * catches up instantly instead of iterating.
 * Rolling ONLY advances the accounting boundary — it never removes,
 * renumbers, or rewrites a single chain entry. Entries from a prior window
 * remain in the chain (and remain visible via `entries()`) but stop
 * counting toward the CURRENT window's `spentRisk`, because that figure is
 * computed as `sum(risk for entries with issuedAt >= windowStartedAt)`.
 * `rollWindow(at)` is the same operation invoked explicitly with a caller
 * chosen timestamp (a no-op on a `session` ledger).
 *
 * ## Multi-process safety (locked)
 *
 * When `path` is set, every read (`quote`, `spend`, `report`, `entries`)
 * re-reads and re-verifies the file from disk FIRST, replacing in-memory
 * state with whatever is durably there before computing anything. `spend`
 * therefore always appends onto the freshest tail any process has written,
 * so two ledger instances over the same path, invoked in an interleaved
 * sequence, never lose an entry or fork the chain.
 *
 * ## Idempotency (locked)
 *
 * `spend` is keyed on `(taskId, subjectSha256)`. A repeat spend for a pair
 * already present in the chain (verified chain only — see above) returns
 * `accepted: true` with the ORIGINAL entry's hash and does not charge the
 * budget again, however many times it is retried.
 *
 * ## Persistence (locked)
 *
 * Atomic write-to-temp + `renameSync` replace, a fixed `.tmp` sibling per
 * path (mirrors `../schedule/receipt-ledger.ts` / `../schedule/store.ts`).
 * The on-disk envelope is the versioned shape
 * `{ version: 1, genesis, windowStartedAt, entries }`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface TrustBudgetConfig {
  /** > 0, finite — total risk mass spendable per window. */
  totalRisk: number;
  window: { kind: "session" } | { kind: "fixed-ms"; ms: number };
  /** domain -> cap; sum may exceed totalRisk (the global cap still binds). */
  perDomainCaps?: Record<string, number>;
  /** Durable JSON path; in-memory when omitted. */
  path?: string;
  /** Injected clock; no ambient Date.now() inside this module. */
  now: () => number;
}

export interface TrustBudgetEntry {
  seq: number;
  domain: string;
  taskId: string;
  risk: number;
  subjectSha256: string;
  issuedAt: number;
  prevSha256: string;
  entrySha256: string;
}

export interface TrustBudgetReport {
  totalRisk: number;
  spentRisk: number;
  remainingRisk: number;
  exhausted: boolean;
  windowStartedAt: number;
  windowKind: string;
  entries: number;
  chainRoot: string;
  chainHead: string;
  perDomain: Record<string, { cap: number | null; spent: number; remaining: number | null; admissions: number }>;
}

export interface ChainVerification {
  ok: boolean;
  length: number;
  firstBadSeq?: number;
  reason?: "hash_mismatch" | "chain_break" | "seq_gap" | "malformed";
}

/** Fixed literal the chain root is derived from — see the module doc. */
export const TRUST_BUDGET_GENESIS: string = sha256Hex("hades.trust.budget.v1");

// ===========================================================================
// Small pure helpers
// ===========================================================================

/**
 * Float-comparison tolerance used everywhere a spend is checked against a
 * remaining budget or a window's numbers are checked for exact accounting.
 * `spentRisk + remainingRisk === totalRisk` is expected to hold within this
 * epsilon (it holds exactly, modulo IEEE-754 summation error, since
 * `remainingRisk` is always derived as `totalRisk - spentRisk`).
 */
const FLOAT_EPS = 1e-9;

const REASON_EXHAUSTED_GLOBAL = "trust budget exhausted";
const REASON_INVALID_RISK_PREFIX = "invalid risk: must be a finite number > 0, got ";
const REASON_CHAIN_INVALID_PREFIX =
  "trust budget ledger failed chain verification; refusing further spends until resolved: ";

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateRisk(risk: unknown): string | null {
  if (typeof risk !== "number" || Number.isNaN(risk) || !Number.isFinite(risk) || risk <= 0) {
    return REASON_INVALID_RISK_PREFIX + String(risk);
  }
  return null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * The LOCKED canonical serialization of every `TrustBudgetEntry` field
 * except `entrySha256`, in the fixed order documented at the top of this
 * file. Throws if `seq`/`risk`/`issuedAt` is not finite — a non-finite
 * value here would silently canonicalize via `JSON.stringify` (e.g.
 * `NaN` -> `"null"`) and corrupt the hash's meaning without any visible
 * error, which is exactly the silent-corruption class this module exists
 * to make impossible.
 */
function canonicalizeEntryFields(e: Omit<TrustBudgetEntry, "entrySha256">): string {
  if (!Number.isInteger(e.seq) || e.seq < 0) {
    throw new TypeError(`canonicalizeEntryFields: seq must be a non-negative integer, got ${String(e.seq)}`);
  }
  if (!Number.isFinite(e.risk)) {
    throw new TypeError(`canonicalizeEntryFields: risk must be a finite number, got ${String(e.risk)}`);
  }
  if (!Number.isFinite(e.issuedAt)) {
    throw new TypeError(`canonicalizeEntryFields: issuedAt must be a finite number, got ${String(e.issuedAt)}`);
  }
  const parts: string[] = [
    '"seq":' + JSON.stringify(e.seq),
    '"domain":' + JSON.stringify(e.domain),
    '"taskId":' + JSON.stringify(e.taskId),
    '"risk":' + JSON.stringify(e.risk),
    '"subjectSha256":' + JSON.stringify(e.subjectSha256),
    '"issuedAt":' + JSON.stringify(e.issuedAt),
    '"prevSha256":' + JSON.stringify(e.prevSha256),
  ];
  return "{" + parts.join(",") + "}";
}

function computeEntryHash(e: Omit<TrustBudgetEntry, "entrySha256">): string {
  return sha256Hex(canonicalizeEntryFields(e));
}

/**
 * Loose type/shape check for an entry loaded off disk (or otherwise
 * untrusted). Deliberately does NOT check `risk > 0` — a hand-edited risk
 * value that has been flipped to something implausible (including <= 0)
 * still has the right TYPE, so it is caught by the more informative
 * `hash_mismatch` path in {@link verifyEntries} instead of being collapsed
 * into a generic `malformed`.
 */
function isValidEntryShape(v: unknown): v is TrustBudgetEntry {
  if (!isPlainRecord(v)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.domain !== "string" || v.domain.length === 0) return false;
  if (typeof v.taskId !== "string" || v.taskId.length === 0) return false;
  if (typeof v.risk !== "number" || !Number.isFinite(v.risk)) return false;
  if (typeof v.subjectSha256 !== "string" || v.subjectSha256.length === 0) return false;
  if (typeof v.issuedAt !== "number" || !Number.isFinite(v.issuedAt)) return false;
  if (typeof v.prevSha256 !== "string") return false;
  if (typeof v.entrySha256 !== "string") return false;
  return true;
}

/**
 * Pure re-verification of a candidate entry array (raw, untrusted `unknown`
 * items straight off disk or straight from memory): shape per entry, dense
 * `seq` numbering from `0`, `prevSha256` linkage back to
 * {@link TRUST_BUDGET_GENESIS} (or the prior entry's real `entrySha256`),
 * and a from-scratch `entrySha256` recomputation. The first failure wins
 * and is reported with its `seq` (when known) and a specific reason —
 * never a generic catch-all. An empty array verifies `ok: true`.
 */
function verifyEntries(raw: readonly unknown[]): { verification: ChainVerification; entries: TrustBudgetEntry[] } {
  const entries: TrustBudgetEntry[] = [];
  for (const candidate of raw) {
    if (!isPlainRecord(candidate)) {
      return { verification: { ok: false, length: raw.length, reason: "malformed" }, entries: [] };
    }
    entries.push(candidate as unknown as TrustBudgetEntry);
  }

  let prevSha256 = TRUST_BUDGET_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;

    if (!isValidEntryShape(e)) {
      return { verification: { ok: false, length: entries.length, firstBadSeq: i, reason: "malformed" }, entries };
    }
    if (e.seq !== i) {
      return { verification: { ok: false, length: entries.length, firstBadSeq: i, reason: "seq_gap" }, entries };
    }
    if (e.prevSha256 !== prevSha256) {
      return {
        verification: { ok: false, length: entries.length, firstBadSeq: e.seq, reason: "chain_break" },
        entries,
      };
    }

    let expected: string;
    try {
      expected = computeEntryHash(e);
    } catch {
      return { verification: { ok: false, length: entries.length, firstBadSeq: e.seq, reason: "malformed" }, entries };
    }
    if (expected !== e.entrySha256) {
      return {
        verification: { ok: false, length: entries.length, firstBadSeq: e.seq, reason: "hash_mismatch" },
        entries,
      };
    }

    prevSha256 = e.entrySha256;
  }

  return { verification: { ok: true, length: entries.length }, entries };
}

function idemKey(taskId: string, subjectSha256: string): string {
  return `${taskId}\u0000${subjectSha256}`;
}

// ===========================================================================
// Persistence envelope
// ===========================================================================

interface PersistedBudgetFile {
  version: 1;
  genesis: string;
  windowStartedAt: number;
  entries: TrustBudgetEntry[];
}

// ===========================================================================
// TrustBudgetLedger
// ===========================================================================

export class TrustBudgetLedger {
  private readonly cfg: TrustBudgetConfig;
  private readonly path: string | null;
  private _entries: TrustBudgetEntry[] = [];
  private _windowStartedAt: number;
  /**
   * Set only when the on-disk envelope could not even be parsed into an
   * entries array (unreadable file, invalid JSON, wrong top-level shape) —
   * i.e. when there is nothing meaningful to recompute a chain over.
   * `verifyChain()` returns this cached result instead of trivially
   * "verifying" an empty array, which would hide the corruption.
   */
  private _unrecoverable: ChainVerification | null = null;

  private constructor(cfg: TrustBudgetConfig) {
    this.cfg = cfg;
    this.path = cfg.path ?? null;
    this._windowStartedAt = cfg.now();
    if (this.path) this.loadFromDisk();
  }

  /** Loads + verifies any existing file at `cfg.path` before returning. */
  static open(cfg: TrustBudgetConfig): TrustBudgetLedger {
    if (typeof cfg.totalRisk !== "number" || !Number.isFinite(cfg.totalRisk) || cfg.totalRisk <= 0) {
      throw new RangeError(
        `TrustBudgetLedger.open: totalRisk must be a finite number > 0, got ${String(cfg.totalRisk)}`,
      );
    }
    if (!cfg.window || (cfg.window.kind !== "session" && cfg.window.kind !== "fixed-ms")) {
      throw new TypeError('TrustBudgetLedger.open: window.kind must be "session" or "fixed-ms"');
    }
    if (cfg.window.kind === "fixed-ms" && (!Number.isFinite(cfg.window.ms) || cfg.window.ms <= 0)) {
      throw new RangeError(
        `TrustBudgetLedger.open: window.ms must be a finite number > 0, got ${String(cfg.window.ms)}`,
      );
    }
    if (typeof cfg.now !== "function") {
      throw new TypeError("TrustBudgetLedger.open: now must be a function");
    }
    if (cfg.perDomainCaps) {
      for (const [domain, cap] of Object.entries(cfg.perDomainCaps)) {
        if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
          throw new RangeError(
            `TrustBudgetLedger.open: perDomainCaps["${domain}"] must be a finite number > 0, got ${String(cap)}`,
          );
        }
      }
    }
    return new TrustBudgetLedger(cfg);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  quote(req: { domain: string; taskId: string; risk: number }): { allowed: boolean; reason?: string; remaining: number } {
    if (this.path) this.loadFromDisk();
    this.maybeAutoRoll();

    const chain = this.verifyChain();
    if (!chain.ok) {
      return { allowed: false, reason: REASON_CHAIN_INVALID_PREFIX + (chain.reason ?? "unknown"), remaining: 0 };
    }

    const riskErr = validateRisk(req?.risk);
    const globalRemaining = this.globalRemaining();
    if (riskErr) {
      return { allowed: false, reason: riskErr, remaining: globalRemaining };
    }
    if (!isNonEmptyString(req?.domain)) {
      return { allowed: false, reason: "invalid domain: must be a non-empty string", remaining: globalRemaining };
    }

    if (globalRemaining <= FLOAT_EPS) {
      return { allowed: false, reason: REASON_EXHAUSTED_GLOBAL, remaining: globalRemaining };
    }
    if (req.risk > globalRemaining + FLOAT_EPS) {
      return {
        allowed: false,
        reason: "requested risk exceeds remaining global trust budget",
        remaining: globalRemaining,
      };
    }

    const cap = this.domainCap(req.domain);
    if (cap !== null) {
      const domainRemaining = cap - this.domainSpent(req.domain);
      if (domainRemaining <= FLOAT_EPS) {
        return { allowed: false, reason: `domain trust budget exhausted: ${req.domain}`, remaining: globalRemaining };
      }
      if (req.risk > domainRemaining + FLOAT_EPS) {
        return {
          allowed: false,
          reason: `requested risk exceeds remaining trust budget for domain ${req.domain}`,
          remaining: globalRemaining,
        };
      }
    }

    return { allowed: true, remaining: globalRemaining };
  }

  spend(req: {
    domain: string;
    taskId: string;
    risk: number;
    subjectSha256: string;
    issuedAt: number;
  }): { accepted: boolean; remaining: number; entrySha256: string } {
    if (this.path) this.loadFromDisk();
    this.maybeAutoRoll();

    const chain = this.verifyChain();
    if (!chain.ok) {
      return { accepted: false, remaining: 0, entrySha256: "" };
    }

    // Idempotency FIRST: a retried spend for a pair already on the chain
    // returns the original hash and never re-charges, regardless of any
    // other validation outcome for this particular call.
    if (isNonEmptyString(req?.taskId) && isNonEmptyString(req?.subjectSha256)) {
      const existing = this.findByIdemKey(idemKey(req.taskId, req.subjectSha256));
      if (existing) {
        return { accepted: true, remaining: this.globalRemaining(), entrySha256: existing.entrySha256 };
      }
    }

    const riskErr = validateRisk(req?.risk);
    if (riskErr) {
      return { accepted: false, remaining: this.globalRemaining(), entrySha256: "" };
    }
    if (!isNonEmptyString(req?.domain) || !isNonEmptyString(req?.taskId) || !isNonEmptyString(req?.subjectSha256)) {
      return { accepted: false, remaining: this.globalRemaining(), entrySha256: "" };
    }
    if (typeof req.issuedAt !== "number" || !Number.isFinite(req.issuedAt)) {
      return { accepted: false, remaining: this.globalRemaining(), entrySha256: "" };
    }

    const globalRemaining = this.globalRemaining();
    if (req.risk > globalRemaining + FLOAT_EPS) {
      // Never clamped, never partially spent — a refusal charges nothing.
      return { accepted: false, remaining: globalRemaining, entrySha256: "" };
    }

    const cap = this.domainCap(req.domain);
    if (cap !== null) {
      const domainRemaining = cap - this.domainSpent(req.domain);
      if (req.risk > domainRemaining + FLOAT_EPS) {
        return { accepted: false, remaining: globalRemaining, entrySha256: "" };
      }
    }

    const seq = this._entries.length;
    const prevSha256 = seq === 0 ? TRUST_BUDGET_GENESIS : this._entries[seq - 1]!.entrySha256;
    const withoutHash: Omit<TrustBudgetEntry, "entrySha256"> = {
      seq,
      domain: req.domain,
      taskId: req.taskId,
      risk: req.risk,
      subjectSha256: req.subjectSha256,
      issuedAt: req.issuedAt,
      prevSha256,
    };
    const entrySha256 = computeEntryHash(withoutHash);
    const entry: TrustBudgetEntry = { ...withoutHash, entrySha256 };

    this._entries.push(entry);
    if (this.path) {
      try {
        this.persist();
      } catch (err) {
        this._entries.pop();
        throw err;
      }
    }

    return { accepted: true, remaining: this.globalRemaining(), entrySha256 };
  }

  /** Defensive copies of every entry ever appended, in chain order. */
  entries(): TrustBudgetEntry[] {
    if (this.path) this.loadFromDisk();
    return this._entries.map((e) => ({ ...e }));
  }

  /** Independent re-verification of the current in-memory chain. */
  verifyChain(): ChainVerification {
    if (this._unrecoverable) {
      return { ...this._unrecoverable };
    }
    return verifyEntries(this._entries).verification;
  }

  report(): TrustBudgetReport {
    if (this.path) this.loadFromDisk();
    this.maybeAutoRoll();

    const chain = this.verifyChain();
    const windowed = this.windowedEntries();

    let spentRisk = windowed.reduce((s, e) => s + e.risk, 0);
    let remainingRisk = Math.max(0, this.cfg.totalRisk - spentRisk);
    let exhausted = remainingRisk <= FLOAT_EPS;

    if (!chain.ok) {
      // Fail safe: a ledger that has failed chain verification must never
      // be able to report itself as anything other than fully spent — a
      // tampered file must not be able to make the agent look safer than
      // it was.
      spentRisk = this.cfg.totalRisk;
      remainingRisk = 0;
      exhausted = true;
    }

    const domains = new Set<string>([...Object.keys(this.cfg.perDomainCaps ?? {}), ...windowed.map((e) => e.domain)]);
    const perDomain: TrustBudgetReport["perDomain"] = {};
    for (const domain of domains) {
      const cap = this.domainCap(domain);
      const domainEntries = windowed.filter((e) => e.domain === domain);
      const spent = domainEntries.reduce((s, e) => s + e.risk, 0);
      perDomain[domain] = {
        cap,
        spent,
        remaining: cap === null ? null : Math.max(0, cap - spent),
        admissions: domainEntries.length,
      };
    }

    return {
      totalRisk: this.cfg.totalRisk,
      spentRisk,
      remainingRisk,
      exhausted,
      windowStartedAt: this._windowStartedAt,
      windowKind: this.cfg.window.kind,
      entries: this._entries.length,
      chainRoot: TRUST_BUDGET_GENESIS,
      chainHead: this._entries.length > 0 ? this._entries[this._entries.length - 1]!.entrySha256 : TRUST_BUDGET_GENESIS,
      perDomain,
    };
  }

  /**
   * Explicit window roll to caller-chosen timestamp `at`. A no-op for
   * `{ kind: "session" }` ledgers (session windows never roll) and a no-op
   * if `at` does not move the window forward. Archives rather than
   * discards: no entry is ever removed, renumbered, or rehashed by a roll.
   */
  rollWindow(at: number): void {
    if (this.path) this.loadFromDisk();
    if (this.cfg.window.kind !== "fixed-ms") return;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= this._windowStartedAt) return;
    this._windowStartedAt = at;
    if (this.path) this.persist();
  }

  /** Force a durable write of the current in-memory state. No-op in-memory. */
  flush(): void {
    if (this.path) this.persist();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private windowedEntries(): TrustBudgetEntry[] {
    return this._entries.filter((e) => e.issuedAt >= this._windowStartedAt);
  }

  private globalSpent(): number {
    return this.windowedEntries().reduce((s, e) => s + e.risk, 0);
  }

  private globalRemaining(): number {
    return Math.max(0, this.cfg.totalRisk - this.globalSpent());
  }

  private domainSpent(domain: string): number {
    return this.windowedEntries()
      .filter((e) => e.domain === domain)
      .reduce((s, e) => s + e.risk, 0);
  }

  private domainCap(domain: string): number | null {
    const cap = this.cfg.perDomainCaps?.[domain];
    return typeof cap === "number" && Number.isFinite(cap) ? cap : null;
  }

  private findByIdemKey(key: string): TrustBudgetEntry | null {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const e = this._entries[i]!;
      if (idemKey(e.taskId, e.subjectSha256) === key) return e;
    }
    return null;
  }

  /**
   * For `{ kind: "fixed-ms" }` ledgers, advances `windowStartedAt` by `ms`
   * as many times as needed to catch up with the injected clock (handles a
   * clock jump spanning multiple windows), and persists the new boundary
   * if anything moved. `{ kind: "session" }` ledgers never roll.
   */
  private maybeAutoRoll(): void {
    if (this.cfg.window.kind !== "fixed-ms") return;
    const ms = this.cfg.window.ms;
    const now = this.cfg.now();
    if (typeof now !== "number" || !Number.isFinite(now)) return;
    const elapsed = now - this._windowStartedAt;
    if (elapsed < ms) return;
    // Computed, never iterated. A `while (elapsed >= ms) start += ms` loop is
    // O(elapsed/ms): a 1 ms window and a clock that jumps a year forward (a
    // perfectly ordinary "the laptop was asleep" case, or a hostile injected
    // clock) would spin ~3e10 times and wedge the process. The closed form is
    // identical arithmetic in O(1).
    const windows = Math.floor(elapsed / ms);
    if (!Number.isFinite(windows) || windows <= 0) return;
    this._windowStartedAt += windows * ms;
    if (this.path) this.persist();
  }

  /**
   * Reloads state from `this.path`, replacing in-memory `_entries` /
   * `_windowStartedAt` with whatever is durably on disk. Called at the top
   * of every public accessor when `path` is set, which is what gives two
   * ledger instances over the same path safe interleaving (each write is
   * always onto the freshest observed tail) and continuous tamper
   * detection (a file that becomes corrupt between two calls is caught on
   * the very next call, not just at construction).
   *
   * Never throws: any failure to read/parse/verify lands the ledger in the
   * refuse-to-spend state via `_unrecoverable` or a chain-verifying-false
   * `_entries` array, rather than propagating an exception or silently
   * falling back to "act as if the file were empty".
   */
  private loadFromDisk(): void {
    const path = this.path;
    if (!path) return;

    if (!existsSync(path)) {
      // Nothing persisted yet. Keep current in-memory defaults — this is
      // the ONLY case where an absent/unreadable-as-missing file is
      // treated as "empty", because it genuinely never existed.
      this._unrecoverable = null;
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      this._unrecoverable = { ok: false, length: 0, reason: "malformed" };
      this._entries = [];
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this._unrecoverable = { ok: false, length: 0, reason: "malformed" };
      this._entries = [];
      return;
    }

    if (
      !isPlainRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.genesis !== TRUST_BUDGET_GENESIS ||
      typeof parsed.windowStartedAt !== "number" ||
      !Number.isFinite(parsed.windowStartedAt) ||
      !Array.isArray(parsed.entries)
    ) {
      this._unrecoverable = { ok: false, length: 0, reason: "malformed" };
      this._entries = [];
      return;
    }

    const { entries } = verifyEntries(parsed.entries);
    this._entries = entries;
    this._windowStartedAt = parsed.windowStartedAt;
    // `_unrecoverable` stays null here regardless of whether the chain
    // verified: the entries array WAS recoverable (it parsed into a real
    // array of candidate entries), so `verifyChain()` can — and should —
    // recompute the same failure fresh from `_entries` on every call
    // rather than relying on a cached copy. `_unrecoverable` is reserved
    // for the strictly worse case (above) where there is no entries array
    // to recompute over at all.
    this._unrecoverable = null;
  }

  /**
   * Atomic write of the full envelope: `mkdir -p` the parent, write the
   * fixed `.tmp` sibling, then `renameSync` it over the target.
   */
  private persist(): void {
    const path = this.path;
    if (!path) return;
    const payload: PersistedBudgetFile = {
      version: 1,
      genesis: TRUST_BUDGET_GENESIS,
      windowStartedAt: this._windowStartedAt,
      entries: this._entries,
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpPath, path);
  }
}

// ===========================================================================
// Terminal report formatting (never HTML)
// ===========================================================================

/** Left-pad-free column alignment helper: pad `s` to `width` with spaces. */
function col(s: string, width: number): string {
  return s.length >= width ? s + " " : s.padEnd(width);
}

export function formatTrustBudgetReport(r: TrustBudgetReport): string {
  const pct = r.totalRisk > 0 ? (r.spentRisk / r.totalRisk) * 100 : 0;
  const lines: string[] = [];
  lines.push("TRUST BUDGET");
  lines.push("=".repeat(60));
  lines.push(`window        ${r.windowKind} (started ${new Date(r.windowStartedAt).toISOString()})`);
  lines.push(`total risk    ${r.totalRisk.toFixed(6)}`);
  lines.push(`spent risk    ${r.spentRisk.toFixed(6)} (${pct.toFixed(2)}%)`);
  lines.push(`remaining     ${r.remainingRisk.toFixed(6)}`);
  lines.push(`status        ${r.exhausted ? "EXHAUSTED" : "ok"}`);
  lines.push(`entries       ${r.entries}`);
  lines.push(`chain root    ${r.chainRoot}`);
  lines.push(`chain head    ${r.chainHead}`);
  lines.push("-".repeat(60));
  lines.push(col("domain", 20) + col("cap", 12) + col("spent", 12) + col("remaining", 12) + "admits");

  const domains = Object.keys(r.perDomain).sort();
  for (const domain of domains) {
    const p = r.perDomain[domain]!;
    lines.push(
      col(domain, 20) +
        col(p.cap === null ? "-" : p.cap.toFixed(4), 12) +
        col(p.spent.toFixed(4), 12) +
        col(p.remaining === null ? "-" : p.remaining.toFixed(4), 12) +
        String(p.admissions),
    );
  }

  return lines.join("\n");
}
