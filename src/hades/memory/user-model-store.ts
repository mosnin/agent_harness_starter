/**
 * Durable persistence for the Phase-5 dialectic user model, plus the guarded
 * write-through that makes high-confidence beliefs first-class long-term
 * memory citizens.
 *
 * This module is the seam between three things that already exist and are
 * each individually correct, but were never wired together end to end:
 *
 *   - `DialecticUserModel` (`./user-model.ts`) — the in-memory belief engine.
 *     Its `toJSON()`/`fromJSON()` pair is the only honest way to round-trip a
 *     model: `fromJSON` NEVER trusts a stored `confidence`, it always
 *     re-derives it from the evidence ledger. That guarantee is this file's
 *     entire defense against a hand-edited or bit-rotted profile silently
 *     lying about how confident the agent is in something.
 *   - `EvidenceLedger` (`./belief-evidence.ts`) — the hash-chained, tamper-
 *     evident audit trail behind every belief. `EvidenceLedger.restore()`
 *     re-derives every hash from genesis before trusting a loaded chain; a
 *     single flipped byte anywhere in the chain throws, which is exactly the
 *     signal this file uses to route a file to quarantine instead of loading
 *     tampered evidence as if it were real.
 *   - `GuardedMemoryStore` (`./guard.ts`) — the contradiction gate that
 *     stands between a candidate memory write and long-term memory.
 *     `ProfileMemoryBridge` is the first caller that routes belief-derived
 *     facts through that gate instead of writing straight to a `MemoryStore`,
 *     closing the loop: a belief the dialectic model is confident about can
 *     now itself become a durable fact the rest of Hades' memory/retrieval
 *     stack sees — but only if the guard's independent contradiction check
 *     agrees.
 *
 * ---------------------------------------------------------------------------
 * Persistence model
 * ---------------------------------------------------------------------------
 * One JSON file (`opts.path`) holds a `PersistedProfile`: the model snapshot,
 * the FULL evidence ledger (not just what's attached to live beliefs — a
 * `"revised"` belief retires its old evidence from the live ledger slot, but
 * the ledger itself never forgets it), and the ledger's root hash as of the
 * save (a redundant, cheap cross-check on top of `EvidenceLedger.restore`'s
 * own internal chain verification).
 *
 * Writes are atomic: `mkdir -p` the parent, write a `<path>.tmp` sibling,
 * then `renameSync` it over `path` — the same temp+rename convention
 * `FileMemoryStore`/`FileUserModel` (`./store.ts`, `../learning/user-model.ts`)
 * and `appendMemoryFact` (`./context-files.ts`) already use. A crash between
 * those two steps leaves either the untouched old file or an unfinished
 * `.tmp` sibling — `path` itself is never observed half-written.
 *
 * Loading is deliberately paranoid, because persistence is where agent state
 * dies quietly if you let it: a file that exists but fails to parse, fails
 * `DialecticUserModel.fromJSON`'s structural validation, or fails ledger
 * chain verification is never crashed on and never silently discarded. It is
 * renamed out of the way to `<path>.corrupt-<timestamp>` (so the bad bytes
 * are preserved for forensics) and the store starts fresh, with the event
 * recorded in `loadIssues()`. There is no other load-time throw path that
 * escapes the constructor.
 *
 * ---------------------------------------------------------------------------
 * Legacy migration
 * ---------------------------------------------------------------------------
 * The pre-Phase-5 `FileUserModel` (`../learning/user-model.ts`) stored plain
 * `UserTrait[]` with a free-set `confidence` nobody ever calibrated against a
 * tier. `migrateLegacyTraits` is a pure function that turns each mappable
 * legacy trait into one `BeliefAssertion`, synthesizing `BeliefEvidence` at a
 * flat `"T4-consistency"` tier and capping its weight at `min(legacy
 * confidence, 0.6)` — the exact ceiling `combineEvidence`'s own `tierCap`
 * applies to T4 evidence in `./user-model.ts`. A legacy trait that claimed
 * 95% confidence on nothing but free-set self-assertion is not allowed to
 * walk into the new model at face value; it is re-graded down to what T4
 * evidence is actually worth.
 *
 * Migration only ever runs once per `path`: it is only attempted when
 * `path` does not yet exist, and the very first successful migration
 * immediately saves to `path` — so the next construction against the same
 * `path` loads the migrated profile directly (branch (a)) and never touches
 * `legacyPath` again.
 *
 * ---------------------------------------------------------------------------
 * The guarded write-through (`ProfileMemoryBridge`)
 * ---------------------------------------------------------------------------
 * `syncAssertedBeliefs()` walks every belief the model currently holds (not
 * just the ones already passing the model's own assert floor — a contested
 * or decayed belief still gets a `SyncOutcome`, it just reports `"skipped"`
 * with a reason, so the caller has a complete accounting, not just the
 * happy path). For each belief whose status is `"asserted"` and whose
 * confidence, decayed to now, clears `assertFloor` (default 0.75 — stricter
 * than `describe()`'s implicit bar, because writing into `MEMORY.md` is a
 * much stronger claim than mentioning something in a prompt), it renders
 * `"The user's <attribute> is <value>."` and routes it through
 * `GuardedMemoryStore.addChecked`.
 *
 * A clean verdict lands in the guarded store's inner `MemoryStore` and,
 * with `dataDir` set, is appended to `MEMORY.md` via `appendMemoryFact`. A
 * quarantined verdict does the opposite of writing anything: it converts the
 * gate's own verdict into a *contradicting* `BeliefEvidence` via
 * `evidenceFromVerdict` and feeds it straight back into the model through
 * `store.assertAndPersist` with the SAME value the belief already holds —
 * which `reconcileBelief` (`./user-model.ts`) treats as a same-value
 * `"contradicts"` and resolves to `"contested"`. The belief's own confidence
 * erodes and it stops appearing in `model.asserted()` on the next read. The
 * belief that tried to overwrite memory and lost the gate ends up demoted by
 * that very fact — the dialectic loop closes on itself.
 *
 * Idempotence across repeated syncs (including across a process restart)
 * does not need a bespoke "already written" ledger of its own: it is
 * re-derived, honestly, from the REAL guarded memory store's own current
 * contents. Before writing, `syncAssertedBeliefs` checks whether a
 * `"user-model"`-tagged record with the identical rendered fact text already
 * exists in `memory.all()`; if so, the belief is reported `"skipped"`
 * (`"already written to memory"`) and nothing is written twice. Because that
 * check reads the guarded store's own durable state rather than any private
 * flag, it survives a fresh `UserModelStore`/`ProfileMemoryBridge` being
 * constructed around the same underlying memory backend after a restart.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  DialecticUserModel,
  type UserModelSnapshot,
  type UserBelief,
  type BeliefEvidence,
  type DialecticModelOptions,
  type BeliefAssertion,
  type DialecticDecision,
} from "./user-model";
import { EvidenceLedger, type LedgerEntry, evidenceFromVerdict } from "./belief-evidence";
import { GuardedMemoryStore, type FlaggedWrite } from "./guard";
import { appendMemoryFact } from "./context-files";
import type { UserTrait } from "../learning/user-model";

// ===========================================================================
// Small local helpers
// ===========================================================================

function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Deterministic sha256 hex digest. Pure — no I/O, no randomness. Used only
 *  to fabricate a content-addressed `id`/`excerptSha256` for synthesized
 *  legacy-migration evidence; NOT a re-export of `belief-evidence.ts`'s
 *  `evidenceId`/`sha256Hex` (those are out of this file's locked import
 *  surface), but the same standard `sha256` primitive underneath. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Defensive guard for evidence crossing the `belief-evidence.ts` boundary:
 * `./user-model.ts`'s `sanitizeEvidence` (invoked inside
 * `DialecticUserModel.assert`) requires a non-empty `excerptSha256` and
 * throws otherwise. The producers (`evidenceFromVerdict` et al.) populate it
 * since central integration closed that gap, making this a no-op on the
 * normal path — it is kept as belt-and-braces against any future producer
 * omission, filling in a REAL sha256 of the evidence's own excerpt (never a
 * fabricated placeholder) only when the field is missing, so the guarded
 * write-through can never crash on a quarantine verdict because of an
 * upstream field omission.
 */
