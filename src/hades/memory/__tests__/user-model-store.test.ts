import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UserModelStore,
  ProfileMemoryBridge,
  migrateLegacyTraits,
  type PersistedProfile,
  type SyncOutcome,
} from "../user-model-store";
import type { BeliefEvidence } from "../user-model";
import { GuardedMemoryStore } from "../guard";
import { InMemoryMemoryStore } from "../store";
import type { UserTrait } from "../../learning/user-model";

// ===========================================================================
// Fixtures / helpers
// ===========================================================================

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "user-model-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

let clock = 1_700_000_000_000;
function fixedNow(): number {
  return clock;
}

function mkEvidence(overrides: Partial<BeliefEvidence> = {}): BeliefEvidence {
  return {
    id: overrides.id ?? `ev-${Math.random().toString(36).slice(2)}`,
    excerpt: overrides.excerpt ?? "the user said so directly",
    excerptSha256: overrides.excerptSha256 ?? "deadbeef",
    polarity: overrides.polarity ?? "supports",
    tier: overrides.tier ?? "T1-reference",
    weight: overrides.weight ?? 0.9,
    at: overrides.at ?? clock,
    ...overrides,
  };
}

function readProfile(path: string): PersistedProfile {
  return JSON.parse(readFileSync(path, "utf8")) as PersistedProfile;
}

function corruptFilesIn(dir: string, base: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
}

// ===========================================================================
// Cold start / round-trip / confidence re-derivation
// ===========================================================================

describe("UserModelStore — cold start and round-trip", () => {
  it("starts fresh with no beliefs and empty loadIssues when nothing exists on disk", () => {
    const path = join(root, "user-model.json");
    const store = new UserModelStore({ path, now: fixedNow });
    expect(store.model.all()).toEqual([]);
    expect(store.ledger.entries()).toEqual([]);
    expect(store.loadIssues()).toEqual([]);
    // Nothing was written yet — a fresh store must not eagerly touch disk.
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips beliefs, evidence, and the ledger root across assert -> save -> reload", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow });

    const decision = storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Ada Lovelace",
      evidence: mkEvidence({ id: "e1", excerpt: "My name is Ada Lovelace.", weight: 0.9 }),
      now: clock,
    });
    expect(decision).toBe("created");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false); // atomic rename cleans up the tmp sibling

    const rootHashAfterA = storeA.ledger.root();
    const beliefA = storeA.model.get("identity.name");
    expect(beliefA).toBeDefined();
    expect(beliefA!.value).toBe("Ada Lovelace");
    expect(beliefA!.evidence).toHaveLength(1);

    const storeB = new UserModelStore({ path, now: fixedNow });
    expect(storeB.loadIssues()).toEqual([]);
    expect(storeB.ledger.root()).toBe(rootHashAfterA);
    expect(storeB.ledger.entries()).toHaveLength(1);

    const beliefB = storeB.model.get("identity.name");
    expect(beliefB).toBeDefined();
    expect(beliefB!.value).toBe("Ada Lovelace");
    expect(beliefB!.confidence).toBeCloseTo(beliefA!.confidence, 10);
    expect(beliefB!.evidence).toHaveLength(1);
    expect(beliefB!.evidence[0].excerpt).toBe("My name is Ada Lovelace.");
  });

  it("reload re-derives confidence from evidence, correcting a hand-tampered stored value", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Grace Hopper",
      evidence: mkEvidence({ id: "e1", weight: 0.9, tier: "T1-reference" }),
      now: clock,
    });
    const honestConfidence = storeA.model.get("identity.name")!.confidence;
    expect(honestConfidence).toBeGreaterThan(0);
    expect(honestConfidence).toBeLessThan(1);

    // Hand-tamper the saved snapshot's confidence upward. The ledger arrays
    // (and therefore its chain / root) are untouched, so this file still
    // loads via the clean path -- but the model must never trust the
    // tampered number.
    const profile = readProfile(path);
    profile.snapshot.beliefs[0].confidence = 0.999999;
    writeFileSync(path, JSON.stringify(profile), "utf8");

    const storeB = new UserModelStore({ path, now: fixedNow });
    expect(storeB.loadIssues()).toEqual([]); // still a clean load: JSON + ledger chain both valid
    const reDerived = storeB.model.get("identity.name")!.confidence;
    expect(reDerived).toBeCloseTo(honestConfidence, 10);
    expect(reDerived).not.toBeCloseTo(0.999999, 3);
  });
});

// ===========================================================================
// Corruption handling
// ===========================================================================

