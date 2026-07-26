/* ------------------------------------------------------------------ *
 * ledger.test.ts — exercises REAL tamper-evidence, not trivial asserts.
 *
 * Hashing throughout is cross-checked against an independently-invoked
 * `sha256Hex` (imported straight from the real `../../styx/certificate`
 * engine, the same one `ledger.ts` uses) so these tests never trust
 * `ledger.ts`'s own internal computation of a hash as its own proof.
 * ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../styx/certificate";
import {
  ROUTING_LEDGER_GENESIS,
  RoutingLedger,
  RoutingLedgerError,
  canonicalizeDecision,
  type ArmAttribution,
  type RoutingDecision,
  type RoutingLedgerEntry,
} from "../ledger";

const HEX64 = /^[0-9a-f]{64}$/;

function independentSha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** A valid, fully-populated RoutingDecision, with overrides. */
function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: "task-1",
    category: "arithmetic",
    armId: "openai/gpt-x",
    reason: "cheapest arm that meets the accuracy bar",
    candidates: ["openai/gpt-x", "anthropic/claude-y"],
    fannedOut: [],
    escalations: 0,
    estimatedUsd: 0.002,
    actualUsd: 0.0021,
    wallMs: 450,
    claimedVerified: true,
    graded: true,
    pCorrect: 0.94,
    certificateId: "cert-abc123",
    at: 1_000,
    ...overrides,
  };
}

function buildChain(n: number): RoutingLedger {
  const ledger = new RoutingLedger();
  for (let i = 0; i < n; i++) {
    ledger.append(
      decision({
        taskId: `task-${i}`,
        armId: i % 2 === 0 ? "openai/gpt-x" : "anthropic/claude-y",
        candidates: ["openai/gpt-x", "anthropic/claude-y", "local/llama"],
        fannedOut: i % 3 === 0 ? ["local/llama"] : [],
        escalations: i % 3 === 0 ? 1 : 0,
        graded: i % 5 === 4 ? false : true, // one silentWrong-flavored entry (with claimedVerified true elsewhere too)
        at: 1_000 + i,
      }),
    );
  }
  return ledger;
}

// ===========================================================================
// Genesis
// ===========================================================================

describe("ROUTING_LEDGER_GENESIS", () => {
  it("is the real sha256 of the fixed literal, independently reproducible", () => {
    expect(ROUTING_LEDGER_GENESIS).toBe(independentSha256("hades.routing.ledger.v1"));
    expect(ROUTING_LEDGER_GENESIS).toMatch(HEX64);
  });
});

// ===========================================================================
// canonicalizeDecision
// ===========================================================================

describe("canonicalizeDecision", () => {
  it("is stable regardless of the source object's key insertion order", () => {
    const d1: RoutingDecision = decision();

    // Build an object with the SAME values but a deliberately shuffled
    // insertion order, via multiple partial spreads.
    const shuffled: RoutingDecision = {
      at: d1.at,
      certificateId: d1.certificateId,
      pCorrect: d1.pCorrect,
      graded: d1.graded,
      claimedVerified: d1.claimedVerified,
      wallMs: d1.wallMs,
      actualUsd: d1.actualUsd,
      estimatedUsd: d1.estimatedUsd,
      escalations: d1.escalations,
      fannedOut: [...d1.fannedOut],
      candidates: [...d1.candidates],
      reason: d1.reason,
      armId: d1.armId,
      category: d1.category,
      taskId: d1.taskId,
    };

    expect(canonicalizeDecision(shuffled)).toBe(canonicalizeDecision(d1));
  });

  it("produces different output for different values (sanity)", () => {
    const a = canonicalizeDecision(decision({ armId: "openai/gpt-x" }));
    const b = canonicalizeDecision(decision({ armId: "anthropic/claude-y" }));
    expect(a).not.toBe(b);
  });

  it("round-trips through JSON.parse to equal-shaped data (locked field order)", () => {
    const canon = canonicalizeDecision(decision());
    const parsed = JSON.parse(canon);
    expect(Object.keys(parsed)).toEqual([
      "taskId",
      "category",
      "armId",
      "reason",
      "candidates",
      "fannedOut",
      "escalations",
      "estimatedUsd",
      "actualUsd",
      "wallMs",
      "claimedVerified",
      "graded",
      "pCorrect",
      "certificateId",
      "at",
    ]);
  });

  const nonFiniteCases: Array<[string, Partial<RoutingDecision>]> = [
    ["escalations NaN", { escalations: NaN }],
    ["estimatedUsd Infinity", { estimatedUsd: Infinity }],
    ["actualUsd -Infinity", { actualUsd: -Infinity }],
    ["wallMs NaN", { wallMs: NaN }],
    ["pCorrect Infinity", { pCorrect: Infinity }],
    ["at NaN", { at: NaN }],
  ];
  it.each(nonFiniteCases)("throws on non-finite %s", (_label, overrides) => {
    expect(() => canonicalizeDecision(decision(overrides))).toThrow(TypeError);
  });

  it("throws on a non-JSON-safe candidates element (e.g. undefined)", () => {
    const bad = decision({ candidates: [undefined as unknown as string] });
    expect(() => canonicalizeDecision(bad)).toThrow(TypeError);
  });

  it("throws on a non-string fannedOut element", () => {
    const bad = decision({ fannedOut: [{} as unknown as string] });
    expect(() => canonicalizeDecision(bad)).toThrow(TypeError);
  });

  it("handles graded:null and certificateId:null without throwing", () => {
    expect(() => canonicalizeDecision(decision({ graded: null, certificateId: null }))).not.toThrow();
  });
});