function withExcerptSha256(e: BeliefEvidence): BeliefEvidence {
  if (typeof e.excerptSha256 === "string" && e.excerptSha256.length > 0) return e;
  return { ...e, excerptSha256: sha256Hex(e.excerpt) };
}

/** Loose text-equality for dedupe comparisons: case/whitespace-insensitive. */
function normalizeForCompare(s: string): string {
  return collapseWhitespace(s).toLowerCase();
}

// ===========================================================================
// Persistence types (locked shape)
// ===========================================================================

export interface UserModelStoreOptions {
  /** Profile JSON file, e.g. `<dataDir>/user-model.json`. */
  path: string;
  /** The old `FileUserModel` JSON to migrate from, if `path` doesn't exist yet. */
  legacyPath?: string;
  model?: DialecticModelOptions;
  now?: () => number;
}

export interface PersistedProfile {
  version: 1;
  snapshot: UserModelSnapshot;
  ledger: LedgerEntry[];
  ledgerRoot: string;
  migratedFromLegacy?: boolean;
  savedAt: number;
}

// ===========================================================================
// Legacy attribute mapping (pure)
// ===========================================================================

/** legacy `UserTrait.attribute` (lowercased) -> Phase-5 taxonomy key. Traits
 *  whose attribute isn't in this table are unmappable and reported skipped —
 *  guessing a taxonomy slot for an attribute nobody has vetted would be
 *  exactly the kind of fabricated confidence this migration exists to avoid. */