describe("UserModelStore — corruption is quarantined, never thrown", () => {
  it("quarantines torn/truncated JSON and starts fresh, recording the event", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Torn Value",
      evidence: mkEvidence({ id: "e1" }),
      now: clock,
    });

    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)), "utf8"); // truncate mid-JSON

    let storeB: UserModelStore | undefined;
    expect(() => {
      storeB = new UserModelStore({ path, now: fixedNow });
    }).not.toThrow();

    expect(storeB!.model.all()).toEqual([]); // fresh, not a partial/garbage hydration
    expect(storeB!.loadIssues().length).toBeGreaterThan(0);
    expect(storeB!.loadIssues().some((m) => m.toLowerCase().includes("quarantine"))).toBe(true);

    const quarantined = corruptFilesIn(root, "user-model.json");
    expect(quarantined).toHaveLength(1);
    // The bad bytes are preserved, not silently discarded.
    expect(readFileSync(join(root, quarantined[0]), "utf8")).toBe(good.slice(0, Math.floor(good.length / 2)));
    // And the original path was replaced by a fresh, valid file on next save.
    storeB!.save();
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("quarantines a broken evidence-ledger hash chain on disk", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Chain Value",
      evidence: mkEvidence({ id: "e1" }),
      now: clock,
    });
    storeA.assertAndPersist({
      attribute: "identity.location",
      value: "Berlin",
      evidence: mkEvidence({ id: "e2" }),
      now: clock,
    });

    const profile = readProfile(path);
    expect(profile.ledger.length).toBeGreaterThanOrEqual(2);
    // Tamper a past entry's evidence weight without recomputing the chain --
    // this must invalidate every downstream hash.
    profile.ledger[0].evidence.weight = 0.999999;
    writeFileSync(path, JSON.stringify(profile), "utf8");

    const storeB = new UserModelStore({ path, now: fixedNow });
    expect(storeB.model.all()).toEqual([]);
    expect(storeB.ledger.entries()).toEqual([]);
    expect(storeB.loadIssues().length).toBeGreaterThan(0);
    expect(corruptFilesIn(root, "user-model.json")).toHaveLength(1);
  });

  it("every public method still works on a store that failed to load", () => {
    const path = join(root, "user-model.json");
    writeFileSync(path, "{not valid json at all", "utf8");

    const store = new UserModelStore({ path, now: fixedNow });
    expect(store.loadIssues().length).toBeGreaterThan(0);

    expect(() =>
      store.assertAndPersist({
        attribute: "identity.name",
        value: "Recovered",
        evidence: mkEvidence({ id: "e1" }),
        now: clock,
      }),
    ).not.toThrow();
    expect(store.model.get("identity.name")?.value).toBe("Recovered");
    expect(() => store.save()).not.toThrow();
    expect(readProfile(path).snapshot.beliefs).toHaveLength(1);
  });
});

// ===========================================================================
// Concurrency-adjacent: last save wins, never a corrupt file
// ===========================================================================

describe("UserModelStore — two instances on the same path", () => {
  it("last save wins and the file is always well-formed", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow }); // both fresh, unaware of each other
    const storeB = new UserModelStore({ path, now: fixedNow });

    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "From A",
      evidence: mkEvidence({ id: "a1" }),
      now: clock,
    });
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();

    storeB.assertAndPersist({
      attribute: "identity.name",
      value: "From B",
      evidence: mkEvidence({ id: "b1" }),
      now: clock,
    });

    const finalProfile = readProfile(path);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    expect(finalProfile.snapshot.beliefs).toHaveLength(1);
    expect(finalProfile.snapshot.beliefs[0].value).toBe("From B"); // B's save clobbered A's
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

// ===========================================================================
// migrateLegacyTraits (pure)
// ===========================================================================