// ===========================================================================
// append / entries / head / verifyChain — the happy path
// ===========================================================================

describe("RoutingLedger append/entries/head/verifyChain", () => {
  it("empty ledger: head() is genesis, verifyChain() is ok/empty", () => {
    const ledger = new RoutingLedger();
    expect(ledger.head()).toBe(ROUTING_LEDGER_GENESIS);
    expect(ledger.entries()).toEqual([]);
    expect(ledger.verifyChain()).toEqual({ ok: true, entries: 0, brokenAt: null, code: "empty" });
  });

  it("chains hashes correctly and matches an independently recomputed hash at every seq", () => {
    const ledger = buildChain(6);
    const entries = ledger.entries();
    expect(entries).toHaveLength(6);

    let prevHash = ROUTING_LEDGER_GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      expect(e.seq).toBe(i);
      expect(e.prevHash).toBe(prevHash);
      const expected = sha256Hex(prevHash + "\n" + canonicalizeDecision(e) + "\n" + i);
      expect(e.hash).toBe(expected);
      expect(e.hash).toMatch(HEX64);
      prevHash = e.hash;
    }
    expect(ledger.head()).toBe(prevHash);
  });

  it("verifyChain() reports ok on a freshly-built chain", () => {
    const ledger = buildChain(5);
    expect(ledger.verifyChain()).toEqual({ ok: true, entries: 5, brokenAt: null, code: "ok" });
  });

  it("append() throws before mutating state on an invalid decision", () => {
    const ledger = new RoutingLedger();
    ledger.append(decision({ taskId: "keeper" }));
    expect(() => ledger.append(decision({ pCorrect: NaN }))).toThrow(TypeError);
    // state must be unaffected by the rejected append
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]!.taskId).toBe("keeper");
  });

  it("entries()/head() return defensive copies (mutating them never corrupts the ledger)", () => {
    const ledger = buildChain(3);
    const got = ledger.entries();
    (got[1] as { armId: string }).armId = "corrupted";
    (got[1]!.candidates as string[]).push("evil");
    expect(ledger.entries()[1]!.armId).not.toBe("corrupted");
    expect(ledger.entries()[1]!.candidates).not.toContain("evil");
  });
});

// ===========================================================================
// Tamper evidence — the core of this module
// ===========================================================================

describe("tamper evidence: mutating a single field of a mid-chain entry", () => {
  const fieldMutations: Array<[keyof RoutingDecision, (v: unknown) => unknown]> = [
    ["taskId", (v) => `${v}-tampered`],
    ["category", (v) => `${v}-tampered`],
    ["armId", (v) => `${v}-tampered`],
    ["reason", (v) => `${v}-tampered`],
    ["candidates", (v) => [...(v as string[]), "extra/arm"]],
    ["fannedOut", (v) => [...(v as string[]), "extra/arm"]],
    ["escalations", (v) => (v as number) + 1],
    ["estimatedUsd", (v) => (v as number) + 0.5],
    ["actualUsd", (v) => (v as number) + 0.5],
    ["wallMs", (v) => (v as number) + 1],
    ["claimedVerified", (v) => !(v as boolean)],
    ["graded", (v) => (v === true ? false : true)],
    ["pCorrect", (v) => (v as number) + 0.01],
    ["certificateId", (v) => (v === null ? "forged-cert" : null)],
    ["at", (v) => (v as number) + 1],
  ];

  it.each(fieldMutations)("mutating %s is detected as hash-mismatch at the tampered seq", (field, mutate) => {
    const ledger = buildChain(6);
    const entries = ledger.entries() as RoutingLedgerEntry[];
    const targetSeq = 3; // mid-chain

    const tampered = entries.map((e) => ({ ...e }));
    const original = tampered[targetSeq]!;
    (tampered[targetSeq] as Record<string, unknown>)[field] = mutate((original as Record<string, unknown>)[field]);

    const rebuilt = new RoutingLedger(tampered);
    const check = rebuilt.verifyChain();

    expect(check.ok).toBe(false);
    expect(check.code).toBe("hash-mismatch");
    expect(check.brokenAt).toBe(targetSeq);
    expect(check.entries).toBe(6);
  });
});