const LEGACY_ATTRIBUTE_MAP: Readonly<Record<string, string>> = {
  name: "identity.name",
  location: "identity.location",
  preference: "preference.style",
  stack: "stack.primary",
};

/** Legacy confidences were free-set by `UserModel.assert()` (see
 *  `../learning/user-model.ts`) — never calibrated against any verifier
 *  tier. Migrated evidence is stamped `"T4-consistency"`, the weakest tier,
 *  and its weight is hard-capped here to match `combineEvidence`'s own
 *  `tierCap("T4-consistency")` in `./user-model.ts` (currently 0.6) — a
 *  legacy trait can walk in at most as confident as the weakest real
 *  evidence tier allows, never at whatever number it used to self-report. */
const LEGACY_EVIDENCE_WEIGHT_CAP = 0.6;

/**
 * PURE. Turn legacy `FileUserModel`-format traits into `BeliefAssertion`s the
 * Phase-5 `DialecticUserModel` can `assert()`. Never touches disk, never
 * throws on malformed input — a trait this function cannot make sense of is
 * reported `skipped` with a human-readable reason rather than aborting the
 * whole migration.
 */
export function migrateLegacyTraits(
  traits: UserTrait[],
  opts: { now: () => number },
): { assertions: BeliefAssertion[]; report: { migrated: number; skipped: number; reasons: string[] } } {
  const assertions: BeliefAssertion[] = [];
  const reasons: string[] = [];
  let migrated = 0;
  let skipped = 0;

  const list = Array.isArray(traits) ? traits : [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      skipped += 1;
      reasons.push("skipped a malformed legacy trait entry (not an object)");
      continue;
    }
    const t = raw as Partial<UserTrait>;

    const legacyKey = typeof t.attribute === "string" ? collapseWhitespace(t.attribute).toLowerCase() : "";
    const mapped = legacyKey ? LEGACY_ATTRIBUTE_MAP[legacyKey] : undefined;
    if (!mapped) {
      skipped += 1;
      reasons.push(`skipped unmappable legacy attribute ${JSON.stringify(t.attribute ?? "")}`);
      continue;
    }

    if (typeof t.value !== "string" || collapseWhitespace(t.value).length === 0) {
      skipped += 1;
      reasons.push(`skipped legacy trait "${legacyKey}" with a missing or empty value`);
      continue;
    }

    const at = Number.isFinite(t.updatedAt) ? (t.updatedAt as number) : opts.now();
    const legacyConfidence = typeof t.confidence === "number" && Number.isFinite(t.confidence) ? t.confidence : 0;
    const weight = Math.min(clamp01(legacyConfidence), LEGACY_EVIDENCE_WEIGHT_CAP);

    const evidenceStrings = Array.isArray(t.evidence) ? t.evidence.filter((e): e is string => typeof e === "string") : [];
    const excerpt =
      evidenceStrings.length > 0
        ? evidenceStrings.join(" ")
        : `legacy trait migration: ${legacyKey} = ${t.value}`;

    const idempotentKey = JSON.stringify({
      migration: "legacy-user-model.v1",
      attribute: mapped,
      value: t.value,
      excerpt,
      at,
    });

    const evidence: BeliefEvidence = {
      id: sha256Hex(idempotentKey),
      excerpt,
      excerptSha256: sha256Hex(excerpt),
      polarity: "supports",
      tier: "T4-consistency",
      weight,
      at,
    };

    assertions.push({
      attribute: mapped,
      value: t.value,
      polarity: "supports",
      evidence,
      now: at,
    });
    migrated += 1;
  }

  return { assertions, report: { migrated, skipped, reasons } };
}

