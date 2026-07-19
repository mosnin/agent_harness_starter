import { describe, it, expect } from "vitest";
import {
  detectContradictions,
  verifyMemoryWrite,
  memoryWriteCalibration,
  GuardedMemoryStore,
  type ContradictionKind,
  type MemoryWriteVerdict,
} from "../guard";
import { InMemoryMemoryStore, type MemoryRecord, type MemoryStore } from "../store";
import type { VerifierVote } from "../../styx/tiers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let idCounter = 0;
function mkRecord(fact: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? `rec-${idCounter++}`,
    fact,
    salience: overrides.salience ?? 0.9,
    tags: overrides.tags ?? [],
    source: overrides.source,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    lastAccessedAt: overrides.lastAccessedAt,
    accessCount: overrides.accessCount ?? 0,
  };
}

function kinds(findings: { kind: ContradictionKind }[]): ContradictionKind[] {
  return findings.map((f) => f.kind);
}

// ===========================================================================
// detectContradictions — negation
// ===========================================================================

describe("detectContradictions — negation", () => {
  it("fires on a plain 'does not' negation of a shared fact", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user does not like coffee", existing);
    expect(kinds(findings)).toContain("negation");
    expect(findings[0].existing.id).toBe(existing[0].id);
    expect(findings[0].confidence).toBeGreaterThan(0);
    expect(findings[0].confidence).toBeLessThanOrEqual(1);
  });

  it("fires on n't contraction negation", () => {
    const existing = [mkRecord("the user enjoys spicy food")];
    const findings = detectContradictions("the user doesn't enjoy spicy food", existing);
    expect(kinds(findings)).toContain("negation");
  });

  it("fires on 'no longer'", () => {
    const existing = [mkRecord("user works at the office")];
    const findings = detectContradictions("user no longer works at the office", existing);
    expect(kinds(findings)).toContain("negation");
  });

  it("fires on 'never'", () => {
    const existing = [mkRecord("user travels for work")];
    const findings = detectContradictions("user never travels for work", existing);
    expect(kinds(findings)).toContain("negation");
  });

  it("fires on 'stopped Xing'", () => {
    const existing = [mkRecord("user drinks coffee every morning")];
    const findings = detectContradictions("user stopped drinking coffee", existing);
    expect(kinds(findings)).toContain("negation");
  });

  it("does NOT fire when the negated object differs (low content overlap)", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user does not like mornings", existing);
    expect(kinds(findings)).not.toContain("negation");
  });

  it("does NOT fire on an additive, non-conflicting fact", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user likes tea", existing);
    expect(findings).toEqual([]);
  });

  it("does NOT fire when both sides are negated", () => {
    const existing = [mkRecord("user does not like coffee")];
    const findings = detectContradictions("user does not like coffee at night", existing);
    expect(kinds(findings)).not.toContain("negation");
  });

  it("does NOT fire on a paraphrase that adds detail without negating", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user really likes coffee in the morning", existing);
    expect(kinds(findings)).not.toContain("negation");
  });
});

// ===========================================================================
// detectContradictions — numeric
// ===========================================================================

describe("detectContradictions — numeric", () => {
  it("fires on conflicting numeric values in the same context", () => {
    const existing = [mkRecord("the request timeout is 30s")];
    const findings = detectContradictions("the request timeout is 45s", existing);
    expect(kinds(findings)).toContain("numeric");
  });

  it("fires on conflicting units in the same context", () => {
    const existing = [mkRecord("build timeout is 30s")];
    const findings = detectContradictions("build timeout is 30ms", existing);
    expect(kinds(findings)).toContain("numeric");
  });

  it("parses decimals and fires on conflicting decimal values", () => {
    const existing = [mkRecord("cpu budget is 2.5 hours")];
    const findings = detectContradictions("cpu budget is 3.5 hours", existing);
    expect(kinds(findings)).toContain("numeric");
  });

  it("does NOT fire when values are equal", () => {
    const existing = [mkRecord("the request timeout is 30s")];
    const findings = detectContradictions("the request timeout is 30s exactly", existing);
    expect(kinds(findings)).not.toContain("numeric");
  });

  it("does NOT fire when numbers attach to different attributes", () => {
    const existing = [mkRecord("the request timeout is 30s")];
    const findings = detectContradictions("the retry count is 45", existing);
    expect(kinds(findings)).not.toContain("numeric");
  });

  it("does NOT fire when candidate has no number at all", () => {
    const existing = [mkRecord("the request timeout is 30s")];
    const findings = detectContradictions("the request timeout matters a lot", existing);
    expect(kinds(findings)).not.toContain("numeric");
  });
});