describe("tamper evidence: structural attacks", () => {
  it("entry reordering is detected (seq no longer matches position)", () => {
    const ledger = buildChain(5);
    const entries = ledger.entries().map((e) => ({ ...e }));
    // swap entries at index 1 and 2, seq fields unchanged
    const swapped = [entries[0]!, entries[2]!, entries[1]!, entries[3]!, entries[4]!];

    const check = new RoutingLedger(swapped).verifyChain();
    expect(check.ok).toBe(false);
    expect(check.code).toBe("seq-gap");
    expect(check.brokenAt).toBe(1); // position 1 now holds an entry whose seq is 2
  });

  it("truncation (removing a mid-chain entry) is detected", () => {
    const ledger = buildChain(6);
    const entries = ledger.entries().map((e) => ({ ...e }));
    const truncated = [entries[0]!, entries[1]!, entries[3]!, entries[4]!, entries[5]!]; // drop seq 2

    const check = new RoutingLedger(truncated).verifyChain();
    expect(check.ok).toBe(false);
    expect(check.code).toBe("seq-gap");
    expect(check.brokenAt).toBe(2); // position 2 now holds seq 3
  });

  it("truncation from the tail alone still verifies (a valid shorter prefix) -- documents the boundary", () => {
    const ledger = buildChain(6);
    const entries = ledger.entries().map((e) => ({ ...e }));
    const prefix = entries.slice(0, 4);
    const check = new RoutingLedger(prefix).verifyChain();
    expect(check).toEqual({ ok: true, entries: 4, brokenAt: null, code: "ok" });
    // This is exactly why a re-signed-suffix attack (below) needs an
    // externally retained head hash, not just verifyChain(), to catch.
  });

  it("insertion of a foreign entry mid-chain is detected", () => {
    const ledgerA = buildChain(4);
    const ledgerB = buildChain(4); // an unrelated, independently-built chain
    const entriesA = ledgerA.entries().map((e) => ({ ...e }));
    const foreign = { ...ledgerB.entries()[0]! }; // valid entry, but from a different chain

    const withInsertion = [entriesA[0]!, entriesA[1]!, foreign, entriesA[2]!, entriesA[3]!];
    const check = new RoutingLedger(withInsertion).verifyChain();
    expect(check.ok).toBe(false);
    // the inserted entry (seq 0 from ledgerB) lands at array position 2
    expect(check.code).toBe("seq-gap");
    expect(check.brokenAt).toBe(2);
  });

  it("a forged prevHash (not recomputing hash) on a mid-chain entry is detected as prev-mismatch", () => {
    const ledger = buildChain(5);
    const entries = ledger.entries().map((e) => ({ ...e }));
    entries[2] = { ...entries[2]!, prevHash: "f".repeat(64) }; // forged, hash left stale

    const check = new RoutingLedger(entries).verifyChain();
    expect(check.ok).toBe(false);
    expect(check.code).toBe("prev-mismatch");
    expect(check.brokenAt).toBe(2);
  });

  it("a rewritten genesis (first entry's prevHash != ROUTING_LEDGER_GENESIS) is detected, even if self-consistently re-signed", () => {
    const ledger = buildChain(5);
    const entries = ledger.entries().map((e) => ({ ...e }));
    const fakeGenesis = "a".repeat(64);
    const first = entries[0]!;
    // Attacker rewrites genesis AND recomputes hash to be internally
    // self-consistent with the fake genesis -- still must fail, because
    // genesis-mismatch is checked before hash recomputation.
    const resignedFirst: RoutingLedgerEntry = {
      ...first,
      prevHash: fakeGenesis,
      hash: sha256Hex(fakeGenesis + "\n" + canonicalizeDecision(first) + "\n" + 0),
    };
    const tampered = [resignedFirst, ...entries.slice(1)];

    // downstream linkage now also breaks (entries[1].prevHash no longer
    // matches resignedFirst.hash), but genesis-mismatch must win at seq 0.
    const check = new RoutingLedger(tampered).verifyChain();
    expect(check.ok).toBe(false);
    expect(check.code).toBe("genesis-mismatch");
    expect(check.brokenAt).toBe(0);
  });

  it("a re-signed suffix passes verifyChain() (fully self-consistent) but no longer matches the retained head", () => {
    const ledger = buildChain(6);
    const originalHead = ledger.head();
    const entries = ledger.entries().map((e) => ({ ...e })) as RoutingLedgerEntry[];

    const tamperAt = 2;
    const resigned: RoutingLedgerEntry[] = entries.map((e) => ({ ...e }));
    resigned[tamperAt] = { ...resigned[tamperAt]!, armId: "sneaky/substituted-arm" };

    // Re-sign every entry from the tamper point onward so the chain is
    // internally self-consistent end to end.
    let prevHash = resigned[tamperAt - 1]!.hash;
    for (let i = tamperAt; i < resigned.length; i++) {
      const withPrev: RoutingLedgerEntry = { ...resigned[i]!, seq: i, prevHash };
      const hash = sha256Hex(prevHash + "\n" + canonicalizeDecision(withPrev) + "\n" + i);
      resigned[i] = { ...withPrev, hash };
      prevHash = hash;
    }

    const rebuilt = new RoutingLedger(resigned);
    const check = rebuilt.verifyChain();
    // Internally self-consistent: verifyChain() alone cannot see the tamper.
    expect(check).toEqual({ ok: true, entries: 6, brokenAt: null, code: "ok" });
    // But it produces a DIFFERENT head than the untampered chain -- an
    // externally retained head hash (e.g. checkpointed elsewhere) is
    // what actually catches a fully re-signed suffix.
    expect(rebuilt.head()).not.toBe(originalHead);
  });
});