// ===========================================================================
// UserModelStore
// ===========================================================================

export class UserModelStore {
  readonly model: DialecticUserModel;
  readonly ledger: EvidenceLedger;

  private readonly path: string;
  private readonly nowFn: () => number;
  private readonly _loadIssues: string[] = [];
  private _migratedFromLegacy = false;

  constructor(opts: UserModelStoreOptions) {
    if (!opts || typeof opts.path !== "string" || opts.path.length === 0) {
      throw new TypeError("UserModelStore: opts.path must be a non-empty string");
    }
    this.path = opts.path;
    this.nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();

    const modelOpts: DialecticModelOptions = {
      ...opts.model,
      now: opts.model?.now ?? this.nowFn,
    };

    let model: DialecticUserModel | undefined;
    let ledger: EvidenceLedger | undefined;

    const primaryExists = existsSync(this.path);

    if (primaryExists) {
      try {
        const raw = readFileSync(this.path, "utf8");
        const parsed = JSON.parse(raw) as PersistedProfile;
        if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
          throw new Error(`unsupported or missing profile version: ${JSON.stringify((parsed as { version?: unknown })?.version)}`);
        }
        const restoredLedger = EvidenceLedger.restore(Array.isArray(parsed.ledger) ? parsed.ledger : []);
        if (restoredLedger.root() !== parsed.ledgerRoot) {
          throw new Error("ledger root does not match the persisted ledger's own chain");
        }
        const restoredModel = DialecticUserModel.fromJSON(parsed.snapshot, modelOpts);

        model = restoredModel;
        ledger = restoredLedger;
        this._migratedFromLegacy = parsed.migratedFromLegacy === true;
      } catch (err) {
        this.quarantineCorruptFile(err);
      }
    } else if (opts.legacyPath) {
      try {
        const legacyRaw = readFileSync(opts.legacyPath, "utf8");
        const legacyParsed = JSON.parse(legacyRaw) as unknown;
        if (!Array.isArray(legacyParsed)) {
          throw new Error(`legacy user-model file at ${opts.legacyPath} did not contain an array`);
        }
        const { assertions, report } = migrateLegacyTraits(legacyParsed as UserTrait[], { now: this.nowFn });

        const migratedModel = new DialecticUserModel(modelOpts);
        const migratedLedger = new EvidenceLedger();
        for (const a of assertions) {
          migratedModel.assert(a);
          migratedLedger.append(a.attribute, a.evidence);
        }

        model = migratedModel;
        ledger = migratedLedger;
        this._migratedFromLegacy = true;

        this._loadIssues.push(
          `migrated ${report.migrated} legacy trait(s) from ${opts.legacyPath} (${report.skipped} skipped)`,
        );
        for (const reason of report.reasons) this._loadIssues.push(reason);
      } catch (err) {
        this._loadIssues.push(
          `legacy migration from ${opts.legacyPath} failed, starting fresh: ${errorMessage(err)}`,
        );
        model = undefined;
        ledger = undefined;
      }
    }