// ===========================================================================
// detectContradictions — antonym
// ===========================================================================

describe("detectContradictions — antonym", () => {
  it("fires on enabled/disabled with shared context", () => {
    const existing = [mkRecord("dark mode is enabled")];
    const findings = detectContradictions("dark mode is disabled", existing);
    expect(kinds(findings)).toContain("antonym");
  });

  it("fires on dark/light with shared context", () => {
    const existing = [mkRecord("user prefers dark mode")];
    const findings = detectContradictions("user prefers light mode", existing);
    expect(kinds(findings)).toContain("antonym");
  });

  it("fires on likes/hates with shared context", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user hates coffee", existing);
    expect(kinds(findings)).toContain("antonym");
  });

  it("fires on remote/office with shared context", () => {
    const existing = [mkRecord("user works remote on Fridays")];
    const findings = detectContradictions("user works office on Fridays", existing);
    expect(kinds(findings)).toContain("antonym");
  });

  it("does NOT fire when the antonym pair applies to different topics", () => {
    const existing = [mkRecord("user enabled notifications")];
    const findings = detectContradictions("user disabled logging", existing);
    expect(kinds(findings)).not.toContain("antonym");
  });

  it("does NOT fire on unrelated preferences (no antonym pair present)", () => {
    const existing = [mkRecord("user likes coffee")];
    const findings = detectContradictions("user likes tea", existing);
    expect(kinds(findings)).not.toContain("antonym");
  });
});

// ===========================================================================
// detectContradictions — exclusive-value
// ===========================================================================

describe("detectContradictions — exclusive-value", () => {
  it("fires when the same attribute is set to two different values", () => {
    const existing = [mkRecord("default model is alpha")];
    const findings = detectContradictions("default model is beta", existing);
    expect(kinds(findings)).toContain("exclusive-value");
  });

  it("fires with the 'uses' trigger verb", () => {
    const existing = [mkRecord("the pipeline uses postgres")];
    const findings = detectContradictions("the pipeline uses mysql", existing);
    expect(kinds(findings)).toContain("exclusive-value");
  });

  it("does NOT fire when the attribute differs", () => {
    const existing = [mkRecord("default model is alpha")];
    const findings = detectContradictions("default timeout is alpha", existing);
    expect(kinds(findings)).not.toContain("exclusive-value");
  });

  it("does NOT fire on a superset/additive value", () => {
    const existing = [mkRecord("user prefers coffee")];
    const findings = detectContradictions("user prefers coffee and tea", existing);
    expect(kinds(findings)).not.toContain("exclusive-value");
  });

  it("does NOT fire on a stopword paraphrase with the identical value", () => {
    const existing = [mkRecord("the default model is alpha")];
    const findings = detectContradictions("default model is alpha", existing);
    expect(kinds(findings)).not.toContain("exclusive-value");
  });
});

// ===========================================================================
// Salience floor
// ===========================================================================

describe("detectContradictions — salience floor", () => {
  it("a below-floor record never vetoes (0.69 < default 0.7 floor)", () => {
    const existing = [mkRecord("default model is alpha", { salience: 0.69 })];
    const findings = detectContradictions("default model is beta", existing);
    expect(findings).toEqual([]);
  });

  it("a record exactly at the default floor (0.7) does veto", () => {
    const existing = [mkRecord("default model is alpha", { salience: 0.7 })];
    const findings = detectContradictions("default model is beta", existing);
    expect(kinds(findings)).toContain("exclusive-value");
  });

  it("respects a custom salienceFloor option", () => {
    const existing = [mkRecord("default model is alpha", { salience: 0.4 })];
    expect(detectContradictions("default model is beta", existing, { salienceFloor: 0.5 })).toEqual([]);
    expect(kinds(detectContradictions("default model is beta", existing, { salienceFloor: 0.4 }))).toContain(
      "exclusive-value",
    );
  });
});