// ===========================================================================
// deserialize — hostile-input hardening
// ===========================================================================

describe("RoutingLedger.serialize / deserialize", () => {
  it("round-trips a real chain byte-for-byte equivalent", () => {
    const ledger = buildChain(5);
    const text = ledger.serialize();
    const restored = RoutingLedger.deserialize(text);
    expect(restored.entries()).toEqual(ledger.entries());
    expect(restored.head()).toBe(ledger.head());
    expect(restored.verifyChain()).toEqual({ ok: true, entries: 5, brokenAt: null, code: "ok" });
  });

  it("round-trips an empty ledger", () => {
    const ledger = new RoutingLedger();
    const restored = RoutingLedger.deserialize(ledger.serialize());
    expect(restored.entries()).toEqual([]);
    expect(restored.head()).toBe(ROUTING_LEDGER_GENESIS);
  });

  it("rejects non-JSON input with code invalid-json", () => {
    expect(() => RoutingLedger.deserialize("not json at all {{{")).toThrow(RoutingLedgerError);
    try {
      RoutingLedger.deserialize("not json at all {{{");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingLedgerError);
      expect((err as RoutingLedgerError).code).toBe("invalid-json");
    }
  });

  it("rejects a non-string input with code invalid-json", () => {
    expect(() => RoutingLedger.deserialize(42 as unknown as string)).toThrow(RoutingLedgerError);
  });

  it("rejects the wrong version with code bad-version", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    envelope.version = 2;
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "bad-version");
  });

  it("rejects a mismatched envelope genesis with code genesis-mismatch", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    envelope.genesis = "0".repeat(64);
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "genesis-mismatch");
  });

  it("rejects a top-level payload that is not an object, with code malformed", () => {
    expectCode(() => RoutingLedger.deserialize(JSON.stringify([1, 2, 3])), "malformed");
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(42)), "malformed");
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(null)), "malformed");
  });

  it("rejects entries that are not an array, with code malformed", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries = { not: "an array" };
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "malformed");
  });

  it("rejects a missing field with code missing-field", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    delete envelope.entries[0].taskId;
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "missing-field");
  });

  it("rejects a non-string candidates element with code missing-field", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries[0].candidates = [123];
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "missing-field");
  });

  it("rejects an Infinity numeric field (smuggled via a valid-JSON overflow literal) with code invalid-number", () => {
    const ledger = buildChain(2);
    const raw = ledger.serialize();
    // 1e999 is valid JSON syntax but parses to the double Infinity --
    // a real hostile-input vector that JSON.parse alone won't catch.
    const withInfinity = raw.replace(/"estimatedUsd":[0-9.eE+-]+/, '"estimatedUsd":1e999');
    expect(withInfinity).toContain("1e999");
    expectCode(() => RoutingLedger.deserialize(withInfinity), "invalid-number");
  });

  it("rejects a negative escalations count with code invalid-number", () => {
    const ledger = buildChain(2);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries[0].escalations = -1;
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "invalid-number");
  });

  it("rejects a non-contiguous seq with code seq-gap", () => {
    const ledger = buildChain(3);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries[1].seq = 5;
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "seq-gap");
  });

  it("rejects a prototype-pollution key at the root with code unsafe-key", () => {
    const ledger = buildChain(1);
    const envelope = JSON.parse(ledger.serialize());
    const withPollution = JSON.stringify(envelope).replace(
      '"version":1',
      '"version":1,"__proto__":{"polluted":true}',
    );
    expectCode(() => RoutingLedger.deserialize(withPollution), "unsafe-key");
  });

  it("rejects a prototype-pollution key inside an entry with code unsafe-key", () => {
    const ledger = buildChain(1);
    const envelope = JSON.parse(ledger.serialize());
    const entryJson = JSON.stringify(envelope.entries[0]);
    const pollutedEntry = entryJson.replace("{", '{"constructor":{"evil":true},');
    const withPollution = JSON.stringify(envelope).replace(JSON.stringify(envelope.entries[0]), pollutedEntry);
    expectCode(() => RoutingLedger.deserialize(withPollution), "unsafe-key");
  });

  it("rejects a chain whose hash no longer verifies, with code hash-mismatch -- NEVER succeeds silently", () => {
    const ledger = buildChain(4);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries[2].armId = "quietly-swapped/arm";
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "hash-mismatch");
  });

  it("rejects broken prevHash linkage, with code prev-mismatch", () => {
    const ledger = buildChain(4);
    const envelope = JSON.parse(ledger.serialize());
    envelope.entries[2].prevHash = "b".repeat(64);
    expectCode(() => RoutingLedger.deserialize(JSON.stringify(envelope)), "prev-mismatch");
  });

  function expectCode(fn: () => unknown, code: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoutingLedgerError);
    expect((caught as RoutingLedgerError).code).toBe(code);
  }
});