    if (!model || !ledger) {
      model = new DialecticUserModel(modelOpts);
      ledger = new EvidenceLedger();
    }

    this.model = model;
    this.ledger = ledger;

    if (this._migratedFromLegacy && !primaryExists) {
      // Persist the migration result immediately so a second construction
      // against the same `path` loads it directly (branch (a)) instead of
      // re-reading (and re-migrating from) `legacyPath`.
      this.save();
    }
  }

  /** Human-readable record of corruption/migration events encountered while
   *  loading. Empty when the load was clean (no corruption, no migration). */
  loadIssues(): string[] {
    return [...this._loadIssues];
  }

  /**
   * `model.assert(a)` + `ledger.append(a.attribute, evidence)` + an atomic
   * save, in that order. The evidence recorded to the ledger mirrors exactly
   * what `DialecticUserModel.assert` itself resolves (same polarity
   * defaulting: `a.polarity ?? a.evidence.polarity ?? "supports"`), so the
   * ledger's audit trail always agrees with what the model actually saw.
   */
  assertAndPersist(a: BeliefAssertion): DialecticDecision {
    const decision = this.model.assert(a);

    const now = a.now !== undefined && Number.isFinite(a.now) ? a.now : this.nowFn();
    const polarity = a.polarity ?? a.evidence?.polarity ?? "supports";
    const ledgerEvidence: BeliefEvidence = {
      ...a.evidence,
      polarity,
      at: Number.isFinite(a.evidence?.at) ? a.evidence.at : now,
    };
    this.ledger.append(a.attribute, ledgerEvidence);

    this.save();
    return decision;
  }

  /** Atomic save (mkdir -p, tmp file, rename) — matches `FileMemoryStore`'s
   *  temp+rename convention in `./store.ts`. */
  save(): void {
    const profile: PersistedProfile = {
      version: 1,
      snapshot: this.model.toJSON(),
      ledger: this.ledger.entries(),
      ledgerRoot: this.ledger.root(),
      savedAt: this.nowFn(),
    };
    if (this._migratedFromLegacy) profile.migratedFromLegacy = true;

    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* directory already exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile), "utf8");
    renameSync(tmp, this.path);
  }

  /**
   * Never crashes construction: rename the unreadable/tampered file to
   * `<path>.corrupt-<timestamp>` (preserving it for forensics rather than
   * clobbering or silently dropping it) and record the event. If even the
   * rename fails (e.g. the file became inaccessible out from under us), the
   * failure is recorded too and the store still starts fresh — a corrupt or
   * unreadable profile on disk must never prevent the agent from running.
   */
  private quarantineCorruptFile(err: unknown): void {
    const ts = this.nowFn();
    let target = `${this.path}.corrupt-${ts}`;
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = `${this.path}.corrupt-${ts}-${suffix}`;
    }
    try {
      renameSync(this.path, target);
      this._loadIssues.push(`corrupt profile at ${this.path} quarantined to ${target}: ${errorMessage(err)}`);
    } catch (renameErr) {
      this._loadIssues.push(
        `corrupt profile at ${this.path} could not be quarantined (${errorMessage(renameErr)}); starting fresh in memory: ${errorMessage(err)}`,
      );
    }
  }
}

// ===========================================================================
// SyncOutcome / ProfileMemoryBridge
// ===========================================================================

export interface SyncOutcome {
  attribute: string;
  action: "written" | "quarantined" | "skipped";
  reason?: string;
  flagged?: FlaggedWrite;
}

export interface ProfileMemoryBridgeOptions {
  store: UserModelStore;
  memory: GuardedMemoryStore;
  /** Enables MEMORY.md write-back via `appendMemoryFact`. */
  dataDir?: string;
  /** Default 0.75 — MEMORY.md is a stronger claim than `describe()`. */
  assertFloor?: number;
  now?: () => number;
}

function renderBeliefFact(b: UserBelief): string {
  return `The user's ${b.attribute} is ${b.value}.`;
}

export class ProfileMemoryBridge {
  private readonly store: UserModelStore;
  private readonly memory: GuardedMemoryStore;
  private readonly dataDir?: string;
  private readonly assertFloor: number;
  private readonly nowFn: () => number;