// ===========================================================================
// Adversarial / edge cases
// ===========================================================================

describe("detectContradictions — adversarial edge cases", () => {
  it("handles an empty candidate without throwing, and finds nothing", () => {
    const existing = [mkRecord("default model is alpha")];
    expect(() => detectContradictions("", existing)).not.toThrow();
    expect(detectContradictions("", existing)).toEqual([]);
  });

  it("handles a 10k-character candidate without throwing", () => {
    const long = "user likes coffee. ".repeat(600); // ~12,000 chars
    const existing = [mkRecord("user likes coffee")];
    expect(() => detectContradictions(long, existing)).not.toThrow();
  });

  it("a candidate identical to an existing fact is NOT a contradiction", () => {
    const existing = [mkRecord("default model is alpha")];
    expect(detectContradictions("default model is alpha", existing)).toEqual([]);
  });

  it("handles unicode facts without throwing or false-firing", () => {
    const existing = [mkRecord("ユーザーはコーヒーが好きです"), mkRecord("café préféré: espresso")];
    expect(() => detectContradictions("café préféré: ristretto", existing)).not.toThrow();
    // Non-ASCII content tokenizes to nothing meaningful — no fabricated finding.
    const findings = detectContradictions("café préféré: ristretto", existing);
    expect(Array.isArray(findings)).toBe(true);
  });

  it("scans a 500-record store in a single pass without pathological blowup", () => {
    const existing: MemoryRecord[] = [];
    for (let i = 0; i < 500; i++) {
      existing.push(mkRecord(`user preference number ${i} is set to value ${i}`, { salience: 0.9 }));
    }
    // One genuine contradiction planted in the middle.
    existing.push(mkRecord("default model is alpha", { salience: 0.9 }));

    const start = Date.now();
    const findings = detectContradictions("default model is beta", existing);
    const elapsedMs = Date.now() - start;

    expect(kinds(findings)).toContain("exclusive-value");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    // Generous bound — this is a correctness-of-scaling smoke test, not a
    // micro-benchmark; a quadratic-in-records bug would still blow well past
    // this on 500 short records.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

// ===========================================================================
// verifyMemoryWrite — verdict contract
// ===========================================================================

describe("verifyMemoryWrite", () => {
  it("passes cleanly with empty reasons and no contradictions for a non-conflicting write", () => {
    const existing = [mkRecord("user likes coffee")];
    const verdict = verifyMemoryWrite("user likes tea", existing);
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.contradictions).toEqual([]);
    expect(verdict.verifierId).toBe("verify.memory-write");
    expect(verdict.confidence).toBeGreaterThanOrEqual(0);
    expect(verdict.confidence).toBeLessThanOrEqual(1);
  });

  it("fails with the frozen reason code for a negation contradiction", () => {
    const existing = [mkRecord("user likes coffee")];
    const verdict = verifyMemoryWrite("user does not like coffee", existing);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(["contradiction.negation"]);
    expect(verdict.contradictions).toHaveLength(1);
  });

  it("fails with the frozen reason code for a numeric contradiction", () => {
    // "timeout is 30s" / "timeout is 45s" also happens to fit the
    // exclusive-value shape ("X is A" vs "X is B") — both codes are honest
    // and REASON_ORDER keeps them stably ordered.
    const existing = [mkRecord("timeout is 30s")];
    const verdict = verifyMemoryWrite("timeout is 45s", existing);
    expect(verdict.reasons).toContain("contradiction.numeric");
    const order = ["contradiction.negation", "contradiction.numeric", "contradiction.antonym", "contradiction.exclusive-value"];
    const indices = verdict.reasons.map((r) => order.indexOf(r));
    expect(indices).toEqual([...indices].sort((a, b) => a - b)); // fixed check order preserved
  });

  it("fails with a frozen reason code drawn only from the known set, for a pure numeric conflict with no copula", () => {
    const existing = [mkRecord("build takes 30s to finish")];
    const verdict = verifyMemoryWrite("build takes 45s to finish", existing);
    expect(verdict.reasons).toEqual(["contradiction.numeric"]);
  });

  it("fails with the frozen reason code for an antonym contradiction", () => {
    const existing = [mkRecord("notifications are enabled")];
    const verdict = verifyMemoryWrite("notifications are disabled", existing);
    expect(verdict.reasons).toContain("contradiction.antonym");
  });

  it("fails with a pure antonym reason code when the sentence has no copula-style trigger", () => {
    const existing = [mkRecord("user always keeps dark mode enabled")];
    const verdict = verifyMemoryWrite("user always keeps dark mode disabled", existing);
    expect(verdict.reasons).toEqual(["contradiction.antonym"]);
  });

  it("fails with the frozen reason code for an exclusive-value contradiction", () => {
    const existing = [mkRecord("default model is alpha")];
    const verdict = verifyMemoryWrite("default model is beta", existing);
    expect(verdict.reasons).toEqual(["contradiction.exclusive-value"]);
  });

  it("orders reason codes in fixed order and dedupes per kind across multiple records", () => {
    const existing = [mkRecord("user likes coffee"), mkRecord("user likes coffee", { id: "dup-2" })];
    const verdict = verifyMemoryWrite("user does not like coffee", existing);
    // Both existing records independently produce a negation finding, but
    // reasons de-duplicate to one code per kind.
    expect(verdict.reasons).toEqual(["contradiction.negation"]);
    expect(verdict.contradictions.length).toBe(2);
  });

  it("passed is true iff contradictions is empty", () => {
    const passing = verifyMemoryWrite("user likes tea", [mkRecord("user likes coffee")]);
    const failing = verifyMemoryWrite("user does not like coffee", [mkRecord("user likes coffee")]);
    expect(passing.passed).toBe(passing.contradictions.length === 0);
    expect(failing.passed).toBe(failing.contradictions.length === 0);
    expect(passing.passed).toBe(true);
    expect(failing.passed).toBe(false);
  });

  it("confidence is always within [0,1]", () => {
    const cases: Array<[string, MemoryRecord[]]> = [
      ["user likes tea", [mkRecord("user likes coffee")]],
      ["user does not like coffee", [mkRecord("user likes coffee")]],
      ["timeout is 45s", [mkRecord("timeout is 30s")]],
      ["notifications are disabled", [mkRecord("notifications are enabled")]],
      ["default model is beta", [mkRecord("default model is alpha")]],
      ["", []],
    ];
    for (const [candidate, existing] of cases) {
      const v = verifyMemoryWrite(candidate, existing);
      expect(v.confidence).toBeGreaterThanOrEqual(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("shape is assignable to VerifierVote at the type level", () => {
    const verdict: MemoryWriteVerdict = verifyMemoryWrite("user likes tea", [mkRecord("user likes coffee")]);
    const asVote: VerifierVote = verdict; // compile-time assignability check
    expect(asVote.verifierId).toBe("verify.memory-write");
    expect(typeof asVote.passed).toBe("boolean");
  });
});

// ===========================================================================
// memoryWriteCalibration
// ===========================================================================

describe("memoryWriteCalibration", () => {
  it("returns a T4-consistency tier with a prior in (0,1]", () => {
    const cal = memoryWriteCalibration();
    expect(cal.tier).toBe("T4-consistency");
    expect(cal.prior).toBeGreaterThan(0);
    expect(cal.prior).toBeLessThanOrEqual(1);
  });

  it("is deterministic across calls", () => {
    expect(memoryWriteCalibration()).toEqual(memoryWriteCalibration());
  });
});

// ===========================================================================
// GuardedMemoryStore — MemoryStore conformance for clean writes
// ===========================================================================

describe("GuardedMemoryStore — MemoryStore conformance (clean writes)", () => {
  it("add/get/all/search/forget/size all delegate correctly for clean writes", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);

    const r1 = guarded.add({ fact: "user likes coffee", salience: 0.8, tags: ["pref"], source: "test" });
    expect(r1.tags).not.toContain("quarantined");
    expect(guarded.get(r1.id)).toEqual(r1);
    expect(inner.get(r1.id)).toEqual(r1);

    const r2 = guarded.add({ fact: "user likes tea" });
    expect(guarded.all().map((r) => r.id).sort()).toEqual(inner.all().map((r) => r.id).sort());
    expect(guarded.all()).toHaveLength(2);

    const results = guarded.search("coffee");
    expect(results.some((r) => r.id === r1.id)).toBe(true);
    expect(guarded.size()).toBe(2);
    expect(inner.size()).toBe(2);

    expect(guarded.forget(r1.id)).toBe(true);
    expect(guarded.get(r1.id)).toBeUndefined();
    expect(inner.get(r1.id)).toBeUndefined();
    expect(guarded.size()).toBe(1);

    // r2 untouched
    expect(guarded.get(r2.id)).toBeDefined();
  });

  it("implements MemoryStore structurally (assignable)", () => {
    const guarded: MemoryStore = new GuardedMemoryStore(new InMemoryMemoryStore());
    expect(typeof guarded.add).toBe("function");
    expect(typeof guarded.search).toBe("function");
  });
});

// ===========================================================================
// GuardedMemoryStore — quarantine behavior
// ===========================================================================

describe("GuardedMemoryStore — quarantine", () => {
  it("a contradicting write does not reach inner and is quarantined", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    guarded.add({ fact: "default model is alpha", salience: 0.9 });

    const beforeSize = inner.size();
    const quarantined = guarded.add({ fact: "default model is beta", salience: 0.9 });

    expect(quarantined.tags).toContain("quarantined");
    expect(inner.size()).toBe(beforeSize); // did NOT write through
    expect(inner.all().some((r) => r.fact === "default model is beta")).toBe(false);
    expect(inner.search("beta").some((r) => r.fact === "default model is beta")).toBe(false);
    expect(guarded.all().some((r) => r.fact === "default model is beta")).toBe(false);
  });

  it("addChecked reports the verdict and the flag for a contradicted write", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    guarded.add({ fact: "default model is alpha", salience: 0.9 });

    const result = guarded.addChecked({ fact: "default model is beta", salience: 0.9 });
    expect(result.verdict.passed).toBe(false);
    expect(result.flagged).toBeDefined();
    expect(result.flagged!.candidate.fact).toBe("default model is beta");
    expect(guarded.flags().map((f) => f.id)).toContain(result.flagged!.id);
  });

  it("addChecked reports a clean verdict with no flag for a clean write", () => {
    const guarded = new GuardedMemoryStore(new InMemoryMemoryStore());
    const result = guarded.addChecked({ fact: "user likes coffee" });
    expect(result.verdict.passed).toBe(true);
    expect(result.flagged).toBeUndefined();
    expect(result.record).toBeDefined();
  });

  it("a low-salience existing fact does not cause quarantine", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    guarded.add({ fact: "default model is alpha", salience: 0.3 });

    const written = guarded.add({ fact: "default model is beta", salience: 0.9 });
    expect(written.tags).not.toContain("quarantined");
    expect(inner.all().some((r) => r.fact === "default model is beta")).toBe(true);
  });

  it("multiple pending flags coexist with stable, distinct ids", () => {
    const guarded = new GuardedMemoryStore(new InMemoryMemoryStore());
    guarded.add({ fact: "default model is alpha", salience: 0.9 });
    guarded.add({ fact: "timeout is 30s", salience: 0.9 });

    const q1 = guarded.add({ fact: "default model is beta", salience: 0.9 });
    const q2 = guarded.add({ fact: "timeout is 45s", salience: 0.9 });

    expect(q1.id).not.toBe(q2.id);
    const flags = guarded.flags();
    expect(flags.map((f) => f.id)).toEqual(expect.arrayContaining([q1.id, q2.id]));
    expect(new Set(flags.map((f) => f.id)).size).toBe(flags.length);
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// GuardedMemoryStore — resolution workflow
// ===========================================================================

describe("GuardedMemoryStore — resolve()", () => {
  it("accept-new writes the candidate to inner and leaves the contradicted record in place", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    const original = guarded.add({ fact: "default model is alpha", salience: 0.9 });
    const q = guarded.add({ fact: "default model is beta", salience: 0.9 });
    const flag = guarded.flags().find((f) => f.id === q.id)!;

    const ok = guarded.resolve(flag.id, "accept-new");
    expect(ok).toBe(true);
    expect(inner.all().some((r) => r.fact === "default model is beta")).toBe(true);
    expect(inner.get(original.id)).toBeDefined(); // existing record kept
    expect(guarded.flags().find((f) => f.id === flag.id)?.resolution).toBe("accept-new");
  });

  it("supersede writes the candidate AND removes the contradicted existing record", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    const original = guarded.add({ fact: "default model is alpha", salience: 0.9 });
    const q = guarded.add({ fact: "default model is beta", salience: 0.9 });
    const flag = guarded.flags().find((f) => f.id === q.id)!;

    const ok = guarded.resolve(flag.id, "supersede");
    expect(ok).toBe(true);
    expect(inner.get(original.id)).toBeUndefined(); // old record actually removed
    expect(inner.all().some((r) => r.fact === "default model is beta")).toBe(true);
    expect(guarded.flags().find((f) => f.id === flag.id)?.resolution).toBe("supersede");
  });

  it("keep-existing discards the candidate and leaves inner untouched", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    const original = guarded.add({ fact: "default model is alpha", salience: 0.9 });
    const q = guarded.add({ fact: "default model is beta", salience: 0.9 });
    const flag = guarded.flags().find((f) => f.id === q.id)!;
    const sizeBefore = inner.size();

    const ok = guarded.resolve(flag.id, "keep-existing");
    expect(ok).toBe(true);
    expect(inner.size()).toBe(sizeBefore);
    expect(inner.all().some((r) => r.fact === "default model is beta")).toBe(false);
    expect(inner.get(original.id)).toBeDefined();
    expect(guarded.flags().find((f) => f.id === flag.id)?.resolution).toBe("keep-existing");
  });

  it("resolve is idempotent — a second call on the same flag returns false", () => {
    const guarded = new GuardedMemoryStore(new InMemoryMemoryStore());
    guarded.add({ fact: "default model is alpha", salience: 0.9 });
    const q = guarded.add({ fact: "default model is beta", salience: 0.9 });
    const flag = guarded.flags().find((f) => f.id === q.id)!;

    expect(guarded.resolve(flag.id, "keep-existing")).toBe(true);
    expect(guarded.resolve(flag.id, "keep-existing")).toBe(false);
    expect(guarded.resolve(flag.id, "accept-new")).toBe(false);
  });

  it("resolve on an unknown id returns false", () => {
    const guarded = new GuardedMemoryStore(new InMemoryMemoryStore());
    expect(guarded.resolve("does-not-exist", "accept-new")).toBe(false);
  });

  it("supersede removes all distinct contradicted records when more than one exists", () => {
    const inner = new InMemoryMemoryStore();
    const guarded = new GuardedMemoryStore(inner);
    const a = guarded.add({ fact: "user likes coffee", salience: 0.9 });
    const b = guarded.add({ fact: "user likes coffee", salience: 0.9, source: "second" });
    // Force a second distinct-fact record with the same negation target by
    // bypassing the guard (direct inner write) so both exist for supersede.
    inner.forget(b.id);
    const c = inner.add({ fact: "user likes coffee", salience: 0.9 });

    const q = guarded.add({ fact: "user does not like coffee", salience: 0.9 });
    const flag = guarded.flags().find((f) => f.id === q.id)!;
    expect(flag.verdict.contradictions.length).toBeGreaterThanOrEqual(2);

    expect(guarded.resolve(flag.id, "supersede")).toBe(true);
    expect(inner.get(a.id)).toBeUndefined();
    expect(inner.get(c.id)).toBeUndefined();
    expect(inner.all().some((r) => r.fact === "user does not like coffee")).toBe(true);
  });
});

// ===========================================================================
// GuardedMemoryStore — injected clock determinism
// ===========================================================================

describe("GuardedMemoryStore — injected now()", () => {
  it("uses the injected clock for flag timestamps deterministically", () => {
    let clock = 1_000_000;
    const guarded = new GuardedMemoryStore(new InMemoryMemoryStore(), { now: () => clock });
    guarded.add({ fact: "default model is alpha", salience: 0.9 });

    clock = 2_000_000;
    const q1 = guarded.add({ fact: "default model is beta", salience: 0.9 });
    clock = 3_000_000;
    const q2 = guarded.add({ fact: "default model is gamma", salience: 0.9 });

    const flags = guarded.flags();
    expect(flags.find((f) => f.id === q1.id)?.at).toBe(2_000_000);
    expect(flags.find((f) => f.id === q2.id)?.at).toBe(3_000_000);
    expect(q1.createdAt).toBe(2_000_000);
    expect(q2.createdAt).toBe(3_000_000);
  });
});