describe("migrateLegacyTraits", () => {
  function mkTrait(overrides: Partial<UserTrait> = {}): UserTrait {
    return {
      attribute: overrides.attribute ?? "name",
      value: overrides.value ?? "Someone",
      confidence: overrides.confidence ?? 0.5,
      evidence: overrides.evidence ?? ["some evidence"],
      updatedAt: overrides.updatedAt ?? clock,
      revisions: overrides.revisions ?? 0,
    };
  }

  it("maps every known legacy attribute through the taxonomy table", () => {
    const { assertions, report } = migrateLegacyTraits(
      [
        mkTrait({ attribute: "name", value: "Ada" }),
        mkTrait({ attribute: "location", value: "London" }),
        mkTrait({ attribute: "preference", value: "dark mode" }),
        mkTrait({ attribute: "stack", value: "TypeScript" }),
      ],
      { now: fixedNow },
    );
    expect(report.migrated).toBe(4);
    expect(report.skipped).toBe(0);
    expect(assertions.map((a) => a.attribute).sort()).toEqual(
      ["identity.location", "identity.name", "preference.style", "stack.primary"].sort(),
    );
  });

  it("caps an over-confident legacy trait's evidence weight at the T4 ceiling (0.6)", () => {
    const { assertions } = migrateLegacyTraits([mkTrait({ attribute: "name", value: "Ada", confidence: 0.99 })], {
      now: fixedNow,
    });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].evidence.weight).toBeCloseTo(0.6, 10);
    expect(assertions[0].evidence.tier).toBe("T4-consistency");
  });

  it("does not cap a legacy trait whose confidence was already below the ceiling", () => {
    const { assertions } = migrateLegacyTraits([mkTrait({ attribute: "name", value: "Ada", confidence: 0.2 })], {
      now: fixedNow,
    });
    expect(assertions[0].evidence.weight).toBeCloseTo(0.2, 10);
  });

  it("reports unmappable attributes as skipped with a reason, and is pure (no I/O)", () => {
    const { assertions, report } = migrateLegacyTraits(
      [mkTrait({ attribute: "shoe-size", value: "10" }), mkTrait({ attribute: "name", value: "Ada" })],
      { now: fixedNow },
    );
    expect(report.migrated).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.reasons.some((r) => r.includes("shoe-size"))).toBe(true);
    expect(assertions).toHaveLength(1);
  });

  it("skips malformed entries and empty/missing values without throwing", () => {
    const { assertions, report } = migrateLegacyTraits(
      [null as unknown as UserTrait, mkTrait({ attribute: "name", value: "" }), mkTrait({ attribute: "location", value: "Paris" })],
      { now: fixedNow },
    );
    expect(report.skipped).toBe(2);
    expect(report.migrated).toBe(1);
    expect(assertions).toHaveLength(1);
    expect(assertions[0].value).toBe("Paris");
  });
});

// ===========================================================================
// End-to-end legacy migration through UserModelStore
// ===========================================================================

describe("UserModelStore — legacy migration end to end", () => {
  function legacyFixture(): UserTrait[] {
    return [
      { attribute: "name", value: "Ada Lovelace", confidence: 0.95, evidence: ["Her name is Ada Lovelace."], updatedAt: clock, revisions: 0 },
      { attribute: "location", value: "London", confidence: 0.4, evidence: ["Lives in London."], updatedAt: clock, revisions: 1 },
      { attribute: "preference", value: "dark mode", confidence: 0.7, evidence: ["Prefers dark mode."], updatedAt: clock, revisions: 0 },
      { attribute: "stack", value: "TypeScript", confidence: 0.5, evidence: [], updatedAt: clock, revisions: 0 },
      { attribute: "shoe-size", value: "10", confidence: 0.9, evidence: [], updatedAt: clock, revisions: 0 },
    ];
  }

  it("migrates every mappable attribute, caps over-confident traits, reports skips, and sets migratedFromLegacy", () => {
    const legacyPath = join(root, "legacy-user-model.json");
    writeFileSync(legacyPath, JSON.stringify(legacyFixture()), "utf8");
    const path = join(root, "user-model.json");

    const store = new UserModelStore({ path, legacyPath, now: fixedNow });

    expect(store.model.get("identity.name")?.value).toBe("Ada Lovelace");
    expect(store.model.get("identity.name")?.confidence).toBeCloseTo(0.6, 10); // 0.95 capped to 0.6
    expect(store.model.get("identity.location")?.value).toBe("London");
    expect(store.model.get("preference.style")?.value).toBe("dark mode");
    expect(store.model.get("stack.primary")?.value).toBe("TypeScript");
    expect(store.model.get("shoe-size")).toBeUndefined(); // unmappable, never landed

    expect(store.loadIssues().some((m) => m.includes("migrated 4"))).toBe(true);
    expect(store.loadIssues().some((m) => m.includes("shoe-size"))).toBe(true);

    // Migration is persisted immediately, and the flag is set on disk.
    expect(existsSync(path)).toBe(true);
    expect(readProfile(path).migratedFromLegacy).toBe(true);
  });

  it("does not re-migrate on a second construction against the same path", () => {
    const legacyPath = join(root, "legacy-user-model.json");
    writeFileSync(legacyPath, JSON.stringify(legacyFixture()), "utf8");
    const path = join(root, "user-model.json");

    const storeA = new UserModelStore({ path, legacyPath, now: fixedNow });
    expect(storeA.model.get("identity.location")?.value).toBe("London");

    // Mutate the legacy fixture on disk -- if a second construction were to
    // (incorrectly) re-migrate, this new value would leak in.
    const mutatedFixture = legacyFixture();
    mutatedFixture[1] = { ...mutatedFixture[1], value: "Paris" };
    writeFileSync(legacyPath, JSON.stringify(mutatedFixture), "utf8");

    const storeB = new UserModelStore({ path, legacyPath, now: fixedNow });
    expect(storeB.model.get("identity.location")?.value).toBe("London"); // unchanged: loaded from path, not re-migrated
    expect(storeB.loadIssues()).toEqual([]); // a clean load from `path`, no migration event this time
  });

  it("degrades gracefully on malformed legacy JSON instead of throwing", () => {
    const legacyPath = join(root, "legacy-user-model.json");
    writeFileSync(legacyPath, "{this is not valid json", "utf8");
    const path = join(root, "user-model.json");

    let store: UserModelStore | undefined;
    expect(() => {
      store = new UserModelStore({ path, legacyPath, now: fixedNow });
    }).not.toThrow();
    expect(store!.model.all()).toEqual([]);
  });

  it("degrades gracefully when legacy JSON parses but isn't an array", () => {
    const legacyPath = join(root, "legacy-user-model.json");
    writeFileSync(legacyPath, JSON.stringify({ not: "an array" }), "utf8");
    const path = join(root, "user-model.json");

    const store = new UserModelStore({ path, legacyPath, now: fixedNow });
    expect(store.model.all()).toEqual([]);
  });
});