  constructor(opts: ProfileMemoryBridgeOptions) {
    if (!opts || !opts.store || !opts.memory) {
      throw new TypeError("ProfileMemoryBridge: opts.store and opts.memory are required");
    }
    this.store = opts.store;
    this.memory = opts.memory;
    this.dataDir = opts.dataDir;
    this.assertFloor = opts.assertFloor !== undefined ? clamp01(opts.assertFloor) : 0.75;
    this.nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();
  }

  /**
   * Walk every belief the model currently holds and route the ones that
   * clear the floor through the guarded memory gate. Returns one
   * `SyncOutcome` per belief — including the ones that were skipped — so the
   * caller always gets a complete accounting, never just the happy path.
   */
  syncAssertedBeliefs(): SyncOutcome[] {
    const now = this.nowFn();
    const outcomes: SyncOutcome[] = [];

    // Snapshot of what the guarded store already durably holds, used to
    // derive idempotence without any bespoke persisted dedupe state: a
    // belief that already produced a matching "user-model"-tagged record is
    // simply not written again, on this call or any future one, as long as
    // that record still lives in the (real, durable) memory backend.
    const existingFacts = this.memory.all();

    for (const belief of this.store.model.all()) {
      if (belief.status !== "asserted") {
        outcomes.push({
          attribute: belief.attribute,
          action: "skipped",
          reason: `belief status is "${belief.status}", not asserted`,
        });
        continue;
      }

      const decayed = this.store.model.decayedConfidence(belief, now);
      if (decayed < this.assertFloor) {
        outcomes.push({
          attribute: belief.attribute,
          action: "skipped",
          reason: `decayed confidence ${decayed.toFixed(3)} is below assertFloor ${this.assertFloor}`,
        });
        continue;
      }

      const factText = renderBeliefFact(belief);
      const normalizedFact = normalizeForCompare(factText);
      const alreadyWritten = existingFacts.some(
        (r) => r.tags.includes("user-model") && normalizeForCompare(r.fact) === normalizedFact,
      );
      if (alreadyWritten) {
        outcomes.push({ attribute: belief.attribute, action: "skipped", reason: "already written to memory" });
        continue;
      }

      const { verdict, flagged } = this.memory.addChecked({
        fact: factText,
        salience: decayed,
        tags: ["user-model"],
        source: "user-model",
      });

      if (!verdict.passed) {
        const contradictingEvidence = withExcerptSha256(evidenceFromVerdict(factText, verdict, { now: this.nowFn }));
        // Same value as the belief already holds + a "contradicts" polarity
        // -> reconcileBelief resolves this to "contested" (see
        // ./user-model.ts's same-value-contradicts extension). The belief
        // that lost the gate is demoted by that very fact.
        this.store.assertAndPersist({
          attribute: belief.attribute,
          value: belief.value,
          evidence: contradictingEvidence,
          now,
        });
        outcomes.push({
          attribute: belief.attribute,
          action: "quarantined",
          reason: verdict.reasons.length > 0 ? verdict.reasons.join(", ") : "contradiction detected",
          flagged,
        });
        continue;
      }

      let reason: string | undefined;
      if (this.dataDir) {
        try {
          const result = appendMemoryFact({
            dataDir: this.dataDir,
            fact: factText,
            source: "user-model",
            now: this.nowFn,
          });
          if (!result.appended) {
            reason = `memory record written but MEMORY.md append failed (${result.reason ?? "unknown reason"})`;
          }
        } catch (err) {
          // appendMemoryFact must never be allowed to turn a successful
          // guarded-memory write into a thrown exception for the caller —
          // the write already landed durably; the MEMORY.md write-back is a
          // best-effort extra, and its failure is reported, not thrown.
          reason = `memory record written but MEMORY.md append threw (${errorMessage(err)})`;
        }
      }

      outcomes.push(
        reason !== undefined
          ? { attribute: belief.attribute, action: "written", reason }
          : { attribute: belief.attribute, action: "written" },
      );
    }

    return outcomes;
  }
}