// ===========================================================================
// attribution() — correctness, independently cross-checked
// ===========================================================================

/** Independent re-derivation of per-arm attribution, NOT calling ledger.attribution(). */
function independentAttribution(entries: readonly RoutingLedgerEntry[]): Map<string, ArmAttribution> {
  const armIds = new Set<string>();
  for (const e of entries) {
    armIds.add(e.armId);
    for (const c of e.candidates) armIds.add(c);
    for (const f of e.fannedOut) armIds.add(f);
  }
  const out = new Map<string, ArmAttribution>();
  for (const armId of armIds) {
    let tasks = 0;
    let verifiedCorrect = 0;
    let silentWrong = 0;
    let declined = 0;
    let usd = 0;
    let wallMs = 0;
    for (const e of entries) {
      if (e.armId !== armId) continue;
      tasks++;
      usd += e.actualUsd;
      wallMs += e.wallMs;
      if (e.claimedVerified && e.graded === true) verifiedCorrect++;
      else if (e.claimedVerified && e.graded === false) silentWrong++;
      else if (!e.claimedVerified) declined++;
    }
    const hours = wallMs / 3_600_000;
    const vtph = hours > 0 ? verifiedCorrect / hours : 0;
    const vtphPerDollar = vtph / Math.max(usd, 1e-9);
    let escalatedInto = 0;
    for (const e of entries) if (e.fannedOut.includes(armId)) escalatedInto++;
    out.set(armId, { armId, tasks, verifiedCorrect, silentWrong, declined, usd, wallMs, vtph, vtphPerDollar, escalatedInto });
  }
  return out;
}