// ===========================================================================
// ProfileMemoryBridge — full loop, idempotence, contradiction, edge cases
// ===========================================================================

describe("ProfileMemoryBridge", () => {
  function highConfidenceEvidence(id: string): BeliefEvidence {
    return mkEvidence({ id, tier: "T1-reference", weight: 0.9 });
  }

  it("writes an above-floor belief into the guarded store and MEMORY.md exactly once across two syncs, and again after reopening the store from disk", () => {
    const path = join(root, "user-model.json");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });

    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Grace Hopper",
      evidence: highConfidenceEvidence("e1"),
      now: clock,
    });

    const memory = new GuardedMemoryStore(new InMemoryMemoryStore(), { now: fixedNow });
    const bridgeA = new ProfileMemoryBridge({ store: storeA, memory, dataDir, now: fixedNow });

    const first = bridgeA.syncAssertedBeliefs();
    expect(first).toEqual([{ attribute: "identity.name", action: "written" }]);
    expect(memory.all()).toHaveLength(1);
    expect(memory.all()[0].fact).toBe("The user's identity.name is Grace Hopper.");

    const memoryMdPath = join(dataDir, "MEMORY.md");
    const contentAfterFirst = readFileSync(memoryMdPath, "utf8");
    expect(contentAfterFirst).toContain("The user's identity.name is Grace Hopper.");

    const second = bridgeA.syncAssertedBeliefs();
    expect(second).toEqual([{ attribute: "identity.name", action: "skipped", reason: "already written to memory" }]);
    expect(memory.all()).toHaveLength(1); // no duplicate record
    expect(readFileSync(memoryMdPath, "utf8")).toBe(contentAfterFirst); // no duplicate bullet

    // Simulate a process restart: a fresh UserModelStore reloaded from disk,
    // a fresh ProfileMemoryBridge, but the same durable memory backend.
    const storeReopened = new UserModelStore({ path, now: fixedNow });
    const bridgeReopened = new ProfileMemoryBridge({ store: storeReopened, memory, dataDir, now: fixedNow });
    const third = bridgeReopened.syncAssertedBeliefs();
    expect(third).toEqual([{ attribute: "identity.name", action: "skipped", reason: "already written to memory" }]);
    expect(memory.all()).toHaveLength(1);
    expect(readFileSync(memoryMdPath, "utf8")).toBe(contentAfterFirst);
  });

  it("quarantines a belief that contradicts a pre-seeded high-salience memory via the REAL gate", () => {
    const path = join(root, "user-model.json");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });

    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "favorite number",
      value: "45",
      evidence: highConfidenceEvidence("e1"),
      now: clock,
    });
    expect(storeA.model.get("favorite number")?.status).toBe("asserted");

    const inner = new InMemoryMemoryStore();
    inner.add({ fact: "The user's favorite number is 12.", salience: 0.9, tags: ["seed"] });
    const memory = new GuardedMemoryStore(inner, { now: fixedNow });

    const bridge = new ProfileMemoryBridge({ store: storeA, memory, dataDir, now: fixedNow });
    const outcomes = bridge.syncAssertedBeliefs();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("quarantined");
    expect(outcomes[0].flagged).toBeDefined();
    expect(outcomes[0].reason).toBeTruthy();

    expect(memory.flags()).toHaveLength(1);
    expect(memory.all()).toHaveLength(1); // only the seeded record, candidate never landed

    const belief = storeA.model.get("favorite number");
    expect(belief?.status).toBe("contested");
    expect(storeA.model.asserted().find((b) => b.attribute === "favorite number")).toBeUndefined();

    expect(existsSync(join(dataDir, "MEMORY.md"))).toBe(false); // MEMORY.md untouched
  });

  it("skips below-floor and contested beliefs with reasons, and never touches memory for them", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, model: { assertFloor: 0.1 }, now: fixedNow });

    // Low confidence: clears the model's own (deliberately lowered) floor so
    // it IS "asserted", but not the bridge's default 0.75 floor.
    storeA.assertAndPersist({
      attribute: "preference.style",
      value: "light mode",
      evidence: mkEvidence({ id: "low1", tier: "T4-consistency", weight: 0.3 }),
      now: clock,
    });
    expect(storeA.model.get("preference.style")?.status).toBe("asserted");

    // A belief that gets contested via a same-value contradicting assertion.
    storeA.assertAndPersist({
      attribute: "stack.primary",
      value: "TypeScript",
      evidence: highConfidenceEvidence("stack1"),
      now: clock,
    });
    storeA.assertAndPersist({
      attribute: "stack.primary",
      value: "TypeScript",
      polarity: "contradicts",
      evidence: mkEvidence({ id: "stack2", polarity: "contradicts", tier: "T1-reference", weight: 0.9 }),
      now: clock,
    });
    expect(storeA.model.get("stack.primary")?.status).toBe("contested");

    const memory = new GuardedMemoryStore(new InMemoryMemoryStore(), { now: fixedNow });
    const bridge = new ProfileMemoryBridge({ store: storeA, memory, now: fixedNow });
    const outcomes = bridge.syncAssertedBeliefs();

    const byAttr = new Map(outcomes.map((o) => [o.attribute, o] as const));
    expect(byAttr.get("preference.style")?.action).toBe("skipped");
    expect(byAttr.get("preference.style")?.reason).toMatch(/confidence/i);
    expect(byAttr.get("stack.primary")?.action).toBe("skipped");
    expect(byAttr.get("stack.primary")?.reason).toMatch(/contested/i);

    expect(memory.all()).toHaveLength(0);
    expect(memory.flags()).toHaveLength(0);
  });

  it("reports an appendMemoryFact failure instead of throwing, while the guarded memory write still lands", () => {
    const path = join(root, "user-model.json");
    const storeA = new UserModelStore({ path, now: fixedNow });
    storeA.assertAndPersist({
      attribute: "identity.name",
      value: "Katherine Johnson",
      evidence: highConfidenceEvidence("e1"),
      now: clock,
    });

    // dataDir points at a path that is actually a regular FILE, so any
    // attempt to write a sibling file underneath it fails at the filesystem
    // level (ENOTDIR) regardless of unix permissions / running as root.
    const fakeDataDir = join(root, "not-a-directory");
    writeFileSync(fakeDataDir, "i am a file, not a directory", "utf8");

    const memory = new GuardedMemoryStore(new InMemoryMemoryStore(), { now: fixedNow });
    const bridge = new ProfileMemoryBridge({ store: storeA, memory, dataDir: fakeDataDir, now: fixedNow });

    let outcomes: SyncOutcome[] = [];
    expect(() => {
      outcomes = bridge.syncAssertedBeliefs();
    }).not.toThrow();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("written"); // the guarded memory write itself succeeded
    expect(outcomes[0].reason).toBeTruthy(); // but the MEMORY.md failure is surfaced
    expect(memory.all()).toHaveLength(1);
  });

  it("throws on construction without a store or memory", () => {
    const path = join(root, "user-model.json");
    const store = new UserModelStore({ path, now: fixedNow });
    const memory = new GuardedMemoryStore(new InMemoryMemoryStore(), { now: fixedNow });
    expect(() => new ProfileMemoryBridge({ store, memory: undefined as never })).toThrow();
    expect(() => new ProfileMemoryBridge({ store: undefined as never, memory })).toThrow();
  });
});