describe("RoutingLedger.attribution", () => {
  it("cross-checks exactly against an independently-computed reduction", () => {
    const ledger = buildChain(11);
    const got = ledger.attribution();
    const expected = independentAttribution(ledger.entries());

    expect(got.length).toBe(expected.size);
    for (const row of got) {
      expect(row).toEqual(expected.get(row.armId));
    }
  });

  it("is sorted deterministically by armId", () => {
    const ledger = buildChain(9);
    const got = ledger.attribution();
    const sorted = [...got].sort((a, b) => a.armId.localeCompare(b.armId));
    expect(got.map((r) => r.armId)).toEqual(sorted.map((r) => r.armId));
  });

  it("a lying arm (claimedVerified:true, graded:false) earns ZERO verifiedCorrect / vtph credit, tracked as silentWrong", () => {
    const ledger = new RoutingLedger();
    ledger.append(
      decision({
        taskId: "t1",
        armId: "liar/arm",
        candidates: ["liar/arm"],
        claimedVerified: true,
        graded: false, // independently graded WRONG despite the claim
        actualUsd: 1,
        wallMs: 3_600_000, // exactly 1 hour, so vtph math is easy to check by hand
      }),
    );
    ledger.append(
      decision({
        taskId: "t2",
        armId: "liar/arm",
        candidates: ["liar/arm"],
        claimedVerified: true,
        graded: false,
        actualUsd: 1,
        wallMs: 3_600_000,
      }),
    );

    const [row] = ledger.attribution();
    expect(row).toBeDefined();
    expect(row!.armId).toBe("liar/arm");
    expect(row!.tasks).toBe(2);
    expect(row!.silentWrong).toBe(2);
    expect(row!.verifiedCorrect).toBe(0);
    expect(row!.declined).toBe(0);
    // Fabricating "verified" earns exactly zero throughput credit:
    expect(row!.vtph).toBe(0);
    expect(row!.vtphPerDollar).toBe(0);
  });

  it("a genuinely verified arm earns real, hand-computable vtph/vtphPerDollar credit", () => {
    const ledger = new RoutingLedger();
    ledger.append(
      decision({
        taskId: "t1",
        armId: "honest/arm",
        candidates: ["honest/arm"],
        claimedVerified: true,
        graded: true,
        actualUsd: 2,
        wallMs: 1_800_000, // 0.5 hour
      }),
    );
    const [row] = ledger.attribution();
    expect(row!.verifiedCorrect).toBe(1);
    expect(row!.vtph).toBeCloseTo(1 / 0.5, 10); // 1 verified task / 0.5 hour = 2 vtph
    expect(row!.vtphPerDollar).toBeCloseTo(2 / 2, 10); // 2 vtph / $2
  });

  it("never produces NaN/Infinity for a zero-task, zero-cost, zero-duration arm", () => {
    const ledger = new RoutingLedger();
    ledger.append(
      decision({
        taskId: "t1",
        armId: "chosen/arm",
        candidates: ["chosen/arm", "never-chosen/arm"], // never-chosen/arm gets a row with 0 tasks
        actualUsd: 0,
        wallMs: 0,
        claimedVerified: false,
        graded: null,
      }),
    );
    const rows = ledger.attribution();
    for (const row of rows) {
      expect(Number.isFinite(row.usd)).toBe(true);
      expect(Number.isFinite(row.wallMs)).toBe(true);
      expect(Number.isFinite(row.vtph)).toBe(true);
      expect(Number.isFinite(row.vtphPerDollar)).toBe(true);
      expect(Number.isNaN(row.vtph)).toBe(false);
      expect(Number.isNaN(row.vtphPerDollar)).toBe(false);
    }
    const neverChosen = rows.find((r) => r.armId === "never-chosen/arm");
    expect(neverChosen).toBeDefined();
    expect(neverChosen!.tasks).toBe(0);
    expect(neverChosen!.usd).toBe(0);
    expect(neverChosen!.wallMs).toBe(0);
    expect(neverChosen!.vtph).toBe(0);
    expect(neverChosen!.vtphPerDollar).toBe(0);
  });

  it("escalatedInto counts decisions whose fannedOut lists this arm, independent of who was chosen", () => {
    const ledger = new RoutingLedger();
    ledger.append(
      decision({ taskId: "t1", armId: "primary/arm", candidates: ["primary/arm", "helper/arm"], fannedOut: ["helper/arm"] }),
    );
    ledger.append(
      decision({ taskId: "t2", armId: "primary/arm", candidates: ["primary/arm", "helper/arm"], fannedOut: ["helper/arm"] }),
    );
    ledger.append(
      decision({ taskId: "t3", armId: "helper/arm", candidates: ["primary/arm", "helper/arm"], fannedOut: [] }),
    );

    const rows = ledger.attribution();
    const helper = rows.find((r) => r.armId === "helper/arm")!;
    expect(helper.escalatedInto).toBe(2);
    const primary = rows.find((r) => r.armId === "primary/arm")!;
    expect(primary.escalatedInto).toBe(0);
  });
});
